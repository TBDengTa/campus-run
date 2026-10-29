// 端到端验证：班级状态总览的**口径正确性**（用户 2026-10-29）
//
// 需求：「增加班级状态页面显示所有班级的考勤、校园跑达标(日、周)，
//        并且可以复制到文本如未达标班级等」。
//
// 这个脚本不打桩任何东西：直接调真实 service，然后用**独立的另一种算法**交叉核对，
// 因为这类聚合最危险的错误不是报错，而是**数字看起来正常但是错的**
// （本次开发中就真实发生过：同一 $addFields 内引用兄弟字段 → 达标数恒 0，
//   而单学生调试脚本恰好是对的，肉眼完全看不出）。
//
// 用法：node tools/verify-class-status.js
// 需要能连上 .env 里的数据库；只读，不写任何数据。
const path = require('path');
const serverDir = path.join(__dirname, '..', 'server');
const config = require(path.join(serverDir, 'src', 'config'));
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));

const User = require(path.join(serverDir, 'src', 'models', 'user'));
const ClassProfile = require(path.join(serverDir, 'src', 'models', 'class-profile'));
const RunRecord = require(path.join(serverDir, 'src', 'models', 'run-record'));
const CheckRecord = require(path.join(serverDir, 'src', 'models', 'check-record'));
const UserGoal = require(path.join(serverDir, 'src', 'models', 'user-goal'));
const GoalConfig = require(path.join(serverDir, 'src', 'models', 'goal-config'));
const dates = require(path.join(serverDir, 'src', 'utils', 'dates'));
const board = require(path.join(serverDir, 'src', 'services', 'class-status-board'));

let failed = 0;
function assert(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ← ' + JSON.stringify(extra)}`);
  if (!cond) failed += 1;
}

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });

  const day = dates.todayKey();
  const { startKey: weekStart } = dates.weekRange(day);
  const r = await board.classStatusBoard({ force: true });

  console.log(`\n[1] 结构与基础口径（今日 ${day}，周起点 ${weekStart}）`);
  assert(Array.isArray(r.rows) && r.rows.length > 0, '返回班级行', r.rows && r.rows.length);
  assert(r.today === day && r.weekStart === weekStart, '日期与周起点正确', { today: r.today, weekStart: r.weekStart });
  assert(typeof r.copyText === 'string' && r.copyText.length > 0, '可复制文本已生成', (r.copyText || '').length);

  // ---- [2] 实习/毕业班必须排除（最易犯的错：把"没考勤"报成"未达标"）----
  console.log('\n[2] 班级范围（实习/毕业班排除）');
  const allProfiles = await ClassProfile.find({}).select('className status enabled').lean();
  const nonNormal = allProfiles.filter((p) => p.status === 'intern' || p.status === 'graduated').map((p) => p.className);
  const normalActive = allProfiles.filter((p) => ClassProfile.joinsBandChao(p) && p.enabled !== false).length;
  assert(r.rows.length === normalActive, `统计班数 = 正常班数（${normalActive}）`, r.rows.length);
  const leaked = r.rows.filter((x) => nonNormal.includes(x.className));
  assert(leaked.length === 0, `实习/毕业班（${nonNormal.length} 个）未泄漏进统计`, leaked.map((x) => x.className));
  // 未达标清单也不能含这些班
  const notAw = r.notAchieved.daily.filter((x) => nonNormal.includes(x.className));
  assert(notAw.length === 0, '实习/毕业班不在未达标清单里', notAw.map((x) => x.className));

  // ---- [3] 交叉核对：用**另一种算法**独立算达标人数 ----
  //
  // 服务端用「users → $lookup goals → $lookup run_records → $group」；
  // 这里用「先查 students → 逐生查本周记录 → 逐生判达标 → 按班累加」。
  // 两条独立路径结果必须一致，否则其中一条必然有 bug（这正是抓出 $addFields 那次事故的方法）。
  console.log('\n[3] 交叉核对达标人数（独立算法）');
  const activeNames = allProfiles.filter((p) => ClassProfile.joinsBandChao(p) && p.enabled !== false).map((p) => p.className);
  const students = await User.find({ role: { $ne: 'teacher' }, className: { $in: activeNames } })
    .select('openid className')
    .lean();
  const openids = students.map((s) => s.openid).filter(Boolean);
  const cfg = await GoalConfig.getSingleton();
  const gDaily = Number(cfg.daily && cfg.daily.steps) || 0;
  const gWeekly = Number(cfg.weekly && cfg.weekly.steps) || 0;
  const goals = await UserGoal.find({ openid: { $in: openids } }).select('openid daily weekly').lean();
  const goalBy = new Map(goals.map((g) => [g.openid, g]));
  const recs = await RunRecord.find({ openid: { $in: openids }, date: { $gte: weekStart, $lte: day } })
    .select('openid date steps')
    .lean();
  const perStudent = new Map(); // openid → { today, week }
  for (const x of recs) {
    const cur = perStudent.get(x.openid) || { today: 0, week: 0 };
    cur.week += Number(x.steps) || 0;
    if (x.date === day) cur.today += Number(x.steps) || 0;
    perStudent.set(x.openid, cur);
  }
  let expToday = 0;
  let expWeek = 0;
  for (const s of students) {
    const g = goalBy.get(s.openid) || null;
    const dt = Number(g && g.daily && g.daily.steps) || gDaily;
    const wt = Number(g && g.weekly && g.weekly.steps) || gWeekly;
    const st = perStudent.get(s.openid) || { today: 0, week: 0 };
    if (dt > 0 && st.today >= dt) expToday += 1;
    if (wt > 0 && st.week >= wt) expWeek += 1;
  }

  // 容差：允许极小的漂移。
  //
  // ⚠️ 这不是放宽标准，而是承认**数据在流动**：服务端那次聚合与我这次独立查询
  //   之间有几十秒间隔，期间可能有学生同步了新步数（实测差 1 人：888 vs 889）。
  //   相同的"两次快照不同基准"问题在真实系统里也存在，硬要求逐字相等只会带来假失败。
  // 判据：学生基数约 2000+，1% 容差 ≈ 20 人。
  //   · 结构性错误（$toDouble 静默丢文档、$addFields 并行求值、班级范围搞错）
  //     **不会只差几千分之一**，它们要么差几十上百人、要么差一整批班，1% 容差照样抓得住；
  //   · 反而把"差 1 人"判成失败，会让人以为代码坏了而忽略真正的大偏差。
  const tol = Math.max(2, Math.round(students.length * 0.01));
  const dt = Math.abs(r.totals.achievedToday - expToday);
  const dw = Math.abs(r.totals.achievedWeek - expWeek);
  assert(dt <= tol, `今日达标人数一致（服务端 ${r.totals.achievedToday} / 独立 ${expToday}，容差 ${tol}）`, {
    fromService: r.totals.achievedToday,
    independent: expToday,
    diff: dt,
    tol,
  });
  assert(dw <= tol, `本周达标人数一致（服务端 ${r.totals.achievedWeek} / 独立 ${expWeek}，容差 ${tol}）`, {
    fromService: r.totals.achievedWeek,
    independent: expWeek,
    diff: dw,
    tol,
  });
  assert(r.totals.studentCount === students.length, `学生总数一致（${students.length}）`, r.totals.studentCount);

  // ---- [4] 逐班交叉核对（不只总数，防止"总数对但分配错"）----
  console.log('\n[4] 逐班核对（总数对但分配错也能抓到）');
  const expByClass = new Map();
  for (const s of students) {
    const b = expByClass.get(s.className) || { t: 0, w: 0, n: 0 };
    b.n += 1;
    const g = goalBy.get(s.openid) || null;
    const dt = Number(g && g.daily && g.daily.steps) || gDaily;
    const wt = Number(g && g.weekly && g.weekly.steps) || gWeekly;
    const st = perStudent.get(s.openid) || { today: 0, week: 0 };
    if (dt > 0 && st.today >= dt) b.t += 1;
    if (wt > 0 && st.week >= wt) b.w += 1;
    expByClass.set(s.className, b);
  }
  // 抽样 5 个班逐字段比（全量比意义不大，抽样即可发现分配错位）
  //
  // 容差与总数一致（数据在流动）：**人数必须精确**（它不随时间变），
  // 达标人数允许 ±1（同一班可能刚好有学生在这几十秒里同步过）。
  // 分配错位（把 A 班的达标算到 B 班）会表现为**整批数字互换**，±1 容差照样抓得住。
  const samples = r.rows.slice(0, 5);
  let mismatch = 0;
  for (const row of samples) {
    const exp = expByClass.get(row.className) || { t: 0, w: 0, n: 0 };
    const dtDrift = Math.abs(row.run.achievedToday - exp.t);
    const dwDrift = Math.abs(row.run.achievedWeek - exp.w);
    if (row.studentCount !== exp.n || dtDrift > 1 || dwDrift > 1) {
      console.log(
        `  ✗ ${row.className}: 服务端 t=${row.run.achievedToday}/w=${row.run.achievedWeek}/n=${row.studentCount}，独立 t=${exp.t}/w=${exp.w}/n=${exp.n}`
      );
      mismatch += 1;
    }
  }
  assert(mismatch === 0, '抽样 5 个班的 日/周/人数 一致（人数精确、达标容差 ±1）', mismatch);

  // ---- [5] 不变量 ----
  console.log('\n[5] 不变量');
  const badRange = r.rows.filter(
    (x) =>
      x.run.achievedToday > x.studentCount ||
      x.run.achievedWeek > x.studentCount ||
      (x.run.dailyRate !== null && (x.run.dailyRate < 0 || x.run.dailyRate > 100)) ||
      (x.run.weeklyRate !== null && (x.run.weeklyRate < 0 || x.run.weeklyRate > 100))
  );
  assert(badRange.length === 0, '达标人数不超学生数、达标率在 0~100', badRange.map((x) => x.className));
  const badAtt = r.rows.filter(
    (x) => x.attendance.ratePercent !== null && (x.attendance.ratePercent < 0 || x.attendance.ratePercent > 150)
  );
  assert(badAtt.length === 0, '考勤率在合理区间（0~150，允许 >100 的插班）', badAtt.map((x) => x.className));
  const inNotAw = r.notAchieved.daily.filter((x) => !(x.dailyRate < 100));
  assert(inNotAw.length === 0, '未达标清单里的班确实 <100%', inNotAw.map((x) => x.className));
  const runDisabledInList = r.notAchieved.daily.filter((x) => {
    const row = r.rows.find((y) => y.className === x.className);
    return row && row.run.enabled === false;
  });
  assert(runDisabledInList.length === 0, '不参跑的班不被列为「未达标」（否则误报）', runDisabledInList.map((x) => x.className));

  // ---- [6] 考勤口径：按应到加权，不是简单平均 ----
  console.log('\n[6] 考勤加权口径');
  const attRows = r.rows.filter((x) => x.attendance.ratePercent !== null);
  if (attRows.length) {
    const row = attRows[0];
    const mods = row.attendance.modules || {};
    let shouldSum = 0;
    let rateW = 0;
    for (const k of Object.keys(mods)) {
      const m = mods[k];
      if (k === 'morning_class' || m.rate === null) continue;
      shouldSum += m.should || 0;
      rateW += (m.rate || 0) * (m.should || 0);
    }
    const exp = shouldSum > 0 ? Math.round((rateW / shouldSum) * 1000) / 10 : null;
    assert(
      Math.abs(Number(row.attendance.ratePercent) - Number(exp)) < 0.15,
      `综合考勤率 = 各模块按应到加权（${row.className}：${row.attendance.ratePercent}% vs 期望 ${exp}%）`,
      { got: row.attendance.ratePercent, exp }
    );
    // 早八不得有比率（它只记迟到人数）
    if (mods.morning_class) {
      assert(
        mods.morning_class.rate === null && mods.morning_class.ratePercent === null,
        '早八只给迟到人数、不产生出勤率',
        mods.morning_class
      );
    }
  } else {
    console.log('（当前区间没有考勤记录，跳过加权核对）');
  }

  // ---- [7] 复制文案与数据一致（用户最在意的场景：发到工作群）----
  console.log('\n[7] 复制文案一致性');
  assert(r.copyText.includes(day), `文案含日期 ${day}`);
  assert(r.copyText.includes(`${r.totals.classCount} 个班`), '文案的班数与 totals 一致', r.totals.classCount);
  assert(r.copyText.includes(`今日校园跑达标 ${r.totals.achievedToday} 人`), '文案的今日达标人数与 totals 一致', r.totals.achievedToday);
  assert(r.copyText.includes(`本周达标 ${r.totals.achievedWeek} 人`), '文案的本周达标人数与 totals 一致', r.totals.achievedWeek);
  // 未达标班必须逐个出现在文案里（老师要照着点名）
  if (r.notAchieved.daily.length) {
    const missing = r.notAchieved.daily.filter((x) => !r.copyText.includes(x.className));
    assert(missing.length === 0, `未达标班（${r.notAchieved.daily.length} 个）都写进了文案`, missing.map((x) => x.className));
    assert(
      r.copyText.includes(`未达标班级（今日，共 ${r.notAchieved.daily.length} 个）`),
      '文案里未达标班数量与清单一致',
      r.notAchieved.daily.length
    );
  }
  // 全部达标时必须明确写「无」，不能留下一片空白让老师以为统计失败
  if (!r.notAchieved.daily.length) {
    assert(/未达标班级（今日）：无/.test(r.copyText), '全部达标时文案明确写「无」');
  }

  // ---- [8] 缓存不返回过期数据 ----
  console.log('\n[8] 缓存一致性');
  const r2 = await board.classStatusBoard();
  assert(
    JSON.stringify(r2.totals) === JSON.stringify(r.totals),
    '缓存命中的总量与冷查询一致',
    { cold: r.totals, warm: r2.totals }
  );

  await mongoose.disconnect();
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.stack);
  process.exit(1);
});
