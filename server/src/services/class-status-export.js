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

// ===== 版式：Excel 成品美化（用户 2026-11-21「太难看了，格式化一下」）=====
// 用 exceljs（唯一新增依赖）而不是社区版 xlsx：后者**不支持单元格样式**（字体/底色/边框
// 都是 Pro 功能），只能改列宽，导出出来就是一坨黑白网格。ExcelJS 支持 fill/font/border/
// alignment/numFmt/freeze/autoFilter，且写出的仍是标准 xlsx（微信 wx.openDocument 可预览）。
const XLSX_COLORS = {
  brand: 'FFFF6B00',
  brandDeep: 'FFB45309',
  brandSoft: 'FFFFF4EC',
  brandSoft2: 'FFFFE6D2',
  white: 'FFFFFFFF',
  text: 'FF1F2329',
  text2: 'FF4B5563',
  text3: 'FF6B7280',
  line: 'FFE5E7EB',
  zebra: 'FFFFFBF7',
  good: 'FF15803D',
  warn: 'FFB45309',
  bad: 'FFD93025',
};
const XLSX_BORDER = {
  top: { style: 'thin', color: { argb: XLSX_COLORS.line } },
  left: { style: 'thin', color: { argb: XLSX_COLORS.line } },
  bottom: { style: 'thin', color: { argb: XLSX_COLORS.line } },
  right: { style: 'thin', color: { argb: XLSX_COLORS.line } },
};
const XLSX_FONT = '微软雅黑';

/** 「2026-11-16」→「2026年11月16日」（标题/口径说明里说人话用） */
function humanDay(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  if (!m) return String(dayKey || '');
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

/** 标题行：品牌浅橙底 + 加粗大字 + 横向合并 */
function styleSheetTitle(ws, rowNo, colCount, text) {
  ws.mergeCells(rowNo, 1, rowNo, colCount);
  const cell = ws.getCell(rowNo, 1);
  cell.value = text;
  cell.font = { name: XLSX_FONT, size: 15, bold: true, color: { argb: XLSX_COLORS.text } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_COLORS.brandSoft } };
  cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(rowNo).height = 34;
}

/** 副标题行：灰字小字 + 浅灰底（区间 / 筛选 / 导出时间） */
function styleSheetSubtitle(ws, rowNo, colCount, text) {
  ws.mergeCells(rowNo, 1, rowNo, colCount);
  const cell = ws.getCell(rowNo, 1);
  cell.value = text;
  cell.font = { name: XLSX_FONT, size: 10, color: { argb: XLSX_COLORS.text2 } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
  cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(rowNo).height = 22;
}

/** 表头行：品牌橙底 + 白字加粗居中 + 细边框（Excel 里像表头，而不是普通行） */
function styleHeaderRow(ws, rowNo, columns) {
  const row = ws.getRow(rowNo);
  row.height = 30;
  columns.forEach((c, i) => {
    const cell = row.getCell(i + 1);
    cell.value = c.title;
    cell.font = { name: XLSX_FONT, size: 10, bold: true, color: { argb: XLSX_COLORS.white } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_COLORS.brand } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = XLSX_BORDER;
  });
}

/** 小节标题（明细表 A/B、字段说明表头等）：浅橙底 + 深橙加粗 */
function styleSectionTitle(ws, rowNo, colCount, text) {
  ws.mergeCells(rowNo, 1, rowNo, colCount);
  const cell = ws.getCell(rowNo, 1);
  cell.value = text;
  cell.font = { name: XLSX_FONT, size: 11, bold: true, color: { argb: XLSX_COLORS.brandDeep } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_COLORS.brandSoft2 } };
  cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(rowNo).height = 24;
}

/**
 * 数据行：细边框 + 隔行浅底 + 数值右对齐 / 文本左对齐；可指定哪些列换行。
 * @param {number[]} numericCols 1-based 数值列（右对齐）
 * @param {number[]} wrapCols 1-based 需要自动换行的长文本列（缺勤名单 / 备注）
 */
function styleDataRows(ws, startRow, rows, colCount, { numericCols = [], wrapCols = [], centerCols = [], light = false } = {}) {
  const numSet = new Set(numericCols);
  const wrapSet = new Set(wrapCols);
  const centerSet = new Set(centerCols);
  // 样式对象**预先建好共享**：47 张 sheet × 上万单元格时，每格 new 3 个对象会把生成时间拖到
  // 十几秒（实测 15.6s，导出按钮像卡死）。共享后 ExcelJS 写档只按样式 id 复用，快一个数量级。
  const BODY_FONT = { name: XLSX_FONT, size: 10, color: { argb: XLSX_COLORS.text } };
  const ZEBRA_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_COLORS.zebra } };
  const alignCache = new Map();
  const alignOf = (horizontal, wrapText) => {
    const key = `${horizontal}|${wrapText ? 1 : 0}`;
    let v = alignCache.get(key);
    if (!v) {
      v = { vertical: 'middle', horizontal, wrapText };
      alignCache.set(key, v);
    }
    return v;
  };
  rows.forEach((values, ri) => {
    const row = ws.getRow(startRow + ri);
    const fill = ri % 2 === 1 ? ZEBRA_FILL : null;
    for (let c = 1; c <= colCount; c += 1) {
      const cell = row.getCell(c);
      const v = values[c - 1];
      cell.value = v === undefined || v === null ? '' : v;
      if (!light) {
        cell.font = BODY_FONT;
        cell.border = XLSX_BORDER;
        if (fill) cell.fill = fill;
      }
      cell.alignment = alignOf(numSet.has(c) ? 'right' : centerSet.has(c) ? 'center' : 'left', wrapSet.has(c));
    }
    row.height = 20;
  });
}

/** 表尾「口径说明」小节标题 + 逐条整段合并（自动换行，Excel 打开时按内容撑高） */
function styleNoteBlock(ws, startRow, colCount, notes) {
  ws.mergeCells(startRow, 1, startRow, colCount);
  const head = ws.getCell(startRow, 1);
  head.value = '口径说明（这份表怎么算出来的）';
  head.font = { name: XLSX_FONT, size: 11, bold: true, color: { argb: XLSX_COLORS.brandDeep } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_COLORS.brandSoft2 } };
  head.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(startRow).height = 24;
  notes.forEach((line, i) => {
    const rowNo = startRow + 1 + i;
    ws.mergeCells(rowNo, 1, rowNo, colCount);
    const cell = ws.getCell(rowNo, 1);
    cell.value = `${i + 1}. ${line}`;
    cell.font = { name: XLSX_FONT, size: 10, color: { argb: XLSX_COLORS.text2 } };
    cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true, indent: 1 };
    cell.border = { bottom: { style: 'hair', color: { argb: XLSX_COLORS.line } } };
  });
}

// ===== 版式：总标 sheet =====
function buildSummarySheet(wb, payload) {
  const ExcelJS = require('exceljs');
  const columns = payload.columns;
  const colCount = columns.length;
  const ws = wb.addWorksheet(SUMMARY_SHEET, {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 3 }],
    properties: { defaultRowHeight: 18 },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  ws.columns = columns.map((c) => ({ width: Math.max(6, c.wch || 14) }));
  styleSheetTitle(ws, 1, colCount, payload.meta.title);
  styleSheetSubtitle(ws, 2, colCount, payload.meta.subtitle);
  styleHeaderRow(ws, 3, columns);
  // 数据行：1 序号居中；数值列（学生数起）右对齐
  const dataStart = 4;
  const numericCols = [];
  for (let i = 6; i <= colCount; i += 1) numericCols.push(i); // 学生数(6) 之后都是数字/百分比/计数
  styleDataRows(ws, dataStart, payload.tableRows, colCount, { numericCols, centerCols: [1, 5] });
  // 班超分（第 15 列）按分段上色，一眼能看出谁差
  const scoreCol = columns.findIndex((c) => c.title === '班超分') + 1;
  if (scoreCol > 0) {
    payload.tableRows.forEach((row, ri) => {
      const v = Number(row[scoreCol - 1]);
      if (!Number.isFinite(v) || row[scoreCol - 1] === '') return;
      const cell = ws.getCell(dataStart + ri, scoreCol);
      const color = v < 8 ? XLSX_COLORS.bad : v < 9.2 ? XLSX_COLORS.warn : XLSX_COLORS.good;
      cell.font = { name: XLSX_FONT, size: 10, bold: true, color: { argb: color } };
    });
  }
  const dataEnd = dataStart + payload.tableRows.length - 1;
  if (payload.tableRows.length) {
    ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: dataEnd, column: colCount } };
  }
  ws.pageSetup.printTitlesRow = '3:3';
  const noteStart = dataEnd + 2;
  styleNoteBlock(ws, noteStart, colCount, payload.meta.noteLines);
  return ws;
}

/** 版式：每班一张明细 sheet（上：区间考勤明细；下：校园跑每人数据；表尾说人话的口径） */
function buildClassSheet(wb, payload, sheet) {
  const attCols = DETAIL_ATT_COLUMNS;
  const runCols = DETAIL_RUN_COLUMNS;
  const colCount = Math.max(attCols.length, runCols.length);
  const ws = wb.addWorksheet(sheet.sheetName, {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 4 }],
    properties: { defaultRowHeight: 18 },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  ws.columns = Array.from({ length: colCount }, (_, i) => ({ width: DETAIL_COL_WIDTHS[i] || 12 }));
  styleSheetTitle(ws, 1, colCount, `${sheet.className} · 详细数据`);
  styleSheetSubtitle(ws, 2, colCount, `统计区间：${payload.meta.from} ~ ${payload.meta.to} ｜ 导出时间：${payload.meta.exportedAt}`);

  // A. 区间考勤明细
  styleSectionTitle(ws, 3, colCount, `A. 这一周的每一次检查（共 ${sheet.attRows.length} 条）`);
  const attHeaderRow = 4;
  const attHeaderCols = attCols.map((c) => ({ title: c.title }));
  styleHeaderRow(ws, attHeaderRow, attHeaderCols);
  const attStart = attHeaderRow + 1;
  styleDataRows(ws, attStart, sheet.attRows, attCols.length, {
    numericCols: [5, 6, 8, 9], // 应到 / 实到 / 得分 / 扣分
    centerCols: [2, 12, 14], // 时段 / 状态 / 照片数
    wrapCols: [7, 13], // 缺勤名单 / 备注
  });

  // B. 校园跑每人数据
  const secBRow = attStart + sheet.attRows.length + 1;
  styleSectionTitle(ws, secBRow, colCount, `B. 这一周每位同学的跑步达标情况（统计到 ${payload.meta.runTo}）`);
  const runHeaderRow = secBRow + 1;
  styleHeaderRow(ws, runHeaderRow, runCols);
  const runStart = runHeaderRow + 1;
  styleDataRows(ws, runStart, sheet.runRows, runCols.length, {
    numericCols: [3, 4, 5, 6, 7, 8, 9],
    centerCols: [1],
  });

  const noteStart = runStart + sheet.runRows.length + 1;
  styleNoteBlock(ws, noteStart, colCount, sheet.noteLines);
  return ws;
}

// ===== 版式：字段说明 sheet =====
const SUMMARY_FIELD_DESC = {
  序号: '第几个班，从 1 开始',
  院校: '这个班属于哪个校区（院校）',
  系部: '这个班属于哪个系部',
  专业: '班级对应的专业名称',
  年级: '入学年份，如 2026 就是 2026 级',
  学生数: '这个班在籍的学生人数（不含老师），也是达标率、人均步数的分母',
  住宿数: '在宿舍住的学生人数',
  班委数: '班里的班委人数',
  学生会成员数: '这个班在学生会的成员人数',
  卫生累计扣分: '这一周卫生检查一共扣了多少分；没有检查就是 0',
  晚自习累计扣分: '这一周晚自习考勤一共扣了多少分；没有记录就是 0',
  查宿累计扣分: '这一周查宿（未归）一共扣了多少分；没有记录就是 0',
  早操累计扣分: '这一周早操考勤一共扣了多少分；没有记录就是 0',
  早八累计扣分: '这一周早八迟到一共扣了多少分；没有记录就是 0',
  班超分: '满分 10 分：先扣掉卫生、查宿、晚自习、早操这四项累计扣分的 10%，再按缺勤人数扣——普通缺勤每人 0.02 分，病假/事假/公假每人 0.01 分，早八迟到每人 0.02 分。这一周没有检查记录时留空，不是 0 分',
  校园跑班级日目标平均达标率: '每天「达标人数 ÷ 班级人数」的百分比，再对这一周每天取平均；没有跑步数据时留空',
  校园跑班级周目标平均达标率: '每周「达标人数 ÷ 班级人数」的百分比，再对每周取平均；没有跑步数据时留空',
  校园跑班级日目标达标次数: '这一周里，全班所有人当天都达标（100%）的天数',
  校园跑班级周目标达标次数: '这一周里，全班所有人当周都达标（100%）的周数',
  校园跑班级日目标达标最低值: '这一周里表现最差的那一天，全班的达标率是多少',
  校园跑班级周目标达标最低值: '这一周里表现最差的那一周，全班的达标率是多少',
  校园跑累计步数: '这一周全班学生加起来的步数',
  校园跑人均累计步数: '这一周全班步数 ÷ 班级人数，平均每人走了多少步',
};

function buildDictSheet(wb, payload) {
  const ws = wb.addWorksheet(DICT_SHEET, {
    views: [{ state: 'frozen', xSplit: 0, ySplit: 2 }],
    properties: { defaultRowHeight: 18 },
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = [{ width: 26 }, { width: 92 }];
  styleSheetTitle(ws, 1, 2, '字段说明（每个表头是什么意思）');
  styleHeaderRow(ws, 2, [{ title: '字段' }, { title: '含义（说人话版）' }]);
  const rows = [
    ...payload.columns.map((c) => [c.title, SUMMARY_FIELD_DESC[c.title] || '']),
    ['工作表结构', `第 1 张「${SUMMARY_SHEET}」是总表，一个班一行；后面每个班一张「详细数据」，可以看每一次检查是谁查的、谁复核的，以及每位同学的跑步达标情况；最后就是本页。`],
    ['班级明细上限', `最多 ${CLASS_SHEET_LIMIT} 个班；本次 ${payload.classSheets.length} 个班${payload.classSheetsTruncated ? '，超出的部分已截断' : ''}。`],
    ['总标行数上限', `最多 ${SUMMARY_ROW_LIMIT} 个班；本次 ${payload.tableRows.length} 个班。`],
    ['考勤明细上限', `每份导出最多 ${ATTENDANCE_ROW_LIMIT} 条检查记录；本次 ${payload.attendance.total} 条${payload.attendance.truncated ? '，超出的部分已截断' : ''}。`],
    ['统计区间', `考勤和扣分统计的是 ${payload.meta.from} 到 ${payload.meta.to}；校园跑统计到 ${payload.meta.runTo}（今天），后面的日子还没到，不算进达标率。`],
    ['筛选条件', payload.meta.filterText],
    ['导出时间', payload.meta.exportedAt],
  ];
  styleDataRows(ws, 3, rows, 2, { wrapCols: [2] });
  return ws;
}

/** 生成完整 xlsx 工作簿（总标 + 每班明细 + 字段说明）—— 异步（ExcelJS writeBuffer 是 Promise） */
async function buildWorkbook(payload) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = '唐唐快跑';
  wb.created = new Date();
  buildSummarySheet(wb, payload);
  for (const sheet of payload.classSheets) buildClassSheet(wb, payload, sheet);
  buildDictSheet(wb, payload);
  return wb.xlsx.writeBuffer();
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
      `A 部分是这一周（${from} 到 ${to}）的每一次检查：应到 / 实到就是当时检查录入的人数。早八只记迟到的人，所以它没有应到 / 实到。`,
      `缺勤名单里括号是请假类型（病假 / 事假 / 公假）；早八只记迟到，没有假别。`,
      `状态说明：已提交 = 录入人交上来了；已复核 = 学生会复核通过；已退回 / 已取消 = 不计入分数。`,
      `B 部分是这一周每位同学的跑步：每人有每日目标和每周目标（没设个人目标就用学校默认），当天步数达到目标就算达标。日达标率 = 达标天数 ÷ 统计天数，周达标率同理。`,
      `校园跑统计到 ${runTo}（今天），不包含还没到的日子。`,
      `本班这一周共 ${attRows.length} 条检查记录。`,
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
  // 副标题 / 口径说明都写成**老师能直接看懂的话**（用户 2026-11-21：别再堆字段名和公式符号）。
  const subtitle = `统计区间：${humanDay(from)} ~ ${humanDay(to)}${attRangeLabel ? `（${attRangeLabel}）` : ''} ｜ 筛选：${filterText} ｜ 共 ${rows.length} 个班 / ${studentCount} 人 ｜ 导出时间：${exportedAt}`;
  const note =
    '这张总表一个班一行，汇总这一周的考勤扣分和校园跑达标情况；每个班后面还有一张「详细数据」表，能看到每次检查是谁查的、谁复核的，以及每位同学的跑步达标情况。';

  // 表尾口径说明（总标 sheet 尾部整段跨列）：说人话，不写字段名 / 公式符号。
  const noteLines = [
    `这份表统计的是 ${humanDay(from)} 到 ${humanDay(to)}${attRangeLabel ? `（${attRangeLabel}）` : ''} 的检查情况。`,
    `校园跑只统计到 ${humanDay(runTo)}（今天）：后面的日子还没到，算进去会把达标率拉低，所以不统计。`,
    '「累计扣分」是这一周里卫生、晚自习、查宿、早操、早八各扣了多少分，直接从「班级状态」页拿过来，导出时没有重新算。',
    '班超分满分 10 分。算法：先扣掉卫生、查宿、晚自习、早操这四项这一周累计扣分的 10%，再按缺勤人数扣分——普通缺勤每人扣 0.02 分，病假、事假、公假每人扣 0.01 分；早八迟到只按人数扣（每人 0.02 分）。最低扣到 0 分。这一周一次检查都没有的班，这一格是空的，不是 0 分。',
    '校园跑达标：每个学生有自己的每日目标和每周目标（没设个人目标就用学校默认）。当天步数达到目标算达标；达标人数 ÷ 班级人数 = 达标率。',
    '「达标次数」是全班所有人都达标的天数 / 周数；「最低值」是这段时间里最差的一天 / 一周的达标率。',
    '每个班都有一张「详细数据」表：A 部分是这一周每一次检查的记录（含检查人、复核人、缺勤名单），B 部分是每位同学这一周的跑步达标情况。',
    `最多导出 ${SUMMARY_ROW_LIMIT} 个班、每个班 ${ATTENDANCE_ROW_LIMIT} 条检查记录；超出的部分会被截断。`,
  ];

  const sheets = [SUMMARY_SHEET, ...classSheets.map((s) => s.sheetName), DICT_SHEET];
  // 标题（用户 2026-11-20 第五轮）：
  //   「2026年11月16日至2026年11月22日（本周）2026级-2025级班级状态总表」
  // 年级段只在**有年级筛选**时出现（多选按年份降序、用「级-」连接；单选就是「2026级」）。
  const gradeList = (Array.isArray(filter.grades) ? filter.grades : [])
    .map((g) => String(g || '').trim())
    .filter((g) => /^(19|20)\d{2}$/.test(g))
    .sort((a, b) => Number(b) - Number(a));
  const gradesText = gradeList.length ? `${gradeList.map((g) => `${g}级`).join('-')}` : '';
  const title = `${humanDay(from)}至${humanDay(to)}${attRangeLabel ? `（${attRangeLabel}）` : ''}${gradesText}班级状态总表`;

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

/** CSV：只有总标 23 列（缺省格式，旧客户端/脚本向后兼容），BOM 防 Excel 乱码 */
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
async function sendXlsx(res, payload) {
  const buf = await buildWorkbook(payload);
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
async function respond(res, payload, { format, preview, limit } = {}) {
  const raw = String(format || '').trim().toLowerCase();
  const fmt = ['xlsx', 'csv', 'json'].includes(raw) ? raw : 'csv';
  if (fmt === 'json') {
    ok(res, jsonPreview(payload, { preview: ['1', 'true', 'yes'].includes(String(preview || '')), limit }));
    return;
  }
  if (fmt === 'xlsx') {
    await sendXlsx(res, payload);
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
  // 版式工具：classes/class-report-export.js（班超日报/周报/月报）复用同一套配色与排版，
  // 不许那边再写一份「品牌橙 + 微软雅黑」的字面量（同一样式两处维护必然漂移）。
  XLSX_COLORS,
  XLSX_BORDER,
  XLSX_FONT,
  humanDay,
  styleSheetTitle,
  styleSheetSubtitle,
  styleHeaderRow,
  styleSectionTitle,
  styleDataRows,
  styleNoteBlock,
};
