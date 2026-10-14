const mongoose = require('mongoose');

// 封禁/限制申诉
const appealSchema = new mongoose.Schema(
  {
    openid: { type: String, required: true, index: true },
    banRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'BanRecord' },
    // 申诉针对的限制类型：login 限制登录 / sync 限制微信同步 / gps 限制 GPS 实跑
    banType: { type: String, default: 'login', index: true },
    banUntil: { type: Date }, // 提交时该限制的到期时间（快照，null = 永久）
    studentId: { type: String, default: '' },
    realName: { type: String, default: '' },
    banReason: { type: String, default: '' },
    content: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    reply: { type: String, default: '' },
    reviewedBy: { type: String, default: '' },
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Appeal', appealSchema, 'appeals');
