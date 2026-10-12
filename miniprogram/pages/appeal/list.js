const auth = require('../../utils/request');

const STATUS = {
  pending: { text: '待审核', theme: 'warning' },
  approved: { text: '已通过', theme: 'success' },
  rejected: { text: '已驳回', theme: 'danger' },
};

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
      await getApp().ensureLogin();
      const { list } = await auth.get('/api/appeals/mine', { limit: 50 });
      this.setData({
        loading: false,
        list: list.map((a) => ({
          ...a,
          statusInfo: STATUS[a.status] || STATUS.pending,
          dateText: (a.createdAt || '').slice(0, 16).replace('T', ' '),
        })),
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  goSubmit() {
    wx.navigateTo({ url: '/pages/appeal/submit' });
  },
});
