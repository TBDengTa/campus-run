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
      // 日超出档位：超出日目标后，每再多达成「个人日目标 × extraPercent%」的步数，得 perStepScore 分
      // （百分比而非固定步数：档位随个人目标等比放大，相对努力等值）
      extraPercent: { type: Number, default: 10 }, // 百分比，范围 1~100
      // 周超出档位：超出周目标后，每再多达成「个人周目标 × weeklyExtraPercent%」的步数，得 perStepScore 分
      weeklyExtraPercent: { type: Number, default: 10 }, // 百分比，范围 1~100
      // 【已完全弃用】固定步数档位：日、周公式都不再读取（保留字段仅为兼容存量配置文档）
      perStep: { type: Number, default: 1000 },
      perStepScore: { type: Number, default: 1 }, // 每达成一档加多少分（日/周共用）
      dailyExtraCap: { type: Number, default: 10 }, // 单日超出加分上限（只封顶超出部分，不封顶达标基础分）
      // 单周超出加分上限：**0 = 不封顶**（默认 0，与改造前的「周无上限」一致）；> 0 才封顶超出部分
      weeklyExtraCap: { type: Number, default: 0 },
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
