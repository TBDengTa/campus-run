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
    // 内置位：启动播种，key 不可改、不可删除（可改名称/类型/页面/开关等）
    builtIn: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// 内置广告位目录（服务端每次启动按 key 播种，仿 Permission.DEFAULT_CATALOG）
// 开屏位沿用旧库已有的 startup_banner（启动页广告即开屏），不另造新 key
const DEFAULT_SLOTS = [
  { key: 'home_banner', name: '首页轮播', type: 'banner', page: '首页', maxSponsors: 5, exclusive: false },
  { key: 'startup_banner', name: '开屏', type: 'splash', page: '启动页', maxSponsors: 1, exclusive: true },
  { key: 'record_card', name: '记录页卡片', type: 'card', page: '运动记录', maxSponsors: 3, exclusive: false },
  { key: 'ranking_card', name: '排行榜卡片', type: 'card', page: '排行榜', maxSponsors: 3, exclusive: false },
];

const AdSlot = mongoose.model('AdSlot', adSlotSchema, 'ad_slots');
AdSlot.DEFAULT_SLOTS = DEFAULT_SLOTS;

module.exports = AdSlot;
