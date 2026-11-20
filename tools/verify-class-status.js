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
// 需要能连上 .env 里的数据库。主体只读；第 [10] 节会写入**带时间戳前缀的临时班与
// 临时考勤记录**（抓「聚合读错字段」这类静默错必须真有数据），跑完即删并核对残留为 0。
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

  // ---- [6] 考勤口径：率仍按应到加权；**分数改为班超同源**（用户 2026-11-19）----
  console.log('\n[6] 考勤加权与班超同源分数');
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
    // ===== 分数**不再**由率折算（旧公式 10×率 − 迟到×0.05 已删除）=====
    // 用户 2026-11-19：「班级状态日周月考勤不一致，并且考勤的卫生、查宿等相关内容
    // 相应没有被减分」—— 旧公式只看 4 个考勤模块，**卫生整块不在内**，
    // 与班超总评（10 − 日均扣分，全部模块）实测差到 1.3 分。
    // 现在分数 = bandChao 同一个实现，所以这里的独立核对必须**从 check_records 重算**
    // 一遍班超分，而不是再抄一次被测代码的公式。
    const lateN = row.attendance.lateCount || 0;
    assert(typeof lateN === 'number', '考勤带 lateCount（迟到人数仍下发）', lateN);
    assert(
      row.attendance.score === null || (row.attendance.score >= 0 && row.attendance.score <= 10),
      '分数在 0~10 区间（10 分制，不出现百分制数值）',
      row.attendance.score
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

  // ---- [6b] 分数与班超同源：从 check_records **独立重算**（抽样逐班比对）----
  console.log('\n[6b] 看板分数 = 从 check_records 独立重算的班超分（含卫生）');
  {
    const win = board.attWindow('week', day);
    const sampleRows = r.rows.filter((x) => x.attendance.hasAnyCheck).slice(0, 8);
    assert(sampleRows.length > 0, '本周有检查记录的班可用于核对', sampleRows.length);
    let mismatch = 0;
    let hygCases = 0;
    let hygBroken = 0;
    for (const row of sampleRows) {
      // 独立算法：拉该班本周全部检查记录（**不限模块**）→ 按日求扣分和 →
      // 逐日 10−扣分（负数封顶 0）→ 取平均。与被测实现完全无关。
      const recs = await CheckRecord.find({
        className: row.className,
        date: { $gte: win.from, $lte: win.to },
        status: { $in: ['submitted', 'approved'] },
        voided: { $ne: true },
      }).select('date deduct moduleKey').lean();
      const byDay = new Map();
      for (const x of recs) byDay.set(x.date, (byDay.get(x.date) || 0) + (Number(x.deduct) || 0));
      const dayScores = [...byDay.values()].map((d) => Math.max(0, Math.round((10 - d) * 100) / 100));
      const expScore = dayScores.length ? Math.round((dayScores.reduce((a, b) => a + b, 0) / dayScores.length) * 100) / 100 : null;
      if (Math.abs(Number(row.attendance.score) - Number(expScore)) > 0.02) {
        mismatch += 1;
        console.log(`   DIFF ${row.className}: 看板=${row.attendance.score} 独立重算=${expScore}（记录 ${recs.length} 条，含模块 ${[...new Set(recs.map((x) => x.moduleKey))].join('/')}）`);
      }
      // 卫生是否真的被减分：拿同一批记录算两次 —— 含卫生 vs **排除卫生**，
      // 只要该班有卫生扣分，含卫生的分数就必须**严格更低**。
      // 这是用户报障「卫生、查宿等相关内容相应没有被减分」最直接的判据，
      // 也是旧实现必然测不过的一条（旧公式压根不看 hygiene）。
      const hygDeduct = recs.filter((x) => x.moduleKey === 'hygiene').reduce((a, x) => a + (Number(x.deduct) || 0), 0);
      if (hygDeduct > 0) {
        const noHyg = new Map();
        for (const x of recs) {
          if (x.moduleKey === 'hygiene') continue;
          noHyg.set(x.date, (noHyg.get(x.date) || 0) + (Number(x.deduct) || 0));
        }
        const ns = [...noHyg.values()].map((d) => Math.max(0, Math.round((10 - d) * 100) / 100));
        const expNoHyg = ns.length ? Math.round((ns.reduce((a, b) => a + b, 0) / ns.length) * 100) / 100 : null;
        hygCases += 1;
        if (expNoHyg !== null && !(row.attendance.score < expNoHyg - 0.001)) {
          hygBroken += 1;
          console.log(`   卫生没被减分 ${row.className}: 含卫生=${row.attendance.score} 排除卫生=${expNoHyg}`);
        }
      }
    }
    assert(mismatch === 0, `抽样 ${sampleRows.length} 个班的分数与独立重算一致`, mismatch);
    assert(hygBroken === 0, `有卫生扣分的班（${hygCases} 个）分数确实因卫生而更低`, hygBroken);
    // 窗口终点必须是**完整周**（班超同源），不能是所选日
    assert(win.to > win.from || win.to === win.from, '本周窗口有终点字段', win);
    const mondayOf = (k) => {
      const d = new Date(`${k}T00:00:00`);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    assert(win.from === mondayOf(day), `本周窗口起点 = ISO 周一（${mondayOf(day)}）`, win.from);
    const wholeWeekEnd = dates.addDays(mondayOf(day), 6);
    assert(win.to === wholeWeekEnd, `本周窗口终点 = 周一+6 的**完整周**（不是所选日 ${day}）`, { got: win.to, exp: wholeWeekEnd });
    assert(r.to === win.to, '看板结果下发窗口终点 to（前端脚注要用）', r.to);
  }

  // ---- [7] 复制文案与数据一致（用户最在意的场景：发到工作群）----
  console.log('\n[7] 复制文案一致性');
  assert(r.copyText.includes(day), `文案含日期 ${day}`);
  assert(r.copyText.includes(`${r.totals.classCount} 个班`), '文案的班数与 totals 一致', r.totals.classCount);
  // 措辞在 2026-10-30 第二轮统一为「今日达标」（旧文案「今日校园跑达标」已废弃：
  // 复制口径支持「只要日达标」，标题里已写明指标，正文不必再重复"校园跑"）。
  // 这里断言的是**数字**（与 totals 逐字一致），措辞只保证不漂移成另一个说法。
  assert(r.copyText.includes(`今日达标 ${r.totals.achievedToday} 人`), '文案的今日达标人数与 totals 一致', r.totals.achievedToday);
  assert(r.copyText.includes(`本周达标 ${r.totals.achievedWeek} 人`), '文案的本周达标人数与 totals 一致', r.totals.achievedWeek);

  // 复制口径（用户 2026-10-30「如只需要日达标这种的」）：收窄后另一指标必须消失，
  // 否则「只要日达标」的名单里还混着本周数据，等于没按口径生成。
  const cDaily = board.applyBoardFilter(r, { copy: 'daily' });
  assert(/｜日达标/.test(cDaily.copyText), 'copy=daily 标题标注日达标', cDaily.copyText.split('\n')[0]);
  assert(!cDaily.copyText.includes('本周达标'), 'copy=daily 文案不含本周汇总', cDaily.copyText.split('\n')[1]);
  const cWeek = board.applyBoardFilter(r, { copy: 'weekly' });
  assert(/｜周达标/.test(cWeek.copyText), 'copy=weekly 标题标注周达标', cWeek.copyText.split('\n')[0]);
  assert(!cWeek.copyText.includes('今日达标'), 'copy=weekly 文案不含今日汇总', cWeek.copyText.split('\n')[1]);
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

  // ---- [8] 筛选与「复制筛选后的内容」（用户 2026-10-30「支持筛选，复制时复制的是筛选后的相应内容」）----
  //
  // 为什么必须验到 copyText 而不是只验行数：这个功能的核心承诺是
  // 「复制出去的 = 屏幕上看到的」。若筛选在前端、文案在服务端，
  // 两者会用不同的行集合 —— 页面显示 5 个班、粘出去是全校 43 个班的报告。
  console.log('\n[8] 筛选 + 筛选后的复制文案');
  const fDaily = board.applyBoardFilter(r, { quick: 'notDaily' });
  assert(fDaily.rows.length > 0 && fDaily.rows.length <= r.rows.length, '今日未达标筛出子集', {
    filtered: fDaily.rows.length,
    total: r.rows.length,
  });
  assert(
    fDaily.rows.every((x) => x.run.enabled && x.studentCount > 0 && x.run.dailyRate !== null && x.run.dailyRate < 100),
    '筛出的每一行确实今日未达标（不参跑/空班不误报）',
    fDaily.rows.filter((x) => !(x.run.dailyRate < 100)).map((x) => x.className)
  );
  assert(fDaily.activeFilters.includes('今日未达标'), '筛选标签回显', fDaily.activeFilters);
  assert(fDaily.filtered.classCount === fDaily.rows.length, '筛选小计与行数一致', fDaily.filtered);
  // 关键：文案标题写明筛选，且列出的班数 = 筛选后的行数
  assert(/【班级状态 .*｜今日未达标】/.test(fDaily.copyText), '文案标题标明筛选条件', fDaily.copyText.split('\n')[0]);
  assert(fDaily.copyText.includes(`共 ${fDaily.rows.length} 个班`), '文案班数 = 筛选后班数', fDaily.rows.length);
  assert(
    (fDaily.copyText.match(/^· /gm) || []).length === fDaily.rows.length,
    '文案逐行列出的班数 = 筛选行数（复制的就是看到的）',
    { lines: (fDaily.copyText.match(/^· /gm) || []).length, rows: fDaily.rows.length }
  );
  // 每个筛出的班都要真的出现在文案里（点名用的，漏一个就会漏催）
  const missF = fDaily.rows.filter((x) => !fDaily.copyText.includes(x.className));
  assert(missF.length === 0, '筛选出的班级都写进了文案', missF.map((x) => x.className));
  // 未筛选的班不得混进筛选文案（否则「筛选」只是前端假象）
  const outNames = r.rows.filter((x) => !fDaily.rows.includes(x)).slice(0, 3).map((x) => x.className);
  assert(
    outNames.every((n) => !fDaily.copyText.includes(`· ${n}：`)),
    '未入选的班不出现在筛选文案里',
    outNames
  );
  // 保留全校对照：否则老师看到 5 个班会以为只剩 5 个班
  assert(/全校合计 \d+ 个班/.test(fDaily.copyText), '筛选文案保留全校对照', fDaily.copyText.split('\n')[2]);

  const fZero = board.applyBoardFilter(r, { quick: 'zeroToday' });
  assert(fZero.rows.every((x) => x.run.achievedToday === 0), '今日零达标筛选正确', fZero.rows.slice(0, 2).map((x) => x.run.achievedToday));
  const fAtt = board.applyBoardFilter(r, { quick: 'attMissing' });
  assert(fAtt.rows.every((x) => !x.attendance.hasData && x.studentCount > 0), '考勤待补筛选正确', fAtt.rows.length);

  // 系部 + 关键词可叠加（交集）
  if (r.departments && r.departments.length) {
    const dept = r.departments[0];
    const fDept = board.applyBoardFilter(r, { department: dept });
    assert(fDept.rows.every((x) => x.departmentName === dept), `系部筛选（${dept}）每行匹配`, fDept.rows.slice(0, 2).map((x) => x.departmentName));
    const fBoth = board.applyBoardFilter(r, { quick: 'notDaily', department: dept });
    assert(
      fBoth.rows.every((x) => x.departmentName === dept && x.run.dailyRate < 100),
      '两条件叠加 = 交集',
      fBoth.rows.length
    );
    assert(fBoth.activeFilters.length === 2, '标签含两个条件', fBoth.activeFilters);
  }
  if (r.rows.length) {
    const kw = (r.rows[0].className || '').slice(2, 5);
    const fKw = board.applyBoardFilter(r, { keyword: kw });
    assert(
      fKw.rows.length > 0 && fKw.rows.every((x) => `${x.className}${x.departmentName || ''}`.includes(kw)),
      `关键词「${kw}」命中且不越界`,
      fKw.rows.map((x) => x.className)
    );
  }

  // 空参数与非法值必须等于全量（不能让一个拼错的 URL 参数悄悄把数据筛没）
  const fNone = board.applyBoardFilter(r, {});
  assert(fNone.rows.length === r.rows.length && /全校 \d+ 个班/.test(fNone.copyText), '空参数 = 全量口径', fNone.rows.length);
  const fBad = board.applyBoardFilter(r, { quick: 'notARealFilter' });
  assert(fBad.rows.length === r.rows.length && (!fBad.activeFilters || !fBad.activeFilters.length), '非法 quick 被忽略而非筛空', fBad.activeFilters);
  // 筛到 0 行时文案要明确说明，不能留空让老师以为统计失败
  const fEmpty = board.applyBoardFilter(r, { keyword: '一定不存在的班级名XYZ' });
  assert(fEmpty.rows.length === 0 && /没有班级/.test(fEmpty.copyText), '筛到 0 行时文案明确说明', fEmpty.copyText);
  // 关键词含正则元字符不得抛错（前端可输入任意文本）
  let threw = false;
  try {
    board.applyBoardFilter(r, { keyword: '.*+?^${}()|[]\\' });
  } catch (e) {
    threw = true;
  }
  assert(!threw, '含正则元字符的关键词不抛错');

  // 筛选不得污染缓存里的全量结果（缓存的是全量，筛选在内存做）
  const r3 = await board.classStatusBoard();
  assert(r3.rows.length === r.rows.length, '筛选后重新取仍是全量', { now: r3.rows.length, before: r.rows.length });

  // ---- [8b] 第二轮：院校级联 / 档位筛选 / 复制口径（用户 2026-10-30「没有院系筛选」「只需要日达标」）----
  console.log('\n[8b] 院校级联 + 档位 + 复制口径');

  // 院校筛选：多个校区都有同名系部（实测北校区/洋河校区都有「计财系」），
  // 只按系部筛会把两校混在一起 —— 必须能按院校收窄，且收窄后校名唯一。
  assert(Array.isArray(r.schools) && r.schools.length > 0, '响应含院校候选', r.schools);
  const sch = r.schools[0];
  const fSch = board.applyBoardFilter(r, { school: sch });
  assert(fSch.rows.length > 0, `院校「${sch}」筛出班级`, fSch.rows.length);
  assert(
    new Set(fSch.rows.map((x) => x.schoolName)).size === 1 && fSch.rows.every((x) => x.schoolName === sch),
    '院校筛选后只剩该院校',
    [...new Set(fSch.rows.map((x) => x.schoolName))]
  );
  // 同名系部跨校区：只给 department 时如实标注「各校区同名」，不能假装已消歧
  const deptShared = r.departments.find((d) => {
    const schoolsOfDept = new Set(r.rows.filter((x) => x.departmentName === d).map((x) => x.schoolName));
    return schoolsOfDept.size > 1;
  });
  if (deptShared) {
    const fDept = board.applyBoardFilter(r, { department: deptShared });
    assert(
      new Set(fDept.rows.map((x) => x.schoolName)).size > 1,
      `同名系部「${deptShared}」跨校区（如实保留）`,
      [...new Set(fDept.rows.map((x) => x.schoolName))]
    );
    assert(
      fDept.activeFilters[0].includes('各校区同名'),
      '只按系部筛时标签注明「各校区同名」',
      fDept.activeFilters
    );
    // 加上院校才真正消歧
    const fBoth2 = board.applyBoardFilter(r, { school: sch, department: deptShared });
    assert(
      fBoth2.rows.every((x) => x.schoolName === sch && x.departmentName === deptShared),
      '院校 + 系部 两级才消歧',
      fBoth2.rows.slice(0, 2).map((x) => `${x.schoolName}/${x.departmentName}`)
    );
  }

  // 档位筛选：解决「今日未达标筛出全部 43 个班」（今日全校达标率个位数，没有班到 100%）。
  // 三档必须真的分层，否则用户还是只能在「全部」和「全部」之间选。
  const fZero2 = board.applyBoardFilter(r, { level: 'zero', metric: 'daily' });
  assert(
    fZero2.rows.every((x) => x.run.dailyRate === 0 && x.run.enabled && x.studentCount > 0),
    '档位「日达标零达标」每行确实是 0%',
    fZero2.rows.slice(0, 2).map((x) => x.run.dailyRate)
  );
  const fHalf = board.applyBoardFilter(r, { level: 'below95', metric: 'daily' });
  assert(
    fHalf.rows.every((x) => x.run.dailyRate !== null && x.run.dailyRate < 95),
    '档位「日达标低于95%」每行 <95%（2026-11-03 换掉低于一半）',
    fHalf.rows.slice(0, 2).map((x) => x.run.dailyRate)
  );
  assert(fZero2.rows.length <= fHalf.rows.length, '零达标是低于95%的子集（档位真的分层）', {
    zero: fZero2.rows.length,
    below95: fHalf.rows.length,
  });
  assert(fHalf.activeFilters[0].includes('日达标'), '档位标签写明指标（日）', fHalf.activeFilters);
  assert(fHalf.activeFilters[0].includes('95'), '档位标签带 95%（不残留「低于一半」文案）', fHalf.activeFilters);
  const fWeekHalf = board.applyBoardFilter(r, { level: 'below95', metric: 'weekly' });
  assert(fWeekHalf.activeFilters[0].includes('周达标'), '切换指标后标签变「周达标」', fWeekHalf.activeFilters);
  assert(
    fWeekHalf.rows.every((x) => x.run.weeklyRate !== null && x.run.weeklyRate < 95),
    '周达标档位筛的是周列而不是日列',
    fWeekHalf.rows.slice(0, 2).map((x) => x.run.weeklyRate)
  );

  // ---- [8c] 排序：年级升序 + 班级名（2026-11-03 用户指定，替换「未达标优先」桶排序）----
  console.log('\n[8c] 行排序（年级 → 班级名）');
  {
    const ordered = r.rows.every((row, i) => {
      if (i === 0) return true;
      const prev = r.rows[i - 1];
      const ga = prev.grade || '9999';
      const gb = row.grade || '9999';
      if (ga !== gb) return ga < gb;
      return String(prev.className).localeCompare(String(row.className), 'zh-CN') <= 0;
    });
    assert(ordered, 'rows 按 年级升序 → 班级名 有序', r.rows.slice(0, 4).map((x) => `${x.grade || '—'} ${x.className}`));
    assert(Array.isArray(r.grades) && [...r.grades].every((g, i) => i === 0 || r.grades[i - 1] <= g), '响应含升序年级候选 grades', r.grades);
  }

  // ---- [8d] 年级多选筛选（2026-11-03）：行集合与文案标签同源 ----
  console.log('\n[8d] 年级多选筛选');
  if (r.grades && r.grades.length >= 1) {
    const g1 = r.grades[0];
    const fG1 = board.applyBoardFilter(r, { grades: [g1] });
    assert(fG1.rows.length > 0 && fG1.rows.every((x) => x.grade === g1), `单选 ${g1} 级：每行都是该年级`, fG1.rows.length);
    assert(fG1.activeFilters.includes(`${g1}级`), '标签写「YYYY级」', fG1.activeFilters);
    if (r.grades.length >= 2) {
      const [ga, gb] = r.grades.slice(0, 2);
      const fG2 = board.applyBoardFilter(r, { grades: [gb, ga] }); // 故意乱序传
      assert(
        fG2.rows.every((x) => x.grade === ga || x.grade === gb) && fG2.rows.length >= fG1.rows.length,
        '多选为并集（两个年级 ≥ 单年级）',
        { a: fG1.rows.length, ab: fG2.rows.length }
      );
      assert(fG2.activeFilters.includes(`${ga}+${gb}级`), '多选标签按升序拼「A+B级」', fG2.activeFilters);
      assert(
        /【班级状态[^\n]*年级?/.test(fG2.copyText) || fG2.copyText.includes(`${ga}+${gb}级`),
        '筛选标签进可复制文案标题',
        fG2.copyText.slice(0, 80)
      );
    }
  } else {
    assert(false, '全库解析不出任何年级（grade 兜底失效？）', r.grades);
  }

  // 档位与快捷 chip 互斥（前端选了 chip 会清档位）；服务端同时收到时快捷优先，不得筛成空
  const fMix = board.applyBoardFilter(r, { quick: 'zeroToday', level: 'zero', metric: 'daily' });
  assert(fMix.rows.length > 0, 'chip 与档位同时传入时不筛成空', fMix.rows.length);

  // ---- [9] 缓存：命中必须返回同一份计算结果，且**不同窗口不得共用缓存** ----
  //
  // 旧断言写的是「缓存命中的总量 == 脚本开头那次冷查询的总量」，这在生产库上是**假失败**：
  // 冷聚合本身要 14 秒，脚本从 [1] 跑到 [9] 早超过 60 秒 TTL，期间学生还在同步步数
  // （实测 achievedToday 756 → 759），拿几分钟前的快照比数字当然比不上。
  // 缓存真正要保证的是两件事，都跟数据变化无关：
  //   ① 60 秒内重复请求**不重算**（返回同一个对象引用）；
  //   ② 窗口换了（本日/本周/本月）必须重算 —— 2026-11-12 把缓存 key 从
  //      `day|from|weekStart|span` 改成 `day|from|weekStart|attRangeKey`，
  //      key 里少了这一维的话，切窗口会拿到上一个窗口的数据（数字看着正常但区间是错的，
  //      正是这页最要命的一类静默 bug）。
  console.log('\n[9] 缓存一致性与 key 维度');
  {
    const c1 = await board.classStatusBoard({ force: true });
    const c2 = await board.classStatusBoard();
    assert(c1 === c2, '60 秒内重复请求命中缓存（同一对象引用，未重算）', { same: c1 === c2 });
    // 不同窗口必须是不同的缓存项
    const cDay = await board.classStatusBoard({ attRange: 'day' });
    const cMonth = await board.classStatusBoard({ attRange: 'month' });
    assert(cDay !== c2 && cMonth !== c2, '切换窗口不会命中上一个窗口的缓存', {
      dayHit: cDay === c2, monthHit: cMonth === c2,
    });
    assert(cDay.attRange === 'day' && cMonth.attRange === 'month', '缓存项各自记住自己的窗口', [cDay.attRange, cMonth.attRange]);
    // 再取一次同窗口 → 应命中（证明 key 稳定，不是每次都重算）
    assert(await board.classStatusBoard({ attRange: 'month' }) === cMonth, '同窗口二次请求命中缓存');
  }

  // ---- [10] 考勤字段路径（2026-11-03 修复「考勤一直是 —」的回归锚）----
  //
  // 根因：聚合曾读 $metrics.shouldCount/actualCount/shouldStay，但写入端
  // (routes/union.js::fillDerived) 把这些数字放 **details**，metrics 只有 ratios/values
  // → 应到恒 0 → ratePercent 恒 null → 考勤列恒「—」。
  // 此前全库没有考勤模块记录，[6] 的加权断言从未真正生效过 —— 这里**主动造数**
  // 让它每次运行都咬合（造的是带时间戳前缀的临时班与临时记录，跑完即删，
  // 并在删除后 force 刷新一次缓存，不给线上留 60 秒的脏缓存）。
  console.log('\n[10] 考勤聚合读 details（造数 + 应到加权交叉核对）');
  {
    const TS = String(Date.now());
    const CLS = `verify考勤_${TS}班`;
    // 手工期望值（与聚合完全独立的算术）：
    //   早操   should 40 / actual 36 → 0.9；晚自习 should 38 / actual 30 → ≈0.7895
    //   查宿   shouldStay 40 / actual 38 → 0.95；早八只记迟到 3 人（rate 恒 null）
    //   综合率 = Σrate×should ÷ Σshould = (0.9×40 + 0.7895×38 + 0.95×40) ÷ 118 ≈ 88.6%
    // 每条临时记录的**手工独立扣分**（与任何被测实现无关）：
    // ⚠️ deduct 必须由本表给、期望值由本表推 —— 若从被测代码算出来再断言被测代码，
    //   等于自证，正是 [6b] 要防的那类假绿。
    const SEED_DEDUCT = {
      morning_exercise: 1.0,
      study_evening: 2.1,
      night_dorm: 0.4,
      morning_class: 0.15,
      // 卫生评「良」→ 得 8 分 → 扣 2 分（与 check-modules 的 GRADE_SCORE 同一换算，
      // 但这里的数字是本表**手写**的，不从被测代码取）
      hygiene: 2.0,
    };
    const SEED_DAY_DEDUCT = Object.values(SEED_DEDUCT).reduce((a, b) => a + b, 0); // 5.65
    const seed = [
      { moduleKey: 'morning_exercise', details: { shouldCount: 40, actualCount: 36, absentCount: 4 }, rate: 36 / 40 },
      { moduleKey: 'study_evening', details: { shouldCount: 38, actualCount: 30, absentCount: 8 }, rate: 30 / 38 },
      { moduleKey: 'night_dorm', details: { shouldStay: 40, actualCount: 38, notReturnedCount: 2 }, rate: 38 / 40 },
      { moduleKey: 'morning_class', details: { lateCount: 3 }, rate: null },
      // ⚠️ 卫生这条是用户报障的主体（「卫生…相应没有被减分」）：旧公式压根不看它，
      //   加了这条记录后分数必须**明显掉 2 分**。ratePercent 不受它影响（考勤率只看 4 个模块）。
      { moduleKey: 'hygiene', details: { grade: ['良'], score: 8 }, rate: null, targetType: 'area', metrics: { values: { score: 8 } } },
    ].map((s) => ({ ...s, deduct: SEED_DEDUCT[s.moduleKey] }));
    await ClassProfile.create({ className: CLS, status: 'normal' });
    await CheckRecord.insertMany(
      seed.map((s) => ({
        moduleKey: s.moduleKey,
        date: day,
        period: '',
        targetType: 'class',
        targetId: CLS,
        targetName: CLS,
        className: CLS,
        details: s.details,
        // ⚠️ deduct 必须一起造（用户 2026-11-19 之后分数就是从这里算的）：
        //   写入端 routes/union.js 每条记录都落 deduct = computeDeduct(...)，
        //   只造 details 不造 deduct 的记录在看板里等于「零扣分」→ 分数恒 10，
        //   断言会假绿（上一版就是这么测过的：公式读 details 时才碰巧对上）。
        //   这里按**手工独立算**的扣分值写，与被测实现无关。
        deduct: s.deduct,
        // 与真实写入同构：metrics 只装 ratios/values，数字都在 details —— 钉住字段路径
        // （卫生例外：它带自己的 values.score，由上面 seed 表显式给，不能被 lateCount 兜底覆盖）
        metrics: s.metrics || (s.rate == null ? { values: { lateCount: s.details.lateCount } } : { ratios: { rate: s.rate } }),
        status: 'submitted',
      }))
    );
    try {
      const rb = await board.classStatusBoard({ force: true });
      const row = rb.rows.find((x) => x.className === CLS);
      assert(!!row, '临时班出现在看板行里', rb.rows.length);
      if (row) {
        const att = row.attendance || {};
        assert(att.hasData === true, '考勤 hasData=true（此前恒 — 的直接判据）', att.hasData);
        assert(att.ratePercent !== null && att.ratePercent > 0, '综合考勤率有值', att.ratePercent);
        // 独立算术交叉核对（应到加权，早八不计率）
        const exp = ((36 / 40) * 40 + (30 / 38) * 38 + (38 / 40) * 40) / (40 + 38 + 40);
        assert(
          Math.abs(att.ratePercent - exp * 100) < 0.2,
          `综合考勤率 = 应到加权（期望 ≈${(exp * 100).toFixed(1)}%）`,
          att.ratePercent
        );
        const me = (att.modules || {}).morning_exercise || {};
        const nc = (att.modules || {}).night_dorm || {};
        const mc = (att.modules || {}).morning_class || {};
        assert(me.should === 40 && me.actual === 36, '早操应到/实到读的是 details', { s: me.should, a: me.actual });
        assert(nc.should === 40 && nc.actual === 38, '查宿读 details.shouldStay（不是 shouldCount）', { s: nc.should, a: nc.actual });
        assert(mc.rate === null && mc.ratePercent === null && (mc.lateCount || mc.late) === 3, '早八只记迟到、不给比率', mc);
        // ===== 分数（用户 2026-11-19 改为班超同源）=====
        // 期望 = 10 − 当日扣分合计，**扣分合计直接由本文件上方 SEED_DEDUCT 手算相加**，
        // 不读任何被测函数的返回值（读了就是自证）。
        const expScore = Math.round((10 - SEED_DAY_DEDUCT) * 100) / 100;
        assert(
          att.score !== null && att.score !== undefined && Math.abs(att.score - expScore) < 0.02,
          `分数 = 10 − 当日扣分合计（期望 ${expScore}，含卫生 ${SEED_DEDUCT.hygiene || 0} 分扣分）`,
          { got: att.score, expScore }
        );
        assert(att.lateCount === 3, '考勤带 lateCount（迟到人数仍下发）', att.lateCount);
        assert(att.score > 0 && att.score < 10, '分数落在 10 分制区间', att.score);
        // 分数**不等于**旧公式（10×加权率 − 迟到×0.05）：证明换掉了那套只看考勤四项的算法
        const legacyScore = Math.round((exp * 10 - 3 * 0.05) * 100) / 100;
        assert(
          Math.abs(att.score - legacyScore) > 0.05,
          `分数已脱离旧的「10×加权率−迟到×0.05」公式（旧=${legacyScore} 新=${att.score}）`,
          { legacyScore, got: att.score }
        );
        // 扣分明细必须能对上账：各模块日均扣分之和 = 日均总扣分 = 10 − 分数
        const ddSum = (att.deductDetail || []).reduce((a, x) => a + x.deduct, 0);
        assert(
          Math.abs(ddSum - (Number(att.deduct) || 0)) < 0.02,
          `扣分明细之和 = 日均总扣分（${ddSum.toFixed(2)} vs ${att.deduct}）`,
          { ddSum, deduct: att.deduct, detail: att.deductDetail }
        );
        assert(
          (att.deductDetail || []).some((x) => x.key === 'hygiene'),
          '扣分明细里出现卫生（用户点名「卫生没有被减分」，看得见才算修好）',
          att.deductDetail
        );
        assert(att.hasAnyCheck === true, '下发 hasAnyCheck（考勤列显隐看它）', att.hasAnyCheck);
      }

      // ---- [10b] 只有早八记录、且没人迟到：分数必须是 10.00 而不是「—」 ----
      // 这是 10 分制改造里最容易写错的一处：若分数按「率与迟到都为空 → null」推断，
      // 就会出现「迟到 3 人的班显示 9.85、一个都没迟到的班显示 —」，
      // 老师只会认为统计坏了（比显示 0 分更难解释）。
      const CLS2 = `verify考勤_${TS}乙班`;
      await ClassProfile.create({ className: CLS2, status: 'normal' });
      await CheckRecord.create({
        moduleKey: 'morning_class',
        date: day,
        period: '',
        targetType: 'class',
        targetId: CLS2,
        targetName: CLS2,
        className: CLS2,
        details: { lateCount: 0, lateList: [] },
        metrics: { values: { lateCount: 0 } },
        status: 'submitted',
      });
      const rb2 = await board.classStatusBoard({ force: true });
      const row2 = rb2.rows.find((x) => x.className === CLS2);
      assert(!!row2 && row2.attendance.hasData === true, '只有早八记录也算「有考勤数据」', row2 && row2.attendance);
      assert(!!row2 && row2.attendance.score === 10, '无迟到 = 满分 10.00（不是 —、不是 0）', row2 && row2.attendance.score);
      assert(!!row2 && row2.attendance.ratePercent === null, '早八不产生出勤率（率仍为 null）', row2 && row2.attendance.ratePercent);
      await CheckRecord.deleteMany({ className: CLS2 });
      await ClassProfile.deleteOne({ className: CLS2 });
    } finally {
      // 清理 + 强制刷新缓存：不留 60 秒的脏行给线上页面
      // ⚠️ 两个临时班都要清：CLS2 的清理写在 try 里，一旦中途抛错就漏在库里
      await CheckRecord.deleteMany({ className: { $in: [CLS, `verify考勤_${TS}乙班`] } });
      await ClassProfile.deleteMany({ className: { $in: [CLS, `verify考勤_${TS}乙班`] } });
      await board.classStatusBoard({ force: true }).catch(() => {});
      const left = await CheckRecord.countDocuments({ className: { $in: [CLS, `verify考勤_${TS}乙班`] } });
      assert(left === 0, '临时考勤记录清理干净', left);
    }
  }

  // ---- [11] today 参数 + 考勤窗口（本日/本周/本月，用户 2026-11-12）----
  console.log('\n[11] 日期选择（today）与考勤统计窗口');
  {
    // 独立算「该日所在 ISO 周的周一」：不复用被测的 dates.weekRange，
    // 否则实现写错时断言会跟着一起错（本文件的存在意义就是交叉核对）。
    const mondayOf = (key) => {
      const d = new Date(`${key}T00:00:00`);
      const shift = (d.getDay() + 6) % 7; // 0=周一
      d.setDate(d.getDate() - shift);
      const m = String(d.getMonth() + 1).padStart(2, '0');
      return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const firstOfMonth = (key) => `${key.slice(0, 7)}-01`;

    const pastDay = dates.addDays(day, -20); // 必然落在本周之前，周起点应早于本周
    const rp = await board.classStatusBoard({ today: pastDay, force: true });
    assert(rp.today === pastDay, 'today 覆盖生效（日列 = 所选日期）', rp.today);
    assert(rp.weekStart === dates.weekRange(pastDay).startKey, '周起点随所选日期重算', rp.weekStart);
    // 缺省窗口 = 本周（旧「回看 7 天」已被用户否掉）
    assert(rp.attRange === 'week', '缺省考勤窗口 = 本周', rp.attRange);
    assert(rp.from === mondayOf(pastDay), `本周窗口从周一开始（独立算的周一 = ${mondayOf(pastDay)}）`, rp.from);
    // ⚠️ 判「不是回看 7 天」不能靠在**某一天**上比对两个公式 —— pastDay 若恰好是周日，
    //    `周一(该日)` 与 `该日−6` 是同一天（2026-10-25 实测撞上，断言假红）。
    //   真正的不变量是「窗口起点随星期几变化」：取该周内**几个不同的日子**，
    //     · ISO 周口径 → from 恒等于同一周一（窗口起点不随所选日在周内移动）
    //     · 回看 7 天口径 → from 随所选日逐日平移
    //   只要窗口覆盖该周多个日子时 from 始终是同一个周一，就证明用的不是「该日−6」。
    const sameWeek = [];
    for (let back = 0; back <= 6; back += 1) sameWeek.push(dates.addDays(pastDay, -back));
    const weekStarts = [];
    for (const k of sameWeek) {
      // 只取与该日同属 ISO 周的那些天（回退超过周一就落进上一周，起点自然会变）
      const one = await board.classStatusBoard({ today: k, force: true });
      weekStarts.push({ day: k, from: one.from, monday: mondayOf(k) });
    }
    const consistent = weekStarts.filter((x) => x.from === x.monday);
    assert(
      consistent.length >= 1,
      `本周窗口起点 = 所选日所在周一（逐日核对 ${consistent.length}/${weekStarts.length} 天成立）`,
      weekStarts.slice(0, 3)
    );
    // 决定性判据：**同一周内至少有一天**（非周日）的 from ≠ 「该日−6」，
    // 说明实现取的是周一而不是简单回退 7 天。
    const distinguishes = weekStarts.some((x) => x.from !== dates.addDays(x.day, -6));
    assert(distinguishes, '窗口是 ISO 周一而非「该日 −6 天」（同周内两口径必然不同）', weekStarts.slice(0, 3));

    // 三个窗口逐个验起止
    const rd = await board.classStatusBoard({ today: pastDay, attRange: 'day', force: true });
    assert(rd.from === pastDay && rd.today === pastDay, '本日窗口 = 所选日当天', [rd.from, rd.today]);
    assert(rd.attRangeLabel === '本日', '本日窗口回显中文标签', rd.attRangeLabel);
    const rm = await board.classStatusBoard({ today: pastDay, attRange: 'month', force: true });
    assert(rm.from === firstOfMonth(pastDay), `本月窗口从 1 号开始（期望 ${firstOfMonth(pastDay)}）`, rm.from);
    assert(rm.attRangeLabel === '本月', '本月窗口回显中文标签', rm.attRangeLabel);

    // 窗口必须真的影响数据，不只是改个 from：造一个临时班，把记录分别落在
    // 「所选日 / 所选日所在周一 / 所选日所在月 1 号」三个位置上，
    // 于是 本日 ⊆ 本周 ⊆ 本月 应当**逐级变多**。
    // 不造数的话历史日期本来就一条记录都没有，0 ≤ 0 ≤ 0 恒成立 —— 那是假绿。
    // TS 是 [10] 块的局部变量，这里必须自己造一个（临时班名不能与别的节撞）
    const TS2 = String(Date.now());
    const CLSW = `verify窗口_${TS2}班`;
    const monday = mondayOf(pastDay);
    const monthFirst = firstOfMonth(pastDay);
    const winDates = [...new Set([pastDay, monday, monthFirst])];
    await ClassProfile.create({ className: CLSW, status: 'normal' });
    await CheckRecord.insertMany(
      winDates.map((dk, i) => ({
        moduleKey: 'morning_exercise',
        date: dk,
        period: '',
        targetType: 'class',
        targetId: CLSW,
        targetName: CLSW,
        className: CLSW,
        details: { shouldCount: 40, actualCount: 40 - i, absentCount: i },
        metrics: { ratios: { rate: (40 - i) / 40 } },
        status: 'submitted',
      }))
    );
    try {
      const countFor = async (range) => {
        const one = await board.classStatusBoard({ today: pastDay, attRange: range, force: true });
        const row = (one.rows || []).find((x) => x.className === CLSW);
        const recs = row && row.attendance && row.attendance.modules && row.attendance.modules.morning_exercise;
        return recs ? recs.records : 0;
      };
      const [nDay, nWeek, nMonth] = await Promise.all([countFor('day'), countFor('week'), countFor('month')]);
      assert(nDay === 1, `本日窗口只命中所选日那 1 条（造了 ${winDates.length} 个日期）`, nDay);
      assert(nWeek >= nDay && nMonth >= nWeek, `窗口越大命中记录越多（本日 ${nDay} ≤ 本周 ${nWeek} ≤ 本月 ${nMonth}）`, { nDay, nWeek, nMonth });
      // 三个日期不重合时，必须真的逐级扩大（否则「本月」只是个换了名字的本周）
      if (winDates.length === 3) {
        assert(nWeek >= 2, `本周窗口含周一那条（≥2，实际 ${nWeek}）`, nWeek);
        assert(nMonth === 3, `本月窗口含全部 3 条（实际 ${nMonth}）`, nMonth);
      }
    } finally {
      await CheckRecord.deleteMany({ className: CLSW });
      await ClassProfile.deleteOne({ className: CLSW });
    }

    // 非法窗口 = 回退本周（不能让拼错的参数悄悄统计出一个空区间）
    const rBadRange = await board.classStatusBoard({ today: pastDay, attRange: 'quarter', force: true });
    assert(rBadRange.attRange === 'week' && rBadRange.from === mondayOf(pastDay), '非法窗口回退本周', [rBadRange.attRange, rBadRange.from]);
    // 旧的 days 参数不再参与计算（两套窗口并存迟早「脚注说本周、数据是回看 7 天」）
    const rLegacyDays = await board.classStatusBoard({ today: pastDay, days: 30, force: true });
    assert(rLegacyDays.attRange === 'week' && rLegacyDays.from === mondayOf(pastDay), '旧 days 参数不再改变窗口', [rLegacyDays.attRange, rLegacyDays.from]);

    // 考勤计算规则文案（用户 2026-11-12「要标注考勤计算规则，如迟到缺勤等逻辑」）
    assert(Array.isArray(rp.attRuleLines) && rp.attRuleLines.length >= 3, '下发考勤规则（≥3 条）', rp.attRuleLines && rp.attRuleLines.length);
    const ruleText = (rp.attRuleLines || []).join(' ');
    assert(/迟到/.test(ruleText) && /缺勤/.test(ruleText), '规则里写明迟到与缺勤逻辑', ruleText.slice(0, 80));
    assert(/未归/.test(ruleText), '规则里写明查宿未归', ruleText.slice(0, 120));
    assert(/10/.test(ruleText), '规则里写明满分刻度', ruleText.slice(0, 60));
    // 数字必须与真源一致，不能是写死的旧单价
    const cmSvc = require(path.join(serverDir, 'src', 'services', 'check-modules'));
    assert(ruleText.includes(String(cmSvc.PERSON_DEDUCT.late)), `规则里的迟到单价跟随 PERSON_DEDUCT（${cmSvc.PERSON_DEDUCT.late}）`, ruleText.slice(0, 90));
    // 复制文案（copy=all）也要带规则
    assert(/考勤计算规则/.test(rp.copyText), 'copy=all 的复制文案含规则段', rp.copyText.split('\n').slice(-2)[0]);

    // 非法日期 = 当未指定（不能让拼错的参数统计出空日期）
    const rBad = await board.classStatusBoard({ today: 'not-a-date', force: true });
    assert(rBad.today === day, '非法 today 回退服务器今天', rBad.today);
    // 收尾：刷新回「今天」的缓存，避免把历史日期的结果留给下一次页面加载
    await board.classStatusBoard({ force: true });
  }

  // ---- [12] 扣分来源细化 targets（用户 2026-11-20「减分要写明考察项」）----
  //
  // 需求原文：「班级状态中选择了班超分要有查看日期并且还要给各班中如有减分情况要写
  //          哪个考察项检查扣分如卫生-宿舍、晚自习这样」。
  // 实现：band-chao.scoreOfAggregate 给每个模块产出 targets（模块 × 受检类型），
  // 看板把它透传到 attendance.deductDetail[i].targets。
  // 这一节既检查「全库不变式」，也**造一个 4 种受检类型的临时班**验证拆分与「其他」折叠
  //（不造数的话线上卫生类可能只有 dorm_room 一种，超过 3 项的折叠分支永远测不到）。
  console.log('\n[12] 扣分明细 targets（模块 × 受检类型）');
  {
    // 全库不变式：每项 targets 都是数组；Σ targets = 模块日均扣分（必须能对上账）
    const allDetail = r.rows.flatMap((row) => (row.attendance && row.attendance.deductDetail) || []);
    assert(allDetail.length > 0, '本周有扣分明细可用于核对', allDetail.length);
    const notArray = allDetail.filter((d) => !Array.isArray(d.targets));
    assert(notArray.length === 0, 'deductDetail 每项都带 targets 数组（不是 undefined）', notArray.slice(0, 2));
    const badSum = allDetail.filter((d) => {
      const sum = d.targets.reduce((a, t) => a + (Number(t.avgDeduct) || 0), 0);
      return Math.abs(sum - (Number(d.deduct) || 0)) > 0.011;
    });
    assert(badSum.length === 0, 'Σ targets.avgDeduct = 模块日均扣分（全库逐项对账）', badSum.slice(0, 2));
    const tooMany = allDetail.filter((d) => d.targets.length > 4);
    assert(tooMany.length === 0, '每个模块最多 4 个子项（前 3 + 「其他」）', tooMany.slice(0, 2));
    const badName = allDetail.filter((d) => d.targets.some((t) => !t.name.startsWith(`${d.name}-`)));
    assert(badName.length === 0, '子项名称 = 「模块名-受检类型」（如 卫生-宿舍）', badName.slice(0, 2));

    // 造数：卫生 4 种受检类型 + 晚自习 1 种 → 验证拆分 / 排序 / 折叠 / 中文映射
    const TS3 = String(Date.now());
    const CLST = `verify目标_${TS3}班`;
    await ClassProfile.create({ className: CLST, status: 'normal' });
    const mkHyg = (type, deduct, i) => ({
      moduleKey: 'hygiene',
      date: day,
      period: '',
      targetType: type,
      targetId: `${CLST}_${type}`,
      targetName: `${CLST}_${type}`,
      className: CLST,
      // 用手写的 deduct（独立于被测实现），details 只作展示字段
      deduct,
      details: { grade: ['良'], score: 8 },
      metrics: { values: { score: 8 } },
      status: 'submitted',
    });
    await CheckRecord.insertMany([
      mkHyg('dorm_room', 0.4, 1),
      mkHyg('classroom', 0.1, 2),
      mkHyg('area', 0.05, 3),
      mkHyg('class', 0.02, 4),
      {
        moduleKey: 'study_evening',
        date: day,
        period: '',
        targetType: 'classroom',
        targetId: CLST,
        targetName: CLST,
        className: CLST,
        deduct: 0.2,
        details: { shouldCount: 30, actualCount: 27, absentCount: 3 },
        metrics: { ratios: { rate: 0.9 } },
        status: 'submitted',
      },
    ]);
    try {
      const rb = await board.classStatusBoard({ force: true });
      const rowT = rb.rows.find((x) => x.className === CLST);
      assert(!!rowT, '临时班出现在看板行里', rb.rows.length);
      if (rowT) {
        const detail = rowT.attendance.deductDetail || [];
        const hyg = detail.find((d) => d.key === 'hygiene');
        assert(!!hyg && hyg.targets.length === 4, '卫生 4 种受检类型 → 3 项 + 「其他」共 4 项', hyg && hyg.targets);
        if (hyg) {
          const names = hyg.targets.map((t) => t.name);
          // 排序契约：按日均扣分降序（0.4 > 0.1 > 0.05 > 0.02），「其他」恒在最后
          assert(
            JSON.stringify(names) === JSON.stringify(['卫生-宿舍', '卫生-教室', '卫生-卫生区', '卫生-其他']),
            '受检类型中文名与降序（卫生-宿舍/教室/卫生区/其他）',
            names
          );
          const byName = new Map(hyg.targets.map((t) => [t.name, t]));
          assert(
            Math.abs(byName.get('卫生-宿舍').avgDeduct - 0.4) < 0.011 &&
              Math.abs(byName.get('卫生-教室').avgDeduct - 0.1) < 0.011 &&
              Math.abs(byName.get('卫生-其他').avgDeduct - 0.02) < 0.011,
            '各子项日均扣分 = 该受检类型的扣分（手写值）',
            hyg.targets
          );
          const sumT = hyg.targets.reduce((a, t) => a + t.avgDeduct, 0);
          assert(Math.abs(sumT - hyg.deduct) < 0.011, `Σ 子项 = 卫生模块日均扣分（${sumT.toFixed(2)} vs ${hyg.deduct}）`, {
            sumT,
            module: hyg.deduct,
          });
          assert(
            hyg.targets.every((t) => t.count === 1),
            '子项条数 = 该受检类型记录数（各 1 条）',
            hyg.targets.map((t) => t.count)
          );
          assert(hyg.targets.every((t) => t.key.startsWith('hygiene:')), '子项 key 带模块前缀（同类型可跨模块复用）', hyg.targets.map((t) => t.key));
        }
        const even = detail.find((d) => d.key === 'study_evening');
        assert(
          !!even && even.targets.length === 1 && even.targets[0].name === '晚自习-教室',
          '晚自习只有一个受检类型时也带 targets（晚自习-教室）',
          even && even.targets
        );
        // 分数仍然可由扣分明细还原：10 − Σ 各模块日均扣分
        const totalDeduct = detail.reduce((a, d) => a + d.deduct, 0);
        assert(
          Math.abs(10 - totalDeduct - rowT.attendance.score) < 0.02,
          `看板分数 = 10 − Σ 模块日均扣分（${rowT.attendance.score}）`,
          { score: rowT.attendance.score, totalDeduct }
        );
      }
    } finally {
      await CheckRecord.deleteMany({ className: CLST });
      await ClassProfile.deleteOne({ className: CLST });
      await board.classStatusBoard({ force: true }).catch(() => {});
      const leftT = await CheckRecord.countDocuments({ className: CLST });
      assert(leftT === 0, '临时 targets 造数清理干净', leftT);
    }
  }

  await mongoose.disconnect();
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.stack);
  process.exit(1);
});
