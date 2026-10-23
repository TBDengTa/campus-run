// 通用广告卡（记录页卡片位 / 排行榜卡片位共用）
//
// 用法（父页面）：
//   1) 页面 json 里注册： "ad-card": "/components/ad-card/ad-card"
//   2) wxml 放一行： <ad-card slot-key="record_card" refresh-at="{{adRefreshAt}}" />
//   3) 页面 onShow 里 this.setData({ adRefreshAt: Date.now() }) 即刷新素材
//
// 行为：该广告位没有可下发素材时整块不渲染（不会留空卡片）；
//       曝光自动上报 PV，点击上报并跳转（外链 / 落地页），与首页轮播同一套口径。
const auth = require('../../utils/request');
const { env } = require('../../utils/request');

Component({
  properties: {
    slotKey: { type: String, value: '' },
    // 父页面把它改成新值即重新拉取（页面 onShow 刷新时最方便）
    refreshAt: {
      type: Number,
      value: 0,
      observer() {
        if (this.data.loaded) this.load();
      },
    },
  },

  data: {
    ads: [],
    height: 250, // 卡片高度（rpx），按图片真实比例算得，保证整张图完整显示
    loaded: false,
  },

  lifetimes: {
    attached() {
      this.load();
    },
    detached() {
      this.loaded = false;
    },
  },

  methods: {
    async load() {
      const { slotKey } = this.data;
      if (!slotKey) return;
      try {
        await getApp().ensureLogin();
        const list = await auth.get(`/api/ads/slot/${slotKey}`).catch(() => []);
        const ads = (list || []).filter((a) => a && a.imageUrl);
        this.setData({ ads, loaded: true });
        // 曝光 PV 上报（与首页轮播一致）
        ads.forEach((ad) => {
          auth.post(`/api/ads/${ad._id}/pv`).catch(() => {});
        });
        this.measureHeight(ads);
      } catch (e) {
        // 接口不可用 / 未登录：整块不渲染，不打扰页面
        this.setData({ ads: [], loaded: true });
      }
    },

    reload() {
      return this.load();
    },

    // 高度：按图片真实比例换算 rpx（可用宽 702rpx = 750 - 卡片左右各 24rpx），限制 120~420rpx
    async measureHeight(list) {
      const items = (list || []).filter((a) => a && a.imageUrl);
      if (!items.length) return;
      const infos = await Promise.all(
        items.map(
          (a) =>
            new Promise((resolve) => {
              wx.getImageInfo({ src: a.imageUrl, success: resolve, fail: () => resolve(null) });
            })
        )
      );
      let max = 0;
      for (const info of infos) {
        if (!info || !info.width || !info.height) continue;
        max = Math.max(max, Math.round((702 * info.height) / info.width));
      }
      // 探测失败（如未配置下载域名）时保持兜底高度，配合 aspectFit 仍能完整显示
      if (!max) return;
      const height = Math.max(120, Math.min(420, max));
      if (height !== this.data.height) this.setData({ height });
    },

    // 素材解码失败（如老 iOS 不支持 WebP / 域名被拦）：摘掉这一条，避免留一张空白卡片
    onImgError(e) {
      const index = Number(e.currentTarget.dataset.index);
      const ads = (this.data.ads || []).filter((_, i) => i !== index);
      this.setData({ ads });
    },

    // 点击：上报后按跳转类型去外链 / 落地页
    async onTap(e) {
      const ad = this.data.ads[e.currentTarget.dataset.index];
      if (!ad) return;
      try {
        const res = await auth.post(`/api/ads/${ad._id}/click`);
        if (res.linkType === 'web' && res.linkUrl) {
          wx.navigateTo({ url: `/pages/webview/webview?url=${encodeURIComponent(res.linkUrl)}` });
        } else if (res.linkType === 'page' && res.pageSlug) {
          wx.navigateTo({
            url: `/pages/webview/webview?url=${encodeURIComponent(`${env.AD_PAGE_BASE_URL || env.BASE_URL}/p/${res.pageSlug}`)}`,
          });
        }
      } catch (err) {
        wx.showToast({ title: err.message || '打开失败', icon: 'none' });
      }
    },
  },
});
