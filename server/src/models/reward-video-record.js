const mongoose = require('mongoose');

// 激励视频观看记录（每日一条，openid+date 唯一）
const rewardVideoRecordSchema = new mongoose.Schema(
  {
    openid: { type: String, required: true },
    date: { type: String, required: true },
    watchCount: { type: Number, default: 0 },
    stepsEarned: { type: Number, default: 0 },
  },
  { timestamps: true }
);

rewardVideoRecordSchema.index({ openid: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('RewardVideoRecord', rewardVideoRecordSchema, 'reward_video_records');
