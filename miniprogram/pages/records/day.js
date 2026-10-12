const auth = require('../../utils/request');
const fmt = require('../../utils/format');

function decorate(r) {
  return {
    ...r,
    timeText: r.createdAt ? new Date(r.createdAt).toTimeString().slice(0, 5) : '',
    distanceText: fmt.formatDistance(r.distance),
    durationText: fmt.formatDuration(r.durationSeconds),
    stepsText: fmt.formatNumber(r.steps || 0),
    sourceText: r.source === 'gps' ? 'GPS 实跑' : '微信运动',
    sourceIcon: r.source === 'gps' ? 'location' : 'logo-wechat-stroke',
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
    records: [],
    loading: true,
  },

  onLoad(options) {
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
      const percent = Math.min(100, Math.round(((data.totals.steps || 0) / (data.goal.daily.steps || 1)) * 100));
      this.setData({
        loading: false,
        dateText: `${p.m}月${p.d}日 ${p.week}`,
        holiday: data.holiday,
        totals: {
          steps: fmt.formatNumber(data.totals.steps),
          distance: fmt.formatDistance(data.totals.distance),
          calories: data.totals.calories,
          durationText: fmt.formatDuration(data.totals.durationSeconds),
        },
        goal: data.goal,
        goalPercent: percent,
        goalAchieved: !!data.goalAchieved,
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
