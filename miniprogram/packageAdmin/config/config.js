const auth = require('../../utils/request');

Page({
  data: {
    config: null,
    saving: false,
  },

  onShow() {
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const config = await auth.get('/api/admin/config');
      this.setData({ config });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  onDaily(e) {
    this.setData({ [`config.daily.${e.currentTarget.dataset.field}`]: Number(e.detail.value) || 0 });
  },

  onWeekly(e) {
    this.setData({ [`config.weekly.${e.currentTarget.dataset.field}`]: Number(e.detail.value) || 0 });
  },

  onAnticheat(e) {
    const { field } = e.currentTarget.dataset;
    const value = e.detail.value;
    this.setData({ [`config.anticheat.${field}`]: typeof value === 'boolean' ? value : Number(value) || 0 });
  },

  onReward(e) {
    const { field } = e.currentTarget.dataset;
    const value = e.detail.value;
    this.setData({ [`config.rewardVideo.${field}`]: typeof value === 'boolean' ? value : Number(value) || 0 });
  },

  onGradedTime(e) {
    const { index } = e.currentTarget.dataset;
    this.setData({ [`config.graded[${index}].time`]: e.detail.value });
  },

  onGradedPercent(e) {
    const { index } = e.currentTarget.dataset;
    this.setData({ [`config.graded[${index}].percent`]: Number(e.detail.value) || 0 });
  },

  addGraded() {
    const graded = this.data.config.graded.concat([{ time: '12:00', percent: 50 }]);
    this.setData({ 'config.graded': graded });
  },

  removeGraded(e) {
    const { index } = e.currentTarget.dataset;
    const graded = this.data.config.graded.filter((_, i) => i !== Number(index));
    this.setData({ 'config.graded': graded });
  },

  async save() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    const { config } = this.data;
    try {
      await auth.put('/api/admin/config', {
        daily: config.daily,
        weekly: config.weekly,
        graded: config.graded,
        anticheat: config.anticheat,
        rewardVideo: config.rewardVideo,
      });
      wx.showToast({ title: '配置已保存', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },
});
