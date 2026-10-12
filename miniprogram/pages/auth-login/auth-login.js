const auth = require('../../utils/request');

Page({
  data: {
    account: '',
    password: '',
    submitting: false,
    devRoles: null, // DEV 模式下的快速角色切换
  },

  onLoad() {
    const { env } = auth;
    if (env.DEV_LOGIN) {
      this.setData({ devRoles: ['dev-student', 'dev-teacher', 'dev-admin'] });
    }
  },

  inputAccount(e) {
    this.setData({ account: e.detail.value });
  },

  inputPassword(e) {
    this.setData({ password: e.detail.value });
  },

  async submit() {
    const { account, password, submitting } = this.data;
    if (submitting) return;
    if (!account.trim() || !password) {
      wx.showToast({ title: '请输入姓名和密码', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      // 无 token（如退出登录后进入）先换取游客 token；已绑定用户会直接拿到正式 token
      if (!auth.getToken()) {
        const loginResult = await auth.login();
        if (loginResult.bound !== false) {
          this.afterLogin(loginResult);
          return;
        }
      }
      const result = await auth.bindAccount(account.trim(), password);
      wx.showToast({ title: '登录成功', icon: 'success' });
      this.afterLogin(result);
    } catch (e) {
      if (e.code === 429) {
        wx.showModal({ title: '账号已锁定', content: e.message, showCancel: false });
      } else {
        wx.showToast({ title: e.message || '登录失败', icon: 'none' });
      }
    } finally {
      this.setData({ submitting: false });
    }
  },

  // 登录成功后的分流：强制改密 → 改密页；否则回首页
  afterLogin(result) {
    if (result.mustChangePassword) {
      wx.reLaunch({ url: '/pages/password/change?first=1' });
    } else {
      wx.switchTab({ url: '/pages/home/home' });
    }
  },

  // DEV：快速角色登录（切换 env.DEV_ROLE 后按新角色静默登录）
  devLogin(e) {
    const { env } = auth;
    const role = e.currentTarget.dataset.role;
    env.DEV_ROLE = role;
    auth.logout();
    wx.showToast({ title: `已切换 ${role.replace('dev-', '')}，重新登录中`, icon: 'none' });
    setTimeout(async () => {
      try {
        const result = await auth.login();
        this.afterLogin(result);
      } catch (err) {
        wx.showToast({ title: err.message, icon: 'none' });
      }
    }, 600);
  },
});
