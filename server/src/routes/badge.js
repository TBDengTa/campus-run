const express = require('express');
const { wrap, ok } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const Badge = require('../models/badge');
const UserBadge = require('../models/user-badge');
const badgesSvc = require('../services/badges');

const router = express.Router();
router.use(auth);

// 全部徽章 + 我的获得状态 + 每枚徽章的进度
// 口径：list 只含「启用中」的定义；earnedCount 也只数这些定义，
// 已停用/已删除定义的残留 user_badges 行不计入，避免出现「获得数 > 总数」、进度 >100%。
// 成本：每次请求固定 3 次查询（定义 / 我的获得 / 运动汇总），不随徽章数量增长。
router.get(
  '/',
  wrap(async (req, res) => {
    const [badges, earned, stats] = await Promise.all([
      Badge.find({ enabled: true }).sort({ sort: 1 }).lean(),
      UserBadge.find({ openid: req.user.openid }).lean(),
      badgesSvc.aggregateUser(req.user.openid),
    ]);
    // 需要 streak_days 进度时才多查一次「按日汇总」（一次查询供该类型所有徽章共用）
    const needDaily = badges.some((b) => b.type === 'streak_days');
    const daily = needDaily ? await badgesSvc.tallyUser(req.user.openid) : null;
    const nextTargets = badgesSvc.buildNextTargets(badges);
    const progressCtx = { nextTargets, streak: (daily && daily.streak) || 0 };

    // 前端直接用 item.percent 与 item.progress / item.target 展示，无需再算一遍
    const earnedMap = new Map(earned.map((e) => [e.badgeKey, e]));
    const list = badges.map((b) => ({
      ...b,
      earned: earnedMap.has(b.key),
      earnedAt: earnedMap.get(b.key)?.createdAt || null,
      // level：该行记录时用户所在的等级（独立徽章为 0）
      level: earnedMap.get(b.key)?.level || 0,
      ...badgesSvc.progressOf(b, stats, progressCtx),
    }));
    const earnedCount = badges.reduce((n, b) => n + (earnedMap.has(b.key) ? 1 : 0), 0);
    const total = badges.length;
    ok(res, {
      list,
      earnedCount,
      total,
      // 汇总进度：未启用徽章不计入分母，恒在 0~100
      percent: total > 0 ? Math.round((earnedCount / total) * 100) : 0,
    });
  })
);

module.exports = router;
