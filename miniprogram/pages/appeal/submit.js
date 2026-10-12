const auth = require('../../utils/request');

Page({
  data: {
    content: '',
    contentLength: 0,
    submitting: false,
    user: null,
  },

  onLoad() {
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
