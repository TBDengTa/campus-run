const GoalConfig = require('../models/goal-config');
const BanRecord = require('../models/ban-record');
const User = require('../models/user');

// ===== 限制的作用域 =====
//   login 限制登录（整账号，走 user.status + bannedUntil）
//   sync  限制微信同步（微信运动步数同步）
//   gps   限制 GPS 实跑
const SCOPES = ['login', 'sync', 'gps'];
const DAY_MS = 24 * 3600 * 1000;
const SCOPE_TEXT = { login: '登录', sync: '微信同步', gps: 'GPS 实跑' };

function normalizeScope(scope) {
  if (scope === 'manual') return 'login'; // 历史记录 banType='manual' 即整账号封禁
  return SCOPES.includes(scope) ? scope : 'login';
}

function scopeText(scope) {
  return SCOPE_TEXT[normalizeScope(scope)] || '功能';
}

// 某作用域当前是否生效（到期视为失效，不写库）
function isRestricted(user, scope) {
  const s = normalizeScope(scope);
  const now = new Date();
  if (s === 'login') {
    return user.status === 'banned' && (!user.bannedUntil || user.bannedUntil > now);
  }
  const r = (user.restrictions || {})[s];
  return !!(r && r.until && r.until > now);
}

// 生效中的全部限制（给接口/小程序展示与申诉用）
function activeRestrictions(user) {
  const now = new Date();
  const out = [];
  if (user.status === 'banned' && (!user.bannedUntil || user.bannedUntil > now)) {
    out.push({ scope: 'login', text: scopeText('login'), reason: user.banReason || '', until: user.bannedUntil || null });
  }
  for (const s of ['sync', 'gps']) {
    const r = (user.restrictions || {})[s];
    if (r && r.until && r.until > now) {
      out.push({ scope: s, text: scopeText(s), reason: r.reason || '', until: r.until });
    }
  }
  return out;
}

// 生效中的单项限制（供 run 路由拦截）
function activeRestriction(user, scope) {
  const s = normalizeScope(scope);
  return activeRestrictions(user).find((r) => r.scope === s) || null;
}

/**
 * 写入限制（自动反作弊与人工封禁共用）
 * @param {Object} p
 * @param {Object} p.user      用户文档（会被 save）
 * @param {String} p.scope     login | sync | gps
 * @param {String} p.reason    原因
 * @param {Number} p.days      >0 天数；<=0 永久
 * @param {String} p.operator  'system' 或管理员 openid
 * @param {Boolean} p.escalate 同类 24h 内重犯 → 升级为限制登录
 * @returns {{ scope, until, escalated }}
 */
async function restrict({ user, scope, reason, days = 0, operator = 'system', escalate = false }) {
  const target = normalizeScope(scope);
  const now = new Date();
  const until = days > 0 ? new Date(now.getTime() + days * DAY_MS) : null;
  const baseReason = String(reason || '').trim() || '数据异常';

  let finalScope = target;
  if (escalate && target !== 'login') {
    const prev = (user.restrictions || {})[target] || {};
    const recent = prev.at && now.getTime() - new Date(prev.at).getTime() < DAY_MS;
    if (recent) finalScope = 'login';
  }
  const escalated = finalScope !== target;
  const finalReason = escalated
    ? `${baseReason}（同类违规 24 小时内重复，升级为限制登录）`
    : baseReason;

  if (finalScope === 'login') {
    user.status = 'banned';
    user.banReason = finalReason;
    user.banType = 'login';
    user.bannedAt = now;
    user.bannedUntil = until;
  } else {
    const prev = (user.restrictions || {})[finalScope] || {};
    user.restrictions[finalScope] = {
      until,
      reason: finalReason,
      at: now,
      count: (prev.count || 0) + 1,
      operator,
    };
  }
  await user.save();
  await BanRecord.create({
    userId: user._id,
    openid: user.openid,
    action: 'ban',
    banType: finalScope,
    reason: finalReason,
    durationDays: days || 0,
    bannedUntil: until,
    operator,
  });
  return { scope: finalScope, until, escalated };
}

/**
 * 解除限制
 * @param {Object} p
 * @param {String} p.scope  login | sync | gps | all
 */
async function lift({ user, scope = 'all', operator, reason = '解封' }) {
  const now = new Date();
  const targets = scope === 'all' ? SCOPES : [normalizeScope(scope)];
  const lifted = [];
  for (const s of targets) {
    if (s === 'login') {
      if (user.status === 'banned' || user.bannedUntil || user.banReason) {
        user.status = 'active';
        user.banReason = '';
        user.banType = '';
        user.bannedAt = null;
        user.bannedUntil = null;
        lifted.push('login');
      }
    } else {
      const r = (user.restrictions || {})[s];
      if (r && (r.until || r.reason)) {
        user.restrictions[s] = { until: null, reason: '', at: now, count: r.count || 0, operator: operator || 'system' };
        lifted.push(s);
      }
    }
  }
  if (!lifted.length) return { lifted };
  await user.save();
  for (const s of lifted) {
    await BanRecord.create({
      userId: user._id,
      openid: user.openid,
      action: 'unban',
      banType: s,
      reason,
      operator: operator || 'system',
    });
  }
  return { lifted };
}

// ===== 反作弊检查 =====
// 步数暴增（微信运动同步）→ 限制微信同步；24h 内重犯升级为限制登录
async function checkStepJump(user, date, previousSteps, newSteps) {
  const config = await GoalConfig.getSingleton();
  if (!config.anticheat.enabled) return { violation: false };
  const jump = newSteps - previousSteps;
  if (jump > config.anticheat.maxStepJumpPerSync) {
    const days = config.anticheat.banDays || 7;
    const info = await restrict({
      user,
      scope: 'sync',
      days,
      operator: 'system',
      escalate: true,
      reason: `单次同步暴增${jump.toLocaleString()}步，数据异常`,
    });
    return { violation: true, ...info, message: `单次同步暴增${jump}步` };
  }
  return { violation: false };
}

// 配速异常（GPS 实跑）→ 限制 GPS；24h 内重犯升级为限制登录
async function checkPace(user, distanceMeters, durationSeconds) {
  const config = await GoalConfig.getSingleton();
  if (!config.anticheat.enabled) return { violation: false };
  if (distanceMeters >= 500 && durationSeconds > 0) {
    const paceSeconds = durationSeconds / (distanceMeters / 1000);
    if (paceSeconds < config.anticheat.minPaceSecondsPerKm) {
      const m = Math.floor(paceSeconds / 60);
      const s = Math.round(paceSeconds % 60);
      const days = config.anticheat.banDays || 7;
      const info = await restrict({
        user,
        scope: 'gps',
        days,
        operator: 'system',
        escalate: true,
        reason: `配速${m}'${String(s).padStart(2, '0')}/公里，低于${Math.floor(config.anticheat.minPaceSecondsPerKm / 60)}分钟/公里，异常`,
      });
      return { violation: true, ...info, message: '配速异常' };
    }
  }
  return { violation: false };
}

// ===== 管理端（人工）=====
// scope: login 限制登录（默认，整账号）/ sync 限制微信同步 / gps 限制 GPS
async function manualBan(user, { reason, days, operator, scope = 'login' }) {
  return restrict({ user, scope, reason: reason || '违反社区规范', days: days || 0, operator });
}

// scope 省略时解除全部限制
async function manualUnban(user, operator, scope = 'all') {
  return lift({ user, scope, operator, reason: '管理员解封' });
}

module.exports = {
  SCOPES,
  scopeText,
  isRestricted,
  activeRestriction,
  activeRestrictions,
  restrict,
  lift,
  checkStepJump,
  checkPace,
  manualBan,
  manualUnban,
};
