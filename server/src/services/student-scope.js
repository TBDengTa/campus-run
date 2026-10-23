/**
 * 「谁可以管理这个学生」的**唯一判定**（班主任范围的权限来源）。
 *
 * 用户 2026-10-22 口径：
 *   「班主任没有用户管理权限时，是可以管理自己本班的学生的操作功能
 *    如（编辑资料 / 重置密码 / 发放徽章 / 限制功能 / 删除账户）。」
 *
 * 也就是说：**管理端权限项不是唯一入口** —— 班主任身份本身就是一份「只管本班学生」的管理授权，
 * 不需要额外分配 user.manage / permission.manage / badge.manage。
 *
 * 这个文件只做判定，不做鉴权、不写库；两条使用路径：
 *   ① 管理端 `/api/admin/users/*` 的只读详情：在响应里带上 canManageStudent，前端据此渲染按钮；
 *   ② 班级域 `/api/class/student/*` 的写接口：**先过本判定再动手**（这些路由不走 requirePermission）。
 *
 * 不变式（改这里之前先读）：
 *   · 只认**教师**身份（actor.role === 'teacher'）—— 班委是学生，一律只读；
 *   · 目标必须是**学生**：教师账号不属于班级域，不能借班名去改另一位老师；
 *   · 目标班级必须真的在 actor.homeroomClasses 里（多班班主任也是逐班判定，不能跨班）；
 *   · 目标**不能持有任何管理权限**：否则班主任可以重置/删除一个「学生身份的超级管理员」，
 *     那是明显的越权（把有权限的人交给没有权限的人处置）。有权限的学生由管理员处理。
 */
const NO_CLASS_ACCESS = '该班级不在你的管理范围';

/**
 * 是否是「本班」关系（纯判定，不查库）。
 * @param {Object} actor 发起人（教师）
 * @param {Object} target 目标用户
 */
function isHomeroomOf(actor, target) {
  if (!actor || !target) return false;
  if (actor.role !== 'teacher') return false;
  if (target.role !== 'student') return false;
  const cls = String(target.className || '').trim();
  if (!cls) return false;
  const homeroom = Array.isArray(actor.homeroomClasses) ? actor.homeroomClasses : [];
  if (!homeroom.includes(cls)) return false;
  return String(actor._id || '') !== String(target._id || '');
}

/**
 * 班主任能否管理该学生（含「目标不能是管理员」这条）。
 * 需要 target 是**完整文档**（用 getEffectivePermissions 展开权限组），不接受 lean 对象。
 * @returns {Promise<boolean>}
 */
async function canManageStudent(actor, target) {
  if (!isHomeroomOf(actor, target)) return false;
  try {
    const perms = await target.getEffectivePermissions();
    return !(perms && perms.length);
  } catch (e) {
    return false; // 判定失败一律按无权限（fail-closed）
  }
}

module.exports = { isHomeroomOf, canManageStudent, NO_CLASS_ACCESS };
