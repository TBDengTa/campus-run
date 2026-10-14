const auth = require('../../utils/request');

Page({
  data: {
    config: null,
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
      if (!user.isManager || (!perms.includes('config.view') && !perms.includes('*'))) {
        wx.showModal({
          title: '无权限',
          content: '该功能仅限持有配置权限的教师/管理员使用',
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
      const config = await auth.get('/api/admin/config');
      this.setData({ config, cats: this.catsOf(config), loading: false });
    } catch (e) {
      this.setData({ loading: false });
      if (e.code === 403002) {
        wx.showModal({ title: '无权限', content: '该功能仅管理员可用', showCancel: false });
        return;
      }
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  catsOf(config) {
    return [
      {
        key: 'anticheat',
        icon: 'secured',
        title: '反作弊',
        desc: config.anticheat.enabled ? '已启用自动检测' : '已停用',
        url: '/packageAdmin/config/anticheat',
      },
      {
        key: 'rewardVideo',
        icon: 'play-circle',
        title: '激励视频赚步数',
        desc: config.rewardVideo.enabled ? `每日上限 ${config.rewardVideo.dailyLimit} 次` : '已停用',
        url: '/packageAdmin/config/reward-video',
      },
      {
        key: 'points',
        icon: 'chart-bubble',
        title: '跑分设置',
        desc: config.points && config.points.enabled ? `日目标 +${config.points.dailyGoal} 分 / 周目标 +${config.points.weeklyGoal} 分` : '已停用',
        url: '/packageAdmin/config/points',
      },
    ];
  },

  go(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url });
  },
});
