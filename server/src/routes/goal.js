const express = require('express');
const { wrap, ok, ApiError } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const GoalPlan = require('../models/goal-plan');
const BodyData = require('../models/body-data');
const UserGoal = require('../models/user-goal');
const goalsSvc = require('../services/goals');

const router = express.Router();
router.use(auth);

// 当前生效目标
router.get(
  '/effective',
  wrap(async (req, res) => {
    ok(res, await goalsSvc.getEffectiveGoal(req.user.openid));
  })
);

// 预设计划列表
router.get(
  '/plans',
  wrap(async (req, res) => {
    const plans = await GoalPlan.find({ enabled: true }).sort({ bmiMin: 1 }).lean();
    ok(res, plans);
  })
);

// 我的身体数据 + 当前匹配计划 + 生效目标（身体数据页一次拉全）
router.get(
  '/body-data',
  wrap(async (req, res) => {
    const openid = req.user.openid;
    const [doc, userGoal, effective] = await Promise.all([
      BodyData.findOne({ openid }).lean(),
      UserGoal.findOne({ openid }).populate('planId').lean(),
      goalsSvc.getEffectiveGoal(openid),
    ]);
    ok(res, {
      bodyData: doc,
      currentPlan: userGoal && userGoal.planId ? userGoal.planId : null,
      planName: userGoal?.planName || '',
      autoMatched: userGoal ? userGoal.autoMatched : false,
      effective,
    });
  })
);

// 保存身体数据（自动计算 BMI 并匹配计划）
router.post(
  '/body-data',
  wrap(async (req, res) => {
    const { height, weight, preferenceLevel, gender } = req.body || {};
    if (!height || !weight) throw new ApiError(400, 400, '请填写身高和体重');
    if (height < 50 || height > 250) throw new ApiError(400, 400, '身高数值不合理');
    if (weight < 20 || weight > 300) throw new ApiError(400, 400, '体重数值不合理');
    const result = await goalsSvc.saveBodyData(req.user.openid, { height, weight, preferenceLevel, gender });
    ok(res, result);
  })
);

// 查看我的计划
router.get(
  '/my-plan',
  wrap(async (req, res) => {
    const doc = await UserGoal.findOne({ openid: req.user.openid }).populate('planId').lean();
    ok(res, doc);
  })
);

// AI 智能匹配：按 BMI + 性别 + 运动偏好推荐计划，并生成推荐理由（不直接应用）
router.post(
  '/ai-match',
  wrap(async (req, res) => {
    const openid = req.user.openid;
    let { height, weight, preferenceLevel, gender } = req.body || {};
    const saved = await BodyData.findOne({ openid }).lean();
    height = Number(height) || saved?.height;
    weight = Number(weight) || saved?.weight;
    preferenceLevel = preferenceLevel || saved?.preferenceLevel || 'moderate';
    if (gender == null) {
      const user = require('../models/user');
      const u = await user.findOne({ openid }, 'gender').lean();
      gender = u?.gender ?? 0;
    }

    const bmi = goalsSvc.calcBmi(height, weight);
    if (bmi == null) throw new ApiError(400, 400, '请先填写身高和体重');
    const level = goalsSvc.bmiLevel(bmi);
    const plan = await goalsSvc.matchPlan({ bmi, gender, preferenceLevel });
    if (!plan) throw new ApiError(404, 404, '暂无可用计划，请联系管理员配置');

    const levelText = { underweight: '偏轻', normal: '正常', overweight: '超重', obese: '偏胖' }[level] || level;
    const prefText = { relaxed: '轻松', moderate: '适中', intense: '进阶' }[preferenceLevel] || preferenceLevel;
    const reasons = [
      `您的 BMI 为 ${bmi}（${levelText}），适合${level === 'underweight' ? '循序渐进增加运动量' : level === 'normal' ? '保持规律运动维持状态' : '加强有氧运动改善体质'}`,
      `结合您「${prefText}」的运动偏好，匹配「${plan.name}」`,
      `建议每日 ${plan.daily.steps.toLocaleString()} 步 / ${(plan.daily.distance / 1000).toFixed(1)} 公里，每周 ${plan.weekly.steps.toLocaleString()} 步`,
    ];

    ok(res, {
      bmi,
      bmiLevel: level,
      bmiLevelText: levelText,
      preferenceLevel,
      plan,
      reasons,
    });
  })
);

// 应用计划（手动）：{planId}
router.post(
  '/apply',
  wrap(async (req, res) => {
    const { planId } = req.body || {};
    if (!planId) throw new ApiError(400, 400, '缺少 planId');
    const plan = await GoalPlan.findById(planId);
    if (!plan || !plan.enabled) throw new ApiError(404, 404, '计划不存在或未启用');
    const userGoal = await UserGoal.findOneAndUpdate(
      { openid: req.user.openid },
      {
        $set: {
          planId: plan._id,
          planName: plan.name,
          autoMatched: false,
          daily: { steps: plan.daily.steps, distance: plan.daily.distance, calories: plan.daily.calories },
          weekly: { steps: plan.weekly.steps, distance: plan.weekly.distance },
        },
      },
      { new: true, upsert: true }
    );
    ok(res, userGoal);
  })
);

module.exports = router;
