const mongoose = require('mongoose');

const { Schema } = mongoose;

// 设备登录令牌（"记住我 / 历史登录一键登录"）
// 只存 sha256 哈希，明文只在签发时返回给客户端一次；可撤销、有有效期
const loginDeviceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    // 冗余姓名/学号，便于管理端排查（不是鉴权依据）
    account: { type: String, default: '' },
    studentId: { type: String, default: '' },
    tokenHash: { type: String, unique: true },
    label: { type: String, default: '' }, // 设备/客户端描述（UA 截断）
    lastUsedAt: { type: Date },
    expiresAt: { type: Date, index: true },
    revoked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

loginDeviceSchema.index({ userId: 1, revoked: 1, lastUsedAt: -1 });

module.exports = mongoose.model('LoginDevice', loginDeviceSchema, 'login_devices');
