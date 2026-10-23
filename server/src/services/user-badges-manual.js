/**
 * 手工发放徽章的**唯一实现**。
 *
 * 为什么抽成 service：发放现在有两个入口 ——
 *   ① 管理端 `/api/admin/users/:id/badges`（需独立权限项 badge.manage）；
 *   ② 班级域 `/api/class/student/:id/badges`（班主任对本班学生，不需要 badge.manage，用户 2026-10-22）。
 * 发放是「按定义解析 + 幂等 upsert」的一段逻辑，复制一份就会出现
 * 「管理端会拦已停用定义、班级入口不拦」这类分裂，所以只留这一份。
 *
 * 口径（与管理端路由文件头一致）：
 *   · 发放 = $setOnInsert + upsert（幂等：重复发放不报错、不重复插入）；
 *   · 回收 = deleteMany（撤销语义 = 删除记录；用户以后再次满足条件会自动重新获得）；
 *   · 与 POST /api/badges/check（按需评估）、反作弊触发的撤销（services/anticheat.js）同一口径。
 *
 * 鉴权不在本文件：调用方必须先确认「要么有 badge.manage，要么是本班班主任」。
 */
const { ApiError } = require('../utils/response');
const badgesSvc = require('./badges');
const Badge = require('../models/badge');
const UserBadge = require('../models/user-badge');

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

/**
 * 给某个用户发放徽章。
 * 教师账号一律拒绝：goal_days / single_steps / 排名等徽章全部由运动数据推导，
 * 而教师不产生任何 run_records（AGENTS.md「教师账号规则」三层拦截），
 * 手工发放只会造出无依据、且用户端也看不到的记录。
 * @returns {Promise<{granted:boolean, badge:Object, list:Array, count:number}>}
 */
async function grantBadgeToUser(user, { badgeKey, tierGroup, tierLevel } = {}) {
  if (!user) throw new ApiError(404, 404, '用户不存在');
  if (user.role === 'teacher') throw new ApiError(400, 400, '教师账号不参与运动，无法发放徽章');
  if (!user.openid) throw new ApiError(400, 400, '该账号未绑定微信（没有 openid），无法关联徽章记录');
  const badge = await resolveGrantBadge({ badgeKey, tierGroup, tierLevel, openid: user.openid });
  const granted = await badgesSvc.grantBadge(user.openid, badge);
  const list = await earnedBadgeRows(user.openid);
  return {
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
  };
}

/**
 * 发放抽屉的数据源：全部「启用中」的徽章定义 + 该用户已获得列表（含 earned 标记）。
 * 管理端与班级域共用，避免两处渲染出不同的可选项。
 */
async function badgeSheetPayload(user) {
  if (!user) throw new ApiError(404, 404, '用户不存在');
  const [defs, list] = await Promise.all([
    Badge.find({ enabled: true }).sort({ sort: 1 }).lean(),
    earnedBadgeRows(user.openid),
  ]);
  const earnedKeys = new Set(list.map((b) => b.key));
  return {
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
  };
}

/**
 * 手工回收徽章（幂等：没获得过也返回成功 revoked:0）。
 * 「回收后用户再次满足条件会自动重新获得」——这句文案要在前端二次确认里写清。
 */
async function revokeBadgeFromUser(user, badgeKey, { reason } = {}) {
  if (!user) throw new ApiError(404, 404, '用户不存在');
  const key = String(badgeKey || '').trim();
  const def = await Badge.findOne({ key }).lean();
  if (!def) throw new ApiError(404, 404, `徽章不存在：${key}`);
  const { deleted } = await badgesSvc.revokeBadgesFor(user.openid, {
    badgeKey: key,
    reason: reason || '手工回收',
  });
  const list = await earnedBadgeRows(user.openid);
  return { revoked: deleted, badgeKey: key, name: def.name, list, count: list.length };
}

module.exports = { earnedBadgeRows, resolveGrantBadge, grantBadgeToUser, revokeBadgeFromUser, badgeSheetPayload };
