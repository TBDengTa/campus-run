const auth = require('../../utils/request');
const fmt = require('../../utils/format');

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateKey(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

// 本周（自然周，周一起）柱状图数据：周一 → 周日，未来日期留空
function buildBars(records) {
  const map = new Map();
  for (const r of records || []) {
    map.set(r.date, (map.get(r.date) || 0) + (r.steps || 0));
  }
  const today = new Date();
  const todayKeyStr = dateKey(today.getFullYear(), today.getMonth() + 1, today.getDate());
  // 本周一
  const diff = today.getDay() === 0 ? 6 : today.getDay() - 1;
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - diff);

  const bars = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    const key = dateKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
    const isFuture = key > todayKeyStr;
    const steps = map.get(key) || 0;
    bars.push({
      key,
      label: WEEKDAYS[d.getDay()],
      steps: isFuture ? 0 : steps,
      isToday: key === todayKeyStr,
      isFuture,
    });
  }
  const max = Math.max(1, ...bars.map((b) => b.steps));
  for (const b of bars) {
    b.height = b.isFuture ? 0 : b.steps > 0 ? Math.max(10, Math.round((b.steps / max) * 100)) : 4;
    b.stepsText = !b.isFuture && b.steps > 0 ? fmt.formatNumber(b.steps) : '';
  }
  return bars;
}

// 单条记录展示装饰
function decorateRecord(r) {
  return {
    ...r,
    dateText: r.date ? `${Number(r.date.slice(5, 7))}月${Number(r.date.slice(8, 10))}日` : '',
    timeText: r.createdAt ? new Date(r.createdAt).toTimeString().slice(0, 5) : '',
    weekText: r.date ? fmt.parseDateKey(r.date).week : '',
    distanceText: fmt.formatDistance(r.distance),
    durationText: fmt.formatDuration(r.durationSeconds),
    stepsText: fmt.formatNumber(r.steps || 0),
    ...fmt.sourceOf(r.source),
  };
}

// 每日聚合展示装饰
function decorateDay(d) {
  const p = fmt.parseDateKey(d.date);
  return {
    ...d,
    monthDay: `${p.m}月${p.d}日`,
    weekText: p.week,
    distanceText: fmt.formatDistance(d.distance),
    durationText: fmt.formatDuration(d.durationSeconds),
    stepsText: fmt.formatNumber(d.steps),
    isToday: d.date === fmt.todayKey(),
  };
}

// 每周聚合展示装饰
function decorateWeek(w) {
  const s = fmt.parseDateKey(w.weekStart);
  const e = fmt.parseDateKey(w.weekEnd);
  return {
    ...w,
    rangeText: `${s.m}月${s.d}日 - ${e.m}月${e.d}日`,
    distanceText: fmt.formatDistance(w.distance),
    stepsText: fmt.formatNumber(w.steps),
    isThisWeek: w.weekStart === weekStartOf(fmt.todayKey()),
  };
}

function weekStartOf(dateKey) {
  const p = fmt.parseDateKey(dateKey);
  const d = new Date(p.y, p.m - 1, p.d);
  const diff = d.getDay() === 0 ? 6 : d.getDay() - 1;
  d.setDate(d.getDate() - diff);
  return fmt.todayKey(d);
}

Page({
  data: {
    weekRangeText: '',
    tab: 'sport', // sport 运动记录 | day 每日记录 | week 每周记录
    weekStats: null,
    bars: [],
    // 运动记录
    sport: { list: [], total: 0, page: 1, loading: false, done: false },
    // 每日记录
    days: { list: [], total: 0, page: 1, loading: false, done: false },
    // 每周记录
    weeks: { list: [], loading: false },
  },

  onShow() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    this.syncTabBar();
    this.reload();
  },

  syncTabBar() {
    if (typeof this.getTabBar !== 'function') return;
    const bar = this.getTabBar();
    if (bar && typeof bar.setActive === 'function') bar.setActive('/pages/records/records');
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh());
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) return;
    this.setData({ tab });
    // 首次切到某栏时若无数据则加载
    if (tab === 'week' && !this.data.weeks.list.length) this.loadWeeks();
    if (tab === 'day' && !this.data.days.list.length) this.loadDays(true);
    if (tab === 'sport' && !this.data.sport.list.length) this.loadSport(true);
  },

  async reload() {
    try {
      await getApp().ensureLogin();
      const [week] = await Promise.all([auth.get('/api/run/week').catch(() => ({ records: [] }))]);
      // 自然周（周一起）：仅统计今天及之前的日期
      const todayStr = fmt.todayKey();
      const thisWeekRecords = (week.records || []).filter((r) => r.date <= todayStr);
      const weekSteps = thisWeekRecords.reduce((s, r) => s + (r.steps || 0), 0);
      const weekDistance = thisWeekRecords.reduce((s, r) => s + (r.distance || 0), 0);
      const activeDays = new Set(thisWeekRecords.map((r) => r.date)).size;
      const daysGone = new Date().getDay() === 0 ? 7 : new Date().getDay();
      const ws = fmt.parseDateKey(week.weekStart || todayStr);
      const we = fmt.parseDateKey(week.weekEnd || todayStr);
      const weekRangeText = `${ws.m}月${ws.d}日 - ${we.m}月${we.d}日`;
      this.setData({
        weekRangeText,
        weekStats: {
          steps: fmt.formatNumber(weekSteps),
          distance: fmt.formatDistance(weekDistance),
          activeDays: `${activeDays}/${daysGone}`,
        },
        bars: buildBars(week.records),
      });
      await Promise.all([this.loadSport(true), this.loadDays(true), this.loadWeeks()]);
    } catch (e) {
      if (e.code === 403003) return;
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  // ===== 运动记录 =====
  async loadSport(reset) {
    const sport = this.data.sport;
    if (sport.loading || (sport.done && !reset)) return;
    const page = reset ? 1 : sport.page + 1;
    this.setData({ sport: { ...sport, loading: true, page: reset ? 1 : sport.page } });
    try {
      const res = await auth.get('/api/run/list', { page, limit: 15 });
      const list = res.list.map(decorateRecord);
      const merged = reset ? list : [...sport.list, ...list];
      this.setData({
        sport: { list: merged, total: res.total, page, loading: false, done: merged.length >= res.total },
      });
    } catch (e) {
      this.setData({ sport: { ...this.data.sport, loading: false } });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  // ===== 每日记录 =====
  async loadDays(reset) {
    const days = this.data.days;
    if (days.loading || (days.done && !reset)) return;
    const page = reset ? 1 : days.page + 1;
    this.setData({ days: { ...days, loading: true, page: reset ? 1 : days.page } });
    try {
      const res = await auth.get('/api/run/days', { page, limit: 15 });
      const list = res.list.map(decorateDay);
      const merged = reset ? list : [...days.list, ...list];
      this.setData({
        days: { list: merged, total: res.total, page, loading: false, done: merged.length >= res.total },
      });
    } catch (e) {
      this.setData({ days: { ...this.data.days, loading: false } });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  // ===== 每周记录 =====
  async loadWeeks() {
    if (this.data.weeks.loading) return;
    this.setData({ weeks: { ...this.data.weeks, loading: true } });
    try {
      const res = await auth.get('/api/run/weeks', { limit: 8 });
      this.setData({ weeks: { list: res.list.map(decorateWeek), loading: false } });
    } catch (e) {
      this.setData({ weeks: { ...this.data.weeks, loading: false } });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  onReachBottom() {
    if (this.data.tab === 'sport') this.loadSport(false);
    if (this.data.tab === 'day') this.loadDays(false);
  },

  openRecord(e) {
    wx.navigateTo({ url: `/pages/run/detail?id=${e.currentTarget.dataset.id}` });
  },

  openDay(e) {
    wx.navigateTo({ url: `/pages/records/day?date=${e.currentTarget.dataset.date}` });
  },

  openWeek(e) {
    wx.navigateTo({ url: `/pages/records/week?start=${e.currentTarget.dataset.start}` });
  },

  goRun() {
    wx.switchTab({ url: '/pages/run/index' });
  },
});
