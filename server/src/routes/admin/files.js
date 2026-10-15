const express = require('express');
const { wrap, ok, ApiError } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const { unlinkUpload } = require('../../utils/uploader');
const { AdContent, AdSponsor, User } = require('../../models');
const Badge = require('../../models/badge');
const FileObject = require('../../models/file-object');

const router = express.Router();

// 文件列表 + 汇总（挂载级 file.view）
router.get(
  '/',
  wrap(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = Math.min(60, Math.max(1, Number(req.query.size) || 24));
    const { category } = req.query;
    const cond = FileObject.CATEGORIES.includes(category) ? { category } : {};

    const [total, list, agg] = await Promise.all([
      FileObject.countDocuments(cond),
      FileObject.find(cond)
        .sort({ createdAt: -1 })
        .skip((page - 1) * size)
        .limit(size)
        .populate('uploader', 'nickname')
        .lean(),
      FileObject.aggregate([{ $group: { _id: '$category', count: { $sum: 1 }, size: { $sum: '$size' } } }]),
    ]);

    const byCategory = { all: 0, avatar: 0, ad: 0, badge: 0, other: 0 };
    let totalSize = 0;
    for (const row of agg) {
      if (byCategory[row._id] !== undefined) byCategory[row._id] = row.count;
      byCategory.all += row.count;
      totalSize += row.size;
    }

    ok(res, { list, total, page, size, stats: { byCategory, totalSize } });
  })
);

// 删除文件：删文档 + 磁盘文件 + 清理业务引用（file.manage）
router.delete(
  '/:id',
  requirePermission('file.manage'),
  wrap(async (req, res) => {
    const doc = await FileObject.findById(req.params.id);
    if (!doc) throw new ApiError(404, 404, '文件不存在');

    const cleared = { adContents: 0, adSponsors: 0, users: 0, badges: 0 };
    const [adContents, adSponsors, users, badges] = await Promise.all([
      AdContent.updateMany({ imageUrl: doc.url }, { $set: { imageUrl: '' } }),
      AdSponsor.updateMany({ logo: doc.url }, { $set: { logo: '' } }),
      User.updateMany({ avatarUrl: doc.url }, { $set: { avatarUrl: '' } }),
      // 徽章图标（icon 存 URL）：删文件后必须摘掉引用，否则用户端/管理端徽章会留一个裂图
      Badge.updateMany({ icon: doc.url }, { $set: { icon: '' } }),
    ]);
    cleared.adContents = adContents.modifiedCount || 0;
    cleared.adSponsors = adSponsors.modifiedCount || 0;
    cleared.users = users.modifiedCount || 0;
    cleared.badges = badges.modifiedCount || 0;

    await doc.deleteOne();
    unlinkUpload(doc.filename);
    ok(res, { cleared });
  })
);

module.exports = router;
