const auth = require('../../utils/request');

const STATUS = {
  pending: { text: '待审核', theme: 'warning' },
  approved: { text: '已通过', theme: 'success' },
  rejected: { text: '已驳回', theme: 'danger' },
};

Page({
  data: {
    tab: 'pending',
    list: [],
    loading: false,
  },

  onShow() {
    this.reload();
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
    this.reload();
  },

  reload() {
    this.setData({ list: [] });
    this.load();
  },

  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      const res = await auth.get('/api/admin/appeals', { status: this.data.tab, limit: 50 });
      this.setData({
        list: res.list.map((a) => ({
          ...a,
          openidShort: (a.openid || '').slice(0, 8),
          statusInfo: STATUS[a.status] || STATUS.pending,
          timeText: (a.createdAt || '').slice(0, 16).replace('T', ' '),
        })),
      });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  review(e) {
    const { id, approve } = e.currentTarget.dataset;
    const that = this;
    wx.showModal({
      title: approve === 'true' ? '通过申诉（将解封）' : '驳回申诉',
      editable: true,
      placeholderText: '回复内容（可空）',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.post(`/api/admin/appeals/${id}/review`, {
            approve: approve === 'true',
            reply: res.content || '',
          });
          wx.showToast({ title: '已处理', icon: 'success' });
          that.reload();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },
});
