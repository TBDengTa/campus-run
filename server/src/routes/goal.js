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

// 我的身体数据
router.get(
  '/body-data',
  wrap(async (req, res) => {
    const doc = await BodyData.findOne({ openid: req.user.openid }).lean();
    ok(res, doc);
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

module.exports = router;
