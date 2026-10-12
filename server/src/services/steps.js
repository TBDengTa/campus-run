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

// 同步微信运动某日步数（ werun 数据 30 天内逐日同步）
async function syncWerunDay(user, dateKey, steps, { checkJump = true } = {}) {
  const blocked = teacherBlock(user);
  if (blocked) return blocked;

  const prev = await RunRecord.findOne({ openid: user.openid, date: dateKey, source: 'werun' }).lean();
  const prevSteps = prev?.steps || 0;

  if (checkJump) {
    const result = await anticheat.checkStepJump(user, dateKey, prevSteps, steps);
    if (result.violation) return { banned: true, reason: result.message };
  }

  const est = wechat.estimateFromSteps(steps);
  const doc = await RunRecord.findOneAndUpdate(
    { openid: user.openid, date: dateKey, source: 'werun' },
    {
      $set: {
        steps,
        distance: est.distance,
        calories: est.calories,
        durationSeconds: est.durationSeconds,
        goalAchieved: false,
      },
      $setOnInsert: { openid: user.openid, date: dateKey, source: 'werun' },
    },
    { new: true, upsert: true }
  );
  return { record: withPace(doc) };
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

  // 步数计入当日 werun 记录
  await RunRecord.findOneAndUpdate(
    { openid: user.openid, date, source: 'werun' },
    {
      $inc: { steps: config.rewardVideo.stepsPerWatch, distance: Math.round(config.rewardVideo.stepsPerWatch * 0.7) },
      $setOnInsert: { openid: user.openid, date, source: 'werun' },
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
async function postSyncRefresh(user, dateKeys = []) {
  const goalsSvc = require('./goals');
  const goal = await goalsSvc.getEffectiveGoal(user.openid);
  for (const date of dateKeys) {
    const rec = await RunRecord.findOne({ openid: user.openid, date, source: 'werun' });
    if (rec) {
      rec.goalAchieved = rec.steps >= goal.daily.steps;
      await rec.save();
    }
  }
  await badgesSvc.refreshUserStats(user);
  const newBadges = await badgesSvc.evaluateBadges(user.openid);
  return { newBadges };
}

module.exports = {
  syncWerunDay,
  saveGpsRun,
  reportRewardVideo,
  postSyncRefresh,
  withPace,
  isTeacher,
  TEACHER_BLOCK_MESSAGE,
};
