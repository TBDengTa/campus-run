const express = require('express');
const { wrap, ok, ApiError, parsePagination } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const Appeal = require('../models/appeal');
const BanRecord = require('../models/ban-record');

const router = express.Router();
router.use(auth);

// 提交申诉（封禁用户可用）
router.post(
  '/',
  wrap(async (req, res) => {
    const { content } = req.body || {};
    if (!content || content.trim().length < 10) throw new ApiError(400, 400, '请填写申诉说明（至少 10 字）');
    const hasPending = await Appeal.exists({ openid: req.user.openid, status: 'pending' });
    if (hasPending) throw new ApiError(400, 400, '已有待审核的申诉，请耐心等待');
    const lastBan = await BanRecord.findOne({ openid: req.user.openid, action: 'ban' }).sort({ createdAt: -1 }).lean();
    const appeal = await Appeal.create({
      openid: req.user.openid,
      banRecordId: lastBan?._id,
      studentId: req.user.studentId || req.body?.studentId || '',
      realName: req.user.realName || req.body?.realName || '',
      banReason: req.user.banReason || '',
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
    ok(res, { list, total, page, limit });
  })
);

module.exports = router;
