const mongoose = require('mongoose');

const routePointSchema = new mongoose.Schema(
  {
    latitude: Number,
    longitude: Number,
    timestamp: Number, // 毫秒
  },
  { _id: false }
);

// 跑步/步数记录：三种来源各自独立成条
//   werun  微信运动同步（1 小时内的多次同步合并为一条，超过 1 小时新建当日下一条，记增量）
//   gps    GPS 实跑（单次一条，一天可多条）
//   beidou 北斗：激励视频奖励的步数（当日一条累加）
const runRecordSchema = new mongoose.Schema(
  {
    openid: { type: String, required: true, index: true },
    source: { type: String, enum: ['werun', 'gps', 'beidou'], required: true },
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
