const mongoose = require('mongoose');

// 全局配置单例：目标 / 反作弊 / 激励视频 / 跑分
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
    // 跑分：学校使用的衡量标准（达标基础分 + 超出目标的加分）
    // 计算公式见 services/points.js 文件头注释（与用户端 /api/points 完全一致）
    points: {
      enabled: { type: Boolean, default: true }, // 关闭后跑分一律为 0（不展示、不上榜）
      dailyGoal: { type: Number, default: 5 }, // 完成日目标得分
      weeklyGoal: { type: Number, default: 20 }, // 完成周目标得分
      // 日超出档位：超出日目标后，每再多达成「个人目标 × extraPercent%」的步数，得 perStepScore 分
      // （百分比而非固定步数：日目标 6000 与 15000 的人边际收益因此成比例，而不是完全相同）
      extraPercent: { type: Number, default: 10 }, // 百分比，范围 1~100
      // 【已弃用】固定步数档位：日公式已改用 extraPercent；这里保留仅供**周公式**使用（周公式本次未改）
      perStep: { type: Number, default: 1000 }, // 固定步数档位（仅周跑分使用，日公式已弃用该字段）
      perStepScore: { type: Number, default: 1 }, // 每达成一档加多少分
      dailyExtraCap: { type: Number, default: 10 }, // 单日超出加分上限（只封顶超出部分，不封顶达标基础分）
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
