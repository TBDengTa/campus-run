const express = require('express');
const { wrap, ok } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const Badge = require('../models/badge');
const UserBadge = require('../models/user-badge');

const router = express.Router();
router.use(auth);

// 全部徽章 + 我的获得状态
router.get(
  '/',
  wrap(async (req, res) => {
    const [badges, earned] = await Promise.all([
      Badge.find({ enabled: true }).sort({ sort: 1 }).lean(),
      UserBadge.find({ openid: req.user.openid }).lean(),
    ]);
    const earnedMap = new Map(earned.map((e) => [e.badgeKey, e]));
    const list = badges.map((b) => ({
      ...b,
      earned: earnedMap.has(b.key),
      earnedAt: earnedMap.get(b.key)?.createdAt || null,
    }));
    ok(res, { list, earnedCount: earned.length, total: badges.length });
  })
);

module.exports = router;
