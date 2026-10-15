const express = require('express');
const { wrap, ok } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const points = require('../services/points');

const router = express.Router();
router.use(auth);

// GET /api/points/me —— 我的跑分（用户端）
// 返回：{ total, today, week, config: { enabled, dailyGoal, weeklyGoal, extraPercent, weeklyExtraPercent,
//         perStepScore, dailyExtraCap, weeklyExtraCap, perStep } }
//   total = 全历史跑分（各日跑分之和 + 各达标周的一次性周分）
//   today = 今日跑分（达标基础分 + 超出加分，封顶 dailyExtraCap）
//   week  = 本周（周一起）跑分
//   config.extraPercent       = 日超出档位（个人日目标的百分比）
//   config.weeklyExtraPercent = 周超出档位（个人周目标的百分比）
//   config.weeklyExtraCap     = 单周超出加分上限（0 = 不封顶）
//   config.perStep 已**完全弃用**（日、周公式都不再读取，仅为兼容老客户端字段而保留）
// 口径与排行榜 metric=points / 管理端日周记录完全一致（见 services/points.js 文件头注释）
router.get(
  '/me',
  wrap(async (req, res) => {
    const openid = req.user.openid;
    const config = await points.getPointsConfig();
    const { today, weekStart } = points.currentWindows();

    const [todayInfo, weekInfo, totalInfo] = await Promise.all([
      points.sumPointsByDay(openid, { from: today, to: today, config }),
      points.sumPointsByDay(openid, { from: weekStart, to: today, config }),
      points.sumPointsTotal(openid, { config }),
    ]);

    ok(res, {
      total: totalInfo.total || 0,
      today: todayInfo.total || 0,
      week: weekInfo.total || 0,
      date: today,
      weekStart,
      config: points.publicConfig(config),
      // 今日增量/距下次加分（纯展示用，公式与后端一致）
      todaySteps: todayInfo.steps || 0,
      weekSteps: weekInfo.steps || 0,
    });
  })
);

module.exports = router;
