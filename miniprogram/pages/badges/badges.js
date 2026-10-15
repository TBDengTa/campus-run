const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// 徽章阈值单位（仅用于展示）
const UNIT_MAP = {
  total_distance: 'm',
  single_distance: 'm',
  total_steps: '步',
  single_steps: '步',
};

Page({
  data: {
    loading: true,
    list: [],
    earnedCount: 0,
    total: 0,
    percent: 0,
  },

  onShow() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const data = await auth.get('/api/badges');
      const total = Number(data.total) || 0;
      const earnedCount = Number(data.earnedCount) || 0;
      const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((earnedCount / total) * 100))) : 0;
      const unitOf = (type) => UNIT_MAP[type] || '天';
      this.setData({
        loading: false,
        // 仅补充展示用字段，接口数据原样保留（progress / nextTarget / percent 来自服务端）
        list: (data.list || []).map((b) => ({
          ...b,
          targetText: `${fmt.formatNumber(b.target)}${unitOf(b.type)}`,
          nextText: b.nextTarget ? `${fmt.formatNumber(b.nextTarget)}${unitOf(b.type)}` : '',
        })),
        earnedCount,
        total,
        percent,
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
});
