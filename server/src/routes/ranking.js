const express = require('express');
const { wrap, ok, ApiError } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const RunRecord = require('../models/run-record');
const WaterRecord = require('../models/water-record');
const pointsSvc = require('../services/points');
const { todayKey, weekRange } = require('../utils/dates');

const router = express.Router();
router.use(auth);

// ===== 维度定义 =====
// 时间：今日 / 本周（周一起） / 总榜
const RANGES = {
  today: { label: '今日' },
  week: { label: '本周' },
  total: { label: '总榜' },
};

// 范围：班级 / 系部 / 院系（校区） / 全校
const SCOPES = {
  class: { label: '班级' },
  department: { label: '系部' },
  school: { label: '院系' },
  all: { label: '全校' },
};

// 榜单类型：步数（默认，保持向后兼容） / 达标天数 / 饮水 / 跑分
// 注：徽章不作为榜单维度 —— 产品口径是「跑分/排名是发放徽章的条件」，而不是徽章参与排名。
const METRICS = {
  steps: { label: '步数', unit: '步' },
  goal: { label: '达标', unit: '天' },
  water: { label: '饮水', unit: 'ml' },
  points: { label: '跑分', unit: '分' },
};

// 榜单形态：个人榜（默认）/ 班级榜（按班级汇总）
const KINDS = ['person', 'class'];

const TOP_LIMIT = 50;
const SCAN_LIMIT = 2000;
const CACHE_TTL = 60 * 1000;

const cache = new Map();

function rangeWindow(range) {
  if (range === 'total') return { startKey: null, endKey: null };
  if (range === 'week') {
    const r = weekRange(todayKey());
    // 周窗口取「周一 → 周日」（历史数据到今天就没了，多算几天不影响）；
    // 跑分的周聚合按 ISO 周分组，与 admin /records 的周口径一致
    return { startKey: r.startKey, endKey: weekEndKey(r.startKey) };
  }
  return { startKey: todayKey(), endKey: todayKey() };
}

function weekEndKey(startKey) {
  const d = new Date(`${startKey}T00:00:00`);
  d.setDate(d.getDate() + 6);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 组织范围过滤（users 集合字段）
function scopeFilter(me, scope) {
  if (scope === 'class') {
    if (!me.className) throw new ApiError(400, 400, '尚未绑定班级，请先完成学生认证');
    return me.schoolId ? { className: me.className, schoolId: me.schoolId } : { className: me.className };
  }
  if (scope === 'department') {
    if (!me.departmentId) throw new ApiError(400, 400, '尚未绑定系部，请先完成学生认证');
    return { departmentId: me.departmentId };
  }
  if (scope === 'school') {
    if (!me.schoolId) throw new ApiError(400, 400, '尚未绑定院系，请先完成学生认证');
    return { schoolId: me.schoolId };
  }
  return {}; // all 全校
}

function availableScopes(me) {
  return [
    { key: 'class', label: SCOPES.class.label, available: !!me.className },
    { key: 'department', label: SCOPES.department.label, available: !!me.departmentId },
    { key: 'school', label: SCOPES.school.label, available: !!me.schoolId },
    { key: 'all', label: SCOPES.all.label, available: true },
  ];
}

// 姓名隐私遮蔽：张三 → 张**，单字名 → 张*
function maskName(name) {
  if (!name) return '匿名同学';
  if (name.length === 1) return name + '*';
  return name.slice(0, 1) + '**';
}

// 公共 $lookup users + 范围/隐私过滤 + 展示字段投影
// isMeMark 占位符会被替换为我的 openid
function lookupStage(userFilter) {
  return [
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: 'openid',
        as: 'u',
      },
    },
    { $unwind: '$u' },
    {
      $match: {
        'u.status': { $ne: 'banned' },
        'u.role': { $ne: 'teacher' },
        'u.privacy.exitRanking': { $ne: true },
        ...Object.entries(userFilter).reduce((acc, [k, v]) => ({ ...acc, [`u.${k}`]: v }), {}),
      },
    },
    {
      $lookup: {
        from: 'user_goals',
        localField: 'u.openid',
        foreignField: 'openid',
        as: 'g',
      },
    },
    {
      $addFields: {
        planNameRaw: { $ifNull: [{ $arrayElemAt: ['$g.planName', 0] }, ''] },
      },
    },
    {
      $project: {
        _id: 0,
        openid: '$_id',
        userId: '$u._id',
        value: 1,
        steps: { $ifNull: ['$steps', 0] },
        distance: { $ifNull: ['$distance', 0] },
        name: {
          $cond: [
            { $eq: ['$u.privacy.hideName', true] },
            {
              $cond: [
                { $gt: [{ $strLenCP: { $ifNull: ['$u.realName', ''] } }, 0] },
                { $concat: [{ $substrCP: ['$u.realName', 0, 1] }, '**'] },
                '匿名同学',
              ],
            },
            { $ifNull: ['$u.realName', { $ifNull: ['$u.nickname', '匿名同学'] }] },
          ],
        },
        className: {
          $cond: [{ $eq: ['$u.privacy.hideClass', true] }, '', { $ifNull: ['$u.className', ''] }],
        },
        planName: {
          $cond: [{ $eq: ['$u.privacy.hidePlan', true] }, '', '$planNameRaw'],
        },
      },
    },
  ];
}

// 全局默认目标必须以 $literal 注入：$globalDailyGoal 不会自己出现在文档里，
// 缺了这一步 «每用户目标» 会解析成 missing → 0，跑分恒为 0（务必保持在第 2 阶段之后）。
function globalGoalStage(config) {
  return {
    $addFields: {
      globalDailyGoal: { $literal: (config && config.__globalDaily) || 0 },
      globalWeeklyGoal: { $literal: (config && config.__globalWeekly) || 0 },
    },
  };
}

// ===== 跑分榜的专用管道 =====
// 跑分不是存储字段，必须「先按日聚合步数 → 并上每用户生效目标 → 用与 services/points.js
// 完全一致的公式算出每日跑分 → 汇总」。步数/距离在同一趟里累加
// （不再回查一次 run_records：range=total 会在 10 万+ 记录上多扫一遍，接口被拖到 10s 以上）。
// 公式本身复用 pointsSvc.dailyPointsExpr（禁止在本文件另写一套，避免口径漂移）。
function pointsStages(startKey, endKey, config) {
  const inRange = startKey ? { date: { $gte: startKey, $lte: endKey } } : {};
  return [
    { $match: { steps: { $gt: 0 }, ...inRange } },
    globalGoalStage(config),
    {
      $group: {
        _id: { openid: '$openid', date: '$date' },
        steps: { $sum: '$steps' },
        distance: { $sum: { $ifNull: ['$distance', 0] } },
      },
    },
    {
      $lookup: {
        from: 'user_goals',
        localField: '_id.openid',
        foreignField: 'openid',
        as: 'g',
        pipeline: [{ $project: { _id: 0, dailySteps: '$daily.steps' } }],
      },
    },
    {
      $addFields: {
        _goalDaily: {
          $ifNull: [{ $arrayElemAt: ['$g.dailySteps', 0] }, { $ifNull: ['$globalDailyGoal', 0] }],
        },
      },
    },
    {
      $group: {
        _id: '$_id.openid',
        value: { $sum: pointsSvc.dailyPointsExpr('$steps', '$_goalDaily', config) },
        steps: { $sum: '$steps' },
        distance: { $sum: '$distance' },
      },
    },
    { $match: { value: { $gt: 0 } } },
  ];
}

// 各指标聚合管道前半段（match + group 出 value/steps/distance）
// inRange 是「run_records / water_records 的 date 日历键」窗口（今日 / 本周 / 总榜）
function metricStages(metric, startKey, endKey) {
  const inRange = startKey ? { date: { $gte: startKey, $lte: endKey } } : {};
  switch (metric) {
    case 'steps':
      return [
        { $match: { steps: { $gt: 0 }, ...inRange } },
        {
          $group: {
            _id: '$openid',
            value: { $sum: '$steps' },
            steps: { $sum: '$steps' },
            distance: { $sum: '$distance' },
          },
        },
        { $match: { value: { $gt: 0 } } },
      ];
    case 'goal':
      return [
        { $match: { goalAchieved: true, ...inRange } },
        {
          $group: {
            _id: '$openid',
            value: { $sum: 1 },
            steps: { $sum: '$steps' },
            distance: { $sum: '$distance' },
          },
        },
      ];
    case 'water':
      return [
        { $match: inRange },
        { $group: { _id: '$openid', value: { $sum: '$total' }, steps: { $sum: 0 }, distance: { $sum: 0 } } },
        { $match: { value: { $gt: 0 } } },
      ];
    default:
      throw new ApiError(400, 400, '不支持的榜单类型');
  }
}

// 指标对应集合（饮水在另一个集合）
function metricCollection(metric) {
  if (metric === 'water') return WaterRecord;
  return RunRecord;
}

async function rankRows({ metric, startKey, endKey, userFilter, myOpenid }) {
  const config = metric === 'points' ? await pointsSvc.loadEffective() : null;
  const stages = [
    ...(metric === 'points' ? pointsStages(startKey, endKey, config) : metricStages(metric, startKey, endKey)),
    { $sort: { value: -1, _id: 1 } },
    { $limit: SCAN_LIMIT },
    ...lookupStage(userFilter),
  ];
  // isMe 标记：在投影后按 openid === 我的openid 计算
  const pipeline = JSON.parse(JSON.stringify(stages)).map((stage, idx) => {
    const last = idx === stages.length - 1;
    if (last && stage.$project) {
      return {
        $project: {
          ...stage.$project,
          isMe: { $eq: ['$_id', myOpenid] },
        },
      };
    }
    return stage;
  });
  const Col = metricCollection(metric);
  const rows = await Col.aggregate(pipeline).allowDiskUse(true);
  rows.sort((a, b) => b.value - a.value);
  return rows;
}

async function cachedRankRows(key, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.rows;
  const rows = await producer();
  cache.set(key, { at: Date.now(), rows });
  if (cache.size > 200) cache.clear();
  return rows;
}

// ===== 班级榜（按班级汇总，班级跑分 = 班内学生跑分之和）=====
// 口径与个人榜完全一致：排除教师、封禁、退出排名（privacy.exitRanking）的账号；
// 班级名取 users.className（自动识别「年级+专业」，见 AGENTS.md 学籍字段约定）。
function classStages(metric, startKey, endKey) {
  const inRange = startKey ? { date: { $gte: startKey, $lte: endKey } } : {};
  const base = metric === 'water' ? { ...inRange } : { steps: { $gt: 0 }, ...inRange };
  const inner = [
    { $match: base },
    {
      $group: {
        _id: '$openid',
        value:
          metric === 'water'
            ? { $sum: '$total' }
            : metric === 'goal'
              ? { $sum: { $cond: [{ $eq: ['$goalAchieved', true] }, 1, 0] } }
              : { $sum: '$steps' },
        steps: { $sum: { $ifNull: ['$steps', 0] } },
      },
    },
    { $match: { value: { $gt: 0 } } },
  ];
  return [
    {
      $lookup: {
        from: metric === 'water' ? 'water_records' : 'run_records',
        localField: 'openid',
        foreignField: 'openid',
        pipeline: inner,
        as: 'rows',
      },
    },
    {
      $project: {
        _id: 0,
        className: { $ifNull: ['$className', ''] },
        value: { $sum: '$rows.value' },
        steps: { $sum: '$rows.steps' },
        members: { $size: '$rows' },
      },
    },
  ];
}

// 跑分班级榜：候选账号 → 按日步数 → 日跑分（公式同 services/points.js）→ 每班汇总
// 起始 $match 由 rankClassRows 统一加（users 集合字段），保证 $lookup 紧跟其后能用上 openid 索引
function classPointsStages(startKey, endKey, config) {
  const inRange = startKey ? { date: { $gte: startKey, $lte: endKey } } : {};
  return [
    globalGoalStage(config),
    {
      $lookup: {
        from: 'run_records',
        localField: 'openid',
        foreignField: 'openid',
        pipeline: [
          { $match: { steps: { $gt: 0 }, ...inRange } },
          { $group: { _id: '$date', steps: { $sum: '$steps' } } },
        ],
        as: 'dayRows',
      },
    },
    {
      $lookup: {
        from: 'user_goals',
        localField: 'openid',
        foreignField: 'openid',
        as: 'g',
        pipeline: [{ $project: { _id: 0, dailySteps: '$daily.steps' } }],
      },
    },
    {
      $addFields: {
        _goalDaily: {
          $ifNull: [{ $arrayElemAt: ['$g.dailySteps', 0] }, { $ifNull: ['$globalDailyGoal', 0] }],
        },
      },
    },
    {
      $project: {
        _id: 0,
        className: { $ifNull: ['$className', ''] },
        steps: { $sum: '$dayRows.steps' },
        value: {
          $sum: {
            $map: { input: '$dayRows', as: 'd', in: pointsSvc.dailyPointsExpr('$$d.steps', '$_goalDaily', config) },
          },
        },
      },
    },
  ];
}

// 班级榜聚合：候选账号（学生 / 正常 / 未退出排名）→ 每班汇总
// scope 过滤条件放在最前面（$lookup 紧跟其后，此时 openid 索引仍可用）
async function rankClassRows({ metric, startKey, endKey, scopeFilter: scopedMatch, config }) {
  const User = require('../models/user');
  const stages = metric === 'points' ? classPointsStages(startKey, endKey, config) : classStages(metric, startKey, endKey);
  const rows = await User.aggregate([
    { $match: { openid: { $nin: [null, ''] }, status: { $ne: 'banned' }, role: { $ne: 'teacher' }, 'privacy.exitRanking': { $ne: true }, ...scopedMatch } },
    ...stages,
    {
      $group: {
        _id: '$className',
        value: { $sum: '$value' },
        steps: { $sum: '$steps' },
        members: { $sum: 1 },
      },
    },
    { $match: { value: { $gt: 0 }, _id: { $nin: [null, ''] } } },
    { $sort: { value: -1, steps: -1, _id: 1 } },
    { $limit: 200 },
  ]).allowDiskUse(true);
  // 实习 / 毕业班不参加任何校园跑统计：整班从班级榜剔除（不是记 0）
  const names = rows.map((r) => r._id).filter(Boolean);
  if (!names.length) return rows;
  const ClassProfile = require('../models/class-profile');
  const profiles = await ClassProfile.find({ className: { $in: names } }).select('className status').lean();
  const excluded = new Set(
    profiles.filter((p) => ClassProfile.normalizeStatus(p.status) !== 'normal').map((p) => p.className)
  );
  return excluded.size ? rows.filter((r) => !excluded.has(r._id)) : rows;
}

// GET /api/ranking?metric=steps|goal|water|points&range=today|week|total&scope=class|department|school|all
// GET /api/ranking?kind=class&metric=steps|points...  → 班级榜
router.get(
  '/',
  wrap(async (req, res) => {
    const me = req.user;
    const metric = METRICS[req.query.metric] ? req.query.metric : 'steps';
    const range = RANGES[req.query.range] ? req.query.range : 'today';
    const scope = SCOPES[req.query.scope] ? req.query.scope : 'all';
    const kind = KINDS.includes(req.query.kind) ? req.query.kind : 'person';

    const userFilter = scopeFilter(me, scope);
    const { startKey, endKey } = rangeWindow(range);
    const metricDef = METRICS[metric];
    const config = metric === 'points' ? await pointsSvc.loadEffective() : null;

    // ===== 班级榜：一行一个班，班级跑分 / 班级步数 = 班内学生之和 =====
    if (kind === 'class') {
      // scope=class 时「班级榜」只剩自己班一行，仍返回（前端会自动收窄范围选择）
      const scopedMatch = scope === 'class' ? (me.className ? { className: me.className } : {}) : userFilter;
      const key = ['class', metric, range, scope, scopedMatch.className || '', scopedMatch.schoolId || '', scopedMatch.departmentId || ''].join('|');
      const rows = await cachedRankRows(key, () => rankClassRows({ metric, startKey, endKey, scopeFilter: scopedMatch, config }));

      const list = rows.slice(0, TOP_LIMIT).map((r, i) => ({
        rank: i + 1,
        className: r._id,
        value: r.value || 0,
        steps: r.steps || 0,
        members: r.members || 0,
        valueText: `${fmtInt(r.value)} ${metricDef.unit}`,
        stepsText: fmtInt(r.steps || 0),
        membersText: `${r.members || 0} 人`,
        isMine: !!me.className && r._id === me.className,
      }));

      const mine = list.find((r) => r.isMine) || null;
      return ok(res, {
        kind: 'class',
        metric,
        range,
        scope,
        metricText: metricDef.label,
        rangeText: RANGES[range].label,
        scopeText: SCOPES[scope].label,
        unit: metricDef.unit,
        date: todayKey(),
        participants: rows.length,
        list,
        me: {
          rank: mine ? mine.rank : null,
          className: me.className || '',
          value: mine ? mine.value : 0,
          valueText: mine ? mine.valueText : `0 ${metricDef.unit}`,
          steps: mine ? mine.steps : 0,
          members: mine ? mine.members : 0,
        },
        scopes: availableScopes(me),
      });
    }

    // ===== 个人榜 =====
    const cacheKey = [kind, metric, range, scope, me.schoolId || '', me.departmentId || '', me.className || ''].join('|');
    const rows = await cachedRankRows(cacheKey, () =>
      rankRows({ metric, startKey, endKey, userFilter, myOpenid: me.openid })
    );

    const list = rows.slice(0, TOP_LIMIT).map((r, i) => ({
      rank: i + 1,
      openid: r.openid,
      name: r.name,
      className: r.className,
      planName: r.planName,
      steps: r.steps || 0,
      distanceKm: ((r.distance || 0) / 1000).toFixed(2),
      value: r.value || 0,
      valueText: `${fmtInt(r.value)} ${metricDef.unit}`,
      isMe: r.openid === me.openid,
    }));

    // 我的成绩（不在榜时也给出自己的值）
    const myRow = rows.find((r) => r.openid === me.openid) || null;
    const myRank = myRow ? rows.indexOf(myRow) + 1 : null;
    let myValue = myRow ? myRow.value || 0 : null;
    let mySteps = myRow ? myRow.steps || 0 : 0;
    let myDistance = myRow ? myRow.distance || 0 : 0;
    if (myValue == null) {
      myValue = 0;
      mySteps = 0;
      myDistance = 0;
      if (metric === 'points') {
        // 跑分不在榜（0 分）时：用服务现算，保证「我的跑分」与 /api/points/me 一致
        const sums = await pointsSvc.sumPointsByDay(me.openid, { from: startKey || undefined, to: endKey || undefined, config });
        myValue = sums.total || 0;
        mySteps = sums.steps || 0;
      } else {
        const Col = metricCollection(metric);
        const inRange = startKey ? { date: { $gte: startKey, $lte: endKey } } : {};
        const mine = await Col.aggregate([
          { $match: { openid: me.openid, ...inRange } },
          ...(metric === 'goal'
            ? [{ $match: { goalAchieved: true } }, { $group: { _id: null, value: { $sum: 1 } } }]
            : [{ $group: { _id: null, value: metric === 'water' ? { $sum: '$total' } : { $sum: 1 } } }]),
        ]);
        myValue = mine[0]?.value || 0;
        if (metric === 'steps') {
          const sr = await RunRecord.aggregate([
            { $match: { openid: me.openid, ...inRange } },
            { $group: { _id: null, steps: { $sum: '$steps' }, distance: { $sum: '$distance' } } },
          ]);
          mySteps = sr[0]?.steps || 0;
          myDistance = sr[0]?.distance || 0;
        }
      }
    }

    ok(res, {
      kind: 'person',
      metric,
      range,
      scope,
      metricText: metricDef.label,
      rangeText: RANGES[range].label,
      scopeText: SCOPES[scope].label,
      unit: metricDef.unit,
      date: todayKey(),
      excluded: me.role === 'teacher' || (me.privacy && me.privacy.exitRanking),
      excludedReason:
        me.role === 'teacher' ? '教师账号不参与排名' : me.privacy && me.privacy.exitRanking ? '你已开启「不参与排名」' : '',
      participants: rows.length,
      list,
      me: {
        rank: myRank,
        value: myValue,
        valueText: `${fmtInt(myValue)} ${metricDef.unit}`,
        steps: mySteps,
        distanceKm: ((myDistance || 0) / 1000).toFixed(2),
        name: me.privacy && me.privacy.hideName ? maskName(me.realName) : me.realName || me.nickname || '我',
        className: me.privacy && me.privacy.hideClass ? '' : me.className || '',
      },
      scopes: availableScopes(me),
    });
  })
);

function fmtInt(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

module.exports = router;
