const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// 榜单维度：图标必须是 TDesign 图标字体里真实存在的名字（footprints / medal 都不存在，会渲染空白）
const METRICS = [
  { key: 'steps', label: '步数', icon: 'component-steps' },
  { key: 'goal', label: '达标', icon: 'check-circle' },
  { key: 'water', label: '饮水', icon: 'drink' },
  { key: 'badge', label: '成就', icon: 'star' },
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
    // 加载骨架屏的行（放 data 里而不是 WXML 的数组字面量，避免个别基础库不支持 {{[1,2,3]}} 而整页编译失败白屏）
    skeletonRows: [1, 2, 3, 4, 5],
    metric: 'steps',
    range: 'today',
    scope: 'all',
    scopes: [],
    rank: null,
    loading: false,
    error: '',
  },

  onShow() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
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
    // 正在加载时又切换了筛选：记下来，等这次请求结束后自动再拉一次。
    // 不能直接 return —— 否则「点了筛选没反应、列表还是上一次的数据」，看起来像没加载。
    if (this.data.loading) {
      this._pending = true;
      return;
    }
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
    } finally {
      // 期间又切过筛选 → 用最新条件再请求一次
      if (this._pending) {
        this._pending = false;
        this.load();
      }
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
