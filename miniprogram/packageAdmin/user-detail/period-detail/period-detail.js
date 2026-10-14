// 注意：本页在 packageAdmin/user-detail/period-detail/ 下，比 users/account-edit 深一级，
// 回到 miniprogram 根需要 ../../..（写成 ../.. 会让整页 JS 加载失败 → 页面全白）
const auth = require('../../../utils/request');
const fmt = require('../../../utils/format');

// 日期 YYYY-MM-DD → M月D日（周内展示用）
function md(dateKey) {
  if (!dateKey) return '';
  return `${Number(dateKey.slice(5, 7))}月${Number(dateKey.slice(8, 10))}日`;
}

function fmtTime(v) {
  if (!v) return '';
  const s = String(v);
  // 兼容 Date / ISO 字符串：只取 HH:mm
  const m = s.match(/T(\d{2}:\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

Page({
  data: {
    id: '',
    type: 'day', // day 日明细 | week 周明细
    date: '', // 日：当天；周：周起始（周一）
    userName: '',
    loading: true,
    summary: null,
    records: [],
    days: [],
    goalSteps: 0,
    achieved: false,
    planName: '',
    mode: '', // 周视图里点某天 → 该天的日明细（内嵌展示）
    modeIsDay: false, // 布尔标记（WXML 里避免用字符串比较，静态检查会把它当图标名）
    modeDate: '',
    modeRecords: [],
    rangeText: '',
  },

  onLoad(options) {
    const type = options.type === 'week' ? 'week' : 'day';
    this.setData({
      id: options.id || '',
      date: options.date || '',
      type,
      userName: decodeURIComponent(options.name || ''),
    });
    wx.setNavigationBarTitle({ title: type === 'week' ? '周运动明细' : '日运动明细' });
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const query = this.data.type === 'week' ? { type: 'week', weekStart: this.data.date } : { type: 'day', date: this.data.date };
      const res = await auth.get(`/api/admin/users/${this.data.id}/period`, query);
      const records = (res.records || []).map((r) => this.fmtRun(r));
      const days = (res.days || []).map((d) => ({
        ...d,
        dateText: md(d.date),
        distanceKm: ((d.distance || 0) / 1000).toFixed(2),
        stepsText: fmt.formatNumber(d.steps),
        durationText: fmt.formatDuration(d.durationSeconds),
      }));
      this.setData({
        loading: false,
        summary: {
          stepsText: fmt.formatNumber(res.summary.steps),
          distanceText: fmt.formatDistance(res.summary.distance),
          caloriesText: fmt.formatNumber(res.summary.calories),
          durationText: fmt.formatDuration(res.summary.durationSeconds),
          recordCount: res.summary.recordCount,
        },
        records,
        days,
        goalSteps: res.goalSteps || 0,
        achieved: !!res.achieved,
        planName: res.planName || '默认目标',
        rangeText:
          this.data.type === 'week'
            ? `${md(res.from)} - ${md(res.to)}`
            : md(res.from),
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  // 单条运动的展示字段（与用户详情明细一致）
  fmtRun(r) {
    return {
      ...r,
      dateText: md(r.date),
      timeText: fmtTime(r.startTime || r.createdAt) || '—',
      sourceText: r.source === 'gps' ? 'GPS 实跑' : '微信运动',
      distanceText: fmt.formatDistance(r.distance),
      durationText: fmt.formatDuration(r.durationSeconds),
    };
  },

  // 周视图点某天 → 展开该天的逐条记录
  openDay(e) {
    const date = e.currentTarget.dataset.date;
    if (!date) return;
    if (this.data.mode === 'day' && this.data.modeDate === date) {
      this.setData({ mode: '', modeIsDay: false, modeDate: '', modeRecords: [] });
      return;
    }
    const rows = (this.data.records || []).filter((r) => r.date === date);
    this.setData({ mode: 'day', modeIsDay: true, modeDate: date, modeRecords: rows });
  },

  openRun(e) {
    const id = e.currentTarget.dataset.id;
    // 管理端看的是别人的记录：带 admin=1&uid，走管理端取数接口
    if (id) wx.navigateTo({ url: `/pages/run/detail?id=${id}&admin=1&uid=${this.data.id}` });
  },
});
