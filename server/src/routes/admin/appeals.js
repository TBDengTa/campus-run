const express = require('express');
const { wrap, ok, ApiError, parsePagination } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const Appeal = require('../../models/appeal');
const User = require('../../models/user');
const anticheat = require('../../services/anticheat');

const router = express.Router();

// 申诉列表：带上用户当前状态与生效中的限制，审核端才看得到「事实」
router.get(
  '/',
  wrap(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const cond = {};
    if (req.query.status) cond.status = req.query.status;
    if (req.query.banType) cond.banType = req.query.banType;
    const [raw, total] = await Promise.all([
      Appeal.find(cond).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Appeal.countDocuments(cond),
    ]);
    const openids = raw.map((a) => a.openid).filter(Boolean);
    const users = openids.length
      ? await User.find({ openid: { $in: openids } })
          .select('openid realName nickname studentId className status banReason banType bannedUntil restrictions role')
          .lean()
      : [];
    const byOpenid = new Map(users.map((u) => [u.openid, u]));
    const list = raw.map((a) => {
      const u = byOpenid.get(a.openid) || null;
      return {
        ...a,
        banTypeText: anticheat.scopeText(a.banType),
        user: u
          ? {
              _id: u._id,
              realName: u.realName || u.nickname || '',
              studentId: u.studentId || '',
              className: u.className || '',
              role: u.role,
              status: u.status,
              restrictions: anticheat.activeRestrictions(u),
            }
          : null,
      };
    });
    ok(res, { list, total, page, limit });
  })
);

// 审核：approve=true → 只解除「该申诉针对的那一类限制」（可选 scope 覆盖）；false → 驳回
router.post(
  '/:id/review',
  requirePermission('appeal.review'),
  wrap(async (req, res) => {
    const { approve, reply, scope } = req.body || {};
    const appeal = await Appeal.findById(req.params.id);
    if (!appeal) throw new ApiError(404, 404, '申诉不存在');
    if (appeal.status !== 'pending') throw new ApiError(400, 400, '该申诉已处理');

    appeal.status = approve ? 'approved' : 'rejected';
    appeal.reply = reply || '';
    appeal.reviewedBy = req.user.openid;
    appeal.reviewedAt = new Date();
    await appeal.save();

    let lifted = [];
    if (approve) {
      const user = await User.findOne({ openid: appeal.openid });
      if (user) {
        // 默认只解除申诉针对的类型；管理员可用 scope 指定（含 'all'）
        const target = scope === 'all' || anticheat.SCOPES.includes(scope) ? scope : appeal.banType || 'login';
        const res1 = await anticheat.lift({
          user,
          scope: target,
          operator: req.user.openid,
          reason: `申诉通过解除「${anticheat.scopeText(target === 'all' ? appeal.banType : target)}」：${(reply || '').slice(0, 100)}`,
        });
        lifted = res1.lifted;
      }
    }
    ok(res, { appeal, lifted });
  })
);

module.exports = router;
