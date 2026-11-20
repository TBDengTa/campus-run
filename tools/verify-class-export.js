// 端到端验证：班级状态导出工作簿（用户 2026-11-20 定稿：总标 + 每班明细）
//
// 需求原文：「导出工作簿改为『总标 + 每班明细』；筛选/范围与看板完全一致」。
//
// 实现：
//   · GET /api/admin/class/status-export（routes/admin/class-profile.js，只做鉴权/取参）
//   · services/class-status-export.js（工作簿的唯一实现：总标 22 列 + 每班一张详细数据 + 字段说明）
//
// 这个脚本真连库、真挂 routes/admin/index.js（auth 中间件按 header 打桩成指定账号），
// 造一个临时班 + 已知检查/跑步/目标数据，然后：
//   ① 把「总标」逐格与独立手算的期望值对账（学生数/住宿数/班委数/学生会成员数/五模块累计扣分/
//      校园跑日周达标率·次数·最低值/累计步数·人均）
//   ② 把「每班明细」sheet 的两块内容与手算对账（含名单假别、检查人/复核人/状态、每生达标数据）
//   ③ 验证三种格式（xlsx / csv / json 预览）与权限、只读
//
// 用法：node tools/verify-class-export.js
// 需要能连上 server/.env 里的数据库。只写带时间戳前缀的临时数据，跑完即删并核对残留为 0。
const path = require('path');
const serverDir = path.join(__dirname, '..', 'server');
const config = require(path.join(serverDir, 'src', 'config'));
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));
const express = require(path.join(serverDir, 'node_modules', 'express'));

const User = require(path.join(serverDir, 'src', 'models', 'user'));
const ClassProfile = require(path.join(serverDir, 'src', 'models', 'class-profile'));
const CheckRecord = require(path.join(serverDir, 'src', 'models', 'check-record'));
const RunRecord = require(path.join(serverDir, 'src', 'models', 'run-record'));
const UserGoal = require(path.join(serverDir, 'src', 'models', 'user-goal'));
const GoalConfig = require(path.join(serverDir, 'src', 'models', 'goal-config'));
const UnionMember = require(path.join(serverDir, 'src', 'models', 'union-member'));
const DormAssignment = require(path.join(serverDir, 'src', 'models', 'dorm-assignment'));
const dates = require(path.join(serverDir, 'src', 'utils', 'dates'));
const boardSvc = require(path.join(serverDir, 'src', 'services', 'class-status-board'));
const checkModules = require(path.join(serverDir, 'src', 'services', 'check-modules'));
const XLSX = require(path.join(serverDir, 'node_modules', 'xlsx'));

let failed = 0;
function assert(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ← ' + JSON.stringify(extra)}`);
  if (!cond) failed += 1;
}

const TS = Date.now();
const TAG = `exp_verify_${TS}`;
// 班级名要短：Excel sheet 名上限 31 字，`<className>详细数据` 不能被截断（截断断言会假红）
const CLS = `导${String(TS).slice(-8)}班`;

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const pctCell = (v) => (v === null || v === undefined ? '' : `${round1(v)}%`);

// 独立算「某日期所在 ISO 周的周一」：不复用被测的 dates.weekRange
function mondayOf(key) {
  const d = new Date(`${key}T00:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, '0')}`;
}

// 简易 CSV 解析：本接口每个单元格都被双引号包裹，内部双引号转义为 ""
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
function parseCsv(text) {
  const body = text.replace(/^\uFEFF/, '');
  const lines = body.split('\r\n').filter((l) => l.length > 0);
  const rows = lines.map(parseCsvLine);
  return { header: rows[0] || [], rows: rows.slice(1) };
}

function sheetRows(wb, name) {
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
}

const SUMMARY_HEADER = [
  '序号',
  '院校',
  '系部',
  '专业',
  '年级',
  '学生数',
  '住宿数',
  '班委数',
  '学生会成员数',
  '卫生累计扣分',
  '晚自习累计扣分',
  '查宿累计扣分',
  '早操累计扣分',
  '早八累计扣分',
  '校园跑班级日目标平均达标率',
  '校园跑班级周目标平均达标率',
  '校园跑班级日目标达标次数',
  '校园跑班级周目标达标次数',
  '校园跑班级日目标达标最低值',
  '校园跑班级周目标达标最低值',
  '校园跑累计步数',
  '校园跑人均累计步数',
];

/**
 * 校园跑区间统计的独立实现（只按需求文字逐步算，不调用被测服务）：
 *   · 窗口 = 看板 from ~ min(看板 to, 今天)
 *   · 日：每天「达标人数 ÷ 学生数」；平均/最低取 1 位小数百分比；达标次数 = 100% 的天数
 *   · 周：按 ISO 周（周一~周日）切窗口内日期，每人该周步数 = 窗口内该周之和
 *   · 达标判定：步数 >= 目标（目标 <= 0 时天然为已达标）
 * @param {object} p { board, students:[{openid,daily,weekly}], seeds:[{openid,date,steps}], studentCount }
 */
function expectedRunStats({ board, students, seeds, studentCount }) {
  const to = board.to < dates.todayKey() ? board.to : dates.todayKey();
  const days = [];
  if (board.from <= to) {
    for (let k = board.from; k <= to; k = dates.addDays(k, 1)) days.push(k);
  }
  const weeks = [];
  for (const d of days) {
    const start = mondayOf(d);
    let w = weeks.find((x) => x.start === start);
    if (!w) {
      w = { start, days: [] };
      weeks.push(w);
    }
    w.days.push(d);
  }
  const stepsOf = (openid, day) =>
    seeds.filter((s) => s.openid === openid && s.date === day).reduce((a, s) => a + s.steps, 0);
  // 百分比先保留未舍入原值，最终展示再 1 位小数（与需求「各日百分比的平均」一致）
  const rawPct = (achieved) => (studentCount > 0 ? (achieved / studentCount) * 100 : null);

  const dayAchieved = days.map((day) => {
    let achieved = 0;
    for (const s of students) if (stepsOf(s.openid, day) >= s.daily) achieved += 1;
    return achieved;
  });
  const weekAchieved = weeks.map((w) => {
    let achieved = 0;
    for (const s of students) {
      let steps = 0;
      for (const d of w.days) steps += stepsOf(s.openid, d);
      if (steps >= s.weekly) achieved += 1;
    }
    return achieved;
  });
  const dayPcts = dayAchieved.map(rawPct).filter((v) => v !== null);
  const weekPcts = weekAchieved.map(rawPct).filter((v) => v !== null);
  const avg = (list) => (list.length ? round1(list.reduce((a, b) => a + b, 0) / list.length) : null);
  const fullCount = (list) => (studentCount > 0 ? list.filter((a) => a >= studentCount).length : 0);

  const perStudent = {};
  for (const s of students) {
    const achievedDays = days.filter((d) => stepsOf(s.openid, d) >= s.daily).length;
    let achievedWeeks = 0;
    let total = 0;
    for (const w of weeks) {
      let steps = 0;
      for (const d of w.days) steps += stepsOf(s.openid, d);
      total += steps;
      if (steps >= s.weekly) achievedWeeks += 1;
    }
    perStudent[s.openid] = {
      achievedDays,
      dailyRate: days.length ? round1((achievedDays / days.length) * 100) : null,
      achievedWeeks,
      weeklyRate: weeks.length ? round1((achievedWeeks / weeks.length) * 100) : null,
      total,
    };
  }
  const totalSteps = Object.values(perStudent).reduce((a, r) => a + r.total, 0);
  return {
    days,
    weeks,
    dailyAvg: avg(dayPcts),
    dailyFullDays: fullCount(dayAchieved),
    dailyMin: dayPcts.length ? round1(Math.min(...dayPcts)) : null,
    weeklyAvg: avg(weekPcts),
    weeklyFullWeeks: fullCount(weekAchieved),
    weeklyMin: weekPcts.length ? round1(Math.min(...weekPcts)) : null,
    totalSteps,
    avgSteps: studentCount > 0 ? Math.round(totalSteps / studentCount) : 0,
    perStudent,
  };
}

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });

  // ---- 0) 起真实管理端路由（auth 打桩：按 x-actor 指定账号）----
  const authMw = require(path.join(serverDir, 'src', 'middlewares', 'auth'));
  const actors = new Map();
  authMw.auth = (req, res, next) => {
    const who = req.headers['x-actor'] || '';
    if (who === 'anon') return res.status(401).json({ code: 401, message: '未登录' });
    const doc = actors.get(who);
    if (!doc) return res.status(401).json({ code: 401, message: 'unknown actor' });
    req.user = doc;
    next();
  };
  const adminRouter = require(path.join(serverDir, 'src', 'routes', 'admin', 'index'));
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code || 500, message: err.message }));
  const port = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s.address().port));
  });
  const BASE = `http://127.0.0.1:${port}`;
  const call = async (who, url, method = 'GET') => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { 'x-actor': who } });
    // ⚠️ 必须用原始字节判 BOM：fetch 的 text() 会吃掉开头 BOM，用 text() 永远验不出来
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString('utf8');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, bytes, json };
  };

  const DAY = dates.todayKey(); // 导出/看板都锚定今天，窗口可手算
  const MON = mondayOf(DAY);
  const openids = [`${TAG}_u1`, `${TAG}_u2`, `${TAG}_u3`];
  const createdUserIds = [];
  const studentIds = [`${TS}1`, `${TS}2`, `${TS}3`];

  // ---- 手工期望值（与任何被测实现无关）----
  // 五模块每条记录一个（date=today，周/月窗口都包含）：
  //   卫生 2.00 / 晚自习 0.30 / 查宿 0.20 / 早操 0.50 / 早八 0.10
  const DEDUCT = { hygiene: 2, study_evening: 0.3, night_dorm: 0.2, morning_exercise: 0.5, morning_class: 0.1 };

  // 临时数据构造（跑步记录：s1 周一 9000 + 今天 5000 + 本月 1 号 7000；s2 今天 6000；s3 没有）
  const RUN_SEEDS = [
    { openid: openids[0], date: MON, steps: 9000 },
    { openid: openids[0], date: DAY, steps: 5000 },
    { openid: openids[0], date: `${DAY.slice(0, 7)}-01`, steps: 7000 },
    { openid: openids[1], date: DAY, steps: 6000 },
  ];

  try {
    // ---- 1) 造临时班 / 学生 / 班委 / 教师 / 学生会成员 / 住宿 / 目标 / 记录 / 跑步 ----
    const adminUser = await User.create({
      openid: `${TAG}_admin`,
      account: `${TAG}_admin`,
      realName: '导出-管理员',
      role: 'teacher',
      permissions: ['class.view'],
    });
    const nopermUser = await User.create({
      openid: `${TAG}_noperm`,
      account: `${TAG}_noperm`,
      realName: '导出-无权限',
      role: 'teacher',
      permissions: [],
    });
    createdUserIds.push(adminUser._id, nopermUser._id);
    actors.set('admin', adminUser);
    actors.set('noperm', nopermUser);

    await ClassProfile.create({
      className: CLS,
      status: 'normal',
      schoolName: '导出测试学院',
      departmentName: '导出测试系',
      grade: '2026',
      specialty: '导出测试专业',
    });

    const s1 = await User.create({
      openid: openids[0],
      account: openids[0],
      realName: '张三',
      studentId: studentIds[0],
      role: 'student',
      className: CLS,
      specialty: '导出测试专业',
      isClassOfficer: true, // 班委数 = 1
    });
    const s2 = await User.create({
      openid: openids[1],
      account: openids[1],
      realName: '李四',
      studentId: studentIds[1],
      role: 'student',
      className: CLS,
    });
    const s3 = await User.create({
      openid: openids[2],
      account: openids[2],
      realName: '王五',
      studentId: studentIds[2],
      role: 'student',
      className: CLS,
    });
    // 教师即使被误标班委也不占班级人数/班委数
    const teacher = await User.create({
      openid: `${TAG}_t1`,
      account: `${TAG}_t1`,
      realName: '导出教师',
      role: 'teacher',
      className: CLS,
      isClassOfficer: true,
    });
    createdUserIds.push(s1._id, s2._id, s3._id, teacher._id);

    // 学生会成员：1 个 active（应计入）+ 1 个 left（不应计入）
    await UnionMember.create({
      userId: s1._id,
      openid: s1.openid,
      realName: '张三',
      studentId: studentIds[0],
      className: CLS,
      level: 'branch',
      deptKey: `${TAG}_dept`,
      role: 'member',
      status: 'active',
    });
    await UnionMember.create({
      userId: s2._id,
      openid: s2.openid,
      realName: '李四',
      studentId: studentIds[1],
      className: CLS,
      level: 'branch',
      deptKey: `${TAG}_dept_left`,
      role: 'member',
      status: 'left',
    });

    // 住宿数 = 1（checked_in 在住）
    await DormAssignment.create({
      userId: s1._id,
      openid: s1.openid,
      realName: '张三',
      studentId: studentIds[0],
      className: CLS,
      buildingName: '导出测试楼',
      roomNo: '101',
      status: 'checked_in',
    });

    // 个人目标：s1 = 3000/8000；s2 无个人计划（用全局默认）；s3 = 0/0（目标 ≤0 视为已达标）
    await UserGoal.create({
      openid: s1.openid,
      daily: { steps: 3000 },
      weekly: { steps: 8000 },
    });
    await UserGoal.create({
      openid: s3.openid,
      daily: { steps: 0 },
      weekly: { steps: 0 },
    });
    const globalConfig = await GoalConfig.getSingleton();
    const globalDaily = Number(globalConfig.daily && globalConfig.daily.steps) || 0;
    const globalWeekly = Number(globalConfig.weekly && globalConfig.weekly.steps) || 0;
    // 学生目标表（手算用）
    const goalStudents = [
      { openid: openids[0], daily: 3000, weekly: 8000 },
      { openid: openids[1], daily: globalDaily, weekly: globalWeekly },
      { openid: openids[2], daily: 0, weekly: 0 },
    ];

    for (const seed of RUN_SEEDS) {
      await RunRecord.create({ openid: seed.openid, source: 'werun', date: seed.date, steps: seed.steps, distance: 0 });
    }

    // 检查记录：5 个模块各一条（今天）+ 1 条 rejected（不计入）
    await CheckRecord.create({
      moduleKey: 'morning_exercise',
      date: DAY,
      period: 'morning',
      targetType: 'class',
      targetId: CLS,
      targetName: CLS,
      className: CLS,
      details: {
        shouldCount: 40,
        actualCount: 38,
        absentCount: 2,
        absentList: [
          { name: '张三', reason: '病假' },
          { name: '李四', reason: '' },
        ],
      },
      metrics: { ratios: { rate: 38 / 40 } },
      score: 0,
      deduct: DEDUCT.morning_exercise,
      status: 'submitted',
      inspectorName: '导出检查人',
    });
    await CheckRecord.create({
      moduleKey: 'study_evening',
      date: DAY,
      period: 'evening_study',
      targetType: 'classroom',
      targetId: `${TAG}_classroom`,
      targetName: '导出教室101',
      className: CLS,
      details: {
        shouldCount: 30,
        actualCount: 27,
        absentCount: 3,
        absentList: [
          { name: '张三', reason: '病假' },
          { name: '王五', reason: '事假' },
        ],
        remark: '晚自习备注',
      },
      metrics: { ratios: { rate: 27 / 30 } },
      score: 0,
      deduct: DEDUCT.study_evening,
      status: 'approved',
      inspectorName: '导出检查人',
      reviewedByName: '导出复核人',
      photos: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
      remark: '晚自习备注',
    });
    await CheckRecord.create({
      moduleKey: 'night_dorm',
      date: DAY,
      period: 'night',
      targetType: 'dorm_room',
      targetId: `${TAG}_room`,
      targetName: '导出测试楼 101',
      className: CLS,
      details: {
        shouldStay: 6,
        actualCount: 5,
        notReturnedCount: 1,
        absentList: [{ name: '李四', reason: '事假' }],
      },
      metrics: { ratios: { rate: 5 / 6 } },
      score: 0,
      deduct: DEDUCT.night_dorm,
      status: 'submitted',
      inspectorName: '导出检查人',
    });
    await CheckRecord.create({
      moduleKey: 'morning_class',
      date: DAY,
      period: 'morning_class',
      targetType: 'class',
      targetId: CLS,
      targetName: CLS,
      className: CLS,
      details: { lateList: [{ name: '王五' }], lateCount: 1 },
      metrics: { values: { lateCount: 1 } },
      score: 0,
      deduct: DEDUCT.morning_class,
      status: 'submitted',
      inspectorName: '导出检查人',
    });
    await CheckRecord.create({
      moduleKey: 'hygiene',
      date: DAY,
      period: '',
      targetType: 'dorm_room',
      targetId: `${TAG}_room`,
      targetName: '导出测试楼 101',
      className: CLS,
      details: { grade: ['良'], score: 8, remark: '卫生备注' },
      metrics: { values: { score: 8 } },
      score: 8,
      deduct: DEDUCT.hygiene,
      status: 'submitted',
      inspectorName: '导出检查人',
      remark: '卫生备注',
    });
    await CheckRecord.create({
      moduleKey: 'hygiene',
      date: DAY,
      period: 'rejected_only',
      targetType: 'area',
      targetId: `${TAG}_rejected`,
      targetName: '不应出现的记录',
      className: CLS,
      details: { grade: ['差'], score: 6 },
      score: 6,
      deduct: 9,
      status: 'rejected',
      inspectorName: '导出检查人',
    });

    // 模块中文名（库里可被运营改名，断言用同一份字典，不写死）
    const modules = await checkModules.listModules();
    const moduleNameOf = (key) => {
      const m = modules.find((x) => x.key === key);
      return m ? String(m.shortName || m.name || key) : key;
    };

    // ---- 2) 先强刷看板（导出路由会用同一份缓存快照），取出本周/本月窗口 ----
    const boardW = await boardSvc.classStatusBoard({ today: DAY, attRange: 'week', force: true });
    const rowW = (boardW.rows || []).find((r) => r.className === CLS);
    assert(!!rowW, '临时班出现在本周看板里', (boardW.rows || []).length);
    assert(rowW && rowW.studentCount === 3, '看板学生数 = 3（教师不计入）', rowW && rowW.studentCount);
    const expW = expectedRunStats({ board: boardW, students: goalStudents, seeds: RUN_SEEDS, studentCount: 3 });

    // ---- 3) 总标：CSV 22 列、行数 = 看板行数、临时班逐格手算 ----
    console.log('\n[1] 总标（CSV 22 列 / 逐格手算）');
    const csvW = await call('admin', `/api/admin/class/status-export?attRange=week&today=${DAY}&format=csv`);
    assert(csvW.status === 200, 'csv 导出 → 200', csvW.status);
    assert(/text\/csv/.test(csvW.headers.get('content-type') || ''), 'Content-Type = text/csv', csvW.headers.get('content-type'));
    assert(/attachment/.test(csvW.headers.get('content-disposition') || ''), 'Content-Disposition = attachment', csvW.headers.get('content-disposition'));
    assert(csvW.bytes[0] === 0xef && csvW.bytes[1] === 0xbb && csvW.bytes[2] === 0xbf, 'CSV 以 UTF-8 BOM 开头', [...csvW.bytes.slice(0, 3)]);
    const csvParsed = parseCsv(csvW.text);
    assert(JSON.stringify(csvParsed.header) === JSON.stringify(SUMMARY_HEADER), '表头 22 列逐字一致且顺序固定', csvParsed.header);
    assert(csvParsed.rows.every((r) => r.length === 22), '每行 22 列（不错列）', csvParsed.rows.filter((r) => r.length !== 22).length);
    const boardRowCount = Math.min(500, (boardW.rows || []).length);
    assert(csvParsed.rows.length === boardRowCount, 'CSV 行数 = 看板行数（≤500 不截断）', { csv: csvParsed.rows.length, board: boardRowCount });

    // keyword 筛选：只剩临时班 1 行，序号 = 1
    const kwCsv = await call('admin', `/api/admin/class/status-export?attRange=week&today=${DAY}&format=csv&keyword=${encodeURIComponent(CLS)}`);
    const kwParsed = parseCsv(kwCsv.text);
    assert(kwCsv.status === 200 && kwParsed.rows.length === 1, 'keyword 筛选后只剩 1 行（临时班）', kwParsed.rows.length);
    const row = kwParsed.rows[0] || [];
    const col = (title) => row[SUMMARY_HEADER.indexOf(title)];
    assert(col('序号') === '1', '序号 = 筛选后行序 1', col('序号'));
    assert(col('院校') === '导出测试学院', '院校 = 导出测试学院', col('院校'));
    assert(col('系部') === '导出测试系', '系部 = 导出测试系', col('系部'));
    assert(col('专业') === '导出测试专业', '专业 = class_profiles.specialty', col('专业'));
    assert(col('年级') === '2026', '年级 = 2026', col('年级'));
    assert(col('学生数') === '3', '学生数 = 3（教师不计入）', col('学生数'));
    assert(col('住宿数') === '1', '住宿数 = 1（dorm_assignments 在住）', col('住宿数'));
    assert(col('班委数') === '1', '班委数 = 1（教师班委不计入）', col('班委数'));
    assert(col('学生会成员数') === '1', '学生会成员数 = 1（只有 active）', col('学生会成员数'));
    assert(Number(col('卫生累计扣分')) === 2, '卫生累计扣分 = 2', col('卫生累计扣分'));
    assert(Number(col('晚自习累计扣分')) === 0.3, '晚自习累计扣分 = 0.3', col('晚自习累计扣分'));
    assert(Number(col('查宿累计扣分')) === 0.2, '查宿累计扣分 = 0.2', col('查宿累计扣分'));
    assert(Number(col('早操累计扣分')) === 0.5, '早操累计扣分 = 0.5', col('早操累计扣分'));
    assert(Number(col('早八累计扣分')) === 0.1, '早八累计扣分 = 0.1（rejected 记录不计入）', col('早八累计扣分'));
    assert(col('校园跑班级日目标平均达标率') === pctCell(expW.dailyAvg), '校园跑日目标平均达标率 = 手算', {
      got: col('校园跑班级日目标平均达标率'),
      want: pctCell(expW.dailyAvg),
    });
    assert(col('校园跑班级周目标平均达标率') === pctCell(expW.weeklyAvg), '校园跑周目标平均达标率 = 手算', {
      got: col('校园跑班级周目标平均达标率'),
      want: pctCell(expW.weeklyAvg),
    });
    assert(Number(col('校园跑班级日目标达标次数')) === expW.dailyFullDays, '日目标达标次数 = 达标率 100% 的天数', {
      got: col('校园跑班级日目标达标次数'),
      want: expW.dailyFullDays,
    });
    assert(Number(col('校园跑班级周目标达标次数')) === expW.weeklyFullWeeks, '周目标达标次数 = 达标率 100% 的周数', {
      got: col('校园跑班级周目标达标次数'),
      want: expW.weeklyFullWeeks,
    });
    assert(col('校园跑班级日目标达标最低值') === pctCell(expW.dailyMin), '日目标达标最低值 = 各日最低百分比', {
      got: col('校园跑班级日目标达标最低值'),
      want: pctCell(expW.dailyMin),
    });
    assert(col('校园跑班级周目标达标最低值') === pctCell(expW.weeklyMin), '周目标达标最低值 = 各周最低百分比', {
      got: col('校园跑班级周目标达标最低值'),
      want: pctCell(expW.weeklyMin),
    });
    assert(Number(col('校园跑累计步数')) === expW.totalSteps, '校园跑累计步数 = 窗口内步数之和', {
      got: col('校园跑累计步数'),
      want: expW.totalSteps,
    });
    assert(Number(col('校园跑人均累计步数')) === expW.avgSteps, '校园跑人均累计步数 = round(累计/学生数)', {
      got: col('校园跑人均累计步数'),
      want: expW.avgSteps,
    });
    // 目标 ≤0 视为已达标：s3 的目标为 0，每个窗口日都应算达标（否则日达标率不会是手算值）
    assert(
      expW.dailyAvg !== null && Number(col('校园跑班级日目标达标次数')) >= 1,
      '目标 ≤0 的学生按「已达标」计入（s3 目标 0）',
      { dailyAvg: expW.dailyAvg }
    );

    // ---- 4) XLSX：总标 + 每班明细 + 字段说明 ----
    console.log('\n[2] XLSX 工作簿（总标 / 每班明细 / 字段说明）');
    const xw = await call('admin', `/api/admin/class/status-export?attRange=week&today=${DAY}&format=xlsx&keyword=${encodeURIComponent(CLS)}`);
    assert(xw.status === 200, 'xlsx 导出 → 200', xw.status);
    assert(/spreadsheetml/.test(xw.headers.get('content-type') || ''), 'xlsx Content-Type = spreadsheetml', xw.headers.get('content-type'));
    assert(xw.bytes[0] === 0x50 && xw.bytes[1] === 0x4b, 'xlsx 是合法 zip（PK 头）', [...xw.bytes.slice(0, 2)]);
    assert(/\.xlsx"/.test(xw.headers.get('content-disposition') || ''), 'xlsx 附件名 .xlsx', xw.headers.get('content-disposition'));
    const wb = XLSX.read(xw.bytes, { type: 'buffer' });
    const wantSheets = ['总标', `${CLS}详细数据`, '字段说明'];
    assert(JSON.stringify(wb.SheetNames) === JSON.stringify(wantSheets), 'sheet 顺序 = 总标 + 每班详细数据 + 字段说明', wb.SheetNames);

    const summary = sheetRows(wb, '总标');
    assert(String((summary[0] || [])[0]) === '班级状态总标', '总标第 1 行是标题', (summary[0] || [])[0]);
    const subtitle = String((summary[1] || [])[0] || '');
    assert(/统计区间：/.test(subtitle) && /筛选：/.test(subtitle) && /共 1 个班/.test(subtitle) && /导出时间/.test(subtitle), '第 2 行 = 区间/筛选/班数人数/导出时间', subtitle);
    assert(subtitle.includes(`${boardW.from} ~ ${boardW.to}`), '本周区间 = 周一 ~ 周日（完整周）', subtitle);
    const sumHeader = summary.find((r) => r[0] === '序号' && r.length === 22) || [];
    assert(JSON.stringify(sumHeader) === JSON.stringify(SUMMARY_HEADER), '总标表头 22 列逐字一致', sumHeader);
    // 总标没有「班级」列（22 列是需求定的），keyword 筛到 1 个班时数据行序号一定是 1
    const sumDataRow = summary.find((r) => Number(r[0]) === 1 && r.length === 22) || [];
    assert(sumDataRow.length === 22, '总标含临时班数据行（序号 1）', summary.length);
    assert(Number(sumDataRow[5]) === 3 && Number(sumDataRow[8]) === 1, '总标数据行学生数/学生会成员数 = 手算', [sumDataRow[5], sumDataRow[8]]);
    assert(Number(sumDataRow[20]) === expW.totalSteps, '总标累计步数与 CSV 一致', sumDataRow[20]);
    const tailText = summary.map((r) => String((r || [])[0] || '')).join('\n');
    assert(/口径说明/.test(tailText), '总标表尾带「口径说明」', tailText.slice(-80));
    assert(/累计扣分/.test(tailText) && /校园跑达标/.test(tailText) && /缺勤口径/.test(tailText) && /统计窗口/.test(tailText), '表尾覆盖累计扣分/达标/缺勤/统计窗口', tailText.slice(-200));
    const merged = (wb.Sheets['总标']['!merges'] || []).length;
    assert(merged >= 3, '总标标题/副标题/说明做了合并单元格', merged);
    // ⚠️ 社区版 SheetJS 回读工作簿时不会保留 !cols（列宽只在写入端有效），
    // 所以列宽断言改为「实现里有 !cols 且每列都给了 wch」（json 预览已逐列验过 wch）。
    const exportSvcSrc = require('fs').readFileSync(
      path.join(serverDir, 'src', 'services', 'class-status-export.js'),
      'utf8'
    );
    assert(/ws\['!cols'\] = payload\.columns\.map/.test(exportSvcSrc) && /ws\['!cols'\] = DETAIL_COL_WIDTHS\.map/.test(exportSvcSrc), 'xlsx 总标与明细 sheet 都写了 !cols 列宽', 'source');

    const dictRows = sheetRows(wb, '字段说明');
    const dictKeys = dictRows.map((r) => String((r || [])[0] || ''));
    assert(dictKeys.includes('校园跑班级日目标平均达标率') && dictKeys.includes('序号'), '字段说明覆盖总标列含义', dictKeys.slice(0, 5));
    const dictText = dictRows.map((r) => r.join(' ')).join('\n');
    assert(/班级明细上限/.test(dictText) && /500/.test(dictText), '字段说明注明班级明细 sheet 上限', dictText.slice(-200));
    assert(/考勤明细上限/.test(dictText) && /统计窗口/.test(dictText), '字段说明注明考勤明细上限与统计窗口', dictText.slice(-200));

    // ---- 4b) 每班明细 sheet：A. 区间考勤明细 ----
    console.log('\n[3] 每班明细 sheet：区间考勤明细');
    const detailRows = sheetRows(wb, `${CLS}详细数据`);
    const attTitleIdx = detailRows.findIndex((r) => String((r || [])[0] || '').startsWith('A. 区间考勤明细'));
    assert(attTitleIdx >= 0, '明细 sheet 有「A. 区间考勤明细」小标题', attTitleIdx);
    const attHeader = detailRows[attTitleIdx + 1] || [];
    const wantAttHeader = ['日期', '时段', '模块', '受检对象', '应到', '实到', '缺勤/未归/迟到名单', '得分', '扣分', '检查人', '复核人', '状态', '备注', '照片数'];
    assert(JSON.stringify(attHeader) === JSON.stringify(wantAttHeader), '考勤明细表头 14 列逐字一致', attHeader);
    const attRows = [];
    for (let i = attTitleIdx + 2; i < detailRows.length; i += 1) {
      const r = detailRows[i] || [];
      // 数据行首列一定是日期（YYYY-MM-DD）；小标题 / 空行 / 表尾说明一律不是
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r[0] || ''))) break;
      attRows.push(r);
    }
    const attOf = (moduleKey, targetName) =>
      attRows.find((r) => String(r[2]) === moduleNameOf(moduleKey) && String(r[3]) === targetName);
    const se = attOf('study_evening', '导出教室101');
    assert(!!se, '考勤明细含临时晚自习记录', attRows.slice(0, 3).map((r) => [r[0], r[2]]));
    if (se) {
      assert(String(se[0]) === DAY, '晚自习记录日期 = 今天', se[0]);
      assert(String(se[1]) === '晚自习', '时段中文 = 晚自习', se[1]);
      assert(Number(se[4]) === 30 && Number(se[5]) === 27, '应到 30 / 实到 27', [se[4], se[5]]);
      assert(String(se[6]) === '张三(病假) · 王五(事假)', '名单 = 姓名(假别) · 姓名', se[6]);
      assert(Number(se[8]) === 0.3, '扣分 = 0.3', se[8]);
      assert(String(se[9]) === '导出检查人', '检查人 = 导出检查人', se[9]);
      assert(String(se[10]) === '导出复核人', '复核人 = reviewedByName', se[10]);
      assert(String(se[11]) === '已复核', '状态 approved = 已复核', se[11]);
      assert(String(se[12]) === '晚自习备注' && Number(se[13]) === 2, '备注与照片数正确', [se[12], se[13]]);
    }
    const mc = attOf('morning_class', CLS);
    assert(!!mc, '考勤明细含临时早八记录', attRows.map((r) => r[2]));
    if (mc) {
      assert(String(mc[4]) === '' && String(mc[5]) === '', '早八应到/实到留空', [mc[4], mc[5]]);
      assert(String(mc[6]) === '王五', '早八名单只写姓名（无假别）', mc[6]);
      assert(String(mc[11]) === '已提交', '状态 submitted = 已提交', mc[11]);
      assert(String(mc[10]) === '—', '未复核时复核人写「—」', mc[10]);
    }
    const dorm = attOf('night_dorm', '导出测试楼 101');
    assert(!!dorm && String(dorm[6]) === '李四(事假)', '查宿名单取 absentList 并带假别（未归语义）', dorm && dorm[6]);
    assert(!attRows.some((r) => String(r[3]) === '不应出现的记录'), 'rejected 记录不进考勤明细', attRows.length);

    // ---- 4c) 每班明细 sheet：B. 校园跑每人数据 ----
    console.log('\n[4] 每班明细 sheet：校园跑每人数据');
    const runTitleIdx = detailRows.findIndex((r) => String((r || [])[0] || '').startsWith('B. 校园跑每人数据'));
    assert(runTitleIdx >= 0, '明细 sheet 有「B. 校园跑每人数据」小标题', runTitleIdx);
    const runHeader = detailRows[runTitleIdx + 1] || [];
    const wantRunHeader = ['姓名', '学号', '日目标', '周目标', '达标天数', '日达标率', '达标周数', '周达标率', '区间累计步数'];
    // sheet_to_json 会把行补齐到整张 sheet 的列宽（两大块共用 14 列），只比前 9 列
    assert(JSON.stringify(runHeader.slice(0, 9)) === JSON.stringify(wantRunHeader), '校园跑每人表头 9 列逐字一致', runHeader.slice(0, 9));
    const runRows = [];
    for (let i = runTitleIdx + 2; i < detailRows.length; i += 1) {
      const r = detailRows[i] || [];
      // 数据行第 2 列一定是本次造的学生学号；小标题 / 空行 / 表尾说明不是
      if (!studentIds.includes(String(r[1] || ''))) break;
      runRows.push(r);
    }
    assert(runRows.length === 3, '每人表恰好 3 个学生（教师不出现）', runRows.length);
    assert(JSON.stringify(runRows.map((r) => String(r[1]))) !== JSON.stringify([studentIds[2], studentIds[1], studentIds[0]]), '学生按学号稳定排序（不是数据库顺出）', runRows.map((r) => r[1]));
    const runOf = (studentId) => runRows.find((r) => String(r[1]) === studentId);
    for (let i = 0; i < goalStudents.length; i += 1) {
      const studentId = studentIds[i];
      const expect = expW.perStudent[goalStudents[i].openid];
      const got = runOf(studentId);
      assert(!!got, `学生 ${studentId} 出现在每人表里`, runRows.map((r) => r[1]));
      if (!got) continue;
      assert(Number(got[2]) === goalStudents[i].daily && Number(got[3]) === goalStudents[i].weekly, `学生 ${i + 1} 日/周目标正确`, [got[2], got[3]]);
      assert(Number(got[4]) === expect.achievedDays, `学生 ${i + 1} 达标天数 = 手算`, { got: got[4], want: expect.achievedDays });
      assert(String(got[5]) === pctCell(expect.dailyRate), `学生 ${i + 1} 日达标率 = 手算`, { got: got[5], want: pctCell(expect.dailyRate) });
      assert(Number(got[6]) === expect.achievedWeeks, `学生 ${i + 1} 达标周数 = 手算`, { got: got[6], want: expect.achievedWeeks });
      assert(String(got[7]) === pctCell(expect.weeklyRate), `学生 ${i + 1} 周达标率 = 手算`, { got: got[7], want: pctCell(expect.weeklyRate) });
      assert(Number(got[8]) === expect.total, `学生 ${i + 1} 区间累计步数 = 手算`, { got: got[8], want: expect.total });
    }
    const detailTail = detailRows.map((r) => String((r || [])[0] || '')).join('\n');
    assert(/考勤明细口径/.test(detailTail) && /名单格式/.test(detailTail) && /校园跑达标判定/.test(detailTail), '明细 sheet 表尾带口径说明', detailTail.slice(-160));

    // ---- 5) 窗口变化：本月 vs 本周（区间不同时数值必须跟着变） ----
    console.log('\n[5] 本月 / 本周区间变化');
    const boardM = await boardSvc.classStatusBoard({ today: DAY, attRange: 'month', force: true });
    const expM = expectedRunStats({ board: boardM, students: goalStudents, seeds: RUN_SEEDS, studentCount: 3 });
    const mCsv = await call('admin', `/api/admin/class/status-export?attRange=month&today=${DAY}&format=csv&keyword=${encodeURIComponent(CLS)}`);
    const mRow = (parseCsv(mCsv.text).rows || [])[0] || [];
    const mCol = (title) => mRow[SUMMARY_HEADER.indexOf(title)];
    assert(mCsv.status === 200 && mRow.length === 22 && Number(mRow[0]) === 1, '本月导出 200 且能定位临时班', mCsv.status);
    assert(Number(mCol('校园跑累计步数')) === expM.totalSteps, '本月累计步数 = 本月窗口手算', { got: mCol('校园跑累计步数'), want: expM.totalSteps });
    assert(String(mCol('校园跑班级日目标平均达标率')) === pctCell(expM.dailyAvg), '本月日平均达标率 = 本月窗口手算', {
      got: mCol('校园跑班级日目标平均达标率'),
      want: pctCell(expM.dailyAvg),
    });
    const sameWindow = boardM.from === boardW.from && expM.days.length === expW.days.length;
    if (!sameWindow) {
      assert(Number(mCol('校园跑累计步数')) !== Number(col('校园跑累计步数')), '本周/本月区间不同时累计步数随之变化', {
        week: col('校园跑累计步数'),
        month: mCol('校园跑累计步数'),
      });
    } else {
      assert(Number(mCol('校园跑累计步数')) === Number(col('校园跑累计步数')), '本周/本月窗口相同时累计步数一致', mCol('校园跑累计步数'));
    }

    // ---- 6) JSON 预览：列定义 22 + 截断行 + total + sheets，且不下发明细 ----
    console.log('\n[6] JSON 预览');
    const j = await call('admin', `/api/admin/class/status-export?attRange=week&today=${DAY}&format=json&preview=1&limit=1`);
    const jd = (j.json && j.json.data) || {};
    assert(j.status === 200 && jd.preview === true, 'json 预览 → 200 + preview=true', j.status);
    assert(Array.isArray(jd.columns) && jd.columns.length === 22 && jd.columns[0].title === '序号', '预览列定义 22 列且首列序号', jd.columns && jd.columns.length);
    assert(jd.columns.every((c) => typeof c.wch === 'number'), '每列带 Excel 字符宽（wch）', jd.columns.slice(0, 2));
    assert(Array.isArray(jd.rows) && jd.rows.length === Math.min(1, jd.total) && jd.rows.length <= 1, '预览 rows 截断到 limit=1', { rows: jd.rows && jd.rows.length, total: jd.total });
    assert(jd.total === boardRowCount, '预览 total = 总标行数', { total: jd.total, board: boardRowCount });
    assert(Array.isArray(jd.sheets) && jd.sheets.includes('总标') && jd.sheets.includes(`${CLS}详细数据`), 'sheets 名单含总标与班级明细名', jd.sheets);
    assert(jd.sheets[jd.sheets.length - 1] === '字段说明', 'sheets 名单最后是字段说明', jd.sheets && jd.sheets.slice(-2));
    assert(!jd.classSheets && !jd.detailSheets && Array.isArray(jd.rows[0]) && jd.rows[0].length === 22, '预览不下发明细行（只有总标行）', Object.keys(jd));
    assert(/统计区间：/.test(jd.subtitle || '') && /导出时间/.test(jd.subtitle || ''), '预览副标题含区间/导出时间', jd.subtitle);
    // 预览里不传 keyword 时，首个数据行的序号仍是全局行序（不是 1..N 重排）
    assert(Number(jd.rows[0] && jd.rows[0][0]) === 1, '预览首行序号 = 1', jd.rows[0] && jd.rows[0][0]);

    // ---- 7) 缺省格式（旧客户端）仍是 CSV ----
    const def = await call('admin', `/api/admin/class/status-export?attRange=week&today=${DAY}`);
    assert(/text\/csv/.test(def.headers.get('content-type') || ''), '不传 format 默认仍是 CSV（向后兼容）', def.headers.get('content-type'));

    // ---- 8) 权限与只读 ----
    console.log('\n[7] 权限与只读');
    const noperm = await call('noperm', `/api/admin/class/status-export?attRange=week&today=${DAY}&format=csv`);
    assert(noperm.status === 403, '无 class.view → 403', noperm.status);
    const anon = await call('anon', `/api/admin/class/status-export?attRange=week&today=${DAY}&format=csv`);
    assert(anon.status === 401, '未登录 → 401', anon.status);
    const cnt = await CheckRecord.countDocuments({ className: CLS });
    assert(cnt === 6, '导出是只读的（临时检查记录数仍为 6）', cnt);
  } finally {
    // ---- 清理：临时数据一条不留 + 清看板缓存（不留 60 秒脏行）----
    await CheckRecord.deleteMany({ className: CLS });
    await RunRecord.deleteMany({ openid: { $in: openids } });
    await UserGoal.deleteMany({ openid: { $in: openids } });
    await DormAssignment.deleteMany({ openid: { $in: openids } });
    await UnionMember.deleteMany({ className: CLS });
    await ClassProfile.deleteMany({ className: CLS });
    await User.deleteMany({ openid: new RegExp(`^${TAG}`) });
    if (createdUserIds.length) await User.deleteMany({ _id: { $in: createdUserIds } });
    if (typeof boardSvc.clearCache === 'function') boardSvc.clearCache();

    const left = {
      users: await User.countDocuments({ openid: new RegExp(`^${TAG}`) }),
      profiles: await ClassProfile.countDocuments({ className: CLS }),
      records: await CheckRecord.countDocuments({ className: CLS }),
      runs: await RunRecord.countDocuments({ openid: { $in: openids } }),
      goals: await UserGoal.countDocuments({ openid: { $in: openids } }),
      dorms: await DormAssignment.countDocuments({ openid: { $in: openids } }),
      union: await UnionMember.countDocuments({ className: CLS }),
    };
    console.log(`\n[8] 清理：残留 ${JSON.stringify(left)}`);
    assert(Object.values(left).every((n) => n === 0), '临时数据清理干净', left);
    await mongoose.disconnect();
    console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
    process.exit(failed ? 1 : 0);
  }
})().catch((e) => {
  console.error('ERR', e.stack);
  process.exit(1);
});
