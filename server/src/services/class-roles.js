/**
 * 班级身份写入（班主任班级 / 班委）—— 管理端与班级域**共用同一份实现**。
 *
 * 背景（用户 2026-10-24「示例教师1 为什么没有本班的操作权限，班级TAB中也没有配置权限」）：
 *   班委开关与班主任分配原先只写在 `PUT /api/admin/users/:id/class-roles`（需 user.manage）。
 *   班主任对本班学生本来就有管理权（student-scope 判定），却因为没有 user.manage 而
 *   在「班级」TAB 里看不到 / 用不了班委开关 —— 能力表里也一直没有这一项。
 *   现在把校验与写入抽到这里，管理端与班级域两个入口都调它，避免两套逻辑漂移
 *   （AGENTS.md：班级域只做鉴权与取参，禁止另写一套）。
 */
const { ApiError } = require('../utils/response');

/**
 * 设置 / 取消班委（学生）。
 * 校验口径与原管理端接口逐字一致：只有学生能当班委、必须先识别出班级。
 * @param {object} target User 文档（非 lean）
 * @param {boolean} value
 */
async function setClassOfficer(target, value) {
  if (target.role !== 'student') throw new ApiError(400, 400, '只有学生账号可以设为班委');
  if (value && !target.className) {
    throw new ApiError(400, 400, '该学生尚未识别出班级（年级 + 专业），无法设为班委');
  }
  target.isClassOfficer = !!value;
  await target.save();
}

/**
 * 分配班主任班级（教师，多选，可清空）。
 * @param {object} user User 文档（非 lean）
 * @param {string[]} classes
 */
async function setHomeroomClasses(user, classes) {
  if (user.role !== 'teacher') throw new ApiError(400, 400, '只有教师账号可以设置为班主任');
  if (!Array.isArray(classes)) throw new ApiError(400, 400, 'homeroomClasses 需为数组');
  const list = [...new Set(classes.map((c) => String(c || '').trim()).filter(Boolean))];
  if (list.length > 20) throw new ApiError(400, 400, '一个班主任最多分配 20 个班级');
  const tooLong = list.find((c) => c.length > 40);
  if (tooLong) throw new ApiError(400, 400, `班级名过长：${tooLong.slice(0, 20)}…`);
  user.homeroomClasses = list;
  await user.save();
}

module.exports = { setClassOfficer, setHomeroomClasses };
