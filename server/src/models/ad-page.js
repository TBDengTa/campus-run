const mongoose = require('mongoose');

// 广告落地页（HTML 由后端托管，路由 /p/:slug）
const adPageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    htmlContent: { type: String, default: '' },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AdPage', adPageSchema, 'ad_pages');
