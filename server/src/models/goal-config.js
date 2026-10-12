const mongoose = require('mongoose');

// 全局配置单例：目标 / 反作弊 / 激励视频
const goalConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true },
    daily: {
      steps: { type: Number, default: 5000 },
      distance: { type: Number, default: 3000 }, // 米
      calories: { type: Number, default: 250 },
    },
    weekly: {
      steps: { type: Number, default: 35000 },
      distance: { type: Number, default: 21000 },
      calories: { type: Number, default: 1750 },
    },
    // 分时段目标：到某时刻应完成当日目标的百分比
    graded: {
      type: [{ time: String, percent: Number }],
      default: [
        { time: '10:00', percent: 40 },
        { time: '16:00', percent: 70 },
        { time: '22:00', percent: 100 },
      ],
    },
    anticheat: {
      maxStepJumpPerSync: { type: Number, default: 13000 }, // 单次同步步数暴增阈值
      minPaceSecondsPerKm: { type: Number, default: 120 }, // 配速低于该值(秒/公里)视为异常
      banDays: { type: Number, default: 7 },
      enabled: { type: Boolean, default: true },
    },
    rewardVideo: {
      dailyLimit: { type: Number, default: 10 }, // 每日观看上限
      stepsPerWatch: { type: Number, default: 1000 }, // 每次奖励步数
      enabled: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

goalConfigSchema.statics.getSingleton = async function () {
  let doc = await this.findOne({ key: 'default' });
  if (!doc) doc = await this.create({ key: 'default' });
  return doc;
};

module.exports = mongoose.model('GoalConfig', goalConfigSchema, 'goal_config');
