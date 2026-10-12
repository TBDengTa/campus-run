const mongoose = require('mongoose');

const routePointSchema = new mongoose.Schema(
  {
    latitude: Number,
    longitude: Number,
    timestamp: Number, // 毫秒
  },
  { _id: false }
);

// 跑步/步数日记录：werun 来源为当日微信运动汇总，gps 来源为单次实跑
const runRecordSchema = new mongoose.Schema(
  {
    openid: { type: String, required: true, index: true },
    source: { type: String, enum: ['werun', 'gps'], required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    steps: { type: Number, default: 0 },
    distance: { type: Number, default: 0 }, // 米
    calories: { type: Number, default: 0 },
    durationSeconds: { type: Number, default: 0 },
    pace: { type: String, default: '' }, // 如 12'03"
    goalAchieved: { type: Boolean, default: false },
    startTime: { type: Date },
    endTime: { type: Date },
    routePoints: { type: [routePointSchema], default: undefined },
    location: { type: String, default: '' },
  },
  { timestamps: true }
);

runRecordSchema.index({ openid: 1, date: 1 });
runRecordSchema.index({ date: 1 });

module.exports = mongoose.model('RunRecord', runRecordSchema, 'run_records');
