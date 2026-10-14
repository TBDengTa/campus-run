const express = require('express');
const { wrap, ok, ApiError } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const Organization = require('../models/organization');
const ClassMonitor = require('../models/class-monitor');

const router = express.Router();
router.use(auth);

// 组织树（学校 → 院系 → 专业）：按 parentId 通用组装，不写死层级
router.get(
  '/tree',
  wrap(async (req, res) => {
    const all = await Organization.find().sort({ sort: 1, createdAt: 1 }).lean();
    const byParent = new Map();
    for (const node of all) {
      const key = String(node.parentId || '');
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(node);
    }
    const build = (parentId) =>
      (byParent.get(String(parentId || '')) || []).map((node) => ({
        ...node,
        children: build(node._id),
      }));
    ok(res, build(null));
  })
);

// 班长绑定
router.post(
  '/monitor/bind',
  wrap(async (req, res) => {
    const { className } = req.body || {};
    if (!className) throw new ApiError(400, 400, '请填写班级名称');
    const existing = await ClassMonitor.findOne({ className, openid: { $ne: req.user.openid } });
    if (existing) throw new ApiError(400, 400, '该班级已有班长绑定');
    const doc = await ClassMonitor.findOneAndUpdate(
      { openid: req.user.openid },
      { $set: { className, studentId: req.user.studentId || '' } },
      { new: true, upsert: true }
    );
    ok(res, doc);
  })
);

router.get(
  '/monitor/me',
  wrap(async (req, res) => {
    ok(res, await ClassMonitor.findOne({ openid: req.user.openid }).lean());
  })
);

module.exports = router;
