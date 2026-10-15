const RunRecord = require('../models/run-record');
const RewardVideoRecord = require('../models/reward-video-record');
const GoalConfig = require('../models/goal-config');
const wechat = require('./wechat');
const anticheat = require('./anticheat');
const badgesSvc = require('./badges');
const rewardVideoSvc = require('./reward-video');
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
    // 违规时返回限制信息：scope=sync 限制微信同步 / scope=login 升级为限制登录
    if (result.violation) return { restricted: result };
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
  // 违规时返回限制信息：scope=gps 限制 GPS / scope=login 升级为限制登录（见 routes/run.js 的错误码映射）
  if (result.violation) return { restricted: result };

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

// 激励视频上报：校验每日上限 → 按配置一次性入账四项（步数/距离/卡路里/时长）→ 记录
// 幂等：客户端每次观看生成一个 watchId，同一个 watchId 重复提交只入账一次（返回上一次结果）
async function reportRewardVideo(user, { watchId } = {}) {
  if (isTeacher(user)) return { error: TEACHER_BLOCK_MESSAGE };

  const config = await GoalConfig.getSingleton();
  if (!config.rewardVideo.enabled) {
    return { error: '激励视频活动未开启' };
  }
  const date = todayKey();
  const limit = config.rewardVideo.dailyLimit;
  // 每次入账的四项：以 goal_config.rewardVideo 为唯一真源；距离/卡路里/时长未单独配置时
  // 按既有的步数换算（wechat.estimateFromSteps）派生（见 services/reward-video.js）
  const per = rewardVideoSvc.resolvePerWatch(config.rewardVideo);
  const nonce = String(watchId || '').trim().slice(0, 64);

  let rec = await RewardVideoRecord.findOne({ openid: user.openid, date });
  if (!rec) {
    rec = await RewardVideoRecord.create({ openid: user.openid, date, watchCount: 0, stepsEarned: 0, watchIds: [] });
  }
  // 同一次观看重复上报（网络重试/重复点击）：不再入账、不再消耗次数，原样返回上一次结果
  if (nonce && (rec.watchIds || []).includes(nonce)) {
    return {
      watchCount: rec.watchCount,
      stepsEarned: rec.stepsEarned,
      awarded: per,
      remaining: Math.max(0, limit - rec.watchCount),
      limit,
      duplicated: true,
    };
  }
  if (rec.watchCount >= limit) {
    return { error: `今日观看已达上限（${limit} 次）`, limit, watchCount: rec.watchCount, stepsEarned: rec.stepsEarned };
  }

  // 原子领取：以 watchCount 作版本号做一次 CAS，并发/重放都不会重复计数或重复入账
  const claimed = await RewardVideoRecord.findOneAndUpdate(
    {
      _id: rec._id,
      watchCount: rec.watchCount,
      ...(nonce ? { watchIds: { $ne: nonce } } : {}),
    },
    {
      $inc: { watchCount: 1, stepsEarned: per.steps },
      ...(nonce ? { $push: { watchIds: { $each: [nonce], $slice: -50 } } } : {}),
    },
    { new: true }
  );
  if (!claimed) {
    const latest = await RewardVideoRecord.findOne({ openid: user.openid, date });
    if (nonce && latest && (latest.watchIds || []).includes(nonce)) {
      return {
        watchCount: latest.watchCount,
        stepsEarned: latest.stepsEarned,
        awarded: per,
        remaining: Math.max(0, limit - latest.watchCount),
        limit,
        duplicated: true,
      };
    }
    return { error: '上报过于频繁，请稍后重试' };
  }

  // 北斗记录：一次观看的四项奖励合并进当日同一条 source='beidou' 记录
  // （单列一种来源，不混进微信运动记录，这样下一次微信同步不会把奖励数据覆盖掉）。
  // 记录页 / 排行榜 / 跑分 / 徽章 / 首页统计都是聚合 run_records，
  // 因此四项与既有统计口径完全一致，不存在「页面看得见、统计看不见」。
  await RunRecord.findOneAndUpdate(
    { openid: user.openid, date, source: 'beidou' },
    {
      $inc: {
        steps: per.steps,
        distance: per.distance,
        calories: per.calories,
        durationSeconds: per.durationSeconds,
      },
      $setOnInsert: { openid: user.openid, date, source: 'beidou' },
    },
    { upsert: true }
  );
  return {
    watchCount: claimed.watchCount,
    stepsEarned: claimed.stepsEarned,
    awarded: per,
    stepsAwarded: per.steps, // 兼容老客户端字段
    remaining: Math.max(0, limit - claimed.watchCount),
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
