const section = require('./section');

Page({
  sectionKeys: ['rewardVideo'],

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

  // 数值项（步数/距离/卡路里/时长/上限）：留空 = 未配置（服务端按步数换算派生），不写成 0
  onReward(e) {
    const { field } = e.currentTarget.dataset;
    const value = e.detail.value;
    if (typeof value === 'boolean') {
      this.setData({ [`config.rewardVideo.${field}`]: value });
      return;
    }
    const raw = String(value == null ? '' : value).trim();
    const n = Number(raw);
    // 空 / 非数字 → null（服务端按「未配置」处理并按步数换算派生）
    this.setData({ [`config.rewardVideo.${field}`]: raw === '' || !Number.isFinite(n) ? null : n });
  },

  // 文本项（广告位 ID）
  onRewardText(e) {
    const { field } = e.currentTarget.dataset;
    this.setData({ [`config.rewardVideo.${field}`]: e.detail.value });
  },
});
