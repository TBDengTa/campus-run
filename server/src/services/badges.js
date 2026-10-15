const Badge = require('../models/badge');
const UserBadge = require('../models/user-badge');
const RunRecord = require('../models/run-record');
const pointsSvc = require('./points');
const { toDateKey, addDays } = require('../utils/dates');

// ===== 徽章形态 =====
//   single：独立徽章（一次达标即获得，如「魅力新人」）
//   tier  ：等级徽章（同一 tierGroup 下按 tierLevel 逐级解锁，如「达标里程」3 级、「登录达人」6 级）
// 等级判断规则产品仍在确认，这里只提供 mode/tierGroup/tierLevel 三个字段与校验，不含等级判定逻辑。
const MODES = ['single', 'tier'];

// ===== 支持的达成条件（type）=====
//   total_steps / total_distance / total_days / goal_days / single_steps / single_distance / streak_days
//     —— 运动数据汇总（aggregateUser / tallyUser）
//   points —— 全历史累计跑分（≥ target 分）
//   rank   —— 全校跑分总榜名次（≤ target 名，数值越小越好）；数据源见下方 RANK_* 区
// 跑分口径一律复用 services/points.js（禁止在本文件重写公式）。

// ===== 默认徽章定义（全新部署播种用；也是 1.0 迁移的兜底定义）=====
const DEFAULT_BADGES = [
  { key: 'first_run', name: '初次奔跑', description: '完成第一次跑步打卡', type: 'total_days', target: 1, sort: 1 },
  { key: 'steps_100k', name: '十万步', description: '累计步数达到 100,000', type: 'total_steps', target: 100000, sort: 2 },
  { key: 'steps_500k', name: '五十万步', description: '累计步数达到 500,000', type: 'total_steps', target: 500000, sort: 3 },
  { key: 'steps_1m', name: '百万步传说', description: '累计步数达到 1,000,000', type: 'total_steps', target: 1000000, sort: 4 },
  { key: 'single_20k', name: '两万步勇士', description: '单日步数达到 20,000', type: 'single_steps', target: 20000, sort: 5 },
  { key: 'single_5km', name: '五公里达成', description: '单次跑步距离达到 5 公里', type: 'single_distance', target: 5000, sort: 6 },
  { key: 'days_7', name: '坚持一周', description: '累计打卡 7 天', type: 'total_days', target: 7, sort: 7 },
  { key: 'days_30', name: '坚持一月', description: '累计打卡 30 天', type: 'total_days', target: 30, sort: 8 },
  { key: 'days_100', name: '百日坚持', description: '累计打卡 100 天', type: 'total_days', target: 100, sort: 9 },
  { key: 'streak_7', name: '七日连击', description: '连续打卡 7 天', type: 'streak_days', target: 7, sort: 10 },
];

// 默认徽章的形态：有阶梯组即等级徽章（当前 10 枚均为独立徽章）
function modeOf(def) {
  return def.tierGroup ? 'tier' : 'single';
}

// 汇总用户跑步数据
//   withPoints=false：调用方只要步数/距离/天数汇总（如 services/steps.js::refreshUserStats），
//   跳过跑分聚合（跑分是 2 次单用户聚合 + 1 次配置读取），同步热路径不必付这份成本。
//   注意：徽章发放（evaluateBadges）必须带 points —— points 徽章靠它判定达标。
async function aggregateUser(openid, { withPoints = true } = {}) {
  const [aggRows, pointsTotal] = await Promise.all([
    RunRecord.aggregate([
      { $match: { openid } },
      {
        $group: {
          _id: null,
          totalSteps: { $sum: '$steps' },
          totalDistance: { $sum: '$distance' },
          maxSteps: { $max: '$steps' },
          maxDistance: { $max: '$distance' },
          goalDays: { $sum: { $cond: [{ $eq: ['$goalAchieved', true] }, 1, 0] } },
          dates: { $addToSet: '$date' },
        },
      },
    ]),
    // 跑分一律走 services/points.js（唯一公式来源）：与 /api/points/me 的 total 同口径
    withPoints ? pointsSvc.sumPointsTotal(openid).then((r) => r.total || 0) : Promise.resolve(null),
  ]);
  const agg = aggRows[0];
  const dates = (agg?.dates || []).sort();
  // 连续打卡：从最近记录日往前数连续天数
  let streak = 0;
  if (dates.length) {
    let cursor = dates[dates.length - 1];
    const set = new Set(dates);
    while (set.has(cursor)) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }
  }
  const stats = {
    total_steps: agg?.totalSteps || 0,
    total_distance: agg?.totalDistance || 0,
    total_days: dates.length,
    goal_days: agg?.goalDays || 0,
    single_steps: agg?.maxSteps || 0,
    single_distance: agg?.maxDistance || 0,
    streak_days: streak,
  };
  if (pointsTotal != null) stats.points = pointsTotal;
  // rank 不在这里算：全校总榜极贵（见 getRankIndex），只在显式允许时由 evaluateBadges 注入
  return stats;
}

// ===== 累计口径的进度（仅用于「当前值 / 目标值」展示，不改动授予口径）=====
// 累计量、达标天数、单日最好成绩本身就在 aggregateUser 里；连续打卡要按累计步数看，
// 所以额外做一次「按日汇总步数」的聚合（一次查询，供所有 streak 徽章共用）。
// points（累计跑分）与它们同为「越大越好」的累计量，一并放进这张表。
const ACCUMULATE_TYPES = ['total_steps', 'total_distance', 'total_days', 'goal_days', 'single_steps', 'single_distance', 'points'];

// ===== 跑分总榜排名（rank 徽章）=================================================
// 语义：`rank` 徽章的 target = 名次，**越小越好**（target=100 → 全校跑分前 100 名）。
//   stats.rank = 该用户在全校跑分总榜的名次（1 起）；0 = 未上榜（0 分 / 不参与排名 / 拿不到榜单）。
// 成本控制（产品硬要求：绝不在每次同步 / 每次评估时全表排名）：
//   ① 榜单**整体只算一次**：pointsSvc.pointsTotalsAllUsers()（实测 110k run_records / 1538 账号 ≈ 2.7s）；
//   ② 进程内缓存 RANK_TTL_MS（60s），并发重复请求共用同一个 in-flight promise；
//   ③ 缓存**过期**时先返回旧榜并在后台重建（stale-while-revalidate），只有**进程内第一次**会阻塞等待；
//   ④ allowCompute=false（GET /api/badges、步数同步的评估）**只读**缓存，绝不触发全表排名。
const RANK_TTL_MS = 60 * 1000;
const RANK_TYPE = 'rank';

let rankCache = null; // { at, map: Map<openid, rank>, ranked: Number }
let rankInFlight = null;

function ensureRankRefresh() {
  if (!rankInFlight) {
    rankInFlight = pointsSvc
      .pointsTotalsAllUsers()
      .then((rows) => {
        const map = new Map();
        // rows 已按分数倒序，下标 +1 即名次（只含 points>0 的上榜账号）
        rows.forEach((r, i) => map.set(r.openid, i + 1));
        rankCache = { at: Date.now(), map, ranked: map.size };
        return map;
      })
      .catch((err) => {
        // 榜单构建失败不能让「检测徽章」整体 500：本轮按「未上榜」处理，下轮再试
        console.warn('[badges] 跑分总榜构建失败，rank 徽章本轮跳过：', err.message);
        return null;
      })
      .finally(() => {
        rankInFlight = null;
      });
  }
  return rankInFlight;
}

// 只读快照（不触发任何计算、不管是否过期）：给进度展示用
function peekRankIndex() {
  return rankCache ? rankCache.map : null;
}

/**
 * 取跑分总榜名次索引
 * @param {{ allowCompute?: Boolean }} opts allowCompute=true 时才允许触发全表排名（只有 POST /api/badges/check 这么做）
 * @returns {Promise<Map<String, Number>|null>}
 */
async function getRankIndex({ allowCompute = false } = {}) {
  if (rankCache && Date.now() - rankCache.at < RANK_TTL_MS) return rankCache.map;
  if (!allowCompute) return rankCache ? rankCache.map : null;
  if (rankCache) {
    // 过期：先给旧榜（不阻塞请求），后台重建
    ensureRankRefresh();
    return rankCache.map;
  }
  // 进程内第一次（冷启动）：等一次，保证首次「按需检测」就能正确发放 rank 徽章
  return ensureRankRefresh();
}

/**
 * 某用户在全校跑分总榜的名次；0 = 未上榜（含「拿不到榜单」的情况）
 * @param {String} openid
 * @param {{ allowCompute?: Boolean }} opts
 */
async function rankOf(openid, { allowCompute = false } = {}) {
  const map = await getRankIndex({ allowCompute });
  if (!map || !openid) return 0;
  return map.get(openid) || 0;
}

// 测试/运维用：清掉进程内榜单缓存
function clearRankCache() {
  rankCache = null;
  rankInFlight = null;
}

// 达标判定：普通类型「≥ target」；rank 类型「上榜且名次 ≤ target」
function reached(badge, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const target = Number(badge.target) || 0;
  if (badge.type === RANK_TYPE) return value > 0 && target > 0 && value <= target;
  return value >= target;
}

function accumulateStat(stats, type) {
  if (!stats) return null;
  return ACCUMULATE_TYPES.includes(type) ? stats[type] : null;
}

function streakFromDailySums(rows) {
  const sums = (rows || []).filter((r) => r && r.date).sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!sums.length) return 0;
  let streak = 0;
  let cursor = sums[0].date;
  for (const r of sums) {
    if (r.date !== cursor) break;
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

async function tallyUser(openid) {
  const rows = await RunRecord.aggregate([
    { $match: { openid } },
    { $group: { _id: '$date', steps: { $sum: '$steps' } } },
    { $project: { _id: 0, date: '$_id', steps: 1 } },
  ]);
  const dates = rows.map((r) => r.date).filter(Boolean).sort();
  return {
    days: dates.length,
    stepDays: rows.filter((r) => Number(r.steps) > 0).length,
    streak: streakFromDailySums(rows),
  };
}

// 每枚徽章的进度：progress=当前值，nextTarget=同阶梯组的下一级目标（无则 null），percent=0~100
//   rank 特例：progress = 当前名次（0 = 未上榜），percent = 目标名次 / 当前名次（越小越接近 100）
function progressOf(badge, stats, daily) {
  const target = Number(badge.target) || 0;
  const nextTarget = (daily && daily.nextTargets ? daily.nextTargets[badge.key] : null) ?? null;
  if (badge.type === RANK_TYPE) {
    const rank = Math.max(0, Math.round(Number((stats && stats.rank) || 0) || 0));
    return {
      progress: rank,
      nextTarget,
      percent: rank > 0 && target > 0 ? Math.max(0, Math.min(100, Math.round((target / rank) * 100))) : 0,
    };
  }
  let current = accumulateStat(stats, badge.type);
  if (current == null) {
    current = badge.type === 'streak_days' ? ((daily && daily.streak) || 0) : 0;
  }
  return {
    progress: Math.max(0, Math.round(current)),
    nextTarget,
    percent: target > 0 ? Math.max(0, Math.min(100, Math.round((current / target) * 100))) : 0,
  };
}

// 同阶梯组内「比我高一级」的目标值（用于「再跑 N 步到下一级」）
// 与 type 无关：points/rank 的等级组同样按 tierLevel 排序取下一级的 target（后者是「前 N 名」）
function buildNextTargets(badges) {
  const byGroup = new Map();
  for (const b of badges || []) {
    const group = b.tierGroup || '';
    if (!group) continue;
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(b);
  }
  const nextTargets = {};
  for (const [, list] of byGroup) {
    const sorted = [...list].sort((a, b) => (Number(a.tierLevel) || 0) - (Number(b.tierLevel) || 0));
    sorted.forEach((b, i) => {
      const next = sorted[i + 1];
      if (next) nextTargets[b.key] = Number(next.target) || null;
    });
  }
  return nextTargets;
}

// 检查并授予徽章，返回**本次真正新发放**的徽章列表（幂等：已获得的不重发，重复调用第二次为空）
//   preloaded：可选，调用方已经查好的 { badges, earned, stats }，避免同一次请求里重复聚合
//   （按需检测接口要同时产出 newBadges 与 earnedCount，复用这三份数据就只有 3 次查询）
//   preloaded.allowRank：只有 POST /api/badges/check 会传 true —— 它是唯一允许触发
//   「全校跑分总榜」计算的路径（且仍受 TTL/进程内缓存约束）；步数同步等其它调用方一律 false，
//   连「按需检测」以外的写入路径都不会做全表排名。
async function evaluateBadges(openid, preloaded) {
  const [badges, earned, stats] = await Promise.all([
    preloaded && preloaded.badges ? preloaded.badges : Badge.find({ enabled: true }).sort({ sort: 1 }).lean(),
    preloaded && preloaded.earned ? preloaded.earned : UserBadge.find({ openid }).distinct('badgeKey'),
    preloaded && preloaded.stats ? preloaded.stats : aggregateUser(openid),
  ]);
  const earnedSet = new Set(earned);
  const pending = badges.filter((b) => !earnedSet.has(b.key));
  // rank 徽章才需要总榜名次：缓存命中直接读，未命中/过期按 allowRank 决定是否重建
  let values = stats;
  if (pending.some((b) => b.type === RANK_TYPE)) {
    const rank = await rankOf(openid, { allowCompute: !!(preloaded && preloaded.allowRank) });
    values = { ...stats, rank };
  }
  const newBadges = [];
  for (const badge of pending) {
    const value = values[badge.type];
    if (reached(badge, value)) {
      // 等级徽章（mode='tier'）落库时记下所在等级；独立徽章固定 0
      const level = badge.mode === 'tier' ? Number(badge.tierLevel) || 0 : 0;
      // $setOnInsert + upsert 本身幂等，但并发下可能已被别的请求插入——
      // 只有真正插入了新行才计入 newBadges，保证「第二次调用 newBadges 为空」。
      const r = await UserBadge.updateOne(
        { openid, badgeKey: badge.key },
        { $setOnInsert: { openid, badgeKey: badge.key, level } },
        { upsert: true }
      );
      const inserted = !!(r && (r.upsertedCount || r.upsertedId));
      if (inserted) newBadges.push(badge);
    }
  }
  return newBadges;
}

// 刷新用户汇总缓存（只要步数/距离/天数，不付跑分聚合的成本）
async function refreshUserStats(user) {
  const stats = await aggregateUser(user.openid, { withPoints: false });
  user.totalSteps = stats.total_steps;
  user.totalDistance = stats.total_distance;
  user.totalDays = stats.total_days;
  user.lastSyncAt = new Date();
  await user.save();
  return stats;
}

// ===== 启动期播种（幂等）=====
// 播种只服务于「全新部署」：库里已有任何徽章定义时整体跳过。
// 原因：现网徽章用旧 hex key（badges.key='6a27...'）+ 图片 URL，而 DEFAULT_BADGES 是语义 key
// （first_run/steps_100k…）。若按 key 逐条补建，会把语义 key 的僵尸定义混进库里，
// 徽章页出现双份、图标缺失；清理见 scripts/dedupe-badge-definitions.js。
// 已存在的一律不动，绝不覆盖运营改过的 name/icon/target/enabled 等字段。
async function seedBadges() {
  const existing = await Badge.estimatedDocumentCount();
  if (existing > 0) {
    return { created: 0, keys: [], total: DEFAULT_BADGES.length, skipped: true, existing };
  }
  const created = [];
  for (const def of DEFAULT_BADGES) {
    await Badge.create({
      ...def,
      icon: def.icon || '',
      tierGroup: def.tierGroup || '',
      tierLevel: def.tierLevel || 0,
      tierColor: def.tierColor || '',
      enabled: def.enabled !== false,
      mode: def.mode || modeOf(def),
    });
    created.push(def.key);
  }
  // 日志只在真正插入时输出
  if (created.length) {
    console.log(`[badges] 默认徽章播种完成：新增 ${created.length} 枚（${created.join(', ')}）`);
  }
  return { created: created.length, keys: created, total: DEFAULT_BADGES.length, skipped: false, existing: 0 };
}

// ===== 旧数据回填（幂等）=====
// 规则：tierGroup 非空 → mode='tier'；tierGroup 为空 → mode='single'。
// 已有 mode 的定义一律不动（不覆盖运营/其它写入方的设置）。
async function backfillBadgeModes() {
  const [tierR, singleR] = await Promise.all([
    Badge.updateMany(
      { tierGroup: { $nin: [null, ''] }, $or: [{ mode: { $exists: false } }, { mode: null }, { mode: '' }] },
      { $set: { mode: 'tier' } }
    ),
    Badge.updateMany(
      { tierGroup: { $in: [null, ''] }, $or: [{ mode: { $exists: false } }, { mode: null }, { mode: '' }] },
      { $set: { mode: 'single' } }
    ),
  ]);
  const n = (r) => (r && (r.modifiedCount || r.nModified)) || 0;
  const patched = n(tierR) + n(singleR);
  if (patched) console.log(`[badges] 旧徽章定义回填 mode：tier ${n(tierR)} 条，single ${n(singleR)} 条`);
  return { patched, tier: n(tierR), single: n(singleR) };
}

module.exports = {
  MODES,
  RANK_TYPE,
  RANK_TTL_MS,
  DEFAULT_BADGES,
  modeOf,
  aggregateUser,
  tallyUser,
  buildNextTargets,
  progressOf,
  evaluateBadges,
  rankOf,
  getRankIndex,
  peekRankIndex,
  clearRankCache,
  refreshUserStats,
  seedBadges,
  backfillBadgeModes,
  toDateKey,
};
