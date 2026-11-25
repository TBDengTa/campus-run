const mongoose = require('mongoose');

/**
 * 北斗运动 3.0 铜版流水（每次余额变动一条）。
 *
 * 为什么独立成表：
 *   ① 钱包余额必须能被解释（学生申诉 / 客服对账 / 后台经济概览都读它）；
 *   ② 发铜版的路径很多（任务/游戏/分享/新手/返还），只改余额不留流水 = 出事查不出来；
 *   ③ `idemKey` 唯一索引是**幂等闸门**：弱网重试、并发重复点击都只入账一次。
 *
 * 约定：
 *   · delta > 0 = 发放，delta < 0 = 扣款；
 *   · idemKey 在同一 openid 下唯一（例：welcome / video:<watchId> / cost:<playId>）；
 *   · balanceAfter 是写入时的余额快照（异常时可与钱包当前值比对）。
 */
const beidouCoinLogSchema = new mongoose.Schema(
  {
    openid: { type: String, required: true },
    date: { type: String, required: true }, // YYYY-MM-DD（本地日历键）
    delta: { type: Number, required: true }, // 正=发放，负=扣款
    balanceAfter: { type: Number, default: 0 },
    source: {
      type: String,
      enum: ['welcome', 'video', 'checkin', 'share', 'wheel', 'grid', 'refund'],
      required: true,
    },
    game: { type: String, enum: ['', 'wheel', 'grid'], default: '' },
    refId: { type: String, default: '' }, // watchId / drawId / clickId / 日期
    // 幂等键：同一用户下唯一；重复写入直接判重，不再动余额
    idemKey: { type: String, required: true },
    note: { type: String, default: '' },
  },
  { timestamps: true }
);

beidouCoinLogSchema.index({ openid: 1, idemKey: 1 }, { unique: true });
beidouCoinLogSchema.index({ date: 1, source: 1, game: 1 });
beidouCoinLogSchema.index({ openid: 1, date: 1 });

module.exports = mongoose.model('BeidouCoinLog', beidouCoinLogSchema, 'beidou_coin_logs');
