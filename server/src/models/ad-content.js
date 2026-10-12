const mongoose = require('mongoose');

// 广告素材/内容
const adContentSchema = new mongoose.Schema(
  {
    slotKey: { type: String, required: true, index: true },
    sponsorId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdSponsor', index: true },
    title: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    linkType: { type: String, enum: ['web', 'page', 'none'], default: 'web' },
    linkUrl: { type: String, default: '' }, // web 外链
    pageId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdPage' }, // page 落地页
    startDate: { type: String, default: '' }, // YYYY-MM-DD 投期
    endDate: { type: String, default: '' },
    weight: { type: Number, default: 1 }, // 排序权重，大者靠前
    enabled: { type: Boolean, default: true },
    totalPv: { type: Number, default: 0 },
    totalClick: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AdContent', adContentSchema, 'ad_contents');
