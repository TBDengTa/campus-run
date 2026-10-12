const express = require('express');
const { wrap, ok, ApiError } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const adsSvc = require('../services/ads');
const AdPage = require('../models/ad-page');

const router = express.Router();

// 拉取广告位内容（需登录，用于 PV 归因）
router.get(
  '/slot/:key',
  auth,
  wrap(async (req, res) => {
    const ads = await adsSvc.pickAdsForSlot(req.params.key);
    ok(res, ads);
  })
);

// PV 上报
router.post(
  '/:contentId/pv',
  auth,
  wrap(async (req, res) => {
    const content = await adsSvc.reportStat(req.params.contentId, 'pv', req.user.openid);
    if (!content) throw new ApiError(404, 404, '广告不存在');
    ok(res, { success: true });
  })
);

// 点击上报：返回跳转目标（web 外链或落地页 slug）
router.post(
  '/:contentId/click',
  auth,
  wrap(async (req, res) => {
    const content = await adsSvc.reportStat(req.params.contentId, 'click', req.user.openid);
    if (!content) throw new ApiError(404, 404, '广告不存在');
    let pageSlug;
    if (content.linkType === 'page' && content.pageId) {
      const page = await AdPage.findById(content.pageId).select('slug').lean();
      pageSlug = page?.slug;
    }
    ok(res, { success: true, linkType: content.linkType, linkUrl: content.linkUrl, pageSlug });
  })
);

// 落地页元信息（内容走后端 /p/:slug 直出）
router.get(
  '/pages/:slug',
  wrap(async (req, res) => {
    const page = await AdPage.findOne({ slug: req.params.slug, enabled: true }).select('name slug').lean();
    if (!page) throw new ApiError(404, 404, '页面不存在');
    ok(res, page);
  })
);

module.exports = router;
