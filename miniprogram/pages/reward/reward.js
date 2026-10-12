const auth = require('../../utils/request');

// 小程序激励视频广告位 ID（流量主后台创建后填入，此处为占位）
const AD_UNIT_ID = 'adunit-placeholder';

Page({
  data: {
    loading: true,
    enabled: true,
    watchCount: 0,
    stepsEarned: 0,
    remaining: 0,
    limit: 0,
    stepsPerWatch: 0,
    rewarded: null, // 刚看完一次的结果
  },

  onShow() {
    this.load();
  },

  onLoad() {
    this.videoAd = null;
    if (wx.createRewardedVideoAd) {
      this.videoAd = wx.createRewardedVideoAd({ adUnitId: AD_UNIT_ID });
      this.videoAd.onError((err) => {
        console.warn('[reward] 广告加载失败', err);
      });
    }
  },

  onUnload() {
    if (this.videoAd) {
      this.videoAd.destroy();
      this.videoAd = null;
    }
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const data = await auth.get('/api/reward-video/today');
      this.setData({
        loading: false,
        enabled: data.enabled,
        watchCount: data.watchCount,
        stepsEarned: data.stepsEarned,
        limit: data.limit,
        stepsPerWatch: data.stepsPerWatch,
        remaining: Math.max(0, data.limit - data.watchCount),
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async watch() {
    if (!this.data.enabled) {
      wx.showToast({ title: '活动暂未开启', icon: 'none' });
      return;
    }
    if (this.data.remaining <= 0) {
      wx.showToast({ title: '今日次数已用完，明天再来吧', icon: 'none' });
      return;
    }
    if (!this.videoAd) {
      wx.showToast({ title: '广告组件暂不可用', icon: 'none' });
      return;
    }
    // 展示广告 → onClose 判断是否完整观看 → 上报
    const reported = await new Promise((resolve) => {
      const handler = (res) => {
        this.videoAd.offClose(handler);
        if ((res && res.isEnded) || res === undefined) {
          resolve(true);
        } else {
          resolve(false); // 中途关闭
        }
      };
      this.videoAd.onClose(handler);
      this.videoAd.show().catch(() => {
        this.videoAd
          .load()
          .then(() => this.videoAd.show())
          .catch(() => {
            this.videoAd.offClose(handler);
            resolve(false);
            wx.showToast({ title: '广告暂时无法播放，稍后再试', icon: 'none' });
          });
      });
    });
    if (!reported) return;
    try {
      const result = await auth.post('/api/reward-video/report');
      if (result.success) {
        this.setData({
          watchCount: result.watchCount,
          stepsEarned: result.stepsEarned,
          remaining: result.remaining,
          rewarded: { steps: result.stepsAwarded, badges: result.newBadges || [] },
        });
        wx.showToast({ title: `+${result.stepsAwarded} 步`, icon: 'success' });
      } else {
        wx.showToast({ title: result.message || '上报失败', icon: 'none' });
        this.load();
      }
    } catch (e) {
      if (e.code === 403001) {
        wx.navigateTo({ url: '/pages/banned/banned' });
        return;
      }
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
});
