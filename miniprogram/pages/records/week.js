const auth = require('../../utils/request');
const fmt = require('../../utils/format');

const WEEKDAY_TEXT = ['一', '二', '三', '四', '五', '六', '日'];

function decorateRecord(r) {
  return {
    ...r,
    dateText: r.date ? `${Number(r.date.slice(5, 7))}月${Number(r.date.slice(8, 10))}日` : '',
    distanceText: fmt.formatDistance(r.distance),
    durationText: fmt.formatDuration(r.durationSeconds),
    stepsText: fmt.formatNumber(r.steps || 0),
    sourceText: r.source === 'gps' ? 'GPS 实跑' : '微信运动',
    sourceIcon: r.source === 'gps' ? 'location' : 'logo-wechat-stroke',
  };
}

Page({
  data: {
    start: '',
    rangeText: '',
    totals: null,
    goal: null,
    goalStepsText: '',
    goalPercent: 0,
    goalAchieved: false,
    activeDays: 0,
    days: [], // 7 天逐日
    records: [],
    loading: true,
  },

  onLoad(options) {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    this.setData({ start: options.start || '' });
    this.load();
  },

  async load() {
    const { start } = this.data;
    if (!start) return;
    try {
      await getApp().ensureLogin();
      const data = await auth.get(`/api/run/week-detail/${start}`);
      const s = fmt.parseDateKey(start);
      const e = fmt.parseDateKey(data.weekEnd);
      const today = fmt.todayKey();

      const maxSteps = Math.max(1, ...data.days.map((d) => d.steps));
      const days = data.days.map((d, i) => {
        const p = fmt.parseDateKey(d.date);
        return {
          ...d,
          label: `${p.m}/${p.d}`,
          weekText: WEEKDAY_TEXT[i],
          isToday: d.date === today,
          isFuture: d.date > today,
          stepsText: fmt.formatNumber(d.steps),
          barHeight: d.steps > 0 ? Math.max(10, Math.round((d.steps / maxSteps) * 100)) : 3,
        };
      });

      const goalSteps = (data.goal && data.goal.weekly && data.goal.weekly.steps) || 0;
      const goalPercent = Math.min(100, Math.round(((data.totals.steps || 0) / (goalSteps || 1)) * 100));
      this.setData({
        loading: false,
        rangeText: `${s.m}月${s.d}日 - ${e.m}月${e.d}日`,
        totals: {
          steps: fmt.formatNumber(data.totals.steps),
          distance: fmt.formatDistance(data.totals.distance),
          calories: fmt.formatNumber(data.totals.calories),
          durationText: fmt.formatDuration(data.totals.durationSeconds),
        },
        goal: data.goal,
        goalStepsText: fmt.formatNumber(goalSteps),
        goalPercent,
        goalAchieved: !!data.goalAchieved,
        activeDays: data.activeDays,
        days,
        records: data.records.map(decorateRecord),
      });
      wx.setNavigationBarTitle({ title: '每周记录' });
    } catch (e) {
      this.setData({ loading: false });
      if (e.code === 403003) return;
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  openDay(e) {
    wx.navigateTo({ url: `/pages/records/day?date=${e.currentTarget.dataset.date}` });
  },

  openRecord(e) {
    wx.navigateTo({ url: `/pages/run/detail?id=${e.currentTarget.dataset.id}` });
  },
});
