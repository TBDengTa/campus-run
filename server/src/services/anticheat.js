const GoalConfig = require('../models/goal-config');
const BanRecord = require('../models/ban-record');
const User = require('../models/user');
const badgesSvc = require('./badges');

// ===== 限制的作用域 =====
//   login 限制登录（整账号，走 user.status + bannedUntil）
//   sync  限制微信同步（微信运动步数同步）
//   gps   限制 GPS 实跑
const SCOPES = ['login', 'sync', 'gps'];
const DAY_MS = 24 * 3600 * 1000;
const SCOPE_TEXT = { login: '登录', sync: '微信同步', gps: 'GPS 实跑' };

// ===== 微信运动同步的误伤护栏（用户 2026-10-26「同步的微信步数不要被封禁」）=====
// STALE_SYNC_MS：距上次同步超过这么久，就视为「攒了一段时间才同步」——
//   此时增量天然等于这段时间的累计步数，一律不按「暴增」处理（首次同步同理）。
const STALE_SYNC_MS = 30 * 60 * 1000;
// MAX_REASONABLE_DAILY_STEPS：单日步数的物理上限。真实高强度用户（长跑/巡逻）能到 3~5 万，
//   超过这个数才可能是脚本刷步；不超过它的一律视为真实步数，判违规没有意义。
const MAX_REASONABLE_DAILY_STEPS = 50000;

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
  // ===== 徽章撤销（产品口径）=====
  // 撤销触发源只有两处：① 反作弊判定成立（checkStepJump / checkPace）；② 封禁（人工 manualBan 与申诉外的限制）。
  // 两者都收敛到本函数，所以在这里删一次即可 —— **只在判定成立时执行**（restrict 不会被正常用户触发），
  // 正常的 evaluateBadges 评估不会走到这里，绝不会误删普通用户的徽章。
  // 语义：删除记录（不加 revoked 字段），解封/到期**不自动恢复**；用户以后再次满足条件会自然重新获得。
  // 幂等：deleteMany 命中 0 行也成功。清理失败绝不能影响「限制生效」这一主流程 → 只记日志。
  try {
    await badgesSvc.revokeBadgesFor(user.openid, { reason: `限制${scopeText(finalScope)}：${finalReason}` });
  } catch (e) {
    console.warn(`[anticheat] 撤销徽章失败（不影响限制生效）openid=${user.openid}: ${e.message}`);
  }
  return { scope: finalScope, until, escalated };
}

/**
 * 解除限制
 * @param {Object} p
 * @param {String} p.scope  login | sync | gps | all
 *
 * 注意（产品口径）：解封 / 限制到期**不恢复徽章** —— 撤销是删除记录，没有「恢复」动作；
 * 用户下次满足条件时由 evaluateBadges 重新发放（见 revokeBadgesFor 注释）。
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
/**
 * 步数暴增检测（微信运动同步）→ 限制微信同步；24h 内重犯升级为限制登录。
 *
 * ⚠️ 用户 2026-10-26：「微信运动学生账户要进入页面自动同步，同步的微信步数不要被封禁」。
 * 这条检测**原本会误伤正常人**，必须按「同步节奏」而不是「绝对增量」判断：
 *
 *   反例（修复前必然踩到）：学生白天走了 15000 步，晚上第一次进小程序（或昨天没开过），
 *   一次同步写入 15000 步 → 旧逻辑只看 `jump > maxStepJumpPerSync(13000)`
 *   → 判「单次同步暴增」→ 限制微信同步 7 天；24h 内再撞一次就**升级为限制登录**。
 *   可这完全是微信运动的真实步数，用户什么也没做错。**进页面自动同步会让这个误伤频次大增**。
 *
 * 正确口径（三个条件都要满足才算异常）：
 *   ① **不是「攒了很久才同步」** —— 距上次微信同步超过 STALE_SYNC_MS（30 分钟）时，
 *      增量天然就是「这段时间攒下的全部步数」，属于正常补同步；首次同步同理（无记录即 stale）。
 *   ② 当日累计超过 MAX_REASONABLE_DAILY_STEPS（50000）：真实高强度用户也能到 3~5 万步，
 *      旧阈值 13000 对「全天累计的首同步」过窄。
 *   ③ 同时单次增量仍超过配置阈值：短窗口内暴增这么多，才可能是脚本刷步。
 *
 * @param {object} user
 * @param {string} date 日期键 YYYY-MM-DD
 * @param {number} previousSteps 今天已记录的步数
 * @param {number} newSteps 本次同步的当日累计步数
 * @param {{lastSyncAt?: number}} [ctx] 该用户上一次微信同步的时间戳（毫秒）
 */
async function checkStepJump(user, date, previousSteps, newSteps, ctx = {}) {
  const config = await GoalConfig.getSingleton();
  if (!config.anticheat.enabled) return { violation: false };
  const jump = (newSteps || 0) - (previousSteps || 0);
  if (jump <= 0) return { violation: false };

  // ① 首次同步 / 长时间未同步后的补同步 → 增量天然是累计值，不算「暴增」
  const lastSyncAt = Number(ctx.lastSyncAt) || 0;
  const stale = lastSyncAt > 0 ? Date.now() - lastSyncAt > STALE_SYNC_MS : true;
  if (stale) return { violation: false };

  // ② 当日累计没超过物理上限 → 真实步数，不判违规
  if ((newSteps || 0) <= MAX_REASONABLE_DAILY_STEPS) return { violation: false };

  // ③ 短窗口内仍然暴增超过配置阈值 → 才认定异常
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
