/**
 * 班级状态导出工作簿（用户 2026-11-20 定稿）
 *
 * ===== 这个文件是什么 =====
 * `GET /api/admin/class/status-export` 的**唯一实现**：路由（routes/admin/class-profile.js）
 * 只做鉴权与取参（boardQuery + classStatusBoard + applyBoardFilter），所有「导出的数字怎么来」
 * 「工作簿长什么样」都在这里。路由里不再出现第二份列定义 / 第二套格式序列化。
 *
 * ===== 与看板的关系（最重要的一条） =====
 * 筛选范围与页面看板**完全一致**：调用方传入的 board 就是 `applyBoardFilter(classStatusBoard(), ...)`
 * 的结果，本文件**不重算任何看板数字**（学生数 / 五模块扣分 / 达标人数等都直接读 board.rows）。
 * 唯一新增计算是「校园跑 8 列」的区间统计：它基于 run_records / user_goals 独立聚合
 * （看板只给「今日/本周」两个时点的达标人数，表达不了区间内的每日/每周达标率、次数、最低值与累计步数），
 * 且这部分**不碰任何分数**（不重算班超分、不重算考勤率）。
 *
 * ===== 校园跑区间统计窗口 =====
 *   from = 看板考勤窗口起点（本日/本周/本月，来自 band-chao.rangeOf 的完整区间）
 *   to   = **min(看板窗口终点, 今天)**
 * 为什么必须截到今天：看板的「本周/本月」是完整周/完整月（周日 / 月末），包含未来日期。
 * 未来日期没有任何跑步记录，若把它们算进「日达标率」的分母，本周末/本月末的达标率会被
 * 未来天数系统性拖低（看得像「今天才 30%，其实周内该达标的都达标了」）。所以导出把窗口
 * 截到「今天」（服务器今天，不是所选日期）；历史周/月（终点早于今天）则按完整区间统计。
 *
 * ===== 查询次数（禁止按班 N+1）=====
 *   1) class_profiles 一次（专业）
 *   2) class-counts.liveCounts 内部 2 次聚合（学生数 / 住宿数）
 *   3) users 一次聚合（班委数）+ 一次 find（每班学生名单，明细 sheet 与人均分母都要）
 *   4) student_union_members 一次聚合（学生会成员数，按 className 分组）
 *   5) run_records 一次聚合（按 openid × date 汇总步数）+ user_goals 一次 find + goal_config 一次
 *   6) check_records 一次 find（区间考勤明细，按班内存分组）
 * 合计约 9 次查询，与班级数无关。⚠️ run_records **没有 className 字段**（见 models/run-record.js），
 * 所以聚合按 `openid × date` 分组，再用上一步的 openid→className 映射落到班 —— 仍是单次查询。
 *
 * ===== 输出 =====
 *   · xlsx（新版小程序）：总标 + 每班一张「<班级>详细数据」+ 字段说明（最后一张）
 *   · csv（缺省，旧客户端/脚本向后兼容）：只有「总标」22 列 + BOM
 *   · json（format=json&preview=1&limit=N）：列定义 + 总标前 N 行 + total + sheets 名单，
 *     **不下发明细行**（明细可能有几千行，小程序预览装不下）
 */

const User = require('../models/user');
const ClassProfile = require('../models/class-profile');
const CheckRecord = require('../models/check-record');
const RunRecord = require('../models/run-record');
const UserGoal = require('../models/user-goal');
const GoalConfig = require('../models/goal-config');
const UnionMember = require('../models/union-member');
const dates = require('../utils/dates');
const checkModules = require('./check-modules');
const { liveCounts } = require('./class-counts');
const { ok } = require('../utils/response');

// 上限（需求：总标 500 行、班级明细 sheet 最多 500 张、考勤明细单次 5000 条）
const SUMMARY_ROW_LIMIT = 500;
const CLASS_SHEET_LIMIT = 500;
const ATTENDANCE_ROW_LIMIT = 5000;

const SUMMARY_SHEET = '总标';
const DICT_SHEET = '字段说明';

// ===== 数字 / 百分比展示口径 =====
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
// 达标率 / 最低值：1 位小数 + %；无有效数据写空串（不是 0% —— 0% 会被读成「一个人都没达标」）
const pctCell = (v) => (v === null || v === undefined ? '' : `${round1(v)}%`);
const numOr0 = (v) => Number(v) || 0;

// ===== 总标 22 列（顺序固定，需求逐字给定）=====
const SUMMARY_COLUMNS = [
  { title: '序号', wch: 6 },
  { title: '院校', wch: 16 },
  { title: '系部', wch: 16 },
  { title: '专业', wch: 22 },
  { title: '年级', wch: 8 },
  { title: '学生数', wch: 8 },
  { title: '住宿数', wch: 8 },
  { title: '班委数', wch: 8 },
  { title: '学生会成员数', wch: 12 },
  { title: '卫生累计扣分', wch: 12 },
  { title: '晚自习累计扣分', wch: 14 },
  { title: '查宿累计扣分', wch: 12 },
  { title: '早操累计扣分', wch: 12 },
  { title: '早八累计扣分', wch: 12 },
  // 用户 2026-11-20 第五轮：「在早八累计扣分后面增加班超分按照咱们的班超计算公式来」
  { title: '班超分', wch: 9 },
  { title: '校园跑班级日目标平均达标率', wch: 24 },
  { title: '校园跑班级周目标平均达标率', wch: 24 },
  { title: '校园跑班级日目标达标次数', wch: 22 },
  { title: '校园跑班级周目标达标次数', wch: 22 },
  { title: '校园跑班级日目标达标最低值', wch: 24 },
  { title: '校园跑班级周目标达标最低值', wch: 24 },
  { title: '校园跑累计步数', wch: 15 },
  { title: '校园跑人均累计步数', wch: 17 },
];

// 五模块累计扣分：key 必须与看板 attendance.deductDetail[].key 一致（check-modules 的内置 key）
const DEDUCT_MODULES = [
  { key: 'hygiene', title: '卫生累计扣分' },
  { key: 'study_evening', title: '晚自习累计扣分' },
  { key: 'night_dorm', title: '查宿累计扣分' },
  { key: 'morning_exercise', title: '早操累计扣分' },
  { key: 'morning_class', title: '早八累计扣分' },
];

// ===== 班级明细 sheet：A. 区间考勤明细（14 列）=====
const DETAIL_ATT_COLUMNS = [
  { title: '日期', wch: 12 },
  { title: '时段', wch: 8 },
  { title: '模块', wch: 10 },
  { title: '受检对象', wch: 22 },
  { title: '应到', wch: 6 },
  { title: '实到', wch: 6 },
  { title: '缺勤/未归/迟到名单', wch: 34 },
  { title: '得分', wch: 7 },
  { title: '扣分', wch: 7 },
  { title: '检查人', wch: 12 },
  { title: '复核人', wch: 12 },
  { title: '状态', wch: 9 },
  { title: '备注', wch: 26 },
  { title: '照片数', wch: 7 },
];

// ===== 班级明细 sheet：B. 校园跑每人数据（9 列）=====
const DETAIL_RUN_COLUMNS = [
  { title: '姓名', wch: 10 },
  { title: '学号', wch: 14 },
  { title: '日目标', wch: 8 },
  { title: '周目标', wch: 8 },
  { title: '达标天数', wch: 9 },
  { title: '日达标率', wch: 9 },
  { title: '达标周数', wch: 9 },
  { title: '周达标率', wch: 9 },
  { title: '区间累计步数', wch: 13 },
];

// 两个块上下排在同一张 sheet，列宽取两块同名下标的最大值（Excel 列宽是整列属性）
const DETAIL_COL_WIDTHS = (() => {
  const max = Math.max(DETAIL_ATT_COLUMNS.length, DETAIL_RUN_COLUMNS.length);
  const out = [];
  for (let i = 0; i < max; i += 1) {
    out.push(Math.max(
      (DETAIL_ATT_COLUMNS[i] && DETAIL_ATT_COLUMNS[i].wch) || 6,
      (DETAIL_RUN_COLUMNS[i] && DETAIL_RUN_COLUMNS[i].wch) || 8
    ));
  }
  return out;
})();

// 状态文案（与页面 / 复审台同一套中文）
const STATUS_TEXT = {
  submitted: '已提交',
  approved: '已复核',
  rejected: '已退回',
  cancelled: '已取消',
};

// 时段展示（库里是英文 key；导出文件给老师看，写中文；未知 key 原样输出）
const PERIOD_TEXT = {
  morning: '早间',
  evening_study: '晚自习',
  night: '晚间',
  morning_class: '早八',
};

// 考勤模块的明细取数口径（需求逐条给定，别改成「猜字段名」）：
//   早操 / 晚自习：shouldCount / actualCount / absentList
//   查宿：shouldStay / actualCount / absentList（语义是「未归」）
//   早八：只有迟到名单（lateList / lateCount），应到/实到留空
const ATT_DETAIL_KEYS = {
  morning_exercise: { should: 'shouldCount', actual: 'actualCount', roster: 'absentList', withReason: true },
  study_evening: { should: 'shouldCount', actual: 'actualCount', roster: 'absentList', withReason: true },
  night_dorm: { should: 'shouldStay', actual: 'actualCount', roster: 'absentList', withReason: true },
  morning_class: { should: null, actual: null, roster: 'lateList', withReason: false },
};

// ===== 小工具 =====
function dayKeys(from, to) {
  const out = [];
  if (!dates.isValidDateKey(from) || !dates.isValidDateKey(to) || from > to) return out;
  let k = from;
  // 保护：最多 400 天（本月/本周最多 31 天；给补算留余量，绝不让脏参数无限循环）
  for (let i = 0; i < 400 && k <= to; i += 1) {
    out.push(k);
    k = dates.addDays(k, 1);
  }
  return out;
}

// ISO 周（周一 ~ 周日，与 dates.weekRange / 看板 weekStart 同一口径）切窗口内日期
function groupWeeks(days) {
  const map = new Map();
  for (const d of days) {
    const start = dates.weekRange(d).startKey;
    if (!map.has(start)) map.set(start, []);
    map.get(start).push(d);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([startKey, list]) => ({ startKey, days: list }));
}

function exportedAtText() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
}

// 名单文案：「姓名(病假) · 姓名」（reason 为空不写括号；早八没有假别，只写姓名）
function rosterText(list, withReason) {
  return (Array.isArray(list) ? list : [])
    .map((s) => {
      const name = String((s && s.name) || '').trim();
      if (!name) return '';
      const reason = withReason ? String((s && s.reason) || '').trim() : '';
      return reason ? `${name}(${reason})` : name;
    })
    .filter(Boolean)
    .join(' · ');
}

/**
 * 个人目标（与看板同源：个人计划优先，否则全局默认）。
 * 看板用 `$ifNull: [个人目标, 全局默认]` —— 个人计划里写了 0 也会取 0（不是回退全局），
 * 所以这里用 Number.isFinite 判断「路径存在」，不用真假值判断。
 */
function targetOf(goalDoc, key, fallback) {
  const v = goalDoc && goalDoc[key] ? Number(goalDoc[key].steps) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

/** 读班委数 / 学生会成员数 / 住宿数 / 专业 / 学生名单（一次批量，禁止 N+1） */
async function loadClassExtras(classNames) {
  const names = [...new Set((classNames || []).map((n) => String(n || '').trim()).filter(Boolean))];
  const out = {
    specialtyBy: new Map(),
    liveBy: new Map(),
    officerBy: new Map(),
    unionBy: new Map(),
    studentsByClass: new Map(),
  };
  if (!names.length) return out;

  const [profiles, live, officerAgg, unionAgg] = await Promise.all([
    ClassProfile.find({ className: { $in: names } }).select('className specialty').lean(),
    liveCounts(names),
    // 班委数：班委标记 + 排除教师账号（教师即使被误标 isClassOfficer 也不占班级人数，与全库口径一致）
    User.aggregate([
      { $match: { className: { $in: names }, role: { $ne: 'teacher' }, isClassOfficer: true } },
      { $group: { _id: '$className', n: { $sum: 1 } } },
    ]),
    // 学生会成员数：active 且班级匹配；一次 aggregate 按 className 分组
    UnionMember.aggregate([
      { $match: { className: { $in: names }, status: 'active' } },
      { $group: { _id: '$className', n: { $sum: 1 } } },
    ]),
  ]);

  for (const p of profiles) out.specialtyBy.set(p.className, String(p.specialty || '').trim());
  for (const [name, c] of live) out.liveBy.set(name, c);
  for (const r of officerAgg) out.officerBy.set(String(r._id || ''), numOr0(r.n));
  for (const r of unionAgg) out.unionBy.set(String(r._id || ''), numOr0(r.n));

  // 每班学生名单：明细 sheet（校园跑每人数据）与人均分母都要；按 openid 聚合跑步记录也靠它
  const students = await User.find({ className: { $in: names }, role: { $ne: 'teacher' } })
    .select('openid realName nickname account studentId className specialty')
    .lean();
  for (const s of students) {
    const cls = String(s.className || '');
    if (!out.studentsByClass.has(cls)) out.studentsByClass.set(cls, []);
    out.studentsByClass.get(cls).push(s);
  }
  return out;
}

/** 区间考勤明细：**一次查全部筛选班级**再按班分组（需求：limit 5000，超出截断） */
async function loadAttendanceRecords({ classNames, from, to }) {
  const names = [...new Set((classNames || []).map((n) => String(n || '').trim()).filter(Boolean))];
  const out = { byClass: new Map(), truncated: false, total: 0 };
  if (!names.length) return out;
  const records = await CheckRecord.find({
    className: { $in: names },
    date: { $gte: from, $lte: to },
    status: { $in: CheckRecord.COUNTED_STATUS },
    voided: { $ne: true },
  })
    .select('className moduleKey date period targetType targetId targetName details score deduct inspectorName reviewedByName status remark photos')
    .sort({ date: 1, moduleKey: 1 })
    .limit(ATTENDANCE_ROW_LIMIT)
    .lean();
  out.total = records.length;
  out.truncated = records.length >= ATTENDANCE_ROW_LIMIT;
  for (const r of records) {
    const cls = String(r.className || '');
    if (!out.byClass.has(cls)) out.byClass.set(cls, []);
    out.byClass.get(cls).push(r);
  }
  return out;
}

/**
 * 校园跑区间数据：**一次聚合** run_records（按 openid × date） + **一次批量** user_goals + goal_config。
 * run_records 没有 className 字段，所以先用学生名单拿到 openid 范围再分组（等价于「className in 筛选班」）。
 */
async function loadRunData({ studentsByClass, from, to }) {
  const allStudents = [];
  for (const list of studentsByClass.values()) allStudents.push(...list);
  const openids = [...new Set(allStudents.map((s) => String(s.openid || '')).filter(Boolean))];
  const out = {
    daySteps: new Map(), // openid → Map(date → steps)
    goalBy: new Map(), // openid → user_goals 文档
    globalDaily: 0,
    globalWeekly: 0,
  };
  const globalConfig = await GoalConfig.getSingleton();
  out.globalDaily = numOr0(globalConfig.daily && globalConfig.daily.steps);
  out.globalWeekly = numOr0(globalConfig.weekly && globalConfig.weekly.steps);
  if (!openids.length) return out;

  const [goals, runAgg] = await Promise.all([
    UserGoal.find({ openid: { $in: openids } }).select('openid daily weekly').lean(),
    RunRecord.aggregate([
      { $match: { openid: { $in: openids }, date: { $gte: from, $lte: to } } },
      { $group: { _id: { openid: '$openid', date: '$date' }, steps: { $sum: { $ifNull: ['$steps', 0] } } } },
    ]),
  ]);
  for (const g of goals) out.goalBy.set(String(g.openid || ''), g);
  for (const r of runAgg) {
    const oid = String((r._id && r._id.openid) || '');
    const date = String((r._id && r._id.date) || '');
    if (!oid || !date) continue;
    if (!out.daySteps.has(oid)) out.daySteps.set(oid, new Map());
    out.daySteps.get(oid).set(date, numOr0(r.steps));
  }
  return out;
}

/**
 * 单个班的校园跑区间统计（日/周达标率、次数、最低值、累计步数）与每人明细。
 *
 * 口径（需求 2026-11-20）：
 *   · 日：对窗口内每一天算「班级达标人数 ÷ 学生数」的百分比；
 *     日平均达标率 = 各日百分比的平均（1 位小数）；达标次数 = 百分比 100% 的天数；
 *     最低值 = 各日百分比的最低值（窗口无有效日 → 空）。
 *   · 周：按 ISO 周（周一~周日）切窗口内日期，每个学生该周步数 = 窗口内该周记录之和；
 *     周达标率同上。
 *   · 达标判定：`步数 ≥ 目标`；目标 ≤ 0 视为已达标（需求明确：0 目标不让班白背锅）。
 *   · 累计步数 = 窗口内该班所有学生步数之和；人均 = round(累计 ÷ 学生数)，学生数 0 写 0。
 */
function computeRunStats({ students, studentCount, dailySteps, goalBy, globalDaily, globalWeekly, runDays, weeks }) {
  const dailyTargetOf = (s) => targetOf(goalBy.get(String(s.openid || '')), 'daily', globalDaily);
  const weeklyTargetOf = (s) => targetOf(goalBy.get(String(s.openid || '')), 'weekly', globalWeekly);
  const stepsMapOf = (s) => dailySteps.get(String(s.openid || '')) || null;
  const stepsOn = (s, day) => {
    const map = stepsMapOf(s);
    return map ? numOr0(map.get(day)) : 0;
  };
  // 百分比先保留**未舍入**的原值（达标人数 ÷ 学生数 × 100），只在最终展示时 round1：
  // 「各日百分比的平均」如果先逐日 round 再平均，会多一次舍入（最多差 0.05 个百分点），
  // 老师拿手算对照时可能觉得对不上。
  const rawPctOf = (achieved) => (studentCount > 0 ? (achieved / studentCount) * 100 : null);

  // ---- 日 ----
  const dayRows = runDays.map((day) => {
    let achieved = 0;
    for (const s of students) if (stepsOn(s, day) >= dailyTargetOf(s)) achieved += 1;
    return { date: day, achieved, rawPct: rawPctOf(achieved) };
  });
  // ---- 周 ----
  const weekRows = weeks.map((w) => {
    let achieved = 0;
    for (const s of students) {
      const target = weeklyTargetOf(s);
      let steps = 0;
      for (const day of w.days) steps += stepsOn(s, day);
      if (steps >= target) achieved += 1;
    }
    return { weekStart: w.startKey, achieved, rawPct: rawPctOf(achieved) };
  });

  const dayPcts = dayRows.map((r) => r.rawPct).filter((v) => v !== null);
  const weekPcts = weekRows.map((r) => r.rawPct).filter((v) => v !== null);
  const avgOf = (list) => (list.length ? round1(list.reduce((a, b) => a + b, 0) / list.length) : null);
  // 达标次数 = 达标人数 = 学生数（即百分比 100%）的天数 / 周数（学生数 0 时不存在「全班达标」）
  const fullCount = (rows) => (studentCount > 0 ? rows.filter((r) => r.achieved >= studentCount).length : 0);

  // ---- 每人（按学号 / 姓名稳定排序：导出文件里同一批人每跑一次顺序都一样）----
  const ordered = students.slice().sort(studentSort);
  const studentRows = ordered.map((s) => {
    const dailyTarget = dailyTargetOf(s);
    const weeklyTarget = weeklyTargetOf(s);
    const achievedDays = runDays.filter((day) => stepsOn(s, day) >= dailyTarget).length;
    let achievedWeeks = 0;
    let totalSteps = 0;
    for (const w of weeks) {
      let steps = 0;
      for (const day of w.days) steps += stepsOn(s, day);
      totalSteps += steps;
      if (steps >= weeklyTarget) achievedWeeks += 1;
    }
    return {
      openid: String(s.openid || ''),
      name: String(s.realName || s.nickname || s.account || '').trim(),
      studentId: String(s.studentId || '').trim(),
      dailyTarget,
      weeklyTarget,
      achievedDays,
      dailyRate: runDays.length ? round1((achievedDays / runDays.length) * 100) : null,
      achievedWeeks,
      weeklyRate: weeks.length ? round1((achievedWeeks / weeks.length) * 100) : null,
      totalSteps,
    };
  });

  const totalSteps = studentRows.reduce((a, r) => a + r.totalSteps, 0);
  return {
    dailyAvg: avgOf(dayPcts),
    dailyFullDays: fullCount(dayRows),
    dailyMin: dayPcts.length ? round1(Math.min(...dayPcts)) : null,
    weeklyAvg: avgOf(weekPcts),
    weeklyFullWeeks: fullCount(weekRows),
    weeklyMin: weekPcts.length ? round1(Math.min(...weekPcts)) : null,
    totalSteps,
    avgSteps: studentCount > 0 ? Math.round(totalSteps / studentCount) : 0,
    studentRows,
  };
}

/** 从看板行取某模块的窗口累计扣分（totalDeduct；没记录 → 0） */
function deductOf(boardRow, moduleKey) {
  const list = (boardRow.attendance && boardRow.attendance.deductDetail) || [];
  const hit = list.find((d) => d && d.key === moduleKey);
  return hit ? round2(hit.totalDeduct || 0) : 0;
}

function studentSort(a, b) {
  const sa = String(a.studentId || '');
  const sb = String(b.studentId || '');
  if (sa && sb && sa !== sb) return sa.localeCompare(sb);
  if (sa && !sb) return -1;
  if (!sa && sb) return 1;
  const na = String(a.realName || a.nickname || a.account || '');
  const nb = String(b.realName || b.nickname || b.account || '');
  return na.localeCompare(nb, 'zh-CN') || String(a.openid || '').localeCompare(String(b.openid || ''));
}

/** 考勤明细一条 → 14 列表格行 */
function attendanceRow(record, moduleNameBy) {
  const moduleKey = String(record.moduleKey || '');
  const keys = ATT_DETAIL_KEYS[moduleKey] || null;
  const d = record.details && typeof record.details === 'object' ? record.details : {};
  const shouldRaw = keys && keys.should ? d[keys.should] : undefined;
  const actualRaw = keys && keys.actual ? d[keys.actual] : undefined;
  const rosterField = keys ? keys.roster : '';
  const photos = Array.isArray(record.photos) && record.photos.length
    ? record.photos.length
    : Array.isArray(d.photos)
      ? d.photos.length
      : 0;
  // 得分 / 扣分：null / undefined / 空串写空（不要用 Number(null)=0 把「没值」显示成 0 分）
  const numCell = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '' : round2(v));
  return [
    String(record.date || ''),
    PERIOD_TEXT[String(record.period || '')] || String(record.period || ''),
    moduleNameBy.get(moduleKey) || moduleKey,
    String(record.targetName || record.targetId || ''),
    shouldRaw === undefined || shouldRaw === null ? '' : numOr0(shouldRaw),
    actualRaw === undefined || actualRaw === null ? '' : numOr0(actualRaw),
    rosterField ? rosterText(d[rosterField], keys.withReason) : '',
    numCell(record.score),
    numCell(record.deduct),
    String(record.inspectorName || ''),
    // 复核人：没复核过写「—」（空单元格会被读成「漏导」）
    String(record.reviewedByName || '') || '—',
    STATUS_TEXT[String(record.status || '')] || String(record.status || ''),
    String(record.remark || d.remark || ''),
    photos,
  ];
}

/** Excel sheet 名：上限 31 字符、非法字符 []:*?/\ 替换、重名加序号 */
function sheetNameOf(className, used) {
  const base = `${String(className || '未命名班级')}详细数据`;
  const clean = base.replace(/[\[\]:*?/\\]/g, '_');
  const fit = (s) => (s.length > 31 ? s.slice(0, 31) : s);
  let name = fit(clean);
  let n = 2;
  while (used.has(name)) {
    const suffix = `-${n}`;
    name = `${fit(clean).slice(0, 31 - suffix.length)}${suffix}`;
    n += 1;
  }
  used.add(name);
  return name;
}

// ===== 版式：总标 sheet =====
function buildSummarySheet(XLSX, payload) {
  const lastCol = payload.columns.length - 1;
  const aoa = [];
  const merges = [];
  aoa.push([payload.meta.title]);
  merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } });
  aoa.push([payload.meta.subtitle]);
  merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } });
  aoa.push([]);
  aoa.push(payload.columns.map((c) => c.title));
  for (const row of payload.tableRows) aoa.push(row);

  aoa.push([]);
  aoa.push(['口径说明']);
  merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: lastCol } });
  for (const line of payload.meta.noteLines) {
    aoa.push([line]);
    merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: lastCol } });
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = payload.columns.map((c) => ({ wch: c.wch || 14 }));
  ws['!merges'] = merges;
  ws['!rows'] = [{ hpt: 26 }, { hpt: 32 }, { hpt: 8 }, { hpt: 24 }];
  return ws;
}

/** 版式：每班一张明细 sheet（上：区间考勤明细；下：校园跑每人数据；表尾口径/截断说明） */
function buildClassSheet(XLSX, payload, sheet) {
  const lastCol = Math.max(DETAIL_ATT_COLUMNS.length, DETAIL_RUN_COLUMNS.length) - 1;
  const aoa = [];
  const merges = [];
  const mergeLine = () => merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: lastCol } });

  aoa.push([`班级状态 · ${sheet.className} 详细数据`]);
  mergeLine();
  aoa.push([`A. 区间考勤明细（${payload.meta.from} ~ ${payload.meta.to}，共 ${sheet.attRows.length} 条）`]);
  mergeLine();
  aoa.push(DETAIL_ATT_COLUMNS.map((c) => c.title));
  for (const row of sheet.attRows) aoa.push(row);

  aoa.push([]);
  aoa.push([`B. 校园跑每人数据（统计窗口 ${payload.meta.runFrom} ~ ${payload.meta.runTo}）`]);
  mergeLine();
  aoa.push(DETAIL_RUN_COLUMNS.map((c) => c.title));
  for (const row of sheet.runRows) aoa.push(row);

  aoa.push([]);
  for (const line of sheet.noteLines) {
    aoa.push([line]);
    mergeLine();
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = DETAIL_COL_WIDTHS.map((wch) => ({ wch }));
  ws['!merges'] = merges;
  ws['!rows'] = [{ hpt: 26 }, { hpt: 20 }, { hpt: 22 }];
  return ws;
}

// ===== 版式：字段说明 sheet =====
const SUMMARY_FIELD_DESC = {
  序号: '筛选后的行序（1..N）',
  院校: '看板行的院校（class_profiles.schoolName）',
  系部: '看板行的系部（class_profiles.departmentName）',
  专业: 'class_profiles.specialty；台账缺行/为空时用该班任一学生 users.specialty；都空写空',
  年级: '看板行的年级（grade 字段为空时按班级名推导）',
  学生数: '看板同学籍人数（users，排除教师）；也是达标率 / 人均步数的分母',
  住宿数: '住宿名单（dorm_assignments 在住：checked_in / guest）人数',
  班委数: 'users.isClassOfficer=true 且 role≠teacher 的人数',
  学生会成员数: 'student_union_members 中 status=active 且班级匹配的人数',
  卫生累计扣分: '看板 attendance.deductDetail 中 hygiene 的 totalDeduct（窗口累计），无记录 0',
  晚自习累计扣分: '看板 attendance.deductDetail 中 study_evening 的 totalDeduct（窗口累计），无记录 0',
  查宿累计扣分: '看板 attendance.deductDetail 中 night_dorm 的 totalDeduct（窗口累计），无记录 0',
  早操累计扣分: '看板 attendance.deductDetail 中 morning_exercise 的 totalDeduct（窗口累计），无记录 0',
  早八累计扣分: '看板 attendance.deductDetail 中 morning_class 的 totalDeduct（窗口累计），无记录 0',
  班超分: '看板 attendance.score（新公式：10 − 卫生/查宿/晚自习/早操累计扣分×10% − 缺勤人次×0.02（病/事/公假 0.01），clamp 0~10）；区间内无检查记录写空（不是 0 分）',
  校园跑班级日目标平均达标率: '区间内各日「达标人数 ÷ 学生数」百分比的平均（1 位小数，%）；窗口无有效日写空',
  校园跑班级周目标平均达标率: '按 ISO 周（周一~周日）切分后，各周达标率的平均（1 位小数，%）；无有效周写空',
  校园跑班级日目标达标次数: '日达标率 = 100% 的天数',
  校园跑班级周目标达标次数: '周达标率 = 100% 的周数',
  校园跑班级日目标达标最低值: '各日达标率中的最低值（%；无有效日写空）',
  校园跑班级周目标达标最低值: '各周达标率中的最低值（%；无有效周写空）',
  校园跑累计步数: '统计窗口内该班全部学生步数之和',
  校园跑人均累计步数: 'round(累计步数 ÷ 学生数)；学生数 0 写 0',
};

function buildDictSheet(XLSX, payload) {
  const rows = [['字段', '含义']];
  for (const c of payload.columns) rows.push([c.title, SUMMARY_FIELD_DESC[c.title] || '']);
  rows.push([]);
  rows.push(['工作表结构', `第 1 张「${SUMMARY_SHEET}」= 筛选后每个班一行；随后每班一张「<班级>详细数据」（区间考勤明细 + 校园跑每人数据）；最后本「${DICT_SHEET}」。`]);
  rows.push(['班级明细上限', `最多 ${CLASS_SHEET_LIMIT} 张（正常约 43 张）；本次 ${payload.classSheets.length} 张${payload.classSheetsTruncated ? '，超出部分已截断' : ''}。`]);
  rows.push(['总标行数上限', `最多 ${SUMMARY_ROW_LIMIT} 行；本次 ${payload.tableRows.length} 行。`]);
  rows.push(['考勤明细上限', `单次最多 ${ATTENDANCE_ROW_LIMIT} 条；本次 ${payload.attendance.total} 条${payload.attendance.truncated ? '，超出部分已截断' : ''}。`]);
  rows.push(['统计窗口', `考勤 / 累计扣分：${payload.meta.from} ~ ${payload.meta.to}；校园跑区间统计：${payload.meta.runFrom} ~ ${payload.meta.runTo}（终点 = min(看板区间终点, 今天)，避免本周/本月含未来天数把达标率拖低）。`]);
  rows.push(['筛选', payload.meta.filterText]);
  rows.push(['导出时间', payload.meta.exportedAt]);
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 24 }, { wch: 96 }];
  return ws;
}

/** 生成完整 xlsx 工作簿（总标 + 每班明细 + 字段说明） */
function buildWorkbook(payload) {
  // 仓库已有 xlsx 依赖（server/package.json），不新增依赖
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildSummarySheet(XLSX, payload), SUMMARY_SHEET);
  for (const sheet of payload.classSheets) {
    XLSX.utils.book_append_sheet(wb, buildClassSheet(XLSX, payload, sheet), sheet.sheetName);
  }
  XLSX.utils.book_append_sheet(wb, buildDictSheet(XLSX, payload), DICT_SHEET);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * 组装整份导出数据（CSV / xlsx / json 预览共用**同一份** payload）。
 *
 * @param {object} opts
 * @param {object} opts.board `applyBoardFilter(classStatusBoard(...), filter)` 的结果（看板行已筛选）
 * @param {object} [opts.filter] 看板的筛选条件（只用来生成标题里的「2026级-2025级」年级段）
 * @returns {Promise<object>} payload
 */
async function buildExport({ board, filter = {} } = {}) {
  const result = board || {};
  const rows = Array.isArray(result.rows) ? result.rows.slice(0, SUMMARY_ROW_LIMIT) : [];
  const classNames = rows.map((r) => String(r.className || '')).filter(Boolean);
  const todayKey = dates.todayKey();
  const from = String(result.from || '');
  const to = String(result.to || '');
  // 校园跑区间统计窗口终点：min(看板区间终点, 今天)（见文件头「校园跑区间统计窗口」）
  const runFrom = from;
  const runTo = to && to < todayKey ? to : todayKey;
  const runDays = dayKeys(runFrom, runTo);
  const weeks = groupWeeks(runDays);

  const [extras, attendance, moduleList] = await Promise.all([
    loadClassExtras(classNames),
    loadAttendanceRecords({ classNames, from, to }),
    checkModules.listModules(),
  ]);
  const run = await loadRunData({ studentsByClass: extras.studentsByClass, from: runFrom, to: runTo });

  const moduleNameBy = new Map((moduleList || []).map((m) => [String(m.key), String(m.shortName || m.name || m.key)]));

  // ---- 每班校园跑区间统计（一次算好，总标与明细 sheet 复用，禁止两处各算一份）----
  const runStatsBy = new Map();
  for (const row of rows) {
    const className = String(row.className || '');
    const students = extras.studentsByClass.get(className) || [];
    const studentCount = numOr0(row.studentCount);
    runStatsBy.set(
      className,
      computeRunStats({
        students,
        studentCount,
        dailySteps: run.daySteps,
        goalBy: run.goalBy,
        globalDaily: run.globalDaily,
        globalWeekly: run.globalWeekly,
        runDays,
        weeks,
      })
    );
  }

  // ---- 总标 22 列 ----
  const tableRows = rows.map((row, index) => {
    const className = String(row.className || '');
    const live = extras.liveBy.get(className) || { studentCount: 0, dormCount: 0 };
    const runStats = runStatsBy.get(className) || {};
    // 专业：台账优先，缺行/为空时退回该班任一学生的 users.specialty（需求口径）
    const students = extras.studentsByClass.get(className) || [];
    const studentSpecialty = students.map((s) => String(s.specialty || '').trim()).find(Boolean) || '';
    const specialty = extras.specialtyBy.get(className) || studentSpecialty;
    const values = [
      index + 1,
      String(row.schoolName || ''),
      String(row.departmentName || ''),
      specialty,
      String(row.grade || ''),
      numOr0(row.studentCount),
      numOr0(live.dormCount),
      extras.officerBy.get(className) || 0,
      extras.unionBy.get(className) || 0,
    ];
    for (const m of DEDUCT_MODULES) values.push(deductOf(row, m.key));
    // 班超分：直接取看板行 attendance.score（新公式唯一实现算好的值，导出不重算）；
    // 区间内没有检查记录时看板 score 是 null → 写空（不是 0 分）。
    const score = row.attendance ? row.attendance.score : null;
    values.push(score === null || score === undefined ? '' : score);
    values.push(
      pctCell(runStats.dailyAvg),
      pctCell(runStats.weeklyAvg),
      numOr0(runStats.dailyFullDays),
      numOr0(runStats.weeklyFullWeeks),
      pctCell(runStats.dailyMin),
      pctCell(runStats.weeklyMin),
      numOr0(runStats.totalSteps),
      numOr0(runStats.avgSteps)
    );
    return values;
  });

  // ---- 班级明细 sheet（最多 500 张；行数上限 500 → 正常不会触发截断）----
  const usedSheetNames = new Set([SUMMARY_SHEET, DICT_SHEET]);
  const classSheets = rows.slice(0, CLASS_SHEET_LIMIT).map((row) => {
    const className = String(row.className || '');
    const runStats = runStatsBy.get(className) || {};
    const attRecords = attendance.byClass.get(className) || [];
    const attRows = attRecords.map((r) => attendanceRow(r, moduleNameBy));
    // computeRunStats 已经按学号/姓名稳定排序，这里不再重排
    const runRows = (runStats.studentRows || []).map((s) => [
        s.name,
        s.studentId,
        s.dailyTarget,
        s.weeklyTarget,
        s.achievedDays,
        pctCell(s.dailyRate),
        s.achievedWeeks,
        pctCell(s.weeklyRate),
        s.totalSteps,
      ]);
    const noteLines = [
      `考勤明细口径：早操 / 晚自习取 details.shouldCount / actualCount / absentList；查宿取 details.shouldStay / actualCount / absentList（未归名单）；早八只登记迟到名单（lateList），应到 / 实到留空。`,
      `名单格式：姓名(假别) · 姓名（假别为空不写括号；早八没有假别）。状态：已提交 / 已复核 / 已退回 / 已取消。`,
      `校园跑达标判定：个人计划目标优先、否则全局默认；目标 ≤ 0 视为已达标。日达标率 = 达标人数 ÷ 学生数；周按 ISO 周（周一~周日）切分，周步数 = 窗口内该周每日步数之和。窗口 ${runFrom} ~ ${runTo}（截止今天，不含未来日期）。`,
      `本班区间内考勤明细 ${attRows.length} 条；全校单次最多 ${ATTENDANCE_ROW_LIMIT} 条${attendance.truncated ? '，本次已截断' : ''}。`,
    ];
    return {
      className,
      sheetName: sheetNameOf(className, usedSheetNames),
      attRows,
      runRows,
      noteLines,
    };
  });

  const studentCount = rows.reduce((a, r) => a + numOr0(r.studentCount), 0);
  const filterText = (result.activeFilters || []).length ? result.activeFilters.join(' · ') : '全校';
  const attRangeLabel = result.attRangeLabel || '';
  const exportedAt = exportedAtText();
  const subtitle = `统计区间：${from} ~ ${to}${attRangeLabel ? `（${attRangeLabel}）` : ''} ｜ 筛选：${filterText} ｜ 共 ${rows.length} 个班 / ${studentCount} 人 ｜ 导出时间：${exportedAt}`;
  const note = '总标 = 看板同源数据（不重算任何看板数字）；校园跑 8 列为区间独立聚合（窗口 = 看板区间起点 ~ min(看板区间终点, 今天)），明细见每班「详细数据」sheet。';

  // 表尾口径说明（总标 sheet 尾部整段跨列）
  const noteLines = [
    `统计窗口：考勤 / 五模块累计扣分 / 班超分 = ${from} ~ ${to}${attRangeLabel ? `（${attRangeLabel}）` : ''}；校园跑区间统计 = ${runFrom} ~ ${runTo}（终点 = min(看板区间终点, 今天)，避免本周/本月把未来天数算进达标率分母）。`,
    `累计扣分：取看板 attendance.deductDetail[].totalDeduct（窗口累计，与看板同源），无记录的模块记 0；不在导出里重新聚合扣分。`,
    `班超分：取看板 attendance.score（唯一实现算好的值，导出不重算）= 10 − 卫生/查宿/晚自习/早操累计扣分 × 10% − 缺勤人次加权（普通/早八每人 0.02，病假/事假/公假 0.01），clamp 到 0~10；区间内没有检查记录写空。`,
    `校园跑达标：生效目标 = 个人计划优先、否则全局默认；目标 ≤ 0 视为已达标，判定一律为「步数 ≥ 目标」。日达标率 = 当日达标人数 ÷ 学生数；日平均达标率 = 各日达标率的平均（1 位小数）；日达标次数 = 达标率 100% 的天数；日达标最低值 = 各日最低达标率。周按 ISO 周（周一~周日）切分，周步数 = 窗口内该周每日步数之和，周平均 / 次数 / 最低值同上。窗口内没有有效日 / 周时对应单元格写空。`,
    `缺勤口径：班级明细 sheet 的应到 / 实到 / 名单取自 check_records.details（早操、晚自习用 shouldCount / actualCount / absentList；查宿用 shouldStay / actualCount / absentList，语义为未归；早八只有迟到名单，应到 / 实到留空）；名单写「姓名(假别) · 姓名」。`,
    `行数 / 张数上限：总标最多 ${SUMMARY_ROW_LIMIT} 行、班级明细 sheet 最多 ${CLASS_SHEET_LIMIT} 张、区间考勤明细单次最多 ${ATTENDANCE_ROW_LIMIT} 条，超出截断（详见「字段说明」sheet）。`,
  ];

  const sheets = [SUMMARY_SHEET, ...classSheets.map((s) => s.sheetName), DICT_SHEET];
  // 标题（用户 2026-11-20 第五轮）：
  //   「2026年11月16日至2026年11月22日（本周）2026级-2025级班级状态总表」
  // 年级段只在**有年级筛选**时出现（多选按年份降序、用「级-」连接；单选就是「2026级」）。
  const cnDate = (dayKey) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
    if (!m) return String(dayKey || '');
    return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
  };
  const gradeList = (Array.isArray(filter.grades) ? filter.grades : [])
    .map((g) => String(g || '').trim())
    .filter((g) => /^(19|20)\d{2}$/.test(g))
    .sort((a, b) => Number(b) - Number(a));
  const gradesText = gradeList.length ? `${gradeList.map((g) => `${g}级`).join('-')}` : '';
  const title = `${cnDate(from)}至${cnDate(to)}${attRangeLabel ? `（${attRangeLabel}）` : ''}${gradesText}班级状态总表`;

  return {
    columns: SUMMARY_COLUMNS,
    tableRows,
    classSheets,
    attendance,
    classSheetsTruncated: rows.length > CLASS_SHEET_LIMIT,
    sheets,
    meta: {
      title,
      subtitle,
      note,
      noteLines,
      // 考勤窗口 / 校园跑窗口分开给：前端与 verify 都按这个判断「数据属于哪个区间」
      from,
      to,
      runFrom,
      runTo,
      attRangeLabel,
      filterText,
      classCount: rows.length,
      studentCount,
      exportedAt,
      // 文件名用的日期（与页面所选日期一致；缺省今天）
      today: String(result.today || todayKey),
    },
  };
}

// ===== 三种格式的序列化（同一份 payload）=====

/** CSV：只有总标 22 列（缺省格式，旧客户端/脚本向后兼容），BOM 防 Excel 乱码 */
function sendCsv(res, payload) {
  const cell = (v) => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [payload.columns.map((c) => cell(c.title)).join(',')];
  for (const row of payload.tableRows) lines.push(row.map(cell).join(','));
  const csv = `\uFEFF${lines.join('\r\n')}`;
  const safeDay = String(payload.meta.today || dates.todayKey()).replace(/[^0-9A-Za-z-]/g, '');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="class-status-${safeDay}.csv"`);
  res.send(csv);
}

/** XLSX：微信 wx.openDocument 能直接预览（CSV 不行） */
function sendXlsx(res, payload) {
  const buf = buildWorkbook(payload);
  const safeDay = String(payload.meta.today || dates.todayKey()).replace(/[^0-9A-Za-z-]/g, '');
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="class-status-${safeDay}.xlsx"`);
  res.send(buf);
}

/**
 * JSON 预览：只回列定义 + 总标前 N 行 + total + sheets 名单，**不下发明细行**。
 * 小程序在「生成文件之前」用它画一张小表格 + 提示将导出几张 sheet。
 */
function jsonPreview(payload, { preview = false, limit } = {}) {
  const parseLimit = (v, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(50, Math.max(1, n)) : fallback;
  };
  const lim = parseLimit(limit, preview ? 5 : 50);
  const rows = preview ? payload.tableRows.slice(0, lim) : payload.tableRows;
  return {
    title: payload.meta.title,
    subtitle: payload.meta.subtitle,
    note: payload.meta.note,
    columns: payload.columns.map((c) => ({ title: c.title, wch: c.wch })),
    rows,
    total: payload.tableRows.length,
    sheets: payload.sheets,
    preview: !!preview,
  };
}

/**
 * 路由出口：按 format 分发（xlsx / csv / json；非法值回退 csv，旧客户端行为不变）。
 */
function respond(res, payload, { format, preview, limit } = {}) {
  const raw = String(format || '').trim().toLowerCase();
  const fmt = ['xlsx', 'csv', 'json'].includes(raw) ? raw : 'csv';
  if (fmt === 'json') {
    ok(res, jsonPreview(payload, { preview: ['1', 'true', 'yes'].includes(String(preview || '')), limit }));
    return;
  }
  if (fmt === 'xlsx') {
    sendXlsx(res, payload);
    return;
  }
  sendCsv(res, payload);
}

module.exports = {
  buildExport,
  buildWorkbook,
  jsonPreview,
  respond,
  sendCsv,
  sendXlsx,
  // 供检查器 / 验证脚本交叉核对（不是给前端用的接口字段）
  SUMMARY_COLUMNS,
  DETAIL_ATT_COLUMNS,
  DETAIL_RUN_COLUMNS,
  SUMMARY_ROW_LIMIT,
  CLASS_SHEET_LIMIT,
  ATTENDANCE_ROW_LIMIT,
};
