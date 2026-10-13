const auth = require('../../utils/request');
const fmt = require('../../utils/format');

const METRICS = [
  { key: 'steps', label: '步数', icon: 'footprints' },
  { key: 'goal', label: '达标', icon: 'check-circle' },
  { key: 'water', label: '饮水', icon: 'drink' },
  { key: 'badge', label: '成就', icon: 'medal' },
];
const RANGES = [
  { key: 'today', label: '今日' },
  { key: 'week', label: '本周' },
  { key: 'total', label: '总榜' },
];

Page({
  data: {
    metrics: METRICS,
    ranges: RANGES,
    metric: 'steps',
    range: 'today',
    scope: 'all',
    scopes: [],
    rank: null,
    loading: false,
    error: '',
  },

  onShow() {
    this.syncTabBar();
    this.load();
  },

  syncTabBar() {
    if (typeof this.getTabBar !== 'function') return;
    const bar = this.getTabBar();
    if (bar && typeof bar.setActive === 'function') bar.setActive('/pages/ranking/ranking');
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    try {
      await getApp().ensureLogin();
      const { metric, range, scope } = this.data;
      const data = await auth.get('/api/ranking', { metric, range, scope });
      const list = (data.list || []).map((r) => ({
        ...r,
        nameText: r.isMe ? r.name + '（我）' : r.name,
        medal: r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : '',
        stepsText: fmt.formatNumber(r.steps || 0),
        valueText: fmt.formatNumber(r.value || 0),
      }));
      this.setData({
        rank: {
          ...data,
          list,
          me: { ...data.me, stepsText: fmt.formatNumber(data.me.steps || 0) },
        },
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false, error: e.message || '加载失败' });
    }
  },

  pickMetric(e) {
    const metric = e.currentTarget.dataset.key;
    if (metric !== this.data.metric) {
      this.setData({ metric });
      this.load();
    }
  },

  pickRange(e) {
    const range = e.currentTarget.dataset.key;
    if (range !== this.data.range) {
      this.setData({ range });
      this.load();
    }
  },

  pickScope(e) {
    const { key, available } = e.currentTarget.dataset;
    if (!available) {
      wx.showToast({ title: '请先完成学生认证', icon: 'none' });
      return;
    }
    if (key !== this.data.scope) {
      this.setData({ scope: key });
      this.load();
    }
  },

  goPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy' });
  },

  goRun() {
    wx.switchTab({ url: '/pages/run/index' });
  },
});
