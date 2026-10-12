const auth = require('../../utils/request');

Page({
  data: {
    url: '',
    title: '',
  },

  onLoad(options) {
    const url = decodeURIComponent(options.url || '');
    const title = options.title ? decodeURIComponent(options.title) : '';
    this.setData({ url, title });
    if (title) wx.setNavigationBarTitle({ title });
  },

  // web-view 加载出错时的兜底提示
  onError() {
    wx.showToast({ title: '页面加载失败，请确认域名已配置', icon: 'none' });
  },
});
