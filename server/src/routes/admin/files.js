const express = require('express');
const { wrap, ok, ApiError } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const { unlinkUpload } = require('../../utils/uploader');
const { AdContent, AdSponsor, User } = require('../../models');
const Badge = require('../../models/badge');
const CheckRecord = require('../../models/check-record');
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

    // 统计键**从模型的枚举派生**（不再硬编码）：新增一个「用途」时只要加
    // file-object.js::CATEGORIES（+ 前端 CATS），这里自动跟上。
    // 历史 bug：这里曾写死 { avatar, ad, badge, other }，而 check_photo 是第四轮新增的用途，
    // 导致学生会的检查照片在文件管理里**没有这一项分类计数**（byCategory 无该键 → 前端统计网格与
    // 筛选条都没有「检查照片」，用户报障「拍照上传没有显示」）。
    // 注意：`all` 与 `totalSize` 是**对全部聚合行**累加的，所以它们本来就没漏（出错的是分类明细）。
    const byCategory = { all: 0 };
    for (const c of FileObject.CATEGORIES) byCategory[c] = 0;
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

    const cleared = { adContents: 0, adSponsors: 0, users: 0, badges: 0, checkRecords: 0 };
    const [adContents, adSponsors, users, badges, checkRecords] = await Promise.all([
      AdContent.updateMany({ imageUrl: doc.url }, { $set: { imageUrl: '' } }),
      AdSponsor.updateMany({ logo: doc.url }, { $set: { logo: '' } }),
      User.updateMany({ avatarUrl: doc.url }, { $set: { avatarUrl: '' } }),
      // 徽章图标（icon 存 URL）：删文件后必须摘掉引用，否则用户端/管理端徽章会留一个裂图
      Badge.updateMany({ icon: doc.url }, { $set: { icon: '' } }),
      // 检查留证照片（check_records.photos 是 URL 数组）：用 $pull 把该 URL 从数组里摘掉。
      // 不做这一步的话，记录详情页会显示一个裂图 —— 而检查照片本来是**复核证据**，
      // 必须与文件管理里的删除动作保持一致（删了文件就同时从记录里摘引用）。
      CheckRecord.updateMany({ photos: doc.url }, { $pull: { photos: doc.url } }),
    ]);
    cleared.adContents = adContents.modifiedCount || 0;
    cleared.adSponsors = adSponsors.modifiedCount || 0;
    cleared.users = users.modifiedCount || 0;
    cleared.badges = badges.modifiedCount || 0;
    cleared.checkRecords = checkRecords.modifiedCount || 0;

    await doc.deleteOne();
    unlinkUpload(doc.filename);
    ok(res, { cleared });
  })
);

module.exports = router;
