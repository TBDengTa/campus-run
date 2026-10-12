const auth = require('./utils/request');

App({
  globalData: {
    userInfo: null,
    // 今日数据缓存（首页/日历页共享）
    today: null,
  },

  onLaunch() {
    this.ensureLogin().catch((e) => {
      // 未绑定/待改密的跳转已在 ensureLogin 内处理
      if (e.code !== 403003 && e.code !== 403004) {
        console.warn('[app] 静默登录失败（未配置后端或网络异常）:', e.message);
      }
    });
  },

  // 确保已登录：有 token 直接用；无 token 静默登录；未绑定账号 → 登录页
  async ensureLogin() {
    if (auth.getToken()) {
      if (!this.globalData.userInfo) {
        this.globalData.userInfo = auth.getUser();
      }
      return this.globalData.userInfo;
    }
    const data = await auth.login();
    this.globalData.userInfo = data.userInfo;
    if (data.bound === false) {
      const err = new Error('请先登录账号');
      err.code = 403003;
      wx.reLaunch({ url: '/pages/auth-login/auth-login' });
      throw err;
    }
    if (data.mustChangePassword) {
      const err = new Error('请先修改密码');
      err.code = 403004;
      wx.reLaunch({ url: '/pages/password/change?first=1' });
      throw err;
    }
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
