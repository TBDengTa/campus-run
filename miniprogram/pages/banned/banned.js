const auth = require('../../utils/request');

// 解封时间展示：空 = 永久
function fmtTime(v) {
  return v ? String(v).slice(0, 16).replace('T', ' ') : '';
}

Page({
  data: {
    user: null,
    loading: true,
    untilText: '',
  },

  onShow() {
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const user = await auth.get('/api/auth/me');
      this.setData({ user, untilText: fmtTime(user.bannedUntil), loading: false });
    } catch (e) {
      const user = getApp().globalData.userInfo;
      this.setData({ user, untilText: fmtTime(user && user.bannedUntil), loading: false });
    }
  },

  goSubmit() {
    wx.navigateTo({ url: '/pages/appeal/submit?scope=login' });
  },

  goList() {
    wx.navigateTo({ url: '/pages/appeal/list' });
  },

  async refreshStatus() {
    try {
      const user = await getApp().refreshUser();
      if (user.status !== 'banned') {
        wx.showToast({ title: '已解除封禁', icon: 'success' });
        setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 1000);
      } else {
        this.setData({ user });
        wx.showToast({ title: '仍在封禁中', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
});
