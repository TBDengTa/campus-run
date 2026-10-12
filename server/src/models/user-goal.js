const mongoose = require('mongoose');

// 用户当前生效的目标计划
const userGoalSchema = new mongoose.Schema(
  {
    openid: { type: String, required: true, unique: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'GoalPlan' },
    planName: { type: String, default: '' },
    autoMatched: { type: Boolean, default: true },
    daily: {
      steps: { type: Number, default: 5000 },
      distance: { type: Number, default: 3000 },
      calories: { type: Number, default: 250 },
    },
    weekly: {
      steps: { type: Number, default: 35000 },
      distance: { type: Number, default: 21000 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('UserGoal', userGoalSchema, 'user_goals');
