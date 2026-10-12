const mongoose = require('mongoose');

// 封禁申诉
const appealSchema = new mongoose.Schema(
  {
    openid: { type: String, required: true, index: true },
    banRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'BanRecord' },
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
