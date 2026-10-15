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
    // 跑分：老配置文档缺少 extraPercent（日）/ weeklyExtraPercent（周）时，这里显式告诉管理端
    // 「旧口径等价于多少百分比」，避免档位从固定步数改成百分比后出现静默变更
    // （读取即派生，不写库；管理员在「跑分设置」保存时才落库，幂等）
    // perStep 现已**完全弃用**（日、周公式都不再读取），提示里给出日/周两个等价百分比仅供参考
    const raw = await GoalConfig.collection.findOne(
      { key: 'default' },
      {
        projection: {
          'points.perStep': 1,
          'points.extraPercent': 1,
          'points.weeklyExtraPercent': 1,
          'daily.steps': 1,
          'weekly.steps': 1,
        },
      }
    );
    const rawPoints = (raw && raw.points) || {};
    const globalDailySteps = Number(raw && raw.daily && raw.daily.steps) || 0;
    const globalWeeklySteps = Number(raw && raw.weekly && raw.weekly.steps) || 0;
    const extraPercentMissing = rawPoints.extraPercent == null;
    const weeklyExtraPercentMissing = rawPoints.weeklyExtraPercent == null;
    out.pointsLegacy =
      extraPercentMissing || weeklyExtraPercentMissing
        ? {
            extraPercentMissing,
            weeklyExtraPercentMissing,
            perStep: rawPoints.perStep != null ? rawPoints.perStep : null,
            globalDailySteps: globalDailySteps || null,
            globalWeeklySteps: globalWeeklySteps || null,
            // 与旧口径等价的百分比：日 = perStep ÷ 全局日目标，周 = perStep ÷ 全局周目标
            legacyPercent: pointsSvc.equivalentPercent(rawPoints.perStep, globalDailySteps),
            legacyWeeklyPercent: pointsSvc.equivalentPercent(rawPoints.perStep, globalWeeklySteps),
            extraPercent: pointsSvc.normalizeConfig(out.points).extraPercent,
            weeklyExtraPercent: pointsSvc.normalizeConfig(out.points).weeklyExtraPercent,
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
      // 日超出档位：个人日目标的百分比，整数 1~100（越界一律夹紧，不写非法值）
      const extraPercent = points.extraPercent != null ? num(points.extraPercent, pointsSvc.EXTRA_PERCENT_MIN, pointsSvc.EXTRA_PERCENT_MAX) : null;
      // 周超出档位：个人周目标的百分比，整数 1~100（同一套区间常量）
      const weeklyExtraPercent =
        points.weeklyExtraPercent != null
          ? num(points.weeklyExtraPercent, pointsSvc.EXTRA_PERCENT_MIN, pointsSvc.EXTRA_PERCENT_MAX)
          : null;
      // 【已完全弃用】perStep：日、周公式都不再读取；仍接受回传只为兼容老客户端表单（值原样保存，不影响分数）
      const perStep = points.perStep != null ? num(points.perStep, 1, 1000000) : null;
      const perStepScore = points.perStepScore != null ? num(points.perStepScore, 0, 1000) : null;
      const dailyExtraCap = points.dailyExtraCap != null ? num(points.dailyExtraCap, 0, 1000) : null;
      // 单周超出加分上限：0 = 不封顶（与单日上限的 0 = 超出不加分**语义不同**，管理端已标注）
      const weeklyExtraCap = points.weeklyExtraCap != null ? num(points.weeklyExtraCap, 0, 1000) : null;
      if (dailyGoal != null) doc.points.dailyGoal = dailyGoal;
      if (weeklyGoal != null) doc.points.weeklyGoal = weeklyGoal;
      if (extraPercent != null) doc.points.extraPercent = extraPercent;
      if (weeklyExtraPercent != null) doc.points.weeklyExtraPercent = weeklyExtraPercent;
      if (perStep != null) doc.points.perStep = perStep;
      if (perStepScore != null) doc.points.perStepScore = perStepScore;
      if (dailyExtraCap != null) doc.points.dailyExtraCap = dailyExtraCap;
      if (weeklyExtraCap != null) doc.points.weeklyExtraCap = weeklyExtraCap;
    }
    await doc.save();
    const out = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    out.pointsLegacy = null; // 保存即完成迁移：不再提示旧字段换算
    ok(res, out);
  })
);

module.exports = router;
