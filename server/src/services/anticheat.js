const GoalConfig = require('../models/goal-config');
const BanRecord = require('../models/ban-record');
const User = require('../models/user');

// 反作弊：步数暴增 / 配速异常 → 自动封禁
// 返回 { violation: boolean, message }
async function checkStepJump(user, date, previousSteps, newSteps) {
  const config = await GoalConfig.getSingleton();
  if (!config.anticheat.enabled) return { violation: false };
  const jump = newSteps - previousSteps;
  if (jump > config.anticheat.maxStepJumpPerSync) {
    await applyBan({
      user,
      banType: 'sync',
      reason: `单次同步暴增${jump.toLocaleString()}步，数据异常`,
      days: config.anticheat.banDays,
    });
    return { violation: true, message: `单次同步暴增${jump}步` };
  }
  return { violation: false };
}

async function checkPace(user, distanceMeters, durationSeconds) {
  const config = await GoalConfig.getSingleton();
  if (!config.anticheat.enabled) return { violation: false };
  if (distanceMeters >= 500 && durationSeconds > 0) {
    const paceSeconds = durationSeconds / (distanceMeters / 1000);
    if (paceSeconds < config.anticheat.minPaceSecondsPerKm) {
      const m = Math.floor(paceSeconds / 60);
      const s = Math.round(paceSeconds % 60);
      await applyBan({
        user,
        banType: 'sync',
        reason: `配速${m}'${String(s).padStart(2, '0')}/公里，低于${Math.floor(config.anticheat.minPaceSecondsPerKm / 60)}分钟/公里，异常`,
        days: config.anticheat.banDays,
      });
      return { violation: true, message: '配速异常' };
    }
  }
  return { violation: false };
}

async function applyBan({ user, banType, reason, days }) {
  const bannedUntil = new Date(Date.now() + days * 24 * 3600 * 1000);
  user.status = 'banned';
  user.banReason = reason;
  user.banType = banType;
  user.bannedAt = new Date();
  user.bannedUntil = bannedUntil;
  await user.save();
  await BanRecord.create({
    userId: user._id,
    openid: user.openid,
    action: 'ban',
    banType,
    reason,
    durationDays: days,
    bannedUntil,
    operator: 'system',
  });
}

// 手动封禁/解封（管理端）
async function manualBan(user, { reason, days, operator }) {
  const bannedUntil = new Date(Date.now() + (days || 0) * 24 * 3600 * 1000);
  user.status = 'banned';
  user.banReason = reason || '违反社区规范';
  user.banType = 'manual';
  user.bannedAt = new Date();
  user.bannedUntil = days > 0 ? bannedUntil : null; // days<=0 视为永久
  await user.save();
  await BanRecord.create({
    userId: user._id,
    openid: user.openid,
    action: 'ban',
    banType: 'manual',
    reason: user.banReason,
    durationDays: days || 0,
    bannedUntil: days > 0 ? bannedUntil : null,
    operator,
  });
}

async function manualUnban(user, operator) {
  user.status = 'active';
  user.banReason = '';
  user.banType = '';
  user.bannedAt = null;
  user.bannedUntil = null;
  await user.save();
  await BanRecord.create({
    userId: user._id,
    openid: user.openid,
    action: 'unban',
    banType: 'manual',
    reason: '管理员解封',
    operator,
  });
}

module.exports = { checkStepJump, checkPace, applyBan, manualBan, manualUnban };
