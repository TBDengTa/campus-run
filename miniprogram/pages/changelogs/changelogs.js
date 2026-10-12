const auth = require('../../utils/request');

Page({
  data: {
    loading: true,
    list: [],
  },

  onShow() {
    this.load();
  },

  async load() {
    try {
      const list = await auth.get('/api/content/changelogs');
      this.setData({ loading: false, list });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
});
