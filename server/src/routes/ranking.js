const express = require('express');
const { wrap, ok, ApiError } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const RunRecord = require('../models/run-record');
const { todayKey, weekRange } = require('../utils/dates');

const router = express.Router();
router.use(auth);

// 榜单维度：日榜 / 周榜（自然周，周一起） / 总榜
const RANGES = {
  day: { label: '今日榜' },
  week: { label: '本周榜' },
  total: { label: '总榜' },
};

// 榜单范围：全校 / 本院系 / 本班
const SCOPES = {
  school: '全校',
  department: '本院系',
  class: '本班',
};

const TOP_LIMIT = 50; // 对外返回条数
const SCAN_LIMIT = 2000; // 内部排名扫描上限
const CACHE_TTL = 60 * 1000; // 聚合结果缓存 60s，降低大集合聚合压力

// 简易进程内缓存：key -> { at, rows }
const cache = new Map();

// 组织范围过滤条件（User 集合字段名，用于 $lookup 后加 u. 前缀）
function scopeFilter(me, scope) {
  if (scope === 'class') {
    if (!me.className) throw new ApiError(400, 400, '尚未绑定班级，请先完成学生认证');
    return me.schoolId ? { className: me.className, schoolId: me.schoolId } : { className: me.className };
  }
  if (scope === 'department') {
    if (!me.departmentId) throw new ApiError(400, 400, '尚未绑定院系，请先完成学生认证');
    return { departmentId: me.departmentId };
  }
  // 未绑定学校时退化为全平台
  return me.schoolId ? { schoolId: me.schoolId } : {};
}

function availableScopes(me) {
  return [
    { key: 'school', label: SCOPES.school, available: true },
    { key: 'department', label: SCOPES.department, available: !!me.departmentId },
    { key: 'class', label: SCOPES.class, available: !!me.className },
  ];
}

// 聚合各用户步数（日榜/周榜/总榜共用一条管道，保证数据实时且口径一致）
async function rankRows({ range, startKey, endKey, userFilter }) {
  const match = range === 'total' ? {} : { date: { $gte: startKey, $lte: endKey } };
  match.steps = { $gt: 0 };

  const userMatch = { 'u.status': { $ne: 'banned' }, 'u.role': { $ne: 'teacher' } };
  for (const [k, v] of Object.entries(userFilter)) userMatch[`u.${k}`] = v;

  return RunRecord.aggregate([
    { $match: match },
    { $group: { _id: '$openid', steps: { $sum: '$steps' }, distance: { $sum: '$distance' } } },
    { $match: { steps: { $gt: 0 } } },
    { $lookup: { from: 'users', localField: '_id', foreignField: 'openid', as: 'u' } },
    { $unwind: '$u' },
    { $match: userMatch },
    { $sort: { steps: -1, _id: 1 } },
    { $limit: SCAN_LIMIT },
    {
      $project: {
        _id: 0,
        openid: '$_id',
        steps: 1,
        distance: 1,
        nickname: '$u.nickname',
        avatarUrl: '$u.avatarUrl',
        userId: '$u._id',
      },
    },
  ]).allowDiskUse(true);
}

async function cachedRankRows(key, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.rows;
  const rows = await producer();
  cache.set(key, { at: Date.now(), rows });
  // 防止长期运行内存增长：缓存过大时整体清空（缓存可重建）
  if (cache.size > 200) cache.clear();
  return rows;
}

// GET /api/ranking?range=day|week|total&scope=school|department|class
router.get(
  '/',
  wrap(async (req, res) => {
    const me = req.user;
    const range = Object.prototype.hasOwnProperty.call(RANGES, req.query.range) ? req.query.range : 'day';
    const scope = Object.prototype.hasOwnProperty.call(SCOPES, req.query.scope) ? req.query.scope : 'school';
    const userFilter = scopeFilter(me, scope);

    const today = todayKey();
    const window = range === 'week' ? weekRange(today) : { startKey: today, endKey: today };
    const cacheKey = [range, scope, me.schoolId || '', me.departmentId || '', me.className || ''].join('|');

    const rows = await cachedRankRows(cacheKey, () => rankRows({ range, startKey: window.startKey, endKey: window.endKey, userFilter }));

    const myIndex = rows.findIndex((r) => r.openid === me.openid);
    const list = rows.slice(0, TOP_LIMIT).map((r, i) => ({
      rank: i + 1,
      userId: r.userId,
      nickname: r.nickname || '匿名同学',
      avatarUrl: r.avatarUrl || '',
      steps: r.steps || 0,
      distance: r.distance || 0,
      isMe: r.openid === me.openid,
    }));

    // 我的数据（未进前 2000 名时也要给出自己的成绩）
    let mySteps = myIndex >= 0 ? rows[myIndex].steps : 0;
    let myDistance = myIndex >= 0 ? rows[myIndex].distance : 0;
    if (myIndex < 0) {
      const mine = await RunRecord.aggregate([
        {
          $match: {
            openid: me.openid,
            ...(range === 'total' ? {} : { date: { $gte: window.startKey, $lte: window.endKey } }),
          },
        },
        { $group: { _id: null, steps: { $sum: '$steps' }, distance: { $sum: '$distance' } } },
      ]);
      mySteps = mine[0]?.steps || 0;
      myDistance = mine[0]?.distance || 0;
    }

    ok(res, {
      range,
      scope,
      rangeText: RANGES[range].label,
      scopeText: SCOPES[scope],
      date: today,
      // 教师账号不参与排名（仍可查看榜单）
      excluded: me.role === 'teacher',
      excludedReason: me.role === 'teacher' ? '教师账号不参与步数排名' : '',
      participants: rows.length,
      list,
      me: {
        rank: myIndex >= 0 ? myIndex + 1 : null,
        steps: mySteps,
        distance: myDistance,
        avatarUrl: me.avatarUrl || '',
        nickname: me.nickname || '我',
      },
      scopes: availableScopes(me),
    });
  })
);

module.exports = router;
