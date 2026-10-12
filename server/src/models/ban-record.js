const mongoose = require('mongoose');

// 封禁/解封流水
const banRecordSchema = new mongoose.Schema(
  {
    // 迁移后统一为 User 的 ObjectId；用 Mixed 兼容历史字符串 id
    userId: { type: mongoose.Schema.Types.Mixed, required: true, index: true },
    openid: { type: String, index: true },
    action: { type: String, enum: ['ban', 'unban'], required: true },
    banType: { type: String, default: 'manual' }, // sync 同步异常 / manual 人工
    reason: { type: String, default: '' },
    durationDays: { type: Number, default: 0 },
    bannedUntil: { type: Date },
    operator: { type: String, default: 'system' }, // system 或管理员 openid
  },
  { timestamps: true }
);

module.exports = mongoose.model('BanRecord', banRecordSchema, 'ban_records');
