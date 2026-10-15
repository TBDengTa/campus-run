/**
 * 跑分（唐唐快跑积分体系）：学校使用的统一衡量标准，排行榜 / 记录 / 用户详情统一走本服务。
 *
 * ===== 公式（确定性、可解释）=====
 * 设：C = 跑分配置（goal_config.points 单例），S = 步数，G = 生效目标步数
 *     （日目标 / 周目标都取 services/goals.js::getEffectiveGoal(openid)：个人计划优先，否则全局默认）
 *
 *   日跑分(S) = 达标基础分 + 超出加分，其中
 *     达标基础分 = S >= G ? C.dailyGoal : 0
 *     档位步数   = max(1, G * C.extraPercent / 100)   ← **按「个人目标的百分比」算，不再是固定步数**
 *     超出加分   = min( floor( max(0, S - G) / 档位步数 ) * C.perStepScore , C.dailyExtraCap )
 *                  （C.perStepScore <= 0 时超出加分记 0；**上限只封顶超出加分，不封顶基础分**）
 *   周跑分(S) = 同理，用「周目标」与「本周（周一起的 ISO 周 / 自然周）步数」：
 *     达标基础分 = S >= G周 ? C.weeklyGoal : 0
 *     超出加分   = floor( max(0, S - G周) / C.perStep ) * C.perStepScore，**不设上限**
 *                  （**周公式本次未改**：仍用固定步数 C.perStep，见下方「perStep 已弃用」）
 *   G <= 0（目标缺失）时一律记 0（不能把「0 目标」当成「已达标」白送基础分）；
 *   C.enabled === false 时一律记 0（关闭跑分体系）；C.perStepScore === 0 时只有基础分。
 *
 * ===== 日超出档位改为 extraPercent（本次改造）=====
 * 产品口径：目标是个性化的，旧的固定步数档位（perStep，线上为 1000 步）对日目标 6000 步和 15000 步的人
 * 边际收益完全相同，不合理 → 改为「超出日目标后，每再多达成『个人目标 × extraPercent%』的步数，
 * 得 perStepScore 分」。默认 extraPercent = 10（即每达成个人目标的 10% 一档）。
 *   perStep **已弃用**：日公式不再读取它；仅周公式仍在使用（周公式本次刻意不改，回归基线不变）。
 *   兼容老配置（只有 perStep、没有 extraPercent）：读取时 extraPercent 记默认 10（等价于把旧 perStep
 *   视作「约等于目标的一个百分比」），**不做静默变更** —— 管理端「跑分设置」会显式提示换算结果
 *   （旧 perStep 占全局日目标的百分比 = 与旧口径等价的 extraPercent），管理员可一键改回或改成别的值。
 *   注意：跑分按当前配置实时计算、不落库快照，所以日超出档位从固定步数改成百分比后，
 *   **历史日分值会随新口径重算**（这是 AGENTS.md 里刻意的设计）；周分值不受影响。
 *
 *   取值示例（默认配置 C = {dailyGoal:5, extraPercent:10, perStepScore:1, dailyExtraCap:10}）：
 *     G=5000（档位 500 步）：4700 → 0；5000 → 5；5001 → 5；5500 → 5+1=6；9999 → 5+9=14；
 *                            10000 → 5+min(10,10)=15；20000 → 5+min(30,10)=15（封顶）
 *     G=6000（档位 600 步）：6000 → 5；6600 → 5+1=6；12000 → 5+min(10,10)=15
 *     G=15000（档位 1500 步）：15000 → 5；16500 → 5+1=6；30000 → 5+min(10,10)=15
 *   周（G周=25000，perStep=1000，周公式不变）：7658 → 0；25000 → 20；26000 → 20+1=21；43097 → 20+18=38。
 *
 * ===== 口径一致性 =====
 * - 日/周目标与「达标判定」完全同源（getEffectiveGoal），所以
 *   「日记录里标 ✓ 的那天」必然拿到 C.dailyGoal 基础分，反之亦然。
 * - 周为**周一起始**的自然周 / ISO 周，与 routes/admin/users.js 的 /records（$isoWeek）和
 *   /period（归一化到周一）完全一致；换算用 UTC 做日期算术，不受服务器时区影响
 *   （date 一律是 YYYY-MM-DD 字符串，$dateFromString 默认按 UTC 解析，与 toDateKey 的本地
 *   日历键在「周」这个粒度上不会跨周）。
 * - 「区间跑分 total」= 区间内各日跑分之和（含每达标周一次性记入的周基础分与周超出加分）；
 *   按周汇总（sumPointsByWeek）时，周跑分**不**再叠加该周的日跑分，避免同一件事重复计分。
 *
 * ===== 实现约定 =====
 * - 全部走聚合（$group by date / by ISO 周），不把全历史拉进 Node 循环；
 * - 每用户目标用 $lookup 批量取（禁止按用户逐个查询）；
 * - 计算在 Mongo 侧完成（$floor / $min 等），Node 侧只做映射与合并。
 */
const GoalConfig = require('../models/goal-config');
const RunRecord = require('../models/run-record');
const User = require('../models/user');
const dates = require('../utils/dates');

// 默认值（与 models/goal-config.js 的 schema 默认值保持一致）
const DEFAULT_POINTS = {
  enabled: true,
  dailyGoal: 5,
  weeklyGoal: 20,
  // 日超出档位：个人目标的百分比（默认 10 = 每再多达成『目标的 10%』得 perStepScore 分）
  extraPercent: 10,
  // 【已弃用】固定步数档位：日公式已改用 extraPercent；此处保留供周公式使用（周公式本次不改）
  perStep: 1000,
  perStepScore: 1,
  dailyExtraCap: 10,
};

// extraPercent 的合法区间（管理端做同样的整数校验）
const EXTRA_PERCENT_MIN = 1;
const EXTRA_PERCENT_MAX = 100;

// 班级榜聚合的候选用户上限（与 routes/ranking.js 的 SCAN_LIMIT 同量级）
const MAX_USERS = 5000;
// 每用户在班级聚合里最多统计的天数（年 ≈ 365，10 年足够；防止异常数据把子管道撑爆）
const LIMIT_PER_USER = 4000;

// ===== 配置 =====

// 是否为「有值」的数字（null / undefined / '' 一律视为缺失，不能当成 0）
function hasNumber(v) {
  return v != null && v !== '' && Number.isFinite(Number(v));
}

// 日超出档位百分比：显式配置优先（夹到 1~100）；缺失时取默认 10。
// 老配置（只有已弃用的 perStep）走的就是这条默认路径 —— 行为等价于「旧 perStep ≈ 目标的一个百分比」，
// 具体换算结果由管理端提示（见 routes/admin/config.js 的 pointsLegacy），避免静默变更。
// 不做 perStep 反推的原因：perStep 是绝对步数，无法同时等价于「6000 步目标」和「15000 步目标」的人，
// 而那正是本次要修的问题本身。
function resolveExtraPercent(p) {
  if (!hasNumber(p && p.extraPercent)) return DEFAULT_POINTS.extraPercent;
  const n = Math.round(Number(p.extraPercent));
  return Math.min(EXTRA_PERCENT_MAX, Math.max(EXTRA_PERCENT_MIN, n));
}

// 管理端「已弃用」提示用：旧 perStep 步相当于全局日目标的百分之多少
// （即：若要与改造前的日跑分完全一致，extraPercent 应填这个值）。无法换算时返回 null。
function legacyExtraPercent(perStep, globalDailySteps) {
  if (!hasNumber(perStep) || Number(perStep) <= 0) return null;
  if (!hasNumber(globalDailySteps) || Number(globalDailySteps) <= 0) return null;
  const pct = Math.round((Number(perStep) / Number(globalDailySteps)) * 100);
  return Math.min(EXTRA_PERCENT_MAX, Math.max(EXTRA_PERCENT_MIN, pct));
}

// 归一化跑分配置：任何字段缺失/非法都退回默认值（老配置文档没有 points 子文档时同样成立）
function normalizeConfig(raw) {
  const p = raw || {};
  const num = (v, dft, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dft;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    enabled: p.enabled !== false,
    dailyGoal: num(p.dailyGoal, DEFAULT_POINTS.dailyGoal, 0, 1000),
    weeklyGoal: num(p.weeklyGoal, DEFAULT_POINTS.weeklyGoal, 0, 5000),
    extraPercent: resolveExtraPercent(p),
    // 【已弃用】日公式不再读取 perStep；保留它是为了让周公式（本次未改）仍可配置
    perStep: num(p.perStep, DEFAULT_POINTS.perStep, 1, 1000000),
    perStepScore: num(p.perStepScore, DEFAULT_POINTS.perStepScore, 0, 1000),
    dailyExtraCap: num(p.dailyExtraCap, DEFAULT_POINTS.dailyExtraCap, 0, 1000),
  };
}

// 生效的跑分配置（goal_config 单例，管理端 /api/admin/config 读写同一份）
async function getPointsConfig() {
  const doc = await GoalConfig.getSingleton();
  return normalizeConfig(doc.points);
}

// 跑分配置 + 全局默认目标步数（一次读取，供聚合注入 $literal；口径与 getEffectiveGoal 一致）
async function loadEffective(opts = {}) {
  if (opts.config && opts.config.__globalDaily != null) return opts.config;
  const doc = await GoalConfig.getSingleton();
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
  const pts = normalizeConfig(opts.config || doc.points);
  return { ...pts, __globalDaily: num(doc.daily && doc.daily.steps), __globalWeekly: num(doc.weekly && doc.weekly.steps) };
}

// 给前端展示用的精简配置（GET /api/points/me 的 config 字段）
function publicConfig(config) {
  const c = normalizeConfig(config);
  return {
    enabled: c.enabled,
    dailyGoal: c.dailyGoal,
    weeklyGoal: c.weeklyGoal,
    extraPercent: c.extraPercent,
    perStep: c.perStep,
    perStepScore: c.perStepScore,
    dailyExtraCap: c.dailyExtraCap,
  };
}

// ===== 纯函数公式（Node 侧与 Mongo 侧表达式必须保持一致，改动请同步 THE_*_EXPR）=====

// 日超出档位步数 = max(1, 目标 × extraPercent%)。
// 与 Mongo 侧 dailyUnitExpr 严格等价：都是 (goal * percent) / 100 这一串 IEEE754 双精度运算，
// 不做四舍五入（保证两边在「差值刚好等于小数档位」时也逐例一致）。
function dailyUnit(goalSteps, extraPercent) {
  return Math.max(1, (goalSteps * extraPercent) / 100);
}

// 日跑分（单日步数 → 分数）：达标基础分 + min(超出加分, 日上限)
function pointsForDay({ steps, goalSteps, config }) {
  const c = normalizeConfig(config);
  if (!c.enabled) return 0;
  const s = Math.max(0, Math.round(Number(steps) || 0));
  const g = Math.max(0, Math.round(Number(goalSteps) || 0));
  if (g <= 0) return 0;
  const base = s >= g ? c.dailyGoal : 0;
  const extra =
    c.extraPercent > 0 && c.perStepScore > 0
      ? Math.floor(Math.max(0, s - g) / dailyUnit(g, c.extraPercent)) * c.perStepScore
      : 0;
  // 上限只封顶「超出加分」，不封顶达标基础分（否则日上限小于 dailyGoal 时连基础分都拿不到）
  return base + Math.min(extra, c.dailyExtraCap);
}

// 周跑分（本周累计步数 → 分数）：达标基础分 + 超出加分（无上限）
// 周公式本次**未改**：档位仍是固定步数 perStep（已弃用字段，仅此处仍在使用）
function pointsForWeek({ steps, goalSteps, config }) {
  const c = normalizeConfig(config);
  if (!c.enabled) return 0;
  const s = Math.max(0, Math.round(Number(steps) || 0));
  const g = Math.max(0, Math.round(Number(goalSteps) || 0));
  if (g <= 0) return 0;
  const base = s >= g ? c.weeklyGoal : 0;
  const extra = c.perStep > 0 && c.perStepScore > 0 ? Math.floor(Math.max(0, s - g) / c.perStep) * c.perStepScore : 0;
  return base + extra;
}

// 单个数字 → Mongo 聚合表达式（$literal 表达式，供 $max/$min/$floor 使用）
const lit = (n) => ({ $literal: n });

// 「超出加分」的 Mongo 表达式：floor(max(0, S-G) / 一档步数) * perStepScore
// unitExpr = 一档步数的表达式；null 表示没有可用档位（记 0）；perStepScore <= 0 也记 0
function extraPointsExpr(stepField, goalField, unitExpr, perStepScore) {
  if (unitExpr == null || !(perStepScore > 0)) return lit(0);
  return {
    $multiply: [
      { $floor: { $divide: [{ $max: [0, { $subtract: [stepField, goalField] }] }, unitExpr] } },
      lit(perStepScore),
    ],
  };
}

// 日档位步数表达式 = max(1, 目标 × extraPercent%) —— 与 dailyUnit() 严格等价（运算顺序一致）
function dailyUnitExpr(goalField, config) {
  return {
    $max: [lit(1), { $divide: [{ $multiply: [goalField, lit(config.extraPercent)] }, lit(100)] }],
  };
}

// 日/周跑分的 Mongo 表达式。结构严格等价于 pointsForDay/pointsForWeek：
//   基础分 = S >= G ? base : 0
//   超出分 = floor(max(0, S-G) / 一档步数) * perStepScore
//   日：base + min(超出分, dailyExtraCap)；周：base + 超出分（无上限）
// 目标 G <= 0 时整条记 0（必须显式判空：目标缺失时 S >= 0 恒真，会白送达标基础分）。
// cap 只封顶「超出分」，不能封顶 base，否则日上限小于 dailyGoal 时连基础分都拿不到。
function pointsExpr({ stepField, goalField, base, cap, unitExpr, perStepScore }) {
  const extra = extraPointsExpr(stepField, goalField, unitExpr, perStepScore);
  const scored = {
    $add: [
      { $cond: [{ $gte: [stepField, goalField] }, lit(base), lit(0)] },
      cap == null ? extra : { $min: [extra, lit(cap)] },
    ],
  };
  return { $cond: [{ $lte: [goalField, 0] }, lit(0), scored] };
}

// 日跑分表达式：达标基础分 + min(超出加分, 日上限)，档位 = 个人目标 × extraPercent%
function dailyPointsExpr(stepField, goalField, c) {
  const cfg = normalizeConfig(c);
  return pointsExpr({
    stepField,
    goalField,
    base: cfg.dailyGoal,
    cap: cfg.dailyExtraCap,
    unitExpr: cfg.extraPercent > 0 ? dailyUnitExpr(goalField, cfg) : null,
    perStepScore: cfg.perStepScore,
  });
}

// 周跑分表达式：达标基础分 + 超出加分（无上限），档位 = 固定步数 perStep（周公式未改）
function weeklyPointsExpr(stepField, goalField, c) {
  const cfg = normalizeConfig(c);
  return pointsExpr({
    stepField,
    goalField,
    base: cfg.weeklyGoal,
    cap: null,
    unitExpr: cfg.perStep > 0 ? lit(cfg.perStep) : null,
    perStepScore: cfg.perStepScore,
  });
}

// ===== 聚合常量 =====

// 每用户生效目标（个人计划优先，否则全局默认）——与 services/goals.js::getEffectiveGoal 同口径。
// 注意两条踩过的坑：
//  ① localField 必须是 **'$group 之后的路径'**（_id.openid），写成 'openid' 会因为 $group 只保留
//     _id/累加字段而匹配不到任何 user_goals 文档，lookup 静默返回 [] → 目标退化成 0；
//  ② 「全局默认」必须由 globalGoalStages() 以 $literal 注入（否则 $globalDailyGoal 解析成 missing → 0）。
const GOAL_LOOKUP = {
  $lookup: {
    from: 'user_goals',
    localField: '_id.openid',
    foreignField: 'openid',
    as: 'g',
    pipeline: [{ $project: { _id: 0, dailySteps: '$daily.steps', weeklySteps: '$weekly.steps' } }],
  },
};

// 注入全局默认目标（放在管道最前面）
function globalGoalStages(globalDaily, globalWeekly) {
  return [{ $addFields: { globalDailyGoal: { $literal: globalDaily }, globalWeeklyGoal: { $literal: globalWeekly } } }];
}

const GOAL_FIELDS = {
  $addFields: {
    _goalDaily: {
      $ifNull: [
        { $arrayElemAt: ['$g.dailySteps', 0] },
        { $ifNull: ['$globalDailyGoal', 0] },
      ],
    },
    _goalWeekly: {
      $ifNull: [
        { $arrayElemAt: ['$g.weeklySteps', 0] },
        { $ifNull: ['$globalWeeklyGoal', 0] },
      ],
    },
  },
};

//「按日聚合步数」的公共前半段：日期窗口过滤 → 按 openid+日期分组 → 并上每用户目标 → 算出当日跑分
function dailyStagePrefix({ from, to, openids, config }) {
  const rangeMatch = {};
  if (from) rangeMatch.$gte = from;
  if (to) rangeMatch.$lte = to;
  const firstMatch = {};
  if (Object.keys(rangeMatch).length) firstMatch.date = rangeMatch;
  if (openids && openids.length) firstMatch.openid = { $in: openids };

  const stages = [
    { $match: firstMatch },
    {
      $group: {
        _id: { openid: '$openid', date: '$date' },
        steps: { $sum: { $ifNull: ['$steps', 0] } },
        distance: { $sum: { $ifNull: ['$distance', 0] } },
      },
    },
    // $group 只保留 _id 与累加字段：注入的全局默认目标必须在 $group **之后**，
    // 否则会被 $group 丢掉，$globalDailyGoal 解析成 missing → 目标 0 → 跑分恒为 0
    ...globalGoalStages(config.__globalDaily, config.__globalWeekly),
    { $sort: { '_id.date': 1, '_id.openid': 1 } },
    { $limit: MAX_USERS * 400 },
    GOAL_LOOKUP,
    GOAL_FIELDS,
    {
      $project: {
        _id: 0,
        openid: '$_id.openid',
        date: '$_id.date',
        steps: 1,
        distance: 1,
        goalSteps: '$_goalDaily',
        points: dailyPointsExpr('$steps', '$_goalDaily', config),
      },
    },
  ];
  return stages;
}

// ===== 区间跑分（按日）=====
/**
 * 某用户 [from, to] 区间的跑分（按日累加，含每达标周的一次性周基础分/周加分）
 * @returns {{ total:Number, days:Number, steps:Number, byDay:Array<{date,steps,points}> }}
 */
async function sumPointsByDay(openid, { from, to, config } = {}) {
  const c = await loadEffective({ config });
  if (!c.enabled || !openid) return { total: 0, days: 0, steps: 0, byDay: [] };
  const rows = await RunRecord.aggregate([
    ...dailyStagePrefix({ from, to, openids: [openid], config: c }),
    {
      $group: {
        _id: '$openid',
        total: { $sum: '$points' },
        days: { $sum: 1 },
        steps: { $sum: '$steps' },
        byDay: { $push: { date: '$date', steps: '$steps', points: '$points' } },
      },
    },
  ]);
  const row = rows[0];
  if (!row) return { total: 0, days: 0, steps: 0, byDay: [] };
  return { total: row.total || 0, days: row.days || 0, steps: row.steps || 0, byDay: row.byDay || [] };
}

// ===== 区间跑分（按 ISO 周，周一起始）=====
/**
 * 某用户 [from, to] 区间内各周的跑分
 * @returns {Array<{ weekStart, weekEnd, steps, points }>} 按周起始升序
 */
async function sumPointsByWeek(openid, { from, to, config } = {}) {
  const c = await loadEffective({ config });
  if (!c.enabled || !openid) return [];
  const rows = await weeklyAggregate({ openid, from, to, config: c });
  return rows.map((r) => {
    const range = isoWeekRange(r.isoYear, r.isoWeek);
    return {
      weekStart: range.start,
      weekEnd: range.end,
      steps: r.steps || 0,
      points: r.points || 0,
      achieved: (r._goalWeekly || 0) > 0 && (r.steps || 0) >= r._goalWeekly,
    };
  });
}

// 单个用户按 ISO 周聚合（$isoWeekYear + $isoWeek，与 admin /records 的周口径一致）
function weeklyAggregate({ openid, from, to, config }) {
  const rangeMatch = {};
  if (from) rangeMatch.$gte = from;
  if (to) rangeMatch.$lte = to;
  const match = { openid };
  if (Object.keys(rangeMatch).length) match.date = rangeMatch;
  return RunRecord.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          y: { $isoWeekYear: { $dateFromString: { dateString: '$date' } } },
          w: { $isoWeek: { $dateFromString: { dateString: '$date' } } },
        },
        steps: { $sum: { $ifNull: ['$steps', 0] } },
        distance: { $sum: { $ifNull: ['$distance', 0] } },
      },
    },
    // 同 dailyStagePrefix：全局默认目标必须在 $group 之后注入
    ...globalGoalStages(config.__globalDaily, config.__globalWeekly),
    {
      $lookup: {
        from: 'user_goals',
        let: { oid: openid },
        pipeline: [{ $match: { $expr: { $eq: ['$openid', '$$oid'] } } }, { $project: { _id: 0, weeklySteps: '$weekly.steps' } }],
        as: 'g',
      },
    },
    {
      $addFields: {
        _goalWeekly: { $ifNull: [{ $arrayElemAt: ['$g.weeklySteps', 0] }, { $ifNull: ['$globalWeeklyGoal', 0] }] },
      },
    },
    {
      $project: {
        _id: 0,
        isoYear: '$_id.y',
        isoWeek: '$_id.w',
        steps: 1,
        distance: 1,
        _goalWeekly: 1,
        points: weeklyPointsExpr('$steps', '$_goalWeekly', config),
      },
    },
    { $sort: { isoYear: 1, isoWeek: 1 } },
  ]);
}

/**
 * 区间内所有周的跑分总计（不叠加日跑分，避免同一件事重复计分）
 * @returns {{ total:Number, weeks:Number, steps:Number }}
 */
async function sumPointsByWeekTotal(openid, { from, to, config } = {}) {
  const c = await loadEffective({ config });
  if (!c.enabled || !openid) return { total: 0, weeks: 0, steps: 0 };
  const rows = await weeklyAggregate({ openid, from, to, config: c });
  return {
    total: rows.reduce((s, r) => s + (r.points || 0), 0),
    weeks: rows.length,
    steps: rows.reduce((s, r) => s + (r.steps || 0), 0),
  };
}

/**
 * 全历史跑分总计 = 各日跑分之和 + 各周跑分之和（含达标周的一次性周分）
 * @returns {{ total:Number, weeks:Number }}
 */
async function sumPointsTotal(openid, { config } = {}) {
  const c = await loadEffective({ config });
  if (!c.enabled || !openid) return { total: 0, weeks: 0 };
  const [daily, weekly] = await Promise.all([
    sumPointsByDay(openid, { config: c }),
    sumPointsByWeekTotal(openid, { config: c }),
  ]);
  return { total: (daily.total || 0) + (weekly.total || 0), weeks: weekly.weeks || 0 };
}

// ===== 批量（列表 / 排行榜用）=====

/**
 * 批量算跑分：一次聚合出「多个用户 × 区间」的分数
 * @param {String[]} openids
 * @param {{ from?:String, to?:String, config?:Object }} opts
 * @returns {Map<String, { points:Number, steps:Number, byDay:Map<String,{steps:Number,points:Number}> }>}
 */
async function pointsByUsersForRange(openids, { from, to, config } = {}) {
  const out = new Map();
  const ids = [...new Set((openids || []).filter(Boolean))];
  if (!ids.length) return out;
  const c = await loadEffective({ config });
  if (!c.enabled) return out;
  const rows = await RunRecord.aggregate(dailyStagePrefix({ from, to, openids: ids, config: c }));
  for (const r of rows) {
    let item = out.get(r.openid);
    if (!item) {
      item = { points: 0, steps: 0, byDay: new Map() };
      out.set(r.openid, item);
    }
    item.points += r.points || 0;
    item.steps += r.steps || 0;
    item.byDay.set(r.date, { steps: r.steps || 0, points: r.points || 0 });
  }
  return out;
}

/**
 * 批量算「某一天的跑分」（排行榜今日榜 / 用户列表用）
 * @returns {Map<String, { points:Number, steps:Number }>}
 */
async function pointsOfUsers(openids, dateKey, { config } = {}) {
  const day = dateKey || dates.todayKey();
  const map = await pointsByUsersForRange(openids, { from: day, to: day, config });
  const out = new Map();
  for (const [openid, item] of map) out.set(openid, { points: item.points, steps: item.steps });
  return out;
}

// ===== 某个用户在某天的跑分（明细行用）=====
async function pointsOfUserOnDay(openid, dateKey, { config } = {}) {
  if (!openid || !dateKey) return 0;
  const map = await pointsOfUsers([openid], dateKey, { config });
  return (map.get(openid) || {}).points || 0;
}

// ===== 班级跑分（班级榜用）=====
/**
 * 按班级汇总跑分：班级跑分 = 班内学生跑分之和（闭源口径，见返回注释）
 * 与个人榜同口径：排除教师、被封禁、退出排名（privacy.exitRanking）的账号。
 * @returns {Array<{ className, points, steps, members }>} 按分数倒序
 */
async function classPointsRanking({ from, to, config } = {}) {
  const c = await loadEffective({ config });
  if (!c.enabled) return [];
  // 注意：起始 $match 是 users 集合的字段（role/status/privacy），必须跑在 User 上
  const rows = await User.aggregate([
    ...classAggregationStages({ from, to, config: c }),
    {
      $group: {
        _id: '$className',
        points: { $sum: '$points' },
        steps: { $sum: '$steps' },
        members: { $sum: 1 },
      },
    },
    { $match: { points: { $gt: 0 } } },
    { $sort: { points: -1, steps: -1, _id: 1 } },
    { $limit: 200 },
  ]).allowDiskUse(true);
  return rows.map((r) => ({
    className: r._id,
    points: r.points || 0,
    steps: r.steps || 0,
    members: r.members || 0,
  }));
}

// 班级聚合：候选账号（学生/正常/未退出排名）→ 每人的「按日步数 → 日跑分」求和 → 并上班级名
// 注意：
//  ① 起始 $match 是 users 集合字段，整个管道必须跑在 User 上（放 RunRecord 上会全部匹配不上）；
//  ② $lookup 的 localField=openid 必须紧跟起始阶段（此时索引还能用），日期区间/步数过滤下推到子管道；
//  ③ 每用户目标用 $lookup(user_goals) 取一次，不在逐日循环里重复查。
function classAggregationStages({ from, to, config }) {
  const firstMatch = { openid: { $nin: [null, ''] }, status: { $ne: 'banned' }, role: { $ne: 'teacher' }, 'privacy.exitRanking': { $ne: true } };
  const rangeMatch = {};
  if (from) rangeMatch.$gte = from;
  if (to) rangeMatch.$lte = to;
  const dayMatch = { steps: { $gt: 0 } };
  if (Object.keys(rangeMatch).length) dayMatch.date = rangeMatch;
  return [
    { $match: firstMatch },
    ...globalGoalStages(config.__globalDaily, config.__globalWeekly),
    {
      $lookup: {
        from: 'run_records',
        localField: 'openid',
        foreignField: 'openid',
        pipeline: [
          { $match: dayMatch },
          { $group: { _id: '$date', steps: { $sum: { $ifNull: ['$steps', 0] } } } },
          { $limit: LIMIT_PER_USER },
        ],
        as: 'dayRows',
      },
    },
    {
      $lookup: {
        from: 'user_goals',
        localField: 'openid',
        foreignField: 'openid',
        pipeline: [{ $project: { _id: 0, dailySteps: '$daily.steps' } }],
        as: 'g',
      },
    },
    { $addFields: { _goalDaily: { $ifNull: [{ $arrayElemAt: ['$g.dailySteps', 0] }, { $ifNull: ['$globalDailyGoal', 0] }] } } },    {
      $project: {
        _id: 0,
        className: { $ifNull: ['$className', ''] },
        steps: { $sum: '$dayRows.steps' },
        points: {
          $sum: {
            $map: { input: '$dayRows', as: 'd', in: dailyPointsExpr('$$d.steps', '$_goalDaily', config) },
          },
        },
      },
    },
    { $match: { className: { $nin: [null, ''] }, steps: { $gt: 0 } } },
  ];
}

// ===== 全校累计跑分总榜（徽章 rank 条件用）=====
/**
 * 全校「全历史累计跑分」排名（口径 = sumPointsTotal = 各日跑分之和 + 各达标周的一次性周分）
 *
 * 谁在用：services/badges.js 的 rank 徽章（跑分排名前 N 名）。
 *   —— 榜单**整体只算一次**并由调用方做进程内缓存（TTL 见 services/badges.js），
 *   徽章评估不会每个用户跑一遍全表。
 *
 * 口径要求（与 routes/ranking.js 完全一致）：
 *   ① 排除 rules：role != 'teacher'、status != 'banned'、privacy.exitRanking != true；
 *   ② 只统计 points > 0 的账号（与排行榜 pointsStages 的 { value: { $gt: 0 } } 同口径）；
 *   ③ 排序：points 倒序，同分按 openid 升序（确定的并列名次，避免名次抖动）；
 *   ④ 公式一律复用本文件的 dailyPointsExpr / weeklyPointsExpr，不在这里另写一套。
 *
 * 实现要点（实测 110k run_records / 1538 账号 ≈ 2.7s）：
 *   必须**从 users 起步**再按 openid $lookup run_records（openid 索引可用，每人只扫自己的行）；
 *   反过来用 `run_records.$match({ openid: { $in: [...1538 个] } })` 会退化成大范围索引扫描 +
 *   在 (openid,date) 分组行上做一万多次 user_goals $lookup，同一份数据要 12s+。
 *   每用户目标用 $lookup(user_goals) 取一次（禁止逐日/逐周查询）。
 *
 * @returns {Promise<Array<{ openid:String, points:Number, steps:Number }>>} 按分数倒序（只含 points>0）
 */
async function pointsTotalsAllUsers({ config } = {}) {
  const c = await loadEffective({ config });
  if (!c.enabled) return [];
  const dateExpr = { $dateFromString: { dateString: '$date' } };
  const rows = await User.aggregate([
    {
      $match: {
        openid: { $nin: [null, ''] },
        status: { $ne: 'banned' },
        role: { $ne: 'teacher' },
        'privacy.exitRanking': { $ne: true },
      },
    },
    // 全局默认目标必须以 $literal 注入（否则 $globalDailyGoal 解析成 missing → 目标 0 → 跑分恒为 0）
    ...globalGoalStages(c.__globalDaily, c.__globalWeekly),
    // 按日去重后的步数（一人一天一条，供日跑分使用）
    {
      $lookup: {
        from: 'run_records',
        localField: 'openid',
        foreignField: 'openid',
        pipeline: [
          { $match: { steps: { $gt: 0 } } },
          { $group: { _id: '$date', steps: { $sum: { $ifNull: ['$steps', 0] } } } },
          { $limit: LIMIT_PER_USER },
        ],
        as: 'dayRows',
      },
    },
    // 按 ISO 周（周一起始）汇总的步数，供周跑分使用；周口径与 weeklyAggregate 一致
    {
      $lookup: {
        from: 'run_records',
        localField: 'openid',
        foreignField: 'openid',
        pipeline: [
          { $match: { steps: { $gt: 0 } } },
          {
            $group: {
              _id: { y: { $isoWeekYear: dateExpr }, w: { $isoWeek: dateExpr } },
              steps: { $sum: { $ifNull: ['$steps', 0] } },
            },
          },
          { $limit: LIMIT_PER_USER },
        ],
        as: 'weekRows',
      },
    },
    {
      $lookup: {
        from: 'user_goals',
        localField: 'openid',
        foreignField: 'openid',
        pipeline: [{ $project: { _id: 0, dailySteps: '$daily.steps', weeklySteps: '$weekly.steps' } }],
        as: 'g',
      },
    },
    {
      $addFields: {
        _goalDaily: { $ifNull: [{ $arrayElemAt: ['$g.dailySteps', 0] }, { $ifNull: ['$globalDailyGoal', 0] }] },
        _goalWeekly: { $ifNull: [{ $arrayElemAt: ['$g.weeklySteps', 0] }, { $ifNull: ['$globalWeeklyGoal', 0] }] },
      },
    },
    {
      $project: {
        _id: 0,
        openid: 1,
        steps: { $sum: '$dayRows.steps' },
        points: {
          $add: [
            { $sum: { $map: { input: '$dayRows', as: 'd', in: dailyPointsExpr('$$d.steps', '$_goalDaily', c) } } },
            { $sum: { $map: { input: '$weekRows', as: 'w', in: weeklyPointsExpr('$$w.steps', '$_goalWeekly', c) } } },
          ],
        },
      },
    },
    { $match: { points: { $gt: 0 } } },
    { $sort: { points: -1, openid: 1 } },
  ]).allowDiskUse(true);
  return rows.map((r) => ({ openid: r.openid, points: r.points || 0, steps: r.steps || 0 }));
}

// ===== 工具 =====

// ISO 周（周一起始）→ { start, end } 日历键；用 UTC 做日期算术，避免时区偏移
function isoWeekRange(isoYear, isoWeek) {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7; // 周一=0
  const week1Monday = new Date(jan4.getTime() - jan4Dow * 86400000);
  const start = new Date(week1Monday.getTime() + (isoWeek - 1) * 7 * 86400000);
  const end = new Date(start.getTime() + 6 * 86400000);
  const key = (d) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { start: key(start), end: key(end) };
}

// 今日 / 本周窗口（周一 → 今天）
function currentWindows(today = dates.todayKey()) {
  const { startKey } = dates.weekRange(today);
  return { today, weekStart: startKey };
}

// 跑分的展示单位
const POINTS_UNIT = '跑分';

module.exports = {
  DEFAULT_POINTS,
  EXTRA_PERCENT_MIN,
  EXTRA_PERCENT_MAX,
  POINTS_UNIT,
  currentWindows,
  isoWeekRange,
  getPointsConfig,
  loadEffective,
  normalizeConfig,
  legacyExtraPercent,
  publicConfig,
  pointsForDay,
  pointsForWeek,
  dailyPointsExpr,
  weeklyPointsExpr,
  sumPointsByDay,
  sumPointsByWeek,
  sumPointsByWeekTotal,
  sumPointsTotal,
  pointsByUsersForRange,
  pointsOfUsers,
  pointsOfUserOnDay,
  pointsTotalsAllUsers,
  classPointsRanking,
};
