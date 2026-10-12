const auth = require('../../utils/request');
const fmt = require('../../utils/format');

function buildMonth(year, month) {
  // month: 1-12
  const first = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const startWeek = first.getDay();
  const cells = [];
  for (let i = 0; i < startWeek; i++) cells.push({ empty: true });
  const today = fmt.todayKey();
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ key, day: d, isToday: key === today, steps: 0, achieved: false, holiday: null, records: [] });
  }
  return cells;
}

Page({
  data: {
    year: 0,
    month: 0,
    monthText: '',
    weekdays: ['日', '一', '二', '三', '四', '五', '六'],
    cells: [],
    selected: null,
    selectedRecords: [],
    weekStats: null,
  },

  onShow() {
    const now = new Date();
    this.setData({ year: now.getFullYear(), month: now.getMonth() + 1 });
    this.load();
  },

  prevMonth() {
    let { year, month } = this.data;
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
    this.setData({ year, month });
    this.load();
  },

  nextMonth() {
    let { year, month } = this.data;
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
    this.setData({ year, month });
    this.load();
  },

  async load() {
    const { year, month } = this.data;
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    this.setData({ monthText: `${year} 年 ${month} 月` });
    try {
      await getApp().ensureLogin();
      const [{ records, holidays }, week] = await Promise.all([
        auth.get('/api/run/calendar', { month: monthKey }),
        auth.get('/api/run/week').catch(() => ({ records: [] })),
      ]);
      const recordMap = new Map();
      for (const r of records) {
        if (!recordMap.has(r.date)) recordMap.set(r.date, []);
        recordMap.get(r.date).push(r);
      }
      const holidayMap = new Map(holidays.map((h) => [h.date, h]));
      const cells = buildMonth(year, month);
      for (const cell of cells) {
        if (cell.empty) continue;
        const recs = recordMap.get(cell.key) || [];
        cell.records = recs;
        const werun = recs.find((r) => r.source === 'werun');
        cell.steps = recs.reduce((s, r) => s + (r.steps || 0), 0);
        cell.distance = recs.reduce((s, r) => s + (r.distance || 0), 0);
        cell.achieved = werun ? werun.goalAchieved : cell.distance >= 3000;
        cell.holiday = holidayMap.get(cell.key) || null;
      }
      this.setData({ cells });
      if (this.data.selected) {
        this.selectDay({ currentTarget: { dataset: { key: this.data.selected } } });
      }
      // 周统计
      const weekSteps = week.records.reduce((s, r) => s + (r.steps || 0), 0);
      const weekDistance = week.records.reduce((s, r) => s + (r.distance || 0), 0);
      const activeDays = new Set(week.records.map((r) => r.date)).size;
      this.setData({
        weekStats: {
          steps: fmt.formatNumber(weekSteps),
          distance: fmt.formatDistance(weekDistance),
          activeDays: `${activeDays}/7`,
        },
      });
    } catch (e) {
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  selectDay(e) {
    const key = e.currentTarget.dataset.key;
    const cell = this.data.cells.find((c) => c.key === key);
    if (!cell) return;
    this.setData({
      selected: key,
      selectedRecords: cell.records.map((r) => ({
        ...r,
        distanceText: fmt.formatDistance(r.distance),
        durationText: fmt.formatDuration(r.durationSeconds),
        sourceText: r.source === 'gps' ? 'GPS 实跑' : '微信运动',
      })),
    });
  },

  openRecord(e) {
    wx.navigateTo({ url: `/pages/run/detail?id=${e.currentTarget.dataset.id}` });
  },
});
