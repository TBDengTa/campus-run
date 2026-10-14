const auth = require('../../utils/request');

// 默认目标（全局单例）：每日 / 每周 步数·距离·千卡
Page({
  data: {
    defaults: null,
    saving: false,
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
      const defaults = await auth.get('/api/admin/assessment/defaults');
      this.setData({ defaults });
    } catch (e) {
      if (e.code === 403002) {
        wx.showModal({ title: '无权限', content: '该功能仅管理员可用', showCancel: false });
        return;
      }
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  onDaily(e) {
    this.setData({ [`defaults.daily.${e.currentTarget.dataset.field}`]: Number(e.detail.value) || 0 });
  },

  onWeekly(e) {
    this.setData({ [`defaults.weekly.${e.currentTarget.dataset.field}`]: Number(e.detail.value) || 0 });
  },

  async save() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    const { defaults } = this.data;
    try {
      await auth.put('/api/admin/assessment/defaults', {
        daily: defaults.daily,
        weekly: defaults.weekly,
      });
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },
});
