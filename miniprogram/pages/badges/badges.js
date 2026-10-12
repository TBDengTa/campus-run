const auth = require('../../utils/request');

Page({
  data: {
    loading: true,
    list: [],
    earnedCount: 0,
    total: 0,
  },

  onShow() {
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const data = await auth.get('/api/badges');
      this.setData({
        loading: false,
        list: data.list,
        earnedCount: data.earnedCount,
        total: data.total,
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
});
