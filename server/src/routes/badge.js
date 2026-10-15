const express = require('express');
const { wrap, ok } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const Badge = require('../models/badge');
const UserBadge = require('../models/user-badge');
const badgesSvc = require('../services/badges');

const router = express.Router();
router.use(auth);

// 教师账号不参与运动记录（run_records 里没有它的行），也就没有任何徽章可发放。
// 徽章页对教师端本就不展示，这里再兜一层：直接返回空结果，不跑聚合、不报错。
function isTeacher(user) {
  return !!user && user.role === 'teacher';
}

// ===== 按需检测（客户端登录后触发，只评估当前登录用户）=====
// 为什么不做服务端全量补发：1500+ 用户逐人聚合会打爆数据库；改由客户端在登录后提交一次
// 「检测我是否达成」，服务端只评估 req.user.openid，幂等补发。
// 成本：固定 3 次单用户查询（启用中的定义 / 我的获得 / 运动汇总，均带 openid 索引），
//       没有全表扫描、没有定时任务、不遍历其他用户。
// 幂等：evaluateBadges 用 {openid, badgeKey} 唯一索引 + $setOnInsert，重复调用不会重复发放，
//       第二次 newBadges 必为空数组（只有真正插入的新行才计入）。
router.post(
  '/check',
  wrap(async (req, res) => {
    const openid = req.user.openid;
    const [badges, earnedList, stats] = await Promise.all([
      Badge.find({ enabled: true }).sort({ sort: 1 }).lean(),
      UserBadge.find({ openid }).select('badgeKey level').lean(),
      // 教师没有运动记录：跳过这次聚合（aggregate 本身也只会返回空结果）
      isTeacher(req.user) ? Promise.resolve(null) : badgesSvc.aggregateUser(openid),
    ]);
    // 教师：无运动记录 → 无徽章可发，直接返回空（不报错、不发放）
    if (isTeacher(req.user)) {
      return ok(res, {
        newBadges: [],
        earnedCount: 0,
        total: badges.length,
        checkedAt: new Date(),
      });
    }
    // 已获得的 key 集合在 evaluateBadges 内部按需重建；这里只把三份数据传进去复用，避免重复聚合
    const newBadges = await badgesSvc.evaluateBadges(openid, {
      badges,
      earned: earnedList.map((e) => e.badgeKey),
      stats,
    });
    const earnedKeys = new Set(earnedList.map((e) => e.badgeKey));
    // 新发放的直接并进来，省掉一次「重新读获得列表」的查询
    for (const b of newBadges) earnedKeys.add(b.key);
    // 计数口径与 GET 一致：只数「启用中」的定义，避免已停用定义的残留行把获得数算大
    const earnedCount = badges.reduce((n, b) => n + (earnedKeys.has(b.key) ? 1 : 0), 0);
    const list = newBadges.map((b) => ({
      key: b.key,
      name: b.name,
      description: b.description || '',
      icon: b.icon || '',
      mode: b.mode || 'single',
      tierGroup: b.tierGroup || '',
      tierLevel: Number(b.tierLevel) || 0,
      type: b.type,
      target: b.target,
      // 等级徽章给前端拼「升级到 LvN」用；独立徽章为 0
      level: b.mode === 'tier' ? Number(b.tierLevel) || 0 : 0,
    }));
    ok(res, {
      newBadges: list,
      earnedCount,
      total: badges.length,
      checkedAt: new Date(),
    });
  })
);

// 全部徽章 + 我的获得状态 + 每枚徽章的进度
// 口径：list 只含「启用中」的定义；earnedCount 也只数这些定义，
// 已停用/已删除定义的残留 user_badges 行不计入，避免出现「获得数 > 总数」、进度 >100%。
// 成本：每次请求固定 3 次查询（定义 / 我的获得 / 运动汇总），不随徽章数量增长。
// 只读：这里**不发放**任何徽章，发放只发生在 POST /api/badges/check（写入路径另有 3 处）。
router.get(
  '/',
  wrap(async (req, res) => {
    // 教师：没有运动记录，直接给空列表（前端对教师本就不展示徽章）
    if (isTeacher(req.user)) {
      const badges = await Badge.find({ enabled: true }).lean();
      return ok(res, { list: [], earnedCount: 0, total: badges.length, percent: 0 });
    }
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
