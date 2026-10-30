// 班级状态总览（用户 2026-10-29 建页；2026-10-30 重排 + 加筛选）
//   「增加班级状态页面显示所有班级的考勤、校园跑达标(日、周)，并且可以复制到文本如未达标班级等」
//   「这个页面太难看了，要紧凑排版，并支持筛选，复制时复制的是筛选后的相应内容」
//
// ===== 与「班级管理」的分工 =====
//   · 班级管理 `/packageAdmin/class-manage/class-manage`：改台账（早操/校园跑标记、教室、宿舍）
//   · 本页：只看不改，全校班级一眼看谁没达标，并能一键复制成文字发到工作群
// 权限：class.view（服务端 GET /api/admin/class/status-board）。不新开权限项 ——
//   学生处/年级组长本来就靠 class.view 看班级台账，新开一项会让他们突然失去入口。
//
// ===== 筛选为什么放服务端（本轮最重要的设计决定） =====
// 用户要「复制时复制的是筛选后的相应内容」。可复制文案必须服务端单点生成
// （services/class-status-board.js::buildCopyText —— 前端各拼一次必然漂移成
// 「列表 87%、文案 88%」，老师粘到群里被问住）。
// 那么如果筛选在前端做、文案在服务端做，两者用的就是**不同的行集合**，
// 复制出来的还是全量报告 —— 正是用户这次指出的问题。
// 所以「筛哪些行」也交给服务端（quick / department / keyword），
// 前端只传参数并渲染返回的 rows 与 copyText，本地零计算。
//
// ===== 一排 chips 同时承担「视图」与「筛选」 =====
// 上一版有 tab（总览/未达标/考勤）+ 两个复制按钮，而 tab「未达标」与服务端 quick 语义重叠，
// 于是一行数据可能被两套逻辑各筛一遍。现在合并成一排 chips，每个 chip 就是一次服务端筛选，
// 列的显示内容固定（今日/本周/考勤三格），不再有「换个 tab 换套口径」。
const auth = require('../../utils/request');
const adminPerm = require('../../utils/admin-perm');

// 快捷筛选（value 与服务端 QUICK_FILTERS 的键一一对应，非法值服务端会忽略）
const CHIPS = [
  { key: '', label: '全部班级' },
  { key: 'notDaily', label: '今日未达标' },
  { key: 'zeroToday', label: '今日零达标' },
  { key: 'notWeek', label: '本周未达标' },
  { key: 'attMissing', label: '考勤待补' },
];

const DAY_OPTIONS = [3, 7, 14, 30];

// 达标率色档（阈值与页面语义：100% 绿 / 60% 以上琥珀 / 更低红）
const rateLevel = (v) => (v === null || v === undefined ? 'none' : v >= 100 ? 'ok' : v >= 60 ? 'warn' : 'bad');
const attLevel = (v) => (v === null || v === undefined ? 'none' : v >= 90 ? 'ok' : v >= 70 ? 'warn' : 'bad');
const rateText = (v) => (v === null || v === undefined ? '—' : `${v}%`);

Page({
  data: {
    chips: CHIPS,
    quick: '',
    dayOptions: DAY_OPTIONS,
    days: 7,

    loading: true,
    // 加载失败要**明确显示**并给重试入口。上一版只弹一个 toast 就把列表留空，
    // 于是「后端没部署 / 请求失败」在页面上长得和「今天确实没有数据」一模一样
    // （用户截图里的空白页就是这个，还以为是排版问题）。
    errorText: '',
    rows: [],
    // 展示用的行（在 rows 上补格式化字段；判定一律用服务端数字，前端不再算）
    shown: [],

    today: '',
    from: '',
    weekStart: '',
    // 全校口径（不随筛选变）与筛选后口径
    totals: null,
    filtered: null,
    activeFilters: [],
    // 顶部四个指标：有筛选时用 filtered，否则用 totals —— 在 JS 里选好，WXML 只读
    metrics: [],
    scopeText: '',

    departments: [],
    department: '',
    deptLabels: ['全部系部'],
    deptIndex: 0,

    keyword: '',
    copyText: '',
    // 以下四个都是**展示字段预计算**（仓库约定：WXML 不做表达式拼接）：
    // 模板里写 `{{activeFilters.length ? '筛选结果' : '全部'}}` 这类三元，
    // 一旦字段改名或语义变了不会报错，只会静默显示错文案。
    copyLabel: '复制全部',
    hasFilter: false,
    emptyTitle: '没有班级数据',
    footerText: '',
    canView: false,
  },

  onLoad() {
    if (!getApp().requireLogin()) return;
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

  // 并发保护：快速连点 chip / 连续输入时，慢的响应不能覆盖新的（否则筛选结果会"跳回去"）
  _seq: 0,

  async load() {
    const seq = ++this._seq;
    this.setData({ loading: true, errorText: '' });
    const q = { days: this.data.days };
    if (this.data.quick) q.quick = this.data.quick;
    if (this.data.department) q.department = this.data.department;
    if (this.data.keyword) q.keyword = this.data.keyword;
    try {
      const d = (await auth.get('/api/admin/class/status-board', q)) || {};
      if (seq !== this._seq) return; // 已有更新的请求在飞，丢弃这次
      const rows = d.rows || [];
      const hasFilter = Array.isArray(d.activeFilters) && d.activeFilters.length > 0;
      const scope = hasFilter ? d.filtered : d.totals;
      this.setData({
        loading: false,
        today: d.today || '',
        from: d.from || '',
        weekStart: d.weekStart || '',
        days: d.days || this.data.days,
        totals: d.totals || null,
        filtered: d.filtered || null,
        activeFilters: d.activeFilters || [],
        rows,
        shown: rows.map((r) => this.decorate(r)),
        departments: d.departments || this.data.departments,
        deptLabels: ['全部系部'].concat(d.departments || []),
        // 顶部指标：一次算成数组，WXML 里不做任何表达式拼接（仓库约定）
        // 班级/学生两格刻意**不给色档**（lv 空串）：它们是中性计数，
        // 若套用 'none' 档会被刷成灰色，比达标率还弱 —— 而它们恰恰是这页最重要的两个数。
        metrics: [
          { k: '班级', v: String(scope ? scope.classCount : 0), lv: '' },
          { k: '学生', v: String(scope ? scope.studentCount : 0), lv: '' },
          { k: '今日达标', v: rateText(scope && scope.dailyRate), lv: rateLevel(scope && scope.dailyRate) },
          { k: '本周达标', v: rateText(scope && scope.weeklyRate), lv: rateLevel(scope && scope.weeklyRate) },
        ],
        scopeText: hasFilter
          ? `已按「${d.activeFilters.join(' · ')}」筛选 · 全校 ${d.totals.classCount} 个班`
          : d.totals && d.totals.skippedClasses
            ? `实习/毕业班 ${d.totals.skippedClasses} 个不参加考勤与校园跑，已排除`
            : '',
        copyText: d.copyText || '',
        // 预计算展示字段（与上面 WXML 的引用一一对应）
        hasFilter,
        copyLabel: hasFilter ? '复制筛选结果' : '复制全部',
        emptyTitle: hasFilter ? '当前筛选条件下没有班级' : '没有班级数据',
        // 整句在 JS 拼：weekStart 没到时模板会留下「本周起点 ；」这种断句
        footerText: `达标 = 步数 ≥ 生效目标（个人计划优先）${d.weekStart ? `；本周起点 ${d.weekStart}` : ''}；考勤按应到人数加权，早八只记迟到。`,
      });
    } catch (e) {
      if (seq !== this._seq) return;
      const noPerm = e.code === 403002 || e.code === 403;
      this.setData({
        loading: false,
        rows: [],
        shown: [],
        // ⚠️ 失败时必须把**所有派生展示**一起清掉。上一版只清了列表，
        // 于是报错后顶部指标还是旧数字、复制按钮还会复制过期内容 ——
        // 「看着有数据、其实是上一次的」比直接空着更危险（会被当成最新数据发到群里）。
        metrics: [],
        totals: null,
        filtered: null,
        activeFilters: [],
        scopeText: '',
        copyText: '',
        copyLabel: '复制全部',
        hasFilter: false,
        emptyTitle: '没有班级数据',
        footerText: '',
        // 失败时把错误留在页面上（可重试），而不是留一片看起来像"没数据"的空白
        errorText: noPerm ? '没有查看班级状态的权限（需要 class.view）' : e.message || '加载失败，请下拉重试',
      });
    }
  },

  // 只做展示格式化（数字与判定全部来自服务端）
  decorate(r) {
    const run = r.run || {};
    const att = r.attendance || {};
    return {
      className: r.className,
      departmentName: r.departmentName || '',
      studentCount: r.studentCount || 0,
      dailyText: rateText(run.dailyRate),
      dailyLevel: rateLevel(run.dailyRate),
      dailyCountText: `${run.achievedToday || 0}/${r.studentCount || 0}`,
      weeklyText: rateText(run.weeklyRate),
      weeklyLevel: rateLevel(run.weeklyRate),
      weeklyCountText: `${run.achievedWeek || 0}/${r.studentCount || 0}`,
      attText: att.ratePercent === null || att.ratePercent === undefined ? '—' : `${att.ratePercent}%`,
      attLevel: attLevel(att.ratePercent),
      // 不参跑的班要标出来：否则「0%」会被误读成没完成，而实际上本班不用跑
      runDisabled: run.enabled === false,
    };
  },

  onChip(e) {
    const key = String((e.currentTarget.dataset || {}).key || '');
    if (key === this.data.quick) return;
    this.setData({ quick: key }, () => this.load());
  },

  onDays(e) {
    const days = Number((e.currentTarget.dataset || {}).days) || 7;
    if (days === this.data.days) return;
    this.setData({ days }, () => this.load());
  },

  onDept(e) {
    const idx = Number(e.detail.value) || 0;
    const label = this.data.deptLabels[idx] || '';
    this.setData({ deptIndex: idx, department: idx === 0 ? '' : label }, () => this.load());
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

  // 复制：内容完全来自服务端（已按当前筛选生成），前端不拼一个字。
  copyText() {
    const text = this.data.copyText;
    if (!text) {
      wx.showToast({ title: this.data.errorText || '还没有可复制的数据', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => {
        // 说清复制了什么：筛选态下只复制筛出来的那些班，
        // 不写这句，老师会以为复制的是全校报告（这正是本轮要解决的疑问）
        const n = this.data.rows.length;
        const scoped = this.data.activeFilters && this.data.activeFilters.length;
        wx.showToast({
          title: scoped ? `已复制筛选后的 ${n} 个班` : `已复制全校 ${n} 个班`,
          icon: 'none',
          duration: 2200,
        });
      },
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
    });
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
