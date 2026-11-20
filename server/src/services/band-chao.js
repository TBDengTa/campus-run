/**
 * 班超（班级检查）汇总服务
 *
 * 口径（**唯一来源**，页面与管理端都从这里取，禁止在路由/页面里另写一套）：
 *   班级得分 = FULL_SCORE(10) − Σ(该班各模块扣分)，按日计算；
 *   区间（周 / 月）得分 = 区间内各日得分的算术平均（没有记录的日期不参与平均，避免「没查就满分」）；
 *   早操 / 早八：`hasMorningExercise === false` 的班级**不进分母**，`cancelled` 记录退出统计；
 *   宿舍 / 卫生区：记录里已冗余 className（录入时经映射反查写入），班级聚合直接按 className 求和。
 *
 * ===== 10 分制（用户 2026-11-12）=====
 * 满分刻度取自 services/score-scale.js（它转发 check-modules.FULL_SCORE），
 * **本文件不再自己写 100**：历史上 BASE_SCORE=100 与 computeDeduct 的 ×100 是两处独立硬编码，
 * 改一处就会出现「扣分按 10 分制、总评按 100 分制」的负分班级。
 */
const CheckRecord = require('../models/check-record');
const CheckModule = require('../models/check-module');
const ClassProfile = require('../models/class-profile');
const Organization = require('../models/organization');
const User = require('../models/user');
const dates = require('../utils/dates');
const roster = require('./roster');
const checkModules = require('./check-modules');
const dormsSvc = require('./dorms');
const scoreScale = require('./score-scale');
const { liveCounts } = require('./class-counts');

const COUNTED = CheckRecord.COUNTED_STATUS;
// 满分（10 分制）：唯一真源是 check-modules.FULL_SCORE，这里只是别名，方便本文件沿用旧写法
const BASE_SCORE = scoreScale.FULL_SCORE;

const RANK_TTL = 60 * 1000;
const MAX_ROWS = 4000; // 单次区间扫描上限（一学期 5 模块 × 全校班级的量级之内）
// 查宿对象列表要「先按真实归属过滤、再按 limit 截断」，因此房间必须一次性取回：
// 若先按 limit 截断，分院成员可能在自己那一段之前就被别人的房间占满 → 列表空。
// 线上在用房间实测 272 间；上限给 5000 是量级护栏（不会把整表拖进内存）。
const ROOM_SCAN_LIMIT = 5000;

// ===== 通用小工具 =====
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
// 分数一律两位小数（10 分制）：round1 会把 9.95 收成 10.0，「迟到 1 人」在界面上
// 就变成「没扣分」—— 百分制时 0.5 分粒度看不出这个问题，刻度换小后必须跟着改。
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ===== 受检类型中文名（**全仓唯一一份**，本文件导出给看板 / 导出 / 复制文案复用）=====
// check_records.targetType 的取值域见 models/check-record.js（classroom / dorm_room / area / class）。
// 为什么必须单点：班级状态看板的扣分明细、CSV 导出、复制文案都要拼「卫生-宿舍」这种**具体考察项**，
// 三处各写一份映射必然漂移（「宿舍」vs「寝室」、「教室」vs「教室区」），
// 而本轮要消灭的正是这类「两个数字 / 两种叫法互相对不上」的问题。
const TARGET_TYPE_TEXT = {
  class: '班级',
  classroom: '教室',
  dorm_room: '宿舍',
  area: '卫生区',
  // 预留：check_records 目前不落 building，建筑维度一旦落库即可直接显示中文
  building: '楼栋',
  // 历史脏数据缺 targetType 的兜底（正常记录必填，理论上不会出现）
  unknown: '其他',
};

// 「当月第 N 周」：1-7 为第 1 周，8-14 为第 2 周，最后一周截到月末。
// 与 ISO 周不同，排名页的周选择要落在同一个月内，避免跨月把两周混在一起。
// 「10月8日至10月14日」：周选择器要显示日期段（用户要求「第2周(10月8日至10月14日)」）。
// 跨月时两端都带月份；同一天只写一天。口径与 miniprogram/utils/period.js::dateRangeText 一致。
function dateRangeText(from, to) {
  const md = (k) => (dates.isValidDateKey(k) ? `${Number(k.slice(5, 7))}月${Number(k.slice(8, 10))}日` : '');
  const a = md(from);
  const b = md(to);
  if (!a) return b;
  if (!b || from === to) return a;
  return `${a}至${b}`;
}

// 「当月第 N 周」：从当月 1 日起算，每 7 天一周（1-7 日为第 1 周、8-14 日为第 2 周 …）。
// **周是完整 7 天，不按月末截断**（用户明确要求「周要完整的日期，不要跟随月截断」）：
// 10 月第 5 周 = 10月29日 至 11月4日（跨月），而不是截成 10月29日至10月31日。
// 与 ISO 周不同：按月份锚定，选「10月第1周」不会把 9 月的日子算进来。
// 前端口径副本在 miniprogram/utils/period.js（改动必须两处同步，有桩测试逐例对拍）。
function monthWeekRange(monthKey, weekNo) {
  const mk = /^\d{4}-\d{2}$/.test(monthKey || '') ? monthKey : dates.todayKey().slice(0, 7);
  const mr = dates.monthRange(mk);
  const maxWeek = Math.ceil(Number(mr.endKey.slice(8, 10)) / 7);
  const n = Math.min(maxWeek, Math.max(1, Number(weekNo) || 1));
  const start = dates.addDays(mr.startKey, (n - 1) * 7);
  const end = dates.addDays(start, 6); // 完整 7 天，跨月不截断
  const m = Number(mk.slice(5, 7));
  const span = dateRangeText(start, end);
  return {
    range: 'week',
    from: start,
    to: end,
    // label 保持「第N周」（不动既有消费者：classSummary.rangeLabel / 排名页榜单标题）；
    // weekLabel「第2周(10月8日至10月14日)」与 weekRangeText「10月8日至10月14日」给周选择器用 ——
    // 前端不必自己再算一遍日期，算错就会与服务端统计区间对不上。
    label: `第${n}周`,
    periodLabel: `${m}月第${n}周`,
    weekLabel: `第${n}周(${span})`,
    weekRangeText: span,
    weekNo: n,
    maxWeek,
  };
}

function rangeOf(range, date, weekStartKey, monthKey, weekNo) {
  const day = dates.isValidDateKey(date) ? date : dates.todayKey();
  const dm = Number(day.slice(5, 7));
  const dd = Number(day.slice(8, 10));
  if (range === 'week') {
    if (weekNo) return monthWeekRange(monthKey || day.slice(0, 7), weekNo);
    const start = dates.isValidDateKey(weekStartKey) ? weekStartKey : dates.weekRange(day).startKey;
    const end = dates.addDays(start, 6);
    return {
      range: 'week',
      from: start,
      to: end,
      label: '本周',
      periodLabel: `${Number(start.slice(5, 7))}月${Number(start.slice(8, 10))}日 ~ ${Number(end.slice(5, 7))}月${Number(end.slice(8, 10))}日`,
    };
  }
  if (range === 'month') {
    const mk = /^\d{4}-\d{2}$/.test(monthKey || '') ? monthKey : day.slice(0, 7);
    const mr = dates.monthRange(mk);
    const m = Number(mk.slice(5, 7));
    return { range: 'month', from: mr.startKey, to: mr.endKey, label: '本月', periodLabel: `${m}月` };
  }
  return { range: 'day', from: day, to: day, label: '今日', periodLabel: `${dm}月${dd}日` };
}

// 模块当日/区间聚合：按 className × date × moduleKey 求扣分与记录数
async function aggregateScores({ from, to, className, departmentIds, classNames }) {
  const match = {
    date: { $gte: from, $lte: to },
    status: { $in: COUNTED },
    voided: { $ne: true },
  };
  if (Array.isArray(classNames)) match.className = { $in: classNames };
  else if (className) match.className = className;
  if (departmentIds && departmentIds.length) match.departmentId = { $in: departmentIds };

  const rows = await CheckRecord.aggregate([
    { $match: match },
    {
      $group: {
        _id: { className: '$className', date: '$date', moduleKey: '$moduleKey' },
        deduct: { $sum: '$deduct' },
        count: { $sum: 1 },
        scoreSum: { $sum: '$score' },
        metrics: { $push: '$metrics' },
      },
    },
    { $limit: MAX_ROWS },
  ]);

  // className → date → moduleKey → { deduct, count }
  const byClass = new Map();
  for (const r of rows) {
    const cn = r._id.className || '未分班';
    const dk = r._id.date;
    const mk = r._id.moduleKey;
    let cls = byClass.get(cn);
    if (!cls) {
      cls = { byDate: new Map(), byModule: new Map(), totalDeduct: 0, recordCount: 0 };
      byClass.set(cn, cls);
    }
    cls.totalDeduct += r.deduct || 0;
    cls.recordCount += r.count || 0;

    let day = cls.byDate.get(dk);
    if (!day) {
      day = { date: dk, deduct: 0, modules: new Map() };
      cls.byDate.set(dk, day);
    }
    day.deduct += r.deduct || 0;
    day.modules.set(mk, { deduct: r.deduct || 0, count: r.count || 0, metrics: r.metrics || [] });

    const mod = cls.byModule.get(mk) || { deduct: 0, count: 0, metrics: [] };
    mod.deduct += r.deduct || 0;
    mod.count += r.count || 0;
    mod.metrics.push(...(r.metrics || []));
    cls.byModule.set(mk, mod);
  }
  return byClass;
}

/**
 * 把「模块 × 受检类型」的聚合行组装成扣分来源子项（targets）。
 *
 * 目标（用户 2026-11-20「班级状态看板每行的扣分要能写成『卫生-宿舍 -0.20 · 晚自习 -0.12』」）：
 * 让老师看到扣分来自哪个模块的**哪类受检对象**，而不是只有一个模块名。
 *
 * ⚠️ 硬约束（本仓库反复报障的「两个数字互相矛盾」类问题）：
 *    `round2(Σ targets.avgDeduct)` **必须严格等于** `moduleDeduct[k].avgDeduct`；
 *    `round2(Σ targets.totalDeduct)` **必须严格等于** `moduleDeduct[k].deduct`（窗口合计）。
 *    逐项 round2 后再相加，与整项 round2 可能差 0.01（0.005 的舍入方向不同），
 *    所以两套口径都各自把尾差记到**扣分最大的那一项**上 —— 宁可让最大项偏 0.01，
 *    也不能让「子项加起来 ≠ 模块扣分」被老师当场算出来（页面切「日均/合计」两处都要对得上）。
 *
 * @param {string} moduleKey 模块 key
 * @param {string} moduleName 模块短名（与 deductDetail 的模块名同一口径，如「卫生」「晚自习」）
 * @param {Map<string,{deduct:number,count:number}>|null} byType 该模块按 targetType 的聚合
 * @param {number} dayCount 有记录天数（与 avgDeduct 同一个分母）
 * @param {number} moduleAvgDeduct 该模块日均扣分（round2 后的值，硬约束的目标）
 * @param {number} moduleTotalDeduct 该模块窗口合计扣分（round2 后的值，合计口径的目标）
 * @returns {Array<{key:string,name:string,avgDeduct:number,totalDeduct:number,count:number}>}
 *   按 avgDeduct 降序（并列按 name 稳定排序）；最多 3 项，其余并入一项「<模块名>-其他」。
 */
function buildTargetItems(moduleKey, moduleName, byType, dayCount, moduleAvgDeduct, moduleTotalDeduct) {
  // 没有受检类型聚合（如 classSummary 走 aggregateScores、或该模块零记录）→ 空数组，
  // 消费方无需判空（前端/导出把空数组当「没有更细的来源」处理）。
  if (!byType || !byType.size || !(dayCount > 0)) return [];
  const list = [];
  for (const [rawType, hit] of byType) {
    const type = String(rawType || 'unknown');
    list.push({
      // key 带模块前缀：同一 targetType（如宿舍）会出现在多个模块下，不能只用类型做 key
      key: `${moduleKey}:${type}`,
      name: `${moduleName}-${TARGET_TYPE_TEXT[type] || TARGET_TYPE_TEXT.unknown}`,
      // 与模块 avgDeduct 同一个分母（有记录天数），这样各子项之和 ≈ 该模块的日均扣分
      avgDeduct: round2((hit.deduct || 0) / dayCount),
      // 窗口合计（用户 2026-11-20 第三轮「合计/日均」切换）：与模块 deduct 同为窗口累计
      totalDeduct: round2(hit.deduct || 0),
      count: hit.count || 0,
    });
  }
  // 按日均扣分降序、并列按中文名稳定排序（前端展示顺序即此顺序，不依赖 Map 插入序）
  list.sort((a, b) => b.avgDeduct - a.avgDeduct || a.name.localeCompare(b.name, 'zh-CN'));
  // 最多 3 项：第 4 项起并入「其他」（其余之和 / 其余条数之和）——
  // 卫生一个模块就有教室 / 宿舍 / 卫生区三类对象，全铺开会挤爆一行扣分明细。
  // top 保留参与排序的真实项；other 是分组汇总，恒排在最后（不参与下面的调平与重排）。
  const top = list.slice(0, 3);
  let other = null;
  if (list.length > 3) {
    const rest = list.slice(3);
    other = {
      // key 用 `<moduleKey>:other`（不会与真实 targetType 冲突，见 models/check-record.js 的 enum）
      key: `${moduleKey}:other`,
      name: `${moduleName}-其他`,
      avgDeduct: round2(rest.reduce((a, x) => a + x.avgDeduct, 0)),
      totalDeduct: round2(rest.reduce((a, x) => a + x.totalDeduct, 0)),
      count: rest.reduce((a, x) => a + x.count, 0),
    };
  }
  // 调平尾差（见函数头硬约束）：只允许动**扣分最大的真实项**，
  // 两套口径分别与模块的日均 / 合计严格对上（不把尾差塞给「其他」：它只是分组汇总）。
  const sum = round2(top.concat(other ? [other] : []).reduce((a, x) => a + x.avgDeduct, 0));
  const diff = round2(moduleAvgDeduct - sum);
  if (diff !== 0) top[0].avgDeduct = round2(top[0].avgDeduct + diff);
  const totalSum = round2(top.concat(other ? [other] : []).reduce((a, x) => a + (x.totalDeduct || 0), 0));
  const totalDiff = round2(moduleTotalDeduct - totalSum);
  if (totalDiff !== 0) top[0].totalDeduct = round2(top[0].totalDeduct + totalDiff);
  // 调平后最大项可能与第二项互换（0.01 的临界情况）：重排一次，
  // 保证「按 avgDeduct 降序」这条展示契约不被调平破坏。
  top.sort((a, b) => b.avgDeduct - a.avgDeduct || a.name.localeCompare(b.name, 'zh-CN'));
  return other ? top.concat([other]) : top;
}

/**
 * 「一个班在某区间的班超分」的**唯一组装实现**
 *（用户 2026-11-19「班级状态日周月考勤不一致，并且卫生、查宿等相关内容没有被减分」）。
 *
 * 为什么必须抽出来：班级状态看板原来自己算一套考勤分
 * （`10 × 加权出勤率 − 迟到×0.05`，模块只有早操/早八/晚自习/查宿，**完全不含卫生**），
 * 而班超总页算的是另一套（`10 − 日均扣分`，**所有模块**的 deduct 都算）。
 * 实测同一个班同一周：班超 8.40 分、看板 9.74 分 —— 用户正是拿两个页面互相对照才发现的。
 * 现在两处都走这里，分数只有一个公式。
 *
 * 算法（与改造前的 classSummary 逐字一致，只是搬进单点函数）：
 *   · 逐日得分 = scoreScale.scoreOf(当日 Σdeduct)（10 − 当日扣分，扣穿不显负）
 *   · 区间得分 = 各日得分的**平均**（不是「10 − 区间总扣分」：一个班两周的记录不该扣成负分）
 *   · deduct   = 日均扣分 = 区间总扣分 ÷ 有记录天数
 * ⚠️ 没有记录的班返回 score=null（前端显示「—」），**不是 0 分** ——
 *    0 分是最严重的差评，会被当成真实成绩复制发进工作群。
 *
 * @param {object|undefined} cls aggregateScores() / aggregateScoresLite() Map 里该班的那一项；
 *   若调用方另把「模块 × 受检类型」聚合挂到 `cls.byTarget`
 *   （形状：Map<moduleKey, {name, byType: Map<targetType, {deduct,count}>}>），
 *   则 moduleDeduct[k] 会多下发 targets（扣分来源子项，见 buildTargetItems）。
 * @param {Array} [moduleList] 模块定义列表：传了则按它的 key 与顺序输出 moduleDeduct
 *   （classSummary 要用它列出**全部**模块，含没记录的）；
 *   不传则按该班实际有记录的模块输出（班级状态看板用它 —— 那里不想为了一行文案再拉模块字典）。
 */
function scoreOfAggregate(cls, moduleList) {
  const empty = { score: null, deduct: null, deductTotal: null, dayCount: 0, recordCount: 0, moduleDeduct: {} };
  if (!cls || !cls.byDate || !cls.byDate.size) return empty;
  const dayScores = [...cls.byDate.values()].map((d) => scoreScale.scoreOf(d.deduct));
  const keys = Array.isArray(moduleList) && moduleList.length
    ? moduleList.map((m) => m.key)
    : [...(cls.byModule ? cls.byModule.keys() : [])];
  const dayCount = cls.byDate.size;
  // 「扣分来源」聚合（模块 × targetType）：由调用方挂到 cls.byTarget 上（可选，老调用方没有）
  const byTarget = cls.byTarget && typeof cls.byTarget.get === 'function' ? cls.byTarget : null;
  const moduleDeduct = {};
  for (const k of keys) {
    const hit = cls.byModule && cls.byModule.get(k);
    if (!hit) continue;
    // 该模块的受检类型聚合：模块短名也放在这里（与 deductDetail 的模块名同一份数据，
    // 不再为了一行文案去拉模块字典 —— 看板每 60 秒被反复刷新）
    const tmod = byTarget ? byTarget.get(k) : null;
    moduleDeduct[k] = {
      deduct: round2(hit.deduct),
      // 日均扣分（**与区间得分同一个分母 dayCount**）：
      // 区间得分 = 10 − 日均总扣分，所以「各模块日均扣分之和」必须能与得分对上。
      // 只给窗口累计的话，老师拿「10 − 卫生累计10.00」去核对「班超 8.45 分」必然算不平
      // —— 这类「两个数字互相矛盾」正是本仓库反复报障的成因。
      avgDeduct: round2((hit.deduct || 0) / dayCount),
      score: scoreScale.scoreOf(hit.deduct),
      count: hit.count || 0,
      // 向后兼容的**增量**字段：扣分来源子项（模块 × 受检类型）。
      // 没有 target 聚合（如 classSummary 用的 aggregateScores）时给空数组，而不是 undefined。
      // ⚠️ Σ targets.avgDeduct 必须严格等于上面的 avgDeduct、Σ targets.totalDeduct 必须等于 deduct
      //   （两套口径都在 buildTargetItems 里调平，见那里的注释）。
      targets: buildTargetItems(
        k,
        (tmod && tmod.name) || k,
        tmod && tmod.byType,
        dayCount,
        round2((hit.deduct || 0) / dayCount),
        round2(hit.deduct || 0)
      ),
    };
  }
  return {
    score: round2(dayScores.reduce((a, b) => a + b, 0) / dayScores.length),
    // 日均扣分（与 score 同一个分母）与**窗口合计扣分**（用户 2026-11-20 第三轮「合计/日均」切换）：
    // 两个都下发，前端只调展示口径、不重算；合计 = cls.totalDeduct（与各模块 deduct 之和一致）。
    deduct: round2(cls.totalDeduct / cls.byDate.size),
    deductTotal: round2(cls.totalDeduct),
    dayCount: cls.byDate.size,
    recordCount: cls.recordCount || 0,
    moduleDeduct,
  };
}

/**
 * 看板两个轻量聚合（score / targets）共用的 match。
 *
 * ⚠️ 必须是**同一份**：两边的 COUNTED 状态集合、voided 过滤、className 范围一旦不同，
 * 就会出现「主聚合某模块扣 0.20、targets 子项加起来 0.18」这种硬约束被打破的情况。
 */
function liteMatch({ from, to, classNames }) {
  const match = {
    date: { $gte: from, $lte: to },
    status: { $in: COUNTED },
    voided: { $ne: true },
  };
  if (Array.isArray(classNames)) match.className = { $in: classNames };
  return match;
}

/**
 * 班级状态看板专用的**轻量**扣分聚合（className × date）。
 *
 * 为什么不用 aggregateScores()：那个聚合带 `$push: '$metrics'` 并按
 * className×date×moduleKey 分组，是给「每模块指标文案」用的；
 * 看板只要「这个班这天扣了多少分」，把全部 metrics 数组拖到 Node 侧
 * 会让网络传输与内存都翻几倍（看板每 60 秒被多个老师反复刷新）。
 * 两者**分组口径完全一致**（同一个 match、同一个 COUNTED 状态集合），
 * 所以算出来的分数与班超逐字相同 —— 只是少带了展示用的字段。
 *
 * @returns {Promise<Map<string, {byDate: Map, byModule: Map, totalDeduct: number, recordCount: number}>>}
 *   形状与 aggregateScores() 的返回值**兼容**，可直接喂 scoreOfAggregate()
 */
async function aggregateScoresLite({ from, to, classNames }) {
  const match = liteMatch({ from, to, classNames });
  const rows = await CheckRecord.aggregate([
    { $match: match },
    {
      $group: {
        _id: { className: '$className', date: '$date', moduleKey: '$moduleKey' },
        deduct: { $sum: '$deduct' },
        count: { $sum: 1 },
      },
    },
    { $limit: MAX_ROWS },
  ]);
  const byClass = new Map();
  for (const r of rows) {
    const cn = r._id.className || '未分班';
    const dk = r._id.date;
    const mk = r._id.moduleKey;
    let cls = byClass.get(cn);
    if (!cls) {
      cls = { byDate: new Map(), byModule: new Map(), totalDeduct: 0, recordCount: 0 };
      byClass.set(cn, cls);
    }
    cls.totalDeduct += r.deduct || 0;
    cls.recordCount += r.count || 0;
    const day = cls.byDate.get(dk) || { date: dk, deduct: 0 };
    day.deduct += r.deduct || 0;
    cls.byDate.set(dk, day);
    const mod = cls.byModule.get(mk) || { deduct: 0, count: 0 };
    mod.deduct += r.deduct || 0;
    mod.count += r.count || 0;
    cls.byModule.set(mk, mod);
  }
  return byClass;
}

/**
 * 班级状态看板专用的「模块 × 受检类型」轻量聚合（className × moduleKey × targetType）。
 *
 * 为什么**另起一次聚合**、不把 targetType 塞进 aggregateScoresLite 的 `$group`：
 *   看板要的是「卫生-宿舍扣了 0.20」这种**具体考察项**。把 targetType 加进主聚合的 _id，
 *   分组行数会翻几倍（每个 className×date×moduleKey 再乘受检类型数），
 *   而看板每 60 秒被多个老师反复刷新 —— 主聚合必须保持最轻。
 *   这次聚合只按 className×moduleKey×targetType 分组（**不带 date**，看板只用到「日均」），
 *   行数上限同样是 MAX_ROWS（与主聚合同一个「单次区间扫描上限」语义）。
 *
 * @returns {Promise<Map<string, Map<string, {name: string, byType: Map<string, {deduct:number,count:number}>}>>>}
 *   className → moduleKey → { name（模块短名，与 deductDetail 同口径）, byType }
 *   调用方把它挂到主聚合的 cls.byTarget 上，scoreOfAggregate 就会产出 moduleDeduct[k].targets。
 */
async function aggregateTargetsLite({ from, to, classNames }) {
  const match = liteMatch({ from, to, classNames });
  const rows = await CheckRecord.aggregate([
    { $match: match },
    {
      $group: {
        _id: { className: '$className', moduleKey: '$moduleKey', targetType: '$targetType' },
        deduct: { $sum: '$deduct' },
        count: { $sum: 1 },
      },
    },
    { $limit: MAX_ROWS },
  ]);
  // 模块短名（「卫生」而不是「卫生检查」）：与 deductDetail / CSV 导出用同一个口径，
  // listModules 自带 30 秒缓存，看板这一路不会额外打库。
  const modules = await checkModules.listModules();
  const nameOf = new Map(modules.map((m) => [m.key, m.shortName || m.name]));
  const byClass = new Map();
  for (const r of rows) {
    const cn = r._id.className || '未分班';
    const mk = r._id.moduleKey;
    let mods = byClass.get(cn);
    if (!mods) {
      mods = new Map();
      byClass.set(cn, mods);
    }
    let mod = mods.get(mk);
    if (!mod) {
      mod = { name: nameOf.get(mk) || mk, byType: new Map() };
      mods.set(mk, mod);
    }
    const type = String(r._id.targetType || 'unknown');
    const hit = mod.byType.get(type) || { deduct: 0, count: 0 };
    hit.deduct += r.deduct || 0;
    hit.count += r.count || 0;
    mod.byType.set(type, hit);
  }
  return byClass;
}

// 每模块的展示指标文案（如「出勤率 98.5%」「未归 1 人」）
function metricText(moduleDef, metrics, count) {
  if (!moduleDef) return '';
  const list = moduleDef.metrics || [];
  if (!list.length) return count ? `${count} 条记录` : '';
  const out = [];
  for (const m of list) {
    if (m.unit === '%') {
      // 比例类指标：多条记录取平均（班级维度下通常只有 1 条）
      const ratios = (metrics || []).map((x) => (x && x.ratios ? Number(x.ratios[m.key]) : NaN)).filter((n) => Number.isFinite(n));
      if (!ratios.length) continue;
      const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      out.push(`${m.name} ${round1(avg * 100)}%`);
    } else {
      const vals = (metrics || []).map((x) => (x && x.values ? Number(x.values[m.key]) : NaN)).filter((n) => Number.isFinite(n));
      if (!vals.length) continue;
      const sum = vals.reduce((a, b) => a + b, 0);
      // 得分类指标（卫生）走 10 分制：**两位小数**。
      // 以前 decimals:1 用 round1，9.95 会被显示成「得分 10 分」——
      // 而同一批数据的扣分是 0.05，两条信息互相矛盾，老师只会认为系统算错了。
      const v = m.decimals === 0 ? Math.round(sum) : round2(sum);
      out.push(`${m.name} ${v}${m.unit || ''}`);
    }
  }
  return out.join(' · ') || `${count} 条记录`;
}

/**
 * 某班班超汇总（首页「班超块」与班超门户页共用）
 * @returns {{className, score, days, recordCount, modules: [], today: {...}}}
 */
async function classSummary({ className, date, range = 'day', weekStartKey, monthKey, weekNo, modules }) {
  const scope = rangeOf(range, date, weekStartKey, monthKey, weekNo);
  const moduleList = modules || (await checkModules.listModules());
  const profile = await ClassProfile.findOne({ className }).lean();

  const byClass = await aggregateScores({ from: scope.from, to: scope.to, className });
  const cls = byClass.get(className) || { byDate: new Map(), byModule: new Map(), totalDeduct: 0, recordCount: 0 };

  const days = [...cls.byDate.values()]
    .map((d) => ({ date: d.date, deduct: round1(d.deduct), score: scoreScale.scoreOf(d.deduct) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  // 区间得分与「卫生/查宿等有没有被减分」全部来自这一处组装（scoreOfAggregate）
  const agg = scoreOfAggregate(cls, moduleList);

  const moduleRows = [];
  for (const mod of moduleList) {
    const hit = cls.byModule.get(mod.key);
    // 早操 / 早八 / 晚自习：班级没有该项 → 标注「无」而不是 0 分
    let skippedReason = '';
    if (mod.key === 'morning_exercise' && profile && profile.hasMorningExercise === false) skippedReason = '本班无早操';
    if (mod.key === 'morning_class' && profile && profile.hasMorningClass === false) skippedReason = '本班无早八';
    // 晚自习（用户 2026-10-21「部分班级是没有晚自习的所以不涉及考勤」）
    if (mod.key === 'study_evening' && profile && profile.hasNightStudy === false) skippedReason = '本班无晚自习';
    // 「没有记录 = 正常」的模块（早八：只记迟到人）：没记录时给 noRecordText（「无迟到」），
    // 由前端直接渲染 —— 否则会显示灰色的「未录」，让老师以为纪检部漏录了（用户明确口径）。
    const optional = mod.optionalWhenMissing === true;
    moduleRows.push({
      key: mod.key,
      name: mod.name,
      shortName: mod.shortName || mod.name,
      ownerDeptName: mod.ownerDeptName || '',
      skipped: !!skippedReason,
      skippedReason,
      entered: !!hit,
      // 可选模块未录时的展示文案（前端优先用它；为空则退回「未录」）
      optionalWhenMissing: optional,
      noRecordText: optional ? mod.noRecordText || '无迟到' : '',
      recordCount: hit ? hit.count : 0,
      deduct: hit ? round2(hit.deduct) : 0,
      score: hit ? scoreScale.scoreOf(hit.deduct) : null,
      metricText: hit ? metricText(mod, hit.metrics, hit.count) : '',
    });
  }

  return {
    className,
    // 满分刻度（10 分制）：随汇总一起下发，前端画「得分趋势条」要拿它换算百分比 ——
    // 以前前端把 score 直接当百分数用（Math.min(100, score)），百分制时恰好对，
    // 换成 10 分制后条就只有 9.5% 宽。刻度由服务端给，前端不许自己写死 100。
    fullScore: BASE_SCORE,
    departmentId: profile && profile.departmentId ? String(profile.departmentId) : '',
    departmentName: (profile && profile.departmentName) || '',
    grade: (profile && profile.grade) || '',
    hasMorningExercise: profile ? profile.hasMorningExercise !== false : true,
    hasMorningClass: profile ? profile.hasMorningClass !== false : true,
    range: scope.range,
    rangeLabel: scope.label,
    // 周期文案（「10月17日」「10月第2周」「10月」）：日/周/月都能选具体周期，页面按它展示
    periodLabel: scope.periodLabel || scope.label,
    // 周选择器的展示文案（带日期段）：「第2周(10月8日至10月14日)」；非周口径为 undefined
    weekLabel: scope.weekLabel || '',
    weekRangeText: scope.weekRangeText || '',
    weekNo: scope.weekNo || null,
    maxWeek: scope.maxWeek || null,
    from: scope.from,
    to: scope.to,
    // score / deduct 都来自 scoreOfAggregate（单点实现，班级状态看板走的是同一个函数）：
    // ⚠️ 不要在这里再写一遍「逐日得分平均」—— 那正是用户报「两个页面对不上」的成因。
    score: agg.score, // 区间平均分（当区间无记录时 null，前端显示「—」）
    deduct: agg.deduct,
    days,
    recordCount: agg.recordCount,
    modules: moduleRows,
  };
}

// ===== 全校 / 院系班级排名 =====
let rankCache = { key: '', at: 0, rows: [] };

/**
 * 班级排名（按日均得分倒序）
 * @param {Object} opts { from, to, departmentIds, limit }
 */
async function classRanking({ from, to, departmentIds, classNames, className, limit = 50 }) {
  const key = `${from}|${to}|${className || ''}|${(classNames || []).slice().sort().join(',')}|${(departmentIds || []).join(',')}`;
  let rows;
  if (Array.isArray(classNames) && !classNames.length) {
    rows = [];
  } else if (rankCache.key === key && Date.now() - rankCache.at < RANK_TTL) {
    rows = rankCache.rows;
  } else {
    const byClass = await aggregateScores({ from, to, departmentIds, classNames });
    const names = [...byClass.keys()].filter((n) => n && n !== '未分班');
    const profiles = names.length
      ? await ClassProfile.find({ className: { $in: names } })
          .select('className departmentName grade hasMorningExercise hasMorningClass studentCount status')
          .lean()
      : [];
    const pmap = new Map(profiles.map((p) => [p.className, p]));

    rows = names
      .map((cn) => {
        const cls = byClass.get(cn);
        const dayList = [...cls.byDate.values()];
        const avgDeduct = dayList.length ? cls.totalDeduct / dayList.length : 0;
        const p = pmap.get(cn) || {};
        return {
          className: cn,
          departmentName: p.departmentName || '',
          grade: p.grade || '',
          studentCount: p.studentCount || 0,
          days: dayList.length,
          recordCount: cls.recordCount,
          deduct: round2(avgDeduct),
          // 走 scoreScale 而不是 BASE_SCORE − 扣分：与 classSummary 同一个出口，
          // 否则「班级榜第 1 名 9.5 分、点进详情 9.55 分」这种两位小数下的对不上就成了新问题。
          score: scoreScale.avgScoreOf(avgDeduct),
          // 实习 / 毕业班不参加班超统计：即使历史上有记录，也不进榜
          joinsBandChao: ClassProfile.joinsBandChao(p),
        };
      })
      // 实习 / 毕业班整行剔除（不是记 0 分）：班级榜只保留正常班
      .filter((r) => r.joinsBandChao)
      .sort((a, b) => b.score - a.score || a.deduct - b.deduct || a.className.localeCompare(b.className));
    rankCache = { key, at: Date.now(), rows };
  }

  const list = rows.map((r, i) => ({ rank: i + 1, ...r }));
  const total = list.length;
  const me = className ? list.find((r) => r.className === className) || null : null;
  return {
    total,
    me,
    top: list.slice(0, 3),
    bottom: total > 3 ? list.slice(-3).reverse() : [],
    list: list.slice(0, limit),
  };
}

// ===== 录入台对象列表（含录入状态）=====

// 组织架构（院校 / 系部）解析：录入台「院校 / 系部 / 年级」筛选与分院范围共用。
// 存量 class_profiles 有两类脏数据，不能只看 departmentId：
//   · 老班级：departmentId 有值，但 schoolId / schoolName 为空；
//   · 26 级新班级：只有 departmentName，departmentId / schoolId 都为空。
// 所以 departmentName 也要能反查组织树，否则分院校只能看到老班级、看不到新班级。
let orgCache = { at: 0, maps: null };
const ORG_CACHE_TTL = 60 * 1000;

async function orgMaps() {
  if (orgCache.maps && Date.now() - orgCache.at < ORG_CACHE_TTL) return orgCache.maps;
  const [schools, departments] = await Promise.all([
    Organization.find({ type: 'school' }).select('name').lean(),
    Organization.find({ type: 'department' }).select('name parentId parentName').lean(),
  ]);
  const schoolById = new Map(schools.map((s) => [String(s._id), s.name]));
  const schoolIdByName = new Map(schools.map((s) => [String(s.name || ''), String(s._id)]));
  const deptById = new Map(departments.map((d) => [String(d._id), d]));
  const deptByName = new Map();
  for (const d of departments) {
    const name = String(d.name || '').trim();
    if (!name) continue;
    if (!deptByName.has(name)) deptByName.set(name, []);
    deptByName.get(name).push(d);
  }
  const maps = { schoolById, schoolIdByName, deptById, deptByName };
  orgCache = { at: Date.now(), maps };
  return maps;
}

// 台账行 / 宿舍房 / 卫生区 → { schoolId, schoolName, departmentId, departmentName }
// departmentId 优先；缺失时按 departmentName 反查（同名系部跨校区时优先匹配 schoolId）
//
// ⚠️ 名字反查**不允许猜**（2026-11-13 实测修正）：旧写法 `candidates[0] || list[0]` 在
// 「同名系部、又没有院校信息」时按插入顺序随便取一个 —— 实测把 2 间洋河宿舍、1 个洋河卫生区
// 判成了北校区（记录会被记到别的校区/系部）。现在：消歧后必须**唯一**才认，否则返回空，
// 由调用方补院校信息（宿舍/卫生区从归属班级推，见 entryTargets 里的 campusOf）。
function resolveOrg(row, maps) {
  const r = row || {};
  const name = String(r.departmentName || '').trim();
  let dept = r.departmentId ? maps.deptById.get(String(r.departmentId)) : null;
  if (!dept && name) {
    const list = maps.deptByName.get(name) || [];
    let candidates = list;
    if (r.schoolId) {
      candidates = list.filter((d) => String(d.parentId) === String(r.schoolId));
    } else if (r.schoolName) {
      const sid = maps.schoolIdByName.get(String(r.schoolName));
      if (sid) candidates = list.filter((d) => String(d.parentId) === sid);
    }
    dept = candidates.length === 1 ? candidates[0] : null;
  }
  const schoolId = r.schoolId ? String(r.schoolId) : dept && dept.parentId ? String(dept.parentId) : '';
  const schoolName = r.schoolName || (schoolId && maps.schoolById.get(schoolId)) || (dept && dept.parentName) || '';
  return {
    departmentId: r.departmentId ? String(r.departmentId) : dept ? String(dept._id) : '',
    departmentName: name || (dept && dept.name) || '',
    schoolId,
    schoolName,
    // 归属未能确定（系部名不在组织架构 / 同名歧义且没有院校消歧）：录入台据此标「归属待确认」
    ambiguous: !dept && !!name,
  };
}

/**
 * 从「归属班级」推出院校（宿舍房 / 卫生区自身没有 schoolName 字段）。
 * 这不是猜：房间的 className / 卫生区的 classNames 是它们的责任班级，台账里一定有院校。
 */
async function classCampusMap(classNames) {
  const names = [...new Set((classNames || []).map((n) => String(n || '').trim()).filter(Boolean))];
  const map = new Map();
  if (!names.length) return map;
  const rows = await ClassProfile.find({ className: { $in: names } })
    .select('className schoolId schoolName')
    .lean();
  for (const p of rows) map.set(p.className, { schoolId: p.schoolId ? String(p.schoolId) : '', schoolName: p.schoolName || '' });
  return map;
}

/**
 * 班级 → **完整**组织归属（院校 + 系部，id 与名字都给，走 org-resolve 的唯一口径）。
 *
 * 为什么需要它（用户 2026-11-16「1号楼(女生宿舍)414 显示的却是 25 级软件」的同一处根因）：
 *   `dorm_rooms.departmentId / departmentName` 与它的 className 一样，都是**建房间时的快照**。
 *   换宿后房间记录指向的还是上一届那个班的系部，于是查宿对象列表把
 *   「26级应用化工技术（冶金材料系）」显示成「计财系」，更糟的是**分院范围判定也跟着错**：
 *   冶金材料系的成员看不到自己系里的这间房，计财系的成员反而能看/能录（越权）。
 *   正确口径：按房间的**当前在住班级**去班级台账取归属，房间自身字段只作最后兜底
 *   （与 routes/union.js::resolveClassInfo 同源，禁止各处再拼一套）。
 *
 * @param {string[]} classNames
 * @returns {Promise<Map<string, {departmentId:string, departmentName:string, schoolId:string, schoolName:string, resolved:boolean}>>}
 */
async function classOrgMap(classNames) {
  const names = [...new Set((classNames || []).map((n) => String(n || '').trim()).filter(Boolean))];
  const map = new Map();
  if (!names.length) return map;
  const orgResolveSvc = require('./org-resolve');
  const profiles = await ClassProfile.find({ className: { $in: names } })
    .select('className schoolId schoolName departmentId departmentName')
    .lean();
  const byName = new Map(profiles.map((p) => [p.className, p]));
  // 台账缺行时才退回学籍（与 resolveClassInfo 的兜底顺序一致）
  const missing = names.filter((n) => !byName.has(n));
  const fallbackUsers = missing.length
    ? await User.find({ className: { $in: missing }, role: { $ne: 'teacher' } })
        .select('className schoolId schoolName departmentId departmentName')
        .lean()
    : [];
  for (const u of fallbackUsers) if (!byName.has(u.className)) byName.set(u.className, u);
  for (const name of names) {
    const row = byName.get(name);
    if (!row) {
      map.set(name, { departmentId: '', departmentName: '', schoolId: '', schoolName: '', resolved: false });
      continue;
    }
    const org = await orgResolveSvc.resolveDepartment({
      departmentId: row.departmentId,
      departmentName: row.departmentName,
      schoolId: row.schoolId,
      schoolName: row.schoolName,
    });
    map.set(name, {
      departmentId: org.departmentId || '',
      departmentName: org.departmentName || row.departmentName || '',
      schoolId: org.schoolId || '',
      schoolName: org.schoolName || row.schoolName || '',
      resolved: !!org.resolved,
    });
  }
  return map;
}

/**
 * 某模块在某日应检对象 + 每个对象的录入状态
 *
 * scopeDepartmentIds：**null = 校级（全校）**；数组 = 分院，只允许该数组内的院系（空数组 = 无范围，fail-closed）。
 * 之所以用 null / [] 区分：分院如果组织架构没配系部，departmentIds 为空，旧写法 [] 会被当成「全校」，
 * 属于越权（分院能看到全校班级）。现在 [] 直接返回空列表。
 * scopeSchoolIds / scopeSchoolNames：分院所属院校，用于「同名系部跨校区」时二次校验（26 级班级只有系部名、没有 id）。
 *
 * @returns {{ module, date, period, currentYear, targets: [], summary: {total, entered, cancelled, missing} }}
 */
async function entryTargets({ moduleDef, date, period, scopeDepartmentIds = null, scopeSchoolIds = null, scopeSchoolNames = null, limit = 500 }) {
  const targetTypes = moduleDef.targetTypes || [];
  const currentYear = dates.todayKey().slice(0, 4);
  const branchScoped = Array.isArray(scopeDepartmentIds);
  const maps = await orgMaps();
  const allowedDeptIds = new Set((scopeDepartmentIds || []).map((id) => String(id)).filter(Boolean));
  const allowedSchoolIds = new Set((scopeSchoolIds || []).map((id) => String(id)).filter(Boolean));
  const allowedSchoolNames = new Set((scopeSchoolNames || []).map((name) => String(name).trim()).filter(Boolean));
  const allowedDeptNames = new Set();
  for (const id of allowedDeptIds) {
    const d = maps.deptById.get(id);
    if (d && d.name) allowedDeptNames.add(d.name);
  }

  const emptyResult = () => ({
    module: moduleDef,
    date,
    period: period || '',
    currentYear,
    targets: [],
    summary: { total: 0, entered: 0, cancelled: 0, missing: 0, countable: 0, rawMissing: 0, optional: moduleDef.optionalWhenMissing === true, noRecordText: moduleDef.noRecordText || '' },
  });
  // 分院但没有任何可用院系：宁可返回空，也不能退化成「全校可见」
  if (branchScoped && !allowedDeptIds.size && !allowedDeptNames.size) return emptyResult();

  // 分院范围查询：departmentId 命中，或 departmentName 命中（覆盖只有名字的 26 级新数据）。
  // 同名系部跨校区时后面还会用学校再收一次，不能只靠名字放行。
  const scopeQuery = () => {
    if (!branchScoped) return {};
    const or = [];
    if (allowedDeptIds.size) or.push({ departmentId: { $in: [...allowedDeptIds] } });
    if (allowedDeptNames.size) or.push({ departmentName: { $in: [...allowedDeptNames] } });
    return or.length ? { $or: or } : null;
  };
  const scope = scopeQuery();
  if (!scope) return emptyResult();

  const inScope = (org) => {
    if (!branchScoped) return true;
    if (org.departmentId && allowedDeptIds.has(org.departmentId)) return true;
    if (!allowedDeptNames.has(org.departmentName)) return false;
    // 名字对上但所属院校明确不在本分会院校内 → 拒绝（同名系部跨校区场景）
    if (allowedSchoolIds.size && org.schoolId && !allowedSchoolIds.has(org.schoolId)) return false;
    if (allowedSchoolNames.size && org.schoolName && !allowedSchoolNames.has(org.schoolName)) return false;
    return true;
  };

  const targets = [];

  if (targetTypes.includes('classroom') || targetTypes.includes('class')) {
    // 只有「正常」班级产生班超检查对象：实习 / 毕业班不参加任何班超检查。
    // status 缺省（老数据没有该字段）= 正常，所以要用 $or 兜住「不存在」，不能只写 status:'normal'。
    const profileFilter = {
      enabled: { $ne: false },
      $and: [{ $or: [{ status: 'normal' }, { status: null }, { status: { $exists: false } }] }],
      ...scope,
    };
    // 早操 / 早八 / 晚自习：只列「本班有该项」的班级（无的班级根本不产生记录）
    if (moduleDef.key === 'morning_exercise') profileFilter.hasMorningExercise = { $ne: false };
    if (moduleDef.key === 'morning_class') profileFilter.hasMorningClass = { $ne: false };
    if (moduleDef.key === 'study_evening') profileFilter.hasNightStudy = { $ne: false };
    const profiles = await ClassProfile.find(profileFilter)
      .select('className schoolId schoolName departmentId departmentName grade studentCount dormCount classroom')
      .limit(limit)
      .lean();
    // 人数实时统计（学籍 / 住宿名单）：录入台的「应到 / 应住」必须与班级真实人数一致，
    // 不能读台账里的历史快照（学生转班、退宿后快照会失真）。
    const live = await liveCounts(profiles.map((p) => p.className));
    for (const p of profiles) {
      const c = live.get(p.className) || { studentCount: p.studentCount || 0, dormCount: p.dormCount || 0 };
      const org = resolveOrg(p, maps);
      if (!inScope(org)) continue;
      // 教室（如「1号教学楼·201」）：晚自习这类**以教室为检查场所**的模块要优先展示它；
      // 同时拆出教学楼，供录入台的「教学楼筛选」用（用户 2026-10-26 第 5 点）。
      const classroom = String(p.classroom || '').trim();
      const building = classroom ? classroom.split(/[·・\-—/\s]+/)[0] || '' : '';
      targets.push({
        targetType: targetTypes.includes('classroom') ? 'classroom' : 'class',
        targetId: p.className,
        targetName: p.className,
        className: p.className,
        // 教室 / 教学楼：录入台据此把标题从「班级」换成「教室」，并支持按教学楼筛选
        classroom,
        building,
        schoolId: org.schoolId,
        schoolName: org.schoolName,
        departmentId: org.departmentId,
        departmentName: org.departmentName,
        // 年级用于录入台「今年优先」排序 / 年级筛选：存量 grade 常为空，按班级名兜底
        grade: roster.normalizeGrade(p.grade) || roster.gradeFromClassName(p.className),
        studentCount: c.studentCount,
        dormCount: c.dormCount,
      });
    }
  }

  if (targetTypes.includes('dorm_room')) {
    const DormRoom = require('../models/dorm-room');
    // ⚠️ **不能把 scope 拼进房间查询**：scope 里的 departmentId / departmentName 是
    //   `check_records` / 台账口径的字段，而 `dorm_rooms.departmentId / className` 都是
    //   **建房间那一刻的快照**（换宿后没有任何代码刷新）。拿它做 DB 过滤会两向出错：
    //     · 该看到的看不到：26级应用化工技术的房间记着「计财系」→ 冶金材料系成员查宿列表里没有这间；
    //     · 不该看到的能看/能录：计财系成员反而能（用户 2026-11-16 报障的同一处根因）。
    //   正确做法是**先按在住班级解析归属、再在内存里按 scope 过滤**（见下面的 inScope），
    //   即「范围判定永远用真实归属」；房间量级（实测 272 间）一次取回没有性能问题。
    const rooms = await DormRoom.find({ enabled: { $ne: false } })
      .select('buildingId buildingName roomNo floor className departmentId departmentName residents')
      .sort({ buildingId: 1, roomNo: 1 })
      .limit(ROOM_SCAN_LIMIT)
      .lean();
    // ⚠️ 应住人数必须**实时聚合** dorm_assignments，不能只信 dorm_rooms.residents ——
    //   后者是「展示用缓存值」，退宿 / 换房后极易失真（用户 2026-10-26 报
    //   「查宿录入中没有计算应住人数」，这是第二层根因；第一层是下面这个字段名）。
    //
    // ⚠️⚠️ **归属班级同样必须按在住名单算**（用户 2026-11-16「1号楼(女生宿舍)414
    //   宿舍成员都是 26 级化工的，但是显示的却是 25 级软件」）：
    //   `dorm_rooms.className` 是**建房间那一刻的默认班级快照**，整届换宿后没有任何代码刷新它
    //   （实测线上 272 间在用房里 3 间对不上）。拿它当展示归属，录入台就会把年级徽标、
    //   系部归属和按班筛选全部指向上一届的班 —— 而且**按班统计的分母也会错**。
    //   口径与 routes/union.js::resolveTarget 一致，统一走 dormsSvc.roomLiveOwners。
    const roomOwners = await dormsSvc.roomLiveOwners(rooms);
    // 该房真有在住名单吗（决定是否需要「补录名单」提示与归属兜底）
    const liveResidents = new Map();
    for (const [key, val] of roomOwners) liveResidents.set(key, (val.owners || []).reduce((a, o) => a + (o.count || 0), 0));
    // 房间自身没有院校 / 系部字段（或已过期）：用**当前在住班级**去台账取归属，
    // 同名系部跨校区时不猜（见 resolveOrg / org-resolve 注释）。
    // ⚠️ 绝不能用房间自己的 departmentId：那是建房间时的快照，换宿后会把归属指到别的系部
    //   （26级应用化工技术的房间显示成「计财系」就是这个），并且会让**分院范围判定跟着越权**。
    const roomCampus = await classOrgMap(
      rooms.map((r) => (roomOwners.get(String(r._id)) || {}).className || r.className)
    );
    // 每个分支各自受 limit 约束（与教室分支的 .limit(limit) 同口径）
    let roomPushed = 0;
    for (const r of rooms) {
      if (roomPushed >= limit) break;
      const live = roomOwners.get(String(r._id)) || { className: r.className || '', owners: [] };
      const liveClass = live.className || r.className || '';
      const clsOrg = roomCampus.get(String(liveClass)) || null;
      // 归属优先级：在住班级的台账归属 → 房间自身字段（台账缺行时的兜底）→ 名字反查
      const org = resolveOrg(
        {
          className: liveClass,
          departmentId: (clsOrg && clsOrg.departmentId) || r.departmentId,
          departmentName: (clsOrg && clsOrg.departmentName) || r.departmentName,
          schoolId: (clsOrg && clsOrg.schoolId) || '',
          schoolName: (clsOrg && clsOrg.schoolName) || '',
        },
        maps
      );
      if (!inScope(org)) continue;
      roomPushed += 1;
      const residentCount = liveResidents.get(String(r._id)) || 0;
      // 展示名走 dorms.roomLabel 的同一口径（楼名·门号 + 房号归一）：
      // 存量里有被拆坏的房号（`洋河` + `女宿女宿女宿…301`），直接拼会把这串垃圾摆到
      // 检查录入台的对象列表上（用户 2026-11-14 报障的截图就是这个）。
      // 库里的真实纠正由 scripts/fix-dorm-room-dup-prefix.js 负责，这里只保证**显示**正常。
      const buildingName = r.buildingName || r.buildingId || '';
      targets.push({
        targetType: 'dorm_room',
        targetId: String(r._id),
        targetName: dormsSvc.roomLabel({ buildingName, roomNo: r.roomNo }).replace('·', ' '),
        // 归属班级 = **在住提醒的主班**（没有名单才退回房间默认班级）
        className: liveClass,
        // 混宿房间的全部在住班（含人数）：录入台可展示「混宿」提示，分数按人数分摊
        classNames: (live.owners || []).map((o) => o.className).filter(Boolean),
        // 楼栋：查宿录入台按「宿舍楼」筛选（与卫生的「教学楼」筛选同一种交互）
        building: buildingName,
        // 年级按**在住班级**推导（房间默认班级的年级是上一届的，会让「今年优先」排序失效）
        grade: roster.gradeFromClassName(liveClass),
        schoolId: org.schoolId,
        schoolName: org.schoolName,
        departmentId: org.departmentId,
        departmentName: org.departmentName,
        // 归属未能确定（系部名对不上组织架构）：录入台标「归属待确认」，写入时按 fail-closed 拒
        orgAmbiguous: !!org.ambiguous,
        residents: residentCount,
        // ⚠️ 别名 residentCount：routes/union.js::shouldCountCtx 读的是这个字段名，
        //   而这里历史上只给了 `residents` —— 两个名字对不上，查宿的「应住人数」永远
        //   是 undefined、从不注入（= 用户报的现象）。两个字段都给，
        //   避免再有任何一处按旧名读取时静默拿不到值。
        residentCount,
        // 房间还没有在住名单（管理员尚未录入）→ 录入台提示补录，避免「归属按默认班级」被当真
        needsRoster: residentCount === 0,
      });
    }
  }

  if (targetTypes.includes('area')) {
    const SanitaryArea = require('../models/sanitary-area');
    const areas = await SanitaryArea.find({ enabled: { $ne: false }, ...scope })
      .select('name areaType location classNames departmentId departmentName')
      .sort({ areaType: 1, name: 1 })
      .limit(limit)
      .lean();
    // 卫生区同样没有院校字段：用第一个责任班的院校消歧
    const areaCampus = await classCampusMap(areas.map((a) => (a.classNames || [])[0]));
    for (const a of areas) {
      const campus = areaCampus.get(String((a.classNames || [])[0] || '')) || null;
      const org = resolveOrg({ ...a, schoolId: campus ? campus.schoolId : '', schoolName: campus ? campus.schoolName : '' }, maps);
      if (!inScope(org)) continue;
      targets.push({
        targetType: 'area',
        targetId: String(a._id),
        targetName: a.name,
        className: (a.classNames || [])[0] || '',
        // 共管卫生区按第一个归属班的年级展示 / 筛选
        grade: roster.gradeFromClassName((a.classNames || [])[0] || ''),
        classNames: a.classNames || [],
        areaType: a.areaType || '',
        location: a.location || '',
        schoolId: org.schoolId,
        schoolName: org.schoolName,
        departmentId: org.departmentId,
        departmentName: org.departmentName,
        orgAmbiguous: !!org.ambiguous,
      });
    }
  }

  // 录入状态：同模块 + 同日期（+ 同时段）的既有记录
  const targetIds = targets.map((t) => t.targetId);
  const records = targetIds.length
    ? await CheckRecord.find({
        moduleKey: moduleDef.key,
        date,
        ...(period ? { period } : {}),
        targetId: { $in: targetIds },
        voided: { $ne: true },
      })
        .select('targetId targetType status details metrics score deduct inspectorName updatedAt appeal.status')
        .lean()
    : [];
  const rmap = new Map(records.map((r) => [`${r.targetType}|${r.targetId}`, r]));

  let entered = 0;
  let cancelled = 0;
  for (const t of targets) {
    const rec = rmap.get(`${t.targetType}|${t.targetId}`) || null;
    t.recordId = rec ? String(rec._id) : '';
    t.status = rec ? rec.status : '';
    t.statusText = !rec
      ? '未录'
      : rec.status === 'cancelled'
        ? '已取消'
        : rec.status === 'approved'
          ? '已复核'
          : rec.status === 'rejected'
            ? '已退回'
            : '已录';
    t.inspectorName = rec ? rec.inspectorName : '';
    t.score = rec && rec.score !== undefined ? rec.score : null;
    t.deduct = rec && rec.deduct !== undefined ? rec.deduct : null;
    if (rec && ['submitted', 'approved'].includes(rec.status)) entered += 1;
    if (rec && rec.status === 'cancelled') cancelled += 1;
  }

  targets.sort((a, b) => {
    // 未录优先（录入台按「还没录的」排前面），其次按名称
    const av = a.status === 'submitted' || a.status === 'approved' ? 1 : 0;
    const bv = b.status === 'submitted' || b.status === 'approved' ? 1 : 0;
    if (av !== bv) return av - bv;
    return String(a.targetName).localeCompare(String(b.targetName));
  });

  // 「没有记录 = 正常」的模块（早八：只记迟到人）：
  //   · missing / countable 都按 0 计 → 首页「应录 N 条」与待办「未录 N 项」都不含它；
  //   · rawMissing 保留真实未录数（录入台内部进度用，早八仍要知道还有几个班没录）；
  //   · 前端按 noRecordText（「无迟到」）渲染，而不是灰色的「未录」。
  const optional = moduleDef.optionalWhenMissing === true;
  const rawMissing = Math.max(0, targets.length - entered - cancelled);
  return {
    module: moduleDef,
    date,
    period: period || '',
    // 录入台「今年优先」/ 年级筛选的基准年（服务端时区，避免客户端时区不一致）
    currentYear,
    targets,
    summary: {
      total: targets.length,
      entered,
      cancelled,
      // 不计入统计的模块恒为 0（「没人迟到」是常态，不是漏录）
      missing: optional ? 0 : rawMissing,
      // 应录数（计入首页/待办的那个口径）：可选模块不计
      countable: optional ? 0 : targets.length,
      rawMissing,
      optional,
      noRecordText: moduleDef.noRecordText || '',
    },
  };
}

// ===== 我的记录 / 记录列表查询 =====
// scope：由路由传入已校验的可见范围（services/union.js::scopeFilter / 班级域成员资格），本函数不再自行判权
//
// ===== 记录筛选的「类名条件」怎么合（用户 2026-11-19「检查记录要能按班级/系部/院校/楼栋筛选」）=====
// 三种来源都会想写 `className`：
//   ① scope（身份范围：分院成员限本院系 / 班主任限本班）—— **必须生效，不可被筛选绕过**；
//   ② query.className（用户点选的班级）；
//   ③ query.classNames（院校 / 系部筛选解析出的班级集合）。
// 旧实现是 `Object.assign(filter, scope)`：scope 直接把 ①② 覆盖掉 —— 那对「防越权」是对的，
// 但对「在范围内再收窄」是错的（选了院校却还是全院数据，看着像筛选没生效）。
// 现在统一走 intersectClassCond()：**求交集**。交集为空 → `$in: []`（Mongo 直接返回 0 条），
// 这样既不会 because-of-筛选 而越权，也不会出现「筛选后反而变多」。
function classCondOf(cond) {
  if (cond === undefined || cond === null || cond === '') return null;
  if (typeof cond === 'string') return [cond];
  if (Array.isArray(cond)) return cond.map(String);
  if (cond.$in) return (Array.isArray(cond.$in) ? cond.$in : []).map(String);
  return null; // 其它形态（$ne 等）不参与交集，交由 Object.assign 覆盖（保持旧语义）
}

function intersectClassCond(conds) {
  const lists = conds.map(classCondOf).filter((x) => Array.isArray(x));
  if (!lists.length) return null;
  let out = lists[0];
  for (let i = 1; i < lists.length; i += 1) {
    const set = new Set(lists[i]);
    out = out.filter((n) => set.has(n));
  }
  return { $in: [...new Set(out)] };
}

function buildRecordFilter(query = {}, scope = null) {
  const filter = { voided: { $ne: true } };
  if (query.moduleKey) filter.moduleKey = String(query.moduleKey);
  if (query.status) filter.status = String(query.status);
  if (query.date) filter.date = String(query.date);
  if (query.from || query.to) {
    const range = {};
    if (query.from) range.$gte = String(query.from);
    if (query.to) range.$lte = String(query.to);
    filter.date = range;
  }
  if (query.inspectorOpenid) filter.inspectorOpenid = String(query.inspectorOpenid);
  // 院校 / 系部 / 楼栋 / 关键词（用户 2026-11-19）：
  //   · school / department 由路由解析成 classNames 传进来（check_records 上没有 schoolName 字段，
  //     唯一可信的院校归属在班级台账 class_profiles，见 routes/union.js::resolveRecordOrgFilter）；
  //   · building 解析成 targetIds（查宿记录的 targetId = dorm_rooms._id，按楼查房最准确；
  //     不要解析 targetName 前缀 —— 实测存量里存在「洋河 男宿406」这种把楼名劈成两半的脏数据）；
  //   · keyword 只搜「班级名 / 受检对象名 / 检查人」，**不搜学生姓名**（那要走 nameSearch，另一条链路）。
  const classConds = [query.className, query.classNames, scope && scope.className];
  const merged = intersectClassCond(classConds);
  if (merged) filter.className = merged;
  if (Array.isArray(query.targetIds)) filter.targetId = { $in: query.targetIds.map(String) };
  if (query.keyword) {
    const q = String(query.keyword).trim().slice(0, 40);
    if (q) {
      // 转义正则元字符：用户搜「1号楼(女生宿舍)」不能把括号当分组
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$and = [{ $or: [{ className: re }, { targetName: re }, { inspectorName: re }] }];
    }
  }
  // scope 的其余维度（分院部门条件 / 班主任多班 $in 已由 className 交集处理）
  if (scope && Object.keys(scope).length) {
    const rest = { ...scope };
    // className 已由交集处理；这里只补「非 className」的维度（departmentId / $or 等）
    delete rest.className;
    if (Object.keys(rest).length) {
      if (rest.$or && filter.$and) {
        filter.$and.push({ $or: rest.$or });
        delete rest.$or;
      }
      Object.assign(filter, rest);
    }
  }
  return filter;
}

/**
 * 「院校 / 系部」筛选 → 班级名集合（唯一实现）。
 *
 * 为什么必须走班级台账：`check_records` 只有 `departmentId / departmentName`（系部），
 * **没有任何院校字段**；而两个校区都有「计财系」，只按系部名筛会把两校混在一起。
 * 所以院校/系部一律先在 `class_profiles`（课程台账）里解析成 `className` 集合，
 * 再由 buildRecordFilter 与身份范围求交集。
 *
 * @param {{school?: string, department?: string}} p
 * @returns {Promise<string[]|null>} 班级名数组；null = 没传这两个维度（不过滤）
 */
async function resolveRecordClassNames({ school, department } = {}) {
  const sc = String(school || '').trim();
  const dp = String(department || '').trim();
  if (!sc && !dp) return null;
  const cond = {};
  if (sc) cond.schoolName = sc;
  if (dp) cond.departmentName = dp;
  const rows = await ClassProfile.find(cond).select('className').lean();
  return rows.map((r) => String(r.className || '')).filter(Boolean);
}

/**
 * 「楼栋」筛选 → 房间 id 集合（唯一实现）。
 * @param {string} building 楼名（与 goal_config.buildings.dorm 同一套口径，如「洋河-男宿」）
 * @returns {Promise<string[]|null>} null = 没传楼栋（不过滤）
 */
async function resolveRecordTargetIds(building) {
  const b = String(building || '').trim();
  if (!b) return null;
  const DormRoom = require('../models/dorm-room');
  const rows = await DormRoom.find({ $or: [{ buildingName: b }, { buildingId: b }] }).select('_id').lean();
  return rows.map((r) => String(r._id));
}

/**
 * 记录列表的筛选候选（班级 / 院校 / 系部 / 楼栋 + 计数）。
 *
 * 口径：候选**只按身份范围（scope）统计，不叠加用户已选的筛选项** ——
 * 否则选了「北校区」之后其它院校的选项就消失了，用户没法切回去（班级状态页踩过同一个坑）。
 *
 * @param {object|null} scope 身份范围条件（unionSvc.scopeFilter 的产物）
 * @param {{from?: string, to?: string}} [window] 可选日期窗口（收窄统计范围，避免全表扫）
 */
async function recordFacets(scope = null, { from, to } = {}) {
  const match = { voided: { $ne: true }, ...(scope || {}) };
  if (from || to) {
    match.date = {};
    if (from) match.date.$gte = String(from);
    if (to) match.date.$lte = String(to);
  }
  // 班级（顺带拿院校/系部归属，一次查询搞定三个维度）
  const classAgg = await CheckRecord.aggregate([
    { $match: match },
    { $group: { _id: '$className', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 500 },
  ]);
  const names = classAgg.map((r) => String(r._id || '')).filter(Boolean);
  const profiles = names.length
    ? await ClassProfile.find({ className: { $in: names } })
        .select('className schoolName departmentName')
        .lean()
    : [];
  const profBy = new Map(profiles.map((p) => [p.className, p]));

  const classes = classAgg
    .filter((r) => r._id)
    .map((r) => {
      const p = profBy.get(r._id) || {};
      return {
        className: String(r._id),
        count: r.n,
        schoolName: p.schoolName || '',
        departmentName: p.departmentName || '',
      };
    });

  // 院校 / 系部：从班级台账汇总（同一批数据，保证计数守恒）
  const schoolMap = new Map();
  const deptMap = new Map();
  for (const c of classes) {
    if (c.schoolName) schoolMap.set(c.schoolName, (schoolMap.get(c.schoolName) || 0) + c.count);
    if (c.departmentName) deptMap.set(c.departmentName, (deptMap.get(c.departmentName) || 0) + c.count);
  }
  const byName = (a, b) => String(a).localeCompare(String(b), 'zh-CN');

  // 楼栋：只统计查宿（dorm_room）记录，按 targetId 反查 dorm_rooms.buildingName
  const roomAgg = await CheckRecord.aggregate([
    { $match: { ...match, targetType: 'dorm_room' } },
    { $group: { _id: '$targetId', n: { $sum: 1 } } },
    { $limit: 5000 },
  ]);
  let buildings = [];
  if (roomAgg.length) {
    const DormRoom = require('../models/dorm-room');
    const roomIds = roomAgg.map((r) => r._id).filter((id) => id && /^[a-f0-9]{24}$/i.test(String(id)));
    const rooms = roomIds.length
      ? await DormRoom.find({ _id: { $in: roomIds } }).select('buildingName buildingId').lean()
      : [];
    const nameByRoom = new Map(rooms.map((r) => [String(r._id), String(r.buildingName || r.buildingId || '')]));
    const bMap = new Map();
    for (const r of roomAgg) {
      const name = nameByRoom.get(String(r._id));
      if (!name) continue;
      bMap.set(name, (bMap.get(name) || 0) + r.n);
    }
    buildings = [...bMap.entries()].map(([building, count]) => ({ building, count })).sort((a, b) => byName(a.building, b.building));
  }

  return {
    classes,
    schools: [...schoolMap.entries()].map(([school, count]) => ({ school, count })).sort((a, b) => byName(a.school, b.school)),
    departments: [...deptMap.entries()]
      .map(([department, count]) => ({ department, count }))
      .sort((a, b) => byName(a.department, b.department)),
    buildings,
  };
}

// 排名缓存失效：班级属性（是否有早操 / 是否参跑）改动后必须调用，
// 否则改完要等 60s 缓存过期才反映到榜单上（班主任会觉得「改了没生效」）
function clearRankCache() {
  rankCache = { key: '', at: 0, rows: [] };
}

module.exports = {
  BASE_SCORE,
  // 受检类型中文名的**唯一一份**：看板扣分明细 / CSV 导出 / 复制文案都从这里取
  TARGET_TYPE_TEXT,
  classSummary,
  classRanking,
  clearRankCache,
  entryTargets,
  aggregateScores,
  aggregateScoresLite,
  // 「模块 × 受检类型」轻量聚合：看板把结果挂到 cls.byTarget 上，scoreOfAggregate 产出 targets
  aggregateTargetsLite,
  scoreOfAggregate,
  metricText,
  rangeOf,
  buildRecordFilter,
  resolveRecordClassNames,
  resolveRecordTargetIds,
  recordFacets,
};
