/**
 * 账号级管理动作的**唯一实现**（重置密码 / 删除账号 / 限制与解除限制）。
 *
 * 为什么抽成 service：这些动作现在有两个入口 ——
 *   ① 管理端 `/api/admin/users/*`（按权限项：permission.manage / user.manage）；
 *   ② 班级域 `/api/class/student/*`（按**班主任成员资格**，不需要任何管理权限，用户 2026-10-22 要求：
 *      「班主任没有用户管理权限时，是可以管理自己本班的学生的操作功能」）。
 * 如果两边各写一份，就会出现「单条会同步恢复 initialHashes、班级入口不会」「删除漏吊销设备令牌」这类分裂，
 * 而它们都是不可逆操作，分裂一次就是数据事故。所以实现只留这里，路由只做鉴权与取参。
 *
 * 鉴权不在本文件：本文件的调用方必须先确认「要么有对应权限，要么是本班班主任」。
 */
const { ApiError } = require('../utils/response');
const anticheat = require('./anticheat');
const pwd = require('./password');
const classProfilesSvc = require('./class-profiles');
const deviceSvc = require('./login-device');
const RunRecord = require('../models/run-record');
const WaterRecord = require('../models/water-record');
const UserBadge = require('../models/user-badge');
const UserGoal = require('../models/user-goal');
const Appeal = require('../models/appeal');
const BanRecord = require('../models/ban-record');
const DormAssignment = require('../models/dorm-assignment');
const WxSession = require('../models/wx-session');
const User = require('../models/user');

// 教师账号的固定初始密码（用户 2026-10-26：「初始密码教师账户为 123456」）。
// ⚠️ 只用于「管理员点『恢复初始密码』」这一动作 —— **不迁移任何存量密码**（用户明确第 5 点）。
const TEACHER_INITIAL_PASSWORD = '123456';

/**
 * 重置密码 —— **恢复为初始密码**（单条 / 批量 / 班级域共用）。
 *
 * 用户 2026-10-26 把「重置密码」改称「密码变更」，并拆成两个动作；本函数是其中的「初始密码」：
 *   · 教师 → 固定 123456（写入 resetHashes，保证以后还能再次恢复成同一个值）；
 *   · 学生 → 恢复名单初始密码（学号后8 / 身份证后8 的既有哈希，见 services/roster.js::initialPasswords）。
 *
 * 为什么必须共用一份（历史踩点）：批量如果另写一套，就会出现
 * 「单条会同步恢复 initialHashes、批量不会」这类分裂 —— 下次改密用旧密码验证就会失败。
 *
 * 为什么学生走「恢复 resetHashes」而不是重新算：身份证原文**不落库**
 * （models/user.js 没有身份证字段，导入时算完哈希就丢），没法重算；
 * resetHashes 正是导入时那组初始哈希的常驻备份。
 *
 * @returns {Promise<string>} 给用户看的结果文案
 */
async function resetUserPassword(user) {
  let message;
  if (user.role === 'teacher') {
    // 教师固定 123456：三种哈希字段一起写，保证「登录 / 再次恢复 / 改密时校验旧密码」都认它
    const h = pwd.hashPassword(TEACHER_INITIAL_PASSWORD);
    user.passwordHash = h;
    user.initialHashes = [h];
    user.resetHashes = [h];
    message = `已恢复为初始密码：${TEACHER_INITIAL_PASSWORD}`;
  } else {
    const resetHashes = user.resetHashes || [];
    if (resetHashes.length) {
      // 恢复为名单初始密码，并同步恢复可用的 initialHashes（下次改密用旧密码验证）
      user.passwordHash = resetHashes[0];
      user.initialHashes = [...resetHashes];
      message = '已恢复为初始密码（学号后8位 / 身份证后8位）';
    } else {
      // ⚠️ 不再静默生成随机码（本次改动的刻意决定）：
      //   管理员以为恢复成了「学号后8」、实际是个随机串，学生按学号后8 登不上，
      //   而界面上那句 message 早就滚走了 —— 现场排查成本极高。
      //   没有初始密码数据的账号（例如手工创建、或历史遗留）必须明确报错，让管理员改用「设置密码」。
      throw new ApiError(
        400,
        400,
        '该账号没有名单初始密码数据（学号/身份证后8位），无法恢复为初始密码；请改用「设置密码」指定一个新密码'
      );
    }
  }
  user.mustChangePassword = true;
  user.failedLogins = 0;
  user.lockUntil = null;
  await user.save();
  return message;
}

/**
 * 密码变更的第二个动作：**设置密码**（管理员/班主任直接指定新密码）。
 *
 * 与「恢复初始密码」的区别（用户 2026-10-26 明确）：
 *   · 不强制改密（mustChangePassword=false）—— 管理员主动设的正式密码，不该逼着再改一次；
 *   · 同时清空 initialHashes / resetHashes —— 旧初始密码立即失效，
 *     否则「学号后8」还能登进一个已被重置过的账号（安全倒退）。
 *
 * @param {object} user User 文档
 * @param {string} newPassword 明文新密码
 * @returns {Promise<string>} 结果文案
 */
async function setUserPassword(user, newPassword) {
  const plain = String(newPassword || '');
  // 强度校验（用户第 4 点「要校验强度」）：复用全局唯一口径，避免这里另立一套更宽松的标准
  const invalid = pwd.validateNewPassword(plain);
  if (invalid) throw new ApiError(400, 400, invalid);
  // 与当前密码相同 → 拒绝（否则「变更」是个空操作，用户以为改成功了）
  if (pwd.verifyPassword(plain, user.passwordHash)) {
    throw new ApiError(400, 400, '新密码不能与当前密码相同');
  }
  user.passwordHash = pwd.hashPassword(plain);
  user.initialHashes = [];
  user.resetHashes = [];
  // 设置密码 = 管理员指定的正式密码，不再要求首次登录改密（见函数注释）
  user.mustChangePassword = false;
  user.failedLogins = 0;
  user.lockUntil = null;
  await user.save();
  return '密码已设置';
}

/**
 * 密码变更的统一入口（两个路由共用）：按 mode 分发，路由只做鉴权与取参。
 * @param {object} user
 * @param {{mode?:string, password?:string}} opts mode='initial'（默认）| 'set'
 */
async function changeUserPassword(user, opts = {}) {
  const mode = String(opts.mode || 'initial');
  if (mode === 'set') {
    const message = await setUserPassword(user, opts.password);
    return { mode, message };
  }
  if (mode !== 'initial') {
    throw new ApiError(400, 400, `不支持的密码变更方式：${mode}`);
  }
  const message = await resetUserPassword(user);
  return { mode: 'initial', message };
}

async function refreshDormCountsFor(classNames) {
  for (const cn of [...new Set((classNames || []).map((c) => String(c || '').trim()).filter(Boolean))]) {
    try {
      await classProfilesSvc.refreshDormCounts(cn);
    } catch (e) {
      /* 人数回填失败不影响本次绑定/退宿结果 */
    }
  }
}

/**
 * 删除用户及其全部关联数据（单条接口与批量接口共用）。
 * 注意几处不能漏的收尾（都是历史上踩过的）：
 *   · 吊销「记住我」设备令牌；
 *   · 住宿记录**不物理删除**（查宿历史还要它），但必须置退宿，否则应住人数长期虚高；
 *   · 班级应住人数按涉及的班名回填。
 * @returns {Promise<string>} 被删账号名
 */
async function deleteUserCascade(user) {
  if ((user.permissionGroups || []).includes('superadmin') || (user.permissions || []).includes('*')) {
    throw new ApiError(400, 400, '超级管理员不可删除');
  }
  const oid = user.openid;
  const byOpenid = oid
    ? [
        RunRecord.deleteMany({ openid: oid }),
        WaterRecord.deleteMany({ openid: oid }),
        UserBadge.deleteMany({ openid: oid }),
        UserGoal.deleteMany({ openid: oid }),
        require('../models/body-data').deleteMany({ openid: oid }),
        require('../models/reward-video-record').deleteMany({ openid: oid }),
        require('../models/wx-session').deleteMany({ openid: oid }),
        Appeal.deleteMany({ openid: oid }),
      ]
    : [];
  await Promise.all([...byOpenid, BanRecord.deleteMany({ userId: user._id })]);
  await deviceSvc.revokeAllForUser(user._id); // 吊销「记住我」设备令牌（原实现漏删）
  // 住宿记录不物理删除（查宿历史还要它），但人没了必须置退宿 ——
  // 否则「用户列表」按 openid join 在住记录时，这个已删账号那间房的应住人数会一直虚高。
  if (oid) {
    // 整条取出后再 save（不用 select 部分字段：部分加载的文档写回容易漏字段）
    const activeDorms = await DormAssignment.find({ openid: oid, status: { $in: ['checked_in', 'guest'] } });
    for (const a of activeDorms) {
      a.status = 'checked_out';
      a.remark = `${a.remark || ''}（账号已删除）`.trim();
      await a.save();
    }
    await refreshDormCountsFor(activeDorms.map((a) => a.className));
  }
  await user.deleteOne();
  return user.account || user.nickname || '';
}

// 限制账号功能（类型 + 时长 + 原因）。scope: login | sync | gps
// 超级管理员一律不可限制（不论是谁下的手），否则等于锁死系统。
async function banUser(user, { scope, reason, days, operator } = {}) {
  if ((user.permissionGroups || []).includes('superadmin') || (user.permissions || []).includes('*')) {
    throw new ApiError(400, 400, '不能封禁超级管理员');
  }
  const finalScope = anticheat.SCOPES.includes(scope) ? scope : 'login';
  const info = await anticheat.manualBan(user, {
    scope: finalScope,
    reason,
    days: Number(days) || 0,
    operator,
  });
  return { scope: info.scope, until: info.until, restrictions: anticheat.activeRestrictions(user) };
}

// 解除限制。scope: login | sync | gps | all
async function unbanUser(user, { scope, operator } = {}) {
  const finalScope = ['login', 'sync', 'gps'].includes(scope) ? scope : 'all';
  const { lifted } = await anticheat.manualUnban(user, operator, finalScope);
  return { lifted, restrictions: anticheat.activeRestrictions(user) };
}

/**
 * 解绑微信（用户 2026-10-23：班主任可对本班学生解绑）。
 *
 * 管理端（user.manage）与班级域（班主任对本班学生）共用这一份，避免
 * 「管理端会清 wx_sessions、班级域忘了」这类分裂。
 *
 * ⚠️ 这里清掉的只是**服务端可撤销**的三样东西（openid / wx_sessions / deviceToken）；
 * 小程序侧的 JWT 无法撤销，由 `middlewares/auth.js` 用「令牌里的 openid ≠ user.openid」
 * 判定把旧令牌判 401 —— 少了那一道，解绑后旧设备还能继续用 30 天
 * （2026-10-22 实测撞到：「已经解绑了陈宇航，手机端还是他的超管界面」）。
 *
 * @returns {Promise<{unbound: boolean, openid: string}>}
 */
async function unbindWechat(user) {
  if (!user) throw new ApiError(404, 404, '用户不存在');
  if (!user.openid) throw new ApiError(400, 400, '该账号未绑定微信');
  const openid = user.openid;
  await User.updateOne({ _id: user._id }, { $unset: { openid: 1, openidBoundAt: 1 } });
  await WxSession.deleteMany({ openid });
  await deviceSvc.revokeAllForUser(user._id);
  // 身份缓存按 openid 存，解绑后必须清（与 /api/auth/bind 换绑清缓存同一类问题）：
  // 不清的话，这个微信之后绑到别的账号时，短时间内读到的仍是旧账号的学生会身份。
  // 用延迟 require：避免 services/union ↔ 本文件形成加载期循环依赖。
  try {
    require('./union').clearIdentityCache(openid);
  } catch (e) {
    /* 清不掉只影响一次读取的时效，绝不阻塞解绑本身 */
  }
  return { unbound: true, openid };
}

module.exports = {
  TEACHER_INITIAL_PASSWORD,
  resetUserPassword,
  setUserPassword,
  changeUserPassword,
  deleteUserCascade,
  banUser,
  unbanUser,
  unbindWechat,
};
