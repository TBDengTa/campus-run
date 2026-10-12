const auth = require('../../utils/request');
const fmt = require('../../utils/format');

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateKey(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function buildMonth(year, month) {
  // month: 1-12
  const first = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const startWeek = first.getDay();
  const cells = [];
  for (let i = 0; i < startWeek; i++) cells.push({ empty: true });
  const today = fmt.todayKey();
  for (let d = 1; d <= daysInMonth; d++) {
    const key = dateKey(year, month, d);
    cells.push({
      key,
      day: d,
      dayText: `${month}/${d}`,
      isToday: key === today,
      steps: 0,
      achieved: false,
      holiday: null,
      records: [],
    });
  }
  return cells;
}

// 近 7 天柱状图数据
function buildBars(records) {
  const map = new Map();
  for (const r of records || []) {
    map.set(r.date, (map.get(r.date) || 0) + (r.steps || 0));
  }
  const bars = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = dateKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
    bars.push({ key, label: WEEKDAYS[d.getDay()], steps: map.get(key) || 0, isToday: i === 0 });
  }
  const max = Math.max(1, ...bars.map((b) => b.steps));
  for (const b of bars) {
    b.height = b.steps > 0 ? Math.max(10, Math.round((b.steps / max) * 100)) : 4;
    b.stepsText = b.steps > 0 ? fmt.formatNumber(b.steps) : '';
  }
  return bars;
}

function decorate(r) {
  return {
    ...r,
    dateText: r.date ? `${Number(r.date.slice(5, 7))}月${Number(r.date.slice(8, 10))}日` : '',
    weekText: r.date ? fmt.parseDateKey(r.date).week : '',
    distanceText: fmt.formatDistance(r.distance),
    durationText: fmt.formatDuration(r.durationSeconds),
    stepsText: fmt.formatNumber(r.steps || 0),
    sourceText: r.source === 'gps' ? 'GPS 实跑' : '微信运动',
    sourceIcon: r.source === 'gps' ? 'location' : 'logo-wechat-stroke',
  };
}

Page({
  data: {
    year: 0,
    month: 0,
    monthText: '',
    weekdays: WEEKDAYS,
    cells: [],
    selected: null,
    selectedText: '',
    selectedRecords: [],
    weekStats: null,
    bars: [],
    recent: [],
  },

  onShow() {
    this.syncTabBar();
    const now = new Date();
    this.setData({ year: now.getFullYear(), month: now.getMonth() + 1 });
    this.load();
  },

  // 自定义 tabBar 选中态
  syncTabBar() {
    if (typeof this.getTabBar !== 'function') return;
    const bar = this.getTabBar();
    if (bar && typeof bar.setActive === 'function') bar.setActive('/pages/records/records');
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
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
    const monthKey = `${year}-${pad(month)}`;
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
      const holidayMap = new Map((holidays || []).map((h) => [h.date, h]));
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

      // 近期记录：当月记录按日期倒序
      const recent = records
        .slice()
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
        .slice(0, 12)
        .map(decorate);

      this.setData({ cells, recent, bars: buildBars(week.records) });

      if (this.data.selected) {
        const still = cells.find((c) => c.key === this.data.selected);
        if (still) this.selectDay({ currentTarget: { dataset: { key: this.data.selected } } });
        else this.setData({ selected: null, selectedText: '', selectedRecords: [] });
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
    const d = fmt.parseDateKey(key);
    this.setData({
      selected: key,
      selectedText: `${d.m}月${d.d}日 ${d.week}`,
      selectedRecords: cell.records.map(decorate),
    });
  },

  openRecord(e) {
    wx.navigateTo({ url: `/pages/run/detail?id=${e.currentTarget.dataset.id}` });
  },

  goRun() {
    wx.switchTab({ url: '/pages/run/index' });
  },
});
