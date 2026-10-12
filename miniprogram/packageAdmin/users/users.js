const auth = require('../../utils/request');

Page({
  data: {
    keyword: '',
    status: '',
    page: 1,
    limit: 20,
    total: 0,
    list: [],
    loading: false,
    loadingMore: false,
  },

  onShow() {
    this.reload();
  },

  async reload() {
    this.setData({ page: 1, list: [] });
    this.load();
  },

  async load() {
    const { page, limit, keyword, status, loading } = this.data;
    if (loading) return;
    this.setData({ loading: page === 1, loadingMore: page > 1 });
    try {
      await getApp().ensureLogin();
      const params = { page, limit };
      if (keyword) params.keyword = keyword;
      if (status) params.status = status;
      const res = await auth.get('/api/admin/users', params);
      this.setData({
        list: [...this.data.list, ...res.list],
        total: res.total,
      });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false, loadingMore: false });
    }
  },

  onReachBottom() {
    if (this.data.list.length < this.data.total) {
      this.setData({ page: this.data.page + 1 });
      this.load();
    }
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value || '' });
    this.reload();
  },

  onClear() {
    this.setData({ keyword: '' });
    this.reload();
  },

  filterStatus(e) {
    const status = e.currentTarget.dataset.status;
    this.setData({ status: this.data.status === status ? '' : status });
    this.reload();
  },

  openDetail(e) {
    wx.navigateTo({ url: `/packageAdmin/user-detail/user-detail?id=${e.currentTarget.dataset.id}` });
  },

  async quickBan(e) {
    const { id, nickname } = e.currentTarget.dataset;
    const that = this;
    wx.showModal({
      title: `封禁 ${nickname || '用户'}`,
      editable: true,
      placeholderText: '封禁原因',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.post(`/api/admin/users/${id}/ban`, { reason: res.content || '违反社区规范', days: 7 });
          wx.showToast({ title: '已封禁 7 天', icon: 'success' });
          that.reload();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },

  async quickUnban(e) {
    const { id } = e.currentTarget.dataset;
    try {
      await auth.post(`/api/admin/users/${id}/unban`);
      wx.showToast({ title: '已解封', icon: 'success' });
      this.reload();
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' });
    }
  },
});
