const mongoose = require('mongoose');

/**
 * 北斗运动每日状态（每人每天一份，openid+date 唯一）。
 *
 * 为什么所有计数都收敛到这一份文档：抽奖次数、签到、看视频/分享次数、当日已发步数
 * 必须是**同一个原子版本**，否则「并发抽奖两次各自读到剩余 1 次」就会多发一次。
 * 并发安全统一用本集合的 `draw.used` 做 CAS 版本号（与 services/steps.js::reportRewardVideo
 * 的 watchCount 自增写法同一套：先读 → 带旧值条件更新 → 更新失败即视为抢输）。
 *
 * 方案与口径见 docs/beidou-lottery-plan.md。
 */
const beidouDaySchema = new mongoose.Schema(
  {
    openid: { type: String, required: true },
    date: { type: String, required: true }, // YYYY-MM-DD（本地日历键，与全库一致）

    draw: {
      // 今日**获得**的总次数（各来源之和）
      total: { type: Number, default: 0 },
      // 今日**已抽**次数：CAS 版本号，也是「次数不足」判定的依据
      used: { type: Number, default: 0 },
      fromVideo: { type: Number, default: 0 },
      fromShare: { type: Number, default: 0 },
      fromCheckin: { type: Number, default: 0 },
      fromPrize: { type: Number, default: 0 }, // 「再来一次」产生的次数
      // 今日抽奖 + 签到累计**发出的步数**：dailyStepsCap 的判定唯一依据。
      // ⚠️ 这是方案里唯一的成本闸门（用户 2026-11-11 定了「次数不限 + 点分享即给」），
      //    任何新增的「发步数」路径都必须往这里累加，否则封顶就是假的。
      stepsAwarded: { type: Number, default: 0 },
      capped: { type: Boolean, default: false }, // 今日是否已触及步数封顶（前端据此提示）
    },

    // 看视频：watchIds 是幂等凭据（同 services/steps.js 的 $slice:-50 写法）
    video: {
      count: { type: Number, default: 0 },
      watchIds: { type: [String], default: [] },
    },

    // 分享：lastAt 用于服务端最小间隔（纯技术防连点，不是次数上限）
    share: {
      count: { type: Number, default: 0 },
      lastAt: { type: Date, default: null },
    },

    // 签到：streak = 当日签到**之后**的连续天数（1 起）
    checkin: {
      done: { type: Boolean, default: false },
      at: { type: Date, default: null },
      streak: { type: Number, default: 0 },
      award: {
        draw: { type: Number, default: 0 },
        steps: { type: Number, default: 0 },
      },
    },
  },
  { timestamps: true }
);

// 每人每天一份：唯一索引本身就是「重复签到/重复建档」的硬拦截，不靠 if 判断
beidouDaySchema.index({ openid: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('BeidouDay', beidouDaySchema, 'beidou_day');
