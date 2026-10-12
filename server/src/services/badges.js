const Badge = require('../models/badge');
const UserBadge = require('../models/user-badge');
const RunRecord = require('../models/run-record');
const { toDateKey, addDays } = require('../utils/dates');

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
      await UserBadge.updateOne(
        { openid, badgeKey: badge.key },
        { $setOnInsert: { openid, badgeKey: badge.key } },
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

module.exports = { aggregateUser, evaluateBadges, refreshUserStats, toDateKey };
