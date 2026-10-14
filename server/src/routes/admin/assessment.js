const express = require('express');
const { wrap, ok, ApiError } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const GoalConfig = require('../../models/goal-config');
const GoalPlan = require('../../models/goal-plan');
const UserGoal = require('../../models/user-goal');

const router = express.Router();

// ===== 默认目标（全局单例，仅 daily/weekly）=====
router.get(
  '/defaults',
  wrap(async (req, res) => {
    const doc = await GoalConfig.getSingleton();
    ok(res, { daily: doc.daily, weekly: doc.weekly });
  })
);

router.put(
  '/defaults',
  requirePermission('assessment.manage'),
  wrap(async (req, res) => {
    const doc = await GoalConfig.getSingleton();
    const { daily, weekly } = req.body || {};
    if (daily) Object.assign(doc.daily, pickNums(daily));
    if (weekly) Object.assign(doc.weekly, pickNums(weekly));
    await doc.save();
    ok(res, { daily: doc.daily, weekly: doc.weekly });
  })
);

// ===== 计划目标（goal_plans）=====
// 列表（含停用），附每个计划被 user_goals 快照引用的数量
router.get(
  '/plans',
  wrap(async (req, res) => {
    const [plans, refs] = await Promise.all([
      GoalPlan.find().sort({ isDefault: -1, bmiMin: 1, createdAt: 1 }).lean(),
      UserGoal.aggregate([{ $group: { _id: '$planId', count: { $sum: 1 } } }]),
    ]);
    const refMap = new Map(refs.map((r) => [String(r._id), r.count]));
    ok(res, plans.map((p) => ({ ...p, refCount: refMap.get(String(p._id)) || 0 })));
  })
);

router.post(
  '/plans',
  requirePermission('assessment.manage'),
  wrap(async (req, res) => {
    const fields = pickPlanFields(req.body || {});
    if (!fields.name) throw new ApiError(400, 400, '计划名称必填');
    validateBmi(fields.bmiMin, fields.bmiMax);
    if (fields.isDefault) await GoalPlan.updateMany({ isDefault: true }, { $set: { isDefault: false } });
    const plan = await GoalPlan.create(fields);
    ok(res, plan);
  })
);

router.put(
  '/plans/:id',
  requirePermission('assessment.manage'),
  wrap(async (req, res) => {
    const plan = await GoalPlan.findById(req.params.id);
    if (!plan) throw new ApiError(404, 404, '计划不存在');
    const fields = pickPlanFields(req.body || {});
    validateBmi(fields.bmiMin ?? plan.bmiMin, fields.bmiMax ?? plan.bmiMax);
    Object.assign(plan, fields);
    await plan.save();
    // 「默认计划」全局唯一：matchPlan 无候选时回退到它
    if (plan.isDefault) {
      await GoalPlan.updateMany({ _id: { $ne: plan._id }, isDefault: true }, { $set: { isDefault: false } });
    }
    ok(res, plan);
  })
);

router.delete(
  '/plans/:id',
  requirePermission('assessment.manage'),
  wrap(async (req, res) => {
    const plan = await GoalPlan.findById(req.params.id);
    if (!plan) throw new ApiError(404, 404, '计划不存在');
    const refCount = await UserGoal.countDocuments({ planId: plan._id });
    if (refCount > 0) {
      throw new ApiError(409, 409, `已有 ${refCount} 名用户应用该计划，请改为停用（不影响这些用户当前目标）`);
    }
    await plan.deleteOne();
    ok(res, { deleted: true });
  })
);

function pickNums(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number' && v >= 0) out[k] = v;
  }
  return out;
}

// 计划字段白名单：type/enum 字段非法值直接忽略，交给 schema 默认值
function pickPlanFields(body) {
  const out = {};
  if (typeof body.name === 'string' && body.name.trim()) out.name = body.name.trim();
  if (['male', 'female', 'all'].includes(body.gender)) out.gender = body.gender;
  if (['relaxed', 'moderate', 'intense'].includes(body.preferenceLevel)) out.preferenceLevel = body.preferenceLevel;
  for (const k of ['bmiMin', 'bmiMax']) {
    if (body[k] != null && Number.isFinite(Number(body[k]))) out[k] = Number(body[k]);
  }
  for (const group of ['daily', 'weekly']) {
    if (body[group] && typeof body[group] === 'object') {
      const picked = pickNums(body[group]);
      if (Object.keys(picked).length) out[group] = picked;
    }
  }
  if (typeof body.enabled === 'boolean') out.enabled = body.enabled;
  if (typeof body.isDefault === 'boolean') out.isDefault = body.isDefault;
  return out;
}

function validateBmi(min, max) {
  if (min != null && max != null && min >= max) throw new ApiError(400, 400, 'BMI 下限必须小于上限');
}

module.exports = router;
