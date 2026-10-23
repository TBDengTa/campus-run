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
 * 本路由的写接口只有三处，且都是**班主任专属**（班委一律只读，由接口形态保证）：
 *   PUT /profile   —— 本班班级属性（早操 / 校园跑 / 应住人数 / 教室 / 备注）
 *   PUT /sanitary  —— 本班负责的卫生区（只改本班在 classNames 里的存在与 weights，不动别的班）
 *   其余全部只读。班主任的「督促」只是前端用列表数据生成名单文案（复制到剪贴板），服务端没有端点。
 * 「督促」入口在产品上属于校园跑（督促的就是「校园跑今日未达标」），前端把它放在校园跑 tab，
 * 取数仍复用本接口的 achievedToday=0 筛选 —— 没有为督促新增任何接口或字段。
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
 *   GET /students 每行的 roomText（宿舍）不参与遮蔽 —— 它是房间号，不是身份信息；
 *   「不住宿的学生不给值」，前端据此不渲染，列表里不会出现「未分配」这种噪音。
 */
const express = require('express');
const mongoose = require('mongoose');
const { wrap, ok, ApiError, parsePagination } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const dates = require('../utils/dates');
const User = require('../models/user');
const RunRecord = require('../models/run-record');
const WaterRecord = require('../models/water-record');
const UserBadge = require('../models/user-badge');
const Badge = require('../models/badge');
const GoalConfig = require('../models/goal-config');
const UserGoal = require('../models/user-goal');
// 班超检查（班级考勤汇总用）：明细口径统一走 services/check-modules.js，不在本文件另写一套公式
const CheckRecord = require('../models/check-record');
const ClassProfile = require('../models/class-profile');
// 卫生区（包干区）：关系存在**区域侧**（sanitary_areas.classNames 数组 + weights 按班权重），
// 与管理端 GET/PUT /api/admin/class/profiles/:id/sanitary 读的是同一张表、同一套语义（字段名也一致），
// 区别只在权限：这里是成员资格校验（班主任可写 / 班委只读），那边是 class.view / class.manage。
const SanitaryArea = require('../models/sanitary-area');
const checkModules = require('../services/check-modules');
// 名单每行的宿舍（「1号楼·201」）：权威数据在 dorm_assignments（学生 ↔ 房间，存在混宿），
// 展示口径只读复用 services/dorms.js::roomLabel —— 那个文件不在本页职责内，禁止改。
const DormAssignment = require('../models/dorm-assignment');
const dorms = require('../services/dorms');
// 年级推导（grade 为空时按班级名兜底）：与 services/roster.js 同一口径，
// 班级域与管理端 /api/admin/class/... 的 presentProfile 必须一致，否则两条路径渲染出的年级会不一样
const roster = require('../services/roster');
// 人数实时统计（应到 = 学籍人数，应住 = 住宿名单人数）：与管理端同一口径
const { liveCount } = require('../services/class-counts');
// 班主任「管理本班学生」的判定与实现（权限唯一口径见 services/student-scope.js）：
// 这些动作（编辑资料 / 重置密码 / 发徽章 / 限制 / 删除）与管理端共用同一份 service，
// 班级域只负责「是不是本班班主任 + 目标是不是普通学生」的鉴权。
const studentScope = require('../services/student-scope');
const accountAdmin = require('../services/user-account-admin');
const manualBadges = require('../services/user-badges-manual');
const anticheat = require('../services/anticheat');
// 宿舍（住宿记录）的读写唯一实现：班主任给本班学生安排住宿，与管理端共用，
// 并负责把楼名清单一起下发（教师不需要 building.view）
const studentDorm = require('../services/student-dorm');

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
  'openid realName nickname account studentId className isClassOfficer totalSteps totalDistance totalDays lastSyncAt privacy avatarUrl';

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
    .select('openid className role realName nickname account studentId privacy')
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
      // openid 只在**服务端内部**流转（宿舍 join 的键），presentStudent 不下发它
      openid: s.openid || '',
      name,
      studentId: s.studentId || '',
      avatarUrl: s.avatarUrl || '',
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

function presentStudent(s, { masked, roomText, unionText }) {
  return {
    userId: s.userId,
    name: masked && s.hideName ? maskName(s.name) : s.name,
    studentId: s.studentId,
    // 宿舍（「1号楼·201」）：只由 GET /students 传入（当页一次 $in 查询后按 openid join）。
    // 榜单等其它出口不传 → 空串，前端 wx:if 判空即不渲染；没住宿的学生同样是空串。
    roomText: roomText || '',
    // 学生会职务（「生活部 · 部长」）：同 roomText 口径，只有 GET /students 传入。
    unionText: unionText || '',
    // 头像与管理端用户列表同口径（取用户 avatarUrl，没有则空串→前端回退姓名首字）
    avatarUrl: s.avatarUrl || '',
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

// 宿舍（学生 ↔ 房间，权威数据在 dorm_assignments）：openid → 「1号楼·201」
// 一次 $in 查询 + Map join，**不做 N+1**：调用方只给当页（≤100 人）的 openid，
// 在住口径 status in ['checked_in','guest']（与 services/dorms.js 同一套；换房后的 moved/退宿不算在住）。
// 唯一键 uniq_dorm_active 保证「一人一条在住」，所以这里取第一条即可；没住宿的不进 Map（前端就不显示）。
async function roomTextByOpenid(openids) {
  const map = new Map();
  const ids = [...new Set((openids || []).filter(Boolean))];
  if (!ids.length) return map;
  const rows = await DormAssignment.find({ openid: { $in: ids }, status: { $in: ['checked_in', 'guest'] } })
    .select('openid buildingId buildingName roomNo')
    .lean();
  for (const r of rows) {
    if (map.has(r.openid)) continue; // 一人一条在住（库层唯一约束）；真出现脏数据时保留第一条，不覆盖
    const text = dorms.roomLabel(r);
    if (text) map.set(r.openid, text);
  }
  return map;
}

// 学生会职务（学生 → 「主席团 · 主席」）：与 roomTextByOpenid 同一模式，
// 一次查询 + Map join，不做 N+1。多职务取第一条（展示用，完整列表看管理端详情）。
// ⚠️ 关联键必须**双路**：openid 或 userId 任一命中。成员记录的 openid 是建档时从学生账号
// 拷贝的快照 —— 学生没绑微信时它是空串（实测踩过：冒烟班成员 openid=''），
// 只按 openid join 会让这些成员永远查不到职务；userId 才是建档就有的稳定键。
async function unionTextByStudents(students) {
  const map = new Map(); // key: openid 或 userId 字符串
  const openids = [...new Set((students || []).map((s) => s.openid).filter(Boolean))];
  const userIds = [...new Set((students || []).map((s) => String(s.userId || '')).filter((v) => mongoose.isValidObjectId(v)))];
  if (!openids.length && !userIds.length) return map;
  const UnionMember = require('../models/union-member');
  const or = [];
  if (openids.length) or.push({ openid: { $in: openids } });
  if (userIds.length) or.push({ userId: { $in: userIds } });
  const rows = await UnionMember.find({ status: 'active', $or: or })
    .select('openid userId deptKey deptName role')
    .sort({ level: 1, createdAt: 1 })
    .lean();
  for (const r of rows) {
    const dept = r.deptName || (r.deptKey === 'presidium' ? '主席团' : '');
    const role = UnionMember.ROLE_TEXT[r.role] || r.role;
    const text = [dept, role].filter(Boolean).join(' · ');
    if (!text) continue;
    // 同一个人的两个键都登记（后面按 s.openid / s.userId 任一都能命中）；先到先得 = 排序后的第一条职务
    const keys = [r.openid, r.userId ? String(r.userId) : ''].filter(Boolean);
    for (const k of keys) {
      for (const k2 of keys) if (!map.has(k2)) map.set(k2, text);
    }
  }
  return map;
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

// ===== 班级配置（本方案里班级域**唯一**的写接口）=====
//
// 为什么必须开这个口子：班超的「本班有没有早操」「参不参加校园跑」是**班级属性**，
// 只有班主任最清楚。若只让管理端配（/api/admin/class/:profile，需要 class.manage），
// 那么「被设为班主任但没有管理权限」的教师就永远改不了自己班的早操标记 —— 而这正是新功能的核心。
//
// 权限：**仅班主任**（user.homeroomClasses 包含目标班级）可写；班委只读（403002）。
// 刻意不使用 requirePermission：与文件头「班级域用成员资格校验」的模型保持一致。
// 可改字段**白名单**：只放班级属性，不放班级名（班级名由学籍推导，改它会让所有历史数据对不上）。
// dormCount 已从白名单移除：应住人数由住宿名单实时统计，不允许自助填写（用户要求「自动识别」）
const PROFILE_FIELDS = ['hasMorningExercise', 'hasNightStudy', 'hasMorningRun', 'classroom', 'remark'];
// 两个人数是系统自动识别的只读项：误传时给明确报错，不要静默忽略
const PROFILE_COUNT_FIELDS = ['studentCount', 'dormCount'];
// 卫生区**不在**上面这个白名单里：它是独立资源（sanitary_areas 一张表，多班共管 + 按班权重），
// 走下面的 GET/PUT /sanitary，不要往这里加。

async function loadOrInitProfile(className) {
  const ClassProfile = require('../models/class-profile');
  let profile = await ClassProfile.findOne({ className });
  if (!profile) {
    // 台账缺失（例如刚导入名单还没跑同步）：按学籍即时补一条，避免班主任看到一个空页面
    const svc = require('../services/class-profiles');
    await svc.syncClassProfiles({ className }).catch(() => null);
    profile = await ClassProfile.findOne({ className });
  }
  return profile;
}

function presentProfile(profile, className, live) {
  return {
    className,
    exists: !!profile,
    hasMorningExercise: profile ? profile.hasMorningExercise !== false : true,
    hasMorningRun: profile ? profile.hasMorningRun !== false : true,
    // 晚自习开关（与早操/早八同构）。前端班级配置页此前**没有这个开关**，
    // 后端字段虽已存在（hasNightStudy）但 PUT 白名单未放行 → 老师根本关不掉（用户报的 BUG）。
    hasNightStudy: profile ? profile.hasNightStudy !== false : true,
    // 人数一律取实时统计（学籍 / 住宿名单），台账快照值只做兜底
    studentCount: live ? live.studentCount : profile ? profile.studentCount || 0 : 0,
    dormCount: live ? live.dormCount : profile ? profile.dormCount || 0 : 0,
    studentCountEditable: false,
    dormCountEditable: false,
    // 教室：与管理端 GET/PUT /api/admin/class/... 同名字段（两条路径共用一套表单渲染，不能一个有一个没有）
    classroom: (profile && profile.classroom) || '',
    departmentName: (profile && profile.departmentName) || '',
    // 年级：存量数据 grade 常为空，按班级名推导兜底（与管理端 presentProfile 同口径）
    grade: (profile && (roster.normalizeGrade(profile.grade) || roster.gradeFromClassName(className))) || '',
    specialty: (profile && profile.specialty) || '',
    homeroomNames: (profile && profile.homeroomNames) || [],
    remark: (profile && profile.remark) || '',
  };
}

// 读本班配置（班主任 / 班委都可读）
router.get(
  '/profile',
  wrap(async (req, res) => {
    const scope = resolveScope(req.user, req.query.className);
    const profile = await loadOrInitProfile(scope.className);
    const live = await liveCount(scope.className);
    ok(res, {
      ...presentProfile(profile, scope.className, live),
      role: scope.isHomeroom ? 'homeroom' : 'officer',
      canEdit: scope.isHomeroom, // 班委只读
    });
  })
);

// 改本班配置（仅班主任）
router.put(
  '/profile',
  wrap(async (req, res) => {
    const scope = resolveScope(req.user, req.body && req.body.className);
    if (!scope.isHomeroom) throw new ApiError(403, 403002, '只有班主任可以修改班级配置');
    const profile = await loadOrInitProfile(scope.className);
    if (!profile) throw new ApiError(404, 404, '班级台账生成失败，请稍后重试');

    const body = req.body || {};
    // 人数是自动识别的只读项：误传时明确报错，避免「看起来保存成功」
    if (PROFILE_COUNT_FIELDS.some((k) => body[k] !== undefined)) {
      throw new ApiError(400, 400, '应到 / 应住人数由学籍与住宿名单自动识别，不支持手工设置');
    }
    const changed = {};
    for (const key of PROFILE_FIELDS) {
      if (body[key] === undefined) continue;
      if (key === 'hasMorningExercise' || key === 'hasNightStudy' || key === 'hasMorningRun') {
        const next = body[key] !== false;
        if (profile[key] !== next) changed[key] = next;
        profile[key] = next;
      } else {
        // 字符串字段（remark / classroom）：**必须按 key 写回各自的字段**。
        // 这里曾经是写死的 `changed.remark / profile.remark` —— 白名单加了 classroom 之后，
        // 老师改教室会把备注整段覆盖掉（看着保存成功、数据被悄悄改坏）。
        const maxLen = key === 'classroom' ? 40 : 200;
        const next = String(body[key] || '').trim().slice(0, maxLen);
        if ((profile[key] || '') !== next) changed[key] = next;
        profile[key] = next;
      }
    }
    if (Object.keys(changed).length) {
      await profile.save();
      // 班级属性（是否有早操 / 是否参跑）会影响「录入台对象列表」与「班级排名分母」，
      // 这两处都有 60s 进程内缓存，改完必须失效 —— 否则班主任改完觉得「没生效」
      clearClassCaches();
    }
    const live = await liveCount(scope.className);
    ok(res, { ...presentProfile(profile, scope.className, live), role: 'homeroom', canEdit: true, changed });
  })
);

// ===== 本班的卫生区（包干区）=====
//
// 为什么单独成一组端点、而不是塞进 PROFILE_FIELDS：卫生区是**独立资源**（一张 sanitary_areas 表，
// 多班共管 + 按班权重），不是班级台账上的标量字段。放进白名单的话，PUT /profile 就得接收数组并
// 在这里写另一张表 —— 一个端点两套语义，前端「保存配置」也会把配置和区域绑定混成一次提交。
//
// 关系存在**区域侧**（sanitary_areas.classNames 数组 + weights 按班权重），本组端点只提供
// 「按班看 / 按班改」的视图：改的是「本班加入了哪些区域」，**绝不动其他班的归属与权重**。
// 语义与管理端 GET/PUT /api/admin/class/profiles/:id/sanitary 一致（字段名也一致），
// 权限刻意不同：这里是班级域成员资格校验 —— 班主任可写（不需要 class.manage），班委只读。

// 区域类型标签由前端映射（与管理端同一套 key：classroom / outdoor / corridor / canteen / other）

// 单条区域的班级视角：weight = 本班权重（缺省 1），sharedWith = 除本班外还有几个班共用
// （>0 时前端要提示「本班只按权重分摊」，否则老师以为整区扣分都算自己班）
function presentAreaBrief(a, className) {
  const weight = a.weights && typeof a.weights === 'object' ? Number(a.weights[className]) : NaN;
  const others = (a.classNames || []).filter((c) => c !== className);
  return {
    id: String(a._id),
    name: a.name,
    areaType: a.areaType || 'outdoor',
    location: a.location || '',
    sharedWith: others.length,
    weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
  };
}

// 班级属性（是否有早操 / 是否参跑 / 卫生区归属）会影响「录入台对象列表」与「班级排名分母」，
// 这两处都有 60s 进程内缓存 → 改完必须失效（与 PUT /profile、管理端 clearBandChaoCaches 同一处理）
function clearClassCaches() {
  try {
    require('../services/band-chao').clearRankCache();
  } catch (e) {
    /* 缓存清理是可选能力：服务缺失时忽略 */
  }
  try {
    const svc = require('../services/class-profiles');
    if (typeof svc.clearProfileCache === 'function') svc.clearProfileCache();
  } catch (e) {
    /* 同上 */
  }
}

// 读本班负责的卫生区（班主任 / 班委都可读；班委只读）
router.get(
  '/sanitary',
  wrap(async (req, res) => {
    const scope = resolveScope(req.user, req.query.className);
    const className = scope.className;
    const [mine, all] = await Promise.all([
      SanitaryArea.find({ classNames: className, enabled: { $ne: false } }).sort({ areaType: 1, name: 1 }).lean(),
      SanitaryArea.find({ enabled: { $ne: false } }).sort({ areaType: 1, name: 1 }).limit(300).lean(),
    ]);
    ok(res, {
      className,
      role: scope.isHomeroom ? 'homeroom' : 'officer',
      canEdit: scope.isHomeroom, // 班委只读（与管理端 canEdit 同义）
      mine: mine.map((a) => presentAreaBrief(a, className)),
      // 候选：全部启用区域（区域量级小，不分页；前端按 mine 勾选）
      options: all.map((a) => ({
        id: String(a._id),
        name: a.name,
        areaType: a.areaType || 'outdoor',
        location: a.location || '',
      })),
    });
  })
);

// 设置本班负责的卫生区（**仅班主任**）：{ className, areaIds: [], newAreas: [{ name, areaType, location }] }
// · 只增删**本班**在 classNames 里的存在与 weights，其他班的归属与权重一概不动；
// · newAreas 是「就地新建并绑定」：全校卫生区目前没有独立维护页（管理端那边也一样支持就地新建），
//   不支持的话新学校老师打开就是一个空列表 —— 想给班级设卫生区却无处可设；
// · 同名区域复用已有的（不重复建），新建区域默认 classNames: [本班]。
router.put(
  '/sanitary',
  wrap(async (req, res) => {
    const scope = resolveScope(req.user, req.body && req.body.className);
    if (!scope.isHomeroom) throw new ApiError(403, 403002, '只有班主任可以设置本班卫生区');
    const className = scope.className;
    const body = req.body || {};

    // 新建区域要带上院校 / 系部归属：只读台账，缺失时留空（**不**在这里触发台账初始化，
    // 卫生区不该因为台账还没生成就不能设）
    const profile = await ClassProfile.findOne({ className }).lean();

    const created = [];
    const wanted = [...new Set((Array.isArray(body.areaIds) ? body.areaIds : []).map((x) => String(x)))].filter((x) =>
      mongoose.isValidObjectId(x)
    );

    // 新建区域：同名区域已存在就不重复建（老师手打很容易撞上已有名字）
    const news = (Array.isArray(body.newAreas) ? body.newAreas : []).slice(0, 20);
    for (const raw of news) {
      const name = String((raw && raw.name) || '').trim().slice(0, 40);
      if (!name) continue;
      const hit = await SanitaryArea.findOne({ name }).lean();
      if (hit) {
        wanted.push(String(hit._id));
        continue;
      }
      const doc = await SanitaryArea.create({
        name,
        areaType: String((raw && raw.areaType) || '').trim().slice(0, 16) || 'outdoor',
        location: String((raw && raw.location) || '').trim().slice(0, 60),
        classNames: [className],
        departmentId: (profile && profile.departmentId) || null,
        departmentName: (profile && profile.departmentName) || '',
      });
      created.push(name);
      wanted.push(String(doc._id));
    }

    const wantedSet = new Set(wanted);
    const areas = await SanitaryArea.find({ enabled: { $ne: false } }).lean();
    const added = [];
    const removed = [];
    for (const a of areas) {
      const has = (a.classNames || []).includes(className);
      const should = wantedSet.has(String(a._id));
      if (has === should) continue;
      const classNames = new Set(a.classNames || []);
      const weights = a.weights && typeof a.weights === 'object' ? { ...a.weights } : {};
      if (should) {
        classNames.add(className);
        if (!created.includes(a.name)) added.push(a.name);
      } else {
        classNames.delete(className);
        delete weights[className]; // 移出的班不再参与分摊
        removed.push(a.name);
      }
      await SanitaryArea.updateOne({ _id: a._id }, { $set: { classNames: [...classNames], weights } });
    }
    if (added.length || removed.length || created.length) clearClassCaches();
    ok(res, { className, added, removed, created });
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

// 班级学生列表（分页）：今日/本周步数与达标、最近同步时间、是否班委、宿舍 roomText —— 供班主任督促
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
    const pageRows = sorted.slice(skip, skip + limit);
    // 宿舍：只对**当页**学生的 openid 查一次（禁止 N+1），再按 openid join 回来。
    // 与 masked 判定无关：房间号不是身份信息，班委视角同样展示（班主任也要靠它认人）。
    const roomBy = await roomTextByOpenid(pageRows.map((s) => s.openid));
    // 学生会身份：同样只查当页一次（openid / userId 双路 join，见 unionTextByStudents）。
    // 班级视角的用户详情也要能看到「学生会 · 职务」，班主任靠它认人。
    const unionBy = await unionTextByStudents(pageRows);
    const unionOf = (s) => unionBy.get(s.openid) || unionBy.get(String(s.userId)) || '';
    const rows = pageRows.map((s) =>
      presentStudent(s, { masked, roomText: roomBy.get(s.openid) || '', unionText: unionOf(s) })
    );
    ok(res, {
      className: stats.className,
      role: scope.isHomeroom ? 'homeroom' : 'officer',
      canNudge: scope.isHomeroom,
      // 班主任可对**本班学生**做管理动作（编辑资料/重置密码/发徽章/限制/删除）：
      // 这里是**行级提示**，真正鉴权在 /api/class/student/:userId/* 与 services/student-scope.js；
      // 班委恒 false（只读）。
      canManage: scope.isHomeroom,
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

// 某学生明细分页（只读）：type=runs 最近运动 / daily 日记录 / weekly 周记录 / water 饮水 / badges 徽章，
// 字段与 /api/admin/users/:id/records 的对应类型完全一致（班委也能看饮水与徽章，只是没有任何写操作）
router.get(
  '/student/:userId/records',
  wrap(async (req, res) => {
    const target = await loadScopedStudent(req.user, req.params.userId, req.query.className);
    const openid = target.openid || '';
    const type = ['runs', 'daily', 'weekly', 'water', 'badges'].includes(String(req.query.type))
      ? String(req.query.type)
      : 'runs';
    const { page, limit, skip } = parsePagination(req.query, { page: 1, limit: 20 });
    if (!openid) return ok(res, { type, list: [], total: 0, page, limit, hasMore: false });

    // ===== 饮水 / 徽章：与管理端同字段（不需要目标值，提前返回）=====
    if (type === 'water') {
      const [rows, total] = await Promise.all([
        WaterRecord.find({ openid }).sort({ date: -1 }).skip(skip).limit(limit).select('date total target').lean(),
        WaterRecord.countDocuments({ openid }),
      ]);
      const list = rows.map((w) => ({
        ...w,
        percent: w.target ? Math.min(100, Math.round((w.total / w.target) * 100)) : 0,
      }));
      return ok(res, { type, list, total, page, limit, hasMore: skip + list.length < total });
    }

    if (type === 'badges') {
      const [allBadges, earned] = await Promise.all([
        Badge.find({ enabled: true }).sort({ sort: 1 }).lean(),
        UserBadge.find({ openid }).lean(),
      ]);
      const byKey = new Map(earned.map((b) => [b.badgeKey, b]));
      const badges = allBadges
        .filter((b) => byKey.has(b.key))
        .map((b) => ({
          key: b.key,
          name: b.name,
          icon: b.icon,
          tierColor: b.tierColor,
          earnedAt: byKey.get(b.key).createdAt,
        }))
        .sort((a, b) => new Date(b.earnedAt) - new Date(a.earnedAt));
      const list = badges.slice(skip, skip + limit);
      return ok(res, { type, list, total: badges.length, page, limit, hasMore: skip + list.length < badges.length });
    }

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

// 某条运动记录详情（班级域只读，字段与 /api/admin/users/:id/runs/:runId 一致，含 ownerName）
// 两道校验：① 目标学生必须属于「我可管的班级」（loadScopedStudent，与其它班级域接口同一套成员资格校验）；
//           ② 该 runId 必须属于这名学生（RunRecord.findOne({_id, openid})），防止跨用户拿别人的记录
router.get(
  '/student/:userId/run/:runId',
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.runId)) throw new ApiError(404, 404, '记录不存在');
    const target = await loadScopedStudent(req.user, req.params.userId, req.query.className);
    const record = await RunRecord.findOne({ _id: req.params.runId, openid: target.openid || '' }).lean();
    if (!record) throw new ApiError(404, 404, '记录不存在');
    // 班委是学生：姓名遮蔽口径与列表/榜单一致（班主任看真实姓名）
    const { homeroom } = accessibleClasses(req.user);
    const masked = !homeroom.includes(target.className);
    const rawName = target.realName || target.nickname || target.account || '';
    ok(res, {
      ...record,
      ownerName: masked && target.privacy && target.privacy.hideName ? maskName(rawName) : rawName,
    });
  })
);

// ===== 班级考勤汇总（班主任 / 班委只读）=====
//
// 数据来源：check_records（status in ['submitted','approved'] 且 voided != true）。
//   cancelled（早操临时取消）与 rejected（被退回）**退出统计**，不进分母 —— 沿用方案 §4.4 的口径。
// 分母口径：
//   早操 / 早八 = 应到人数（class_profiles.hasMorningExercise / hasMorningClass === false 的班级整段跳过，
//   既不算 0 也不进平均，否则「本来就没有早操」的班级会永远拖着班级平均分）；
//   晚自习 = 应到 + 插班净额；查宿 = 应住。
// 出勤率：优先取记录里服务端算好的快照（metrics.ratios.rate），快照缺失时按当前模块定义重算，
//   两条路的公式都来自 check_modules.metrics（禁止在本文件另写公式）。
// 索引：查询是 className + date 区间 + moduleKey，命中 check_records 的 { className, date, moduleKey } 复合索引。
const ATTENDANCE_MODULES = ['morning_exercise', 'morning_class', 'study_evening', 'night_dorm'];
const ATTENDANCE_MAX_DAYS = 92; // 单次最多 92 天（一个季度）：再大就是全学期扫描，没必要
const ATTENDANCE_DEFAULT_DAYS = 7; // 不传 from/to 时默认「近 7 天」（含今天）
const ATTENDANCE_MAX_RECORDS = 2000; // 区间内记录数上限（4 模块 × 92 天足够；防异常数据撑爆响应）
const WEEKDAY_TEXT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
// 比率（0~1）保留 4 位小数：只保留 1 位的话 0.975 会被四舍五入成 1，百分比就丢掉精度了
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000) + 1;

// 出勤率指标名（查宿模块的第一个指标是「未归」，不能直接取 metrics[0]，要按 key=rate 找）
function rateMetricOf(moduleDef) {
  const metrics = moduleDef.metrics || [];
  return metrics.find((m) => m.key === 'rate') || metrics.find((m) => (m.unit || '') === '%') || {};
}

// 枚举区间内的日历键：**没有记录的日期也补成一行**，前端「近 7 天」列表不用自己补空
function dateKeysBetween(from, to) {
  const keys = [];
  for (let k = from; k <= to && keys.length < ATTENDANCE_MAX_DAYS; k = dates.addDays(k, 1)) keys.push(k);
  return keys;
}

// 单条记录的考勤人数：**统一走 fillDerived 重算**（老记录里可能存着当年客户端手填的缺勤人数，
// 一律按当前口径覆盖，保证接口输出与口径表逐字一致）
//
// ⚠️ 字段口径变更：旧的 actualStay / leaveStayCount / transferIn / transferOut /
//   violationCount / lateReturnCount / earlyLeaveCount 已从模块定义里删除；
//   第五轮起实到（actualCount）也改成 derived（选缺勤/未归名单自动推算），只在录入/回读时由
//   fillDerived 统一给出，这里按新字段读。老记录里那些旧键读出来是 0（不会报错，但也别再依赖）。
function attendanceNumbers(moduleKey, rawDetails, ctx) {
  const d = checkModules.fillDerived(moduleKey, rawDetails || {}, ctx || {});
  const num = (k) => Number(d[k]) || 0;
  if (moduleKey === 'night_dorm') {
    const notReturned = num('notReturnedCount');
    return {
      should: num('shouldStay'),
      actual: num('actualCount'),
      absent: notReturned, // 查宿的「缺勤」即未归，两个字段都给，前端不用按模块分支
      notReturned,
      leave: 0,
      late: 0,
      earlyLeave: 0,
      violationCount: 0,
      denominator: num('shouldStay'),
    };
  }
  if (moduleKey === 'study_evening') {
    // 第四轮：不再有插班/请假/在教室口径，只有「实到人数」（网课时为 0，不设分母）
    return {
      should: num('shouldCount'),
      actual: num('actualCount'),
      absent: num('absentCount'),
      notReturned: 0,
      leave: 0,
      late: 0,
      earlyLeave: 0,
      violationCount: 0,
      denominator: num('shouldCount'),
    };
  }
  if (moduleKey === 'morning_class') {
    // 早八：只记迟到人（无法同步课表），没有应到/实到
    return {
      should: 0,
      actual: 0,
      absent: 0,
      notReturned: 0,
      leave: 0,
      late: num('lateCount'),
      earlyLeave: 0,
      violationCount: 0,
      denominator: 0,
    };
  }
  // 早操
  return {
    should: num('shouldCount'),
    actual: num('actualCount'),
    absent: num('absentCount'),
    notReturned: 0,
    leave: 0,
    late: 0,
    earlyLeave: 0,
    violationCount: 0,
    denominator: num('shouldCount'),
  };
}

// 出勤率（0~1，允许 >1 时截断到 1.5，与 computeMetrics 的 ratios 同口径）
function attendanceRate(moduleDef, rawDetails, snapshot) {
  const fromSnapshot = snapshot && snapshot.ratios ? Number(snapshot.ratios.rate) : NaN;
  if (Number.isFinite(fromSnapshot)) return Math.max(0, Math.min(1.5, fromSnapshot));
  const details = checkModules.fillDerived(moduleDef.key, rawDetails || {});
  const { ratios } = checkModules.computeMetrics(moduleDef, details);
  const v = Number(ratios.rate);
  return Number.isFinite(v) ? Math.max(0, Math.min(1.5, v)) : 0;
}

// 同一天同一模块的多条记录（多时段 / 多检查小组）：人数相加，出勤率按应到人数加权平均
function buildDayModule(moduleDef, items) {
  const sum = (pick) => items.reduce((a, x) => a + pick(x.numbers), 0);
  const should = sum((n) => n.should);
  const denominator = sum((n) => n.denominator);
  let rate;
  if (items.length === 1) rate = items[0].rate;
  else if (denominator > 0) rate = items.reduce((a, x) => a + x.rate * x.numbers.denominator, 0) / denominator;
  else rate = items.reduce((a, x) => a + x.rate, 0) / items.length;
  const statuses = [...new Set(items.map((x) => x.record.status))];
  return {
    moduleKey: moduleDef.key,
    name: moduleDef.shortName || moduleDef.name,
    rateName: rateMetricOf(moduleDef).name || '出勤率',
    should,
    actual: sum((n) => n.actual),
    absent: sum((n) => n.absent),
    notReturned: sum((n) => n.notReturned),
    leave: sum((n) => n.leave),
    late: sum((n) => n.late),
    earlyLeave: sum((n) => n.earlyLeave),
    violationCount: sum((n) => n.violationCount),
    rate: round4(rate),
    ratePercent: round1(rate * 100),
    status: statuses.length === 1 ? statuses[0] : 'mixed', // 多条记录状态不一致时给 mixed
    recordId: String(items[0].record._id),
    recordCount: items.length,
  };
}

// 班级考勤汇总：按日 × 模块给出应到 / 实到 / 缺勤 / 未归 / 出勤率，供班超块与「班级考勤」tab 展示
// 参数：className（多班班主任必填）、from / to（YYYY-MM-DD，默认近 7 天）
router.get(
  '/attendance',
  wrap(async (req, res) => {
    // 成员资格校验：目标班级必须在我可管的范围内（班主任 homeroomClasses / 班委本班），否则 403002
    const scope = resolveScope(req.user, req.query.className);
    const className = scope.className;

    const today = dates.todayKey();
    const to = dates.isValidDateKey(String(req.query.to || '').slice(0, 10)) ? String(req.query.to).slice(0, 10) : today;
    const fromRaw = String(req.query.from || '').slice(0, 10);
    const from = dates.isValidDateKey(fromRaw) ? fromRaw : dates.addDays(to, -(ATTENDANCE_DEFAULT_DAYS - 1));
    if (from > to) throw new ApiError(400, 400, '起始日期不能晚于结束日期');
    if (daysBetween(from, to) > ATTENDANCE_MAX_DAYS) {
      throw new ApiError(400, 400, `单次最多查询 ${ATTENDANCE_MAX_DAYS} 天，请缩小日期范围`);
    }

    const [modules, profile, records] = await Promise.all([
      checkModules.listModules(),
      ClassProfile.findOne({ className }).lean(),
      CheckRecord.find({
        className,
        date: { $gte: from, $lte: to },
        moduleKey: { $in: ATTENDANCE_MODULES },
        status: { $in: CheckRecord.COUNTED_STATUS }, // submitted / approved；cancelled、rejected 一律不进分母
        voided: { $ne: true },
      })
        .select('moduleKey date period details metrics status')
        .sort({ date: 1 })
        .limit(ATTENDANCE_MAX_RECORDS)
        .lean(),
    ]);
    const moduleBy = new Map(modules.map((m) => [m.key, m]));

    // 无早操 / 无早八 / 无晚自习的班级：整段跳过并给出原因（与 services/band-chao.js 的 skippedReason 同口径）
    const skipped = {};
    if (profile && profile.hasMorningExercise === false) skipped.morning_exercise = '本班无早操';
    if (profile && profile.hasMorningClass === false) skipped.morning_class = '本班无早八';
    if (profile && profile.hasNightStudy === false) skipped.study_evening = '本班无晚自习';

    // date → moduleKey → items
    const byDay = new Map();
    for (const record of records) {
      if (skipped[record.moduleKey]) continue;
      const moduleDef = moduleBy.get(record.moduleKey);
      if (!moduleDef) continue; // 模块被停用/删除：跳过而不是 500
      const numbers = attendanceNumbers(record.moduleKey, record.details);
      const item = { record, numbers, rate: attendanceRate(moduleDef, record.details, record.metrics) };
      const day = byDay.get(record.date) || new Map();
      const list = day.get(record.moduleKey) || [];
      list.push(item);
      day.set(record.moduleKey, list);
      byDay.set(record.date, day);
    }

    const dayKeys = dateKeysBetween(from, to);
    const days = dayKeys.map((dateKey) => {
      const day = byDay.get(dateKey);
      const out = {};
      let absentTotal = 0;
      if (day) {
        for (const [moduleKey, items] of day) {
          const entry = buildDayModule(moduleBy.get(moduleKey), items);
          out[moduleKey] = entry;
          absentTotal += entry.absent;
        }
      }
      return {
        date: dateKey,
        weekday: WEEKDAY_TEXT[new Date(`${dateKey}T00:00:00`).getDay()] || '',
        hasRecord: !!day,
        absentTotal,
        modules: out,
      };
    });

    // 区间汇总：各模块「平均出勤率（按应到人数加权）」+ 累计缺勤 / 未归
    const summaryModules = {};
    let absentTotal = 0;
    let notReturnedTotal = 0;
    let weightSum = 0;
    let weighted = 0;
    for (const key of ATTENDANCE_MODULES) {
      const moduleDef = moduleBy.get(key);
      if (!moduleDef) continue;
      const rows = days.map((d) => d.modules[key]).filter(Boolean);
      const shouldTotal = rows.reduce((a, x) => a + x.should, 0);
      const actualTotal = rows.reduce((a, x) => a + x.actual, 0);
      const absentSum = rows.reduce((a, x) => a + x.absent, 0);
      const notReturnedSum = rows.reduce((a, x) => a + x.notReturned, 0);
      // 平均出勤率：按应到人数加权（应到全为 0 时退化为简单平均，避免 0/0）
      const avgRate = !rows.length
        ? null
        : shouldTotal > 0
          ? rows.reduce((a, x) => a + x.rate * x.should, 0) / shouldTotal
          : rows.reduce((a, x) => a + x.rate, 0) / rows.length;
      if (avgRate !== null && shouldTotal > 0) {
        weightSum += shouldTotal;
        weighted += avgRate * shouldTotal;
      }
      absentTotal += absentSum;
      notReturnedTotal += notReturnedSum;
      summaryModules[key] = {
        key,
        name: moduleDef.shortName || moduleDef.name,
        rateName: rateMetricOf(moduleDef).name || '出勤率',
        skipped: !!skipped[key],
        skipReason: skipped[key] || '',
        // 「没有记录 = 正常」的模块（早八：只记迟到人）：组件据此把「未录」显示成「无迟到」，
        // 而不是灰色的「未录」（那会让老师以为纪检部漏录了）。
        optionalWhenMissing: moduleDef.optionalWhenMissing === true,
        noRecordText: moduleDef.noRecordText || '',
        days: rows.length, // 区间内有记录的日期数（不包含补出来的空日子，避免拉低观感）
        should: shouldTotal,
        actual: actualTotal,
        absent: absentSum,
        notReturned: notReturnedSum,
        avgRate: avgRate === null ? null : round4(avgRate),
        ratePercent: avgRate === null ? null : round1(avgRate * 100),
      };
    }
    const overall = weightSum > 0 ? weighted / weightSum : null;

    ok(res, {
      className,
      from,
      to,
      role: scope.isHomeroom ? 'homeroom' : 'officer',
      canNudge: scope.isHomeroom, // 与其它班级域接口一致：只有班主任做「督促」
      classInfo: {
        className,
        studentCount: profile ? profile.studentCount || 0 : 0,
        hasMorningExercise: !profile || profile.hasMorningExercise !== false,
        hasMorningClass: !profile || profile.hasMorningClass !== false,
        // 晚自习（用户 2026-10-21）：班级无晚自习时不产出晚自习考勤行
        hasNightStudy: !profile || profile.hasNightStudy !== false,
        hasMorningRun: !profile || profile.hasMorningRun !== false,
      },
      days,
      summary: {
        from,
        to,
        totalDays: dayKeys.length,
        recordedDays: days.filter((d) => d.hasRecord).length,
        modules: summaryModules,
        skipped,
        absentTotal, // 区间累计缺勤人数（查宿的未归也计在内）
        notReturnedTotal, // 区间累计未归次数（查宿）
        avgRate: overall === null ? null : round4(overall), // 各模块加权平均（无人数据时为 null）
        ratePercent: overall === null ? null : round1(overall * 100),
      },
    });
  })
);

// ==========================================================================
// ===== 班主任对本班学生的管理动作（用户 2026-10-22）=====
//
// 用户要求：「班主任**没有**用户管理权限时，是可以管理自己本班的学生的操作功能，
// 如（编辑资料 / 重置密码 / 发放徽章 / 限制功能 / 删除账户）。」
//
// 为什么放在班级域而不是放开 /api/admin/users/*：
//   管理端那几个接口整体挂在 `requirePermission('user.view')` 下，而详情、列表、批量等
//   多个路由**只靠这一道闸门**。为了班主任去放宽全局闸门，等于让每个班主任都能拉全校名单，
//   风险远大于收益。班级域本来就是「成员资格校验、不用 requirePermission」的语义（见文件头），
//   所以在这里按**班主任 + 本班学生**逐条判定，作用面精确到一个班。
//
// 两条硬约束（改这里之前先读 services/student-scope.js 的不变式）：
//   · 只有**班主任**能写，**班委一律只读**（403）；
//   · 目标必须是**普通学生**（不持任何管理权限），否则交给管理员 ——
//     不然班主任可以重置/删除一个「学生身份的管理员」。
//
// 实现全部复用管理端那一份 service（重置密码 / 删除 / 限制 / 发徽章），本文件只做鉴权与取参。
// ==========================================================================

// 取出「本次要管理的学生」：先定班级作用域（班委→403），再校验学生属于该班。
async function loadHomeroomTarget(req) {
  const raw = (req.query && req.query.className) || (req.body && req.body.className) || '';
  const scope = resolveScope(req.user, raw);
  if (!scope.isHomeroom) {
    throw new ApiError(403, 403002, '只有班主任可以管理本班学生（班委仅查看）');
  }
  const { userId } = req.params;
  if (!mongoose.isValidObjectId(userId)) throw new ApiError(404, 404, '学生不存在');
  const target = await User.findById(userId);
  if (!target) throw new ApiError(404, 404, '学生不存在');
  if (target.role !== 'student') throw new ApiError(403, 403002, '只能管理学生账号');
  if (!target.className || target.className !== scope.className) {
    throw new ApiError(403, 403002, NO_ACCESS);
  }
  if (!(await studentScope.canManageStudent(req.user, target))) {
    throw new ApiError(403, 403002, '该学生拥有管理权限，请由管理员处理');
  }
  return { scope, target };
}

// ===== 班主任能做什么：**由服务端逐项下发**，前端只照着渲染 =====
//
// 用户 2026-10-23：「在班主任的教师账户中的本班学生用户详细页，有的功能显示按钮，
// 你像删除账户，他没有这个权限请你不要显示。」
//
// 这条规则的正确形态不是「前端各自猜一遍权限」，而是**服务端说能做什么、前端就画什么** ——
// 否则两边的判断一漂移，就必然出现「按钮能点、点了 403」或反过来「该有的按钮没有」。
// 所以 /manage 直接下发 capabilities，user-detail 页一律按它渲染。
//
// 删除账户默认**不给班主任**（HOMEROOM_CAN_DELETE）：删号是级联删除（运动/饮水/徽章/
// 申诉/住宿/设备令牌全没了）且不可恢复，属于校级处置；班主任的合理诉求是「这个人不在我班了」，
// 那应该转班（管理端用户详情 → 转移）而不是删号。要放开只需把下面这个开关改成 true
// —— 改一处即可，路由与前端都跟着变（前端读同一份 capabilities）。
const HOMEROOM_CAN_DELETE = false;

// 班级域 /manage 返回的能力表（唯一来源）
function homeroomCapabilities() {
  return {
    editProfile: true, // 姓名 / 性别 / 生日（学籍字段仍归管理员）
    resetPassword: true,
    badges: true, // 发放 / 回收
    ban: true, // 限制同步 / GPS
    unban: true,
    dorm: true, // 安排 / 退宿（用户 2026-10-22）
    deleteAccount: HOMEROOM_CAN_DELETE,
  };
}

// 管理能力 + 可编辑资料（用户详情页据此渲染按钮、账户编辑页据此回填）
// 班委调用会 403 —— 客户端把 403 当作「无管理权」，不弹错误（这是正常情况，不是失败）
router.get(
  '/student/:userId/manage',
  wrap(async (req, res) => {
    const { scope, target } = await loadHomeroomTarget(req);
    const [badgeList, restrictions, dorm] = await Promise.all([
      manualBadges.earnedBadgeRows(target.openid),
      Promise.resolve(anticheat.activeRestrictions(target)),
      // 宿舍面板（当前在住 + 楼名 + 本班已用房间）：**由服务端下发楼名清单**，
      // 班主任不需要 building.view 也能填宿舍（用户 2026-10-22「为什么教师权限组无法获取楼名」）
      studentDorm.buildDormPayload(target),
    ]);
    ok(res, {
      canManage: true,
      // 能力表：前端按它渲染那排快捷操作（**不要**在前端再各判一遍权限）
      capabilities: homeroomCapabilities(),
      className: scope.className,
      profile: {
        _id: String(target._id),
        realName: target.realName || '',
        account: target.account || '',
        nickname: target.nickname || '',
        studentId: target.studentId || '',
        gender: Number(target.gender) || 0,
        birthdate: target.birthdate ? new Date(target.birthdate).toISOString().slice(0, 10) : '',
        schoolName: target.schoolName || '',
        departmentName: target.departmentName || '',
        specialty: target.specialty || '',
        className: target.className || '',
        grade: target.grade || '',
        role: target.role,
      },
      badges: badgeList,
      restrictions,
      dorm,
      // 班主任只能限制「同步 / GPS」这类功能；限制登录属于校级处置（保留给管理员）
      banScopes: ['sync', 'gps'],
    });
  })
);

// ===== 楼名清单（填表用的只读参考数据）=====
// 用户 2026-10-22：「班主任可以给本班学生设置宿舍，为什么教师权限组无法获取楼名」。
// 原因：楼名原先只有 `GET /api/admin/config/buildings` 一条读路径，挂在
// building.view / building.manage / config.view 下 —— 那是**宿管维护楼名清单**的权限。
// 但「填教室 / 填宿舍要先选楼」是班主任、教务处（class.view）都要做的事，
// 让他们为此拿到楼名管理权限是错的（能改全校配置）。
// 所以这里单开一条**只读**路径：登录即可读，只回楼名字符串，不含任何维护能力；
// 楼名的增删改仍然只走 /api/admin/config/buildings（building.manage）。
router.get(
  '/buildings',
  wrap(async (req, res) => {
    ok(res, await studentDorm.configuredBuildings());
  })
);

// ===== 宿舍（班主任给本班学生安排住宿）=====
// 用户 2026-10-22：「班主任可以给本班学生设置宿舍」。
// 楼名清单由 GET /dorm 与 /manage 一起下发 —— 不从 /api/admin/config/buildings 取，
// 那条路径要 building.view / config.view（宿管维护楼名的权限，不该发给所有教师）。
router.get(
  '/student/:userId/dorm',
  wrap(async (req, res) => {
    const { target } = await loadHomeroomTarget(req);
    ok(res, await studentDorm.buildDormPayload(target));
  })
);

// 分配 / 换房：{ roomLabel: '1号楼·201' } 或 { roomId } + 可选 bedNo
router.put(
  '/student/:userId/dorm',
  wrap(async (req, res) => {
    const { target } = await loadHomeroomTarget(req);
    ok(res, await studentDorm.assignDorm(target, req.body || {}));
  })
);

// 退宿：在住记录置 checked_out（历史保留）
router.delete(
  '/student/:userId/dorm',
  wrap(async (req, res) => {
    const { target } = await loadHomeroomTarget(req);
    ok(res, await studentDorm.checkoutDorm(target));
  })
);

// 编辑资料：只允许改姓名 / 性别 / 生日。
// 学籍字段（学号 / 院校 / 系部 / 专业 / 班级 / 角色 / 权限）来自名单与组织架构，
// 班主任改它们会造成「学籍与名单不一致」，一律交给管理员（与 /api/auth/profile 的口径一致）。
router.put(
  '/student/:userId/profile',
  wrap(async (req, res) => {
    const { target } = await loadHomeroomTarget(req);
    const body = req.body || {};
    const forbidden = ['studentId', 'schoolName', 'school', 'departmentName', 'department', 'specialty', 'className', 'grade', 'role', 'permissions', 'permissionGroups']
      .filter((k) => body[k] !== undefined && String(body[k]) !== '');
    if (forbidden.length) {
      throw new ApiError(403, 403005, `学籍信息由学校名单同步，班主任不能修改（${forbidden.join('、')}）；请联系管理员`);
    }
    if (body.account !== undefined) {
      const name = String(body.account).trim();
      if (!name) throw new ApiError(400, 400, '姓名不能为空');
      const dup = await User.findOne({ account: name, role: 'student', _id: { $ne: target._id } });
      if (dup) throw new ApiError(400, 400, '已存在同名同类型账户');
      target.account = name;
      target.realName = name;
    }
    if (body.gender !== undefined) target.gender = Number(body.gender) || 0;
    if (body.birthdate !== undefined) target.birthdate = body.birthdate ? new Date(body.birthdate) : null;
    await target.save();
    ok(res, {
      success: true,
      user: { _id: String(target._id), realName: target.realName, account: target.account, gender: target.gender, birthdate: target.birthdate },
    });
  })
);

// 重置密码（恢复为名单初始密码；无初始数据则由 service 生成随机码并在 message 里返回）
router.post(
  '/student/:userId/reset-password',
  wrap(async (req, res) => {
    const { target } = await loadHomeroomTarget(req);
    const message = await accountAdmin.resetUserPassword(target);
    ok(res, { success: true, message });
  })
);

// 限制功能（班主任只能限制 同步 / GPS；限制登录需要管理端权限）
router.post(
  '/student/:userId/ban',
  wrap(async (req, res) => {
    const { target } = await loadHomeroomTarget(req);
    const scope = String((req.body || {}).scope || '');
    if (scope === 'login') {
      throw new ApiError(403, 403002, '班主任只能限制「微信同步 / GPS」，限制登录需要管理端权限');
    }
    const info = await accountAdmin.banUser(target, {
      scope,
      reason: (req.body || {}).reason,
      days: (req.body || {}).days,
      operator: req.user.openid,
    });
    ok(res, { success: true, ...info });
  })
);

// 解除限制
router.post(
  '/student/:userId/unban',
  wrap(async (req, res) => {
    const { target } = await loadHomeroomTarget(req);
    const r = await accountAdmin.unbanUser(target, { scope: (req.body || {}).scope, operator: req.user.openid });
    ok(res, { success: true, ...r });
  })
);

// 删除账户：**默认不开放给班主任**（见 HOMEROOM_CAN_DELETE 的说明）。
// 淘汰线：级联删除不可恢复，属于校级处置；班主任应改用「转移」把学生调出本班。
// 这里必须真的拦（403 403002），否则就是「前端不显示、后端仍然可删」的假安全。
router.delete(
  '/student/:userId',
  wrap(async (req, res) => {
    if (!homeroomCapabilities().deleteAccount) {
      throw new ApiError(
        403,
        403002,
        '班主任不能删除学生账户（会连带删除运动 / 饮水 / 徽章 / 住宿等全部数据，且不可恢复）；如需把学生调出本班，请使用「转移」，或联系管理员'
      );
    }
    const { target } = await loadHomeroomTarget(req);
    const deleted = await accountAdmin.deleteUserCascade(target);
    ok(res, { success: true, deleted });
  })
);

// 发放抽屉数据源（已获得 + 全部启用中的定义）：与管理端 GET /api/admin/users/:id/badges 同形
router.get(
  '/student/:userId/badges',
  wrap(async (req, res) => {
    const { target } = await loadHomeroomTarget(req);
    ok(res, await manualBadges.badgeSheetPayload(target));
  })
);

// 发放徽章（幂等：已获得过返回 granted:false）
router.post(
  '/student/:userId/badges',
  wrap(async (req, res) => {
    const { target } = await loadHomeroomTarget(req);
    const { badgeKey, tierGroup, tierLevel } = req.body || {};
    const r = await manualBadges.grantBadgeToUser(target, { badgeKey, tierGroup, tierLevel });
    ok(res, { success: true, ...r });
  })
);

// 回收徽章（幂等）
router.delete(
  '/student/:userId/badges/:badgeKey',
  wrap(async (req, res) => {
    const { target } = await loadHomeroomTarget(req);
    const r = await manualBadges.revokeBadgeFromUser(target, req.params.badgeKey, {
      reason: `班主任回收（${req.user.openid || ''}）`,
    });
    ok(res, { success: true, ...r });
  })
);

module.exports = router;
