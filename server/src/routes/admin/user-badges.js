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
// 发放/列表的实现搬到了 services/user-badges-manual.js：
// 班级域（班主任给本班学生发徽章）与管理端必须走同一份，见该文件头。
const manualBadges = require('../../services/user-badges-manual');
const Badge = require('../../models/badge');
const User = require('../../models/user');

const router = express.Router();

const { earnedBadgeRows } = manualBadges;

// 徽章定义 + 该用户已获得列表（发放抽屉的数据源；只列「启用中」的定义）
router.get(
  '/:id/badges',
  requirePermission('badge.manage'),
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id).select('openid role').lean();
    if (!user) throw new ApiError(404, 404, '用户不存在');
    ok(res, await manualBadges.badgeSheetPayload(user));
  })
);

// 手工发放（幂等）
// body: { badgeKey } 或 { tierGroup, tierLevel? }
// ⚠️ 教师账号一律拒绝（用户 2026-10-20）：徽章 9 种类型（total_steps / total_distance / total_days /
//   goal_days / single_steps / single_distance / streak_days / points / rank）**全部由运动数据推导**，
//   没有「荣誉/手工」类型；而教师不产生任何 run_records（AGENTS.md「教师账号规则」三层拦截），
//   所以教师永远不可能合法达成任何徽章 —— 手工发放只会造出**无依据的记录**，
//   且发出去谁都看不见（教师详情页徽章列表在「运动」Tab 内、教师端「我的徽章」入口也被隐藏）。
//   旧注释「教师也允许手工发放」是错的，已按此口径收回。
//   回收（DELETE）**不**拦教师：撤销是幂等删除，万一有历史脏数据也要能清掉。
router.post(
  '/:id/badges',
  requirePermission('badge.manage'),
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id).select('openid role nickname realName account').lean();
    if (!user) throw new ApiError(404, 404, '用户不存在');
    const { badgeKey, tierGroup, tierLevel } = req.body || {};
    const r = await manualBadges.grantBadgeToUser(user, { badgeKey, tierGroup, tierLevel });
    ok(res, { success: true, granted: r.granted, badge: r.badge, list: r.list, count: r.count });
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
    const r = await manualBadges.revokeBadgeFromUser(user, req.params.badgeKey, {
      reason: `管理员回收（${(req.user && req.user.openid) || 'admin'}）`,
    });
    ok(res, { success: true, revoked: r.revoked, badgeKey: r.badgeKey, name: r.name, list: r.list, count: r.count });
  })
);

module.exports = router;
