/**
 * 全校班级状态总览（用户 2026-10-29）：
 *   「增加班级状态页面显示所有班级的考勤、校园跑达标(日、周)，并且可以复制到文本如未达标班级等」
 *
 * ===== 性能口径（这一版是重写，别退回旧写法）=====
 * 第一版在 Node 侧聚合：`User.find(2274 个 openid)` + `UserGoal.find($in 2274)` +
 * `RunRecord.aggregate($in 2274)`，实测 **17 秒**（瓶颈不是缺索引，而是远程 Mongo
 * 每次往返都要传几千条中间结果）。老师点开等 17 秒 = 以为系统坏了。
 *
 * 现在的口径：**聚合下推到 Mongo**，网络只传最终的 43 行：
 *   · 校园跑：从 `users` 起手 → `$lookup user_goals`（个人计划）→ `$lookup run_records`（本周）
 *     → `$addFields` 判达标 → `$group` 按班汇总。一次查询同时拿到
 *     studentCount / 日达标 / 周达标 / 今日步数（未达标学生也计入分母，这正是要点）。
 *   · 考勤：`check_records` 按 `className + moduleKey` 一次聚合（应到加权），不拉明细。
 * 另外加 60 秒内存缓存：这张表的数据变化很慢（老师刷新不是为了看秒级变化），
 * 缓存能让人连续点击时**立刻**出结果（与 `routes/class.js::classRankCache` 同一思路）。
 *
 * ===== 达标口径（改这里前先读对应实现，禁止另写一份）=====
 *   生效目标 = 个人计划优先，否则全局默认 —— 同 `services/goals.js::getEffectiveGoal`
 *   （这里用 $lookup + $ifNull 复刻同一优先级，注释里逐条对应，改动要与该函数同步）。
 *   周起点 = ISO 周一（`utils/dates.js::weekRange`）。
 *
 * ===== 班级范围（最容易犯也最难发现的错）=====
 *   只统计 `status === 'normal'` 的班（`ClassProfile.joinsBandChao`）——
 *   实习 / 毕业班**不参加**班超与校园跑。把它们算进来，会把「本来就没考勤」
 *   误报成「未达标」，老师照着名单去催一个根本不用跑的班。
 */

const User = require('../models/user');
const ClassProfile = require('../models/class-profile');
const CheckRecord = require('../models/check-record');
const GoalConfig = require('../models/goal-config');
const dates = require('../utils/dates');

// 考勤模块（与 routes/class.js::ATTENDANCE_MODULES 同源）
const MODULES = [
  { key: 'morning_exercise', name: '早操' },
  { key: 'morning_class', name: '早八' },
  { key: 'study_evening', name: '晚自习' },
  { key: 'night_dorm', name: '查宿' },
];
const MODULE_KEYS = MODULES.map((m) => m.key);

// 单次最多统计多少天（考勤区间上限，与班级页一致）
const MAX_DAYS = 92;
const DEFAULT_DAYS = 7;

// 缓存 60 秒：见文件头「性能口径」。key 里带 today/from/span/周起点，跨天自动失效。
const CACHE_TTL = 60 * 1000;
const boardCache = new Map();

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const pct = (num, den) => (den > 0 ? round1((num / den) * 100) : null);

/**
 * 全校班级状态总览。
 * @param {object} [opts]
 * @param {string} [opts.today] 覆盖「今天」（便于测试与补算）
 * @param {number} [opts.days] 考勤回看天数（默认 7，上限 92）
 * @param {boolean} [opts.force] 忽略缓存
 */
async function classStatusBoard({ today, days, force } = {}) {
  const day = today || dates.todayKey();
  const span = Math.min(Math.max(Number(days) || DEFAULT_DAYS, 1), MAX_DAYS);
  const from = dates.addDays(day, -(span - 1));
  const { startKey: weekStart } = dates.weekRange(day);

  const cacheKey = `${day}|${from}|${weekStart}|${span}`;
  if (!force) {
    const hit = boardCache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  }

  // ---- 1) 参与统计的班级（实习/毕业班排除，见文件头）----
  const profiles = await ClassProfile.find({ enabled: { $ne: false } })
    .select('className schoolName departmentName grade status hasMorningExercise hasMorningClass hasNightStudy hasMorningRun')
    .lean();
  // 用 model 上的**唯一判定**，不在这里重写 status 判断
  const activeProfiles = profiles.filter((p) => ClassProfile.joinsBandChao(p));
  const activeNames = activeProfiles.map((p) => p.className);
  const skipped = profiles.length - activeNames.length;

  if (!activeNames.length) {
    const empty = buildResult({ day, from, weekStart, span, totals: emptyTotals(skipped), rows: [], attBy: new Map() });
    boardCache.set(cacheKey, { at: Date.now(), value: empty });
    return empty;
  }

  // ---- 2) 全局默认目标（个人计划在聚合里 $lookup 覆盖）----
  const globalConfig = await GoalConfig.getSingleton();
  const globalDaily = Number(globalConfig.daily && globalConfig.daily.steps) || 0;
  const globalWeekly = Number(globalConfig.weekly && globalConfig.weekly.steps) || 0;

  // ---- 3) 校园跑：**单次聚合**（users → goals → run_records → group by className）----
  //
  // $lookup run_records 用 pipeline + let 而不是 localField/foreignField：
  // 需要同时按 openid 与日期区间过滤，localField 形式无法带 $match 条件
  // （历史踩坑点：localField 形式拿到该生全部历史记录，内存与传输都爆）。
  const runAgg = await User.aggregate([
    { $match: { role: { $ne: 'teacher' }, className: { $in: activeNames } } },
    { $project: { openid: 1, className: 1 } },
    // 个人计划（没有则用全局默认）
    {
      $lookup: {
        from: 'user_goals',
        let: { oid: '$openid' },
        pipeline: [
          { $match: { $expr: { $eq: ['$openid', '$$oid'] } } },
          { $project: { _id: 0, daily: 1, weekly: 1 } },
          { $limit: 1 },
        ],
        as: 'goal',
      },
    },
    // ⚠️ 目标取值必须用 `$toDouble: { $arrayElemAt: ['$goal.daily.steps', 0] }` 这种**先取后转**的写法。
    //   写成 `$toDouble: '$g.daily.steps'`（先拿对象再取路径）在 g 为 null 时会让
    //   `$toDouble` 报错，MongoDB 会**静默丢弃该文档** —— 表现为「全校总数少了几个人」，
    //   而这种偏差肉眼完全看不出来（本次真实发生：819 vs 正确 829，差的正是 10 个没有个人计划的学生）。
    //   所以不要为了"省一个 $addFields"把 g 中间变量再取路径。
    {
      $addFields: {
        // 生效目标：个人计划优先，否则全局默认（同 services/goals.js::getEffectiveGoal）
        dailyTarget: {
          $ifNull: [
            { $toDouble: { $arrayElemAt: ['$goal.daily.steps', 0] } },
            globalDaily,
          ],
        },
        weeklyTarget: {
          $ifNull: [
            { $toDouble: { $arrayElemAt: ['$goal.weekly.steps', 0] } },
            globalWeekly,
          ],
        },
      },
    },
    // 本周（周一起）该生每日步数；只做求和，不携带明细
    {
      $lookup: {
        from: 'run_records',
        let: { oid: '$openid' },
        pipeline: [
          { $match: { $expr: { $eq: ['$openid', '$$oid'] }, date: { $gte: weekStart, $lte: day } } },
          { $group: { _id: '$date', steps: { $sum: { $ifNull: ['$steps', 0] } } } },
        ],
        as: 'runs',
      },
    },
    // ⚠️ 必须**分两个 $addFields 阶段**：同一阶段里不能引用本阶段刚加出来的字段
    //   （MongoDB 对同一 $addFields 内的表达式是**并行求值**的，`$gte: ['$todaySteps', ...]`
    //    拿到的是旧文档里的 todaySteps（不存在 → null）→ 条件恒假 → achievedToday 恒 0）。
    //   这个 bug 真实发生过：第一版合成一个阶段，全表 2285 人算出「今日达标 0 人」，
    //   而单学生调试脚本恰好因为先算出了 todaySteps 看起来是对的 —— 极难发现。
    {
      $addFields: {
        todaySteps: {
          $sum: {
            $map: {
              input: {
                $filter: { input: '$runs', as: 'r', cond: { $eq: ['$$r._id', day] } },
              },
              as: 'r',
              in: '$$r.steps',
            },
          },
        },
        weekSteps: { $sum: { $map: { input: '$runs', as: 'r', in: '$$r.steps' } } },
      },
    },
    {
      // 达标判定：目标 > 0 且步数 ≥ 目标（目标为 0 时不算达标 —— 与班级页
      // `dailyTarget > 0 && day.steps >= dailyTarget` 一致，避免「0 目标白送达标」）
      $addFields: {
        achievedToday: {
          $cond: [
            { $and: [{ $gt: ['$dailyTarget', 0] }, { $gte: ['$todaySteps', '$dailyTarget'] }] },
            1,
            0,
          ],
        },
        achievedWeek: {
          $cond: [
            { $and: [{ $gt: ['$weeklyTarget', 0] }, { $gte: ['$weekSteps', '$weeklyTarget'] }] },
            1,
            0,
          ],
        },
      },
    },
    {
      $group: {
        _id: '$className',
        studentCount: { $sum: 1 },
        achievedToday: { $sum: '$achievedToday' },
        achievedWeek: { $sum: '$achievedWeek' },
        stepsToday: { $sum: '$todaySteps' },
      },
    },
  ]);

  const runBy = new Map(runAgg.map((r) => [r._id, r]));

  // ---- 4) 考勤：**单次聚合**（className + moduleKey，应到加权）----
  //
  // 出勤率不能简单平均，必须按应到人数加权 —— 否则「应到 40 实到 38」与「应到 5 实到 1」
  // 得到同一个比率，小班的一条记录能拖垮全校平均线（与 routes/class.js::buildDayModule 同口径）。
  // 应到字段：早操/晚自习 → metrics.shouldCount，查宿 → metrics.shouldStay。
  const attAgg = await CheckRecord.aggregate([
    {
      $match: {
        className: { $in: activeNames },
        date: { $gte: from, $lte: day },
        moduleKey: { $in: MODULE_KEYS },
        status: { $in: CheckRecord.COUNTED_STATUS },
        voided: { $ne: true },
      },
    },
    {
      $addFields: {
        should: {
          $cond: [
            { $eq: ['$moduleKey', 'night_dorm'] },
            { $ifNull: ['$metrics.shouldStay', 0] },
            { $ifNull: ['$metrics.shouldCount', 0] },
          ],
        },
        actual: { $ifNull: ['$metrics.actualCount', 0] },
        late: { $ifNull: ['$details.lateCount', 0] },
        // 记录里已算好的比率优先（与页面展示同源），缺失才用 actual/should
        storedRate: '$metrics.ratios.rate',
      },
    },
    {
      $addFields: {
        rate: {
          $cond: [
            { $eq: [{ $type: '$storedRate' }, 'double'] },
            { $min: [1.5, { $max: [0, '$storedRate'] }] },
            {
              $cond: [
                { $gt: ['$should', 0] },
                { $min: [1.5, { $max: [0, { $divide: ['$actual', '$should'] }] }] },
                0,
              ],
            },
          ],
        },
      },
    },
    {
      $group: {
        _id: { className: '$className', moduleKey: '$moduleKey' },
        should: { $sum: '$should' },
        actual: { $sum: '$actual' },
        late: { $sum: '$late' },
        rateW: { $sum: { $multiply: ['$rate', '$should'] } },
        records: { $sum: 1 },
      },
    },
  ]);

  // className → moduleKey → { should, actual, late, rateW, records }
  const attBy = new Map();
  for (const r of attAgg) {
    const cls = r._id.className;
    let byModule = attBy.get(cls);
    if (!byModule) {
      byModule = {};
      attBy.set(cls, byModule);
    }
    byModule[r._id.moduleKey] = r;
  }

  // ---- 5) 组装 43 行（这一步纯内存，无任何 await）----
  const rows = activeProfiles.map((p) => {
    const run = runBy.get(p.className) || { studentCount: 0, achievedToday: 0, achievedWeek: 0, stepsToday: 0 };
    const att = attBy.get(p.className) || {};

    const modules = {};
    for (const mDef of MODULES) {
      const m = att[mDef.key];
      if (!m) continue;
      if (mDef.key === 'morning_class') {
        // 早八只记迟到人（无应到/实到，见 check-modules 模块定义），不产生比率
        modules[mDef.key] = { key: mDef.key, name: mDef.name, rate: null, ratePercent: null, late: m.late, records: m.records };
        continue;
      }
      const rate = m.should > 0 ? m.rateW / m.should : null;
      modules[mDef.key] = {
        key: mDef.key,
        name: mDef.name,
        rate: rate === null ? null : Math.round(rate * 10000) / 10000,
        ratePercent: rate === null ? null : round1(rate * 100),
        should: m.should,
        actual: m.actual,
        records: m.records,
      };
    }

    // 综合出勤率：有应到人数的模块按应到加权合并（早八不参与）
    let shouldSum = 0;
    let rateWSum = 0;
    for (const mDef of MODULES) {
      const m = att[mDef.key];
      if (!m || mDef.key === 'morning_class') continue;
      shouldSum += m.should;
      rateWSum += m.rateW;
    }
    const attRate = shouldSum > 0 ? round1((rateWSum / shouldSum) * 100) : null;

    return {
      className: p.className,
      schoolName: p.schoolName || '',
      departmentName: p.departmentName || '',
      grade: p.grade || '',
      studentCount: run.studentCount || 0,
      run: {
        enabled: p.hasMorningRun !== false,
        stepsToday: run.stepsToday || 0,
        achievedToday: run.achievedToday || 0,
        dailyRate: pct(run.achievedToday, run.studentCount),
        achievedWeek: run.achievedWeek || 0,
        weeklyRate: pct(run.achievedWeek, run.studentCount),
      },
      attendance: {
        modules,
        ratePercent: attRate,
        hasData: shouldSum > 0 || !!att.morning_class,
      },
      flags: {
        hasMorningExercise: p.hasMorningExercise !== false,
        hasMorningClass: p.hasMorningClass !== false,
        hasNightStudy: p.hasNightStudy !== false,
        hasMorningRun: p.hasMorningRun !== false,
      },
    };
  });

  // ---- 6) 排序：未达标优先（让老师一眼看到要催的班）----
  const bucket = (r) => (r.run.dailyRate === null ? 1 : r.run.dailyRate < 100 ? 0 : 2);
  rows.sort((a, b) => {
    const oa = bucket(a);
    const ob = bucket(b);
    if (oa !== ob) return oa - ob;
    // 同为未达标：达标率低的排前面（缺口大的先催）
    const ra = a.run.dailyRate === null ? 101 : a.run.dailyRate;
    const rb = b.run.dailyRate === null ? 101 : b.run.dailyRate;
    if (ra !== rb) return ra - rb;
    return String(a.className).localeCompare(String(b.className), 'zh-CN');
  });

  const result = buildResult({ day, from, weekStart, span, totals: null, rows, attBy, skipped });
  boardCache.set(cacheKey, { at: Date.now(), value: result });
  return result;
}

function emptyTotals(skipped) {
  return { classCount: 0, studentCount: 0, achievedToday: 0, achievedWeek: 0, dailyRate: null, weeklyRate: null, skippedClasses: skipped };
}

/**
 * 汇总 + 未达标清单 + 可复制文案。
 *
 * 未达标判定刻意排除三类班，否则会产生大量「不用跑却被点名」的误报：
 *   ① 未参与校园跑（hasMorningRun=false）—— 本班不跑，不该被催；
 *   ② 班里没有学生（studentCount=0）—— 空班，催也没对象；
 *   ③ 没有达标率（dailyRate=null）—— 分母为 0，无意义。
 */
function buildResult({ day, from, weekStart, span, rows, skipped }) {
  const students = rows.reduce((a, r) => a + r.studentCount, 0);
  const aToday = rows.reduce((a, r) => a + r.run.achievedToday, 0);
  const aWeek = rows.reduce((a, r) => a + r.run.achievedWeek, 0);

  const totals = {
    classCount: rows.length,
    studentCount: students,
    achievedToday: aToday,
    achievedWeek: aWeek,
    // 全校达标率按**学生**算，不是按班算（按班会掩盖大班的问题）
    dailyRate: pct(aToday, students),
    weeklyRate: pct(aWeek, students),
    // 被排除在统计外的班（实习/毕业），让老师知道总数对不对得上
    skippedClasses: skipped || 0,
  };

  // 未达标判定复用 QUICK_FILTERS（一份定义）：
  // 之前这里和 buildCopyText 各写一遍 filter 条件，改一处忘另一处就会出现
  // 「页面显示 41 个未达标、复制出来 43 个」——正是本轮要消灭的那类不一致。
  const notAchievedDaily = rows.filter(QUICK_FILTERS.notDaily.test);
  const notAchievedWeekly = rows.filter(QUICK_FILTERS.notWeek.test);
  const attendanceMissing = rows.filter(QUICK_FILTERS.attMissing.test);

  // 系部候选（筛选下拉用）：从实际数据里取，不查组织架构 ——
  // 组织架构里可能有系部但还没有班级，列出来选了是空，反而像坏了。
  const departments = [...new Set(rows.map((r) => r.departmentName).filter(Boolean))].sort((a, b) =>
    String(a).localeCompare(String(b), 'zh-CN')
  );

  return {
    today: day,
    from,
    weekStart,
    days: span,
    totals,
    rows,
    departments,
    notAchieved: {
      daily: notAchievedDaily.map(brief),
      weekly: notAchievedWeekly.map(brief),
      attendanceMissing: attendanceMissing.map(brief),
    },
    // 未筛选态的完整报告（有筛选时由 applyBoardFilter 重新生成对应文案）
    copyText: buildCopyText({ day, from, weekStart, totals, filtered: null, tags: [], rows, quick: '' }),
  };
}

/**
 * 按查询参数筛选（用户 2026-10-30「支持筛选，复制时复制的是筛选后的相应内容」）。
 *
 * 缓存的是**全量聚合结果**，筛选只在内存里做 —— 切换筛选不必重算 Mongo 聚合（那要 3 秒），
 * 而且保证「同一批数据」：不会出现两次请求之间数据变了、筛选前后对不上。
 *
 * 返回里 copyText 是**按当前筛选**重新生成的，所以前端复制到的永远是看到的那些行。
 */
function applyBoardFilter(board, { view, quick, department, keyword } = {}) {
  const { rows, filtered, tags } = filterBoard(board, { view, quick, department, keyword });
  if (!tags.length) return { ...board, view: view || 'overview', filtered: board.totals, activeFilters: [] };
  return {
    ...board,
    view: view || 'overview',
    // rows 换成筛选后的（前端直接渲染，不再自己过滤）
    rows,
    // 全校口径保留在 totals，筛选口径放 filtered —— 两个都要给：
    // 顶部要显示「筛出 5 个班」，也要能说明「全校 43 个班」，否则老师会以为数据被截断。
    filtered,
    activeFilters: tags,
    copyText: buildCopyText({
      day: board.today,
      from: board.from,
      weekStart: board.weekStart,
      totals: board.totals,
      filtered,
      tags,
      rows,
      quick,
    }),
  };
}

// 未达标清单的简报（只带催人时要说的话）
function brief(r) {
  return {
    className: r.className,
    departmentName: r.departmentName,
    studentCount: r.studentCount,
    dailyRate: r.run.dailyRate,
    weeklyRate: r.run.weeklyRate,
    achievedToday: r.run.achievedToday,
    achievedWeek: r.run.achievedWeek,
    attendanceRate: r.attendance.ratePercent,
  };
}

/**
 * 快捷筛选（用户 2026-10-30「支持筛选，复制时复制的是筛选后的相应内容」）。
 *
 * 筛选放在**服务端**而不是前端：可复制文案必须由服务端单点生成
 * （见 buildCopyText 注释 —— 前端各拼一次必然漂移成「列表 87%、文案 88%」，
 * 老师粘到群里被问住）。若筛选在前端、文案在服务端，两者就会用不同的行集合，
 * 正是这里要避免的那类不一致。所以「筛哪些行」也交给服务端，前端只传参数。
 *
 * 每个筛选都排除「不参跑的班 / 空班 / 无达标率」——
 * 把「本班本来就不用跑」列进催办名单，是最容易引起投诉的误报。
 */
const QUICK_FILTERS = {
  notDaily: {
    label: '今日未达标',
    test: (r) => r.run.enabled && r.studentCount > 0 && r.run.dailyRate !== null && r.run.dailyRate < 100,
  },
  notWeek: {
    label: '本周未达标',
    test: (r) => r.run.enabled && r.studentCount > 0 && r.run.weeklyRate !== null && r.run.weeklyRate < 100,
  },
  // 催办最常用的其实是这个：今日一个人都没达标（比「<100%」更能指出要找谁）
  zeroToday: {
    label: '今日零达标',
    test: (r) => r.run.enabled && r.studentCount > 0 && (r.run.achievedToday || 0) === 0,
  },
  attMissing: {
    label: '考勤待补',
    test: (r) => r.studentCount > 0 && (r.flags.hasMorningExercise || r.flags.hasNightStudy) && !r.attendance.hasData,
  },
};

/** 对全量聚合结果做筛选 + 重算小计（缓存的是全量，筛选在内存里做，切筛选不重算 Mongo） */
function filterBoard(board, { view, quick, department, keyword } = {}) {
  const q = String(keyword || '').trim();
  const tags = [];
  let rows = board.rows;

  const def = QUICK_FILTERS[quick];
  if (def) {
    rows = rows.filter(def.test);
    tags.push(def.label);
  }
  if (department) {
    rows = rows.filter((r) => r.departmentName === String(department));
    // 条件在 if 分支里恒真，写成 `rows.length || department` 只会让人误以为
    // 「筛出 0 个班时不打标签」——实际也会打。直接 push，行为不变、意图更清楚。
    tags.push(String(department));
  }
  if (q) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    rows = rows.filter((r) => re.test(r.className) || re.test(r.departmentName || ''));
    tags.push(`搜索「${q}」`);
  }

  const students = rows.reduce((a, r) => a + r.studentCount, 0);
  const aToday = rows.reduce((a, r) => a + r.run.achievedToday, 0);
  const aWeek = rows.reduce((a, r) => a + r.run.achievedWeek, 0);
  const filtered = {
    classCount: rows.length,
    studentCount: students,
    achievedToday: aToday,
    achievedWeek: aWeek,
    dailyRate: pct(aToday, students),
    weeklyRate: pct(aWeek, students),
  };
  return { rows, filtered, tags, view: view || 'overview', quick: def ? quick : '' };
}

/**
 * 生成「可复制到微信/钉钉」的纯文本（用户 2026-10-29「可以复制到文本如未达标班级等」
 * + 2026-10-30「复制时复制的是筛选后的相应内容」）。
 *
 * 为什么在服务端生成：小程序管理端、Web 控制台、将来的导出都用同一段话。
 * 前端各拼一次必然漂移（「未达标」/「不达标」/「未完成」三种写法同时出现，
 * 老师会以为是不同含义），而且文案里的数字必须与列表逐字一致。
 *
 * 两条口径：
 *  · 无筛选 → 完整报告（全校汇总 + 今日未达标 + 本周未达标 + 考勤待补）；
 *  · 有筛选 → **只列筛选后的行**，并在标题写明筛选条件与班数。
 *    标题必须写：否则粘出 5 个班却顶着「全校 43 个班」，群里的人会把
 *    「没列出来」理解成「那些班没问题」—— 这是筛选型报告最容易造成的误读。
 */
function buildCopyText({ day, from, weekStart, totals, filtered, tags, rows, quick }) {
  const scoped = Array.isArray(tags) && tags.length > 0;
  const lines = [];
  const head = scoped ? `【班级状态 ${day}｜${tags.join(' · ')}】` : `【班级状态 ${day}】`;
  lines.push(head);

  if (scoped) {
    const st = filtered || {};
    lines.push(
      `筛选出 ${st.classCount ?? rows.length} 个班 / ${st.studentCount ?? 0} 人；` +
        `今日达标 ${st.achievedToday ?? 0} 人（${st.dailyRate === null || st.dailyRate === undefined ? '—' : st.dailyRate + '%'}），` +
        `本周达标 ${st.achievedWeek ?? 0} 人（${st.weeklyRate === null || st.weeklyRate === undefined ? '—' : st.weeklyRate + '%'}）`
    );
    lines.push(`（全校合计 ${totals.classCount} 个班 / ${totals.studentCount} 人，今日 ${totals.dailyRate ?? '—'}%）`);
  } else {
    lines.push(
      `全校 ${totals.classCount} 个班 / ${totals.studentCount} 人；` +
        `今日校园跑达标 ${totals.achievedToday} 人（${totals.dailyRate === null ? '—' : totals.dailyRate + '%'}），` +
        `本周达标 ${totals.achievedWeek} 人（${totals.weeklyRate === null ? '—' : totals.weeklyRate + '%'}）`
    );
    if (totals.skippedClasses) lines.push(`（实习/毕业班 ${totals.skippedClasses} 个不参与统计，已排除）`);
  }

  lines.push('');
  const list = rows || [];
  if (!list.length) {
    lines.push(scoped ? '当前筛选条件下没有班级' : '未达标班级（今日）：无，全部达标');
    return lines.join('\n');
  }

  // 筛选态只列一份清单（就是筛出来的这些）；未筛选才分三段列
  const title = scoped
    ? `${tags[tags.length - 1] || '筛选结果'}（共 ${list.length} 个班）：`
    : `未达标班级（今日，共 ${list.filter(QUICK_FILTERS.notDaily.test).length} 个）：`;
  lines.push(title);
  const src = scoped ? list : list.filter(QUICK_FILTERS.notDaily.test);
  for (const r of src) {
    lines.push(
      `· ${r.className}：今日 ${r.run.achievedToday}/${r.studentCount} 人（${r.run.dailyRate ?? '—'}%）` +
        `，本周 ${r.run.achievedWeek}/${r.studentCount} 人（${r.run.weeklyRate ?? '—'}%）` +
        (r.departmentName ? `｜${r.departmentName}` : '')
    );
  }
  if (scoped) return lines.join('\n');

  const notWeek = list.filter(QUICK_FILTERS.notWeek.test);
  lines.push('');
  if (notWeek.length) {
    lines.push(`未达标班级（本周 ${weekStart} 起，共 ${notWeek.length} 个）：`);
    for (const r of notWeek) {
      lines.push(`· ${r.className}：达标 ${r.run.achievedWeek}/${r.studentCount} 人（${r.run.weeklyRate}%）`);
    }
  } else {
    lines.push(`未达标班级（本周 ${weekStart} 起）：无，全部达标`);
  }

  const attMissing = list.filter(QUICK_FILTERS.attMissing.test);
  if (attMissing.length) {
    lines.push('');
    lines.push(`考勤待补班级（${from} 至今无任何考勤记录，共 ${attMissing.length} 个）：`);
    for (const r of attMissing) lines.push(`· ${r.className}`);
  }
  void quick;
  return lines.join('\n');
}

/** 仅供测试/排障：清缓存 */
function clearCache() {
  boardCache.clear();
}

module.exports = {
  classStatusBoard,
  applyBoardFilter,
  QUICK_FILTERS,
  buildCopyText,
  MODULES,
  clearCache,
  CACHE_TTL,
};
