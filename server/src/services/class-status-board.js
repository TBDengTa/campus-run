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
 * ===== 分数口径（用户 2026-11-19「班级状态日周月考勤不一致，并且卫生、查宿等内容没有被减分」）=====
 * 本页的「考勤分」**就是班超分**，不是另一套算法：
 *   分数 = bandChao.scoreOfAggregate() = 10 − 各模块日均扣分（**含卫生、查宿、晚自习、早操、早八全部模块**）
 *   窗口 = bandChao.rangeOf()（本日 = 当天；本周 = ISO 周一起至周日；本月 = 1 号至月末，**完整区间**）
 *
 * 为什么必须同源：旧版这里自己写了第二套公式
 * （`10 × 加权出勤率 − 迟到×0.05`，模块只列 4 个考勤项、**完全不含卫生**），
 * 且窗口取「周一起至所选日」—— 同一个班同一周实测 **班超 8.40 / 本页 9.74**。
 * 用户正是拿两个页面互相对照发现「卫生没被减分」的；老师还会把这里的数复制发进工作群，
 * 两套口径迟早变成两份互相矛盾的通报。
 *
 * 仍保留 ratePercent（应到加权的**事实指标**，档位筛选与对照要用），但它**不参与算分**。
 * 展示一律两位小数（scoreScale.scoreText）：10 分制下迟到 1 人只扣 0.05，
 * 一位小数会把 9.95 显示成 10.0，看着就是「扣了个寂寞」。
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
// 班超的唯一实现：窗口（rangeOf）与分数组装（scoreOfAggregate / aggregateScores）都取自这里。
// ⚠️ 延迟 require（在函数体内）也可以，但 band-chao 不依赖本文件，没有循环引用风险，直接顶层引。
const bandChao = require('./band-chao');

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

// ===== 考勤统计区间（用户 2026-11-12「要本日、本周、本月，而不是3天7天这样」）=====
// 旧口径是「往前回看 N 天」（3/7/14/30），用户明确否掉：老师看的是「本周/本月考勤怎么样」，
// 不是「最近 7 天」。窗口一律**锚定所选日期**（today 参数）：
//   本日 = 所选日当天；本周 = 所选日所在 ISO 周（周一起，到所选日）；本月 = 所选日所在月（1 号起）。
// 非法值回退「本周」（与旧默认 7 天最接近，缓存也最友好）。
const ATT_RANGES = {
  day: { label: '本日' },
  week: { label: '本周' },
  month: { label: '本月' },
};
const DEFAULT_RANGE = 'week';

// ===== 考勤/班超分计算规则文案（用户 2026-11-12「要在图片下面标注考勤计算规则，如迟到缺勤等逻辑」）=====
// **服务端生成**：图片、页面脚注、复制文案三处共用同一份中文 —— 前端自己写一份必然与
// 实际算式漂移（改了单价忘了改说明，老师照着错误说明去质疑正确的分数）。
//
// ⚠️ 措辞必须与 bandChao.scoreOfAggregate()（= 本页分数的唯一来源）的真实算式逐字一致。
//   用户 2026-11-19 报「卫生、查宿等内容没有被减分」之后，分数已从
//   「4 个考勤模块的加权出勤率折算」改成「10 分 − 各模块日均扣分（**含卫生**）」，
//   所以这里的说明也必须跟着重写 —— 说明留在旧算法上，就是「改了分数没改说明」的第二次翻车。
// 各类扣分机制**不同**，句子必须分开说，不能笼统写「按出勤率」：
//   · 卫生 = 评价折算（优/良/差 → 10/8/6），扣的是「满分减得分」；
//   · 早操 / 晚自习 = 出勤率折算，每人扣多少**取决于班大小**（10 ÷ 应到人数）——
//     写成固定单价就是说谎（实测 40 人的班缺 1 人扣 0.25，99 人的班扣 0.1）；
//   · 查宿 = 按未归人数固定单价（rate 模式的分母在历史脏数据里可能是 0，走按人计扣）；
//   · 早八 = 按迟到人数固定单价。
// 数字全部从 checkModules.PERSON_DEDUCT / GRADE_SCORE / scoreScale.FULL_SCORE 取值拼句，不写死。
function buildAttRuleLines() {
  const pd = checkModules.PERSON_DEDUCT;
  const full = scoreScale.FULL_SCORE;
  const gs = checkModules.GRADE_SCORE || {};
  // 卫生各评价的扣分 = 满分 − 评价折算分（与 computeDeduct 的 percent 分支同一算式）
  const hyDeduct = (g) => round2(full - (Number(gs[g]) || 0));
  // 白话优先（用户 2026-11-13「一般人看不明白，需要你白话写出」）：
  // 不出现「加权出勤率 / 日均扣分」这类术语，也不写公式符号。
  return [
    `总分满分 ${full} 分（早操/早八/晚自习/查宿 + 卫生全部算在内）：每天从 ${full} 分起扣，统计期里各天的得分取平均。`,
    `卫生按评价扣：评良扣 ${hyDeduct('良')} 分、评差扣 ${hyDeduct('差')} 分（评优不扣）。`,
    '早操、晚自习按出勤情况扣：应到多少人、实际到了多少人，缺勤的人越多扣得越多；' +
      '同样缺 1 个人，小班扣得多、大班扣得少（按人数比例折到 ' +
      full + ' 分上）。',
    `查宿按未归人数扣：每 1 人未归扣 ${pd.notReturned} 分（未归 2 人扣 ${round2(pd.notReturned * 2)} 分）。`,
    `早八只登记迟到的人：每迟到 1 人扣 ${pd.late} 分（迟到 2 人扣 ${round2(pd.late * 2)} 分）。`,
    '班里没排某一项（比如没有晚自习）不另外扣分，只按实际有的项目算。',
    '整个统计期一次检查都没录的班显示「—」，不是 0 分。',
  ];
}

// 缓存 60 秒：见文件头「性能口径」。key 里带 today/from/周起点/**考勤窗口**，跨天自动失效。
//   窗口必须在 key 里：少了这一维，切「本日/本周/本月」会命中上一个窗口的结果
//   （数字看着正常但区间是错的，正是这页最要命的静默 bug）。
const CACHE_TTL = 60 * 1000;
const boardCache = new Map();

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (num, den) => (den > 0 ? round1((num / den) * 100) : null);

// （已删除）attendanceScore(rateWeighted, lateTotal, hasData)
//   用户 2026-11-19「班级状态日周月考勤不一致，并且卫生、查宿等相关内容没有被减分」：
//   这个函数是本页**自己的一套考勤分公式**（加权出勤率折算 + 早八迟到单价），
//   与班超总评（10 − 日均扣分，含卫生）是两套算法 —— 同一个班同一周实测 9.74 vs 8.40。
//   现在分数一律走 bandChao.scoreOfAggregate（与班超同一个函数），本文件不再保留第二套公式。
//   ⚠️ 不要因为「页面要显示出勤率」把它加回来：ratePercent 仍下发，但它只是事实指标，
//      **不是**分数来源。回归断言见 tools/check-server-contract.js 的分数同源一节。

/**
 * 考勤统计窗口：把「本日 / 本周 / 本月」翻译成起止日历键。
 *
 * ⚠️ **一律复用 band-chao.rangeOf**（用户 2026-11-19「班级状态日周月考勤不一致」的根因之二）：
 *   旧实现在这里自己写了一套窗口 —— 本周 = 「ISO 周一起**至所选日**」、本月 = 「1 号起**至所选日**」，
 *   而班超那侧的本周/本月是**完整区间**（band-chao 的「周要完整的日期，不要跟随月截断」）。
 *   同一个「本周」标签在两个页面圈的是不同日期，老师对照着看自然觉得「数字对不上」。
 *   现在窗口只有一份实现（band-chao.rangeOf）：本日 = 当天、本周 = ISO 周一至周日、本月 = 1 号至月末。
 *
 * 一律**锚定所选日期**（不是「今天」）：回看历史某天时，取的是那一天所属的本日 / 本周 / 本月。
 * ⚠️ 周起点仍用 ISO 周一（dates.weekRange，由 rangeOf 内部走），**不用** band-chao 的
 *   「当月第 N 周」（weekNo 参数不传）：那是排名页的月锚定周，两套周混用会出现
 *   「考勤说本周、跑分说本周却是不同区间」。
 *
 * @param {string} rangeKey day | week | month（非法值回退 DEFAULT_RANGE）
 * @param {string} day 锚定的日历键
 * @returns {{from: string, to: string, range: string, rangeLabel: string}}
 */
function attWindow(rangeKey, day) {
  const range = ATT_RANGES[rangeKey] ? rangeKey : DEFAULT_RANGE;
  // rangeOf 的第 3/4/5 参（weekStartKey / monthKey / weekNo）一律不给：
  // 让它按所选日期取 ISO 周 / 所属月的**完整区间**，与班超排名同一份实现。
  const r = bandChao.rangeOf(range, day);
  return { from: r.from, to: r.to, range, rangeLabel: ATT_RANGES[range].label };
}

/**
 * 全校班级状态总览。
 * @param {object} [opts]
 * @param {string} [opts.today] 覆盖「今天」（便于测试与补算）
 * @param {string} [opts.attRange] 考勤统计窗口 day|week|month（默认 week；用户 2026-11-12 要求本日/本周/本月）
 * @param {number} [opts.days] **已废弃**：旧「往前 N 天」口径，传了也按 attRange 走
 * @param {boolean} [opts.force] 忽略缓存
 */
async function classStatusBoard({ today, attRange, days, force } = {}) {
  // today 覆盖「今天」（2026-11-03 前端日期选择接入）：非法/缺省一律回退服务器今天，
  // 不能让拼错的参数悄悄统计出一个空日期（与 quick 非法值=全量同一防呆口径）。
  const day = dates.isValidDateKey(today) ? today : dates.todayKey();
  // 考勤窗口：本日/本周/本月（用户 2026-11-12）。刻意**不**兼容旧的 days 参数语义 ——
  // 老客户端传 days=7 时这里按 attRange 缺省（本周）走，而不是假装还支持「回看 7 天」：
  // 两套窗口并存迟早出现「脚注说本周、数据是回看 7 天」，那比统一成本周更难解释。
  const win = attWindow(attRange, day);
  const { from, to: attTo, range: attRangeKey, rangeLabel: attRangeLabel } = win;
  const { startKey: weekStart } = dates.weekRange(day);

  // ⚠️ 缓存 key 必须含**起止两个日期**：旧 key 只有 from 没有 to，
  //   而窗口改成「完整周/完整月」后 to 也随所选日期变（周一那天与周三那天的本周区间不同）；
  //   漏了 to 会让两个不同区间共用一份缓存 = 数字看着正常但区间是错的（静默 bug）。
  const cacheKey = `${day}|${from}|${attTo}|${weekStart}|${attRangeKey}`;
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
    const empty = buildResult({ day, from, to: attTo, weekStart, attRangeKey, attRangeLabel, totals: emptyTotals(skipped), rows: [], attBy: new Map() });
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
        // ⚠️ 区间终点必须是**窗口终点 attTo**，不是所选日 day（用户 2026-11-19「班级状态
        //   日周月考勤不一致」的直接成因）：窗口已是完整周/完整月，
        //   而这里仍写 `$lte: day` → 「本周」实际只统计到周三，
        //   与班超同标签的整周区间必然对不上。
        date: { $gte: from, $lte: attTo },
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

  // ---- 4b) 班超扣分聚合（**含卫生**，与班超总评同一份实现）----
  // ⚠️ 这是用户 2026-11-19「卫生、查宿等相关内容相应没有被减分」的修复点：
  //   旧版考勤分只按「4 个考勤模块的出勤率 + 早八迟到」自己算一套，
  //   卫生（扣分最大的那一项，实测某班一周扣 4.00 分）完全不在公式里，
  //   于是「班超 8.40 分、本页 9.74 分」这种两个页面对不上的情况必然出现。
  //   现在分数一律走 bandChao.scoreOfAggregate（班超页用的是同一个函数）。
  //
  // 两次轻量聚合并行下发：
  //   · aggregateScoresLite  —— className × date × moduleKey（分数的主聚合，保持最轻）
  //   · aggregateTargetsLite —— className × moduleKey × targetType（扣分来源子项）
  //     刻意**不**把 targetType 塞进主聚合的 $group：那会让分组行数翻几倍，
  //     而看板每 60 秒被多个老师反复刷新。两聚合共用 liteMatch，口径逐字一致。
  const [deductBy, targetBy] = await Promise.all([
    bandChao.aggregateScoresLite({ from, to: attTo, classNames: activeNames }),
    bandChao.aggregateTargetsLite({ from, to: attTo, classNames: activeNames }),
  ]);
  // 模块名（给「卫生 -4.00」这类扣分明细用）：listModules 自带 30 秒缓存
  const allModules = await checkModules.listModules();
  const moduleNameBy = new Map(allModules.map((m) => [m.key, m.shortName || m.name]));

  // ---- 5) 组装 43 行（这一步纯内存，无任何 await）----
  const rows = activeProfiles.map((p) => {
    const run = runBy.get(p.className) || { studentCount: 0, achievedToday: 0, achievedWeek: 0, stepsToday: 0 };
    const att = attBy.get(p.className) || {};

    const modules = {};
    // 该班的班超扣分聚合（含卫生）：scoreOfAggregate 与班超页同一个函数。
    // 「扣分来源」挂到聚合结构 cls.byTarget 上（scoreOfAggregate 读它产出 moduleDeduct[k].targets）；
    // 挂的是本次请求内的一次性对象，不会污染 boardCache（缓存的是组装后的最终结果）。
    const deductCls = deductBy.get(p.className);
    if (deductCls && targetBy.has(p.className)) deductCls.byTarget = targetBy.get(p.className);
    const agg = bandChao.scoreOfAggregate(deductCls);
    const modDeduct = agg.moduleDeduct || {};
    for (const mDef of MODULES) {
      const m = att[mDef.key];
      if (!m) continue;
      const dd = modDeduct[mDef.key];
      if (mDef.key === 'morning_class') {
        // 早八只记迟到人（无应到/实到，见 check-modules 模块定义），不产生比率
        modules[mDef.key] = { key: mDef.key, name: mDef.name, rate: null, ratePercent: null, late: m.late, records: m.records, deduct: dd ? dd.avgDeduct : 0 };
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
        // 该模块在窗口内的**日均**扣分（与分数同一个分母）：让「查宿扣了几分」在这一页也看得见
        deduct: dd ? dd.avgDeduct : 0,
      };
    }

    // 综合出勤率：有应到人数的模块按应到加权合并（早八不参与）。
    // ⚠️ 这个率仍要下发（ratePercent）——它是「实到/应到」的事实指标，页面副信息与口径对照要用；
    //    但**不再用它算分数**（分数唯一来源见下）。
    let shouldSum = 0;
    let rateWSum = 0;
    for (const mDef of MODULES) {
      const m = att[mDef.key];
      if (!m || mDef.key === 'morning_class') continue;
      shouldSum += m.should;
      rateWSum += m.rateW;
    }
    const attRate = shouldSum > 0 ? round1((rateWSum / shouldSum) * 100) : null;
    // 早八迟到人数（分数里扣了什么，要能看见）：只取早八模块，别的模块的 lateCount 不参与。
    const lateTotal = (att.morning_class && att.morning_class.late) || 0;
    // hasData = 窗口内有**考勤类**记录（4 模块）：「考勤待补」筛选的语义保持原样。
    const attHasData = shouldSum > 0 || !!att.morning_class;
    // hasAnyCheck = 窗口内有**任意检查**记录（含卫生）：考勤列显不显示「—」看它。
    // ⚠️ 只拿考勤类记录判断会让「本周只录了卫生」的班显示「—」，
    //   而它的班超分明明是 8.40 —— 用户报「卫生没有被减分」的另一半观感来源。
    const hasAnyCheck = agg.dayCount > 0;
    // 分数 = 班超区间分（**含卫生、查宿等全部模块扣分**，用户 2026-11-19 的核心修复）。
    // 无记录 → null（显「—」），不是 0 分。
    const attScore = agg.score;
    // 扣分明细（按扣分降序，含卫生）：「卫生 -10.00 · 晚自习 -1.53」这种，
    // 让老师看得见**分数是被谁扣掉的**，而不是只有一个孤零零的总分。
    // ⚠️ 用的是**日均扣分 avgDeduct**（与分数同一个分母），不是窗口累计 ——
    //   各模块日均扣分之和 ≈ 10 − 分数，老师能当场把账算平；
    //   写成窗口累计就会出现「10 − 10.00 ≠ 8.45」这种自相矛盾（本轮实测差点踩进去）。
    // 新增 targets（用户 2026-11-20「扣分要能写成『卫生-宿舍 -0.20 · 晚自习 -0.12』」）：
    //   直接搬 scoreOfAggregate 产出的子项（模块 × 受检类型），**不在这里重算**；
    //   Σ targets.avgDeduct / Σ targets.totalDeduct 已由 band-chao 分别调平为严格等于本项的
    //   deduct / totalDeduct，前端切「日均 / 合计」两套口径怎么加都对得上。
    //   没有 targets 时给**空数组**而不是 undefined —— 前端/导出对 undefined 调 .map 会直接报错。
    //
    // 第三轮（用户 2026-11-20「合计或日均」）：每项同时下发窗口合计 totalDeduct。
    // 只给日均时用户无法回答「这 1.6 分是一周扣的还是平均每天扣的」，而这正是本次要补的次级筛选。
    const deductDetail = Object.keys(modDeduct)
      .filter((k) => modDeduct[k].avgDeduct > 0 || modDeduct[k].deduct > 0)
      .map((k) => ({
        key: k,
        name: moduleNameBy.get(k) || k,
        deduct: modDeduct[k].avgDeduct,
        totalDeduct: modDeduct[k].deduct,
        targets: modDeduct[k].targets || [],
      }))
      .sort((a, b) => b.deduct - a.deduct || String(a.key).localeCompare(String(b.key)));

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
        // 当日人均步数（用户 2026-11-20 导出 CSV 的「当日人均步数」列）：
        // 只做「今日步数 ÷ 学生数」，不另算「有效步数 / 达标」口径 —— 那就是第二套算法了。
        // 空班（studentCount=0）给 0，避免导出出现 NaN / Infinity。
        avgSteps: run.studentCount ? Math.round((run.stepsToday || 0) / run.studentCount) : 0,
      },
      attendance: {
        modules,
        ratePercent: attRate,
        // 班超分（10 分制，与班超总评逐字同源）+ 扣分明细（含卫生/查宿）+ 早八迟到人数
        score: attScore,
        deduct: agg.deduct,
        // 窗口合计扣分与有记录天数：前端「日均 / 合计」切换直接用这两个数换算展示，
        // **不在前端重算**（合计 ÷ 天数再 round 会与后端口径差 0.01，老师当场就能算出来）。
        deductTotal: agg.deductTotal,
        dayCount: agg.dayCount,
        deductDetail,
        lateCount: lateTotal,
        // hasData 与「考勤待补」同一个判定；hasAnyCheck 决定考勤列显示
        hasData: attHasData,
        hasAnyCheck,
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

  const result = buildResult({ day, from, to: attTo, weekStart, attRangeKey, attRangeLabel, totals: null, rows, attBy, skipped });
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
function buildResult({ day, from, to, weekStart, attRangeKey, attRangeLabel, rows, skipped }) {
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
    // 考勤窗口终点（完整周/完整月）**必须单独下发**：
    // 旧版没有这一项，前端与复制文案都拿「所选日」当区间终点 ——
    // 窗口改成完整周/月后那句话说的是错的（写着「11月16日~11月19日」，数据其实统计到 22 日）。
    to,
    weekStart,
    // 全量行里是否有任意检查记录（**筛选前**口径，用户 2026-11-20 第三轮）：
    // 前端原来用「筛选后的 rows」现算，于是任何把有记录的班筛掉的筛选都会导致
    // 「班超分列被强制关掉、班超分范围行消失」——用户报「选了班超分却没有考勤范围」的真因。
    // 这是「系统能力」而不是「当前结果」：筛选只该影响列出的行，不该改变可用控件。
    hasAnyCheck: rows.some((r) => r.attendance && r.attendance.hasAnyCheck),
    // 考勤窗口（用户 2026-11-12 本日/本周/本月）：range 是 key、rangeLabel 是中文，
    // 前端标题与图片都直接用 rangeLabel，不许自己按 from~to 反推「这是几天」。
    attRange: attRangeKey,
    attRangeLabel,
    // 考勤计算规则（用户 2026-11-12「要在图片下面标注考勤计算规则，如迟到缺勤等逻辑」）：
    // 服务端一份定义，页面脚注 / 生成图片 / 复制文案三处共用。
    attRuleLines: buildAttRuleLines(),
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
    copyText: buildCopyText({ day, from, to, weekStart, totals, filtered: null, tags: [], rows, copy: 'all', attRangeLabel }),
  };
}

/**
 * 按查询参数筛选（用户 2026-10-30「支持筛选，复制时复制的是筛选后的相应内容」）。
 *
 * 缓存的是**全量聚合结果**，筛选只在内存里做 —— 切换筛选不必重算 Mongo 聚合（那要 3 秒），
 * 而且保证「同一批数据」：不会出现两次请求之间数据变了、筛选前后对不上。
 *
 * 返回里 copyText 是**按当前筛选 + 复制口径 + 班超分是否显示**重新生成的，
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
 * @param {string} [p.copy]       复制口径 all|daily|weekly|att（由前端按显示列派生）
 * @param {boolean} [p.att]       页面是否显示班超分列（决定复制正文是否含班超分/考勤待补/规则）
 */
function applyBoardFilter(board, { school, department, grades, quick, level, metric, keyword, copy, att } = {}) {
  const { rows, filtered, tags } = filterBoard(board, { school, department, grades, quick, level, metric, keyword });
  const copyScope = ['daily', 'weekly', 'att'].includes(copy) ? copy : 'all';
  // 缺省 true：老客户端/Web 控制台不传 att 时保持「含班超分」的原行为（向后兼容）
  const withAtt = att === undefined ? true : !!att;
  const rebuild = (p) =>
    buildCopyText({
      day: board.today,
      from: board.from,
      to: board.to,
      weekStart: board.weekStart,
      totals: board.totals,
      filtered: p.filtered,
      tags: p.tags,
      rows: p.rows,
      copy: copyScope,
      attRangeLabel: board.attRangeLabel,
      withAtt,
    });
  if (!tags.length) {
    return {
      ...board,
      filtered: board.totals,
      activeFilters: [],
      // 无筛选时**只有**「口径 all + 含班超分」才能复用缓存里的 copyText；
      // 收窄口径（daily/weekly/att）或隐藏班超分（att=0）都必须重生成，
      // 否则会出现「屏幕关了班超分列、复制出来还带着班超分」（用户本轮报的不一致）。
      copyText: copyScope === 'all' && withAtt ? board.copyText : rebuild({ filtered: null, tags: [], rows: board.rows }),
      copyScope,
      withAtt,
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
    copyText: rebuild({ filtered, tags, rows }),
    copyScope,
    withAtt,
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
 * 复制口径 copy（用户 2026-10-30 提出；2026-11-20 第三轮**改为由显示列驱动**）：
 *  · all    → 每行同时写今日与本周（默认）；显示班超分时再追加班超分；
 *  · daily  → 只写今日达标，标题标注「日达标」；
 *  · weekly → 只写本周达标，标题标注「周达标」；
 *  · att    → 只写班超分报告（标题「班超分」，逐行写班超分 + 日均/合计扣分 + 主因）。
 *
 * ⚠️ 第三轮：前端不再有「复制内容」picker —— 复制口径由**显示列**派生
 * （只开日→daily、只开周→weekly、只开班超分→att、混合→all），
 * 并额外传 `att=1|0` 表示班超分列是否显示。`att=0` 时本函数不写每行班超分、
 * 不写「考勤待补」段、不写考勤规则 —— 否则会出现「屏幕没有班超分、复制出来却有」，
 * 用户拿两处一对照就会认为复制坏了（这正是本轮要消灭的不一致）。
 * 历史注释里「与显示内容是两回事、独立参数」的口径**已作废**，别再按那个改。
 */
function buildCopyText({ day, from, to, weekStart, totals, filtered, tags, rows, copy, attRangeLabel, withAtt = true } = {}) {
  const scoped = Array.isArray(tags) && tags.length > 0;
  const rawScope = copy === 'daily' || copy === 'weekly' || copy === 'att' ? copy : 'all';
  // att 口径只在显示班超分时可用；防御脏参数（withAtt=false 却传 att）落回 all。
  const scope = rawScope === 'att' && !withAtt ? 'all' : rawScope;
  // 班超分是否进正文：copy=att 恒需要；copy=all 时还要看显示列（att=0 就不写）
  const showAtt = withAtt && (scope === 'all' || scope === 'att');
  const scopeLabel = { daily: '日达标', weekly: '周达标', att: '班超分' }[scope];
  const lines = [];
  const marks = [scopeLabel, ...(scoped ? tags : [])].filter(Boolean);
  const head = marks.length ? `【班级状态 ${day}｜${marks.join(' · ')}】` : `【班级状态 ${day}】`;
  lines.push(head);

  const st = scoped ? filtered || {} : totals;
  const rateOf = (v) => (v === null || v === undefined ? '—' : `${v}%`);
  const list = rows || [];

  if (scope === 'att') {
    // 班超分报告：这是「不看达标、只看分数」的口径，汇总只写有分数的班与平均分。
    const scored = list.filter((r) => r.attendance && r.attendance.score !== null && r.attendance.score !== undefined);
    const avg = scored.length
      ? scoreScale.scoreText(scored.reduce((a, r) => a + Number(r.attendance.score), 0) / scored.length)
      : '—';
    const seg = `有检查记录 ${scored.length} 个班，班超平均 ${avg} 分`;
    if (scoped) {
      lines.push(`筛选出 ${st.classCount ?? list.length} 个班 / ${st.studentCount ?? 0} 人；${seg}`);
      lines.push(`（全校合计 ${totals.classCount} 个班 / ${totals.studentCount} 人）`);
    } else {
      lines.push(`全校 ${totals.classCount} 个班 / ${totals.studentCount} 人；${seg}`);
    }
    lines.push(`口径：${attRangeLabel || '本周'} ${from} ~ ${to || day}，班超分 = 10 − 日均扣分（含卫生/查宿等全部检查）`);
  } else {
    // 汇总行：按复制口径只写要的那个指标（复制「只要日达标」却附一句本周，是噪音）
    const seg = [];
    if (scope !== 'weekly') seg.push(`今日达标 ${st.achievedToday || 0} 人（${rateOf(st.dailyRate)}）`);
    if (scope !== 'daily') seg.push(`本周达标 ${st.achievedWeek || 0} 人（${rateOf(st.weeklyRate)}）`);
    if (scoped) {
      lines.push(`筛选出 ${st.classCount ?? list.length} 个班 / ${st.studentCount ?? 0} 人；${seg.join('，')}`);
      lines.push(`（全校合计 ${totals.classCount} 个班 / ${totals.studentCount} 人）`);
    } else {
      lines.push(`全校 ${totals.classCount} 个班 / ${totals.studentCount} 人；${seg.join('，')}`);
      if (totals.skippedClasses) lines.push(`（实习/毕业班 ${totals.skippedClasses} 个不参与统计，已排除）`);
    }
  }

  lines.push('');
  if (!list.length) {
    if (scoped) lines.push('当前筛选条件下没有班级');
    else if (scope === 'att') lines.push('全校没有班级数据');
    else lines.push(`未达标班级（${scopeLabel || '今日'}）：无，全部达标`);
    return lines.join('\n');
  }

  // 班超分整句（copy=att 与 copy=all 共用）：**日均与合计都写出来**，
  // 这样复制文本不依赖前端当前选的是「日均」还是「合计」——文本会被转发进工作群，
  // 口径冻结在文案里比跟着某个人的屏幕状态走更可靠。
  const attPart = (r) => {
    const att = r.attendance || {};
    if (att.score === null || att.score === undefined) return '本期无检查记录';
    const detail = (att.deductDetail || [])[0];
    const why = detail ? `；主因 ${detail.name}` : att.lateCount ? `；迟到 ${att.lateCount} 人` : '';
    const parts = [];
    if (att.deduct !== null && att.deduct !== undefined) parts.push(`日均扣 ${scoreScale.scoreText(att.deduct)}`);
    if (att.deductTotal !== null && att.deductTotal !== undefined) parts.push(`区间合计扣 ${scoreScale.scoreText(att.deductTotal)}`);
    const deductText = parts.length ? `${parts.join(' / ')}${why}` : why.replace(/^；/, '');
    return `班超 ${scoreScale.scoreText(att.score)} 分${deductText ? `（${deductText}）` : ''}`;
  };

  // 逐行：按复制口径只写要的那个指标
  const rowLine = (r) => {
    if (scope === 'att') return `· ${r.className}：${attPart(r)}${r.departmentName ? `｜${r.departmentName}` : ''}`;
    const parts = [];
    if (scope !== 'weekly') parts.push(`今日 ${r.run.achievedToday}/${r.studentCount} 人（${rateOf(r.run.dailyRate)}）`);
    if (scope !== 'daily') parts.push(`本周 ${r.run.achievedWeek}/${r.studentCount} 人（${rateOf(r.run.weeklyRate)}）`);
    // 班超分只在「显示列里有它」时出现（用户 2026-11-20 第三轮：复制必须与显示一致）
    if (scope === 'all' && showAtt) parts.push(attPart(r));
    return `· ${r.className}：${parts.join('，')}${r.departmentName ? `｜${r.departmentName}` : ''}`;
  };

  if (scoped) {
    // 筛选态只列一份清单（就是筛出来的这些）
    lines.push(`${tags[tags.length - 1] || '筛选结果'}（共 ${list.length} 个班）：`);
    for (const r of list) lines.push(rowLine(r));
    return lines.join('\n');
  }

  if (scope === 'att') {
    lines.push(`各班班超分（共 ${list.length} 个班）：`);
    for (const r of list) lines.push(rowLine(r));
  } else {
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
  }

  // 考勤待补 + 考勤计算规则：只有「显示班超分」时才有意义（att=0 时整段不写）。
  if (showAtt) {
    const attendanceMissing = list.filter(QUICK_FILTERS.attMissing.test);
    if (attendanceMissing.length) {
      lines.push('');
      // 窗口措辞用服务端 rangeLabel（本日/本周/本月），区间用**真实窗口起止**（from ~ to）：
      // 旧文案写「{from} 至今」，窗口还是「回看到所选日」时勉强对；
      // 现在窗口是**完整周/完整月**（与班超同源），终点不再是所选日 ——
      // 拿 day 当终点会出现「文案说统计到 11月19日、数字里含 11月20-22 日」，
      // 那正是用户拿两个页面对照时报「日周月不一致」的同一种说谎。
      lines.push(`考勤待补班级（${attRangeLabel || '本周'}：${from} ~ ${to || day} 无任何考勤记录，共 ${attendanceMissing.length} 个）：`);
      for (const r of attendanceMissing) lines.push(`· ${r.className}`);
    }
    // 考勤计算规则（用户 2026-11-12「要标注考勤计算规则，如迟到缺勤等逻辑」）：
    // 与班超分同生共死：收窄到只看日达标时考勤规则是噪音，不显示班超分时更不该出现。
    lines.push('');
    lines.push('考勤计算规则：');
    for (const l of buildAttRuleLines()) lines.push(`· ${l}`);
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
  // 分数没有第二套实现了（用户 2026-11-19）：本页的 attendance.score 一律来自
  // bandChao.scoreOfAggregate，这里只把窗口翻译函数导出给检查器/测试交叉核对。
  attWindow,
  MODULES,
  clearCache,
  CACHE_TTL,
};
