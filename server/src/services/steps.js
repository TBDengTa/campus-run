const RunRecord = require('../models/run-record');
const RewardVideoRecord = require('../models/reward-video-record');
const GoalConfig = require('../models/goal-config');
const wechat = require('./wechat');
const anticheat = require('./anticheat');
const badgesSvc = require('./badges');
const { todayKey } = require('../utils/dates');

function withPace(doc) {
  doc.pace = wechat.formatPace(doc.durationSeconds, doc.distance);
  if (!doc.steps) doc.goalAchieved = false;
  return doc;
}

// 教师账号不参与运动记录（步数同步 / GPS 实跑 / 激励视频加步数）
const TEACHER_BLOCK_MESSAGE = '教师账号不参与运动记录';

function isTeacher(user) {
  return !!user && user.role === 'teacher';
}

function teacherBlock(user) {
  return isTeacher(user) ? { blocked: true, reason: TEACHER_BLOCK_MESSAGE } : null;
}

// 同步窗口：1 小时内的多次微信同步合并为同一条记录；超过 1 小时则新建当日的下一条记录
const SYNC_WINDOW_MS = 60 * 60 * 1000;

/**
 * 同步微信运动某日步数（werun 数据 30 天内逐日同步）
 *
 * 记录规则（每次同步都独立留痕，便于记录页看清"什么时候同步了多少"）：
 * - 该日已有 werun 记录且最后一条在 1 小时内 → **合并更新该条**（steps = 微信累计 − 该条之前的累计）
 * - 超过 1 小时（或当日还没有记录）→ **新建一条**，steps = 微信累计 − 该日已记录总量（增量）
 * - 没有增量时不建空记录
 * 因此「该日总量 = 各条 werun 记录 steps 之和」，与 beidou / gps 记录一起聚合即当日总计。
 */
async function syncWerunDay(user, dateKey, cumulativeSteps, { checkJump = true } = {}) {
  const blocked = teacherBlock(user);
  if (blocked) return blocked;

  const existing = await RunRecord.find({ openid: user.openid, date: dateKey, source: 'werun' }).sort({ createdAt: 1 });
  const recordedTotal = existing.reduce((sum, r) => sum + (r.steps || 0), 0);
  const last = existing.length ? existing[existing.length - 1] : null;

  if (checkJump) {
    // 反作弊按「当日累计」比对本次同步带来的新增量
    const result = await anticheat.checkStepJump(user, dateKey, recordedTotal, cumulativeSteps || 0);
    if (result.violation) return { banned: true, reason: result.message };
  }

  const now = Date.now();
  const lastAt = last && last.createdAt ? new Date(last.createdAt).getTime() : 0;
  const merge = !!last && now - lastAt < SYNC_WINDOW_MS;

  // 本条记录应承载的步数（合并时不算该条自身已记的部分，避免重复累加）
  const base = merge ? recordedTotal - (last.steps || 0) : recordedTotal;
  const steps = Math.max(0, (cumulativeSteps || 0) - base);

  if (!merge && steps <= 0) return { record: null, skipped: true };

  const est = wechat.estimateFromSteps(steps);
  const payload = {
    steps,
    distance: est.distance,
    calories: est.calories,
    durationSeconds: est.durationSeconds,
    goalAchieved: false,
  };
  const doc = merge
    ? await RunRecord.findByIdAndUpdate(last._id, { $set: payload }, { new: true })
    : await RunRecord.create({ openid: user.openid, date: dateKey, source: 'werun', ...payload });
  return { record: withPace(doc), merged: merge };
}

// 记录一次 GPS 实跑
async function saveGpsRun(user, { date, distance, durationSeconds, calories, startTime, endTime, routePoints, location }) {
  const blocked = teacherBlock(user);
  if (blocked) return blocked;

  const result = await anticheat.checkPace(user, distance, durationSeconds);
  if (result.violation) return { banned: true, reason: result.message };

  const doc = await RunRecord.create({
    openid: user.openid,
    source: 'gps',
    date: date || todayKey(),
    steps: 0,
    distance: Math.round(distance || 0),
    calories: Math.round(calories || 0),
    durationSeconds: Math.round(durationSeconds || 0),
    startTime,
    endTime,
    routePoints: Array.isArray(routePoints) ? routePoints.slice(0, 5000) : [],
    location: location || '',
  });
  return { record: withPace(doc) };
}

// 激励视频上报：校验每日上限 → 发步数 → 记录
async function reportRewardVideo(user) {
  if (isTeacher(user)) return { error: TEACHER_BLOCK_MESSAGE };

  const config = await GoalConfig.getSingleton();
  if (!config.rewardVideo.enabled) {
    return { error: '激励视频活动未开启' };
  }
  const date = todayKey();
  const limit = config.rewardVideo.dailyLimit;
  let rec = await RewardVideoRecord.findOne({ openid: user.openid, date });
  if (!rec) {
    rec = await RewardVideoRecord.create({ openid: user.openid, date, watchCount: 0, stepsEarned: 0 });
  }
  if (rec.watchCount >= limit) {
    return { error: `今日观看已达上限（${limit} 次）`, limit, watchCount: rec.watchCount, stepsEarned: rec.stepsEarned };
  }
  rec.watchCount += 1;
  rec.stepsEarned += config.rewardVideo.stepsPerWatch;
  await rec.save();

  // 北斗记录：激励视频奖励的步数单列一种记录类型（source='beidou'），不混进微信运动记录，
  // 这样下一次微信同步不会把奖励步数覆盖掉
  const per = config.rewardVideo.stepsPerWatch;
  const estPer = wechat.estimateFromSteps(per);
  await RunRecord.findOneAndUpdate(
    { openid: user.openid, date, source: 'beidou' },
    {
      $inc: {
        steps: per,
        distance: estPer.distance,
        calories: estPer.calories,
        durationSeconds: estPer.durationSeconds,
      },
      $setOnInsert: { openid: user.openid, date, source: 'beidou' },
    },
    { upsert: true }
  );
  return {
    watchCount: rec.watchCount,
    stepsEarned: rec.stepsEarned,
    stepsAwarded: config.rewardVideo.stepsPerWatch,
    remaining: Math.max(0, limit - rec.watchCount),
    limit,
  };
}

// 同步后统一刷新：目标达成标记 + 用户汇总 + 徽章
// 目标达成按「当日总量」判定（同步可能被拆成多条记录，不能再按单条记录比）
async function postSyncRefresh(user, dateKeys = []) {
  const goalsSvc = require('./goals');
  const goal = await goalsSvc.getEffectiveGoal(user.openid);
  for (const date of dateKeys) {
    const agg = await RunRecord.aggregate([
      { $match: { openid: user.openid, date } },
      { $group: { _id: null, steps: { $sum: '$steps' } } },
    ]);
    const total = agg.length ? agg[0].steps || 0 : 0;
    const achieved = total >= (goal.daily.steps || Infinity);
    if (achieved) {
      // 达标：该日微信运动记录统一标记（未达标时不改，保留既有的历史达标状态）
      await RunRecord.updateMany(
        { openid: user.openid, date, source: 'werun' },
        { $set: { goalAchieved: true } }
      );
    }
  }
  await badgesSvc.refreshUserStats(user);
  const newBadges = await badgesSvc.evaluateBadges(user.openid);
  return { newBadges };
}

// 某日总量（步数/距离/卡路里/时长）—— 聚合当日所有来源的记录
async function dayTotals(openid, date) {
  const agg = await RunRecord.aggregate([
    { $match: { openid, date } },
    {
      $group: {
        _id: null,
        steps: { $sum: '$steps' },
        distance: { $sum: '$distance' },
        calories: { $sum: '$calories' },
        durationSeconds: { $sum: '$durationSeconds' },
        recordCount: { $sum: 1 },
      },
    },
  ]);
  const t = agg[0] || { steps: 0, distance: 0, calories: 0, durationSeconds: 0, recordCount: 0 };
  return {
    steps: t.steps || 0,
    distance: t.distance || 0,
    calories: t.calories || 0,
    durationSeconds: t.durationSeconds || 0,
    recordCount: t.recordCount || 0,
  };
}

module.exports = {
  syncWerunDay,
  saveGpsRun,
  reportRewardVideo,
  postSyncRefresh,
  dayTotals,
  withPace,
  isTeacher,
  TEACHER_BLOCK_MESSAGE,
  SYNC_WINDOW_MS,
};
