const auth = require('../../utils/request');
const fmt = require('../../utils/format');

Page({
  data: {
    overview: null,
    trend: [],
    trendPeakText: '0',
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
        // 展示用预格式化字段（仅用于排版展示，不影响业务数据）
        overview: {
          ...overview,
          totalUsersText: fmt.formatNumber(overview.totalUsers),
          activeTodayText: fmt.formatNumber(overview.activeToday),
          newUsersTodayText: fmt.formatNumber(overview.newUsersToday),
          stepsTodayText: fmt.formatNumber(overview.stepsToday),
          adPvTodayText: fmt.formatNumber(overview.adPvToday),
          adClickTodayText: fmt.formatNumber(overview.adClickToday),
          pendingAppealsText: fmt.formatNumber(overview.pendingAppeals),
          bannedUsersText: fmt.formatNumber(overview.bannedUsers),
        },
        trend: trend.map((t) => ({
          ...t,
          label: t.date.slice(5),
          activeText: fmt.formatNumber(t.activeUsers),
          maxActive: 0,
        })),
      });
      // 归一化趋势柱高
      const maxActive = Math.max(1, ...this.data.trend.map((t) => t.activeUsers));
      const peak = Math.max(0, ...this.data.trend.map((t) => t.activeUsers));
      this.setData({
        trend: this.data.trend.map((t) => ({
          ...t,
          barHeight: Math.max(4, Math.round((t.activeUsers / maxActive) * 120)),
        })),
        trendPeakText: fmt.formatNumber(peak),
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
