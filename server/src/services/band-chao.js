/**
 * 班超（班级检查）汇总服务
 *
 * 口径（**唯一来源**，页面与管理端都从这里取，禁止在路由/页面里另写一套）：
 *   班级得分 = 100 − Σ(该班各模块扣分)，按日计算；
 *   区间（周 / 月）得分 = 区间内各日得分的算术平均（没有记录的日期不参与平均，避免「没查就满分」）；
 *   早操 / 早八：`hasMorningExercise === false` 的班级**不进分母**，`cancelled` 记录退出统计；
 *   宿舍 / 卫生区：记录里已冗余 className（录入时经映射反查写入），班级聚合直接按 className 求和。
 */
const CheckRecord = require('../models/check-record');
const CheckModule = require('../models/check-module');
const ClassProfile = require('../models/class-profile');
const Organization = require('../models/organization');
const User = require('../models/user');
const dates = require('../utils/dates');
const roster = require('./roster');
const checkModules = require('./check-modules');
const { liveCounts } = require('./class-counts');

const COUNTED = CheckRecord.COUNTED_STATUS;
const BASE_SCORE = 100;
const RANK_TTL = 60 * 1000;
const MAX_ROWS = 4000; // 单次区间扫描上限（一学期 5 模块 × 全校班级的量级之内）

// ===== 通用小工具 =====
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

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
      const v = m.decimals === 0 ? Math.round(sum) : round1(sum);
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
    .map((d) => ({ date: d.date, deduct: round1(d.deduct), score: round1(BASE_SCORE - d.deduct) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const avgScore = days.length ? round1(days.reduce((a, b) => a + b.score, 0) / days.length) : null;

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
      deduct: hit ? round1(hit.deduct) : 0,
      score: hit ? round1(BASE_SCORE - hit.deduct) : null,
      metricText: hit ? metricText(mod, hit.metrics, hit.count) : '',
    });
  }

  return {
    className,
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
    score: avgScore, // 区间平均分（当区间无记录时 null，前端显示「—」）
    deduct: days.length ? round1(days.reduce((a, b) => a + b.deduct, 0) / days.length) : null,
    days,
    recordCount: cls.recordCount,
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
          deduct: round1(avgDeduct),
          score: round1(BASE_SCORE - avgDeduct),
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
    dept = candidates[0] || list[0] || null;
  }
  const schoolId = r.schoolId ? String(r.schoolId) : dept && dept.parentId ? String(dept.parentId) : '';
  const schoolName = r.schoolName || (schoolId && maps.schoolById.get(schoolId)) || (dept && dept.parentName) || '';
  return {
    departmentId: r.departmentId ? String(r.departmentId) : dept ? String(dept._id) : '',
    departmentName: name || (dept && dept.name) || '',
    schoolId,
    schoolName,
  };
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
    const rooms = await DormRoom.find({ enabled: { $ne: false }, ...scope })
      .select('buildingId buildingName roomNo floor className departmentId departmentName residents')
      .sort({ buildingId: 1, roomNo: 1 })
      .limit(limit)
      .lean();
    // ⚠️ 应住人数必须**实时聚合** dorm_assignments，不能只信 dorm_rooms.residents ——
    //   后者是「展示用缓存值」，退宿 / 换房后极易失真（用户 2026-10-26 报
    //   「查宿录入中没有计算应住人数」，这是第二层根因；第一层是下面这个字段名）。
    const roomIds = rooms.map((r) => r._id);
    const liveResidents = new Map();
    if (roomIds.length) {
      const DormAssignment = require('../models/dorm-assignment');
      const agg = await DormAssignment.aggregate([
        { $match: { roomId: { $in: roomIds }, status: { $in: ['checked_in', 'guest'] } } },
        { $group: { _id: '$roomId', n: { $sum: 1 } } },
      ]);
      for (const a of agg) liveResidents.set(String(a._id), a.n);
    }
    for (const r of rooms) {
      const org = resolveOrg(r, maps);
      if (!inScope(org)) continue;
      const residentCount = liveResidents.has(String(r._id))
        ? liveResidents.get(String(r._id))
        : Number(r.residents) || 0;
      targets.push({
        targetType: 'dorm_room',
        targetId: String(r._id),
        targetName: `${r.buildingName || r.buildingId || ''}${r.buildingName ? ' ' : ''}${r.roomNo}`.trim(),
        className: r.className || '',
        // 楼栋：查宿录入台按「宿舍楼」筛选（与卫生的「教学楼」筛选同一种交互）
        building: r.buildingName || r.buildingId || '',
        // 房间按默认班级导出年级（混宿房间仅作展示/筛选参考，真正归属仍按在住学生分摊）
        grade: roster.gradeFromClassName(r.className || ''),
        schoolId: org.schoolId,
        schoolName: org.schoolName,
        departmentId: org.departmentId,
        departmentName: org.departmentName,
        residents: residentCount,
        // ⚠️ 别名 residentCount：routes/union.js::shouldCountCtx 读的是这个字段名，
        //   而这里历史上只给了 `residents` —— 两个名字对不上，查宿的「应住人数」永远
        //   是 undefined、从不注入（= 用户报的现象）。两个字段都给，
        //   避免再有任何一处按旧名读取时静默拿不到值。
        residentCount,
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
    for (const a of areas) {
      const org = resolveOrg(a, maps);
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
function buildRecordFilter(query = {}, scope = null) {
  const filter = { voided: { $ne: true } };
  if (query.moduleKey) filter.moduleKey = String(query.moduleKey);
  if (query.className) filter.className = String(query.className);
  if (query.status) filter.status = String(query.status);
  if (query.date) filter.date = String(query.date);
  if (query.from || query.to) {
    const range = {};
    if (query.from) range.$gte = String(query.from);
    if (query.to) range.$lte = String(query.to);
    filter.date = range;
  }
  if (query.inspectorOpenid) filter.inspectorOpenid = String(query.inspectorOpenid);
  if (scope && Object.keys(scope).length) Object.assign(filter, scope);
  return filter;
}

// 排名缓存失效：班级属性（是否有早操 / 是否参跑）改动后必须调用，
// 否则改完要等 60s 缓存过期才反映到榜单上（班主任会觉得「改了没生效」）
function clearRankCache() {
  rankCache = { key: '', at: 0, rows: [] };
}

module.exports = {
  BASE_SCORE,
  classSummary,
  classRanking,
  clearRankCache,
  entryTargets,
  aggregateScores,
  metricText,
  rangeOf,
  buildRecordFilter,
};
