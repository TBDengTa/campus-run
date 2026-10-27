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
      // 单次同步步数暴增阈值。**2026-10-26 由 13000 提到 30000**（用户：「同步的微信步数不要被封禁」）：
      // 旧值 13000 对「白天走够了、晚上第一次进小程序」的人太窄 —— 一次首同步 15000 步就被
      // 判暴增、限制微信同步 7 天，24h 内再撞一次升级为限制登录，而那全是真实步数。
      // 配合 services/anticheat.js::checkStepJump 的「攒久了才同步不判违规」与 50000 单日上限，
      // 真实用户（含跑马拉松的）不会被误伤；真刷步的短时暴增仍会被抓。
      maxStepJumpPerSync: { type: Number, default: 30000 },
      minPaceSecondsPerKm: { type: Number, default: 120 }, // 配速低于该值(秒/公里)视为异常
      banDays: { type: Number, default: 7 },
      enabled: { type: Boolean, default: true },
    },
    rewardVideo: {
      dailyLimit: { type: Number, default: 10 }, // 每日观看上限
      stepsPerWatch: { type: Number, default: 1000 }, // 每次奖励步数
      // 每次奖励的另外三项：null = 未配置，按 stepsPerWatch 走
      // services/wechat.js::estimateFromSteps（0.7 米/步、0.04 千卡/步、0.5 秒/步）派生。
      // 单位与全库口径一致：距离米、时长秒；解析统一走 services/reward-video.js::resolvePerWatch
      distancePerWatch: { type: Number, default: null }, // 米，允许一位小数
      caloriesPerWatch: { type: Number, default: null }, // 千卡
      durationPerWatch: { type: Number, default: null }, // 秒
      // 激励视频广告位 ID（客户端公开标识，非密钥）：空 = 用户端用代码里的默认广告位。
      // 由管理端「北斗运动」配置下发，用户端从 /api/reward-video/today 读取。
      adUnitId: { type: String, default: '' },
      enabled: { type: Boolean, default: true },
    },
    /**
     * 楼名白名单（用户 2026-10-21）：
     * 「为了防止教室、宿舍被学生不统一填写，请在系统设置中增加教学用楼的楼名列表与
     *   宿舍用楼的楼名列表，这样学生先选择楼名自己再去填写门牌号(纯数字)这样就统一了。」
     *
     * 为什么要白名单而不是继续自由填：同一个教室会被写成「1号教学楼201 / 一教201 / 1-201」，
     * 后面按楼栋统计、按房间查人都对不上。这里只约束**楼名**，门牌号仍由人填（纯数字校验）。
     * 两份清单分别对应教学用楼（教室）与宿舍用楼（查宿），不要合并成一份 ——
     * 教学楼不会出现在查宿名单里，混在一起会让人选错。
     */
    buildings: {
      teaching: { type: [String], default: [] }, // 教学用楼楼名，如「1号教学楼」
      dorm: { type: [String], default: [] }, // 宿舍用楼楼名，如「1号宿舍楼」
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
