// 班级状态总览（用户 2026-10-29 建页；10-30 两次重排）
//   第一轮：「要紧凑排版，并支持筛选，复制时复制的是筛选后的相应内容」
//   第二轮（本次）：「这太难看了…可以查看显示内容与复制内容，如只需要日达标这种的，
//                    而且考勤回看是什么，并且没有院系筛选」
//
// ===== 与「班级管理」的分工 =====
//   · 班级管理：改台账（早操/校园跑标记、教室、宿舍）
//   · 本页：只看不改，全校班级一眼看谁没达标，并能一键复制成文字发到工作群
// 权限：class.view（不新开权限项 —— 学生处/年级组长本来就靠它看班级台账）。
//
// ===== 第二轮针对截图四点的处理 =====
//  ① 「没有院系筛选」→ 院校 + 系部**两级**下拉。
//     必须两级：实测北校区与洋河校区**都有「计财系」**，只给一个系部下拉
//     会把两个校区混着筛出来（看着能筛、结果是错的）。
//     系部选项随已选院校收窄；没选院校时允许按系部筛，但标签写明「各校区同名」。
//  ② 「可以查看显示内容与复制内容，如只需要日达标这种的」→ 两个开关：
//     「显示内容」= 列表与复制里出现哪几列（日达标 / 周达标 / 考勤）；
//     「复制内容」= 复制时强调哪个指标（全部 / 只看日达标 / 只看周达标）。
//     两者独立：可以看着三列、只复制日达标那一份名单。
//  ③ 「考勤回看是什么」→ 这个词没说清，而且**当前考勤根本没有数据**
//     （check_records 全库 4 条，moduleKey 只有 hygiene 卫生区，
//      而考勤统计的是早操/早八/晚自习/查宿，一条都不匹配）。
//     所以：整排选择器在「区间内没有任何考勤记录」时**不显示**，
//     有数据时才出现，并改名为「考勤统计 N 天」+ 一行说明它统计什么。
//     一个永远为空的控件摆在筛选区最显眼的位置，是这页"难看"的主要来源之一。
//  ④ 「太难看」→ 见 WXSS：筛选区从 4 行压到 2 行（一行下拉、一行开关），
//     列表列宽随「显示内容」变化，不再固定四列留大片空白。
//
// ===== 筛选与文案都在服务端 =====
// 可复制文案必须服务端单点生成（前端各拼一次必然漂移成「列表 87%、文案 88%」，
// 老师粘到群里被问住）。若筛选在前端、文案在服务端，两者用的是不同行集合，
// 复制出去仍是全量报告 —— 正是用户第一轮指出的问题。
// 所以前端只传参数（school/department/quick/level/metric/columns）并渲染返回结果。
const auth = require('../../utils/request');
const adminPerm = require('../../utils/admin-perm');
const fmt = require('../../utils/format');

// 快捷筛选（value 与服务端 QUICK_FILTERS 的键一一对应，非法值服务端会忽略）。
// 文案随所选日期联动（2026-11-03 日期选择）：选了非今天的日期后
// 「今日/本周」会变成说谎 —— 一律改说「当日/当周」，见 chipsFor()。
const CHIPS = [
  { key: '', label: '全部班级' },
  { key: 'notDaily', label: '今日未达标' },
  { key: 'zeroToday', label: '今日零达标' },
  { key: 'notWeek', label: '本周未达标' },
  { key: 'attMissing', label: '考勤待补' },
];

// 档位筛选（解决「今日未达标筛出全部 43 个班」= 等于没筛）。
// 2026-11-03：「低于一半」换成「低于95%」（用户指定；催办口径收紧到「没到95%」，
// 覆盖大部分跑了但还差几个的常见场景，零达标仍是它的子集）。
const LEVEL_CHIPS = [
  { key: '', label: '不限' },
  { key: 'notFull', label: '未达标' },
  { key: 'below95', label: '低于95%' },
  { key: 'zero', label: '零达标' },
];

// 指标维度（与档位组合成「日达标未达标 / 周达标零达标」）
const METRIC_CHIPS = [
  { key: 'daily', label: '日' },
  { key: 'weekly', label: '周' },
];

// 显示内容（列表列）与复制内容（文案强调哪个指标）—— 两个独立开关
// 考勤列 2026-11-12 起显示**分数**（10 分制），标签跟着改，否则「考勤」两字会被读成百分数
const COLUMN_TOGGLES = [
  { key: 'daily', label: '日达标' },
  { key: 'weekly', label: '周达标' },
  { key: 'attendance', label: '考勤分' },
];
const COPY_SCOPES = [
  { key: 'all', label: '全部' },
  { key: 'daily', label: '只要日达标' },
  { key: 'weekly', label: '只要周达标' },
];

const DAY_OPTIONS = [3, 7, 14, 30];

const rateLevel = (v) => (v === null || v === undefined ? 'none' : v >= 100 ? 'ok' : v >= 60 ? 'warn' : 'bad');
// 考勤**分数**的档位（10 分制，用户 2026-11-12「考勤要显示分数」）：
// 阈值是原百分制档位（90/70）等比 ÷10，判定结果与换刻度前一致 —— 换的是刻度，不是标准。
const attScoreLevel = (v) => (v === null || v === undefined ? 'none' : v >= 9 ? 'ok' : v >= 7 ? 'warn' : 'bad');
const rateText = (v) => (v === null || v === undefined ? '—' : `${v}%`);
// 分数一律两位小数，且「没有考勤数据」显「—」而不是 0.00 分（0 分是最严重的差评，
// 会被截图发进工作群）—— 统一走 utils/format.js::scoreText，与班级页同一口径。
const scoreText = fmt.scoreText;

Page({
  data: {
    chips: CHIPS,
    levelChips: LEVEL_CHIPS,
    metricChips: METRIC_CHIPS,
    columnToggles: COLUMN_TOGGLES,
    copyScopes: COPY_SCOPES,
    dayOptions: DAY_OPTIONS,

    quick: '',
    level: '',
    metric: 'daily',
    days: 7,
    // 日期选择（2026-11-03）：空串 = 今天。选日期后日列/周列/考勤窗口一次联动：
    //   日达标 = 所选当天；周达标 = 所选日所在 ISO 周（周一至该日）；
    //   考勤 = 所选日往前 N 天（考勤按天回看，永远没有「周」语义）。
    selectedDate: '',
    todayKeyText: '',
    dateLabel: '今天',
    attRangeText: '',
    // 显示内容（列表列）：默认日+周，考勤有数据时才自动加上
    columns: { daily: true, weekly: true, attendance: false },
    // 复制内容：默认只复制日达标（用户「如只需要日达标这种的」）
    copyScope: 'daily',
    // 复制口径的 picker 索引与显示文案（预计算，模板不做三元）
    copyScopeIndex: 1,
    copyScopeLabel: '只要日达标',

    loading: true,
    // 失败要显式呈现并给重试入口：上一版只弹 toast 后留空，
    // 于是「后端没部署」和「今天确实没数据」在页面上长得一模一样。
    errorText: '',

    rows: [],
    shown: [],
    today: '',
    from: '',
    weekStart: '',
    totals: null,
    filtered: null,
    activeFilters: [],

    // 院校 / 系部（两级级联）
    schoolLabels: ['全部院校'],
    schoolIndex: 0,
    school: '',
    deptLabels: ['全部系部'],
    deptIndex: 0,
    department: '',
    allDepartments: [], // 未选院校时的全量系部候选

    // 年级多选（2026-11-03）：候选来自服务端 grades（grade 字段 + 班名解析兜底），
    // 筛选本身在服务端做（与文案同源），这里只维护选中态
    gradeChips: [],
    selectedGrades: [],

    keyword: '',

    // 考勤是否真有数据（决定「考勤统计 N 天」那一行和考勤列出不出现在页面上）
    hasAttendance: false,

    metrics: [],
    scopeText: '',
    copyText: '',
    // 预计算展示字段（仓库约定：WXML 不做表达式拼接）
    copyLabel: '复制',
    hasFilter: false,
    emptyTitle: '没有班级数据',
    footerText: '',
    colCount: 3,
    canView: false,
  },

  onLoad() {
    if (!getApp().requireLogin()) return;
    // 日期选择器的上界（北京时区，不让选未来日期）与默认值
    this.setData({ todayKeyText: fmt.todayKey() });
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    adminPerm.applyManage(this, 'class.view').then(() => {
      this.setData({ canView: !!this.data.canManage });
      this.load();
    });
  },

  onHide() {
    clearTimeout(this._debounce);
  },

  onUnload() {
    clearTimeout(this._debounce);
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  // 并发保护：快速连点时慢响应不得覆盖新结果（否则筛选结果会「跳回去」）
  _seq: 0,
  // 全量行缓存（前端留一份是为了切「显示内容」时不重发请求；判定与文案仍来自服务端）
  _raw: [],

  buildQuery() {
    const d = this.data;
    const q = { days: d.days };
    // 选了非今天的日期才传（保持「今天」走服务端默认口径，缓存也最友好）
    if (d.selectedDate) q.today = d.selectedDate;
    if (d.selectedGrades.length) q.grades = d.selectedGrades.join(',');
    if (d.school) q.school = d.school;
    if (d.department) q.department = d.department;
    if (d.quick) q.quick = d.quick;
    if (d.level) {
      q.level = d.level;
      q.metric = d.metric;
    }
    if (d.keyword) q.keyword = d.keyword;
    // 复制口径也传给服务端：文案要按它生成（用户「复制内容…只需要日达标这种的」）
    q.copy = d.copyScope;
    return q;
  },

  async load() {
    const seq = ++this._seq;
    this.setData({ loading: true, errorText: '' });
    try {
      const d = (await auth.get('/api/admin/class/status-board', this.buildQuery())) || {};
      if (seq !== this._seq) return;
      const rows = d.rows || [];
      this._raw = rows;
      const hasFilter = Array.isArray(d.activeFilters) && d.activeFilters.length > 0;
      const scope = hasFilter ? d.filtered : d.totals;
      // 年级候选变化时把不再存在的选中项清掉（如切日期/院校后某年级不再出现）
      const grades = d.grades || [];
      const selectedGrades = grades.length
        ? (this.data.selectedGrades || []).filter((g) => grades.includes(g))
        : this.data.selectedGrades || [];
      // 考勤有没有真数据：决定考勤列与「考勤统计 N 天」那一行出不出现在页面上
      const hasAttendance = rows.some((x) => x.attendance && x.attendance.hasData);
      const columns = { ...this.data.columns };
      if (hasAttendance && !this._touchedColumns) columns.attendance = true;
      if (!hasAttendance) columns.attendance = false;
      this.setData({
        loading: false,
        today: d.today || '',
        from: d.from || '',
        weekStart: d.weekStart || '',
        days: d.days || this.data.days,
        // 联动展示：快捷 chip 文案随日期换词；考勤行标出实际统计区间
        chips: this.chipsFor(),
        attRangeText: d.from ? `${d.from} ~ ${d.today || ''}（早操/早八/晚自习/查宿）` : '',
        gradeChips: (grades.length ? grades : []).map((g) => ({
          key: g,
          label: `${g}级`,
          on: selectedGrades.includes(g),
        })),
        selectedGrades,
        totals: d.totals || null,
        filtered: d.filtered || null,
        activeFilters: d.activeFilters || [],
        hasAttendance,
        columns,
        rows,
        shown: rows.map((r) => this.decorate(r)),
        colCount: (columns.daily ? 1 : 0) + (columns.weekly ? 1 : 0) + (columns.attendance ? 1 : 0),
        // 院校/系部候选（服务端给的是**当前筛选后**的行，所以候选会随选择收窄）
        ...this.buildDeptOptions(d),
        metrics: this.buildMetrics(scope, d),
        scopeText: this.buildScopeText(hasFilter, d),
        copyText: d.copyText || '',
        copyLabel: hasFilter ? '复制筛选结果' : '复制全部',
        ...this.copyScopeView(this.data.copyScope),
        hasFilter,
        emptyTitle: hasFilter ? '当前筛选条件下没有班级' : '没有班级数据',
        footerText: this.buildFooter(d),
      });
    } catch (e) {
      if (seq !== this._seq) return;
      const noPerm = e.code === 403002 || e.code === 403;
      this.setData({
        loading: false,
        rows: [],
        shown: [],
        // 失败时必须把**所有派生展示**一起清掉：上一版只清列表，
        // 于是顶部指标还是旧数字、复制按钮还会吐出过期内容 ——
        // 「看着有数据、其实是上一次的」比直接空着更危险（会被当成最新发到群里）。
        metrics: [],
        totals: null,
        filtered: null,
        activeFilters: [],
        scopeText: '',
        copyText: '',
        copyLabel: '复制',
        hasFilter: false,
        emptyTitle: '没有班级数据',
        footerText: '',
        errorText: noPerm ? '没有查看班级状态的权限（需要 class.view）' : e.message || '加载失败，请下拉重试',
      });
    }
  },

  // 快捷 chip 文案随所选日期联动（选了非今天的日期再说「今日」就是在说谎）
  chipsFor() {
    const custom = !!this.data.selectedDate;
    return CHIPS.map((c) => {
      if (c.key === 'notDaily') return { ...c, label: custom ? '当日未达标' : '今日未达标' };
      if (c.key === 'zeroToday') return { ...c, label: custom ? '当日零达标' : '今日零达标' };
      if (c.key === 'notWeek') return { ...c, label: custom ? '当周未达标' : '本周未达标' };
      return c;
    });
  },

  // 日期选择（2026-11-03）：一次联动日列 / 周列 / 考勤窗口（口径见 data.selectedDate 注释）
  onDate(e) {
    const value = String(e.detail.value || '');
    const isToday = !value || value === this.data.todayKeyText;
    const selectedDate = isToday ? '' : value;
    if (selectedDate === this.data.selectedDate) return;
    this.setData(
      { selectedDate, dateLabel: isToday ? '今天' : value.slice(5), chips: [] },
      () => this.load()
    );
  },

  // 指标条：显示哪几列由 columns 决定（用户要能控制看什么）
  // columns 作为参数传入而不是读 this.data：setData 之前算的时候 this.data 还是旧值，
  // 在 onToggleColumn 里直接算会用上一次的列（勾上考勤、指标条却还少一格）。
  buildMetrics(scope, columns) {
    if (!scope) return [];
    const cols = columns || this.data.columns;
    const custom = !!this.data.selectedDate;
    const out = [
      { k: '班级', v: String(scope.classCount || 0), lv: '' },
      { k: '学生', v: String(scope.studentCount || 0), lv: '' },
    ];
    if (cols.daily) out.push({ k: custom ? '当日达标' : '今日达标', v: rateText(scope.dailyRate), lv: rateLevel(scope.dailyRate) });
    if (cols.weekly) out.push({ k: custom ? '当周达标' : '本周达标', v: rateText(scope.weeklyRate), lv: rateLevel(scope.weeklyRate) });
    return out;
  },

  // 复制口径的展示字段（模板不做三元拼接）
  copyScopeView(key) {
    const idx = COPY_SCOPES.findIndex((s) => s.key === key);
    return { copyScopeIndex: idx < 0 ? 0 : idx, copyScopeLabel: (COPY_SCOPES[idx < 0 ? 0 : idx] || COPY_SCOPES[0]).label };
  },

  buildScopeText(hasFilter, d) {
    if (hasFilter) return `已按「${d.activeFilters.join(' · ')}」筛选 · 全校 ${d.totals.classCount} 个班`;
    if (d.totals && d.totals.skippedClasses) return `实习/毕业班 ${d.totals.skippedClasses} 个不参加考勤与校园跑，已排除`;
    return '';
  },

  // 整句在 JS 拼：模板里写「本周起点 {{weekStart}}」会在字段为空时留下断句
  buildFooter(d) {
    const parts = ['达标 = 步数 ≥ 生效目标（个人计划优先）'];
    if (d.weekStart) parts.push(this.data.selectedDate ? `周起点 ${d.weekStart}` : `本周起点 ${d.weekStart}`);
    // 考勤口径必须写清「10 分制」与早八怎么扣：老师照着这个数字催人，
    // 不知道「9.95 分」是迟到 1 人扣出来的，就会以为统计出错。
    if (this.data.hasAttendance) parts.push(`考勤为 10 分制，按应到人数加权（${d.from} 起），早八每迟到 1 人扣 0.05 分`);
    return `${parts.join('；')}。`;
  },

  // 院校 / 系部候选：从服务端返回的行里取（不查组织架构 —— 组织树里可能有系部但没有班，
  // 列出来选了是空，反而像坏了）
  buildDeptOptions(d) {
    const rows = d.rows || [];
    const schools = [...new Set((d.schools || rows.map((r) => r.schoolName)).filter(Boolean))].sort((a, b) =>
      String(a).localeCompare(String(b), 'zh-CN')
    );
    const allDepts = [...new Set((d.departments || rows.map((r) => r.departmentName)).filter(Boolean))].sort((a, b) =>
      String(a).localeCompare(String(b), 'zh-CN')
    );
    // 已选院校时，系部候选只列该院的（级联收窄，避免选了个该院不存在的系部筛出空）
    const scoped = d.school ? [...new Set(rows.map((r) => r.departmentName).filter(Boolean))] : allDepts;
    const keepDept = (list) => {
      const labels = ['全部系部'].concat(list);
      const idx = this.data.department ? labels.indexOf(this.data.department) : 0;
      return { deptLabels: labels, deptIndex: idx > 0 ? idx : 0 };
    };
    const schoolIdx = Math.max(0, ['全部院校'].concat(schools).indexOf(this.data.school || '全部院校'));
    return {
      schoolLabels: ['全部院校'].concat(schools),
      schoolIndex: schoolIdx,
      ...keepDept(scoped.sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'))),
      allDepartments: allDepts,
    };
  },

  // 只做展示格式化（数字与判定全部来自服务端）
  decorate(r) {
    const run = r.run || {};
    const att = r.attendance || {};
    // 考勤列显示**分数**（10 分制，用户 2026-11-12）；出勤率仍留在副信息里对照，
    // 因为「9.5 分」和「95%」说的是同一件事，但发群里的报告两个都可能出现。
    const attScoreText = scoreText(att.score);
    return {
      className: r.className,
      departmentName: r.departmentName || '',
      schoolName: r.schoolName || '',
      studentCount: r.studentCount || 0,
      dailyText: rateText(run.dailyRate),
      dailyLevel: rateLevel(run.dailyRate),
      weeklyText: rateText(run.weeklyRate),
      weeklyLevel: rateLevel(run.weeklyRate),
      attText: attScoreText,
      attLevel: attScoreLevel(att.score),
      // 分数下面那行小字：迟到人数（分数里扣掉的那一项）。
      // 出勤率**不再重复显示**：分数就是率的折算结果，同一行给两个数只会让人
      // 去核对「9.85 和 98.5% 是不是同一个意思」，反而更慢。
      attSub: att.lateCount ? `迟到 ${att.lateCount} 人` : '',
      // 不参跑的班要标出来：否则「0%」会被误读成没完成，而实际上本班不用跑
      runDisabled: run.enabled === false,
    };
  },

  onChip(e) {
    const key = String((e.currentTarget.dataset || {}).key || '');
    if (key === this.data.quick) return;
    // 快捷筛选与档位筛选二选一：选了 chip 就清掉档位，否则两个条件叠加会把人绕晕
    this.setData({ quick: key, level: '' }, () => this.load());
  },

  onLevel(e) {
    const key = String((e.currentTarget.dataset || {}).key || '');
    if (key === this.data.level) return;
    this.setData({ level: key, quick: '' }, () => this.load());
  },

  onMetric(e) {
    const key = String((e.currentTarget.dataset || {}).key || '');
    if (key === this.data.metric) return;
    this.setData({ metric: key }, () => this.load());
  },

  // 显示内容开关：只改本地列显隐，不重新请求（数据已在手，避免无谓往返）
  onToggleColumn(e) {
    const key = String((e.currentTarget.dataset || {}).key || '');
    const columns = { ...this.data.columns, [key]: !this.data.columns[key] };
    // 三列全关等于没有列表，兜底保留日达标
    if (!columns.daily && !columns.weekly && !columns.attendance) columns.daily = true;
    // 用户手动改过就不再自动勾考勤（否则每次请求都被强制打开，改不动）
    this._touchedColumns = true;
    const colCount = (columns.daily ? 1 : 0) + (columns.weekly ? 1 : 0) + (columns.attendance ? 1 : 0);
    // 传新 columns（不是 {}）：buildMetrics 里若退读 this.data 会拿到 setData 前的旧值
    this.setData({ columns, colCount, metrics: this.buildMetrics(this.data.filtered || this.data.totals, columns) });
  },

  // 复制内容（picker）：传给服务端，文案按它生成（前端不拼一个字）
  onCopyScopePick(e) {
    const idx = Number(e.detail.value) || 0;
    const key = (COPY_SCOPES[idx] || COPY_SCOPES[0]).key;
    if (key === this.data.copyScope) return;
    this.setData({ copyScope: key, ...this.copyScopeView(key) }, () => this.load());
  },

  onDays(e) {
    const days = Number((e.currentTarget.dataset || {}).days) || 7;
    if (days === this.data.days) return;
    this.setData({ days }, () => this.load());
  },

  onSchool(e) {
    const idx = Number(e.detail.value) || 0;
    const label = this.data.schoolLabels[idx] || '';
    this.setData({ schoolIndex: idx, school: idx === 0 ? '' : label, deptIndex: 0, department: '' }, () => this.load());
  },

  onDept(e) {
    const idx = Number(e.detail.value) || 0;
    const label = this.data.deptLabels[idx] || '';
    this.setData({ deptIndex: idx, department: idx === 0 ? '' : label }, () => this.load());
  },

  // 年级多选（2026-11-03）：tap 切换选中，选中集非空即随请求发给服务端
  onGrade(e) {
    const key = String((e.currentTarget.dataset || {}).key || '');
    if (!key) return;
    const cur = this.data.selectedGrades || [];
    const selectedGrades = cur.includes(key) ? cur.filter((g) => g !== key) : cur.concat(key);
    this.setData(
      {
        selectedGrades,
        gradeChips: this.data.gradeChips.map((c) => ({ ...c, on: selectedGrades.includes(c.key) })),
      },
      () => this.load()
    );
  },

  clearGrades() {
    if (!(this.data.selectedGrades || []).length) return;
    this.setData(
      { selectedGrades: [], gradeChips: this.data.gradeChips.map((c) => ({ ...c, on: false })) },
      () => this.load()
    );
  },

  // 输入防抖 400ms：每次按键都发请求会打断服务端 60s 缓存的收益，也没必要
  onKeyword(e) {
    const keyword = String(e.detail.value || '');
    this.setData({ keyword });
    clearTimeout(this._debounce);
    this._debounce = setTimeout(() => this.load(), 400);
  },

  clearKeyword() {
    clearTimeout(this._debounce);
    this.setData({ keyword: '' }, () => this.load());
  },

  resetFilters() {
    this.setData(
      {
        quick: '', level: '', metric: 'daily', school: '', schoolIndex: 0, department: '', deptIndex: 0, keyword: '',
        // 日期与年级也算筛选条件：清除筛选一并回到「今天 / 全部年级」
        selectedDate: '', dateLabel: '今天',
        selectedGrades: [], gradeChips: this.data.gradeChips.map((c) => ({ ...c, on: false })),
      },
      () => this.load()
    );
  },

  // 复制：内容完全来自服务端（已按当前筛选 + 复制口径生成），前端不拼一个字。
  copyText() {
    const text = this.data.copyText;
    if (!text) {
      wx.showToast({ title: this.data.errorText || '还没有可复制的数据', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => {
        const n = this.data.rows.length;
        const scope = COPY_SCOPES.find((s) => s.key === this.data.copyScope);
        wx.showToast({
          title: `已复制 ${n} 个班（${scope ? scope.label : '全部'}）`,
          icon: 'none',
          duration: 2200,
        });
      },
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
    });
  },

  // ===== 生成图片转发（2026-11-03「文本太多被直接发会折叠」）=====
  // 画的是「当前筛选后的展示行表格」（所见即所转）：标题带服务端下发的筛选标签
  // 与班数，数值颜色与列表同一套 level 口径 —— 纯文本报告仍走「复制」（copyText
  // 服务端生成），图片负责不被微信折叠。
  onShareImage() {
    const rows = this.data.shown || [];
    if (!rows.length) {
      wx.showToast({ title: this.data.errorText || '没有可生成的数据', icon: 'none' });
      return;
    }
    const MAX_ROWS = 45; // 43 个班一屏装得下；超出的截断并注明，画布高度也有上限
    const shownRows = rows.slice(0, MAX_ROWS);
    const omitted = rows.length - shownRows.length;

    // 布局（逻辑像素，node 尺寸 ×2 保清晰）
    const W = 750;
    const PAD = 28;
    const titleH = 118;
    const headH = 56;
    const rowH = 54;
    const footH = 120;
    const H = titleH + headH + shownRows.length * rowH + footH;

    const query = wx.createSelectorQuery().in(this);
    query.select('#csShareCanvas').fields({ node: true });
    query.exec((res) => {
      const canvas = res && res[0] && res[0].node;
      if (!canvas) {
        wx.showToast({ title: '画布初始化失败', icon: 'none' });
        return;
      }
      canvas.width = W * 2;
      canvas.height = H * 2;
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      this.drawShareImage(ctx, { W, PAD, titleH, headH, rowH, footH, shownRows, omitted });
      wx.canvasToTempFilePath({
        canvas,
        success: (r) => {
          // 优先拉起「发送给朋友/收藏」的图片分享菜单；低版本基础库回退存相册
          if (wx.showShareImageMenu) {
            wx.showShareImageMenu({
              path: r.tempFilePath,
              fail: () => this.saveShareImage(r.tempFilePath),
            });
          } else {
            this.saveShareImage(r.tempFilePath);
          }
        },
        fail: () => wx.showToast({ title: '生成图片失败，请重试', icon: 'none' }),
      });
    });
  },

  saveShareImage(path) {
    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
      fail: () => wx.showToast({ title: '已生成，保存失败请检查相册权限', icon: 'none' }),
    });
  },

  // 真正的绘制（拆出来便于阅读；颜色与列表 level 口径一致）
  drawShareImage(ctx, { W, PAD, titleH, headH, rowH, footH, shownRows, omitted }) {
    const cols = this.data.columns;
    const C = {
      text: '#1f2329', sub: '#8a919f', line: '#e4e7ec', zebra: '#fafbfc',
      ok: '#16a34a', warn: '#d97706', bad: '#dc2626', brand: '#ff6b00',
    };
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, titleH + headH + shownRows.length * rowH + footH);

    // 标题区：日期 + 筛选口径（服务端标签）+ 班数
    const scope = this.data.filtered || this.data.totals || {};
    const filterText = (this.data.activeFilters || []).join(' · ') || '全校';
    ctx.fillStyle = C.text;
    ctx.font = 'bold 34px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(`班级状态 ${this.data.today || ''}`, PAD, 40);
    ctx.font = '24px sans-serif';
    ctx.fillStyle = C.brand;
    ctx.fillText(`${filterText} · ${scope.classCount || 0} 个班 / ${scope.studentCount || 0} 人`, PAD, 88);

    // 列定义（按「显示内容」）：班级左对齐，其余右对齐定宽
    const numCols = [];
    if (cols.daily) numCols.push({ key: 'daily', head: '日达标', w: 108 });
    if (cols.weekly) numCols.push({ key: 'weekly', head: '周达标', w: 108 });
    if (cols.attendance) numCols.push({ key: 'att', head: '考勤分', w: 100 });
    const stuW = 78;
    const xOf = [];
    let x = W - PAD;
    for (let i = numCols.length - 1; i >= 0; i -= 1) {
      x -= numCols[i].w;
      xOf[i] = x;
    }
    const stuX = x - stuW;

    // 表头
    const headY = titleH;
    ctx.fillStyle = '#f5f6f8';
    ctx.fillRect(PAD, headY, W - PAD * 2, headH);
    ctx.fillStyle = C.sub;
    ctx.font = '22px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('班级', PAD + 12, headY + headH / 2);
    ctx.fillText('学生', stuX, headY + headH / 2);
    numCols.forEach((c, i) => {
      ctx.fillText(c.head, xOf[i], headY + headH / 2);
    });

    // 数据行（隔行浅底，数值按 level 着色，与列表同一套判定）
    const levelColor = (lv) => (lv === 'ok' ? C.ok : lv === 'warn' ? C.warn : lv === 'bad' ? C.bad : C.sub);
    shownRows.forEach((r, idx) => {
      const y = headY + headH + idx * rowH;
      if (idx % 2 === 1) {
        ctx.fillStyle = C.zebra;
        ctx.fillRect(PAD, y, W - PAD * 2, rowH);
      }
      ctx.textAlign = 'left';
      ctx.font = '24px sans-serif';
      ctx.fillStyle = C.text;
      // 班名过长截断（画布上没有 ellipsis，手动截）
      const name = r.className && r.className.length > 13 ? `${r.className.slice(0, 12)}…` : r.className || '';
      ctx.fillText(name, PAD + 12, y + rowH / 2);
      ctx.fillStyle = r.runDisabled ? C.sub : C.text;
      ctx.fillText(r.runDisabled ? '—' : String(r.studentCount || 0), stuX, y + rowH / 2);
      numCols.forEach((c, i) => {
        let text = '—';
        let lv = 'none';
        if (r.runDisabled) {
          text = '不参跑';
          lv = 'none';
        } else if (c.key === 'daily') {
          text = r.dailyText;
          lv = r.dailyLevel;
        } else if (c.key === 'weekly') {
          text = r.weeklyText;
          lv = r.weeklyLevel;
        } else {
          text = r.attText;
          lv = r.attLevel;
        }
        ctx.fillStyle = levelColor(lv);
        ctx.fillText(text, xOf[i], y + rowH / 2);
      });
    });

    // 底部：口径 + 截断说明 + 落款
    const footY = headY + headH + shownRows.length * rowH;
    ctx.textAlign = 'left';
    ctx.fillStyle = C.sub;
    ctx.font = '20px sans-serif';
    ctx.fillText('达标 = 步数 ≥ 生效目标（个人计划优先）· 考勤为 10 分制，按应到人数加权', PAD, footY + 26);
    if (omitted > 0) ctx.fillText(`其余 ${omitted} 个班未列出（共 ${this.data.rows.length} 个）`, PAD, footY + 54);
    ctx.fillStyle = C.brand;
    ctx.fillText('唐唐快跑 · 班级状态', PAD, footY + footH - 26);
    // 顶部分隔线
    ctx.strokeStyle = C.line;
    ctx.beginPath();
    ctx.moveTo(PAD, footY + 8);
    ctx.lineTo(W - PAD, footY + 8);
    ctx.stroke();
  },

  openClass(e) {
    const className = (e.currentTarget.dataset || {}).name;
    if (!className) return;
    wx.navigateTo({ url: `/packageAdmin/class/class?className=${encodeURIComponent(className)}&scope=admin` });
  },

  retry() {
    this.load();
  },
});
