const mongoose = require('mongoose');

/**
 * 北斗运动 3.0 分享点击流水（每次好友点开卡片一条）。
 *
 * 唯一键 `(ownerOpenid, visitorOpenid, date)`：同一个好友每天只能给同一个人助力一次。
 * 这是「分享后必须有其他用户点击才算」的核心幂等闸门 ——
 * 没有它，一个好友连点就能把分享者的每日上限刷满。
 *
 * rewarded=false 的点击也要落库（例如分享者当日奖励已达上限）：
 * 先占住这对关系，避免同一好友反复触发检查；次日可重新助力。
 */
const beidouShareClickSchema = new mongoose.Schema(
  {
    token: { type: String, required: true },
    ownerOpenid: { type: String, required: true },
    visitorOpenid: { type: String, required: true },
    date: { type: String, required: true },
    rewarded: { type: Boolean, default: false },
    coin: { type: Number, default: 0 },
  },
  { timestamps: true }
);

beidouShareClickSchema.index(
  { ownerOpenid: 1, visitorOpenid: 1, date: 1 },
  { unique: true }
);
beidouShareClickSchema.index({ token: 1 });

module.exports = mongoose.model('BeidouShareClick', beidouShareClickSchema, 'beidou_share_clicks');
