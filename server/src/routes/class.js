/**
 * 班级域接口（/api/class/*）：班主任 / 班委的**只读**数据面
 *
 * ===== 权限模型：成员资格校验（刻意不用 requirePermission）=====
 *   班主任（教师） user.homeroomClasses.includes(className) → 可读该班全部数据
 *   班委（学生）   user.isClassOfficer === true && user.className === className → 只读、只能看自己班
 *   其他一律 403 + code 403002（无权限）
 *
 * 为什么用 403002 而不是 403003：小程序 utils/request.js 把 403003 当作「未绑定账号」处理并
 * reLaunch 到登录页 —— 已登录的班主任/班委访问别人班级时会被错误地踢出登录态；
 * 403002（管理端「无权限」同码）只弹提示、不跳转，正是这里想要的语义。
 *
 * 本路由不提供任何写接口：班委的「督促」只是前端用列表数据生成名单文案（复制到剪贴板），
 * 服务端没有可写入的端点，因此「班委只有查看功能」是由接口形态保证的。
 *
 * ===== 口径 =====
 *   - 达标：当日/本周步数 ≥ 生效目标（个人计划优先，否则全局默认），与 admin/users.js 的
 *     /:id/period、/:id/records 完全一致（明细页可直接复用 packageAdmin/user-detail/period-detail）；
 *   - 全部统计排除教师（role !== 'teacher'），与首页数据概况、排行榜一致；
 *   - 班级排名（全校班级名次）与首页 /api/admin/dashboard/top3 的班级榜同口径：
 *     班级日均 = Σ(班内学生本周日均) ÷ 班内学生数，本周日均 = 本周步数 ÷ 有记录天数；
 *   - 跑分（若 services/points.js 可用）取「本周跑分 = Σ 本周各日跑分」，与 /api/points/me 同源。
 *
 * ===== 隐私 =====
 *   班委是学生：列表/榜单里对开启了「隐藏姓名」的同学做遮蔽（张**），且榜单排除「不参与排名」的同学；
 *   班主任（教师）承担管理职责，始终看到真实姓名与全班数据。
 */
const express = require('express');
const mongoose = require('mongoose');
const { wrap, ok, ApiError, parsePagination } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const dates = require('../utils/dates');
const User = require('../models/user');
const RunRecord = require('../models/run-record');
const GoalConfig = require('../models/goal-config');
const UserGoal = require('../models/user-goal');

// 跑分（可选能力）：公式与批量聚合统一由 services/points.js 提供（与用户端 /api/points 同源）。
// 该服务与班级域并行开发，缺失/接口变动时本路由自动降级为「不含跑分字段」，不影响启动与其它接口。
let pointsSvc = null;
try {
  pointsSvc = require('../services/points'); // eslint-disable-line global-require
} catch (e) {
  pointsSvc = null;
}

const router = express.Router();
router.use(auth);

const NO_ACCESS = '该班级不在你的管理范围'; // 403002
const MULTI_CLASS = '你负责多个班级，请指定 className';
const MAX_STUDENTS = 2000; // 单班学生扫描上限（班级规模远小于此）
const TOP_LIMIT = 50; // 班内榜单返回条数
const CLASS_RANK_TTL = 60 * 1000; // 全校班级排名缓存（首页班级卡与班级页会同时打这个聚合）

const STUDENT_FIELDS =
  'openid realName nickname account studentId className isClassOfficer totalSteps totalDistance totalDays lastSyncAt privacy';

// ===== 权限：可见班级与目标班级 =====

// 我可管的班级：班主任可多个，班委只能是自己所在班级
function accessibleClasses(user) {
  const homeroom = (Array.isArray(user.homeroomClasses) ? user.homeroomClasses : []).filter(Boolean);
  const officer = user.isClassOfficer && user.className ? [user.className] : [];
  return { homeroom, officer, all: [...new Set([...homeroom, ...officer])] };
}

// 解析本次请求的目标班级并判定角色；不传 className 时：只有一个候选就自动选中，多个则要求显式指定
function resolveScope(user, rawClassName) {
  const { homeroom, officer, all } = accessibleClasses(user);
  const className = String(rawClassName || '').trim();
  const asScope = (name) => ({
    className: name,
    isHomeroom: homeroom.includes(name),
    isOfficer: officer.includes(name) && !homeroom.includes(name),
  });
  if (className) {
    if (!all.includes(className)) throw new ApiError(403, 403002, NO_ACCESS);
    return asScope(className);
  }
  if (!all.length) throw new ApiError(403, 403002, '你还不是班主任或班委');
  if (all.length === 1) return asScope(all[0]);
  throw new ApiError(400, 400, MULTI_CLASS);
}

// 目标学生必须属于「我可管的班级」——防跨班越权；教师账号不属于班级学生，一律拒绝
async function loadScopedStudent(user, userId, rawClassName) {
  if (!mongoose.isValidObjectId(userId)) throw new ApiError(404, 404, '学生不存在');
  const target = await User.findById(userId)
    .select('openid className role realName nickname account studentId')
    .lean();
  if (!target) throw new ApiError(404, 404, '学生不存在');
  if (target.role === 'teacher') throw new ApiError(403, 403002, '教师账号不参与运动记录与排名');
  const { all } = accessibleClasses(user);
  if (!target.className || !all.includes(target.className)) throw new ApiError(403, 403002, NO_ACCESS);
  // 多班班主任带 className 访问时，必须与目标学生所在班级一致（不能借 A 班身份看 B 班学生）
  const want = String(rawClassName || '').trim();
  if (want && want !== target.className) throw new ApiError(403, 403002, NO_ACCESS);
  return target;
}

// ===== 通用小工具 =====

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const round = (n) => Math.round(Number(n) || 0);

// 姓名遮蔽（与排行榜一致）：张三 → 张**，单字 → 张*
function maskName(name) {
  if (!name) return '匿名同学';
  if (name.length === 1) return `${name}*`;
  return `${name.slice(0, 1)}**`;
}

// ISO 周（周一起始）→ { start, end } 日历键；与 admin/users.js::isoWeekRange 同口径
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

// ===== 班级数据装载：一次聚合供概况 / 列表 / 榜单共用 =====

async function loadClassStats(className) {
  const students = await User.find({ className, role: { $ne: 'teacher' } })
    .select(STUDENT_FIELDS)
    .limit(MAX_STUDENTS)
    .lean();
  const openids = students.map((s) => s.openid).filter(Boolean);
  const today = dates.todayKey();
  const { startKey: weekStart } = dates.weekRange(today);

  // 跑分配置（可选）：与其它查询并行走，关闭/服务缺失时不展示跑分
  const [globalConfig, goals, rows, pointsConfig] = await Promise.all([
    GoalConfig.getSingleton(),
    openids.length
      ? UserGoal.find({ openid: { $in: openids } }).select('openid daily weekly').lean()
      : Promise.resolve([]),
    // 本周（周一至今）按 学生 × 日期 聚合：今日 + 本周 + 有记录天数 一次拿全
    openids.length
      ? RunRecord.aggregate([
          { $match: { openid: { $in: openids }, date: { $gte: weekStart, $lte: today } } },
          {
            $group: {
              _id: { openid: '$openid', date: '$date' },
              steps: { $sum: { $ifNull: ['$steps', 0] } },
              distance: { $sum: { $ifNull: ['$distance', 0] } },
              records: { $sum: 1 },
            },
          },
        ])
      : Promise.resolve([]),
    pointsSvc && typeof pointsSvc.getPointsConfig === 'function'
      ? pointsSvc.getPointsConfig().catch(() => null)
      : Promise.resolve(null),
  ]);
  const pointsEnabled = !!(pointsConfig && pointsConfig.enabled);

  const globalDaily = Number(globalConfig.daily && globalConfig.daily.steps) || 0;
  const globalWeekly = Number(globalConfig.weekly && globalConfig.weekly.steps) || 0;
  const goalBy = new Map(goals.map((g) => [g.openid, g]));

  // openid → { byDate: Map<date, {steps,distance,records}>, weekSteps, weekDistance, activeDays }
  const aggBy = new Map();
  for (const r of rows) {
    const openid = r._id.openid;
    let item = aggBy.get(openid);
    if (!item) {
      item = { byDate: new Map(), weekSteps: 0, weekDistance: 0, activeDays: 0 };
      aggBy.set(openid, item);
    }
    item.byDate.set(r._id.date, { steps: r.steps || 0, distance: r.distance || 0, records: r.records || 0 });
    item.weekSteps += r.steps || 0;
    item.weekDistance += r.distance || 0;
    item.activeDays += 1;
  }

  const list = students.map((s) => {
    const g = goalBy.get(s.openid) || null;
    const dailyTarget = Number(g && g.daily && g.daily.steps) || globalDaily;
    const weeklyTarget = Number(g && g.weekly && g.weekly.steps) || globalWeekly;
    const agg = aggBy.get(s.openid) || { byDate: new Map(), weekSteps: 0, weekDistance: 0, activeDays: 0 };
    const day = agg.byDate.get(today) || { steps: 0, distance: 0, records: 0 };
    const name = s.realName || s.nickname || s.account || '未命名';
    // 本周跑分 = Σ 各日跑分（口径同 /api/points/me 的 week：只算日跑分，不含达标周的一次性周分）
    // 公式统一取 services/points.js::pointsForDay（不在路由里另写一套）
    let weekPoints = 0;
    if (pointsEnabled && typeof pointsSvc.pointsForDay === 'function') {
      for (const [, d] of agg.byDate) {
        weekPoints += pointsSvc.pointsForDay({ steps: d.steps, goalSteps: dailyTarget, config: pointsConfig }) || 0;
      }
    }
    return {
      userId: String(s._id),
      name,
      studentId: s.studentId || '',
      isClassOfficer: !!s.isClassOfficer,
      todaySteps: day.steps,
      todayDistance: day.distance,
      todayRecords: day.records,
      todayTarget: dailyTarget,
      achievedToday: dailyTarget > 0 && day.steps >= dailyTarget,
      weekSteps: agg.weekSteps,
      weekDistance: agg.weekDistance,
      weekTarget: weeklyTarget,
      achievedWeek: weeklyTarget > 0 && agg.weekSteps >= weeklyTarget,
      activeDays: agg.activeDays,
      avgSteps: agg.activeDays ? round(agg.weekSteps / agg.activeDays) : 0,
      weekPoints,
      lastSyncAt: s.lastSyncAt || null,
      totalSteps: s.totalSteps || 0,
      totalDistance: s.totalDistance || 0,
      totalDays: s.totalDays || 0,
      // 隐私标记（内部用，响应前按角色决定是否遮蔽姓名 / 是否排除出榜单）
      hideName: !!(s.privacy && s.privacy.hideName),
      exitRanking: !!(s.privacy && s.privacy.exitRanking),
    };
  });

  const sum = (fn) => list.reduce((acc, s) => acc + fn(s), 0);
  const studentCount = list.length;
  const achievedToday = list.filter((s) => s.achievedToday).length;
  const achievedWeek = list.filter((s) => s.achievedWeek).length;
  const summary = {
    studentCount,
    // 今日活跃 = 今日有运动记录的学生数（与首页数据概况 distinct openid 同口径）
    activeToday: list.filter((s) => s.todayRecords > 0).length,
    stepsToday: sum((s) => s.todaySteps),
    distanceToday: sum((s) => s.todayDistance),
    recordsToday: sum((s) => s.todayRecords),
    achievedToday,
    dailyRate: studentCount ? Math.round((achievedToday / studentCount) * 100) : 0,
    achievedWeek,
    weeklyRate: studentCount ? Math.round((achievedWeek / studentCount) * 100) : 0,
    totalSteps: sum((s) => s.totalSteps),
    totalDistance: sum((s) => s.totalDistance),
    totalDays: sum((s) => s.totalDays),
    // 班级日均 = 班内学生日均之和 ÷ 班内学生数（与首页班级榜同口径）
    classAvgSteps: studentCount ? round(sum((s) => s.avgSteps) / studentCount) : 0,
    pointsEnabled,
    pointsWeek: sum((s) => s.weekPoints),
  };

  return { className, today, weekStart, list, summary };
}

// ===== 全校班级排名（口径同 /api/admin/dashboard/top3 的班级榜，去掉 limit=3）=====

let classRankCache = { key: '', at: 0, rows: [] };

async function classAvgStepsRows(weekStart, today) {
  const key = `${weekStart}|${today}`;
  if (classRankCache.key === key && Date.now() - classRankCache.at < CLASS_RANK_TTL) return classRankCache.rows;
  const rows = await RunRecord.aggregate([
    { $match: { date: { $gte: weekStart, $lte: today }, steps: { $gt: 0 } } },
    { $group: { _id: '$openid', steps: { $sum: '$steps' }, days: { $sum: 1 } } },
    { $addFields: { avgSteps: { $divide: ['$steps', '$days'] } } },
    { $lookup: { from: 'users', localField: '_id', foreignField: 'openid', as: 'u' } },
    { $addFields: { u: { $arrayElemAt: ['$u', 0] } } },
    // 教师不参与排名；没有班级名的账号不进班级榜
    { $match: { u: { $ne: null }, 'u.className': { $nin: [null, ''] }, $expr: { $ne: ['$u.role', 'teacher'] } } },
    { $group: { _id: '$u.className', activeMembers: { $sum: 1 }, avgSum: { $sum: '$avgSteps' } } },
    {
      $lookup: {
        from: 'users',
        let: { cn: '$_id' },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$className', '$$cn'] }, { $ne: ['$role', 'teacher'] }] } } },
          { $count: 'n' },
        ],
        as: 'sz',
      },
    },
    { $addFields: { total: { $ifNull: [{ $arrayElemAt: ['$sz.n', 0] }, 0] } } },
    { $addFields: { denom: { $cond: [{ $gt: ['$total', 0] }, '$total', '$activeMembers'] } } },
    { $addFields: { avgSteps: { $divide: ['$avgSum', '$denom'] } } },
    { $sort: { avgSteps: -1, activeMembers: -1, _id: 1 } },
    { $project: { _id: 0, className: '$_id', members: '$denom', avgSteps: 1 } },
  ]);
  classRankCache = { key, at: Date.now(), rows };
  return rows;
}

async function globalClassRank(className, weekStart, today) {
  const rows = await classAvgStepsRows(weekStart, today);
  const idx = rows.findIndex((r) => r.className === className);
  return {
    rank: idx >= 0 ? idx + 1 : null, // null = 本班本周还没有任何运动记录，未进入榜单
    total: rows.length,
    avgSteps: idx >= 0 ? round(rows[idx].avgSteps) : 0,
    members: idx >= 0 ? round(rows[idx].members) : 0,
    top: rows.slice(0, 3).map((r, i) => ({
      rank: i + 1,
      className: r.className,
      avgSteps: round(r.avgSteps),
      members: round(r.members),
    })),
  };
}

// ===== 展示映射（按角色处理隐私：班委遮蔽姓名，班主任看真实姓名）=====

function presentStudent(s, { masked }) {
  return {
    userId: s.userId,
    name: masked && s.hideName ? maskName(s.name) : s.name,
    studentId: s.studentId,
    isClassOfficer: s.isClassOfficer,
    todaySteps: s.todaySteps,
    todayDistance: s.todayDistance,
    todayTarget: s.todayTarget,
    achievedToday: s.achievedToday,
    weekSteps: s.weekSteps,
    weekDistance: s.weekDistance,
    weekTarget: s.weekTarget,
    achievedWeek: s.achievedWeek,
    activeDays: s.activeDays,
    avgSteps: s.avgSteps,
    weekPoints: s.weekPoints,
    lastSyncAt: s.lastSyncAt,
    totalSteps: s.totalSteps,
    totalDays: s.totalDays,
  };
}

// ===== 接口 =====

// 我的班级身份（身份探测：无班级身份时也返回 200 + role:null，供客户端/导航判断）
// 返回 { role: 'homeroom' | 'officer' | null, homeroomClasses, officerClass, classes, readonly, className, name }
router.get(
  '/mine',
  wrap(async (req, res) => {
    const { homeroom, officer, all } = accessibleClasses(req.user);
    const role = homeroom.length ? 'homeroom' : officer.length ? 'officer' : null;
    ok(res, {
      role,
      homeroomClasses: homeroom,
      officerClass: officer.length ? officer[0] : '',
      classes: all,
      // 班委仅查看：服务端没有任何写接口，前端据此隐藏全部操作入口
      readonly: role === 'officer',
      className: req.user.className || '',
      name: req.user.realName || req.user.nickname || '',
    });
  })
);

// 班级概况：人数 / 今日活跃 / 今日步数 / 今日记录数 / 达标人数与达标率 / 本周达标率 / 累计 / 班级日均 / 本班跑分 + 全校班级名次
router.get(
  '/overview',
  wrap(async (req, res) => {
    const scope = resolveScope(req.user, req.query.className);
    const stats = await loadClassStats(scope.className);
    const classRank = await globalClassRank(scope.className, stats.weekStart, stats.today);
    ok(res, {
      className: stats.className,
      role: scope.isHomeroom ? 'homeroom' : 'officer',
      canNudge: scope.isHomeroom, // 只有班主任做「督促」，班委仅查看
      date: stats.today,
      weekStart: stats.weekStart,
      ...stats.summary,
      classRank,
    });
  })
);

// 班级学生列表（分页）：今日/本周步数与达标、最近同步时间、是否班委 —— 供班主任督促
// 参数：className / page / limit / keyword（姓名、学号）/ sort=today|week|name|sync|officer
//       achievedToday=0|1（今日未达标 / 已达标，兼容 filter=unachieved|achieved）
// 说明：班级规模有限，先按班装载再在 Node 侧筛选排序分页（达标筛选与排名依赖派生字段，无法下推到 Mongo）
router.get(
  '/students',
  wrap(async (req, res) => {
    const scope = resolveScope(req.user, req.query.className);
    const { page, limit, skip } = parsePagination(req.query, { page: 1, limit: 20 });
    const stats = await loadClassStats(scope.className);
    const masked = !scope.isHomeroom; // 班委是学生：遮蔽开启了「隐藏姓名」的同学

    let list = stats.list;
    const keyword = String(req.query.keyword || '').trim();
    if (keyword) {
      const re = new RegExp(escapeRe(keyword), 'i');
      list = list.filter((s) => re.test(s.name) || re.test(s.studentId) || re.test(s.userId));
    }
    const filter = String(req.query.filter || '');
    const achievedToday = ['0', '1'].includes(String(req.query.achievedToday ?? ''))
      ? String(req.query.achievedToday)
      : filter === 'unachieved'
        ? '0'
        : filter === 'achieved'
          ? '1'
          : '';
    if (achievedToday) {
      const want = achievedToday === '1';
      list = list.filter((s) => s.achievedToday === want);
    }

    const sort = ['today', 'week', 'name', 'sync', 'officer'].includes(String(req.query.sort))
      ? String(req.query.sort)
      : 'today';
    const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const sorted = [...list];
    if (sort === 'today') sorted.sort((a, b) => b.todaySteps - a.todaySteps || byName(a, b));
    else if (sort === 'week') sorted.sort((a, b) => b.weekSteps - a.weekSteps || byName(a, b));
    else if (sort === 'name') sorted.sort(byName);
    else if (sort === 'sync') {
      // 最近同步在前；从未同步（null）排最后
      sorted.sort((a, b) => new Date(b.lastSyncAt || 0) - new Date(a.lastSyncAt || 0) || byName(a, b));
    } else {
      // 班委优先，其余按今日步数
      sorted.sort((a, b) => Number(b.isClassOfficer) - Number(a.isClassOfficer) || b.todaySteps - a.todaySteps || byName(a, b));
    }

    const total = sorted.length;
    const rows = sorted.slice(skip, skip + limit).map((s) => presentStudent(s, { masked }));
    ok(res, {
      className: stats.className,
      role: scope.isHomeroom ? 'homeroom' : 'officer',
      canNudge: scope.isHomeroom,
      date: stats.today,
      weekStart: stats.weekStart,
      sort,
      achievedToday: achievedToday || '',
      page,
      limit,
      total,
      hasMore: skip + rows.length < total,
      list: rows,
    });
  })
);

// 班内学生榜单（本周步数）+ 本班在全校班级排名中的名次
router.get(
  '/ranking',
  wrap(async (req, res) => {
    const scope = resolveScope(req.user, req.query.className);
    const stats = await loadClassStats(scope.className);
    const classRank = await globalClassRank(scope.className, stats.weekStart, stats.today);
    const masked = !scope.isHomeroom;

    // 班委视角排除「不参与排名」的同学（与公开排行榜一致）；班主任仍可看到全部
    const pool = scope.isHomeroom ? stats.list : stats.list.filter((s) => !s.exitRanking);
    const sorted = [...pool].sort(
      (a, b) => b.weekSteps - a.weekSteps || b.todaySteps - a.todaySteps || a.name.localeCompare(b.name)
    );
    const students = sorted.slice(0, TOP_LIMIT).map((s, i) => ({ rank: i + 1, ...presentStudent(s, { masked }) }));

    ok(res, {
      className: stats.className,
      role: scope.isHomeroom ? 'homeroom' : 'officer',
      canNudge: scope.isHomeroom,
      date: stats.today,
      weekStart: stats.weekStart,
      metric: 'week',
      metricText: '本周步数',
      total: sorted.length,
      students,
      classRank,
    });
  })
);

// 某学生的「日 / 周」运动明细（只读）：字段与 /api/admin/users/:id/period 完全一致，前端可直接复用
// 参数：type=day&date=YYYY-MM-DD 或 type=week&weekStart=YYYY-MM-DD(周一)
router.get(
  '/student/:userId/period',
  wrap(async (req, res) => {
    const target = await loadScopedStudent(req.user, req.params.userId, req.query.className);
    const openid = target.openid || '';
    const type = req.query.type === 'week' ? 'week' : 'day';
    let from = String(req.query.date || '').slice(0, 10);
    let to = from;
    if (type === 'week') {
      from = String(req.query.weekStart || '').slice(0, 10);
      if (dates.isValidDateKey(from)) {
        // 归一化到「所在周的周一」再取 7 天（与周记录的 ISO 周口径一致）
        const dt = new Date(`${from}T00:00:00`);
        dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
        from = dates.toDateKey(dt);
        to = dates.addDays(from, 6);
      }
    }
    if (!dates.isValidDateKey(from)) throw new ApiError(400, 400, '日期参数不正确');
    if (!openid) {
      return ok(res, {
        type,
        from,
        to,
        summary: { steps: 0, distance: 0, calories: 0, durationSeconds: 0, recordCount: 0 },
        records: [],
        days: [],
        goalSteps: 0,
        achieved: false,
      });
    }

    const goalsSvc = require('../services/goals');
    const [records, goal] = await Promise.all([
      RunRecord.find({ openid, date: { $gte: from, $lte: to } })
        .sort({ date: 1, createdAt: 1 })
        .select('date source steps distance calories durationSeconds startTime endTime goalAchieved location createdAt')
        .lean(),
      goalsSvc.getEffectiveGoal(openid),
    ]);

    const summary = records.reduce(
      (acc, r) => ({
        steps: acc.steps + (r.steps || 0),
        distance: acc.distance + (r.distance || 0),
        calories: acc.calories + (r.calories || 0),
        durationSeconds: acc.durationSeconds + (r.durationSeconds || 0),
        recordCount: acc.recordCount + 1,
      }),
      { steps: 0, distance: 0, calories: 0, durationSeconds: 0, recordCount: 0 }
    );
    const goalSteps =
      (type === 'week' ? goal && goal.weekly && goal.weekly.steps : goal && goal.daily && goal.daily.steps) || 0;
    const achieved = goalSteps > 0 && summary.steps >= goalSteps;

    const dayMap = new Map();
    for (const r of records) {
      const d = dayMap.get(r.date) || { date: r.date, steps: 0, distance: 0, durationSeconds: 0, recordCount: 0 };
      d.steps += r.steps || 0;
      d.distance += r.distance || 0;
      d.durationSeconds += r.durationSeconds || 0;
      d.recordCount += 1;
      dayMap.set(r.date, d);
    }
    const dayGoal = (goal && goal.daily && goal.daily.steps) || 0;
    const days = [...dayMap.values()]
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .map((d) => ({ ...d, achieved: dayGoal > 0 && d.steps >= dayGoal }));

    ok(res, {
      type,
      from,
      to,
      planName: (goal && goal.planName) || '',
      goalSteps,
      achieved,
      summary,
      days,
      records,
      // 班级视角的附加信息（前端可忽略）
      student: {
        userId: String(target._id),
        name: target.realName || target.nickname || target.account || '未命名',
        studentId: target.studentId || '',
        className: target.className || '',
      },
    });
  })
);

// 某学生明细分页（只读）：type=runs 最近运动 / daily 日记录 / weekly 周记录，字段与
// /api/admin/users/:id/records 的对应类型一致（班级监控只需要运动类，饮水/徽章不在此提供）
router.get(
  '/student/:userId/records',
  wrap(async (req, res) => {
    const target = await loadScopedStudent(req.user, req.params.userId, req.query.className);
    const openid = target.openid || '';
    const type = ['runs', 'daily', 'weekly'].includes(String(req.query.type)) ? String(req.query.type) : 'runs';
    const { page, limit, skip } = parsePagination(req.query, { page: 1, limit: 20 });
    if (!openid) return ok(res, { type, list: [], total: 0, page, limit, hasMore: false });

    const goalsSvc = require('../services/goals');
    const goal = await goalsSvc.getEffectiveGoal(openid);
    const dailyGoal = (goal && goal.daily && goal.daily.steps) || 0;
    const weeklyGoal = (goal && goal.weekly && goal.weekly.steps) || 0;

    if (type === 'runs') {
      const [list, total] = await Promise.all([
        RunRecord.find({ openid })
          .sort({ date: -1, createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .select('date source steps distance durationSeconds calories pace goalAchieved')
          .lean(),
        RunRecord.countDocuments({ openid }),
      ]);
      return ok(res, { type, list, total, page, limit, hasMore: skip + list.length < total });
    }

    if (type === 'daily') {
      const groupStage = {
        $group: {
          _id: '$date',
          steps: { $sum: '$steps' },
          distance: { $sum: '$distance' },
          recordCount: { $sum: 1 },
          werunAchieved: { $max: { $cond: [{ $eq: ['$source', 'werun'] }, '$goalAchieved', false] } },
        },
      };
      const [rows, countAgg] = await Promise.all([
        RunRecord.aggregate([
          { $match: { openid } },
          groupStage,
          { $sort: { _id: -1 } },
          { $skip: skip },
          { $limit: limit },
        ]),
        RunRecord.aggregate([{ $match: { openid } }, groupStage, { $count: 'n' }]),
      ]);
      const list = rows.map((d) => ({
        date: d._id,
        steps: d.steps,
        distanceKm: ((d.distance || 0) / 1000).toFixed(2),
        recordCount: d.recordCount,
        achieved: !!d.werunAchieved || (dailyGoal > 0 && d.steps >= dailyGoal),
      }));
      const total = countAgg[0]?.n || 0;
      return ok(res, { type, list, total, page, limit, hasMore: skip + list.length < total });
    }

    // weekly：Mongo 侧按 ISO 周（周一起始）分组后分页，周起止在 Node 侧算出
    const weekStage = {
      $group: {
        _id: {
          y: { $isoWeekYear: { $dateFromString: { dateString: '$date' } } },
          w: { $isoWeek: { $dateFromString: { dateString: '$date' } } },
        },
        steps: { $sum: '$steps' },
        distance: { $sum: '$distance' },
        activeDays: { $sum: 1 },
      },
    };
    const [rows, countAgg] = await Promise.all([
      RunRecord.aggregate([
        { $match: { openid } },
        weekStage,
        { $sort: { '_id.y': -1, '_id.w': -1 } },
        { $skip: skip },
        { $limit: limit },
      ]),
      RunRecord.aggregate([{ $match: { openid } }, weekStage, { $count: 'n' }]),
    ]);
    const list = rows.map((r) => {
      const range = isoWeekRange(r._id.y, r._id.w);
      return {
        weekStart: range.start,
        weekEnd: range.end,
        steps: r.steps,
        distance: r.distance,
        activeDays: r.activeDays,
        achieved: weeklyGoal > 0 && r.steps >= weeklyGoal,
      };
    });
    const total = countAgg[0]?.n || 0;
    ok(res, { type, list, total, page, limit, hasMore: skip + list.length < total });
  })
);

module.exports = router;
