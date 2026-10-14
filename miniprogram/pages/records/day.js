const auth = require('../../utils/request');
const fmt = require('../../utils/format');

function decorate(r) {
  return {
    ...r,
    timeText: r.createdAt ? new Date(r.createdAt).toTimeString().slice(0, 5) : '',
    distanceText: fmt.formatDistance(r.distance),
    durationText: fmt.formatDuration(r.durationSeconds),
    stepsText: fmt.formatNumber(r.steps || 0),
    ...fmt.sourceOf(r.source),
  };
}

Page({
  data: {
    date: '',
    dateText: '',
    weekText: '',
    holiday: null,
    totals: null,
    goal: null,
    goalPercent: 0,
    goalAchieved: false,
    goalStepsText: '',
    points: 0,
    records: [],
    loading: true,
  },

  onLoad(options) {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    this.setData({ date: options.date || '' });
    this.load();
  },

  async load() {
    const { date } = this.data;
    if (!date) return;
    try {
      await getApp().ensureLogin();
      const data = await auth.get(`/api/run/day/${date}`);
      const p = fmt.parseDateKey(date);
      const goalSteps = (data.goal && data.goal.daily && data.goal.daily.steps) || 0;
      const percent = Math.min(100, Math.round(((data.totals.steps || 0) / (goalSteps || 1)) * 100));
      this.setData({
        loading: false,
        dateText: `${p.m}月${p.d}日 ${p.week}`,
        weekText: p.week,
        holiday: data.holiday,
        totals: {
          steps: fmt.formatNumber(data.totals.steps),
          distance: fmt.formatDistance(data.totals.distance),
          calories: fmt.formatNumber(data.totals.calories),
          durationText: fmt.formatDuration(data.totals.durationSeconds),
        },
        goal: data.goal,
        goalStepsText: fmt.formatNumber(goalSteps),
        goalPercent: percent,
        goalAchieved: !!data.goalAchieved,
        // 当日跑分（达标基础分 + 超出加分，服务端算好，页面不重算公式）
        points: data.points || 0,
        records: data.records.map(decorate),
      });
      wx.setNavigationBarTitle({ title: `${p.m}月${p.d}日记录` });
    } catch (e) {
      this.setData({ loading: false });
      if (e.code === 403003) return;
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  openRecord(e) {
    wx.navigateTo({ url: `/pages/run/detail?id=${e.currentTarget.dataset.id}` });
  },
});
