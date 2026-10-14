// 班级管理（班主任 / 班委）：全部数据来自 /api/class/*
//   班主任：概况 + 名单 + 榜单 + 督促（复制未达标名单）
//   班委：同一页面，但只读 —— 隐藏一切操作入口（服务端也没有任何写接口）
const auth = require('../../utils/request');
const fmt = require('../../utils/format');

const PAGE_SIZE = 20;

// 排序项（前端固定，服务端只认这些 key）
const SORTS = [
  { key: 'today', label: '今日步数' },
  { key: 'week', label: '本周步数' },
  { key: 'name', label: '姓名' },
  { key: 'sync', label: '最近同步' },
];

// 达标筛选：'' 全部 / '0' 今日未达标 / '1' 今日已达标
const FILTERS = [
  { key: '', label: '全部' },
  { key: '0', label: '今日未达标' },
  { key: '1', label: '今日已达标' },
];

// 最近同步时间 → 「10:32 / 昨天 18:02 / 10月12日 / 从未同步」
function syncText(v) {
  if (!v) return '从未同步';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '从未同步';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = fmt.todayKey();
  const key = fmt.todayKey(d);
  if (key === today) return `今天 ${hm}`;
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (key === fmt.todayKey(y)) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function md(dateKey) {
  if (!dateKey) return '';
  return `${Number(dateKey.slice(5, 7))}月${Number(dateKey.slice(8, 10))}日`;
}

Page({
  data: {
    loading: true,
    role: '', // homeroom | officer | ''
    canNudge: false,
    classes: [],
    className: '',
    today: '',
    weekStart: '',
    overview: null,
    classRank: null, // 本班在全校班级榜的名次（{ rank, total, avgSteps, members, top }）
    students: [],
    page: 1,
    total: 0,
    hasMore: false,
    loadingMore: false,
    keyword: '',
    sort: 'today',
    achieved: '',
    sorts: SORTS,
    filters: FILTERS,
    // 督促抽屉
    nudgeVisible: false,
    nudgeLoading: false,
    nudgeList: [],
    nudgeText: '',
  },

  onLoad(options) {
    if (!getApp().requireLogin()) return;
    if (options.className) this.setData({ className: decodeURIComponent(options.className) });
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) this.loadStudents(this.data.page + 1);
  },

  // 身份 + 概况，然后拉第一页名单
  async load() {
    try {
      await getApp().ensureLogin();
      const mine = await auth.get('/api/class/mine');
      if (!mine || !mine.role) {
        this.setData({ loading: false, role: '' });
        return;
      }
      const classes = mine.classes || [];
      const className = this.data.className || classes[0] || '';
      this.setData({
        role: mine.role,
        canNudge: mine.role === 'homeroom' && !mine.readonly,
        classes,
        className,
      });
      wx.setNavigationBarTitle({ title: `${className || '班级'} · 班级管理` });
      await Promise.all([this.loadOverview(), this.loadStudents(1)]);
      this.setData({ loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  async loadOverview() {
    const className = this.data.className;
    if (!className) return;
    const ov = await auth.get('/api/class/overview', { className });
    const rank = ov.classRank || null;
    this.setData({
      today: ov.date || fmt.todayKey(),
      weekStart: ov.weekStart || '',
      overview: {
        ...ov,
        stepsTodayText: fmt.formatNumber(ov.stepsToday),
        totalStepsText: fmt.formatNumber(ov.totalSteps),
        classAvgStepsText: fmt.formatNumber(ov.classAvgSteps),
        rankText: !rank
          ? ''
          : rank.rank
            ? `第 ${rank.rank} / ${rank.total} 名 · 班级日均 ${fmt.formatNumber(rank.avgSteps)} 步`
            : '本周还没有运动记录，暂未进入全校班级榜',
        weekRangeText: ov.weekStart ? `${md(ov.weekStart)} 起` : '',
      },
      classRank: rank,
    });
  },

  // 学生名单（服务端分页：page 递增即追加）
  async loadStudents(page) {
    const className = this.data.className;
    if (!className) return;
    const p = Math.max(1, page || 1);
    this.setData({ loadingMore: p > 1 });
    try {
      const res = await auth.get('/api/class/students', {
        className,
        page: p,
        limit: PAGE_SIZE,
        keyword: this.data.keyword,
        sort: this.data.sort,
        achievedToday: this.data.achieved,
      });
      const rows = (res.list || []).map((s) => ({
        ...s,
        todayStepsText: fmt.formatNumber(s.todaySteps),
        weekStepsText: fmt.formatNumber(s.weekSteps),
        targetText: fmt.formatNumber(s.todayTarget),
        syncText: syncText(s.lastSyncAt),
      }));
      this.setData({
        students: p > 1 ? [...this.data.students, ...rows] : rows,
        page: p,
        total: res.total || 0,
        hasMore: !!res.hasMore,
      });
    } catch (e) {
      wx.showToast({ title: e.message || '名单加载失败', icon: 'none' });
    } finally {
      this.setData({ loadingMore: false });
    }
  },

  // 切换班级（班主任可能有多个班）
  switchClass(e) {
    const className = e.currentTarget.dataset.class;
    if (!className || className === this.data.className) return;
    this.setData({ className, students: [], overview: null, page: 1, total: 0, hasMore: false });
    wx.setNavigationBarTitle({ title: `${className} · 班级管理` });
    this.loadOverview();
    this.loadStudents(1);
  },

  onSearch(e) {
    this.setData({ keyword: (e.detail && e.detail.value) || '' });
    this._searchTimer && clearTimeout(this._searchTimer);
    // 输入停顿 400ms 再查，避免每个字符都打接口
    this._searchTimer = setTimeout(() => this.loadStudents(1), 400);
  },

  onClearSearch() {
    this.setData({ keyword: '' });
    this.loadStudents(1);
  },

  pickSort(e) {
    const sort = e.currentTarget.dataset.key;
    if (sort === this.data.sort) return;
    this.setData({ sort });
    this.loadStudents(1);
  },

  pickFilter(e) {
    const achieved = e.currentTarget.dataset.key || '';
    if (achieved === this.data.achieved) return;
    this.setData({ achieved });
    this.loadStudents(1);
  },

  // 学生日/周明细：复用管理端的 period-detail，带 scope=class 走班级域接口（只读）
  openPeriod(e) {
    const { id, type, date } = e.currentTarget.dataset;
    if (!id || !date) return;
    const row = (this.data.students || []).find((s) => s.userId === id) || {};
    const url =
      `/packageAdmin/user-detail/period-detail/period-detail?id=${id}&type=${type || 'day'}&date=${date}` +
      `&scope=class&name=${encodeURIComponent(row.name || '')}&className=${encodeURIComponent(this.data.className)}`;
    wx.navigateTo({ url });
  },

  // ===== 督促：列出今日未达标学生（仅班主任）=====
  async openNudge() {
    if (!this.data.canNudge) return;
    this.setData({ nudgeVisible: true, nudgeLoading: true, nudgeList: [], nudgeText: '' });
    try {
      const res = await auth.get('/api/class/students', {
        className: this.data.className,
        achievedToday: '0',
        sort: 'today',
        page: 1,
        limit: 100,
      });
      const list = (res.list || []).map((s, i) => ({
        ...s,
        no: i + 1,
        todayStepsText: fmt.formatNumber(s.todaySteps),
        targetText: fmt.formatNumber(s.todayTarget),
        syncText: syncText(s.lastSyncAt),
      }));
      const cn = this.data.className;
      const text = list.length
        ? `【${cn}】今日步数未达标 ${list.length} 人（${this.data.today}）：\n` +
          list.map((s) => `${s.no}. ${s.name} ${s.todaySteps} / ${s.todayTarget} 步`).join('\n')
        : `【${cn}】今日全员达标，很棒！`;
      this.setData({ nudgeList: list, nudgeText: text, nudgeLoading: false });
    } catch (e) {
      this.setData({ nudgeLoading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  onNudgeVisible(e) {
    if (!(e.detail && e.detail.visible)) this.setData({ nudgeVisible: false });
  },

  closeNudge() {
    this.setData({ nudgeVisible: false });
  },

  copyNudge() {
    const text = this.data.nudgeText;
    if (!text) return;
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '名单已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' }),
    });
  },

  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/home/home' });
  },
});
