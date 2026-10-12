const mongoose = require('mongoose');

// 用户已获得的徽章
const userBadgeSchema = new mongoose.Schema(
  {
    openid: { type: String, required: true },
    badgeKey: { type: String, required: true },
  },
  { timestamps: true }
);

userBadgeSchema.index({ openid: 1, badgeKey: 1 }, { unique: true });

module.exports = mongoose.model('UserBadge', userBadgeSchema, 'user_badges');
