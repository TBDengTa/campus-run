const mongoose = require('mongoose');

// 徽章定义
//   mode=single：独立徽章（如「魅力新人」），一次达标即获得
//   mode=tier  ：等级徽章（如「达标里程」3 级、「登录达人」6 级），同一 tierGroup 下按 tierLevel 逐级解锁
// 等级判断规则产品仍在确认：这里只落 mode/tierGroup/tierLevel 三个字段与形态校验（不含等级判定逻辑）；
// 刻意不引入 tiers[]（子文档数组），等级徽章之间仍是一行一个定义。
const badgeSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    icon: { type: String, default: '' }, // 图片 URL（如 https://file.tangbo.tech/...）或图标名
    type: {
      type: String,
      enum: ['total_steps', 'total_distance', 'total_days', 'goal_days', 'single_steps', 'single_distance', 'streak_days'],
      required: true,
    },
    target: { type: Number, required: true }, // 阈值（步/米/天）
    mode: { type: String, enum: ['single', 'tier'], default: 'single' }, // 独立徽章 / 等级徽章
    tierGroup: { type: String, default: '' }, // 阶梯组（如 达标里程/登录达人）
    tierLevel: { type: Number, default: 0 },
    tierColor: { type: String, default: '' },
    sort: { type: Number, default: 0 },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// 等级徽章必须成组且有等级：缺一个都会让「下一级」无法计算，属于脏数据，直接拦在写库前
badgeSchema.pre('validate', function validateTierShape(next) {
  if (this.mode === 'tier') {
    if (!String(this.tierGroup || '').trim()) return next(new Error('等级徽章（mode=tier）必须填写 tierGroup'));
    if (!(Number(this.tierLevel) >= 1)) return next(new Error('等级徽章（mode=tier）的 tierLevel 必须 >= 1'));
  }
  next();
});

module.exports = mongoose.model('Badge', badgeSchema, 'badges');
