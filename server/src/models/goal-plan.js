const mongoose = require('mongoose');

// BMI 预设计划（旧库 goal_plans）
const goalPlanSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    gender: { type: String, enum: ['male', 'female', 'all'], default: 'all' },
    preferenceLevel: { type: String, enum: ['relaxed', 'moderate', 'intense'], default: 'moderate' },
    bmiMin: { type: Number, default: 0 },
    bmiMax: { type: Number, default: 100 },
    daily: {
      steps: { type: Number, default: 5000 },
      distance: { type: Number, default: 3000 },
      calories: { type: Number, default: 250 },
      durationMinutes: { type: Number, default: 45 },
    },
    weekly: {
      steps: { type: Number, default: 35000 },
      distance: { type: Number, default: 21000 },
    },
    enabled: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('GoalPlan', goalPlanSchema, 'goal_plans');
