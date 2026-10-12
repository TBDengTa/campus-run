const mongoose = require('mongoose');

// 用户身体数据（用于 BMI 计算与计划匹配）
const bodyDataSchema = new mongoose.Schema(
  {
    openid: { type: String, required: true, unique: true },
    height: { type: Number }, // cm
    weight: { type: Number }, // kg
    bmi: { type: Number },
    bmiLevel: { type: String, default: '' }, // underweight/normal/overweight/obese 等
    preferenceLevel: { type: String, enum: ['relaxed', 'moderate', 'intense'], default: 'moderate' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BodyData', bodyDataSchema, 'body_data');
