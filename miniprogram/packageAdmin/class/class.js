// 我的班级（班主任 / 班委管**自己名下的班**）· 页面内 4 个 tab：学生名单 / 校园跑 / 班超联赛 / 班级配置
// 命名口径（2026-10-19 用户澄清，别再改错）：
//   · **本页页面名与所有入口文案都叫「我的班级」**（管理中枢条目、首页卡片、我的页入口都是）；
//   · 页面内那个原叫「班级考勤」的 tab **改名为「班超联赛」** —— 这才是用户说的「改为班超联赛」
//     （它承载班超评比：总评 / 检查明细 / 趋势 / 最近记录 / 班级榜 + 考勤）；
//   · 管理员管全校所有班级台账的那一页仍叫「班级管理」（packageAdmin/class-manage）。
// 用户原话：「管理中枢的我的班级还是叫我的班级，我只是说我的班级中的之前的班级考勤更为班超联赛」。
// 「班超联赛」tab 已并入原独立页 pages/banchao/banchao（班超详细页，该页已删除）的全部内容。
//
// 为什么是「页面内 tab」而不是 app.json 的 tabBar：本页在 packageAdmin 分包里，
// 原生 tabBar 只能挂主包页面，所以 tab 用页面状态（data.tab + TABS）切换，不改 app.json。
//
// 各 tab 的数据来源与鉴权方式（两套域，别混）：
//   · 学生名单 GET /api/class/students        ┐
//   · 校园跑   GET /api/class/overview        ├ 班级域：服务端用「成员资格」校验（不用 requirePermission）
//             GET /api/class/ranking          ┘ 班主任（homeroomClasses 含该班）可读全量并可督促；班委（isClassOfficer 且同班）只读
//
// 「督促未达标」放在**校园跑** tab（不在学生名单 tab，产品要求：督促的就是校园跑今日未达标）：
//   入口是概况卡下面一行「督促未达标（N）」+ 抽屉，canNudge（=服务端 role==='homeroom' 且非只读）才渲染；
//   N 直接用 overview 的 studentCount − achievedToday，不额外发请求；学生名单 tab 不再有底部固定操作条。
//   学生名单每行的宿舍（roomText，「1号楼·201」）来自 GET /students：服务端按当页 openid 一次查
//   dorm_assignments（在住 checked_in/guest）后 join，没住宿的学生不下发占位值、前端就不显示。
//   · 班级考勤 GET /api/class/attendance      班级域只读，由 C 的 <attendance> 组件自己取数（本页只传 className / refreshAt）
//   · 班级配置 **两条路径二选一**（服务端两套鉴权，字段名一致，共用同一套表单渲染）：
//       ① admin：GET/PUT /api/admin/class/:className/profile —— 管理端接口，requirePermission（GET 要 class.view、PUT 要 class.manage）；
//       ② class：GET/PUT /api/class/profile —— 班级域自助，成员资格校验（**班主任可写、班委只读**），不需要任何管理权限，
//                也不进 requirePermission —— 这样「被设为班主任但没有管理权限」的老师不用等管理员配权限，
//                就能改本班的早操 / 校园跑标记。
//     选路优先级（见 syncProfileCapability）：能 admin 写 → admin；否则有班级身份（班主任 / 班委）→ class；
//     只能 admin 读 → admin（只读）；两条都不通 → **不发请求**，渲染说明卡。
//     前端隐藏不算权限（服务端仍会拦），但也不能把只读用户误导成能改：没有写权限时开关一律 disabled。
//     注意：应到 / 住宿人数一律由服务端自动识别（学籍人数 / 住宿名单），本页只读展示，不提交。
//
// 「不跑操」是两个**独立**配置，界面上分开说明，别让用户以为是同一件事：
//   hasMorningExercise = 本班有没有早操 → 影响早操考勤的应到人数与出勤率分母
//   hasMorningRun      = 本班参不参加校园跑 → 影响校园跑统计 / 班级榜（关掉即「不跑操」）
const auth = require('../../utils/request');
const fmt = require('../../utils/format');
const period = require('../../utils/period');

const PAGE_SIZE = 20;

// 页面内 4 个 tab（第三个 = 原「班级考勤」，2026-10-19 按用户要求改名为「班超联赛」）
const TABS = [
  { key: 'students', label: '学生名单' },
  { key: 'run', label: '校园跑' },
  { key: 'attendance', label: '班超联赛' },
  { key: 'profile', label: '班级配置' },
];

// ===== 「班超联赛」tab：原 pages/banchao/banchao（班超详细页）的全部内容并到这里 =====
// 为什么合并（用户明确）：班超与班级考勤本来就是同一件事的两面 ——
//   考勤看的是「哪个模块出勤多少」，班超看的是「这些检查折算成多少分、全校排第几」，
//   分成两个页面会让老师为了同一批检查记录在两个页面之间来回跳。
// 现在结构：页面上方一个**周期选择器**（今日选日期 / 本周选当月第几周 / 本月选 1-12 月），
//   下面依次是 总评 hero → 检查明细（5 模块）→ 得分趋势 → 最近记录 → 班级榜前三 → 班级考勤组件；
//   考勤组件由这个周期**驱动**（range-from / range-to），所以两半永远是同一个区间、不会打架。
const RANGES = [
  { key: 'day', label: '今日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
];

// 空记录文案的量词（今日 / 本周 / 本月）—— 不能拿 rangeLabel（周会变成「10月第2周」）
const RANGE_WORD = { day: '今日', week: '本周', month: '本月' };

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

// 卫生区类型标签：与服务端 areaType 的 key 同一套（管理端 class-manage 用的是同一份映射）
const AREA_TYPES = {
  classroom: '教室区',
  outdoor: '室外区',
  corridor: '楼道',
  canteen: '食堂',
  other: '其他',
};

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

// 年级展示：「2023」→「2023级」；已是「2023级」就不重复加字（口径见 AGENTS.md 学籍字段约定）
function gradeLabel(grade) {
  const g = String(grade || '').trim();
  if (!g) return '—';
  return /级$/.test(g) ? g : `${g}级`;
}

// ===== 班级配置：表单默认值与归一化 =====
// 默认值取「有早操 + 参加校园跑」（与服务端口径一致：缺省视为 true），
// 这样 B 的接口未就绪 / 字段缺失时界面也不会把班级显示成「不跑操」。
function emptyProfile(className) {
  return {
    className: className || '',
    hasMorningExercise: true,
    hasNightStudy: true,
    hasMorningRun: true,
    studentCount: 0,
    dormCount: 0,
    classroom: '',
    departmentName: '',
    grade: '',
    homeroomNames: [],
    remark: '',
  };
}

// 服务端返回 → 表单（兼容 { profile } / { data } / 直接对象三种包装，接口未定型时不至于白屏）
function toProfile(raw, className, rosterCount) {
  const src = (raw && (raw.profile || raw.data || raw)) || {};
  const names = src.homeroomNames;
  return {
    ...emptyProfile(className),
    ...src,
    className: src.className || className || '',
    hasMorningExercise: src.hasMorningExercise !== false,
    hasNightStudy: src.hasNightStudy !== false,
    hasMorningRun: src.hasMorningRun !== false,
    studentCount: Number(src.studentCount) || 0,
    dormCount: Number(src.dormCount) || 0,
    classroom: src.classroom || '',
    departmentName: src.departmentName || '',
    grade: src.grade || '',
    homeroomNames: Array.isArray(names) ? names.slice() : names ? [String(names)] : [],
    remark: src.remark || '',
    // 学籍人数只用于「应到人数」一栏的提示文案，不是表单字段（保存时不提交）
    rosterCount: Number(rosterCount) || 0,
  };
}

// 只有这几个字段可改（院系 / 年级 / 班主任由学籍与班级身份分配维护，本页只读）
// 教室（classroom）两条路径都开放；人数（studentCount / dormCount）两条路径都只读（服务端自动识别）；
// 卫生区**不在这里**：它是独立资源，走 /sanitary，有自己的抽屉与保存动作。
function profileChanged(form, snap) {
  if (!form || !snap) return false;
  return (
    !!form.hasMorningExercise !== !!snap.hasMorningExercise ||
    !!form.hasNightStudy !== !!snap.hasNightStudy ||
    !!form.hasMorningRun !== !!snap.hasMorningRun ||
    String(form.classroom || '') !== String(snap.classroom || '') ||
    String(form.remark || '') !== String(snap.remark || '')
  );
}

Page({
  data: {
    loading: true,
    role: '', // homeroom | officer | ''
    roleText: '',
    roleTip: '',
    canNudge: false,
    // 班级配置：管理端权限（class.view / class.manage）与班级身份（班主任 / 班委）是两套判定，
    // 最终用哪条路径、能不能改，由 syncProfileCapability() 统一算出来
    canViewAdminProfile: false, // 有 class.view / class.manage / *
    canEditAdminProfile: false, // 有 class.manage / *
    profileSource: '', // '' | 'admin' | 'class'（决定读写的接口路径）
    profileCanEdit: false, // 班级域接口下发的 canEdit（班主任 true / 班委 false）
    canViewProfile: false, // 能读本班配置（两条路径任一可通）
    canManageProfile: false, // 能改（admin 写权限 || 班级域 canEdit）
    // 教室：改用「一个完整对话框」填（用户 2026-10-22：楼名只能选、只有门号能填，且要一次填完）
    teachingBuildings: [], // 教学用楼白名单（系统设置 → 楼名管理）
    roomVisible: false,
    roomValue: '',
    roomSaving: false,
    // 应到 / 住宿人数改为系统自动识别（学籍人数 / 住宿名单），两条路径都只读
    canEditStudentCount: false,
    // 卫生区只看班级域那一条路径（/api/class/sanitary 是成员资格校验，**没有**管理端等价端点可复用）：
    // 所以只有真有班级身份（班主任 / 班委）才发请求。纯管理端只读用户（class.view）在这里看不到卫生区，
    // 但不会收到一个必然 403 的请求 —— 页面里给一行说明指向「班级管理」页。
    canViewAreas: false,
    profileReadonlyTip: '',
    profileReadonlyFoot: '',
    classes: [],
    className: '',
    today: '',
    weekStart: '',
    // ===== tab =====
    tab: 'students',
    tabs: TABS,
    // ===== 校园跑 tab =====
    overview: null,
    classRank: null, // 本班在全校班级榜的名次（{ rank, total, avgSteps, members, top }）
    topStudents: [], // 班内榜单前三（本周步数，/api/class/ranking）
    nudgeCount: 0, // 今日未达标人数（校园跑 tab 的督促入口副文案）：取自 overview，不另发请求
    pointsText: '—', // 本班本周跑分（未启用跑分时显示 —）
    runExcluded: false, // 已读到的配置里 hasMorningRun === false（本班不参加校园跑）
    // ===== 学生名单 tab =====
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
    // ===== 班级考勤 tab：只递增这个计数，组件自己重新取数 =====
    attendanceRefreshAt: 0,
    // ===== 班超 tab（原 pages/banchao/banchao 的全部内容）=====
    // 周期选择：今日选日期 / 本周选当月第几周 / 本月选 1-12 月（口径与班超排名页一致）
    ranges: RANGES,
    range: 'day',
    rangeWord: RANGE_WORD.day,
    banchaoDate: '', // 今日选中日期（YYYY-MM-DD）
    banchaoDateText: '', // 「10月19日」
    banchaoToday: '', // 日期选择上限（**不能用 banchaoDate**，否则选了过去就选不回今天）
    month: 0, // 本周/本月选中的月（1-12）
    monthIndex: 0,
    monthOptions: [],
    banchaoYear: new Date().getFullYear(), // 周/月选项按它算（跨年时以「今天」所在年为准）
    weekNo: 0, // 本周选中的「当月第几周」
    weekIndex: 0,
    weekOptions: [], // label 带日期段：「第2周(10月8日至10月14日)」
    banchao: null, // 总评（服务端 /api/union/class/:className 的 summary）
    banchaoModules: [], // 检查明细（5 个模块）
    banchaoDays: [], // 得分趋势（按日）
    banchaoRecent: [], // 最近记录
    banchaoRankingTop: [], // 班级榜前三
    banchaoLoading: false,
    banchaoPeriodLabel: '', // 服务端回显的区间文案（「10月8日至10月14日」）
    // 班级考勤组件的驱动区间（与上面周期选择器同一个区间）
    attendanceFrom: '',
    attendanceTo: '',
    attendancePeriod: 'day',
    // ===== 班级配置 tab =====
    profile: emptyProfile(''),
    profileSnapshot: null, // 上次加载 / 保存的值，用来判断是否有未保存改动
    profileExists: true, // 服务端 exists：本班是否已有班级配置记录（false 时提示「保存即创建」）
    profileLoaded: false,
    profileLoading: false,
    profileSaving: false,
    profileDirty: false,
    profileError: '', // 加载失败 / 无服务端权限时的说明（不弹错误 toast，页面内提示更清楚）
    gradeText: '—',
    homeroomText: '未分配',
    // ===== 班级配置 tab · 卫生区（独立资源，走 GET/PUT /api/class/sanitary）=====
    // 班级域**只有**班级域路径的卫生区端点（管理端那套按台账 id 走 /api/admin/class/profiles/:id/sanitary，
    // 本页是教师视角，不混用）：能读 = 有班级身份（班主任 / 班委），能写 = 班主任。
    areasLoading: false,
    areasLoaded: false,
    areasError: '',
    myAreas: [], // 本班负责的区域（{ id, name, areaType, typeLabel, location, sharedWith, weight }）
    areaSheetVisible: false,
    areaSheet: null, // { options: [{ id, name, areaType, typeLabel, location, checked, isNew }] }
    newAreaName: '',
    // ===== 督促抽屉（只挂在校园跑 tab）=====
    nudgeVisible: false,
    nudgeLoading: false,
    nudgeList: [],
    nudgeText: '',
  },

  onLoad(options) {
    if (!getApp().requireLogin()) return;
    if (options.className) this.setData({ className: decodeURIComponent(options.className) });
    // 入口 tab 自动适配：
    //   · 显式带 ?tab= 的（「班超联赛 ›」、班超排名点班级）尊重参数；
    //   · 其余（管理中枢 / 我的页 / 首页「我的班级」）按身份落到最常用的那个：
    //     默认落「学生名单」—— 这页的入口名就叫「我的班级」，日常第一件事是看名单；
    //     班超数据从首页班超块 / 班超排名点进来时会显式带 tab=attendance，不受这里影响。
    const wanted = String(options.tab || '');
    if (wanted && TABS.some((t) => t.key === wanted)) {
      this.setData({ tab: wanted, entryTab: wanted });
    } else {
      this.setData({ tab: 'students', entryTab: 'students' });
    }
    this.syncProfileCapability();
    this.load();
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    // 首次进入由 onLoad 负责加载（避免同一份数据请求两次）；
    // 从学生详情等页面返回时刷新当前 tab，保证看到的是最新数据。
    if (!this._loadedOnce) return;
    this.refreshCurrentTab();
  },

  onPullDownRefresh() {
    if (!getApp().requireLogin()) return;
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  onUnload() {
    // 搜索防抖定时器：页面销毁后回调再 setData 会报警告
    this._searchTimer && clearTimeout(this._searchTimer);
  },

  // 班级配置的「能不能看 / 能不能改 / 走哪条路径」：权限项（管理端）与班级身份（班主任 / 班委）
  // 是两个来源，这里合成一份判定，页面只读 data，不再各自判一遍。
  //   选路优先级：能 admin 写 → admin；否则有班级身份 → class（班主任能改本班，不必等管理员配权限）；
  //              只能 admin 读 → admin（只读）；两条都不通 → source 为空 = 不发请求。
  //   '*' = 超级管理员（有效权限通配）。
  syncProfileCapability() {
    const user = getApp().globalData.userInfo || {};
    const perms = user.effectivePermissions || [];
    const star = perms.includes('*');
    const canEditAdminProfile = star || perms.includes('class.manage');
    const canViewAdminProfile = canEditAdminProfile || perms.includes('class.view');
    // 班级身份来自 /api/class/mine 的 role（班主任 / 班委），与权限项无关
    const classRole = this.data.role === 'homeroom' || this.data.role === 'officer';
    const source = canEditAdminProfile ? 'admin' : classRole ? 'class' : canViewAdminProfile ? 'admin' : '';
    const profileCanEdit = this.data.profileCanEdit === true;
    this.setData({
      canEditAdminProfile,
      canViewAdminProfile,
      // 卫生区没有管理端等价端点：只有班级身份那条路径能读（见 data.canViewAreas 的说明）
      canViewAreas: classRole,
      profileSource: source,
      canViewProfile: !!source,
      // 可改 = 管理端给了写权限，或班级域接口回 canEdit:true（班主任）
      canManageProfile: canEditAdminProfile || profileCanEdit,
      // 人数不由前端控制：服务端自动识别，这里恒为 false（保留字段供模板判断）
      canEditStudentCount: false, // 人数不再允许手改
      profileReadonlyTip:
        source === 'class'
          ? '只读模式：班委不能修改班级配置（本班班主任可以改）'
          : '只读模式：修改班级配置需要 class.manage 权限（服务端同样会校验，前端隐藏不等于权限）',
      profileReadonlyFoot:
        source === 'class'
          ? '只读：班委不能修改班级配置，如需调整请联系本班班主任'
          : '只读：如需修改，请联系管理员授予 class.manage 权限',
    });
  },

  // 身份 + 概况 + 榜单，然后拉第一页名单
  async load() {
    try {
      await getApp().ensureLogin();
      this.syncProfileCapability(); // ensureLogin 后 userInfo 可能是刚刷新的（权限随之变化）
      const mine = await auth.get('/api/class/mine');
      if (!mine || !mine.role) {
        this.setData({ loading: false, role: '' });
        this.syncProfileCapability(); // 无班级身份 → 班级域那条路径不通，重算
        return;
      }
      const classes = mine.classes || [];
      const className = this.data.className || classes[0] || '';
      const canNudge = mine.role === 'homeroom' && !mine.readonly;
      this.setData({
        role: mine.role,
        canNudge,
        roleText: canNudge ? '班主任' : '班委 · 仅查看',
        roleTip: canNudge
          ? '可以查看本班名单、校园跑、班级考勤，并在「校园跑」tab 督促今日未达标的学生'
          : '仅查看模式：名单 / 校园跑 / 班级考勤都能看，但不能做任何修改',
        classes,
        className,
      });
      this.syncProfileCapability(); // role 已知 → 班主任 / 班委现在可以走班级域自助路径
      this.initPeriod(); // 周期选择器按「今天」初始化（换班 / 首次进入都要重来一次）
      // 页面标题叫「我的班级」（**不跟着 tab 改名** —— 用户明确：入口与页面仍叫我的班级，
      // 只有页面内那个「班级考勤」tab 改叫「班超联赛」）；
      // 「班级管理」留给管理员管全校台账的那一页（packageAdmin/class-manage）。
      wx.setNavigationBarTitle({ title: `${className || '班级'} · 我的班级` });
      await Promise.all([this.loadOverview(), this.loadRanking(), this.loadStudents(1), this.loadBanchao()]);
      // 当前 tab 需要配置数据时顺手加载（校园跑要先知道「本班参不参加校园跑」）
      if (this.data.canViewProfile && (this.data.tab === 'run' || this.data.tab === 'profile')) this.ensureProfile();
      // 下拉刷新时如果正停在「班超（含班级考勤）」，让挂着的考勤组件重新取数（首次加载不用，attached 时自己会拉）
      if (this._loadedOnce && this.data.tab === 'attendance') this.refreshAttendance();
      this.setData({ loading: false });
      this._loadedOnce = true;
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  // onShow 回来时只刷新当前 tab 的数据（不显示整页 loading，避免闪屏）
  refreshCurrentTab() {
    if (!this.data.className) return;
    const { tab } = this.data;
    if (tab === 'attendance') {
      // 「班超」tab 两半都要刷新：班超数据本页取，考勤由组件自己重取（它已被驱动区间）
      this.loadBanchao();
      this.refreshAttendance();
    } else if (tab === 'profile') {
      if (this.data.canViewProfile) {
        this.loadProfile();
        // 卫生区是独立资源、独立接口：有别的老师改了归属，回到本页要看到最新的
        if (this.data.canViewAreas) this.loadAreas();
      }
    } else if (tab === 'run') {
      this.loadOverview();
      this.loadRanking();
      this.loadStudents(1);
    } else {
      this.loadOverview();
      this.loadStudents(this.data.page);
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
      // 跑分未启用时不显示 0，避免误解成「本班得 0 分」
      pointsText: ov.pointsEnabled ? fmt.formatNumber(ov.pointsWeek) : '—',
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

  // ===== 班超 tab（原 pages/banchao/banchao）=====
  // 周期参数：与班超排名页（packageUnion/stats）完全一致 —— 周 = month + weekNo，月 = month，日 = date。
  // 口径不一致是本项目的已知事故源（同一个「本周」两个页面算出不同区间），改动时请对齐 stats.js。
  banchaoParams() {
    if (this.data.range === 'day') return { date: this.data.banchaoDate };
    const month = `${this.data.banchaoYear}-${period.pad2(this.data.month)}`;
    if (this.data.range === 'week') return { month, weekNo: this.data.weekNo };
    return { month };
  },

  // 本地口径的区间（不依赖接口回显）：供 initPeriod 先把区间填好，
  // 这样「班超」tab 一挂载，考勤组件就拿到合法区间、只发一次请求
  //（等 loadBanchao 回显再填的话，组件会先用自算区间发一次、回显后又发一次 → 首屏两次请求）。
  // 口径与 utils/period.js / 服务端一致，回显到达后会被覆盖成服务端权威值。
  localRange() {
    const y = this.data.banchaoYear;
    const m = this.data.month;
    if (this.data.range === 'day') {
      const d = this.data.banchaoDate || fmt.todayKey();
      return { from: d, to: d };
    }
    if (this.data.range === 'week') {
      const r = period.monthWeekRange(y, m, this.data.weekNo);
      return { from: r.from, to: r.to };
    }
    return {
      from: `${y}-${period.pad2(m)}-01`,
      to: `${y}-${period.pad2(m)}-${period.pad2(period.daysInMonth(y, m))}`,
    };
  },

  // 初始化周期选择器的值（进页面 / 换班时都按「今天」重算一次）
  initPeriod() {
    const today = fmt.todayKey();
    const [y, m] = today.split('-').map(Number);
    const weekNo = period.weekNoOfDate(y, m, today);
    const weekOptions = period.monthWeekOptions(y, m);
    this.setData(
      {
        banchaoToday: today,
        banchaoDate: today,
        banchaoDateText: period.md(today),
        banchaoYear: y,
        month: m,
        monthIndex: m - 1,
        monthOptions: period.monthOptions(y),
        weekNo,
        weekIndex: Math.min(weekNo, weekOptions.length) - 1,
        weekOptions,
        rangeWord: RANGE_WORD[this.data.range] || '今日',
        attendancePeriod: this.data.range,
      },
      () => {
        // 区间立刻算出并交给考勤组件（避免首屏用空区间发一次、回显后再发一次）
        const r = this.localRange();
        this.setData({ attendanceFrom: r.from, attendanceTo: r.to });
      }
    );
  },

  // 拉班超总评 + 模块 + 趋势 + 最近记录 + 榜单（原班超详细页的全部数据，接口与口径都不变）
  async loadBanchao() {
    const className = this.data.className;
    if (!className) return;
    this.setData({ banchaoLoading: true });
    try {
      const data = await auth.get(`/api/union/class/${encodeURIComponent(className)}`, {
        range: this.data.range,
        ...this.banchaoParams(),
      });
      const modules = (data.modules || []).map((m) => ({
        key: m.key,
        name: m.shortName || m.name,
        ownerDeptName: m.ownerDeptName || '',
        entered: m.entered,
        skipped: m.skipped,
        skippedReason: m.skippedReason || '',
        // 未录文案：早八这类「只记异常人」的模块显示「无迟到」（服务端 noRecordText），不是「未录」
        scoreText: m.skipped ? '无' : m.score === null || m.score === undefined ? m.noRecordText || '未录' : String(m.score),
        metricText: m.metricText || '',
        state: m.skipped ? 'skip' : !m.entered ? 'missing' : m.deduct > 0 ? 'warn' : 'done',
      }));
      const days = (data.days || []).map((d) => ({
        date: d.date,
        label: `${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8, 10))}`,
        scoreText: String(d.score),
        percent: Math.max(0, Math.min(100, d.score)),
      }));
      const recent = (data.recent || []).map((r) => ({
        id: r.id,
        moduleName: r.moduleName || '',
        targetName: r.targetName || '',
        dateText: `${Number(r.date.slice(5, 7))}/${Number(r.date.slice(8, 10))}`,
        statusText: r.statusText,
        scoreText: r.deduct ? `-${r.deduct}` : '0',
        appeal: r.appeal,
      }));
      // 区间回显：日/周/月都用服务端的 from～to（比本地算的权威），周还额外带「第N周」说明
      const from = String(data.from || '').slice(0, 10);
      const to = String(data.to || '').slice(0, 10);
      const spanText = from && to ? period.dateRangeText(from, to) : '';
      // 周期选择器与班级考勤组件共用这个区间 → 两半永远同区间（不会一半今天一半本周）
      this.setData({
        banchaoLoading: false,
        banchao: {
          scoreText: data.score === null || data.score === undefined ? '—' : String(data.score),
          rangeLabel: data.periodLabel || data.rangeLabel || '今日',
          recordCount: data.recordCount || 0,
          // 名次必须取**本接口按当前周期**算的那个（data.ranking），不能用 classRank ——
          // classRank 来自 /api/class/overview，口径永远固定为「本周」，
          // 选「今日 / 本月」时会显示成本周名次（原班超页用的就是 data.ranking，合并时差点丢掉）。
          rank: data.ranking || null,
        },
        banchaoModules: modules,
        banchaoDays: days,
        banchaoRecent: recent,
        banchaoRankingTop: (data.rankingTop || []).map((r, i) => ({ ...r, rankNo: i + 1 })),
        banchaoPeriodLabel: spanText,
        rangeWord: RANGE_WORD[this.data.range] || '今日',
        attendanceFrom: from,
        attendanceTo: to,
        attendancePeriod: this.data.range,
      });
    } catch (e) {
      this.setData({ banchaoLoading: false });
      wx.showToast({ title: e.message || '班超数据加载失败', icon: 'none' });
    }
  },

  // 切周期（今日 / 本周 / 本月）：同时刷新班超与班级考勤（两者共用同一个区间）
  onBanchaoRange(e) {
    const range = e.currentTarget.dataset.range;
    if (!range || range === this.data.range) return;
    const rangeWord = RANGE_WORD[range] || '今日';
    // 切到「本周」时把周序号对齐到当前选中的月（避免「2月 + 第6周」这种越界组合）
    if (range === 'week') {
      const weekOptions = period.monthWeekOptions(this.data.banchaoYear, this.data.month);
      const weekNo = Math.min(this.data.weekNo, weekOptions.length);
      this.setData({ range, rangeWord, weekOptions, weekNo, weekIndex: weekNo - 1 }, () => {
        this.syncAttendanceRange();
        this.loadBanchao();
      });
      return;
    }
    this.setData({ range, rangeWord }, () => {
      this.syncAttendanceRange();
      this.loadBanchao();
    });
  },

  // 把当前周期换算成本地区间立刻交给考勤组件（不等班超接口回显），
  // 这样切周期时考勤组件只按最终区间发一次请求；回显到达后 loadBanchao 会再覆盖一次权威值。
  syncAttendanceRange() {
    const r = this.localRange();
    this.setData({ attendancePeriod: this.data.range, attendanceFrom: r.from, attendanceTo: r.to });
  },

  // 今日：选具体日期
  onBanchaoDate(e) {
    const date = e.detail.value;
    if (!date || date === this.data.banchaoDate) return;
    this.setData({ banchaoDate: date, banchaoDateText: period.md(date) }, () => {
      this.syncAttendanceRange();
      this.loadBanchao();
    });
  },

  // 月：切月时同步收敛周选项（周数随月份变化，2 月只有 4 周）
  onBanchaoMonth(e) {
    const idx = Number(e.detail.value) || 0;
    const month = (this.data.monthOptions[idx] || {}).value || 1;
    const weekOptions = period.monthWeekOptions(this.data.banchaoYear, month);
    const weekNo = Math.min(this.data.weekNo, weekOptions.length);
    this.setData({ month, monthIndex: idx, weekOptions, weekNo, weekIndex: weekNo - 1 }, () => {
      this.syncAttendanceRange();
      this.loadBanchao();
    });
  },

  // 本周：选「当月第几周」（选项 label 已带日期段，如「第2周(10月8日至10月14日)」）
  onBanchaoWeek(e) {
    const idx = Number(e.detail.value) || 0;
    const weekNo = (this.data.weekOptions[idx] || {}).value || 1;
    this.setData({ weekNo, weekIndex: idx }, () => {
      this.syncAttendanceRange();
      this.loadBanchao();
    });
  },

  // 点最近记录 → 记录详情（原班超页的行为）
  goBanchaoRecord(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/packageUnion/record/record?id=${id}` });
  },

  // 「全部记录」→ 该班检查记录列表（原班超页的行为）
  goBanchaoRecords() {
    wx.navigateTo({ url: `/packageUnion/records/records?className=${encodeURIComponent(this.data.className)}` });
  },

  // 「完整榜单」→ 班超排名页
  goBanchaoStats() {
    wx.navigateTo({ url: '/packageUnion/stats/stats' });
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

  // ===== tab 切换 =====
  // 统一入口：任何换 tab 都先把督促抽屉收起（抽屉现在只挂在校园跑 tab）。
  // 不能让它带着开着的抽屉被切走：名单里改筛选 / 翻页时抽屉还开着，就会留下两份不同步的未达标数据。
  switchTab(tab) {
    if (!tab || tab === this.data.tab) return false;
    this.setData({ tab, nudgeVisible: false });
    // 换 tab 相当于换一屏内容，回到页面顶部（否则会停在上一屏的滚动位置）
    wx.pageScrollTo({ scrollTop: 0, duration: 200, fail: () => {} });
    if (tab === 'run' || tab === 'profile') this.ensureProfile();
    // 「班超」tab 的班超数据是本页自己取的（考勤组件 attached 时会自拉）：
    // 首次进入 tab 时数据可能已被 onLoad 拉过，但切周期 / 切班后失效过，这里确保是最新的
    if (tab === 'attendance') this.loadBanchao();
    return true;
  },

  onTabTap(e) {
    this.switchTab(e.currentTarget.dataset.tab);
  },

  // 班级考勤由 C 的 <attendance> 组件自己取数（GET /api/class/attendance），本页只传 className。
  // refreshAt 的用法：组件挂在 wx:if 里，**每次切到该 tab 都会重新 attached 并自己拉一次**，
  // 所以切 tab 不需要递增（否则同一次进入会发两次请求）；同样，切班级由组件的 className
  // observer 负责。refreshAt 只用于「组件已经挂着、但数据要重来」的场景：下拉刷新、onShow 回来。
  refreshAttendance() {
    this.setData({ attendanceRefreshAt: this.data.attendanceRefreshAt + 1 });
  },

  // 校园跑 tab 的入口：切到名单 tab 看学生运动明细
  openStudentsTab() {
    this.switchTab('students');
  },

  // 校园跑 tab 的入口：切到名单 tab 并只看今日未达标（只读查看；督促请用校园跑 tab 的入口）
  openUnachieved() {
    this.setData({ achieved: '0', nudgeVisible: false });
    this.switchTab('students');
    this.syncFilterState();
    this.loadStudents(1);
  },

  // 全校班级榜是公开数据，在排行榜页（tabBar 页，必须用 switchTab）
  openPublicRanking() {
    wx.switchTab({ url: '/pages/ranking/ranking' });
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
    this.setData({
      className,
      students: [],
      topStudents: [],
      overview: null,
      classRank: null,
      page: 1,
      pagesTotal: 1,
      pageItems: [],
      total: 0,
      hasMore: false,
      // 班级配置是「按班」的，换班后必须丢弃上一班的表单与快照（canEdit 也随班重判）
      profile: emptyProfile(className),
      profileSnapshot: null,
      profileCanEdit: false,
      profileExists: true,
      profileLoaded: false,
      profileError: '',
      profileDirty: false,
      gradeText: '—',
      homeroomText: '未分配',
      runExcluded: false,
      // 卫生区同样是「按班」的：换班必须丢弃上一班的列表与抽屉，否则另一个班的区域还挂在屏幕上
      areasLoading: false,
      areasLoaded: false,
      areasError: '',
      myAreas: [],
      areaSheetVisible: false,
      areaSheet: null,
      newAreaName: '',
      // 督促抽屉是「按班」的名单：换班必须一起丢弃，否则另一个班的未达标名单还挂在屏幕上
      nudgeVisible: false,
      nudgeList: [],
      nudgeText: '',
      // 班超（原班超详细页）同样是「按班」的数据：不丢弃的话，上面 hero 还是上一个班的名次，
      // 而「检查明细」已经换成新班的（同一屏两个班的数据）—— 这正是原班超页切班时会犯的错。
      banchao: null,
      banchaoModules: [],
      banchaoDays: [],
      banchaoRecent: [],
      banchaoRankingTop: [],
      banchaoPeriodLabel: '',
    });
    this.syncProfileCapability();
    // 换班后周期选择器按「今天」重算（周选项依赖月份/年份），并顺势把区间交给考勤组件。
    // 注意：**不清空 attendanceFrom/To** —— 区间只由周期决定、与班级无关，
    // 清空只会让组件先用自算区间发一次请求（多一次且区间可能不一致）。
    this.initPeriod();
    // 考勤组件若正挂着，className 变化会由组件自己的 observer 触发重新取数（不需要再动 refreshAt）
    wx.setNavigationBarTitle({ title: `${className} · 我的班级` });
    this.loadOverview();
    this.loadRanking();
    this.loadStudents(1);
    this.loadBanchao();
    if (this.data.canViewProfile && (this.data.tab === 'run' || this.data.tab === 'profile')) {
      this.loadProfile();
      // 卫生区只在班级配置 tab 展示（见 ensureProfile 的说明）
      if (this.data.tab === 'profile' && this.data.canViewAreas) this.loadAreas();
    }
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

  // ===== 班级配置 tab =====
  // 按需加载：只有真的要看（校园跑的「不参加校园跑」提示 / 班级配置 tab）才请求
  ensureProfile() {
    if (!this.data.canViewProfile) return;
    if (!this.data.profileLoaded && !this.data.profileLoading) this.loadProfile();
    // 卫生区只在班级配置 tab 展示，且只在「有班级身份」时请求（见 data.canViewAreas 的说明）
    if (this.data.tab === 'profile' && this.data.canViewAreas && !this.data.areasLoaded && !this.data.areasLoading) {
      this.loadAreas();
    }
  },

  // ===== 教室对话框（用户 2026-10-22：一个完整对话框里选楼 + 填门号，一次填完）=====
  // 教室在这个页面上是「随表单一起保存」的字段：对话框只把值写进 profile.classroom，
  // 由页面底部的「保存班级配置」统一提交 —— 不在这里单独发请求，
  // 否则会出现「改教室立刻生效、改早操要再点保存」两套心智模型。
  async openClassroom() {
    if (!this.data.canManageProfile) {
      wx.showToast({ title: '没有修改本班配置的权限', icon: 'none' });
      return;
    }
    // 楼名清单按需加载（页面其它地方用不到，启动时不请求）
    // ⚠️ 走班级域只读接口 /api/class/buildings：班主任填教室不该需要 building.view
    //    （用户 2026-10-22「为什么教师权限组无法获取楼名」）
    if (!this.data.teachingBuildings.length) {
      try {
        const res = await auth.get('/api/class/buildings');
        this.setData({ teachingBuildings: (res && res.teaching) || [] });
      } catch (e) {
        this.setData({ teachingBuildings: [] });
      }
    }
    this.setData({ roomValue: String(this.data.profile.classroom || ''), roomVisible: true });
  },

  onRoomConfirm(e) {
    const d = (e && e.detail) || {};
    const value = String(d.roomText || '').trim().slice(0, 40);
    this.setData({ 'profile.classroom': value, roomVisible: false });
    // 变更需要用户再点「保存班级配置」——给一句提示，避免以为已经存好了
    wx.showToast({ title: '已填入，记得点「保存班级配置」', icon: 'none', duration: 2200 });
  },

  onRoomClear() {
    this.setData({ 'profile.classroom': '', roomVisible: false });
    wx.showToast({ title: '已清空，记得点「保存班级配置」', icon: 'none', duration: 2200 });
  },

  closeRoomDialog() {
    this.setData({ roomVisible: false });
  },

  async loadProfile() {    const className = this.data.className;
    const source = this.data.profileSource;
    if (!className || !source) return;
    this.setData({ profileLoading: true, profileError: '' });
    try {
      // 两条路径的返回字段名一致（presentProfile），因此共用同一套表单渲染
      const res =
        source === 'class'
          ? await auth.get('/api/class/profile', { className })
          : await auth.get(`/api/admin/class/${encodeURIComponent(className)}/profile`);
      this.applyProfile(res, source);
    } catch (e) {
      // 403/403002 = 服务端判权不通过（前端隐藏不算权限）；其余按接口未就绪 / 网络错误提示
      const msg =
        e.code === 403002 || e.code === 403
          ? source === 'class'
            ? '服务端判定你没有查看本班配置的权限（仅班主任 / 班委可读）'
            : '服务端判定你没有查看班级配置的权限（需要 class.view）'
          : e.message || '加载失败';
      this.setData({ profileLoading: false, profileLoaded: false, profileError: msg });
    }
  },

  applyProfile(raw, source) {
    const src = (raw && (raw.profile || raw.data || raw)) || {};
    const profile = toProfile(src, this.data.className, (this.data.overview || {}).studentCount);
    // 班级域路径的写权限由服务端按成员资格下发（班主任 canEdit:true / 班委 false）；
    // 管理端路径没有 canEdit，就按权限项算 —— 两者合成 canManageProfile（见 syncProfileCapability）
    const profileCanEdit = source === 'class' ? src.canEdit === true : this.data.canEditAdminProfile;
    this.setData({
      profile,
      profileSnapshot: { ...profile },
      profileCanEdit,
      profileExists: src.exists !== false,
      profileLoaded: true,
      profileLoading: false,
      profileError: '',
      profileDirty: false,
      gradeText: gradeLabel(profile.grade),
      homeroomText: profile.homeroomNames.length ? profile.homeroomNames.join('、') : '未分配',
      // 「不参加校园跑」提示在校园跑 tab 顶部显示
      runExcluded: profile.hasMorningRun === false,
    });
    this.syncProfileCapability(); // 拿到 canEdit 后重算「可改」
  },

  // 班级配置的三个布尔开关（早操 / 晚自习 / 校园跑）：t-switch change → { value: boolean }
  // 实现是**通用**的（按 data-field 写回 profile[field]），新增开关不需要改这里；
  // 只有「需要联动页面其它状态的」才在下面加 if（如校园跑影响 runExcluded）。
  onProfileSwitch(e) {
    if (!this.data.canManageProfile) return;
    const field = e.currentTarget.dataset.field;
    if (!field) return;
    const value = !!e.detail.value;
    const patch = { [`profile.${field}`]: value };
    // 校园跑开关同时驱动校园跑 tab 的提示，避免两个 tab 说法不一致
    if (field === 'hasMorningRun') patch.runExcluded = value === false;
    this.setData(patch);
    this.syncProfileDirty();
  },

  // 人数输入（原生 input：bindinput → { value: string }）
  onProfileInput(e) {
    if (!this.data.canManageProfile) return;
    const field = e.currentTarget.dataset.field;
    if (!field) return;
    // 应到人数在班级域自助路径不可改（服务端白名单不含它），输入框也是 disabled，这里再兜一层
    if (field === 'studentCount' || field === 'dormCount') return; // 人数自动识别，不接受输入
    this.setData({ [`profile.${field}`]: (e.detail && e.detail.value) || '' });
    this.syncProfileDirty();
  },

  onProfileRemark(e) {
    if (!this.data.canManageProfile) return;
    this.setData({ 'profile.remark': (e.detail && e.detail.value) || '' });
    this.syncProfileDirty();
  },

  syncProfileDirty() {
    this.setData({ profileDirty: profileChanged(this.data.profile, this.data.profileSnapshot) });
  },

  // 保存班级配置：人数不提交（服务端自动识别），只提交开关 / 教室 / 备注
  async saveProfile() {
    if (!this.data.canManageProfile || this.data.profileSaving) return;
    const className = this.data.className;
    const source = this.data.profileSource;
    if (!className || !source) return;
    if (!profileChanged(this.data.profile, this.data.profileSnapshot)) {
      wx.showToast({ title: '没有需要保存的改动', icon: 'none' });
      return;
    }
    const form = this.data.profile;
    // 人数（studentCount / dormCount）不提交：服务端已改为自动识别，传了会被拒绝
    const payload = {
      hasMorningExercise: !!form.hasMorningExercise,
      // 晚自习开关（用户报「班级配置无法关闭晚自习」—— 之前前端没有这个开关、后端 PUT 白名单也没放行）
      hasNightStudy: !!form.hasNightStudy,
      hasMorningRun: !!form.hasMorningRun,
      // 教室：与早操 / 校园跑同一次提交（两条路径的字段名一致，服务端 classroom 最长 40 字，超长由服务端截断）
      classroom: String(form.classroom || ''),
      remark: String(form.remark || ''),
    };
    this.setData({ profileSaving: true });
    try {
      if (source === 'class') {
        // 班级域自助：className 必须一起带上（班主任可能带多个班，服务端要据此选班）
        const res = await auth.put('/api/class/profile', {
          className,
          hasMorningExercise: payload.hasMorningExercise,
          hasNightStudy: payload.hasNightStudy,
          hasMorningRun: payload.hasMorningRun,
          classroom: payload.classroom,
          remark: payload.remark,
        });
        const body = res && (res.profile || res.data || res);
        if (body && (body.hasMorningRun !== undefined || body.exists !== undefined)) {
          // 这条路径返回完整配置：直接采用，避免服务端归一（如备注截断）后显示与库里不一致
          this.setData({ profileSaving: false });
          this.applyProfile(body, 'class');
        } else {
          // 返回体意外为空时退回本地值（人数不在提交字段里）
          const next = {
            ...form,
            hasMorningExercise: payload.hasMorningExercise,
            hasNightStudy: payload.hasNightStudy,
            hasMorningRun: payload.hasMorningRun,
            classroom: payload.classroom,
            remark: payload.remark,
          };
          this.setData({ profile: next, profileSnapshot: { ...next }, profileDirty: false, profileSaving: false });
        }
      } else {
        await auth.put(`/api/admin/class/${encodeURIComponent(className)}/profile`, payload);
        const next = { ...form, ...payload };
        this.setData({ profile: next, profileSnapshot: { ...next }, profileDirty: false, profileSaving: false });
      }
      // 「不参加校园跑」同时驱动校园跑 tab 的提示
      this.setData({ runExcluded: payload.hasMorningRun === false });
      wx.showToast({ title: '已保存', icon: 'success' });
      // 「不参加校园跑」会影响校园跑统计 / 班级榜，保存后顺手刷新概况
      this.loadOverview();
    } catch (e) {
      this.setData({ profileSaving: false });
      const msg =
        e.code === 403002 || e.code === 403
          ? source === 'class'
            ? '没有修改权限（只有班主任可以改本班配置）'
            : '没有修改权限（需要 class.manage）'
          : e.message || '保存失败';
      wx.showToast({ title: msg, icon: 'none' });
    }
  },

  // ===== 班级配置 tab · 卫生区（GET/PUT /api/class/sanitary）=====
  // 语义与管理端 class-manage 的卫生区抽屉一致：改的是「本班加入了哪些区域」，
  // 多班共管的区域只改本班的加入关系与权重，不动别的班。两个区别：
  //   ① 走班级域成员资格校验（班主任可写、班委只读），不是 class.manage；
  //   ② 班委也要能看到本班负责的区域（只读列表），所以读接口班主任 / 班委都通。
  // 取数与展示口径：mine = 本班负责的区域；options = 全部启用区域（供勾选）。
  async loadAreas() {
    const className = this.data.className;
    if (!className || !this.data.canViewAreas) return;
    this.setData({ areasLoading: true, areasError: '' });
    try {
      const res = await auth.get('/api/class/sanitary', { className });
      const mine = (res.mine || []).map((a) => ({
        id: a.id,
        name: a.name,
        areaType: a.areaType || 'outdoor',
        typeLabel: AREA_TYPES[a.areaType] || a.areaType || '',
        location: a.location || '',
        sharedWith: Number(a.sharedWith) || 0,
        // 共用提示：>0 表示还有别的班共管，本班只按权重分摊（不说清老师会以为整区都算自己班）
        sharedText: Number(a.sharedWith) > 0 ? `与另外 ${a.sharedWith} 个班共管 · 按权重分摊` : '本班独管',
        weight: Number(a.weight) || 1,
      }));
      this.setData({ myAreas: mine, areasLoaded: true, areasLoading: false });
    } catch (e) {
      const msg =
        e.code === 403002 || e.code === 403
          ? '服务端判定你没有查看本班卫生区的权限（仅班主任 / 班委可读）'
          : e.message || '加载失败';
      this.setData({ areasLoading: false, areasLoaded: false, areasError: msg });
    }
  },

  // 「选择卫生区」入口：仅班主任（班委只读列表，不给入口；服务端 PUT 也会 403）
  async openAreas() {
    if (!this.data.canManageProfile) return;
    if (this.data.areaSheetVisible) return;
    const className = this.data.className;
    if (!className) return;
    wx.showLoading({ title: '加载中…', mask: true });
    try {
      const data = await auth.get('/api/class/sanitary', { className });
      const mineIds = new Set((data.mine || []).map((a) => a.id));
      this.setData({
        areaSheetVisible: true,
        newAreaName: '',
        areaSheet: {
          className,
          options: (data.options || []).map((a) => ({
            ...a,
            typeLabel: AREA_TYPES[a.areaType] || a.areaType || '',
            checked: mineIds.has(a.id),
          })),
        },
      });
    } catch (e) {
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  toggleArea(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || !this.data.areaSheet) return;
    const list = (this.data.areaSheet.options || []).map((a) => (a.id === id ? { ...a, checked: !a.checked } : a));
    this.setData({ 'areaSheet.options': list });
  },

  // 就地新建区域：全校卫生区没有独立维护页，不支持新建的话新学校老师打开就是空列表 —— 功能等于没有。
  // 同名区域服务端会复用已有的那条，不会建出重复区域（这里也先挡一道，避免用户白填一次）。
  onNewAreaInput(e) {
    this.setData({ newAreaName: (e.detail && e.detail.value) || '' });
  },

  addNewArea() {
    const name = String(this.data.newAreaName || '').trim();
    if (!name) {
      wx.showToast({ title: '先填区域名称', icon: 'none' });
      return;
    }
    if (name.length > 40) {
      wx.showToast({ title: '区域名称过长', icon: 'none' });
      return;
    }
    const sheet = this.data.areaSheet;
    if (!sheet) return;
    const options = sheet.options || [];
    if (options.some((a) => a.name === name)) {
      wx.showToast({ title: '已有同名区域，直接勾选即可', icon: 'none' });
      this.setData({ newAreaName: '' });
      return;
    }
    const id = `new-${options.length + 1}-${Date.now()}`;
    this.setData({
      newAreaName: '',
      'areaSheet.options': options.concat([
        { id, name, areaType: 'outdoor', typeLabel: AREA_TYPES.outdoor, location: '', checked: true, isNew: true },
      ]),
    });
  },

  closeAreas() {
    this.setData({ areaSheetVisible: false, areaSheet: null, newAreaName: '' });
  },

  onAreasVisible() {
    // 抽屉用页面内自绘（cm-sheet 同款），没有 t-popup 的 visible-change；保留此方法供以后换 t-popup
  },

  async saveAreas() {
    if (!this.data.canManageProfile) return;
    const sheet = this.data.areaSheet;
    if (!sheet) return;
    const checked = (sheet.options || []).filter((a) => a.checked);
    // 新建的区域不能把 'new-3' 这种本地 id 发给服务端 —— 只报名字，由服务端建档（同名则复用）
    const areaIds = checked.filter((a) => !a.isNew).map((a) => a.id);
    const newAreas = checked
      .filter((a) => a.isNew)
      .map((a) => ({ name: a.name, areaType: a.areaType || 'outdoor', location: a.location || '' }));
    try {
      const res = await auth.put('/api/class/sanitary', { className: this.data.className, areaIds, newAreas });
      const n = (res.added || []).length + (res.removed || []).length + (res.created || []).length;
      wx.showToast({ title: n ? '已更新本班卫生区' : '没有变化', icon: 'none' });
      this.closeAreas();
      await this.loadAreas();
    } catch (e) {
      const msg =
        e.code === 403002 || e.code === 403
          ? '没有修改权限（只有班主任可以设置本班卫生区）'
          : e.message || '保存失败';
      wx.showToast({ title: msg, icon: 'none' });
    }
  },

  // ===== 督促：列出今日未达标学生（仅班主任，且只在校园跑 tab 有入口）=====
  // 取数说明：nudgeCount 用 overview 的 studentCount − achievedToday（loadOverview 里算），
  // 不为了督促多开一次请求；抽屉里的明细才打 GET /students?achievedToday=0（复用既有筛选参数，
  // 服务端没有督促专用接口 —— 它只生成剪贴板文案，没有任何写入）。
  async openNudge() {
    // 双重门控：入口只在校园跑 tab 渲染，这里再挡一道（直接调方法 / 别的 tab 上残留的点击也不会打开）
    if (!this.data.canNudge || this.data.tab !== 'run') return;
    // 防重复：入口整行 + 右侧按钮绑的是同一个动作（按钮用 catch:tap 阻断冒泡），
    // 再加一道 nudgeLoading 判定，连点也不会打两次 /students
    if (this.data.nudgeLoading) return;
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
