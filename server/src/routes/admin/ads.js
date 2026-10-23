const express = require('express');
const mongoose = require('mongoose');
const { wrap, ok, ApiError, parsePagination } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const AdSponsor = require('../../models/ad-sponsor');
const AdSlot = require('../../models/ad-slot');
const AdContent = require('../../models/ad-content');
const AdPage = require('../../models/ad-page');
const AdStat = require('../../models/ad-stat');
const config = require('../../config');

const router = express.Router();

const MODEL_MAP = { sponsors: AdSponsor, slots: AdSlot, contents: AdContent, pages: AdPage };

// 可写字段白名单：_id / createdAt / updatedAt / __v / 统计数 / builtIn 一律不收
const WRITABLE_FIELDS = {
  sponsors: ['name', 'contact', 'phone', 'email', 'logo', 'active'],
  slots: ['key', 'name', 'type', 'page', 'maxSponsors', 'exclusive', 'enabled'],
  contents: ['slotKey', 'sponsorId', 'title', 'imageUrl', 'linkType', 'linkUrl', 'pageId', 'startDate', 'endDate', 'weight', 'enabled'],
  pages: ['name', 'slug', 'htmlContent', 'enabled'],
};

function pickWritable(name, body = {}) {
  const allow = WRITABLE_FIELDS[name] || [];
  const out = {};
  for (const f of allow) {
    if (Object.prototype.hasOwnProperty.call(body, f)) out[f] = body[f];
  }
  return out;
}

// 通用 CRUD：/sponsors /slots /contents /pages
for (const [name, Model] of Object.entries(MODEL_MAP)) {
  router.get(
    `/${name}`,
    wrap(async (req, res) => {
      const { page, limit, skip } = parsePagination(req.query, { page: 1, limit: 50 });
      const cond = {};
      if (req.query.keyword) {
        const re = new RegExp(req.query.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        cond.name = re;
      }
      if (req.query.slotKey) cond.slotKey = req.query.slotKey;
      // 广告位：内置位靠前且按播种顺序排列，便于运营一眼看到四个固定位
      const sort = name === 'slots' ? { builtIn: -1, createdAt: 1 } : { createdAt: -1 };
      const [list, total] = await Promise.all([
        Model.find(cond).sort(sort).skip(skip).limit(limit).lean(),
        Model.countDocuments(cond),
      ]);
      ok(res, { list, total, page, limit });
    })
  );

  router.post(
    `/${name}`,
    requirePermission('ad.manage'),
    wrap(async (req, res) => {
      const data = pickWritable(name, req.body);
      if (name === 'slots' && (!data.key || !data.name)) {
        throw new ApiError(400, 400, 'key 和名称必填');
      }
      const doc = await Model.create(data);
      ok(res, doc);
    })
  );

  router.put(
    `/${name}/:id`,
    requirePermission('ad.manage'),
    wrap(async (req, res) => {
      const data = pickWritable(name, req.body);
      // 广告位 key 保护：内置位与已被素材引用的位不可改 key
      if (name === 'slots' && data.key) {
        const current = await AdSlot.findById(req.params.id).select('key builtIn').lean();
        if (!current) throw new ApiError(404, 404, '不存在');
        if (data.key !== current.key) {
          if (current.builtIn) throw new ApiError(400, 400, '内置广告位不可修改 key');
          const used = await AdContent.countDocuments({ slotKey: current.key });
          if (used) throw new ApiError(400, 400, `该广告位已被 ${used} 条素材引用，不可修改 key`);
        }
      }
      const doc = await Model.findByIdAndUpdate(req.params.id, { $set: data }, { new: true, runValidators: true });
      if (!doc) throw new ApiError(404, 404, '不存在');
      ok(res, doc);
    })
  );

  router.delete(
    `/${name}/:id`,
    requirePermission('ad.manage'),
    wrap(async (req, res) => {
      let doc;
      if (name === 'slots') {
        const slot = await AdSlot.findById(req.params.id).lean();
        if (!slot) throw new ApiError(404, 404, '不存在');
        if (slot.builtIn) throw new ApiError(400, 400, '内置广告位不可删除');
        doc = await AdSlot.findByIdAndDelete(req.params.id);
      } else {
        doc = await Model.findByIdAndDelete(req.params.id);
        if (!doc) throw new ApiError(404, 404, '不存在');
      }
      // 级联：删除广告位时停用其下素材；删除落地页时素材改回外链
      if (name === 'slots') {
        await AdContent.updateMany({ slotKey: doc.key }, { $set: { enabled: false } });
      }
      if (name === 'pages') {
        await AdContent.updateMany({ pageId: doc._id }, { $set: { linkType: 'none', pageId: null } });
      }
      ok(res, { success: true });
    })
  );
}

// 落地页访问地址
router.get(
  '/pages-link/:id',
  wrap(async (req, res) => {
    const page = await AdPage.findById(req.params.id).select('slug').lean();
    if (!page) throw new ApiError(404, 404, '不存在');
    const base = config.adPageBaseUrl || `${req.protocol}://${req.get('host')}`;
    ok(res, { url: `${base}/p/${page.slug}` });
  })
);

// 广告统计：按素材/日期区间
router.get(
  '/stats',
  wrap(async (req, res) => {
    const { contentId, sponsorId, start, end } = req.query;
    const cond = {};
    if (contentId) cond.contentId = new mongoose.Types.ObjectId(contentId);
    if (sponsorId) cond.sponsorId = new mongoose.Types.ObjectId(sponsorId);
    if (start || end) {
      cond.date = {};
      if (start) cond.date.$gte = start;
      if (end) cond.date.$lte = end;
    }
    const byType = await AdStat.aggregate([
      { $match: cond },
      { $group: { _id: '$type', count: { $sum: 1 } } },
    ]);
    const byDate = await AdStat.aggregate([
      { $match: cond },
      { $group: { _id: { date: '$date', type: '$type' }, count: { $sum: 1 } } },
      { $group: { _id: '$_id.date', pv: { $sum: { $cond: [{ $eq: ['$_id.type', 'pv'] }, '$count', 0] } }, click: { $sum: { $cond: [{ $eq: ['$_id.type', 'click'] }, '$count', 0] } } } },
      { $sort: { _id: 1 } },
      { $limit: 62 },
    ]);
    const totals = { pv: 0, click: 0 };
    for (const row of byType) totals[row._id] = row.count;
    ok(res, { totals, byDate });
  })
);

module.exports = router;
