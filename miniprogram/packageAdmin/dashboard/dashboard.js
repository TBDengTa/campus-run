const auth = require('../../utils/request');
const fmt = require('../../utils/format');

Page({
  data: {
    overview: null,
    trend: [],
    days: 14,
    loading: true,
  },

  onShow() {
    this.checkAndLoad();
  },

  async checkAndLoad() {
    try {
      await getApp().ensureLogin();
      const user = await getApp().refreshUser();
      const perms = user.effectivePermissions || [];
      if (!user.isManager || (!perms.includes('dashboard.view') && !perms.includes('*'))) {
        wx.showModal({
          title: '无权限',
          content: '该功能仅限持有看板权限的教师/管理员使用',
          showCancel: false,
          success: () => wx.switchTab({ url: '/pages/home/home' }),
        });
        return;
      }
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
      const [overview, trend] = await Promise.all([
        auth.get('/api/admin/dashboard/overview'),
        auth.get('/api/admin/dashboard/trend', { days: this.data.days }),
      ]);
      this.setData({
        loading: false,
        overview: {
          ...overview,
          stepsTodayText: fmt.formatNumber(overview.stepsToday),
        },
        trend: trend.map((t) => ({
          ...t,
          label: t.date.slice(5),
          maxActive: 0,
        })),
      });
      // 归一化趋势柱高
      const maxActive = Math.max(1, ...this.data.trend.map((t) => t.activeUsers));
      this.setData({
        trend: this.data.trend.map((t) => ({
          ...t,
          barHeight: Math.max(4, Math.round((t.activeUsers / maxActive) * 120)),
        })),
      });
    } catch (e) {
      this.setData({ loading: false });
      if (e.code === 403002) {
        wx.showModal({ title: '无权限', content: '该功能仅管理员可用', showCancel: false });
        return;
      }
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  go(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url });
  },
});
