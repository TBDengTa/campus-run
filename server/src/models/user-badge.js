const mongoose = require('mongoose');

// 用户已获得的徽章
// 唯一索引 {openid, badgeKey} 保持不变：等级徽章之间仍是不同的 badgeKey，一个用户在一个 key 上只有一行。
const userBadgeSchema = new mongoose.Schema(
  {
    openid: { type: String, required: true },
    badgeKey: { type: String, required: true },
    // 获得该行时所处的等级：等级徽章 = 定义的 tierLevel；独立徽章 = 0
    level: { type: Number, default: 0 },
  },
  { timestamps: true }
);

userBadgeSchema.index({ openid: 1, badgeKey: 1 }, { unique: true });
// 管理端「按徽章统计获得人数」会用 badgeKey 过滤，缺这个索引会全表扫（905 行 → 后续会更大）
userBadgeSchema.index({ badgeKey: 1 });

module.exports = mongoose.model('UserBadge', userBadgeSchema, 'user_badges');
