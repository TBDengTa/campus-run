const auth = require('../../utils/request');

Page({
  data: {
    id: '',
    user: null,
    bans: [],
    loading: true,
  },

  onLoad(options) {
    this.setData({ id: options.id || '' });
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const { user, bans } = await auth.get(`/api/admin/users/${this.data.id}`);
      this.setData({
        loading: false,
        user: {
          ...user,
          createdText: (user.createdAt || '').slice(0, 16).replace('T', ' '),
          bannedUntilText: user.bannedUntil ? user.bannedUntil.slice(0, 16).replace('T', ' ') : '',
        },
        bans: bans.map((b) => ({
          ...b,
          timeText: (b.createdAt || '').slice(0, 16).replace('T', ' '),
        })),
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  ban() {
    const that = this;
    wx.showModal({
      title: '封禁该用户',
      editable: true,
      placeholderText: '封禁原因',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.post(`/api/admin/users/${that.data.id}/ban`, { reason: res.content || '违反社区规范', days: 7 });
          wx.showToast({ title: '已封禁 7 天', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },

  unban() {
    const that = this;
    wx.showModal({
      title: '解封该用户',
      content: '确认解除封禁？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.post(`/api/admin/users/${that.data.id}/unban`);
          wx.showToast({ title: '已解封', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },
});
