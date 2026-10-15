const Badge = require('../models/badge');
const UserBadge = require('../models/user-badge');
const RunRecord = require('../models/run-record');
const { toDateKey, addDays } = require('../utils/dates');

// ===== 徽章形态 =====
//   single：独立徽章（一次达标即获得，如「魅力新人」）
//   tier  ：等级徽章（同一 tierGroup 下按 tierLevel 逐级解锁，如「达标里程」3 级、「登录达人」6 级）
// 等级判断规则产品仍在确认，这里只提供 mode/tierGroup/tierLevel 三个字段与校验，不含等级判定逻辑。
const MODES = ['single', 'tier'];

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
async function aggregateUser(openid) {
  const [agg] = await RunRecord.aggregate([
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
  ]);
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
  return {
    total_steps: agg?.totalSteps || 0,
    total_distance: agg?.totalDistance || 0,
    total_days: dates.length,
    goal_days: agg?.goalDays || 0,
    single_steps: agg?.maxSteps || 0,
    single_distance: agg?.maxDistance || 0,
    streak_days: streak,
  };
}

// ===== 累计口径的进度（仅用于「当前值 / 目标值」展示，不改动授予口径）=====
// 累计量、达标天数、单日最好成绩本身就在 aggregateUser 里；连续打卡要按累计步数看，
// 所以额外做一次「按日汇总步数」的聚合（一次查询，供所有 streak 徽章共用）。
const ACCUMULATE_TYPES = ['total_steps', 'total_distance', 'total_days', 'goal_days', 'single_steps', 'single_distance'];

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
function progressOf(badge, stats, daily) {
  let current = accumulateStat(stats, badge.type);
  if (current == null) {
    current = badge.type === 'streak_days' ? ((daily && daily.streak) || 0) : 0;
  }
  const target = Number(badge.target) || 0;
  return {
    progress: Math.max(0, Math.round(current)),
    nextTarget: (daily && daily.nextTargets ? daily.nextTargets[badge.key] : null) ?? null,
    percent: target > 0 ? Math.max(0, Math.min(100, Math.round((current / target) * 100))) : 0,
  };
}

// 同阶梯组内「比我高一级」的目标值（用于「再跑 N 步到下一级」）
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

// 检查并授予徽章，返回新获得的徽章列表
async function evaluateBadges(openid) {
  const [badges, earned, stats] = await Promise.all([
    Badge.find({ enabled: true }).sort({ sort: 1 }).lean(),
    UserBadge.find({ openid }).distinct('badgeKey'),
    aggregateUser(openid),
  ]);
  const earnedSet = new Set(earned);
  const newBadges = [];
  for (const badge of badges) {
    if (earnedSet.has(badge.key)) continue;
    const value = stats[badge.type];
    if (typeof value === 'number' && value >= badge.target) {
      // 等级徽章（mode='tier'）落库时记下所在等级；独立徽章固定 0
      const level = badge.mode === 'tier' ? Number(badge.tierLevel) || 0 : 0;
      await UserBadge.updateOne(
        { openid, badgeKey: badge.key },
        { $setOnInsert: { openid, badgeKey: badge.key, level } },
        { upsert: true }
      );
      newBadges.push(badge);
    }
  }
  return newBadges;
}

// 刷新用户汇总缓存
async function refreshUserStats(user) {
  const stats = await aggregateUser(user.openid);
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
  DEFAULT_BADGES,
  modeOf,
  aggregateUser,
  tallyUser,
  buildNextTargets,
  progressOf,
  evaluateBadges,
  refreshUserStats,
  seedBadges,
  backfillBadgeModes,
  toDateKey,
};
