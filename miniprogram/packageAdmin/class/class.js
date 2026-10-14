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

// 页码条：页数少时全列，多时首尾 + 当前页附近，间隔用省略号（与用户明细分页同一语言）
function buildPageItems(current, total) {
  const out = [];
  const push = (page, label) => out.push({ k: `${page}-${out.length}`, page, label: label || String(page) });
  if (total <= 7) {
    for (let i = 1; i <= total; i += 1) push(i);
    return out;
  }
  push(1);
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) push(0, '…');
  for (let i = start; i <= end; i += 1) push(i);
  if (end < total - 1) push(0, '…');
  push(total);
  return out;
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
    topStudents: [], // 班内榜单前三（本周步数，/api/class/ranking）
    nudgeCount: 0, // 今日未达标人数（底部操作条副文案）
    students: [],
    page: 1,
    pagesTotal: 1,
    pageItems: [],
    total: 0,
    hasMore: false,
    loadingMore: false,
    keyword: '',
    sort: 'today',
    achieved: '',
    hasFilter: false, // 搜索 / 达标筛选 / 非默认排序任一为真 → 显示已生效条件行
    filterSummary: '', // 已生效条件摘要（如「今日未达标 · 按姓名排序」）
    filterCount: 0, // 「筛选」按钮角标（达标筛选生效数）
    sortLabel: '今日步数', // 「排序」按钮上的当前排序文案
    showFilters: false, // 筛选面板默认收起（与用户管理页一致）
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

  // 身份 + 概况 + 榜单，然后拉第一页名单
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
      await Promise.all([this.loadOverview(), this.loadRanking(), this.loadStudents(1)]);
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
        // 全校班级名次的展示字段：横条里用大号数字 + 「/ 总数」
        rankNo: rank && rank.rank ? rank.rank : 0,
        rankTotal: rank ? rank.total : 0,
        rankAvgText: rank ? fmt.formatNumber(rank.avgSteps) : '',
        rankText: !rank
          ? ''
          : rank.rank
            ? `第 ${rank.rank} / ${rank.total} 名 · 班级日均 ${fmt.formatNumber(rank.avgSteps)} 步`
            : '本周还没有运动记录，暂未进入全校班级榜',
        weekRangeText: ov.weekStart ? `${md(ov.weekStart)} 起` : '',
      },
      classRank: rank,
      nudgeCount: Math.max(0, (ov.studentCount || 0) - (ov.achievedToday || 0)),
    });
  },

  // 班内榜单前三（本周步数）：只做展示，失败不影响页面主流程
  async loadRanking() {
    const className = this.data.className;
    if (!className) return;
    const medals = ['is-1', 'is-2', 'is-3'];
    try {
      const res = await auth.get('/api/class/ranking', { className });
      const top = (res.students || [])
        .filter((s) => Number(s.weekSteps) > 0)
        .slice(0, 3)
        .map((s, i) => ({
          userId: s.userId,
          name: s.name,
          isClassOfficer: s.isClassOfficer,
          achievedToday: s.achievedToday,
          weekStepsText: fmt.formatNumber(s.weekSteps),
          todayStepsText: fmt.formatNumber(s.todaySteps),
          medal: medals[i] || '',
        }));
      this.setData({ topStudents: top });
    } catch (e) {
      this.setData({ topStudents: [] });
    }
  },

  // 学生名单（服务端分页：翻到第几页就显示第几页，不做触底追加）
  async loadStudents(page) {
    const className = this.data.className;
    if (!className) return;
    const p = Math.max(1, page || 1);
    const pageChanged = p !== this.data.page;
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
        initial: String(s.name || '?').slice(0, 1),
        todayStepsText: fmt.formatNumber(s.todaySteps),
        weekStepsText: fmt.formatNumber(s.weekSteps),
        targetText: fmt.formatNumber(s.todayTarget),
        syncText: syncText(s.lastSyncAt),
      }));
      const total = res.total || 0;
      const pagesTotal = Math.max(1, Math.ceil(total / PAGE_SIZE));
      this.setData({
        students: rows,
        page: p,
        pagesTotal,
        pageItems: buildPageItems(p, pagesTotal),
        total,
        hasMore: !!res.hasMore,
      });
    } catch (e) {
      wx.showToast({ title: e.message || '名单加载失败', icon: 'none' });
    } finally {
      this.setData({ loadingMore: false });
      if (pageChanged) this.scrollToList();
    }
  },

  // 翻页后回到名单顶部（失败静默，不影响数据）
  scrollToList() {
    wx.pageScrollTo({ selector: '#clsList', duration: 200, fail: () => {} });
  },

  // 按钮翻页：上一页 / 指定页 / 下一页
  goPage(e) {
    const p = Number(e.currentTarget.dataset.page) || 0;
    if (!p || p === this.data.page) return;
    if (p < 1 || p > this.data.pagesTotal) return;
    this.loadStudents(p);
  },

  prevPage() {
    if (this.data.page > 1) this.loadStudents(this.data.page - 1);
  },

  nextPage() {
    if (this.data.page < this.data.pagesTotal) this.loadStudents(this.data.page + 1);
  },

  // 切换班级（班主任可能有多个班）
  switchClass(e) {
    const className = e.currentTarget.dataset.class;
    if (!className || className === this.data.className) return;
    this.setData({ className, students: [], topStudents: [], overview: null, page: 1, pagesTotal: 1, pageItems: [], total: 0, hasMore: false });
    wx.setNavigationBarTitle({ title: `${className} · 班级管理` });
    this.loadOverview();
    this.loadRanking();
    this.loadStudents(1);
  },

  onSearch(e) {
    this.setData({ keyword: (e.detail && e.detail.value) || '' });
    this.syncFilterState();
    this._searchTimer && clearTimeout(this._searchTimer);
    // 输入停顿 400ms 再查，避免每个字符都打接口
    this._searchTimer = setTimeout(() => this.loadStudents(1), 400);
  },

  onClearSearch() {
    this.setData({ keyword: '' });
    this.syncFilterState();
    this.loadStudents(1);
  },

  pickSort(e) {
    const sort = e.currentTarget.dataset.key;
    if (sort === this.data.sort) return;
    this.setData({ sort });
    this.syncFilterState();
    this.loadStudents(1);
  },

  pickFilter(e) {
    const achieved = e.currentTarget.dataset.key || '';
    if (achieved === this.data.achieved) return;
    this.setData({ achieved });
    this.syncFilterState();
    this.loadStudents(1);
  },

  // 「清除筛选」：清空搜索 / 达标筛选，排序回到默认（今日步数）
  clearFilters() {
    if (!this.data.hasFilter) return;
    this.setData({ keyword: '', achieved: '', sort: 'today' });
    this.syncFilterState();
    this.loadStudents(1);
  },

  // 筛选面板展开 / 收起（与用户管理页同一交互）
  toggleFilters() {
    this.setData({ showFilters: !this.data.showFilters });
  },

  // 已生效条件：摘要行文本 / 条件数角标 / 排序按钮文案
  syncFilterState() {
    const { keyword, achieved, sort, sorts } = this.data;
    const sortLabel = ((sorts || []).find((s) => s.key === sort) || {}).label || '今日步数';
    const parts = [];
    if (keyword) parts.push(`搜索「${keyword}」`);
    if (achieved === '0') parts.push('今日未达标');
    if (achieved === '1') parts.push('今日已达标');
    if (sort !== 'today') parts.push(`按${sortLabel}排序`);
    this.setData({
      hasFilter: parts.length > 0,
      filterSummary: parts.join(' · '),
      filterCount: achieved ? 1 : 0,
      sortLabel,
    });
  },

  // 学生详情：与管理端用户详情同一个页面，带 scope=class 走班级域（只读；有权限时数据与管理端一致）
  openDetail(e) {
    const { id, name } = e.currentTarget.dataset;
    if (!id) return;
    const url =
      `/packageAdmin/user-detail/user-detail?id=${id}&scope=class` +
      `&name=${encodeURIComponent(name || '')}&className=${encodeURIComponent(this.data.className)}`;
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
        gapText: fmt.formatNumber(Math.max(0, (s.todayTarget || 0) - (s.todaySteps || 0))),
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
