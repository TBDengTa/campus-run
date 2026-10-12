const mongoose = require('mongoose');

// 广告 PV/点击明细（大表：查询全部走索引）
const adStatSchema = new mongoose.Schema(
  {
    contentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    slotKey: { type: String, required: true },
    sponsorId: { type: mongoose.Schema.Types.ObjectId },
    type: { type: String, enum: ['pv', 'click'], required: true },
    openid: { type: String, default: '' },
    date: { type: String, required: true }, // YYYY-MM-DD
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

adStatSchema.index({ contentId: 1, date: 1 });
adStatSchema.index({ slotKey: 1, date: 1 });
adStatSchema.index({ date: 1 });
adStatSchema.index({ sponsorId: 1, date: 1 });

module.exports = mongoose.model('AdStat', adStatSchema, 'ad_stats');
