const express = require('express');
const { wrap, ok } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const GoalConfig = require('../models/goal-config');
const RewardVideoRecord = require('../models/reward-video-record');
const stepsSvc = require('../services/steps');
const { todayKey } = require('../utils/dates');

const router = express.Router();
router.use(auth);

// 今日状态（用于进入页面前展示剩余次数）
router.get(
  '/today',
  wrap(async (req, res) => {
    const config = await GoalConfig.getSingleton();
    const rec = await RewardVideoRecord.findOne({ openid: req.user.openid, date: todayKey() }).lean();
    ok(res, {
      enabled: config.rewardVideo.enabled,
      limit: config.rewardVideo.dailyLimit,
      stepsPerWatch: config.rewardVideo.stepsPerWatch,
      watchCount: rec?.watchCount || 0,
      stepsEarned: rec?.stepsEarned || 0,
    });
  })
);

// 观看完成上报
router.post(
  '/report',
  wrap(async (req, res) => {
    const result = await stepsSvc.reportRewardVideo(req.user);
    if (result.error) {
      return ok(res, { success: false, message: result.error, ...result });
    }
    const { newBadges } = await stepsSvc.postSyncRefresh(req.user, [todayKey()]);
    ok(res, { success: true, ...result, newBadges });
  })
);

module.exports = router;
