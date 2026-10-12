const auth = require('../../utils/request');
const fmt = require('../../utils/format');

const RANGES = [
  { key: 'day', label: '今日' },
  { key: 'week', label: '本周' },
  { key: 'total', label: '总榜' },
];

Page({
  data: {
    ranges: RANGES,
    range: 'day',
    scope: 'school',
    rangeText: '今日榜',
    scopeText: '全校',
    scopes: [
      { key: 'school', label: '全校', available: true },
      { key: 'department', label: '本院系', available: false },
      { key: 'class', label: '本班', available: false },
    ],
    top3: [],
    rest: [],
    list: [],
    me: { rank: null, steps: 0, stepsText: '0', distanceText: '0 m', nickname: '我', avatarUrl: '' },
    participants: 0,
    loading: true,
    empty: false,
    excluded: false,
    excludedReason: '',
  },

  onShow() {
    this.syncTabBar();
    this.load();
  },

  // 自定义 tabBar 选中态
  syncTabBar() {
    if (typeof this.getTabBar !== 'function') return;
    const bar = this.getTabBar();
    if (bar && typeof bar.setActive === 'function') bar.setActive('/pages/ranking/ranking');
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  switchRange(e) {
    const range = e.currentTarget.dataset.range;
    if (range === this.data.range) return;
    this.setData({ range, loading: true });
    this.load();
  },

  switchScope(e) {
    const { key, available } = e.currentTarget.dataset;
    if (!available || available === '0') {
      wx.showToast({ title: '请先完成学生认证', icon: 'none' });
      return;
    }
    if (key === this.data.scope) return;
    this.setData({ scope: key, loading: true });
    this.load();
  },

  async load() {
    const { range, scope } = this.data;
    try {
      await getApp().ensureLogin();
      const data = await auth.get('/api/ranking', { range, scope });
      const list = (data.list || []).map((item) => ({
        ...item,
        stepsText: fmt.formatNumber(item.steps),
      }));
      // 领奖台按 2 / 1 / 3 顺序展示
      const head = list.slice(0, 3);
      const podium = [head[1], head[0], head[2]].filter(Boolean);
      const me = data.me || {};
      this.setData({
        list,
        top3: podium,
        rest: list.slice(3),
        rangeText: data.rangeText || '',
        scopeText: data.scopeText || '',
        scopes: data.scopes || this.data.scopes,
        participants: data.participants || 0,
        excluded: !!data.excluded,
        excludedReason: data.excludedReason || '教师账号不参与步数排名',
        me: {
          ...me,
          stepsText: fmt.formatNumber(me.steps || 0),
          distanceText: fmt.formatDistance(me.distance || 0),
          nickname: me.nickname || '我',
        },
        empty: list.length === 0,
        loading: false,
      });
    } catch (e) {
      // 范围不可用（未绑定院系/班级）时回退到全校
      if (e.code === 400 && scope !== 'school') {
        this.setData({ scope: 'school' });
        return this.load();
      }
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  goRun() {
    wx.switchTab({ url: '/pages/run/index' });
  },

  goBind() {
    wx.navigateTo({ url: '/pages/org/bind' });
  },
});
