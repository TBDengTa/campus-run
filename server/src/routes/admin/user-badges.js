/**
 * 管理端 · 用户徽章：手工发放 / 回收 / 列表（需独立权限项 badge.manage）
 *
 * 为什么单独一个 router（而不是塞进 routes/admin/users.js）：
 *   users.js 整个是挂在 requirePermission('user.view') 下面的，塞进去会变成「有 badge.manage
 *   但没有 user.view 的角色用不了这两个接口」。徽章发放/回收是**独立管理能力**，所以在
 *   routes/admin/index.js 里以 /users 前缀**先于** users 路由挂载（只匹配 /:id/badges*，
 *   其它路径 next() 落到 users 路由），权限完全由本文件的 requirePermission('badge.manage') 决定。
 *
 * 口径（与用户端徽章体系共用同一张表 user_badges 与唯一索引 {openid,badgeKey}）：
 *   发放 = $setOnInsert + upsert（幂等，重复发放不报错、不重复插入）；
 *   回收 = deleteMany（撤销语义 = 删除记录，不加 revoked 字段；用户以后再次满足条件会自动重新获得）。
 * 与 POST /api/badges/check（按需评估）、反作弊/封禁触发的撤销（services/anticheat.js::restrict）同一口径。
 */
const express = require('express');
const { wrap, ok, ApiError } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const badgesSvc = require('../../services/badges');
const Badge = require('../../models/badge');
const UserBadge = require('../../models/user-badge');
const User = require('../../models/user');

const router = express.Router();

// 该用户「已获得」的徽章行：与 GET /api/admin/users/:id/records?type=badges 同形
// （定义信息 + 获得时间 + 记录时的等级），按获得时间倒序；只统计「启用中」的定义，
// 避免停用定义的残留行让列表出现幽灵徽章。
async function earnedBadgeRows(openid) {
  if (!openid) return [];
  const [allBadges, earned] = await Promise.all([
    Badge.find({ enabled: true }).sort({ sort: 1 }).lean(),
    UserBadge.find({ openid }).lean(),
  ]);
  const byKey = new Map(earned.map((b) => [b.badgeKey, b]));
  return allBadges
    .filter((b) => byKey.has(b.key))
    .map((b) => {
      const row = byKey.get(b.key);
      return {
        key: b.key,
        name: b.name,
        icon: b.icon || '',
        tierColor: b.tierColor || '',
        earnedAt: row.createdAt,
        level: Number(row.level) || 0,
        tierGroup: b.tierGroup || '',
        tierLevel: Number(b.tierLevel) || 0,
        mode: b.mode || 'single',
      };
    })
    .sort((a, b) => new Date(b.earnedAt) - new Date(a.earnedAt));
}

// 发放目标的解析（三种写法，均已幂等）：
//   ① badgeKey                    —— 精确发放该定义（等级组里的某一个级别也用这个）
//   ② tierGroup + tierLevel       —— 发到指定等级组的指定级别
//   ③ tierGroup（省略 tierLevel） —— 发到该组「最低的还没获得的那一级」；全获得时取最高一级（幂等收敛）
async function resolveGrantBadge({ badgeKey, tierGroup, tierLevel, openid }) {
  const key = String(badgeKey || '').trim();
  if (key) {
    const def = await Badge.findOne({ key }).lean();
    if (!def) throw new ApiError(404, 404, `徽章不存在：${key}`);
    if (def.enabled === false) throw new ApiError(400, 400, `徽章「${def.name}」已停用，不能发放`);
    return def;
  }
  const group = String(tierGroup || '').trim();
  if (!group) throw new ApiError(400, 400, '请提供 badgeKey，或提供 tierGroup（可再指定 tierLevel）');
  const rows = await Badge.find({ tierGroup: group, enabled: true })
    .sort({ tierLevel: 1, sort: 1 })
    .lean();
  if (!rows.length) throw new ApiError(404, 404, `等级组不存在或没有启用中的级别：${group}`);
  if (tierLevel !== undefined && tierLevel !== null && String(tierLevel) !== '') {
    const lv = Number(tierLevel) || 0;
    const hit = rows.find((r) => (Number(r.tierLevel) || 0) === lv);
    if (!hit) throw new ApiError(404, 404, `等级组「${group}」没有 Lv${lv} 这一级`);
    return hit;
  }
  const earned = new Set(
    await UserBadge.find({ openid, badgeKey: { $in: rows.map((r) => r.key) } }).distinct('badgeKey')
  );
  return rows.find((r) => !earned.has(r.key)) || rows[rows.length - 1];
}

// 徽章定义 + 该用户已获得列表（发放抽屉的数据源；只列「启用中」的定义）
router.get(
  '/:id/badges',
  requirePermission('badge.manage'),
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id).select('openid role').lean();
    if (!user) throw new ApiError(404, 404, '用户不存在');
    const [defs, list] = await Promise.all([
      Badge.find({ enabled: true }).sort({ sort: 1 }).lean(),
      earnedBadgeRows(user.openid),
    ]);
    const earnedKeys = new Set(list.map((b) => b.key));
    ok(res, {
      list,
      count: list.length,
      definitions: defs.map((b) => ({
        key: b.key,
        name: b.name,
        description: b.description || '',
        icon: b.icon || '',
        tierColor: b.tierColor || '',
        mode: b.mode || 'single',
        tierGroup: b.tierGroup || '',
        tierLevel: Number(b.tierLevel) || 0,
        type: b.type,
        target: Number(b.target) || 0,
        sort: Number(b.sort) || 0,
        earned: earnedKeys.has(b.key),
      })),
    });
  })
);

// 手工发放（幂等）
// body: { badgeKey } 或 { tierGroup, tierLevel? }
// 教师账号也允许发放（教师不产生运动记录、徽章不会自动获得，由管理员决定；前端在抽屉里提示）
router.post(
  '/:id/badges',
  requirePermission('badge.manage'),
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id).select('openid role nickname realName account').lean();
    if (!user) throw new ApiError(404, 404, '用户不存在');
    if (!user.openid) throw new ApiError(400, 400, '该账号未绑定微信（没有 openid），无法关联徽章记录');
    const { badgeKey, tierGroup, tierLevel } = req.body || {};
    const badge = await resolveGrantBadge({ badgeKey, tierGroup, tierLevel, openid: user.openid });
    const granted = await badgesSvc.grantBadge(user.openid, badge);
    const list = await earnedBadgeRows(user.openid);
    ok(res, {
      success: true,
      granted, // true = 本次新增；false = 已获得过（幂等，不算失败）
      badge: {
        key: badge.key,
        name: badge.name,
        mode: badge.mode || 'single',
        tierGroup: badge.tierGroup || '',
        tierLevel: Number(badge.tierLevel) || 0,
      },
      list,
      count: list.length,
    });
  })
);

// 手工回收（幂等：没获得过也返回成功 revoked:0）
// 「回收后用户再次满足条件会自动重新获得」——这句文案要在前端二次确认里写清
router.delete(
  '/:id/badges/:badgeKey',
  requirePermission('badge.manage'),
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id).select('openid').lean();
    if (!user) throw new ApiError(404, 404, '用户不存在');
    const badgeKey = String(req.params.badgeKey || '').trim();
    const def = await Badge.findOne({ key: badgeKey }).lean();
    if (!def) throw new ApiError(404, 404, `徽章不存在：${badgeKey}`);
    const { deleted } = await badgesSvc.revokeBadgesFor(user.openid, {
      badgeKey,
      reason: `管理员回收（${(req.user && req.user.openid) || 'admin'}）`,
    });
    const list = await earnedBadgeRows(user.openid);
    ok(res, { success: true, revoked: deleted, badgeKey, name: def.name, list, count: list.length });
  })
);

module.exports = router;
