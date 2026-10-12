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
      const list = await auth.get('/api/content/announcements');
      this.setData({
        loading: false,
        list: list.map((a) => ({
          ...a,
          dateText: (a.createdAt || '').slice(0, 10),
        })),
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
});
