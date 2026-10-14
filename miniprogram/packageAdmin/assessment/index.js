const auth = require('../../utils/request');

// 运动考核分类中枢：默认目标 / 计划目标
Page({
  data: {
    cats: [],
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
      if (!user.isManager || (!perms.includes('assessment.view') && !perms.includes('*'))) {
        wx.showModal({
          title: '无权限',
          content: '该功能仅限持有运动考核权限的教师/管理员使用',
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

  async load() {
    try {
      const [defaults, plans] = await Promise.all([
        auth.get('/api/admin/assessment/defaults'),
        auth.get('/api/admin/assessment/plans'),
      ]);
      const enabledCount = plans.filter((p) => p.enabled).length;
      const defaultPlan = plans.find((p) => p.isDefault);
      this.setData({
        loading: false,
        cats: [
          {
            key: 'goals',
            icon: 'flag',
            title: '默认目标',
            desc: `每日 ${defaults.daily.steps} 步 · 每周 ${defaults.weekly.steps} 步`,
            url: '/packageAdmin/assessment/goals',
          },
          {
            key: 'plans',
            icon: 'view-list',
            title: '计划目标',
            desc: `${enabledCount} 个启用计划${defaultPlan ? ` · 默认「${defaultPlan.name}」` : ' · 未设默认计划'}`,
            url: '/packageAdmin/assessment/plans',
          },
        ],
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
