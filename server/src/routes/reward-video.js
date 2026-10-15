const express = require('express');
const { wrap, ok, ApiError } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const GoalConfig = require('../models/goal-config');
const RewardVideoRecord = require('../models/reward-video-record');
const stepsSvc = require('../services/steps');
const rewardVideoSvc = require('../services/reward-video');
const anticheat = require('../services/anticheat');
const { todayKey } = require('../utils/dates');

const router = express.Router();
router.use(auth);

// 今日状态：剩余次数 + 「每次可获得」四项 + 「今日已入账」四项
// 四项配置的唯一真源是 goal_config.rewardVideo，解析走 services/reward-video.js::resolvePerWatch
router.get(
  '/today',
  wrap(async (req, res) => {
    const config = await GoalConfig.getSingleton();
    const date = todayKey();
    const [rec, earned] = await Promise.all([
      RewardVideoRecord.findOne({ openid: req.user.openid, date }).lean(),
      rewardVideoSvc.earnedToday(req.user.openid, date),
    ]);
    const per = rewardVideoSvc.resolvePerWatch(config.rewardVideo);
    const limit = config.rewardVideo.dailyLimit;
    const watchCount = rec?.watchCount || 0;
    ok(res, {
      enabled: config.rewardVideo.enabled,
      limit,
      dailyLimit: limit,
      // 激励视频广告位 ID（客户端公开标识）：留空时用户端用代码里的默认广告位
      adUnitId: config.rewardVideo.adUnitId || '',
      // 每次观看可获得的四项（步数 / 距离米 / 卡路里 / 时长秒）
      perWatch: per,
      stepsPerWatch: per.steps,
      distancePerWatch: per.distance,
      caloriesPerWatch: per.calories,
      durationPerWatch: per.durationSeconds,
      watchCount,
      remaining: Math.max(0, limit - watchCount),
      stepsEarned: rec?.stepsEarned || 0,
      // 今日已入账的四项：真源 = run_records(source='beidou')，与记录页/首页统计同源
      earned,
    });
  })
);

// 观看完成上报：一次性入账四项（步数/距离/卡路里/时长）
router.post(
  '/report',
  wrap(async (req, res) => {
    // 教师账号不参与运动记录（不加步数/距离/卡路里/时长）。
    // 这里刻意返回 200 + success:false，而不是 403003：小程序端把 403003 当成「未登录」会跳登录页。
    if (stepsSvc.isTeacher(req.user)) {
      return ok(res, { success: false, message: stepsSvc.TEACHER_BLOCK_MESSAGE, error: stepsSvc.TEACHER_BLOCK_MESSAGE });
    }
    // 反作弊/人工限制微信同步的账号：激励奖励走同一条步数通道，同样拦截
    // （403004，小程序端已有对应提示与申诉引导）
    const syncRestriction = anticheat.activeRestriction(req.user, 'sync');
    if (syncRestriction) throw restrictedError(syncRestriction);

    const result = await stepsSvc.reportRewardVideo(req.user, { watchId: (req.body || {}).watchId });
    if (result.error) {
      return ok(res, { success: false, message: result.error, ...result });
    }
    const { newBadges } = await stepsSvc.postSyncRefresh(req.user, [todayKey()]);
    // 今日已入账的四项（聚合当日 source='beidou' 记录，与记录页/首页统计同源）
    const earned = await rewardVideoSvc.earnedToday(req.user.openid, todayKey());
    ok(res, { success: true, ...result, earned, newBadges });
  })
);

// 限制类错误统一出口（与 routes/run.js 同一套映射）：
//   login → 403001（整账号限制登录，小程序跳 pages/banned）
//   sync / gps → 403004（单项能力受限，小程序提示并可申诉）
function restrictedError(info) {
  const scope = (info && info.scope) || 'login';
  const reason = (info && info.reason) || (info && info.message) || '数据异常';
  const until = (info && info.until) || null;
  if (scope === 'login') {
    return new ApiError(403, 403001, `检测到数据异常，账号已被限制登录：${reason}`, {
      banned: { reason, until, banType: 'login' },
    });
  }
  const text = scope === 'sync' ? '微信同步' : 'GPS 实跑';
  return new ApiError(403, 403004, `${text}已被限制：${reason}`, {
    restriction: { scope, text, reason, until },
  });
}

module.exports = router;
