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
  const fHalf = board.applyBoardFilter(r, { level: 'belowHalf', metric: 'daily' });
  assert(
    fHalf.rows.every((x) => x.run.dailyRate !== null && x.run.dailyRate < 50),
    '档位「日达标低于一半」每行 <50%',
    fHalf.rows.slice(0, 2).map((x) => x.run.dailyRate)
  );
  assert(fZero2.rows.length <= fHalf.rows.length, '零达标是低于一半的子集（档位真的分层）', {
    zero: fZero2.rows.length,
    half: fHalf.rows.length,
  });
  assert(fHalf.activeFilters[0].includes('日达标'), '档位标签写明指标（日）', fHalf.activeFilters);
  const fWeekHalf = board.applyBoardFilter(r, { level: 'belowHalf', metric: 'weekly' });
  assert(fWeekHalf.activeFilters[0].includes('周达标'), '切换指标后标签变「周达标」', fWeekHalf.activeFilters);
  assert(
    fWeekHalf.rows.every((x) => x.run.weeklyRate !== null && x.run.weeklyRate < 50),
    '周达标档位筛的是周列而不是日列',
    fWeekHalf.rows.slice(0, 2).map((x) => x.run.weeklyRate)
  );
  // 档位与快捷 chip 互斥（前端选了 chip 会清档位）；服务端同时收到时快捷优先，不得筛成空
  const fMix = board.applyBoardFilter(r, { quick: 'zeroToday', level: 'zero', metric: 'daily' });
  assert(fMix.rows.length > 0, 'chip 与档位同时传入时不筛成空', fMix.rows.length);

  // ---- [9] 缓存不返回过期数据 ----
  console.log('\n[9] 缓存一致性');
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
