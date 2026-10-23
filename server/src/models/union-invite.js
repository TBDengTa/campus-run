const mongoose = require('mongoose');

/**
 * 学生会「扫码加人」凭证（用户 2026-10-22）。
 *
 * 场景：学生在自己主页调出二维码，学生会干部（主席团/部长/副部长）用微信扫一扫，
 * 打开小程序里的「加入确认页」，确认后把该学生加进干部所在部门（可批量）。
 *
 * 为什么用一次性凭证而不是把学号直接写进二维码：
 *   · 学号是**可枚举**的（连号），任何人扫到别人的学号都能伪造入会请求；
 *   · 凭证绑定「学生 + 过期时间 + 一次性」，扫到旧截图也用不了，且能被服务端追溯是谁的码。
 *
 * 为什么不用真小程序码（getwxacodeunlimit）：
 *   那需要有效的 WX_APPSECRET + 外网访问微信接口。本版先用「凭证串二维码」跑通完整链路，
 *   后续要换成真小程序码时，只需把「码内容」从凭证串换成小程序码，
 *   校验逻辑（本集合）完全不变。
 */
const unionInviteSchema = new mongoose.Schema(
  {
    // 凭证串（随机 32 字节 hex）：二维码里编码的就是它
    token: { type: String, required: true, unique: true, index: true },
    // 被邀请的学生
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // 冗余展示字段（扫完先给人看「要加入的是谁」，省一次 users 查询）
    realName: { type: String, default: '' },
    studentId: { type: String, default: '' },
    className: { type: String, default: '' },

    // 过期与使用状态：一次性（用掉即作废），默认 10 分钟有效
    expiresAt: { type: Date, required: true, index: true },
    usedAt: { type: Date, default: null },
    // 谁用掉的（干部 openid / 姓名），便于审计「这条码被谁扫了」
    usedByOpenid: { type: String, default: '' },
    usedByName: { type: String, default: '' },
  },
  { timestamps: true, collection: 'union_invites' }
);

// 过期自动清理：Mongo TTL 索引（由服务端在启动时保证索引存在）
unionInviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// 凭证有效期（毫秒）：10 分钟。
// 太短学生来不及出示、太长截图流传风险大。到期后重新打开二维码会自动生成新的。
unionInviteSchema.statics.TTL_MS = 10 * 60 * 1000;

module.exports = mongoose.model('UnionInvite', unionInviteSchema, 'union_invites');
