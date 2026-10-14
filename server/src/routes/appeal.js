const express = require('express');
const { wrap, ok, ApiError, parsePagination } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const Appeal = require('../models/appeal');
const BanRecord = require('../models/ban-record');
const anticheat = require('../services/anticheat');

const router = express.Router();
router.use(auth);

// 我当前生效的限制（限制登录 / 限制微信同步 / 限制 GPS）——申诉页据此让用户选类型
router.get(
  '/restrictions',
  wrap(async (req, res) => {
    ok(res, { restrictions: anticheat.activeRestrictions(req.user) });
  })
);

// 提交申诉（被限制的用户可用）
// body: { content, scope }；scope 省略时：只有一条限制就用它，否则默认 login
router.post(
  '/',
  wrap(async (req, res) => {
    const { content, scope } = req.body || {};
    if (!content || content.trim().length < 10) throw new ApiError(400, 400, '请填写申诉说明（至少 10 字）');

    const active = anticheat.activeRestrictions(req.user);
    if (!active.length) throw new ApiError(400, 400, '当前没有生效中的限制，无需申诉');
    const wanted = anticheat.SCOPES.includes(scope) ? scope : active.length === 1 ? active[0].scope : 'login';
    const target = active.find((r) => r.scope === wanted);
    if (!target) {
      throw new ApiError(400, 400, `当前没有「${anticheat.scopeText(wanted)}」限制，请选择正确的申诉类型`);
    }

    // 同一限制类型同时只允许一条待审核申诉
    const hasPending = await Appeal.exists({ openid: req.user.openid, banType: wanted, status: 'pending' });
    if (hasPending) throw new ApiError(400, 400, `「${target.text}」已有待审核的申诉，请耐心等待`);

    // 关联该类型的最近一条封禁流水（便于审核端对照事实）
    const lastBan = await BanRecord.findOne({ openid: req.user.openid, action: 'ban', banType: wanted })
      .sort({ createdAt: -1 })
      .lean();
    const appeal = await Appeal.create({
      openid: req.user.openid,
      banRecordId: lastBan?._id,
      banType: wanted,
      banUntil: target.until || null,
      studentId: req.user.studentId || req.body?.studentId || '',
      realName: req.user.realName || req.body?.realName || '',
      banReason: target.reason || req.user.banReason || '',
      content: content.trim(),
    });
    ok(res, appeal);
  })
);

// 我的申诉记录
router.get(
  '/mine',
  wrap(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const [list, total] = await Promise.all([
      Appeal.find({ openid: req.user.openid }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Appeal.countDocuments({ openid: req.user.openid }),
    ]);
    const rows = list.map((a) => ({ ...a, banTypeText: anticheat.scopeText(a.banType) }));
    ok(res, { list: rows, total, page, limit });
  })
);

module.exports = router;
