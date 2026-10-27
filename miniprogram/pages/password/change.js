const auth = require('../../utils/request');

Page({
  data: {
    first: false, // 首次登录强制改密
    isDemo: false, // 示例账号：显示「暂不修改」，真实账号不显示（服务端同样拒绝跳过）
    loading: true, // 身份确认中，避免首帧就把「暂不修改」闪出来
    oldPassword: '',
    newPassword: '',
    confirmPassword: '',
    submitting: false,
  },

  onLoad(options) {
    // 未登录 / 已退出：统一跳登录页，不展示改密表单
    if (!getApp().requireLogin()) return;
    this.setData({ first: options.first === '1' });
    this.checkDemo();
  },

  // 读一次身份，确认是不是示例账号。
  // 这里有意的取舍：跳过按钮**只在确认 isDemo 之后**才渲染（fail-closed）——
  // 读不到身份就当真实账号处理，宁可少一个按钮，也不能让真实账号看到「跳过改密」。
  async checkDemo() {
    try {
      const me = await auth.get('/api/auth/me');
      this.setData({ isDemo: !!(me && me.isDemo), loading: false });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  // 示例账号：跳过改密，直接进首页。
  // 服务端记 passwordChangeSkipped=true，之后登录不再反复弹改密页。
  async skip() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      await auth.post('/api/auth/password/skip', {});
      wx.switchTab({ url: '/pages/home/home' });
    } catch (e) {
      // 服务端拒绝（例如身份其实不是示例账号）→ 按钮不该出现，提示后留在本页
      wx.showToast({ title: e.message || '无法跳过', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  inputOld(e) {
    this.setData({ oldPassword: e.detail.value });
  },

  inputNew(e) {
    this.setData({ newPassword: e.detail.value });
  },

  inputConfirm(e) {
    this.setData({ confirmPassword: e.detail.value });
  },

  async submit() {
    const { oldPassword, newPassword, confirmPassword, submitting } = this.data;
    if (submitting) return;
    if (!oldPassword) {
      wx.showToast({ title: '请输入旧密码', icon: 'none' });
      return;
    }
    if (newPassword.length < 6 || newPassword.length > 20) {
      wx.showToast({ title: '新密码需为 6-20 位', icon: 'none' });
      return;
    }
    if (newPassword !== confirmPassword) {
      wx.showToast({ title: '两次输入的新密码不一致', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      await auth.post('/api/auth/password/change', { oldPassword, newPassword });
      wx.showModal({
        title: '密码已修改',
        content: '请牢记新密码',
        showCancel: false,
        success: () => {
          wx.switchTab({ url: '/pages/home/home' });
        },
      });
    } catch (e) {
      wx.showToast({ title: e.message || '修改失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
