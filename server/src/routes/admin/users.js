const express = require('express');
const { wrap, ok, ApiError, parsePagination } = require('../../utils/response');
const anticheat = require('../../services/anticheat');
const BanRecord = require('../../models/ban-record');
const User = require('../../models/user');

const router = express.Router();

// 用户列表/搜索
router.get(
  '/',
  wrap(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const cond = {};
    if (req.query.keyword) {
      const kw = req.query.keyword.trim();
      const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      cond.$or = [{ nickname: re }, { realName: re }, { studentId: re }, { openid: kw }, { className: re }];
    }
    if (req.query.status) cond.status = req.query.status;
    if (req.query.role) cond.role = req.query.role;
    const [list, total] = await Promise.all([
      User.find(cond).sort({ createdAt: -1 }).skip(skip).limit(limit).select('-__v').lean(),
      User.countDocuments(cond),
    ]);
    ok(res, { list, total, page, limit });
  })
);

// 用户详情（含封禁流水）
router.get(
  '/:id',
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id).select('-__v').lean();
    if (!user) throw new ApiError(404, 404, '用户不存在');
    const bans = await BanRecord.find({ userId: user._id }).sort({ createdAt: -1 }).limit(50).lean();
    ok(res, { user, bans });
  })
);

// 封禁
router.post(
  '/:id/ban',
  wrap(async (req, res) => {
    const { reason, days } = req.body || {};
    const user = await User.findById(req.params.id);
    if (!user) throw new ApiError(404, 404, '用户不存在');
    if (user.role === 'admin') throw new ApiError(400, 400, '不能封禁管理员');
    await anticheat.manualBan(user, {
      reason,
      days: Number(days) || 0,
      operator: req.user.openid,
    });
    ok(res, { success: true });
  })
);

// 解封
router.post(
  '/:id/unban',
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw new ApiError(404, 404, '用户不存在');
    await anticheat.manualUnban(user, req.user.openid);
    ok(res, { success: true });
  })
);

module.exports = router;
