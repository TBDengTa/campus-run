const express = require('express');
const { wrap, ok, ApiError } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const RunRecord = require('../models/run-record');
const WaterRecord = require('../models/water-record');
const UserBadge = require('../models/user-badge');
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

// 榜单类型：步数 / 达标天数 / 饮水 / 成就
const METRICS = {
  steps: { label: '步数', unit: '步' },
  goal: { label: '达标', unit: '天' },
  water: { label: '饮水', unit: 'ml' },
  badge: { label: '成就', unit: '枚' },
};

const TOP_LIMIT = 50;
const SCAN_LIMIT = 2000;
const CACHE_TTL = 60 * 1000;

const cache = new Map();

function rangeWindow(range) {
  if (range === 'total') return { startKey: null, endKey: null };
  if (range === 'week') {
    const r = weekRange(todayKey());
    return { startKey: r.startKey, endKey: r.endKey };
  }
  return { startKey: todayKey(), endKey: todayKey() };
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

// 各指标聚合管道前半段（match + group 出 value/steps/distance）
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
    case 'badge':
      return [
        { $match: inRange },
        { $group: { _id: '$openid', value: { $sum: 1 }, steps: { $sum: 0 }, distance: { $sum: 0 } } },
      ];
    default:
      throw new ApiError(400, 400, '不支持的榜单类型');
  }
}

// 指标对应集合（饮水/成就在不同集合）
function metricCollection(metric) {
  if (metric === 'water') return WaterRecord;
  if (metric === 'badge') return UserBadge;
  return RunRecord;
}

async function rankRows({ metric, startKey, endKey, userFilter, myOpenid }) {
  const Col = metricCollection(metric);
  const stages = [...metricStages(metric, startKey, endKey), { $sort: { value: -1, _id: 1 } }, { $limit: SCAN_LIMIT }, ...lookupStage(userFilter)];
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

// GET /api/ranking?metric=steps|goal|water|badge&range=today|week|total&scope=class|department|school|all
router.get(
  '/',
  wrap(async (req, res) => {
    const me = req.user;
    const metric = METRICS[req.query.metric] ? req.query.metric : 'steps';
    const range = RANGES[req.query.range] ? req.query.range : 'today';
    const scope = SCOPES[req.query.scope] ? req.query.scope : 'all';

    const userFilter = scopeFilter(me, scope);
    const { startKey, endKey } = rangeWindow(range);
    const cacheKey = [metric, range, scope, me.schoolId || '', me.departmentId || '', me.className || ''].join('|');

    const rows = await cachedRankRows(cacheKey, () =>
      rankRows({ metric, startKey, endKey, userFilter, myOpenid: me.openid })
    );

    const metricDef = METRICS[metric];
    const myIndex = rows.findIndex((r) => r.openid === me.openid);
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
    let myValue = myIndex >= 0 ? rows[myIndex].value : 0;
    let mySteps = myIndex >= 0 ? rows[myIndex].steps : 0;
    let myDistance = myIndex >= 0 ? rows[myIndex].distance : 0;
    if (myIndex < 0) {
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

    ok(res, {
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
        rank: myIndex >= 0 ? myIndex + 1 : null,
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
