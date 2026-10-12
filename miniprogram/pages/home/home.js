const auth = require('../../utils/request');
const fmt = require('../../utils/format');

Page({
  data: {
    loading: true,
    dateText: '',
    steps: 0,
    goalSteps: 5000,
    percent: 0,
    expectedPercent: 0,
    distance: '0 m',
    calories: 0,
    durationText: '00:00',
    goalAchieved: false,
    goalName: '',
    ads: [],
    announcements: [],
    banned: false,
    isAdmin: false,
    syncing: false,
    rewardVideo: { enabled: true, remaining: 0 },
    // ===== 角色权限 =====
    role: 'student',
    roleText: '学生',
    isManager: false,
    perms: [],
    mgrEntries: [],
    overview: null,
  },

  onLoad() {
    const d = fmt.parseDateKey(fmt.todayKey());
    this.setData({ dateText: `${d.m}月${d.d}日 ${d.week}` });
  },

  onShow() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    try {
      await getApp().ensureLogin();
      const [today, ads, announcements, me] = await Promise.allSettled([
        auth.get('/api/run/today'),
        auth.get('/api/ads/slot/home_banner').catch(() => []),
        auth.get('/api/content/announcements').catch(() => []),
        getApp().refreshUser().catch(() => null),
      ]);
      const user = getApp().globalData.userInfo || {};
      let banned = false;
      if (user.status === 'banned' && user.bannedUntil && new Date(user.bannedUntil) > new Date()) {
        banned = true;
      }
      const isManager = !!user.isManager;
      const perms = user.effectivePermissions || [];
      // 按权限过滤的管理入口（WXML 无法调用方法，这里预计算）
      const allEntries = [
        { key: 'dashboard', perm: 'dashboard.view', icon: 'dashboard', label: '数据看板', url: '/packageAdmin/dashboard/dashboard', bg: 'var(--td-brand-color-1)', color: 'var(--td-brand-color)' },
        { key: 'users', perm: 'user.view', icon: 'user-add', label: '用户管理', url: '/packageAdmin/users/users', bg: 'var(--td-success-color-1)', color: 'var(--td-success-color-5)' },
        { key: 'appeals', perm: 'appeal.view', icon: 'assignment', label: '申诉审核', url: '/packageAdmin/appeals/appeals', bg: 'var(--td-warning-color-1)', color: 'var(--td-warning-color-5)' },
        { key: 'ads', perm: 'ad.view', icon: 'chart-bar', label: '广告管理', url: '/packageAdmin/ads/contents', bg: 'var(--td-error-color-1)', color: 'var(--td-error-color-6)' },
        { key: 'content', perm: 'content.view', icon: 'book', label: '内容管理', url: '/packageAdmin/content/announcements', bg: 'var(--td-gray-color-2)', color: 'var(--td-gray-color-8)' },
        { key: 'config', perm: 'config.view', icon: 'setting', label: '系统配置', url: '/packageAdmin/config/config', bg: 'var(--td-brand-color-light)', color: 'var(--td-brand-color)' },
      ];
      const mgrEntries = allEntries.filter((e) => perms.includes('*') || perms.includes(e.perm));
      this.setData({
        isManager,
        perms,
        mgrEntries,
        role: user.role || 'student',
        roleText: user.role === 'teacher' ? '教师' : '学生',
        isAdmin: isManager,
      });
      this.applyToday(today.status === 'fulfilled' ? today.value : null);
      // 广告曝光 PV 上报
      const adList = today.status === 'fulfilled' && ads.status === 'fulfilled' ? ads.value : [];
      this.setData({ ads: adList, announcements: announcements.status === 'fulfilled' ? announcements.value : [], banned });
      adList.forEach((ad) => {
        auth.post(`/api/ads/${ad._id}/pv`).catch(() => {});
      });
      // 管理视角：拉取看板概览（无 dashboard.view 权限时静默忽略）
      if (isManager) {
        this.loadOverview();
      }
    } catch (e) {
      if (e.code === 403001) {
        wx.navigateTo({ url: '/pages/banned/banned' });
        return;
      }
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadOverview() {
    try {
      const overview = await auth.get('/api/admin/dashboard/overview');
      this.setData({
        overview: { ...overview, stepsTodayText: fmt.formatNumber(overview.stepsToday) },
      });
    } catch (e) {
      // 无 dashboard.view 权限，忽略
    }
  },

  applyToday(data) {
    if (!data) return;
    getApp().globalData.today = data;
    const record = data.record;
    const steps = record?.steps || 0;
    const goal = data.goal;
    this.setData({
      steps,
      goalSteps: goal.daily.steps,
      percent: Math.min(100, Math.round((steps / (goal.daily.steps || 1)) * 100)),
      expectedPercent: data.expectedPercent,
      distance: fmt.formatDistance(record?.distance || 0),
      calories: record?.calories || 0,
      durationText: fmt.formatDuration(record?.durationSeconds || 0),
      goalAchieved: !!record?.goalAchieved,
      goalName: goal.planName || '默认目标',
    });
  },

  // 同步微信运动
  async syncWerun() {
    if (this.data.syncing) return;
    this.setData({ syncing: true });
    wx.showLoading({ title: '同步中…', mask: true });
    try {
      const runData = await new Promise((resolve, reject) => {
        wx.getWeRunData({
          success: resolve,
          fail: (e) => reject(new Error(e.errMsg || '获取微信运动数据失败')),
        });
      });
      const result = await auth.post('/api/run/sync-werun', {
        encryptedData: runData.encryptedData,
        iv: runData.iv,
      });
      wx.hideLoading();
      const earned = (result.newBadges || []).length;
      wx.showToast({
        title: `同步成功${earned ? `，获得${earned}枚新徽章` : ''}`,
        icon: 'success',
      });
      await this.refresh();
    } catch (e) {
      wx.hideLoading();
      if (e.code === 403001) {
        wx.navigateTo({ url: '/pages/banned/banned' });
        return;
      }
      // 授权拒绝 → 引导开启
      if (/auth|deny|denied/i.test(e.cause?.errMsg || e.message || '')) {
        wx.showModal({
          title: '需要微信运动授权',
          content: '请在设置中开启「微信运动」授权后重试',
          confirmText: '去设置',
          success: (r) => {
            if (r.confirm) wx.openSetting();
          },
        });
        return;
      }
      wx.showToast({ title: e.message || '同步失败', icon: 'none' });
    } finally {
      this.setData({ syncing: false });
    }
  },

  goRun() {
    wx.navigateTo({ url: '/pages/run/index' });
  },

  goWater() {
    wx.navigateTo({ url: '/pages/water/water' });
  },

  goReward() {
    wx.navigateTo({ url: '/pages/reward/reward' });
  },

  goBadges() {
    wx.navigateTo({ url: '/pages/badges/badges' });
  },

  goBodyData() {
    wx.navigateTo({ url: '/pages/body-data/body-data' });
  },

  goAnnouncements() {
    wx.navigateTo({ url: '/pages/announcements/announcements' });
  },

  goBanned() {
    wx.navigateTo({ url: '/pages/banned/banned' });
  },

  goAdmin() {
    wx.navigateTo({ url: '/packageAdmin/dashboard/dashboard' });
  },

  // 管理面板入口跳转（url 由权限过滤后的列表带出）
  goAdminPage(e) {
    if (e.currentTarget.dataset.url) {
      wx.navigateTo({ url: e.currentTarget.dataset.url });
    }
  },

  // 广告点击
  async onAdTap(e) {
    const ad = this.data.ads[e.currentTarget.dataset.index];
    if (!ad) return;
    try {
      const res = await auth.post(`/api/ads/${ad._id}/click`);
      if (res.linkType === 'web' && res.linkUrl) {
        wx.navigateTo({ url: `/pages/webview/webview?url=${encodeURIComponent(res.linkUrl)}` });
      } else if (res.linkType === 'page' && res.pageSlug) {
        const { env } = require('../../utils/request');
        wx.navigateTo({
          url: `/pages/webview/webview?url=${encodeURIComponent(`${env.AD_PAGE_BASE_URL || env.BASE_URL}/p/${res.pageSlug}`)}`,
        });
      }
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' });
    }
  },
});
