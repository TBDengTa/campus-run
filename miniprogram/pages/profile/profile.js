const auth = require('../../utils/request');
const fmt = require('../../utils/format');

Page({
  data: {
    user: null,
    stats: null,
    monitor: null,
    isAdmin: false,
    isTeacher: false,
    canManagePerms: false,
    roleText: '学生',
    banned: false,
  },

  onShow() {
    this.syncTabBar();
    this.refresh();
  },

  // 自定义 tabBar 选中态（教师端导航项与学生不同）
  syncTabBar() {
    if (typeof this.getTabBar !== 'function') return;
    const bar = this.getTabBar();
    if (bar && typeof bar.setActive === 'function') bar.setActive('/pages/profile/profile');
  },

  async refresh() {
    try {
      await getApp().ensureLogin();
      const user = await getApp().refreshUser();
      let banned = false;
      if (user.status === 'banned' && user.bannedUntil && new Date(user.bannedUntil) > new Date()) {
        banned = true;
      }
      const perms = user.effectivePermissions || [];
      const isTeacher = user.role === 'teacher';
      this.setData({
        user,
        isTeacher,
        isAdmin: !!user.isManager,
        canManagePerms: perms.includes('*') || perms.includes('permission.manage'),
        roleText: isTeacher ? '教师' : '学生',
        banned,
        stats: {
          totalSteps: fmt.formatNumber(user.totalSteps || 0),
          totalDistance: fmt.formatDistance(user.totalDistance || 0),
          totalDays: user.totalDays || 0,
        },
      });
      this.syncTabBar();
    } catch (e) {
      if (e.code === 403001) {
        // 封禁用户仍可看基本页
        this.setData({ banned: true, user: getApp().globalData.userInfo });
      } else {
        wx.showToast({ title: e.message || '加载失败', icon: 'none' });
      }
    }
  },

  async chooseAvatar(e) {
    const { avatarUrl } = e.detail;
    this.applyProfile({ avatarUrl });
  },

  async nicknameInput(e) {
    const nickname = (e.detail.value || '').trim();
    if (nickname && nickname !== this.data.user?.nickname) {
      this.applyProfile({ nickname });
    }
  },

  async applyProfile(patch) {
    try {
      const user = await auth.put('/api/auth/profile', patch);
      this.setData({ user });
      getApp().globalData.userInfo = user;
      auth.setUser(user);
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  go(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url });
  },

  goAdmin() {
    wx.navigateTo({ url: '/packageAdmin/dashboard/dashboard' });
  },

  // 权限管理：进用户列表选人（持有 permission.manage 时显示）
  goPerms() {
    wx.navigateTo({ url: '/packageAdmin/users/users?selectForPerms=1' });
  },

  goBanned() {
    wx.navigateTo({ url: '/pages/banned/banned' });
  },

  goChangePwd() {
    wx.navigateTo({ url: '/pages/password/change' });
  },

  // 退出登录：清除本机会话 → 回登录页（已绑定微信的账号重新进入会自动登录）
  logout() {
    wx.showModal({
      title: '退出登录',
      content: '将清除本机登录信息并返回登录页',
      confirmText: '退出',
      confirmColor: '#d54941',
      success: (r) => {
        if (!r.confirm) return;
        auth.logout();
        wx.reLaunch({ url: '/pages/auth-login/auth-login' });
      },
    });
  },
});
