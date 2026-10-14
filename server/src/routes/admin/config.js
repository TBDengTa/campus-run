const express = require('express');
const { wrap, ok } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const GoalConfig = require('../../models/goal-config');

const router = express.Router();

router.get(
  '/',
  wrap(async (req, res) => {
    ok(res, await GoalConfig.getSingleton());
  })
);

router.put(
  '/',
  requirePermission('config.manage'),
  wrap(async (req, res) => {
    const doc = await GoalConfig.getSingleton();
    // 默认目标（daily/weekly）已移交 /api/admin/assessment/defaults
    const { anticheat, rewardVideo } = req.body || {};
    if (anticheat) {
      doc.anticheat.enabled = anticheat.enabled !== false;
      if (anticheat.maxStepJumpPerSync != null) doc.anticheat.maxStepJumpPerSync = Number(anticheat.maxStepJumpPerSync);
      if (anticheat.minPaceSecondsPerKm != null) doc.anticheat.minPaceSecondsPerKm = Number(anticheat.minPaceSecondsPerKm);
      if (anticheat.banDays != null) doc.anticheat.banDays = Number(anticheat.banDays);
    }
    if (rewardVideo) {
      doc.rewardVideo.enabled = rewardVideo.enabled !== false;
      if (rewardVideo.dailyLimit != null) doc.rewardVideo.dailyLimit = Number(rewardVideo.dailyLimit);
      if (rewardVideo.stepsPerWatch != null) doc.rewardVideo.stepsPerWatch = Number(rewardVideo.stepsPerWatch);
    }
    await doc.save();
    ok(res, doc);
  })
);

module.exports = router;
