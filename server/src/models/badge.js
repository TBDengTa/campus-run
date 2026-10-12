const mongoose = require('mongoose');

// 徽章定义
const badgeSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    icon: { type: String, default: '' },
    type: {
      type: String,
      enum: ['total_steps', 'total_distance', 'total_days', 'goal_days', 'single_steps', 'single_distance', 'streak_days'],
      required: true,
    },
    target: { type: Number, required: true }, // 阈值（步/米/天）
    tierGroup: { type: String, default: '' }, // 阶梯组（如 达标里程/登录达人）
    tierLevel: { type: Number, default: 0 },
    tierColor: { type: String, default: '' },
    sort: { type: Number, default: 0 },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Badge', badgeSchema, 'badges');
