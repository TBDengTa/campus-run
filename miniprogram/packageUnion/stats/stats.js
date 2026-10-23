// 班超总评与排名（分包 packageUnion）：班级榜（院校 / 系部 / 年级筛选）+ 红黑榜
//
// 数据来自 /api/union/ranking；筛选口径由服务端统一收敛：
//   · 校级成员看全校，分院成员始终只看本院校 / 本院系；
//   · 院校 / 系部 / 年级是可选筛选，默认全部；
//   · 日榜选日期；周榜选「当月第几周」；月榜选 1-12 月。
//
// 周口径统一走 utils/period.js（与 services/band-chao.js::monthWeekRange 逐例对齐，有桩测试守着）：
// 周选项 label 直接带日期段，如「第2周(10月8日至10月14日)」—— 用户要求，不用心算第 2 周是哪几天。
const auth = require('../../utils/request');
const period = require('../../utils/period');

const RANGES = [
  { key: 'day', label: '今日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
];

const NOW = new Date();
const YEAR = NOW.getFullYear();
const MONTH_OPTIONS = period.monthOptions(YEAR);

const pad2 = period.pad2;

function todayKey() {
  return `${YEAR}-${pad2(NOW.getMonth() + 1)}-${pad2(NOW.getDate())}`;
}

function md(key) {
  return period.md(key);
}

const weekOptionsOfMonth = (month) => period.monthWeekOptions(YEAR, month);

Page({
  data: {
    loading: true,
    range: 'day',
    ranges: RANGES,

    date: todayKey(),
    dateText: md(todayKey()),

    year: YEAR,
    month: NOW.getMonth() + 1,
    monthOptions: MONTH_OPTIONS,
    monthIndex: NOW.getMonth(),

    weekNo: period.weekNoOfDate(YEAR, NOW.getMonth() + 1, todayKey()),
    weekOptions: weekOptionsOfMonth(NOW.getMonth() + 1),
    weekIndex: period.weekNoOfDate(YEAR, NOW.getMonth() + 1, todayKey()) - 1,

    periodText: '',
    // 周区间的日期段（服务端回显的 weekRangeText，如「10月8日至10月14日」）
    weekRangeText: '',

    schools: [{ value: '', label: '全部院校' }],
    schoolIndex: 0,
    school: '',
    departments: [{ value: '', label: '全部系部' }],
    departmentIndex: 0,
    department: '',
    grades: [{ value: '', label: '全部年级' }],
    gradeIndex: 0,
    grade: '',
    hasFilter: false,

    ranking: null,
    list: [],
    me: null,
    // 「需要关注」红黑榜（得分靠后的班）
    bottom: [],
  },

  onLoad() {
    if (!getApp().requireLogin()) return;
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      const params = {
        range: this.data.range,
        school: this.data.school,
        department: this.data.department,
        grade: this.data.grade,
      };
      if (this.data.range === 'day') {
        params.date = this.data.date;
      } else {
        params.month = `${YEAR}-${pad2(this.data.month)}`;
        if (this.data.range === 'week') params.weekNo = this.data.weekNo;
      }

      const data = await auth.get('/api/union/ranking', params);
      const decorate = (r) => ({
        ...r,
        scoreText: r.score === null || r.score === undefined ? '—' : String(r.score),
      });
      this.applyOptions(data.facets || {});
      this.setData({
        loading: false,
        ranking: {
          from: data.from,
          to: data.to,
          total: data.total || 0,
          rangeLabel: data.rangeLabel,
          periodLabel: data.periodLabel || data.rangeLabel,
          filters: data.filters || {},
        },
        periodText: data.periodLabel || data.rangeLabel || '',
        // 周区间的日期段：服务端已按同一口径算好（weekRangeText），前端不重算
        weekRangeText: this.data.range === 'week' ? data.weekRangeText || '' : '',
        list: (data.list || []).map(decorate),
        me: data.me ? decorate(data.me) : null,
        // 「需要关注」红黑榜：服务端已按得分靠后返回，这里只做展示映射
        bottom: (data.bottom || []).map(decorate),
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  // 筛选选项来自服务端 facets；院校变化时系部级联收敛，选中项失效则回到「全部」。
  applyOptions(facets) {
    const schools = [{ value: '', label: '全部院校' }, ...(facets.schools || [])];
    let schoolIndex = schools.findIndex((x) => x.value === this.data.school);
    if (schoolIndex < 0) schoolIndex = 0;
    const school = schools[schoolIndex].value;

    const deptFacets = (facets.departments || []).filter(
      (d) => !school || !d.school || d.school === school
    );
    const departments = [{ value: '', label: '全部系部' }, ...deptFacets];
    let departmentIndex = departments.findIndex((x) => x.value === this.data.department);
    if (departmentIndex < 0) departmentIndex = 0;
    const department = departments[departmentIndex].value;

    const grades = [{ value: '', label: '全部年级' }, ...(facets.grades || [])];
    let gradeIndex = grades.findIndex((x) => x.value === this.data.grade);
    if (gradeIndex < 0) gradeIndex = 0;
    const grade = grades[gradeIndex].value;

    this.setData({
      schools,
      schoolIndex,
      school,
      departments,
      departmentIndex,
      department,
      grades,
      gradeIndex,
      grade,
      hasFilter: !!(school || department || grade),
    });
  },

  onRangeTap(e) {
    const range = e.currentTarget.dataset.range;
    if (!range || range === this.data.range) return;
    if (range === 'week') {
      const weekOptions = weekOptionsOfMonth(this.data.month);
      const weekNo = Math.min(this.data.weekNo, weekOptions.length);
      this.setData({ range, weekOptions, weekNo, weekIndex: weekNo - 1 }, () => this.load());
      return;
    }
    this.setData({ range }, () => this.load());
  },

  onDateChange(e) {
    const date = e.detail.value;
    if (!date || date === this.data.date) return;
    this.setData({ date, dateText: md(date) }, () => this.load());
  },

  onMonthChange(e) {
    const idx = Number(e.detail.value) || 0;
    const month = (this.data.monthOptions[idx] || {}).value || 1;
    const weekOptions = weekOptionsOfMonth(month);
    const weekNo = Math.min(this.data.weekNo, weekOptions.length);
    this.setData(
      { month, monthIndex: idx, weekOptions, weekNo, weekIndex: weekNo - 1 },
      () => this.load()
    );
  },

  onWeekChange(e) {
    const idx = Number(e.detail.value) || 0;
    const weekNo = (this.data.weekOptions[idx] || {}).value || 1;
    this.setData({ weekNo, weekIndex: idx }, () => this.load());
  },

  onSchoolChange(e) {
    const idx = Number(e.detail.value) || 0;
    const school = (this.data.schools[idx] || {}).value || '';
    this.setData({ school, schoolIndex: idx, department: '', departmentIndex: 0 }, () => this.load());
  },

  onDepartmentChange(e) {
    const idx = Number(e.detail.value) || 0;
    const department = (this.data.departments[idx] || {}).value || '';
    this.setData({ department, departmentIndex: idx }, () => this.load());
  },

  onGradeChange(e) {
    const idx = Number(e.detail.value) || 0;
    const grade = (this.data.grades[idx] || {}).value || '';
    this.setData({ grade, gradeIndex: idx }, () => this.load());
  },

  onResetFilters() {
    this.setData(
      { school: '', schoolIndex: 0, department: '', departmentIndex: 0, grade: '', gradeIndex: 0 },
      () => this.load()
    );
  },

  goClass(e) {
    const className = e.currentTarget.dataset.class;
    if (!className) return;
    // 「我的班级」页（页内第三个 tab 是「班超联赛」）；tab=attendance 直接落在该 tab 上
    wx.navigateTo({ url: `/packageAdmin/class/class?tab=attendance&className=${encodeURIComponent(className)}` });
  },
});
