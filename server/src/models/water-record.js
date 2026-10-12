const mongoose = require('mongoose');

const waterLogSchema = new mongoose.Schema(
  {
    time: { type: Date, default: Date.now },
    amount: { type: Number, required: true }, // ml
    type: { type: String, default: '水' },
  },
  { _id: false }
);

// 喝水打卡（每日一条）
const waterRecordSchema = new mongoose.Schema(
  {
    openid: { type: String, required: true },
    date: { type: String, required: true },
    target: { type: Number, default: 2000 }, // ml
    total: { type: Number, default: 0 },
    logs: { type: [waterLogSchema], default: [] },
  },
  { timestamps: true }
);

waterRecordSchema.index({ openid: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('WaterRecord', waterRecordSchema, 'water_records');
