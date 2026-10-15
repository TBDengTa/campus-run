const express = require('express');
const { wrap, ok } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const GoalConfig = require('../../models/goal-config');
const pointsSvc = require('../../services/points');

const router = express.Router();

router.get(
  '/',
  wrap(async (req, res) => {
    const doc = await GoalConfig.getSingleton();
    const out = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    // 跑分：老配置文档只有已弃用的 perStep、没有 extraPercent 时，这里显式告诉管理端
    // 「旧口径等价于多少百分比」，避免日跑分档位从固定步数改成百分比后出现静默变更
    // （读取即派生，不写库；管理员在「跑分设置」保存时才落库，幂等）
    const raw = await GoalConfig.collection.findOne(
      { key: 'default' },
      { projection: { 'points.perStep': 1, 'points.extraPercent': 1, 'daily.steps': 1 } }
    );
    const rawPoints = (raw && raw.points) || {};
    const globalDailySteps = Number(raw && raw.daily && raw.daily.steps) || 0;
    out.pointsLegacy =
      rawPoints.extraPercent == null
        ? {
            extraPercentMissing: true,
            perStep: rawPoints.perStep != null ? rawPoints.perStep : null,
            globalDailySteps: globalDailySteps || null,
            legacyPercent: pointsSvc.legacyExtraPercent(rawPoints.perStep, globalDailySteps),
            extraPercent: pointsSvc.normalizeConfig(out.points).extraPercent,
          }
        : null;
    ok(res, out);
  })
);

router.put(
  '/',
  requirePermission('config.manage'),
  wrap(async (req, res) => {
    const doc = await GoalConfig.getSingleton();
    // 默认目标（daily/weekly）已移交 /api/admin/assessment/defaults
    const { anticheat, rewardVideo, points } = req.body || {};
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
    // 跑分设置（config/points 子页只回传本组，未提供的键不动）
    if (points) {
      doc.points.enabled = points.enabled !== false;
      const num = (v, min, max) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        return Math.min(max, Math.max(min, Math.round(n)));
      };
      const dailyGoal = points.dailyGoal != null ? num(points.dailyGoal, 0, 1000) : null;
      const weeklyGoal = points.weeklyGoal != null ? num(points.weeklyGoal, 0, 5000) : null;
      // 日超出档位：个人目标的百分比，整数 1~100（越界一律夹紧，不写非法值）
      const extraPercent = points.extraPercent != null ? num(points.extraPercent, pointsSvc.EXTRA_PERCENT_MIN, pointsSvc.EXTRA_PERCENT_MAX) : null;
      // 【已弃用】perStep 仅周公式仍在使用，保留可配置；日公式不再读取
      const perStep = points.perStep != null ? num(points.perStep, 1, 1000000) : null;
      const perStepScore = points.perStepScore != null ? num(points.perStepScore, 0, 1000) : null;
      const dailyExtraCap = points.dailyExtraCap != null ? num(points.dailyExtraCap, 0, 1000) : null;
      if (dailyGoal != null) doc.points.dailyGoal = dailyGoal;
      if (weeklyGoal != null) doc.points.weeklyGoal = weeklyGoal;
      if (extraPercent != null) doc.points.extraPercent = extraPercent;
      if (perStep != null) doc.points.perStep = perStep;
      if (perStepScore != null) doc.points.perStepScore = perStepScore;
      if (dailyExtraCap != null) doc.points.dailyExtraCap = dailyExtraCap;
    }
    await doc.save();
    const out = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    out.pointsLegacy = null; // 保存即完成迁移：不再提示旧字段换算
    ok(res, out);
  })
);

module.exports = router;
