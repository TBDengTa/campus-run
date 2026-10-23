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
const crypto = require('crypto');
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

/**
 * 重置密码（单条接口与批量接口共用）。
 * 为什么必须共用：批量如果另写一份，就会出现「单条会同步恢复 initialHashes、批量不会」
 * 这类分裂（下次改密用旧密码验证就会失败）。
 * @returns {Promise<string>} 给用户看的结果文案
 */
async function resetUserPassword(user) {
  let message;
  const resetHashes = user.resetHashes || [];
  if (resetHashes.length) {
    // 恢复为名单初始密码，并同步恢复可用的 initialHashes（下次改密用旧密码验证）
    user.passwordHash = resetHashes[0];
    user.initialHashes = [...resetHashes];
    message = '已重置为初始密码（证件/学号后8位）';
  } else {
    const randomPwd = crypto.randomBytes(4).toString('hex');
    user.passwordHash = pwd.hashPassword(randomPwd);
    user.initialHashes = [pwd.hashPassword(randomPwd)];
    user.resetHashes = [pwd.hashPassword(randomPwd)];
    message = `该账号无名单初始密码数据，已生成随机密码：${randomPwd}`;
  }
  user.mustChangePassword = true;
  user.failedLogins = 0;
  user.lockUntil = null;
  await user.save();
  return message;
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

module.exports = { resetUserPassword, deleteUserCascade, banUser, unbanUser };
