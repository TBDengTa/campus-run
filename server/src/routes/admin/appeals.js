const express = require('express');
const { wrap, ok, ApiError, parsePagination } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const Appeal = require('../../models/appeal');
const User = require('../../models/user');
const BanRecord = require('../../models/ban-record');
const anticheat = require('../../services/anticheat');

const router = express.Router();

router.get(
  '/',
  wrap(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const cond = {};
    if (req.query.status) cond.status = req.query.status;
    const [list, total] = await Promise.all([
      Appeal.find(cond).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Appeal.countDocuments(cond),
    ]);
    ok(res, { list, total, page, limit });
  })
);

// 审核：approve=true 解封并采纳；false 驳回（需 appeal.review）
router.post(
  '/:id/review',
  requirePermission('appeal.review'),
  wrap(async (req, res) => {
    const { approve, reply } = req.body || {};
    const appeal = await Appeal.findById(req.params.id);
    if (!appeal) throw new ApiError(404, 404, '申诉不存在');
    if (appeal.status !== 'pending') throw new ApiError(400, 400, '该申诉已处理');

    appeal.status = approve ? 'approved' : 'rejected';
    appeal.reply = reply || '';
    appeal.reviewedBy = req.user.openid;
    appeal.reviewedAt = new Date();
    await appeal.save();

    if (approve) {
      const user = await User.findOne({ openid: appeal.openid });
      if (user && user.status === 'banned') {
        user.status = 'active';
        user.banReason = '';
        user.bannedUntil = null;
        await user.save();
        await BanRecord.create({
          userId: user._id,
          openid: user.openid,
          action: 'unban',
          banType: 'manual',
          reason: `申诉通过：${(reply || '').slice(0, 100)}`,
          operator: req.user.openid,
        });
      }
    }
    ok(res, appeal);
  })
);

module.exports = router;
