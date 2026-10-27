const section = require('./section');

Page({
  // 步数异常记录（用户 2026-10-27）：可疑但未自动封禁的记录查看 + 手动封禁
  goAnomalies() {
    wx.navigateTo({ url: '/packageAdmin/config/anomalies/anomalies' });
  },

  sectionKeys: ['anticheat'],

  data: {
    // 写权限（用户 2026-10-22）：由 section.js 在 checkAndLoad 里 setData 注入；
    // 只读用户（仅 config.view）看不到保存按钮、输入框禁用。
    canManage: false,
    config: null,
    saving: false,
    loading: true,
  },

  onShow() {
    section.onShow(this);
  },

  checkAndLoad() {
    return section.checkAndLoad(this);
  },

  save() {
    return section.save(this);
  },

  onAnticheat(e) {
    const { field } = e.currentTarget.dataset;
    const value = e.detail.value;
    this.setData({ [`config.anticheat.${field}`]: typeof value === 'boolean' ? value : Number(value) || 0 });
  },
});
