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
 * ===== 考勤分数（用户 2026-11-12「考勤是100%应该显示分数，并且不要满分100分制了，就10分制」）=====
 * 考勤列以前只显示加权出勤率（96.7%），老师要自己心算「这相当于几分」；现在直接给分数：
 *   考勤分 = 满分(10) × 加权出勤率 − 早八迟到人数 × 单价
 * 两条必须一起守住的口径：
 *   ① 单价取 services/check-modules.js::PERSON_DEDUCT.late —— 与早八模块扣分**同一个常量**。
 *      这里另写一份（哪怕只差 0.05）就会出现「看板 9.9 分、班超 9.95 分」，
 *      而这页的分数是要被复制发进工作群的。
 *   ② 展示保留**两位小数**（scoreScale.scoreText）：10 分制下迟到 1 人只扣 0.05，
 *      一位小数会把 9.95 显示成 10.0，看着就是「扣了个寂寞」。
 * ratePercent 仍然下发（档位筛选、其它页面、口径对照都要用），只是考勤列不再显示它。
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
const roster = require('./roster');
const checkModules = require('./check-modules');
const scoreScale = require('./score-scale');

// 行的年级口径（用户 2026-11-03 多选年级筛选）：ClassProfile.grade 大量为空
// （只有导入/手填才有值），按班级名「23级大数据技术」解析兜底 ——
// 与 routes/admin/class-profile.js::gradeOf 同一口径，别在这里再写一份解析。
const gradeOf = (p) => roster.normalizeGrade(p.grade) || roster.gradeFromClassName(p.className);

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
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (num, den) => (den > 0 ? round1((num / den) * 100) : null);

/**
 * 考勤分数（10 分制）：加权出勤率折算 + 早八迟到按人扣。
 *
 * 为什么早八要单独扣而不是并进率：早八模块**没有应到/实到**（只记迟到人，见
 * check-modules 的 morning_class 定义），拿不出分母，所以它不参与加权率；
 * 但它的迟到确实要扣分 —— 否则「迟到 10 人的班」和「一个人都没迟到」同分。
 *
 * ⚠️ 第三个参数 hasData 是**必需的**，不能靠「率与迟到都为空」推断：
 *   只有一个早八记录、且没人迟到的班，率没有、迟到 0 —— 若据此返回 null 就显示「—」，
 *   而同班若有 3 人迟到却显示 9.85，于是出现「迟到的有分、没迟到的反而没分」，
 *   老师只会认为统计坏了。有数据就给分（满分 10 − 0 = 10.00），没数据才是「—」。
 *
 * @param {number|null} rateWeighted 有应到模块的加权出勤率（0~1.5，可能 >1 的插班）
 * @param {number} lateTotal 区间内早八迟到总人数
 * @param {boolean} hasData 该班在区间内是否有任何考勤记录
 * @returns {number|null} 分数（两位小数）；完全没有考勤数据时 null（前端显示「—」）
 */
function attendanceScore(rateWeighted, lateTotal, hasData) {
  if (!hasData) return null;
  const late = Number(lateTotal) || 0;
  const hasRate = rateWeighted !== null && rateWeighted !== undefined;
  // 率封顶满分：出勤率 >1（插班导致实到 > 应到）不该白送超额分，与 computeDeduct 同一护栏
  const base = hasRate ? Math.min(1, Math.max(0, rateWeighted)) * scoreScale.FULL_SCORE : scoreScale.FULL_SCORE;
  return round2(Math.max(0, base - late * checkModules.PERSON_DEDUCT.late));
}

/**
 * 全校班级状态总览。
 * @param {object} [opts]
 * @param {string} [opts.today] 覆盖「今天」（便于测试与补算）
 * @param {number} [opts.days] 考勤回看天数（默认 7，上限 92）
 * @param {boolean} [opts.force] 忽略缓存
 */
async function classStatusBoard({ today, days, force } = {}) {
  // today 覆盖「今天」（2026-11-03 前端日期选择接入）：非法/缺省一律回退服务器今天，
  // 不能让拼错的参数悄悄统计出一个空日期（与 quick 非法值=全量同一防呆口径）。
  const day = dates.isValidDateKey(today) ? today : dates.todayKey();
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
  //
  // ⚠️ 应到/实到数字存在 **details** 里（写入点 routes/union.js：fillDerived 把
  //   shouldCount/actualCount/shouldStay 等派生数字填进 details，metrics 只装
  //   ratios/values 两层 —— 用户 2026-11-03 报「考勤一直是 —」的根因就是这里从
  //   metrics 层取 shouldCount：应到恒 0 → ratePercent 恒 null。比率 metrics.ratios.rate
  //   与迟到 details.lateCount 两处路径本来就是对的。
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
            { $ifNull: ['$details.shouldStay', 0] },
            { $ifNull: ['$details.shouldCount', 0] },
          ],
        },
        actual: { $ifNull: ['$details.actualCount', 0] },
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
    // 早八迟到人数（分数里要扣的那一项）：只取早八模块，别的模块的 lateCount 不参与，
    // 否则将来某个模块也写 lateCount 就会重复扣分。
    const lateTotal = (att.morning_class && att.morning_class.late) || 0;
    // hasData 必须在分数之前定：它同时决定「考勤列显示分数还是 —」与「考勤统计 N 天那行出不出现」
    const attHasData = shouldSum > 0 || !!att.morning_class;
    const attScore = attendanceScore(shouldSum > 0 ? rateWSum / shouldSum : null, lateTotal, attHasData);

    return {
      className: p.className,
      schoolName: p.schoolName || '',
      departmentName: p.departmentName || '',
      grade: gradeOf(p),
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
        // 考勤分数（10 分制，用户 2026-11-12）+ 早八迟到人数（分数里扣了什么，要能看见）
        score: attScore,
        lateCount: lateTotal,
        // hasData 与分数同一个判定（attHasData）：两处分别写就会漂移成
        // 「考勤统计那行出现了，但分数列是 —」
        hasData: attHasData,
      },
      flags: {
        hasMorningExercise: p.hasMorningExercise !== false,
        hasMorningClass: p.hasMorningClass !== false,
        hasNightStudy: p.hasNightStudy !== false,
        hasMorningRun: p.hasMorningRun !== false,
      },
    };
  });

  // ---- 6) 排序：年级升序 → 班级名（用户 2026-11-03「排序根据年级与名称进行排序」）----
  // 替换旧的「未达标优先」桶排序：要看缺口用档位筛选（今日未达标/零达标）即可，
  // 列表本身按 年级→班级 的稳定顺序，方便对照纸质名单逐班核对、也方便生成转发图片。
  // 解析不出年级的班排在末尾（按班名），不能因为一个脏班名把整表顺序打乱。
  rows.sort((a, b) => {
    const ga = a.grade || '9999';
    const gb = b.grade || '9999';
    if (ga !== gb) return ga < gb ? -1 : 1;
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
    // 院校候选（用户 2026-10-30「没有院系筛选」）：与系部成对，因为两个校区都有「计财系」，
    // 只给系部会把两校混筛。取自实际有数据的行，不查组织架构。
    schools: [...new Set(rows.map((r) => r.schoolName).filter(Boolean))].sort((a, b) =>
      String(a).localeCompare(String(b), 'zh-CN')
    ),
    // 年级候选（用户 2026-11-03 多选年级筛选）：升序，前端画多选 chips；
    // 值来自 rows.grade（grade 字段 + 班名解析兜底），不查组织架构 —— 同 schools 的理由。
    grades: [...new Set(rows.map((r) => r.grade).filter(Boolean))].sort(),
    notAchieved: {
      daily: notAchievedDaily.map(brief),
      weekly: notAchievedWeekly.map(brief),
      attendanceMissing: attendanceMissing.map(brief),
    },
    // 未筛选态的完整报告（有筛选时由 applyBoardFilter 重新生成对应文案）
    copyText: buildCopyText({ day, from, weekStart, totals, filtered: null, tags: [], rows, copy: 'all' }),
  };
}

/**
 * 按查询参数筛选（用户 2026-10-30「支持筛选，复制时复制的是筛选后的相应内容」）。
 *
 * 缓存的是**全量聚合结果**，筛选只在内存里做 —— 切换筛选不必重算 Mongo 聚合（那要 3 秒），
 * 而且保证「同一批数据」：不会出现两次请求之间数据变了、筛选前后对不上。
 *
 * 返回里 copyText 是**按当前筛选 + 复制口径**重新生成的，
 * 所以前端复制到的永远是看到的那些行、且只含要的那个指标。
 *
 * @param {object} board 全量聚合结果
 * @param {object} p
 * @param {string} [p.school]     院校（与 department 成对，消歧同名系部）
 * @param {string} [p.department] 系部
 * @param {string[]} [p.grades]   年级（多选，'2023' 形式的年份字符串）
 * @param {string} [p.quick]      快捷筛选键（QUICK_FILTERS）
 * @param {string} [p.level]      达标档位（LEVELS，与 metric 组合）
 * @param {string} [p.metric]     档位针对的指标 daily|weekly
 * @param {string} [p.keyword]    班名/系部/院校 关键词
 * @param {string} [p.copy]       复制口径 all|daily|weekly（文案强调哪个指标）
 */
function applyBoardFilter(board, { school, department, grades, quick, level, metric, keyword, copy } = {}) {
  const { rows, filtered, tags } = filterBoard(board, { school, department, grades, quick, level, metric, keyword });
  const copyScope = ['daily', 'weekly'].includes(copy) ? copy : 'all';
  if (!tags.length) {
    return {
      ...board,
      filtered: board.totals,
      activeFilters: [],
      // 无筛选但复制口径收窄时，文案仍要按复制口径重生成（用户「只需要日达标这种的」）
      copyText:
        copyScope === 'all'
          ? board.copyText
          : buildCopyText({
              day: board.today,
              from: board.from,
              weekStart: board.weekStart,
              totals: board.totals,
              filtered: null,
              tags: [],
              rows: board.rows,
              copy: copyScope,
            }),
      copyScope,
    };
  }
  return {
    ...board,
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
      copy: copyScope,
    }),
    copyScope,
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
    // 考勤分数（10 分制）：复制文案与外部对照都用它，别再让读的人自己从百分数换算
    attendanceScore: r.attendance.score,
    lateCount: r.attendance.lateCount,
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

/**
 * 达标档位（用户 2026-10-30「如只需要日达标这种的」）。
 *
 * 为什么把「未达标」拆成档位：实测今日全校达标率只有 5.3%（下午四点，
 * 学生还没怎么同步），43 个班**全部** <100% —— 「今日未达标」筛出来还是 43 个班，
 * 等于没筛（用户截图里正是这个现象）。给三档才能真的把该催的那批挑出来。
 */
const LEVELS = {
  notFull: { label: '未达标', test: (rate) => rate !== null && rate !== undefined && rate < 100 },
  // 「低于95%」（用户 2026-11-03 换掉「低于一半」）：催办口径从「差得离谱」收紧到
  // 「没到 95%」，覆盖「大部分跑了但还差几个」的常见催办场景；零达标仍是它的子集。
  below95: { label: '低于95%', test: (rate) => rate !== null && rate !== undefined && rate < 95 },
  zero: { label: '零达标', test: (rate) => rate === 0 },
};

/** 指标维度：日 / 周（决定筛哪一列，也决定筛选标签怎么措辞） */
const METRICS = {
  daily: { label: '日达标', rate: (r) => r.run.dailyRate },
  weekly: { label: '周达标', rate: (r) => r.run.weeklyRate },
};

/**
 * 对全量聚合结果做筛选 + 重算小计（缓存的是全量，筛选在内存里做，切筛选不重算 Mongo）。
 *
 * 院校与系部**必须成对使用**：实测两个校区都有「计财系」，
 * 只按系部名筛会把北校区和洋河校区的计财系混在一起 —— 看着能筛，筛出来是错的。
 * 所以：给了 school 就校内筛系部；只给 department 时按同名全筛，
 * 并在标签上写明「各校区同名」，让结果自己说明口径。
 */
function filterBoard(board, { school, department, grades, quick, level, metric, keyword } = {}) {
  const q = String(keyword || '').trim();
  const tags = [];
  let rows = board.rows;

  if (school) {
    rows = rows.filter((r) => (r.schoolName || '') === String(school));
    tags.push(String(school));
  }
  if (department) {
    rows = rows.filter(
      (r) => (r.departmentName || '') === String(department) && (!school || (r.schoolName || '') === String(school))
    );
    tags.push(school ? String(department) : `${department}（各校区同名）`);
  }
  // 多选年级（用户 2026-11-03）：与院校/系部同在服务端筛 —— 文案标题用的 tags
  // 与行集合必须同源，前端自筛必然漂移。多个年级按选中的拼「2023+2024级」。
  if (Array.isArray(grades) && grades.length) {
    const set = new Set(grades.map(String));
    rows = rows.filter((r) => set.has(r.grade));
    tags.push(`${grades.slice().sort().join('+')}级`);
  }
  const def = QUICK_FILTERS[quick];
  if (def) {
    rows = rows.filter(def.test);
    tags.push(def.label);
  } else if (LEVELS[level]) {
    const m = METRICS[metric] || METRICS.daily;
    // enabled/空班排除与 QUICK_FILTERS 同一口径：不参跑的班不该出现在任何催办筛选里
    rows = rows.filter((r) => r.run.enabled && r.studentCount > 0 && LEVELS[level].test(m.rate(r)));
    tags.push(`${m.label}${LEVELS[level].label}`);
  }
  if (q) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    rows = rows.filter(
      (r) => re.test(r.className) || re.test(r.departmentName || '') || re.test(r.schoolName || '')
    );
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
  return { rows, filtered, tags, metric: METRICS[metric] ? metric : 'daily', level: LEVELS[level] ? level : '' };
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
 *
 * 复制口径 copy（用户 2026-10-30「可以查看显示内容与复制内容，如只需要日达标这种的」）：
 *  · all    → 每行同时写今日与本周（默认）；
 *  · daily  → 只写今日达标，标题标注「日达标」；
 *  · weekly → 只写本周达标，标题标注「周达标」。
 *  与「显示内容」是两回事：可以列表看着三列、复制时只要日达标那份名单，
 *  所以它是独立参数，不由列显隐推导。
 */
function buildCopyText({ day, from, weekStart, totals, filtered, tags, rows, copy }) {
  const scoped = Array.isArray(tags) && tags.length > 0;
  const scope = copy === 'daily' || copy === 'weekly' ? copy : 'all';
  const scopeLabel = { daily: '日达标', weekly: '周达标' }[scope];
  const lines = [];
  const marks = [scopeLabel, ...(scoped ? tags : [])].filter(Boolean);
  const head = marks.length ? `【班级状态 ${day}｜${marks.join(' · ')}】` : `【班级状态 ${day}】`;
  lines.push(head);

  // 汇总行：按复制口径只写要的那个指标（复制「只要日达标」却附一句本周，是噪音）
  const st = scoped ? filtered || {} : totals;
  const rateOf = (v) => (v === null || v === undefined ? '—' : `${v}%`);
  const seg = [];
  if (scope !== 'weekly') seg.push(`今日达标 ${st.achievedToday || 0} 人（${rateOf(st.dailyRate)}）`);
  if (scope !== 'daily') seg.push(`本周达标 ${st.achievedWeek || 0} 人（${rateOf(st.weeklyRate)}）`);
  if (scoped) {
    lines.push(`筛选出 ${st.classCount ?? (rows || []).length} 个班 / ${st.studentCount ?? 0} 人；${seg.join('，')}`);
    lines.push(`（全校合计 ${totals.classCount} 个班 / ${totals.studentCount} 人）`);
  } else {
    lines.push(`全校 ${totals.classCount} 个班 / ${totals.studentCount} 人；${seg.join('，')}`);
    if (totals.skippedClasses) lines.push(`（实习/毕业班 ${totals.skippedClasses} 个不参与统计，已排除）`);
  }

  lines.push('');
  const list = rows || [];
  if (!list.length) {
    lines.push(scoped ? '当前筛选条件下没有班级' : `未达标班级（${scopeLabel || '今日'}）：无，全部达标`);
    return lines.join('\n');
  }

  // 逐行：按复制口径只写要的那个指标
  // 考勤分数只在 copy=all 时出现（用户 2026-11-12「考勤要显示分数」）：
  // 收窄成「只要日达标」时附考勤就是噪音 —— 与上面「另一指标不再出现」是同一条设计。
  const rowLine = (r) => {
    const parts = [];
    if (scope !== 'weekly') parts.push(`今日 ${r.run.achievedToday}/${r.studentCount} 人（${rateOf(r.run.dailyRate)}）`);
    if (scope !== 'daily') parts.push(`本周 ${r.run.achievedWeek}/${r.studentCount} 人（${rateOf(r.run.weeklyRate)}）`);
    if (scope === 'all') {
      const att = r.attendance || {};
      if (att.score !== null && att.score !== undefined) {
        parts.push(`考勤 ${scoreScale.scoreText(att.score)} 分${att.lateCount ? `（迟到 ${att.lateCount} 人）` : ''}`);
      }
    }
    return `· ${r.className}：${parts.join('，')}${r.departmentName ? `｜${r.departmentName}` : ''}`;
  };

  if (scoped) {
    // 筛选态只列一份清单（就是筛出来的这些）
    lines.push(`${tags[tags.length - 1] || '筛选结果'}（共 ${list.length} 个班）：`);
    for (const r of list) lines.push(rowLine(r));
    return lines.join('\n');
  }

  // 未筛选：按复制口径分段落列（daily/weekly 只列对应那一段）
  const notDaily = list.filter(QUICK_FILTERS.notDaily.test);
  if (scope !== 'weekly') {
    lines.push(`未达标班级（今日，共 ${notDaily.length} 个）：`);
    for (const r of notDaily) lines.push(rowLine(r));
    if (!notDaily.length) lines.push('（无，全部达标）');
  }
  if (scope !== 'daily') {
    const notWeek = list.filter(QUICK_FILTERS.notWeek.test);
    lines.push('');
    lines.push(`未达标班级（本周 ${weekStart} 起，共 ${notWeek.length} 个）：`);
    for (const r of notWeek) lines.push(rowLine(r));
    if (!notWeek.length) lines.push('（无，全部达标）');
  }

  const attendanceMissing = list.filter(QUICK_FILTERS.attMissing.test);
  if (attendanceMissing.length) {
    lines.push('');
    lines.push(`考勤待补班级（${from} 至今无任何考勤记录，共 ${attendanceMissing.length} 个）：`);
    for (const r of attendanceMissing) lines.push(`· ${r.className}`);
  }

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
  attendanceScore,
  MODULES,
  clearCache,
  CACHE_TTL,
};
