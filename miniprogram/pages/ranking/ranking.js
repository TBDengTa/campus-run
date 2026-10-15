const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// 榜单维度：图标必须是 TDesign 图标字体里真实存在的名字（footprints / medal 都不存在，会渲染空白）
// 注：没有「成就/徽章」维度 —— 产品口径是「跑分/排名是发放徽章的条件」，徽章不参与排名
const METRICS = [
  { key: 'steps', label: '步数', icon: 'component-steps' },
  { key: 'points', label: '跑分', icon: 'chart-bubble' },
  { key: 'goal', label: '达标', icon: 'check-circle' },
  { key: 'water', label: '饮水', icon: 'drink' },
];
const RANGES = [
  { key: 'today', label: '今日' },
  { key: 'week', label: '本周' },
  { key: 'total', label: '总榜' },
];
// 榜单形态：个人榜（一行一人）/ 班级榜（一行一班，班级跑分 = 班内学生跑分之和）
const KINDS = [
  { key: 'person', label: '个人榜' },
  { key: 'class', label: '班级榜' },
];
// 班级榜只支持能按「班内求和」比较的指标（达标天数/饮水按班求和没有解释意义）
const CLASS_METRICS = ['steps', 'points'];

// 维度可用性：班级榜时把不支持的维度置灰
function metricsFor(kind) {
  const ok = kind === 'class' ? CLASS_METRICS : null;
  return METRICS.map((m) => ({ ...m, available: !ok || ok.includes(m.key) }));
}

Page({
  data: {
    metrics: metricsFor('person'),
    ranges: RANGES,
    kinds: KINDS,
    // 加载骨架屏的行（放 data 里而不是 WXML 的数组字面量，避免个别基础库不支持 {{[1,2,3]}} 而整页编译失败白屏）
    skeletonRows: [1, 2, 3, 4, 5],
    kind: 'person',
    metric: 'steps',
    range: 'today',
    scope: 'all',
    scopes: [],
    rank: null,
    loading: false,
    error: '',
    // 广告卡刷新信号（排行榜卡片位）
    adRefreshAt: 0,
  },

  onShow() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    this.syncTabBar();
    // 让排行榜广告卡跟着页面一起刷新
    this.setData({ adRefreshAt: Date.now() });
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
      const { kind, metric, range, scope } = this.data;
      const data = await auth.get('/api/ranking', { kind, metric, range, scope });
      const isClass = kind === 'class';
      const list = (data.list || []).map((r) => ({
        ...r,
        // 个人榜用姓名、班级榜用班级名
        nameText: isClass ? r.className : r.isMe ? r.name + '（我）' : r.name,
        medal: r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : '',
        stepsText: fmt.formatNumber(r.steps || 0),
        valueText: fmt.formatNumber(r.value || 0),
      }));
      this.setData({
        rank: {
          ...data,
          list,
          me: {
            ...data.me,
            stepsText: fmt.formatNumber(data.me.steps || 0),
            membersText: `${data.me.members || 0} 人`,
          },
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

  pickKind(e) {
    const kind = e.currentTarget.dataset.key;
    if (kind === this.data.kind) return;
    // 班级榜只支持步数 / 跑分：切过去时自动落到最贴近当前指标的可用项
    // scope 也一并回到「全校」——班级榜里 scope=班级 只剩自己班一行，没有比较意义
    const metric = kind === 'class' && !CLASS_METRICS.includes(this.data.metric) ? 'points' : this.data.metric;
    const scope = kind === 'class' && this.data.scope === 'class' ? 'all' : this.data.scope;
    this.setData({ kind, metric, scope, metrics: metricsFor(kind) });
    this.load();
  },

  pickMetric(e) {
    const { key, available } = e.currentTarget.dataset;
    if (available === false || available === 'false') return;
    if (key !== this.data.metric) {
      this.setData({ metric: key });
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
