// 开屏广告页（小程序首屏）：全屏展示广告素材，5 秒倒计时自动关闭，左上角可跳过
//
//   素材来源：广告位 key = startup_banner（管理端「广告位 → 启动页/开屏」，独占位，只出权重最高 1 条）
//   展示时长：COUNTDOWN 秒（默认 5s），倒计时结束或点「跳过」→ switchTab 首页
//   无素材 / 图片加载失败 / 接口异常：直接进首页，不阻塞启动
//   点击素材：上报点击后跳转外链或落地页；从落地页返回时直接进首页（不再倒计时）
const auth = require('../../utils/request');
const { env } = require('../../utils/request');

const SLOT_KEY = 'startup_banner'; // 启动页广告位（即开屏）
const COUNTDOWN = 5; // 展示秒数
const LOAD_TIMEOUT = 2500; // 图片加载兜底：超时直接进首页，避免卡在空屏

Page({
  data: {
    ad: null,
    show: false, // 图片加载完成、开始倒计时后才显示跳过按钮与「广告」标识
    remain: COUNTDOWN,
    skipText: `${COUNTDOWN}s 跳过`,
    // 跳过按钮用 px 定位（状态栏 + 胶囊实测值算出来），避免压到状态栏
    skipTop: 0,
    skipHeight: 32,
    flagTop: 0,
  },

  onLoad() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不展示开屏
    if (!getApp().requireLogin()) return;
    // 单页栈的非 tabBar 页会被微信加上「返回首页」按钮，开屏页必须隐藏
    if (typeof wx.hideHomeButton === 'function') wx.hideHomeButton({ fail: () => {} });
    this.setNavMetrics();
    this.loadAd();
  },

  // 跳过按钮与右上角胶囊「同高 + 垂直对齐」（贴左边），彻底避开状态栏：
  //   env(safe-area-inset-top) 在模拟器/多数安卓上是 0，单靠它会把按钮顶进状态栏
  setNavMetrics() {
    let statusBarHeight = 20;
    let capsule = null;
    try {
      const win = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
      statusBarHeight = (win && win.statusBarHeight) || 20;
    } catch (e) {
      /* 取不到就用兜底值 */
    }
    try {
      capsule = typeof wx.getMenuButtonBoundingClientRect === 'function' ? wx.getMenuButtonBoundingClientRect() : null;
    } catch (e) {
      capsule = null;
    }
    const skipHeight = (capsule && capsule.height) || 32;
    const skipTop = (capsule && capsule.top) || statusBarHeight + 4;
    this.setData({ skipTop, skipHeight, flagTop: skipTop + skipHeight + 8 });
  },

  onShow() {
    // 从广告落地页返回 → 结束开屏，进入首页
    if (this.leftForAd) this.goHome();
  },

  onUnload() {
    this.stopCountdown();
  },

  async loadAd() {
    try {
      await getApp().ensureLogin();
      const list = await auth.get(`/api/ads/slot/${SLOT_KEY}`).catch(() => []);
      const ad = (list || []).find((a) => a && a.imageUrl);
      if (!ad) return this.goHome(); // 没有开屏素材：直接进首页
      this.setData({ ad });
      auth.post(`/api/ads/${ad._id}/pv`).catch(() => {});
      this.timeoutTimer = setTimeout(() => {
        if (!this.started) this.goHome();
      }, LOAD_TIMEOUT);
    } catch (e) {
      this.goHome();
    }
  },

  onImgLoad() {
    if (this.started) return;
    this.started = true;
    clearTimeout(this.timeoutTimer);
    this.setData({ show: true, remain: COUNTDOWN, skipText: `${COUNTDOWN}s 跳过` });
    this.startCountdown();
  },

  // 素材域名未配置 / 图片加载失败：不展示开屏，直接进首页
  onImgError() {
    this.goHome();
  },

  startCountdown() {
    this.stopCountdown();
    let remain = COUNTDOWN;
    this.timer = setInterval(() => {
      remain -= 1;
      if (remain <= 0) {
        this.goHome();
        return;
      }
      this.setData({ remain, skipText: `${remain}s 跳过` });
    }, 1000);
  },

  stopCountdown() {
    clearTimeout(this.timeoutTimer);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  skip() {
    this.goHome();
  },

  async onAdTap() {
    const { ad } = this.data;
    if (!ad || this.opening) return;
    this.opening = true;
    this.stopCountdown(); // 进了落地页就不再倒计时（返回时直接进首页）
    try {
      const res = await auth.post(`/api/ads/${ad._id}/click`);
      const url = this.targetUrl(res);
      if (url) {
        this.leftForAd = true;
        wx.navigateTo({ url });
        return;
      }
    } catch (e) {
      // 上报失败也照常进首页
    }
    this.goHome();
  },

  targetUrl(res) {
    if (!res) return '';
    if (res.linkType === 'web' && res.linkUrl) {
      return `/pages/webview/webview?url=${encodeURIComponent(res.linkUrl)}`;
    }
    if (res.linkType === 'page' && res.pageSlug) {
      const base = env.AD_PAGE_BASE_URL || env.BASE_URL;
      return `/pages/webview/webview?url=${encodeURIComponent(`${base}/p/${res.pageSlug}`)}`;
    }
    return '';
  },

  goHome() {
    if (this.gone) return;
    this.gone = true;
    this.stopCountdown();
    wx.switchTab({ url: '/pages/home/home', fail: () => wx.reLaunch({ url: '/pages/home/home' }) });
  },
});
