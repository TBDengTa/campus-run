const auth = require('../../utils/request');

Page({
  data: {
    user: null,
    loading: true,
  },

  onShow() {
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const user = await auth.get('/api/auth/me');
      this.setData({ user, loading: false });
    } catch (e) {
      this.setData({ user: getApp().globalData.userInfo, loading: false });
    }
  },

  goSubmit() {
    wx.navigateTo({ url: '/pages/appeal/submit' });
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
