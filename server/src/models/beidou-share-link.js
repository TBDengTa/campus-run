const mongoose = require('mongoose');

/**
 * 北斗运动 3.0 分享令牌（每个分享者每天一份）。
 *
 * 用户 2026-11-22：「分享后必须有其他用户点击才算」——
 * 分享按钮只能生成一个**随机令牌**放进卡片路径（/pages/splash/splash?bdshare=xxx），
 * 真正发铜版发生在「另一个已登录用户点开并上报」时（见 beidou-share-clicks）。
 *
 * 为什么令牌按人按天唯一：同一天多次分享复用同一令牌，避免一次分享建一堆记录；
 * 令牌是随机 32 位 hex，不携带 openid，不泄露分享者身份。
 */
const beidouShareLinkSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true },
    ownerOpenid: { type: String, required: true },
    date: { type: String, required: true }, // 令牌创建日（YYYY-MM-DD）
    expiresAt: { type: Date, required: true },
    // 累计被点开次数 / 已发放奖励次数（仅统计成功入账的）
    clicks: { type: Number, default: 0 },
    rewarded: { type: Number, default: 0 },
  },
  { timestamps: true }
);

beidouShareLinkSchema.index({ ownerOpenid: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('BeidouShareLink', beidouShareLinkSchema, 'beidou_share_links');
