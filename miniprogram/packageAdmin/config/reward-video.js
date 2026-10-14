const section = require('./section');

Page({
  sectionKeys: ['rewardVideo'],

  data: {
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

  onReward(e) {
    const { field } = e.currentTarget.dataset;
    const value = e.detail.value;
    this.setData({ [`config.rewardVideo.${field}`]: typeof value === 'boolean' ? value : Number(value) || 0 });
  },
});
