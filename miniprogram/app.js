const auth = require('./utils/request');

App({
  globalData: {
    userInfo: null,
    // 今日数据缓存（首页/日历页共享）
    today: null,
  },

  onLaunch() {
    this.ensureLogin().catch((e) => {
      console.warn('[app] 静默登录失败（未配置后端或网络异常）:', e.message);
    });
  },

  // 确保已登录（有 token 就直接用，无则静默登录）
  async ensureLogin() {
    if (auth.getToken()) {
      if (!this.globalData.userInfo) {
        this.globalData.userInfo = auth.getUser();
      }
      return this.globalData.userInfo;
    }
    const data = await auth.login();
    this.globalData.userInfo = data.userInfo;
    return data.userInfo;
  },

  // 刷新用户信息
  async refreshUser() {
    const user = await auth.get('/api/auth/me');
    this.globalData.userInfo = user;
    auth.setUser(user);
    return user;
  },
});
