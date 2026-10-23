// 班级考勤汇总（只读自定义组件）
//
// ===== 位置说明（勿再搬回分包）=====
//   本组件在**主包** `components/attendance/`：使用方（packageAdmin/class 班级管理页）在 packageAdmin
//   分包里，而小程序规则是「分包页面只能引用同包或主包的组件」——放 packageUnion 分包会构成跨分包引用，
//   开发者工具能预览、真机注入失败。引用方已登记为 "/components/attendance/attendance"，
//   因此 require 路径是 `../../utils/request`（主包 components 下比 packageUnion/components 少一层，
//   多写一层会让整页 JS 加载失败、白屏）。
//
// ===== 对外契约（父页面引用方式）=====
//   json: { "usingComponents": { "attendance": "/components/attendance/attendance" } }
//   wxml: <attendance className="{{className}}" refreshAt="{{attendanceRefreshAt}}"
//                   bind:ready="onAttendanceReady" bind:error="onAttendanceError" />
//   属性
//     className  String  必填：要看的班级名（与 users.className 同口径）
//     refreshAt  Number  默认 0；父页面把它改成新值（如 Date.now()）即重新拉取
//                        —— 与 components/class-board 同一约定；也可 this.selectComponent('#attendance').reload()
//   事件
//     ready  { className, period, summary }  数据拉取成功（父页面可用来做角标/统计）
//     error  { className, message }          拉取失败（403002 越权、网络异常等）
//   **只读**：组件内没有任何写操作（无提交/修改/督促入口）。
//
// ===== 数据来源（已按 B 交付的真实响应形状对齐）=====
//   GET /api/class/attendance?className=&from=&to=&period=
//   权限走**班级域成员资格校验**（班主任 homeroomClasses / 班委 isClassOfficer），
//   服务端不使用 requirePermission —— 因此这个组件对班委也是可读的。
//
//   真实响应（server/src/routes/class.js 的 GET /attendance）：
//   {
//     className, from, to, role: 'homeroom'|'officer', canNudge,
//     classInfo: { className, studentCount, hasMorningExercise, hasMorningClass, hasMorningRun },
//     days: [ { date, weekday, hasRecord, absentTotal,
//               modules: { [moduleKey]: { moduleKey, name, rateName, should, actual, absent, notReturned,
//                                        leave, late, earlyLeave, violationCount,
//                                        rate(0~1,4位), ratePercent(1位), status, recordId, recordCount } } } ],
//     summary: { from, to, totalDays, recordedDays, skipped: { [moduleKey]: '本班无早操' },
//                absentTotal, notReturnedTotal, avgRate(0~1), ratePercent,
//                [moduleKey]: { name, rateName, skipped, skipReason, days, should, actual, absent,
//                               notReturned, avgRate, ratePercent } }
//   }
//   **三个关键点（踩过的坑，勿改）**：
//     ① summary **本身就是模块 map**：模块字段挂在 summary 的顶层键上（键 = moduleKey），
//        **不是** summary.modules —— 按「数组 / 嵌套 modules」读会让所有单元格显示「未录」；
//     ② days[].modules 是**对象 map**，不是数组；
//     ③ 出勤率优先用 ratePercent（百分数），其次 rate（0~1 比例）。
//   注：服务端 summary 只汇总 ATTENDANCE_MODULES（早操/早八/晚自习/查宿），卫生是打分模块不在其中；
//   days[].modules 则可能含任意模块，因此模块列表以两处键的并集为准。
//
// ===== 为什么前端自己算 from/to =====
//   「今日 / 本周 / 本月」的边界口径必须和服务器一致才算得对。这里按**本地日历**算：
//   本周 = 本周一 → 今天（ISO 周，与 services/goals.js 的周口径、班级域 /overview 的
//   weekStart 一致），本月 = 本月 1 日 → 今天。同时把 period=day|week|month 一起传过去；
//   服务端按 from/to 算边界并回传 from/to，回传值会被优先采用（服务端口径更权威）。
const auth = require('../../utils/request');

// 周期切换项（默认选中第一个 = 今日）
const PERIODS = [
  { key: 'day', value: 'today', label: '今日' },
  { key: 'week', value: 'week', label: '本周' },
  { key: 'month', value: 'month', label: '本月' },
];

// 模块展示名兜底：服务端模块对象里没给 name 时用（键与 check_modules 对齐）
const MODULE_LABELS = {
  hygiene: { name: '教室卫生检查', short: '卫生' },
  study_evening: { name: '晚自习考勤', short: '晚自习' },
  night_dorm: { name: '晚上查宿', short: '查宿' },
  morning_exercise: { name: '早操出勤', short: '早操' },
  morning_class: { name: '早八出勤', short: '早八' },
};

// 模块展示顺序（卫生是打分模块，没有人数口径，排在最后）
const MODULE_ORDER = ['morning_exercise', 'morning_class', 'study_evening', 'night_dorm', 'hygiene'];

// summary 里除模块字段之外的元信息键：解析模块 map 时要跳过（否则会被当成模块）
const SUMMARY_META_KEYS = [
  'from',
  'to',
  'totalDays',
  'recordedDays',
  'skipped',
  'absentTotal',
  'notReturnedTotal',
  'avgRate',
  'ratePercent',
  'rate',
  'modules',
  'days',
  'className',
  'role',
  'canNudge',
  'classInfo',
  'summary',
  'overview',
  'totals',
];

// 模块 key → classInfo 上的开关字段：区间内一条记录都没有时，只有班级属性能判出「本班没有」。
// 注意只映射「考勤类」模块：hasMorningRun 是「不参加校园跑」，与考勤无关，不能拿来判早操。
const CLASS_FLAG_BY_MODULE = {
  morning_exercise: 'hasMorningExercise',
  morning_class: 'hasMorningClass',
};

// （已下线）「每日明细」的渲染上限 —— 该区块按用户口径整块移除，不再需要

// ===== 小工具 =====
const pad2 = (n) => String(n).padStart(2, '0');

// 日历键 YYYY-MM-DD（与全库日历键口径一致：本地时区，不用 toISOString 免得差一天）
function dateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 「本周一」的日历键（ISO 周：周日算上一周的第 7 天）
function mondayKey(base) {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const diff = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - diff);
  return dateKey(d);
}

// 周期 → { from, to }（to 一律是今天：月/周都只看已经过去的日子）
function rangeOf(periodKey, today) {
  if (periodKey === 'week') return { from: mondayKey(today), to: dateKey(today) };
  if (periodKey === 'month') return { from: `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-01`, to: dateKey(today) };
  return { from: dateKey(today), to: dateKey(today) };
}

// 区间文案：与今日不同月时补上月（8月31日 → 9月2日 才不歧义）
function rangeText(from, to, periodKey) {
  if (!from || !to) return '';
  if (periodKey === 'day' || from === to) return `${Number(from.slice(5, 7))}月${Number(from.slice(8, 10))}日`;
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  const left = sameMonth ? `${Number(from.slice(5, 7))}月${Number(from.slice(8, 10))}日` : `${Number(from.slice(5, 7))}/${Number(from.slice(8, 10))}`;
  return `${left} - ${Number(to.slice(5, 7))}月${Number(to.slice(8, 10))}日`;
}

// 候选字段名取数：多个候选里取第一个有效值（读不到返回 null 而不是 0）
function pickNum(src, keys) {
  if (!src || typeof src !== 'object') return null;
  for (const k of keys) {
    const v = src[k];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// 百分数化：口径是「优先 ratePercent（百分数），其次 rate（0~1 比例）」
// ≤1.5 视为比例（与服务端把比例截断到 1.5 的口径一致）
function percent(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const pct = n <= 1.5 && n >= -1.5 ? n * 100 : n;
  return Math.max(0, Math.round(pct));
}

// 按优先级取百分比：先 ratePercent，再 avgRate，最后 rate；都取不到返回 null（显示「—」）
function percentOf(src, preferPercent) {
  const keys = preferPercent ? ['ratePercent', 'avgRate', 'rate'] : ['avgRate', 'ratePercent', 'rate'];
  for (const k of keys) {
    const v = src ? src[k] : undefined;
    if (v === undefined || v === null || v === '') continue;
    const pct = percent(v);
    if (pct !== null) return pct;
  }
  return null;
}

// ===== 概览 / 汇总对象 =====
// 先找嵌套的 summary / overview / totals，再退回顶层平铺（两种响应形状都要支持）
function pickSummary(data) {
  if (!data || typeof data !== 'object') return {};
  const nested = [data.summary, data.overview, data.totals].filter((x) => x && typeof x === 'object');
  for (const c of nested) {
    if (pickNum(c, ['absentTotal', 'absentCount', 'absent']) !== null) return c;
    if (pickNum(c, ['notReturnedTotal', 'notReturnedCount', 'notReturned']) !== null) return c;
    if (pickNum(c, ['ratePercent', 'avgRate']) !== null) return c;
  }
  if (nested.length) return nested[0];
  return data;
}

// 模块项取数（summary 顶层模块字段 / days 里的模块对象都走这里）
// **必须带上 rate / ratePercent / avgRate**：days 的单元格要按「优先 ratePercent」算当天出勤率，
// 早前这里只取人数、把率丢掉，导致有记录的日子也退化成「缺勤 N」而不是「98%」。
// 率本身仍由 percentOf() 做「ratePercent → avgRate → rate」的优先级换算，这里只负责透传。
function moduleFields(src) {
  const d = src && typeof src === 'object' ? src : {};
  return {
    name: d.name || '',
    rateName: d.rateName || '出勤率',
    should: pickNum(d, ['should', 'shouldCount', 'shouldStay']),
    actual: pickNum(d, ['actual', 'actualCount', 'actualStay']),
    absent: pickNum(d, ['absent', 'absentCount']),
    notReturned: pickNum(d, ['notReturned', 'notReturnedCount', 'unreturned']),
    rate: pickNum(d, ['rate']),
    ratePercent: pickNum(d, ['ratePercent']),
    avgRate: pickNum(d, ['avgRate']),
    skipped: d.skipped === true,
    skipReason: d.skipReason || '',
    // 「没有记录 = 正常」的模块（早八：只记迟到人）：未录时显示 noRecordText（「无迟到」）而不是「未录」
    optionalWhenMissing: d.optionalWhenMissing === true,
    noRecordText: d.noRecordText || '',
  };
}

// 模块聚合数组：以 summary 的顶层模块键为准（区间内没记录的模块也在里面），
// 补上 days 里出现过的模块键，最后用 MODULE_ORDER 排序
function normalizeModules(data) {
  const summary = pickSummary(data);
  const classInfo = (data && data.classInfo) || {};
  const skippedMap = (summary && summary.skipped) || {};
  // days 里出现过的模块键（服务端 summary 只含考勤模块，days 里可能有别的）
  const dayKeys = [];
  for (const day of (data && Array.isArray(data.days) ? data.days : [])) {
    const map = day && day.modules && typeof day.modules === 'object' ? day.modules : {};
    for (const k of Object.keys(map)) if (k && dayKeys.indexOf(k) < 0) dayKeys.push(k);
  }
  const keys = [];
  const push = (k) => {
    if (!k || keys.indexOf(k) >= 0 || SUMMARY_META_KEYS.indexOf(k) >= 0) return;
    if (typeof summary[k] !== 'object' || summary[k] === null) return; // 模块字段必须是对象
    keys.push(k);
  };
  if (summary && typeof summary === 'object') for (const k of Object.keys(summary)) push(k);
  for (const k of dayKeys) if (keys.indexOf(k) < 0) keys.push(k);

  const list = keys.map((key) => {
    const f = moduleFields(summary[key]);
    const fallback = MODULE_LABELS[key] || {};
    const name = f.name || fallback.name || key;
    const short = fallback.short || name;
    // 「本班没有这个模块」判定看两处：
    //   ① summary[key].skipped === true（配 skipReason 文案）；
    //   ② classInfo.hasMorningExercise / hasMorningClass === false —— 区间内一条记录都没有时，
    //      只有班级属性能判出来（否则无早操班级每天都显示「未录」，老师会以为是自己漏录了）。
    const flagField = CLASS_FLAG_BY_MODULE[key];
    const flagOff = !!(flagField && classInfo[flagField] === false);
    const mapReason = skippedMap[key];
    const off = f.skipped || flagOff || !!mapReason;
    // 文案直接用服务端的 skipReason / skipped map，前端不另写一套
    const offText = f.skipReason || (typeof mapReason === 'string' ? mapReason : '') || '本班无';
    const rate = off ? null : percentOf(summary[key], true);
    // 卫生是打分模块：没有人数口径，也不参与出勤率平均
    // TODO（理想做法）：由服务端在 check_modules.metrics 上标记 kind（rate 出勤率 / score 打分），
    // 前端按 kind 判断，而不是像现在这样写死模块 key —— 这样以后加「实验室卫生」这类打分模块不用改前端。
    // 本轮先硬编码（主协调者已知，暂不作为阻塞项）。
    const isScoreModule = key === 'hygiene';
    const hasRate = !off && !isScoreModule && (rate !== null || f.should !== null);
    // 「只记异常人」的模块（早八）：没人迟到是常态 → 未录文案用 noRecordText（「无迟到」）
    const optionalMissing = f.optionalWhenMissing;
    return {
      key,
      name,
      short,
      rateName: f.rateName,
      rate,
      optionalWhenMissing: optionalMissing,
      noRecordText: f.noRecordText || (optionalMissing ? '无迟到' : ''),
      // 无早操的班级显示服务端文案（如「本班无早操」）而不是 0
      rateText: off ? offText : rate === null ? '—' : `${rate}%`,
      off,
      offText,
      isScoreModule,
      hasRate,
      muted: off || !hasRate,
      full: hasRate && rate !== null && rate >= 100,
      should: f.should,
      actual: f.actual,
      absent: f.absent,
      notReturned: f.notReturned,
      days: pickNum(summary[key], ['days']) === null ? 0 : Number(summary[key].days) || 0,
    };
  });

  const rank = (k) => {
    const i = MODULE_ORDER.indexOf(k);
    return i < 0 ? 99 : i;
  };
  return list.sort((a, b) => rank(a.key) - rank(b.key) || String(a.key).localeCompare(String(b.key)));
}

// ===== 概览（各模块区间平均出勤率 + 累计缺勤 + 未归）=====
// recordedDaysFallback：服务端没下发 summary.recordedDays 时，用「days 里有记录的天数」兜底。
function normalizeSummary(data, modules, recordedDaysFallback) {
  const sum = pickSummary(data);
  const ratePercentRaw = pickNum(sum, ['ratePercent']);
  const avgRateRaw = pickNum(sum, ['avgRate', 'rate']);
  // 平均出勤率**优先用服务端的加权值**（否则同一个班在班级页与考勤 tab 会显示两个不同的平均分）；
  // 服务端没给时才退回「各模块出勤率的简单平均」，并用 avgFromServer=false 标出这是本地兜底。
  let avg = ratePercentRaw !== null ? percent(ratePercentRaw) : avgRateRaw !== null ? percent(avgRateRaw) : null;
  const avgFromServer = avg !== null;
  if (avg === null) {
    const rates = (modules || []).filter((m) => m.hasRate && !m.off && m.rate !== null).map((m) => m.rate);
    if (rates.length) avg = Math.round(rates.reduce((a, b) => a + b, 0) / rates.length);
  }
  const absent = pickNum(sum, ['absentTotal', 'absentCount', 'absent']);
  const notReturned = pickNum(sum, ['notReturnedTotal', 'notReturnedCount', 'notReturned']);
  // 天数：以服务端的 recordedDays 为准，没给就用调用方数好的兜底值
  const recordedDays = pickNum(sum, ['recordedDays']);
  const coveredDays = recordedDays === null ? Number(recordedDaysFallback) || 0 : recordedDays;
  const totalDays = pickNum(sum, ['totalDays']);
  const modulesOut = (modules || [])
    // 打分模块（卫生）不上出勤率卡；「本班无」的模块保留（显示服务端文案，不显示 0）
    .filter((m) => !m.isScoreModule && (m.hasRate || m.off))
    .map((m) => ({
      key: m.key,
      short: m.short,
      name: m.name,
      rateName: m.rateName,
      rateText: m.rateText,
      muted: m.muted,
      hasRate: m.hasRate,
      full: m.full,
    }));
  return {
    avg,
    avgText: avg === null ? '—' : `${avg}%`,
    avgFromServer,
    absent,
    notReturned,
    // 服务端没给汇总数字时（estimated=true）前端不做估算，直接显示「—」：宁可空，不给错数
    estimated: absent === null || notReturned === null,
    days: coveredDays,
    totalDays,
    from: String(sum.from || (data && data.from) || '').slice(0, 10),
    to: String(sum.to || (data && data.to) || '').slice(0, 10),
    modules: modulesOut,
    // 模块数 = 0 说明服务端没下发模块定义 → 页面显示「暂无考勤数据」而不是一堆 0
    hasAny: modulesOut.length > 0,
  };
}

// ===== 区间内「有记录的天数」=====
// 用户 2026-10-19 口径：「不需要每日啊，咱们已经有筛选了」——
// 「每日明细（按日期倒序）」整块已不再渲染（页面顶部已有 今日/本周/本月 + 日期筛选），
// 这里只保留概览卡需要的**天数**统计，不再构造每天的单元格。
// （原来这里还会算每天每个模块的出勤率文案，那套逻辑随「每日明细」一起下线。）
function countRecordedDays(data) {
  const list = Array.isArray(data && data.days) ? data.days : [];
  return list.filter((row) => {
    if (!row) return false;
    if (row.hasRecord === true) return true;
    const raw = row.modules && typeof row.modules === 'object' && !Array.isArray(row.modules) ? row.modules : {};
    return Object.keys(raw).length > 0;
  }).length;
}

Component({
  options: {
    // 组件里要用 app.wxss 的 --tt-* 令牌与 .num-font / .tt-card 等公共类，
    // 默认的 isolated 会在组件内看不到这些公共样式（class-board 同样开这个）
    styleIsolation: 'apply-shared',
    multipleSlots: false,
  },

  properties: {
    // 必填：要看哪个班（班主任多班时由父页面切换）
    className: {
      type: String,
      value: '',
      observer(next, prev) {
        if (next === prev) return;
        if (!this._ready) return; // attached 首帧由 load() 拉，避免重复请求
        this.load();
      },
    },
    // 父页面把它改成新值即重新拉取（与 components/class-board 同一约定）：
    // 切 tab 回到「班级考勤」、onShow、下拉刷新时最方便
    refreshAt: {
      type: Number,
      value: 0,
      observer() {
        if (!this._ready) return;
        this.load();
      },
    },
    // ===== 父页面驱动区间（班超联赛页把「班级考勤」并进了自己的周期选择器）=====
    //   rangeFrom / rangeTo 都是合法 YYYY-MM-DD 时：组件**用这两个日期**发请求，
    //   并隐藏自带的「今日/本周/本月」周期条（页面已经有一个周期选择器，两个会打架）。
    //   任一为空则退回组件自算（保持独立可用的能力，别的页面引用它时不用改）。
    rangeFrom: {
      type: String,
      value: '',
      observer() {
        if (!this._ready) return;
        this.load();
      },
    },
    rangeTo: {
      type: String,
      value: '',
      observer() {
        if (!this._ready) return;
        this.load();
      },
    },
    // 父驱动时用于文案的周期键（day|week|month），只影响「今日 10月19日」这类前缀
    rangePeriod: { type: String, value: 'day' },
  },

  data: {
    loading: true,
    error: '',
    periods: PERIODS,
    periodIndex: 0,
    periodLabel: '', // 「8月1日 - 9月2日」这类区间说明
    // 区间由父页面给定（父驱动）→ 模板里隐藏自带的周期条，避免与页面上的周期选择器重复
    rangeDriven: false,
    modules: [],
    summary: null,
  },

  lifetimes: {
    attached() {
      // 组件不自己加登录闸门（登录由引用它的页面保证），但**先确保登录态**再发请求：
      // ensureLogin 是静默重登，不会跳页；失败时 load() 里按「暂无数据」展示，不打扰页面
      this._ready = true;
      this.load();
    },
  },

  methods: {
    // 切周期（今日 / 本周 / 本月）
    onPeriod(e) {
      const index = Number(e.currentTarget.dataset.index) || 0;
      if (index === this.data.periodIndex) return;
      this.setData({ periodIndex: index }, () => this.load());
    },

    async load() {
      const className = this.data.className;
      if (!className) {
        // 没给班级名就不发请求（父页面可能还在加载身份）
        this.setData({ loading: false, error: '未指定班级', modules: [], summary: null });
        return;
      }
      // 父驱动判定：两个日期都合法才认（只给一个会让区间半空，宁可退回自算）
      const driven =
        /^\d{4}-\d{2}-\d{2}$/.test(String(this.data.rangeFrom || '')) &&
        /^\d{4}-\d{2}-\d{2}$/.test(String(this.data.rangeTo || ''));
      const per = driven
        ? PERIODS.find((p) => p.key === this.data.rangePeriod) || PERIODS[0]
        : PERIODS[this.data.periodIndex] || PERIODS[0];
      const today = new Date();
      // 父驱动时用父给的 from/to；否则按本地日历自算（并带上 period 让服务端也用同口径）
      const range = driven
        ? { from: String(this.data.rangeFrom), to: String(this.data.rangeTo) }
        : rangeOf(per.value, today);
      // 同一个组件实例上快速切周期时丢弃过期响应（与 person-picker 的 seq 做法一致）
      const seq = (this._seq || 0) + 1;
      this._seq = seq;
      this.setData({ loading: true, error: '', rangeDriven: driven });
      try {
        await getApp().ensureLogin();
        const query = { className, from: range.from, to: range.to, period: per.key };
        const data = (await auth.get('/api/class/attendance', query)) || {};
        if (seq !== this._seq) return;
        const modules = normalizeModules(data);
        // 「每日明细」已下线，只需天数（概览卡的「区间内在统计里的天数」）
        const recordedDays = countRecordedDays(data);
        const summary = normalizeSummary(data, modules, recordedDays);
        // 区间文案：服务端返回了 from/to 就用它的（它的周期口径更权威），否则用父给 / 本地算的
        const from = summary.from || range.from;
        const to = summary.to || range.to;
        const label = `${per.label} ${rangeText(from, to, per.value)}`;
        this.setData({
          loading: false,
          modules,
          summary: { ...summary, rangeText: rangeText(from, to, per.value) },
          periodLabel: label,
        });
        this.triggerEvent('ready', { className, period: per.key, summary });
      } catch (err) {
        if (seq !== this._seq) return;
        // 403002（不是本班班主任/班委）等错误只提示，不弹窗、不影响页面其它 tab
        this.setData({
          loading: false,
          error: (err && err.message) || '考勤数据加载失败',
          modules: [],
          summary: null,
        });
        this.triggerEvent('error', { className, message: (err && err.message) || '' });
      }
    },

    // 供父页面通过 selectComponent('#attendance').reload() 主动刷新
    reload() {
      return this.load();
    },
  },
});
