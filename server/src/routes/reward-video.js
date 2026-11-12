const express = require('express');
const { wrap, ok } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const GoalConfig = require('../models/goal-config');
const RewardVideoRecord = require('../models/reward-video-record');
const rewardVideoSvc = require('../services/reward-video');
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

// 观看完成上报：**已于 2.0 降级为只回提示，不再发步数**
//
// 为什么保留路由而不直接删（D9，用户 2026-11-11 裁决）：老版本小程序（缓存未更新、
// 或用户长期不更新）仍在调这个接口。直接 404/410 会让这些客户端弹错误框；
// 保留并回 success:false，它们只会看到一句「已升级」提示，**不会静默继续刷步**。
// 真正的看视频加次数逻辑在 POST /api/beidou/video/report。
//
// ⚠️ 不要再往这里加回发步数的逻辑：北斗 2.0 的口径是「步数只能从转盘/签到出」
//    （见 docs/beidou-lottery-plan.md §2 R1）。
router.post(
  '/report',
  wrap(async (req, res) => {
    ok(res, {
      success: false,
      deprecated: true,
      message: '北斗运动已升级，请更新小程序后重新进入',
    });
  })
);

module.exports = router;
