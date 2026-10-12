const mongoose = require('mongoose');

// 广告位
const adSlotSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true }, // 如 home_banner / splash / record_card
    page: { type: String, default: '' },
    name: { type: String, required: true },
    type: { type: String, enum: ['banner', 'card', 'splash'], default: 'banner' },
    maxSponsors: { type: Number, default: 5 },
    exclusive: { type: Boolean, default: false },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AdSlot', adSlotSchema, 'ad_slots');
