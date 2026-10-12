const auth = require('../../utils/request');

Page({
  data: {
    first: false, // 首次登录强制改密
    oldPassword: '',
    newPassword: '',
    confirmPassword: '',
    submitting: false,
  },

  onLoad(options) {
    this.setData({ first: options.first === '1' });
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
