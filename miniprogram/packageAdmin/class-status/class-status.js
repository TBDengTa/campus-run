// 班级状态总览（用户 2026-10-29 建页；10-30 两次重排；11-20 第三轮重排）
//   第一轮：「要紧凑排版，并支持筛选，复制时复制的是筛选后的相应内容」
//   第二轮：「这太难看了…可以查看显示内容与复制内容，如只需要日达标这种的，
//           而且考勤回看是什么，并且没有院系筛选」
//   第三轮（本次）：「选择了班超分要有查看日期并且还要给各班中如有减分情况
//           要写哪个考察项检查扣分如卫生-宿舍、晚自习这样，重新设计各班条的UI样式」
//           + 追加「合计或日均」「一筛选班超分范围就消失」两处修 BUG。
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
//  ② 「可以查看显示内容与复制内容，如只需要日达标这种的」→ 第二轮是两个开关
//     （显示列 + 独立复制口径 picker）；**第三轮删掉复制 picker**，改成口径由显示列
//     自动派生（见 autoCopy）—— 两个 picker 必然会选出「显示三列、只复制日达标」
//     这种自相矛盾的组合，复制出去的文字和屏幕对不上。
//  ③ 「考勤回看是什么」→ 整排选择器在「区间内没有任何检查记录」时**不显示**。
//     第三轮起「有没有检查记录」读服务端顶层 hasAnyCheck（**筛选前**全量口径）：
//     旧版用筛选后的 rows 现算，于是任何把有记录的班筛掉的筛选都会让班超分列
//     与班超分范围行消失（用户报「一筛选班超分范围就不见了」的真 BUG）。
//  ④ 「太难看」→ 见 WXSS：筛选区紧凑工具条，列表从四列表格 → 各班条。
//
// ===== 第三轮的四处结构改动 =====
//  ① 复制口径自动派生：COPY_SCOPE_TEXT + autoCopy(columns)，请求带 copy/att，
//     切显示列后重查（复制正文必须跟着列走）。
//  ② 「班超分范围（本日/本周/本月）+ 口径（日均/合计）」次级筛选行：
//     只在班超分列打开时渲染；口径切换**不重发请求**（两个数服务端都已下发，
//     前端只重新 decorate）；attRange=day 时隐藏口径（合计≡日均）。
//  ③ 行结构重排：左列 班名/学生数·系部/扣分 chips/达标横条，右列 班超分大字+口径副行；
//     班超分列关掉时右列与全部扣分信息都不渲染。单条横条更大、两条更紧凑。
//  ④ 删除 COPY_SCOPES / copyScopeIndex / copyScopeLabel / onCopyScopePick /
//     attRangeText 及对应 picker、旧「考勤统计」行、独立区间条。
//
// ===== 筛选与文案都在服务端 =====
// 可复制文案必须服务端单点生成（前端各拼一次必然漂移成「列表 87%、文案 88%」，
// 老师粘到群里被问住）。若筛选在前端、文案在服务端，两者用的是不同行集合，
// 复制出去仍是全量报告 —— 正是用户第一轮指出的问题。
// 所以前端只传参数（school/department/quick/level/metric/columns/copy/att）并渲染返回结果。
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

// 显示内容（列表列）—— 用户「可以查看显示内容与复制内容，如只需要日达标这种的」。
// 考勤列 2026-11-12 起显示**分数**（10 分制）；
// 2026-11-19 起这一列就是**班超分**（与班超总评同一个数：10 − 各模块日均扣分，**含卫生/查宿**）。
// 标签跟着改成「班超分」—— 用户报的正是「考勤的卫生、查宿等内容没有被减分」，
// 再叫「考勤分」会继续被读成「只算考勤四项」。
const COLUMN_TOGGLES = [
  { key: 'daily', label: '日达标' },
  { key: 'weekly', label: '周达标' },
  { key: 'attendance', label: '班超分' },
];

// ===== 复制口径由「显示列」自动派生（用户 2026-11-20 第三轮）=====
// 旧版有一个独立的「复制」picker：显示三列却只复制日达标、或只显示日达标却复制全部 ——
// 复制出去的文字与屏幕上的表对不上，老师粘贴进工作群就会被问住。
// 现在**只有一份口径**：看的是什么就复制什么，不再让用户选第二套口径。
const COPY_SCOPE_TEXT = { all: '全部', daily: '日达标', weekly: '周达标', att: '班超分' };

/**
 * 由显示列派生复制口径。矩阵：
 *   只开日达标 → copy=daily/att=0；只开周达标 → weekly/0；只开班超分 → att/1；
 *   日+周 → all/0；含班超分的混合 → all/1。
 *
 * `att` 是给服务端的开关（1=页面显示班超分列）：服务端据此决定**复制正文里**要不要写
 * 每行的班超分/考勤待补/考勤规则 —— 列关了却复制出分数，等于把没显示的信息发到群里。
 * 服务端有 60s 缓存，切换显示列时重查一次代价可接受（文案必须跟着列走，见 onToggleColumn）。
 *
 * @param {{daily?:boolean,weekly?:boolean,attendance?:boolean}} columns
 * @returns {{copy:string, att:string}}
 */
function autoCopy(columns) {
  const cols = columns || {};
  const daily = !!cols.daily;
  const weekly = !!cols.weekly;
  const att = !!cols.attendance;
  if (att && !daily && !weekly) return { copy: 'att', att: '1' };
  if (daily && !weekly && !att) return { copy: 'daily', att: '0' };
  if (weekly && !daily && !att) return { copy: 'weekly', att: '0' };
  // 两个及以上指标：正文含全部展示列；带班超分时让服务端补上每行班超分与考勤规则
  return { copy: 'all', att: att ? '1' : '0' };
}

// 班超分口径（用户 2026-11-20 第三轮「合计或日均」）：
// 「这 1.6 分是一周扣的还是平均每天扣的」必须能回答 —— 服务端同时下发日均/合计两个数，
// 前端只切展示口径、不重算（合计 ÷ 天数再 round 会与后端口径差 0.01）。
const DEDUCT_MODE_OPTIONS = [
  { key: 'avg', label: '日均' },
  { key: 'total', label: '合计' },
];

// 考勤统计窗口（用户 2026-11-12「要本日、本周、本月，而不是3天7天这样」）。
// key 与服务端 ATT_RANGES 一一对应；窗口起止由**服务端**按所选日期算（本日/本周/本月
// 都锚定所选日），前端只传 key —— 前端自己算周/月起点迟早和班超的 ISO 周对不上。
const ATT_RANGE_OPTIONS = [
  { key: 'day', label: '本日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
];
const DEFAULT_ATT_RANGE = 'week';

// ===== 导出考勤表（用户 2026-11-20「导出本周/本月考勤表」）=====
// 导出接口与看板**同参**（GET /api/admin/class/status-export），只是窗口只支持本周/本月。
// 当前选中的窗口排第一并标注「（当前）」—— 用户点开浮动菜单时一眼知道默认导哪个。
const EXPORT_RANGES = [
  { key: 'week', label: '本周考勤表' },
  { key: 'month', label: '本月考勤表' },
];

// 扣分来源 chips 的折叠阈值（用户 2026-11-20「各班中如有减分情况要写哪个考察项」）：
// 同一模块最多展开 2 条（卫生底下可能有一堆受检类型，全展开会把一行撑爆）、整行最多 3 条，
// 其余折成「+N」（纯文本，故意不做成可点按钮）。
const DEDUCT_CHIP_MAX = 3;
const DEDUCT_CHIP_PER_MODULE = 2;

// ===== 生成图片的底部规则块布局常量（逻辑像素，画布按 ×2 出图）=====
// 字符预算 = (画布宽 750 − 左右内距 28×2) ÷ 20px 字号 ≈ 34 个汉字。
// 见 wrapCanvasLines 的注释：宁可提前换行，也不能溢出画布（measureText 拿不到，
// 因为画布高度要在拿到 ctx 之前算出来）。
const RULE_LINE_CHARS = 34;
const RULE_LINE_H = 30;
const RULE_TITLE_H = 34;
// 落款那一行的高度（没有规则块时底部就只有它，与改造前的 120 保持同一观感）
const RULE_BRAND_H = 60;

const rateLevel = (v) => (v === null || v === undefined ? 'none' : v >= 100 ? 'ok' : v >= 60 ? 'warn' : 'bad');
// 考勤**分数**的档位（10 分制，用户 2026-11-12「考勤要显示分数」）：
// 阈值是原百分制档位（90/70）等比 ÷10，判定结果与换刻度前一致 —— 换的是刻度，不是标准。
const attScoreLevel = (v) => (v === null || v === undefined ? 'none' : v >= 9 ? 'ok' : v >= 7 ? 'warn' : 'bad');
const rateText = (v) => (v === null || v === undefined ? '—' : `${v}%`);
// '2026-11-17' → '11-17'：区间条只显示月-日（完整日期在上面的日期选择器与脚注里，不重复占宽）
const md = (dateKey) => String(dateKey || '').slice(5);
// 分数一律两位小数，且「没有考勤数据」显「—」而不是 0.00 分（0 分是最严重的差评，
// 会被截图发进工作群）—— 统一走 utils/format.js::scoreText，与班级页同一口径。
const scoreText = fmt.scoreText;

Page({
  data: {
    chips: CHIPS,
    levelChips: LEVEL_CHIPS,
    metricChips: METRIC_CHIPS,
    columnToggles: COLUMN_TOGGLES,
    attRangeOptions: ATT_RANGE_OPTIONS,
    // 班超分口径选项（日均/合计）；只在班超分列打开且窗口不是「本日」时出现
    deductModeOptions: DEDUCT_MODE_OPTIONS,

    quick: '',
    level: '',
    metric: 'daily',
    // 考勤统计窗口：day | week | month（用户 2026-11-12，替代旧的「回看 N 天」）
    attRange: DEFAULT_ATT_RANGE,
    attRangeLabel: '本周',
    // 「口径」在 attRange === 'day' 时隐藏（本日窗口的合计 = 日均，两个按钮没有意义）。
    // 比较放在 JS 里算好：模板不做表达式（仓库约定）。
    showDeductMode: DEFAULT_ATT_RANGE !== 'day',
    // 班超分口径：avg=日均（与分数同一口径）/ total=窗口合计。
    // 切换只重排已有数据（onDeductMode），不重发请求。
    deductMode: 'avg',
    // 服务端下发的考勤计算规则（用户 2026-11-12「要在图片下面标注考勤计算规则」）：
    // 页面脚注与生成图片共用同一份，前端不写一个字 —— 改了单价忘了改说明就是说谎。
    attRuleLines: [],
    attRuleText: '',
    // 日期选择（2026-11-03）：空串 = 今天。选日期后日列/周列/考勤窗口一次联动：
    //   日达标 = 所选当天；周达标 = 所选日所在 ISO 周（周一至该日）；
    //   考勤 = 按 attRange 窗口（本日/本周/本月），同样**锚定所选日**（2026-11-12 改），
    //   但窗口区间是**完整周 / 完整月**（2026-11-19 与班超同源，见服务端 attWindow），
    //   所以区间终点是服务端下发的 attTo，不再是所选日 —— 页面/脚注/图片三处都必须用 attTo。
    selectedDate: '',
    todayKeyText: '',
    dateLabel: '今天',
    // 考勤窗口终点（服务端 d.to 回显；缺失时退回所选日）
    attTo: '',
    // 班超分统计区间说明（用户 2026-11-20「选择了班超分要有查看日期」）：
    // 由服务端回显的窗口起止拼好再下发，模板不做字符串拼接。
    // 2026-11-20 第三轮起这段文案挂在「班超分范围 + 口径」行下方（.cs-att-note），
    // 旧版独立的 `.cs-period` 条不再需要（`attRangeText` 一并删除）。
    periodText: '',
    // 显示内容（列表列）：默认日+周，班超分有任意检查记录时才自动加上
    columns: { daily: true, weekly: true, attendance: false },
    // 服务端回显的复制口径（'all' | 'daily' | 'weekly' | 'att'）：
    // 由 autoCopy(columns) 请求、服务端确认后回显，复制成功的 toast 用它说明复制了什么。
    // 不再是用户可选状态（旧版独立 picker 已删，见 autoCopy 注释）。
    copyScope: '',

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
    canView: false,
    // 导出（2026-11-20）：exporting 同时用于禁用重复点击与按钮文案（导出中）
    exporting: false,
    exportLabel: '导出',
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
  // 全量行缓存（前端留一份是为了切「日均/合计」口径时不重发请求；判定与文案仍来自服务端）
  _raw: [],
  // 「自动打开班超分列后补一次请求」的重入闸门（见 load 里的 needSyncCopy）：
  // 防止极端情况下列自动开/关来回抖动把请求打成死循环。
  _autoSynced: false,

  buildQuery() {
    const d = this.data;
    // 复制口径由**当前显示列**派生（用户 2026-11-20 第三轮）：
    // 旧版是独立 picker，可以「看着三列只复制日达标」，复制出去的内容与屏幕对不上。
    // att 告诉服务端页面有没有显示班超分列 —— 正文是否带每行班超分/考勤规则由它决定。
    const scope = autoCopy(d.columns);
    // 考勤窗口传 key（本日/本周/本月），起止由服务端算 —— 不再传 days（旧「回看 N 天」）
    const q = { attRange: d.attRange, copy: scope.copy, att: scope.att };
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
    return q;
  },

  async load() {
    const seq = ++this._seq;
    // 上一次 load 是「自动打开班超分列后补一次」的（见下面 needSyncCopy）：
    // 只允许补一次，避免极端情况下列/口径来回抖动导致请求打转。
    const autoSynced = this._autoSynced;
    this._autoSynced = false;
    // 本次请求实际发送的复制口径（buildQuery 读的是同一份 this.data.columns）
    const reqScope = autoCopy(this.data.columns);
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
      // 「有没有检查记录」是**系统能力**，不是「当前筛选结果」：
      // 必须读服务端下发的顶层 hasAnyCheck（**筛选前**全量行口径）。
      // ⚠️ 旧实现用筛选后的 rows.some(...) 现算 —— 任何把有记录的班筛掉的筛选
      //   （院系/年级/搜索/快捷 chip）都会让班超分列被强制关掉、班超分范围行消失，
      //   正是用户报「一筛选班超分范围就不见了」的真 BUG。旧后端没有该字段时才回退现算。
      // hasData 仍保留给服务端的「考勤待补」筛选（那个语义是「考勤四项都没录」，没变）。
      const hasAttendance =
        typeof d.hasAnyCheck === 'boolean'
          ? d.hasAnyCheck
          : rows.some((x) => x.attendance && x.attendance.hasAnyCheck);
      const columns = { ...this.data.columns };
      // 自动勾选：有检查记录且用户没手动改过就开列；一条检查都没有则强制关闭。
      if (hasAttendance && !this._touchedColumns) columns.attendance = true;
      if (!hasAttendance) columns.attendance = false;
      // 三列全关等于没有列表：强制关闭班超分时若用户只开了它，兜底保留日达标
      if (!columns.daily && !columns.weekly && !columns.attendance) columns.daily = true;
      // 列被自动打开/关闭后复制口径也跟着变：服务端正文是按**请求时**的 att 生成的，
      // 不补这一次请求，首屏「复制」出来的文字就会与刚显示出来的列对不上
      // （本轮要消灭的就是「显示一套、复制另一套」）。服务端有 60s 缓存，代价可接受。
      const nextScope = autoCopy(columns);
      const needSyncCopy =
        !autoSynced && (nextScope.copy !== reqScope.copy || nextScope.att !== reqScope.att);
      const payload = {
        loading: false,
        today: d.today || '',
        from: d.from || '',
        // 窗口终点（完整周/完整月）：脚注与图片都要用它，不能用 today 顶替（见 periodText 注释）
        attTo: d.to || '',
        weekStart: d.weekStart || '',
        // 窗口以服务端回显为准（非法值会被回退成 week，前端跟着改，否则 chip 与数据不符）
        attRange: d.attRange || this.data.attRange,
        attRangeLabel: d.attRangeLabel || '',
        // 「口径」只在非「本日」窗口出现：本日窗口的合计 = 日均，切了也没意义。
        // 比较放在 JS 里算好 —— 模板不做表达式（仓库约定）。
        showDeductMode: (d.attRange || this.data.attRange) !== 'day',
        attRuleLines: d.attRuleLines || [],
        attRuleText: (d.attRuleLines || []).join('；'),
        chips: this.chipsFor(),
        // 班超分统计区间说明（用户 2026-11-20「选择了班超分要有查看日期」）：
        // 起止只用服务端回显的 from/to（窗口由服务端按所选日算，前端自算必然与班超漂移）。
        // ⚠️ 区间终点用 **d.to**（窗口终点），**不是 d.today**（所选日）：
        //   窗口 2026-11-19 起与班超同源 = **完整周 / 完整月**，本周终点是周日而不是今天。
        //   写 today 会让页面说「11-16 ~ 11-19」而数字里含 20~22 日 ——
        //   老师照着这个区间去核对必然觉得「日周月不一致」（用户报障的第三种表现）。
        //   d.to 缺失 = 后端还是旧版，此时退回 today 至少不说谎。
        // 文案同时解释「分数怎么来」与「合计口径是什么」：老师切到合计后看到的是窗口累计扣分，
        // 若只写「10 − 日均扣分」会以为两处数字是同一口径（本轮已被用户点名过一次「对不上」）。
        periodText: d.from
          ? `${d.attRangeLabel ? `${d.attRangeLabel} ` : ''}${md(d.from)} ~ ${md(d.to || d.today)} · 含卫生/查宿等全部检查 · 班超分 = 10 − 日均扣分（切「合计」看窗口累计扣分）`
          : '',
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
        // 显式传参（不读 this.data.columns/deductMode）：这些值在同一次 setData 里才写入，
        // 仓库已两次踩过「装饰时读到 setData 前的旧值」（buildFooter/buildMetrics 都有注释）。
        shown: rows.map((r) => this.decorate(r, { columns, deductMode: this.data.deductMode })),
        // 院校/系部候选（服务端给的是**当前筛选后**的行，所以候选会随选择收窄）
        ...this.buildDeptOptions(d),
        metrics: this.buildMetrics(scope, columns),
        scopeText: this.buildScopeText(hasFilter, d),
        copyText: d.copyText || '',
        copyLabel: hasFilter ? '复制筛选结果' : '复制全部',
        // 复制口径以服务端回显为准（旧后端没回显时用本次请求的派生值兜底，仍与服务端一致）
        copyScope: d.copyScope || nextScope.copy,
        hasFilter,
        emptyTitle: hasFilter ? '当前筛选条件下没有班级' : '没有班级数据',
        footerText: this.buildFooter(d, hasAttendance),
      };
      if (needSyncCopy) {
        // 列被自动改了 → 先用新列再查一次，**不渲染**这一版（否则会「渲染旧口径 → 闪一下 loading」）。
        // 只把 columns 写回内部状态：下一次 load 的 buildQuery 就会带上正确的 copy/att。
        // _autoSynced 保证最多补一次，正常第二次请求的口径就与列一致了（服务端 60s 缓存，代价可接受）。
        this._autoSynced = true;
        this.setData({ columns });
        return this.load();
      }
      this.setData(payload);
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
        // 规则说明也要清：失败时留着上一次的规则文案，会被当成「数据是新的、只是没刷新」
        attRuleLines: [],
        attRuleText: '',
        // 区间说明同属派生展示：失败后留着它，页面会顶着上一次的统计区间（而数据已空）
        periodText: '',
        // 窗口终点同属派生展示：失败后留着它，图片标题会顶着一个不存在的区间
        attTo: '',
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

  buildScopeText(hasFilter, d) {
    if (hasFilter) return `已按「${d.activeFilters.join(' · ')}」筛选 · 全校 ${d.totals.classCount} 个班`;
    if (d.totals && d.totals.skippedClasses) return `实习/毕业班 ${d.totals.skippedClasses} 个不参加考勤与校园跑，已排除`;
    return '';
  },

  // 整句在 JS 拼：模板里写「本周起点 {{weekStart}}」会在字段为空时留下断句
  //
  // ⚠️ hasAttendance 必须由**调用方传进来**，不能读 this.data.hasAttendance：
  //   本函数在 load() 的那一次 setData 里被调用，而 hasAttendance 是**同一次 setData** 才写入的，
  //   此刻 this.data 还是上一次的旧值 —— 首次进页面永远拿到 false，考勤规则就永远不出现在脚注里。
  //   （仓库里 buildMetrics 已因同一个坑留过注释，这是第二次踩。）
  buildFooter(d, hasAtt) {
    const parts = ['达标 = 步数 ≥ 生效目标（个人计划优先）'];
    if (d.weekStart) parts.push(this.data.selectedDate ? `周起点 ${d.weekStart}` : `本周起点 ${d.weekStart}`);
    // 考勤规则**用服务端下发的句子**（用户 2026-11-12「要标注考勤计算规则，如迟到缺勤等逻辑」）：
    // 以前这里硬编码「每迟到 1 人扣 0.05 分」，单价改了页面不会跟着改 ——
    // 老师照着过时的说明质疑正确的分数，比没有说明更糟。
    if (hasAtt && (d.attRuleLines || []).length) {
      parts.push(`考勤（${d.attRangeLabel || ''}：${d.from} ~ ${d.to || d.today}）：${d.attRuleLines[0]}`);
    }
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
  //
  // view = { columns, deductMode }：**必须由调用方显式传入**（load / onDeductMode），
  // 不读 this.data —— 这些值都写在同一次 setData 里，读 this.data 会拿到上一次的旧值
  // （仓库已在 buildMetrics / buildFooter 上踩过两次，这是第三次，别踩）。
  decorate(r, view = {}) {
    const cols = (view && view.columns) || this.data.columns || {};
    const deductMode = (view && view.deductMode) || this.data.deductMode || 'avg';
    // 班超分列关掉时：chips / 无扣分文案 / 口径行 / 右列**全部不产出**
    // （用户明确要求「不显示班超分时不显示任何扣分信息」）。
    const showAtt = !!cols.attendance;
    const run = r.run || {};
    const att = r.attendance || {};
    // 分数 = 班超分（服务端与班超总评同一个实现，含卫生/查宿扣分）；
    // 出勤率仍下发但不在这行重复显示：分数就是它的折算结果，
    // 同一行给两个数只会让人去核对「9.5 分和 95% 是不是一个意思」。
    const attScoreText = scoreText(att.score);
    // 没有检查记录 ≠ 0 分（0 分是最严重的差评）：右列写人话「无检查记录」而不是「—」
    const hasScore = att.score !== null && att.score !== undefined && att.score !== '';
    // 扣分来源 chips（用户 2026-11-20「各班中如有减分情况要写哪个考察项检查扣分」）：
    // 生成规则见 buildDeductChips —— 同一模块最多 2 条、整行最多 3 条，其余折成 +N。
    const allChips = showAtt ? this.buildDeductChips(att, deductMode) : [];
    const deductChips = allChips.slice(0, DEDUCT_CHIP_MAX).map((c) => ({ key: c.key, text: c.text }));
    const attSub = this.buildAttSub(att);
    const detail = att.deductDetail || [];
    const custom = !!this.data.selectedDate;
    // 达标横条（单/多数据不同排版，见 WXML）：只做**显示出来的**那两列，
    // 不参跑的班不出条（「0%」会被误读成没完成，实际是本班不用跑）。
    const runBars = [];
    if (run.enabled !== false) {
      if (cols.daily) runBars.push(this.buildRunBar('daily', '日达标', run.dailyRate));
      if (cols.weekly) runBars.push(this.buildRunBar('weekly', '周达标', run.weeklyRate));
    }
    const runSingle = runBars.length === 1;
    // 第一行右侧的次要信息（人数 / 系部 / 不参跑）：整句预拼，模板不拼表达式
    const metaParts = [`${r.studentCount || 0}人`];
    if (r.departmentName) metaParts.push(r.departmentName);
    if (run.enabled === false) metaParts.push('不参跑');
    // chips 为空时的替代文案（有记录但没扣分 → 「无扣分」弱文案）。
    // 旧服务不下发 deductDetail 但给了迟到人数时，说「迟到 N 人」比说「无扣分」真实。
    // 没有检查记录时左列留空（右列已经写「无检查记录」，重复两遍反而像两件事）。
    let deductEmptyText = '';
    if (showAtt && !deductChips.length) {
      deductEmptyText = hasScore ? (detail.length ? '无扣分' : attSub || '无扣分') : '';
    }
    return {
      className: r.className,
      studentCount: r.studentCount || 0,
      metaText: metaParts.join(' · '),
      // ---- 旧字段一个不删：分享图片 drawShareImage 直接读 dailyText/weeklyText/attText 与 level ----
      dailyText: rateText(run.dailyRate),
      dailyLevel: rateLevel(run.dailyRate),
      weeklyText: rateText(run.weeklyRate),
      weeklyLevel: rateLevel(run.weeklyRate),
      // 今日/本周达标（选了非今天就说「当日/当周」—— 说「今日」是在说谎）
      dailyRateText: `${custom ? '当日' : '今日'} ${rateText(run.dailyRate)}`,
      weeklyRateText: `${custom ? '当周' : '本周'} ${rateText(run.weeklyRate)}`,
      attText: attScoreText,
      attLevel: attScoreLevel(att.score),
      // 班超分大字：有记录才显示数值；没有记录时右列写「无检查记录」（hasScore 由模板判定）
      hasScore,
      scoreEmptyText: showAtt && !hasScore ? '无检查记录' : '',
      // ---- 本轮新增派生字段（WXML 只渲染，不做任何运算）----
      runBars,
      runSingle,
      // 单/多数据的排版开关：模板不做三元拼接，这里预算成类名
      runbarsClass: runSingle ? 'is-single' : 'is-multi',
      deductChips,
      deductMore: allChips.length > DEDUCT_CHIP_MAX ? allChips.length - DEDUCT_CHIP_MAX : 0,
      deductEmptyText,
      // 右列副行：「日均扣 1.60」/「合计扣 8.00」；扣分为 0 或没有检查记录时为空串
      deductLine: showAtt ? this.buildDeductLine(att, deductMode, hasScore) : '',
      // 扣分明细整句（旧实现保留：分享图/脚本断言用，服务端旧版不下发 targets 时的兜底说明）
      attSub,
      // 不参跑的班要标出来：否则「0%」会被误读成没完成，而实际上本班不用跑
      runDisabled: run.enabled === false,
    };
  },

  // 单条达标横条：{key,label,text,percent,level}。
  // percent 只用于内联宽度（WXML 不做运算）；text 是给右值的「20%」/「—」。
  buildRunBar(key, label, rate) {
    const n = Number(rate);
    return {
      key,
      label,
      text: rateText(rate),
      percent: Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0,
      level: rateLevel(rate),
    };
  },

  /**
   * 班超分右列副行（用户 2026-11-20 第三轮「合计或日均」）：
   *   · 日均 → 服务端 attendance.deduct（与 score 同一个分母）
   *   · 合计 → 服务端 attendance.deductTotal（窗口累计扣分）
   * 数值**不在这里重算**：合计 ÷ 天数再 round 会与后端口径差 0.01，老师当场就能算出来。
   * 只有旧后端缺字段时才兜底：日均用「10 − 分数」反推；合计用「日均 × 有记录天数」，
   * 天数也缺就退回日均（单日窗口下两者本来就相等）—— 宁可比标签少一层信息，也不编造数字。
   * 扣分为 0 或没有检查记录 → 空串（不显示副行）。
   */
  buildDeductLine(att, deductMode, hasScore) {
    if (!hasScore) return '';
    const num = (v) => (v === null || v === undefined ? NaN : Number(v));
    const avgRaw = num(att.deduct);
    const avg = Number.isFinite(avgRaw) ? avgRaw : Math.round((10 - Number(att.score)) * 100) / 100;
    if (!(avg > 0)) return '';
    if (deductMode === 'total') {
      let total = num(att.deductTotal);
      if (!Number.isFinite(total)) {
        const days = num(att.dayCount);
        total = days > 0 ? Math.round(avg * days * 100) / 100 : avg;
      }
      return total > 0 ? `合计扣 ${scoreText(total)}` : '';
    }
    return `日均扣 ${scoreText(avg)}`;
  },

  /**
   * 扣分来源 chips（用户 2026-11-20「各班中如有减分情况要写哪个考察项检查扣分，
   * 如卫生-宿舍、晚自习这样，重新设计各班条的UI样式」）。
   *
   * 服务端 attendance.deductDetail = [{ key, name, deduct }]（name=模块名、deduct=模块日均扣分），
   * 并新增 targets = [{ key, name, avgDeduct, count }]（name 形如「卫生-宿舍」= 具体受检类型）。
   * 2026-11-20 第三轮再新增 totalDeduct（模块与每个 target 的**窗口合计**扣分）：
   * mode='total' 时 chips 全部改用合计口径，与右列副行「合计扣 8.00」对得上；
   * 两套数字都由服务端算好（Σtargets 已调平），前端只挑口径，绝不自己乘天数。
   * 生成规则（三条都是为了让一行既装得下、又说得清）：
   *   ① 有 targets 的模块**展开成多条**（同一模块最多取 2 条最重的 —— 卫生底下受检类型很多）；
   *   ② 没有 targets 的老服务/模块退回「模块名 -0.20」；
   *   ③ 全部按扣分从大到小排，整行最多显示 DEDUCT_CHIP_MAX 条（在 decorate 里切），其余折 +N。
   * 返回的 weight 只用于排序，decorate 只把 { key, text } 下发给模板。
   */
  buildDeductChips(att, mode) {
    const totalMode = mode === 'total';
    const num = (v) => (v === null || v === undefined ? NaN : Number(v));
    // 取当前口径的值；旧后端没有 totalDeduct 时退回日均（这时「合计」只能少一层信息，
    // 不编造一个乘过天数的假合计）。
    const pick = (avg, total) => {
      if (!totalMode) return num(avg);
      const t = num(total);
      return Number.isFinite(t) ? t : num(avg);
    };
    const detail = (att && att.deductDetail) || [];
    const chips = [];
    for (const mod of detail) {
      if (!mod) continue;
      const modDeduct = pick(mod.deduct, mod.totalDeduct);
      const modKey = String(mod.key || mod.name || '');
      const targets = (Array.isArray(mod.targets) ? mod.targets : [])
        .map((t) => ({
          key: String((t && t.key) || (t && t.name) || ''),
          name: String((t && t.name) || ''),
          value: pick(t && t.avgDeduct, t && t.totalDeduct),
        }))
        .filter((t) => t.name && Number.isFinite(t.value) && t.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, DEDUCT_CHIP_PER_MODULE);
      if (targets.length) {
        for (const t of targets) {
          chips.push({
            key: `${modKey}:${t.key}:${chips.length}`,
            weight: t.value,
            text: `${t.name} -${scoreText(t.value)}`,
          });
        }
      } else if (modDeduct > 0 && mod.name) {
        chips.push({
          key: `${modKey}:${chips.length}`,
          weight: modDeduct,
          text: `${mod.name} -${scoreText(modDeduct)}`,
        });
      }
    }
    return chips.sort((a, b) => b.weight - a.weight);
  },

  // 扣分明细兜底文案（2026-11-20 重做行 UI 后它不再独占一行：chips 为空时用它的结果
  // 兜住「旧服务不下发 targets、只有迟到人数」这种场景；模板不做三元拼接 —— 仓库约定）
  // 「卫生 -1.33 · 晚自习 -0.24」 / 超过 2 项时「卫生 -10.00 · 查宿 -0.84 等」
  // 没有明细（满分班）时退回迟到人数；两者都没有就是空串。
  buildAttSub(att) {
    const detail = att.deductDetail || [];
    if (detail.length) {
      const shown = detail.slice(0, 2).map((d) => `${d.name} -${scoreText(d.deduct)}`).join(' · ');
      return detail.length > 2 ? `${shown} 等` : shown;
    }
    return att.lateCount ? `迟到 ${att.lateCount} 人` : '';
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

  // 显示内容开关：列变了 → 复制口径也跟着变，必须重查（复制正文由服务端按 copy/att 生成）。
  // 不重查就会出现「勾上班超分、复制出来却没有班超分」—— 本轮要消灭的正是这种不一致。
  // 服务端有 60s 缓存，多一次往返代价可接受（用户已确认这个取舍）。
  onToggleColumn(e) {
    const key = String((e.currentTarget.dataset || {}).key || '');
    const columns = { ...this.data.columns, [key]: !this.data.columns[key] };
    // 三列全关等于没有列表，兜底保留日达标
    if (!columns.daily && !columns.weekly && !columns.attendance) columns.daily = true;
    // 用户手动改过就不再自动勾班超分（否则每次请求都被强制打开，改不动）
    this._touchedColumns = true;
    // 传新 columns（不是 {}）：buildMetrics 里若退读 this.data 会拿到 setData 前的旧值
    this.setData(
      { columns, metrics: this.buildMetrics(this.data.filtered || this.data.totals, columns) },
      () => this.load()
    );
  },

  // 班超分口径切换（日均/合计）：**不重发请求** —— 服务端两个数都已下发（deduct / deductTotal），
  // 这里只按新口径把已有行重新 decorate。传参而不是读 this.data：deductMode 是同一次 setData
  // 才写入的，读 this.data 会拿到旧口径（仓库已在 buildMetrics/buildFooter 踩过两次）。
  onDeductMode(e) {
    const key = String((e.currentTarget.dataset || {}).key || '');
    if (!key || key === this.data.deductMode) return;
    const columns = this.data.columns;
    this.setData({
      deductMode: key,
      shown: (this._raw || []).map((r) => this.decorate(r, { columns, deductMode: key })),
    });
  },

  // 考勤统计窗口切换（本日/本周/本月，用户 2026-11-12 替代旧的「回看 N 天」）
  onAttRange(e) {
    const key = String((e.currentTarget.dataset || {}).key || '');
    if (!key || key === this.data.attRange) return;
    // showDeductMode 同一次 setData 写入：attRange === 'day' 时「口径」没有意义，隐藏
    this.setData({ attRange: key, showDeductMode: key !== 'day' }, () => this.load());
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
        // 口径用**服务端回显的 copyScope**（不是前端猜）：旧后端不回显时退回「全部」。
        // COPY_SCOPE_TEXT 是唯一的 key→中文映射，前端不再另写一份。
        const scopeText = COPY_SCOPE_TEXT[this.data.copyScope || 'all'];
        wx.showToast({
          title: `已复制 ${n} 个班（${scopeText}）`,
          icon: 'none',
          duration: 2200,
        });
      },
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
    });
  },

  // ===== 导出考勤表（用户 2026-11-20「本周/本月考勤表可导出」）=====
  // 导出的 CSV 由服务端按**与看板完全一致的筛选参数**生成（attRange 用用户刚选的窗口），
  // 所以「屏幕上的筛选口径 = 导出的表」；前端只负责挑窗口、传参、给反馈。
  onExport() {
    if (this.data.exporting) return;
    if (this.data.loading) {
      wx.showToast({ title: '数据加载中，请稍后再导出', icon: 'none' });
      return;
    }
    const cur = this.data.attRange;
    // 当前窗口排第一并标注「（当前）」；导出接口只支持本周/本月，
    // 当前是「本日」时没有可标注的，本周排第一。
    const list = cur === 'month' ? EXPORT_RANGES.slice().reverse() : EXPORT_RANGES.slice();
    const itemList = list.map((r) => (r.key === cur ? `${r.label}（当前）` : r.label));
    wx.showActionSheet({
      itemList,
      success: (res) => {
        const picked = list[Number(res.tapIndex) || 0];
        if (picked) this.exportAttendance(picked.key);
      },
      // 用户取消浮动菜单：静默（取消不是失败，弹提示反而像出错了）
      fail: () => {},
    });
  },

  // 导出参数 = 当前已生效的筛选条件原样带上（与看板同一份 buildQuery），
  // 只换 attRange（用户刚选的窗口）。copy/att 是「生成复制正文」的参数，导出不生成文案，
  // 两个一起去掉（不删 att 会让导出请求带上无意义的列开关）。
  buildExportQuery(rangeKey) {
    const q = this.buildQuery();
    delete q.copy;
    delete q.att;
    q.attRange = rangeKey === 'month' ? 'month' : 'week';
    // 屏幕上的「今天」若来自服务端（用户没手选日期），导出也显式带上：
    // 避免跨零点导出与屏幕统计的不是同一天。
    if (!q.today && this.data.today) q.today = this.data.today;
    return q;
  },

  async exportAttendance(rangeKey) {
    if (this.data.exporting) return;
    const key = rangeKey === 'month' ? 'month' : 'week';
    const label = key === 'month' ? '本月' : '本周';
    this.setData({ exporting: true, exportLabel: '导出中…' });
    // showLoading 带 mask：遮住整页，重复点击根本点不到（setData 的 exporting 是第二道保险）
    wx.showLoading({ title: '导出中…', mask: true });
    try {
      const day = (this.data.today || fmt.todayKey() || '').replace(/-/g, '');
      const fileName = `班级考勤-${label}${day ? `-${day}` : ''}.csv`;
      const res = await auth.downloadAndOpen('/api/admin/class/status-export', {
        query: this.buildExportQuery(key),
        fileName,
        fileType: 'csv',
      });
      this.setData({ exporting: false, exportLabel: '导出' });
      wx.hideLoading();
      // via='share' = CSV 本机打不开、已降级成「发送文件」→ 也算成功（用 Excel/WPS 打开）
      if (res && res.via === 'share') {
        wx.showToast({
          title: '已保存考勤表，发送到文件传输助手后用 Excel/WPS 打开',
          icon: 'none',
          duration: 3200,
        });
      } else {
        wx.showToast({ title: `已导出${label}考勤表`, icon: 'none' });
      }
    } catch (e) {
      this.setData({ exporting: false, exportLabel: '导出' });
      wx.hideLoading();
      wx.showModal({ title: '导出失败', content: this.exportErrorText(e), showCancel: false, confirmText: '知道了' });
    }
  },

  // 失败文案分档（网络 / 无权限 / 登录过期 / 保存 / 打开降级失败）—— 页面直接展示
  exportErrorText(e) {
    const err = e || {};
    const status = Number(err.statusCode) || 0;
    if (err.code === 401 || status === 401) return '登录已过期，请重新登录后再导出。';
    if (err.code === 403 || status === 403) return '没有导出权限（需要 class.view 班级状态查看权限）。';
    if (err.stage === 'save') return err.message || '考勤表已下载，但保存到本机失败，请重试。';
    if (err.stage === 'open') {
      return err.message || '考勤表已下载，但本机无法打开（CSV 需要 Excel / WPS）。请安装后重试，或转发到电脑打开。';
    }
    if (err.network) return err.message || '网络异常，导出失败。请检查网络后重试。';
    return err.message || '导出失败，请稍后重试。';
  },

  // ===== 生成图片转发（2026-11-03「文本太多被直接发会折叠」）=====
  // 画的是「当前筛选后的展示行表格」（所见即所转）：标题带服务端下发的筛选标签
  // 与班数，数值颜色与列表同一套 level 口径 —— 纯文本报告仍走「复制」（copyText
  // 服务端生成），图片负责不被微信折叠。
  //
  // 表格下面必须附**考勤计算规则**（用户 2026-11-12「要在图片下面标注考勤计算规则，
  // 如迟到缺勤等逻辑」）：图片是要发进工作群的，群里的人看不到页面脚注，
  // 只看到「9.85 分」就会问「这分怎么来的」。规则句子来自服务端，前端只负责换行绘制。
  onShareImage() {
    const rows = this.data.shown || [];
    if (!rows.length) {
      wx.showToast({ title: this.data.errorText || '没有可生成的数据', icon: 'none' });
      return;
    }
    const MAX_ROWS = 45; // 43 个班一屏装得下；超出的截断并注明，画布高度也有上限
    const shownRows = rows.slice(0, MAX_ROWS);
    const omitted = rows.length - shownRows.length;

    // 规则块：标题 1 行 + 每条规则按宽度折行（画布没有自动换行，必须自己切）
    const ruleLines = this.data.attRuleLines || [];
    // 区间终点同样是 **attTo（窗口终点）** 而不是 today（见 load() 里 periodText 的同款注释）：
    // 转发的图片是给人当通报用的，区间写错等于整份通报说谎。
    const ruleTitle = `考勤计算规则（${this.data.attRangeLabel || '本周'}：${this.data.from} ~ ${this.data.attTo || this.data.today}）`;
    // 标题不折行（它最长也就 30 字左右），规则条目逐条折行后加「· 」
    const wrapped = ruleLines.length ? [ruleTitle, ...this.wrapCanvasLines(ruleLines, RULE_LINE_CHARS)] : [];
    // 底部布局只算一次（planShareFooter），高度与绘制共用同一份 ——
    // 分两处各算迟早「高度按 A 算、绘制按 B 画」，画布溢出是**静默**的：
    // 图片生成成功、发出去才发现规则被切掉半行，而这图是要进工作群的。
    const foot = this.planShareFooter({ omitted, wrapped });

    // 布局（逻辑像素，node 尺寸 ×2 保清晰）
    const W = 750;
    const PAD = 28;
    const titleH = 118;
    const headH = 56;
    const rowH = 54;
    const footH = foot.footH;
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
      this.drawShareImage(ctx, { W, PAD, titleH, headH, rowH, footH, shownRows, foot });
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

  /**
   * 图片底部布局：达标口径 → 截断说明 → 考勤规则块 → 落款。
   *
   * 返回 footH（总高）与每一行的 y（相对 footY 的偏移），绘制只按这里给的位置画。
   * 单独成函数是因为画布高度必须在**创建画布之前**算出来（先有高度才有 ctx），
   * 而绘制发生在之后 —— 两处各写一遍坐标，改动时漏一处就是内容重叠/被切。
   *
   * @param {{omitted:number, wrapped:string[]}} p wrapped 为空数组 = 后端没给规则
   */
  planShareFooter({ omitted, wrapped }) {
    const lines = [{ text: '达标 = 步数 ≥ 生效目标（个人计划优先）', kind: 'note' }];
    if (omitted > 0) lines.push({ text: `其余 ${omitted} 个班未列出（共 ${this.data.rows.length} 个）`, kind: 'note' });
    if (wrapped && wrapped.length) {
      // 第一条是规则标题（品牌色加粗），其余是规则条目
      lines.push({ text: wrapped[0], kind: 'ruleTitle' });
      for (let i = 1; i < wrapped.length; i += 1) lines.push({ text: wrapped[i], kind: 'rule' });
    }
    let y = 26;
    const placed = [];
    for (const ln of lines) {
      placed.push({ ...ln, y });
      // 规则标题行稍高一点（与条目拉开一档，避免挤成一坨灰字看不出哪句是标题）
      y += ln.kind === 'ruleTitle' ? RULE_TITLE_H : ln.kind === 'note' ? 28 : RULE_LINE_H;
    }
    // 落款固定在底部（与改造前同一位置感），所以 footH 取「内容高度」与「最小底高」的较大者：
    // 没有规则块时也不会让落款贴到分隔线上。
    return { lines: placed, footH: Math.max(RULE_BRAND_H, y + 26) };
  },

  /**
   * 规则条目按宽度折行（canvas 2d 没有自动换行），每条前面加「· 」。
   *
   * 用「字符预算」而不是逐字 measureText：measureText 需要先拿到 ctx，
   * 而画布高度要在创建画布**之前**算出来（先有高度才有 ctx）—— 先有鸡还是先有蛋。
   * 20px 字号下汉字约等于一个全角宽，预算取 (750 - 28*2) / 20 ≈ 34 个汉字；
   * 混排 ASCII（数字/括号）实际更窄，所以只会**提前**换行，不会溢出画布 —— 这个方向是安全的。
   */
  wrapCanvasLines(lines, budget) {
    const out = [];
    const per = Math.max(8, budget - 2); // 扣掉「· 」两个前缀字符
    for (const raw of lines || []) {
      const text = String(raw || '').trim();
      if (!text) continue;
      if (text.length <= per) {
        out.push(`· ${text}`);
        continue;
      }
      for (let i = 0; i < text.length; i += per) {
        out.push(i === 0 ? `· ${text.slice(i, i + per)}` : `  ${text.slice(i, i + per)}`);
      }
    }
    return out;
  },

  saveShareImage(path) {
    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
      fail: () => wx.showToast({ title: '已生成，保存失败请检查相册权限', icon: 'none' }),
    });
  },

  // 真正的绘制（拆出来便于阅读；颜色与列表 level 口径一致）
  drawShareImage(ctx, { W, PAD, titleH, headH, rowH, footH, shownRows, foot }) {
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
    // 「班超分」与页面表头逐字一致（同一列在页面与图片里叫不同名字，看图的人会以为是两个指标）
    if (cols.attendance) numCols.push({ key: 'att', head: '班超分', w: 100 });
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

    // 底部：达标口径 + 截断说明 + **考勤计算规则**（用户 2026-11-12）+ 落款。
    // 每一行的 y 全部来自 planShareFooter（与算高度同一份），这里只负责上色与字号。
    const footY = headY + headH + shownRows.length * rowH;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const ln of foot.lines) {
      if (ln.kind === 'ruleTitle') {
        ctx.fillStyle = C.brand;
        ctx.font = 'bold 20px sans-serif';
      } else {
        ctx.fillStyle = C.sub;
        ctx.font = '20px sans-serif';
      }
      ctx.fillText(ln.text, PAD, footY + ln.y);
    }
    ctx.fillStyle = C.brand;
    ctx.font = '20px sans-serif';
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
