const auth = require('../../utils/request');

Page({
  data: {
    content: '',
    contentLength: 0,
    submitting: false,
    user: null,
  },

  onLoad() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    const user = getApp().globalData.userInfo || auth.getUser();
    this.setData({ user, content: user && user.banReason ? '' : '' });
  },

  input(e) {
    const value = e.detail.value;
    this.setData({ content: value, contentLength: (value || '').length });
  },

  async submit() {
    const { content, submitting } = this.data;
    if (submitting) return;
    if (!content || content.trim().length < 10) {
      wx.showToast({ title: '请填写至少 10 字的申诉说明', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      await getApp().ensureLogin();
      await auth.post('/api/appeals', { content: content.trim() });
      wx.showToast({ title: '申诉已提交', icon: 'success' });
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/appeal/list' });
      }, 1200);
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
