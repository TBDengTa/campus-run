const GoalConfig = require('../models/goal-config');
const GoalPlan = require('../models/goal-plan');
const BodyData = require('../models/body-data');
const UserGoal = require('../models/user-goal');

// 计算并返回 BMI
function calcBmi(heightCm, weightKg) {
  if (!heightCm || !weightKg) return null;
  const h = heightCm / 100;
  return Math.round((weightKg / (h * h)) * 10) / 10;
}

function bmiLevel(bmi) {
  if (bmi == null) return '';
  if (bmi < 18.5) return 'underweight';
  if (bmi < 24) return 'normal';
  if (bmi < 28) return 'overweight';
  return 'obese';
}

// 按 BMI 区间 + 偏好强度匹配预设计划
async function matchPlan({ bmi, gender, preferenceLevel }) {
  const plans = await GoalPlan.find({ enabled: true }).lean();
  if (!plans.length) return null;
  let candidates = plans.filter(
    (p) =>
      (p.preferenceLevel === preferenceLevel || preferenceLevel == null) &&
      (p.gender === 'all' || p.gender === (gender === 1 ? 'male' : gender === 2 ? 'female' : 'all')) &&
      (bmi == null || (bmi >= p.bmiMin && bmi < p.bmiMax))
  );
  if (!candidates.length) {
    candidates = plans.filter((p) => p.isDefault);
  }
  if (!candidates.length) return null;
  // BMI 命中范围更小者更精准
  candidates.sort((a, b) => a.bmiMax - a.bmiMin - (b.bmiMax - b.bmiMin));
  return candidates[0];
}

// 保存身体数据并自动匹配目标
async function saveBodyData(openid, { height, weight, preferenceLevel, gender }) {
  const bmi = calcBmi(height, weight);
  const doc = await BodyData.findOneAndUpdate(
    { openid },
    {
      $set: {
        height,
        weight,
        bmi,
        bmiLevel: bmiLevel(bmi),
        ...(preferenceLevel ? { preferenceLevel } : {}),
      },
    },
    { new: true, upsert: true }
  );
  if (gender != null) {
    const User = require('../models/user');
    await User.updateOne({ openid }, { $set: { gender } });
  }
  const plan = await matchPlan({ bmi, gender, preferenceLevel: doc.preferenceLevel });
  if (plan) {
    await UserGoal.findOneAndUpdate(
      { openid },
      {
        $set: {
          planId: plan._id,
          planName: plan.name,
          autoMatched: true,
          daily: {
            steps: plan.daily.steps,
            distance: plan.daily.distance,
            calories: plan.daily.calories,
          },
          weekly: { steps: plan.weekly.steps, distance: plan.weekly.distance },
        },
      },
      { upsert: true }
    );
  }
  return { bodyData: doc, plan };
}

// 用户当前生效目标：个人计划 > 全局默认
async function getEffectiveGoal(openid) {
  const [userGoal, globalConfig] = await Promise.all([
    UserGoal.findOne({ openid }).lean(),
    GoalConfig.getSingleton(),
  ]);
  if (userGoal) {
    // 兼容历史数据：迁移来的 user_goals 可能缺 daily/weekly，缺啥用全局默认补
    const daily = userGoal.daily && userGoal.daily.steps ? userGoal.daily : globalConfig.daily;
    const weekly = userGoal.weekly && userGoal.weekly.steps ? userGoal.weekly : globalConfig.weekly;
    return {
      source: 'plan',
      planName: userGoal.planName,
      autoMatched: userGoal.autoMatched,
      daily,
      weekly,
    };
  }
  return {
    source: 'default',
    planName: '',
    autoMatched: false,
    daily: globalConfig.daily,
    weekly: globalConfig.weekly,
  };
}

module.exports = { calcBmi, bmiLevel, matchPlan, saveBodyData, getEffectiveGoal };
