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
    const { daily, weekly, graded, anticheat, rewardVideo } = req.body || {};
    if (daily) Object.assign(doc.daily, pickNums(daily));
    if (weekly) Object.assign(doc.weekly, pickNums(weekly));
    if (Array.isArray(graded)) {
      doc.graded = graded
        .filter((g) => g && /^\d{2}:\d{2}$/.test(g.time || ''))
        .map((g) => ({ time: g.time, percent: Number(g.percent) || 0 }));
    }
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

function pickNums(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number' && v >= 0) out[k] = v;
  }
  return out;
}

module.exports = router;
