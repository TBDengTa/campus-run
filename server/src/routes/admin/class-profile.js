/**
 * 管理端：班级配置（/api/admin/class/...）
 *
 * 两条路径分别服务两个视角（都用 class_profiles 一张表）：
 *   · GET/PUT /api/admin/class/profiles        —— 管理员的「班级管理」页：全校所有班级台账的列表 / 同步 / 单条改
 *   · PUT     /api/admin/class/profiles/:id     —— 同上，按台账 id 改一个班的开关（class.manage）
 *   · GET/PUT /api/admin/class/:className/profile —— 按班级名读改单个班（教师那侧的班级域另有 /api/class/profile）
 *
 * 为什么要单独开 /profiles 列表路由，而不是复用 /api/admin/union/class-profiles：
 *   「班级管理」管的是**全校所有班**（早操 / 早八 / 校园跑标记、人数），语义上属于班级配置，
 *   权限就该是 class.view / class.manage；它以前挂在 union.* 下是历史遗留（放在学生会配置里）。
 *   管理员不该为了改一个班的跑操标记而额外持有 union.manage。
 *
 * 权限（models/permission.js 权限目录，启动自动播种）：
 *   读 class.view —— 本文件挂在 routes/admin/index.js 的
 *     router.use('/class', requirePermission('class.view'), require('./class-profile'))
 *   写 class.manage —— 所有写路由在下面单独挂 MANAGE，避免「只有查看权」的人改配置。
 *   注意：学生端班级域是 /api/class/*（成员资格校验、**不用** requirePermission），两条路径互不影响。
 *
 * 字段口径与班级域 GET/PUT /api/class/profile **完全一致**（前端多条路径共用一套渲染，同名不同义会直接踩坑）：
 *   { className, exists, hasMorningExercise, hasMorningRun, studentCount, dormCount,
 *     departmentName, grade, specialty, homeroomNames, remark, role, canEdit }
 *   管理端额外多给：hasMorningClass / schoolId / schoolName / departmentId / enabled / syncedAt / hasDorm（是否有宿舍）/ dormAssignments。
 * 组织层级口径（organizations：school → department → specialty）：前端一律叫「院校」与「系部」，与用户管理页筛选器同名。
 * className 以 URL / 台账为准：body 里带 className 一律忽略（班级名由学籍推导，改它会让所有历史数据对不上）。
 */
const express = require('express');
const mongoose = require('mongoose');
const { wrap, ok, ApiError, parsePagination } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const dates = require('../../utils/dates');
const User = require('../../models/user');
const Organization = require('../../models/organization');
const ClassProfile = require('../../models/class-profile');
const DormAssignment = require('../../models/dorm-assignment');
const DormRoom = require('../../models/dorm-room');
const SanitaryArea = require('../../models/sanitary-area');
const roster = require('../../services/roster');
const dormsSvc = require('../../services/dorms');
const classProfilesSvc = require('../../services/class-profiles');
const bandChao = require('../../services/band-chao');
// 人数实时统计（应到 = 学籍人数，应住 = 住宿名单人数）：唯一口径，见 services/class-counts.js
const { liveCount, liveCounts } = require('../../services/class-counts');

const router = express.Router();
const MANAGE = requirePermission('class.manage');

/**
 * 年级筛选（**必须带推导兜底**，AGENTS.md 的存量数据约定）
 *   class_profiles.grade 来自 users.grade，而存量用户 grade 普遍为空 ——
 *   只按 grade 等值匹配的话，年级筛选对老数据等于筛不出任何东西。
 *   年级本身可由班级名严格推导（「23级大数据技术」→ 2023），所以：
 *   命中标了 grade 的行，或 grade 为空但班级名前缀对得上的行。
 */
function gradeMatch(grade) {
  const g = roster.normalizeGrade(grade);
  if (!g) return null;
  const two = g.slice(-2);
  if (!/^\d{2}$/.test(two)) return null;
  // 与 roster.gradeFromClassName 同口径：两位年份 + 可选「级」
  return {
    $or: [
      { grade: g },
      { grade: { $in: [null, ''] }, className: new RegExp(`^${two}\\s*级?`) },
    ],
  };
}

// 读出来给前端展示的年级：空值按班级名推导兜底（前端不要自己再写一套推导）
const gradeOf = (doc) => roster.normalizeGrade(doc.grade) || roster.gradeFromClassName(doc.className || '');

const str = (v, max = 60) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

// 班级名的唯一来源：URL 参数（含中文需 decode；解码失败按原串处理，不 500）
function classNameOf(req) {
  let raw = String(req.params.className || '');
  try {
    raw = decodeURIComponent(raw);
  } catch (e) {
    /* 非法百分号编码：按原串处理，交给下面的长度校验兜底 */
  }
  const name = raw.trim();
  if (!name) throw new ApiError(400, 400, '缺少班级名');
  if (name.length > 60) throw new ApiError(400, 400, '班级名过长');
  return name;
}

// ===== 字段校验（PUT 只认白名单字段；类型不对直接 400，避免把配置写成字符串 "false" / 负数）=====
// 布尔口径与班级域 /api/class/profile 一致：`!== false` 即 true
// （前端开关传 false / 0 / '0' / 'false' 都算「关」，传 true / 1 / '1' / 'true' 都算「开」）
function boolField(v, label) {
  if (typeof v === 'boolean') return v;
  if (v === 0 || v === 1) return v === 1;
  if (v === '0' || v === '1') return v === '1';
  if (v === 'true' || v === 'false') return v === 'true';
  throw new ApiError(400, 400, `${label} 必须是 true / false`);
}

// 空值（undefined / null / ''）= 不修改：前端没渲染或没填的字段不该被当成 false 覆盖掉（同「只改传了的字段」）
const isBlank = (v) => v === undefined || v === null || v === '';

// 注：旧的 countField()（手工填应到 / 应住人数）已移除 ——
// 两项人数改由 services/class-counts.js 从学籍 / 住宿名单实时统计，写接口显式拒绝这两个字段。

function namesField(v) {
  if (!Array.isArray(v)) throw new ApiError(400, 400, '班主任姓名必须是数组');
  return [...new Set(v.map((x) => str(x, 20)).filter(Boolean))].slice(0, 20);
}

// ===== 台账装载 / 呈现 =====

// 台账缺失（新班、或刚导入名单还没跑同步）时按学籍即时补一条，避免管理端打开配置页看到空数据
async function loadOrInitProfile(className) {
  let profile = await ClassProfile.findOne({ className });
  if (profile) return profile;
  const inRoster = await User.exists({ className, role: { $ne: 'teacher' } });
  if (!inRoster) return null;
  await classProfilesSvc.syncClassProfiles({ className }).catch(() => null);
  profile = await ClassProfile.findOne({ className });
  if (!profile) {
    // 同步服务异常时的兜底：直接建档（人数按学籍聚合，早操/校园跑取默认「有」）
    const studentCount = await User.countDocuments({ className, role: { $ne: 'teacher' } });
    profile = await ClassProfile.create({ className, studentCount, syncedAt: new Date() });
  }
  return profile;
}

function presentProfile(profile, { className, canEdit, role = 'admin', hasDorm = false, dormAssignments = 0, live = null }) {
  // 应到 / 应住人数一律用**实时统计**（学籍人数、住宿名单人数），台账里的 studentCount / dormCount
  // 只是历史快照，学生转班、退学、换宿舍后会失真 —— 所以这两个字段在页面上改为只读展示。
  const studentCount = live ? live.studentCount : profile ? profile.studentCount || 0 : 0;
  const dormCount = live ? live.dormCount : profile ? profile.dormCount || 0 : 0;
  return {
    className,
    exists: !!profile,
    // ===== 与班级域 /api/class/profile 同名的字段：名称与顺序都别改（前端两条路径共用一套渲染）=====
    hasMorningExercise: profile ? profile.hasMorningExercise !== false : true,
    hasMorningRun: profile ? profile.hasMorningRun !== false : true,
    // 班级状态：正常 / 实习 / 毕业（缺省 = 正常）
    //   实习：学生可登录，但不参加任何班超检查与校园跑统计；
    //   毕业：学生不可登录，且不参加任何班超检查与校园跑统计。
    status: ClassProfile.normalizeStatus(profile && profile.status),
    statusText: ClassProfile.STATUS_TEXT[ClassProfile.normalizeStatus(profile && profile.status)],
    joinsBandChao: ClassProfile.joinsBandChao(profile),
    studentCount,
    dormCount,
    // 这两个人数是系统自动识别的，前端不允许编辑（保留字段名，值恒为 false）
    studentCountEditable: false,
    dormCountEditable: false,
    // 本班教室（如「1号教学楼·201」）：卫生（教室）检查核对用，纯展示字段
    classroom: (profile && profile.classroom) || '',
    departmentName: (profile && profile.departmentName) || '',
    // 年级与列表接口同口径：库里 grade 常为空（存量数据），按班级名推导兜底
    grade: profile ? gradeOf(profile) : '',
    specialty: (profile && profile.specialty) || '',
    homeroomNames: (profile && profile.homeroomNames) || [],
    remark: (profile && profile.remark) || '',
    role,
    canEdit: !!canEdit,
    // ===== 管理端额外字段 =====
    hasMorningClass: profile ? profile.hasMorningClass !== false : true,
    // 晚自习（用户 2026-10-21）：false 的班级不进晚自习考勤录入台、不计入出勤率分母
    hasNightStudy: profile ? profile.hasNightStudy !== false : true,
    // 院校（organizations 的 school 层）与系部（department 层）同组下发：
    // 归属只由学籍同步带出，PUT 白名单不含它们（班级管理页的三级筛选要用院校名展示）
    schoolId: profile && profile.schoolId ? String(profile.schoolId) : '',
    schoolName: (profile && profile.schoolName) || '',
    departmentId: profile && profile.departmentId ? String(profile.departmentId) : '',
    enabled: profile ? profile.enabled !== false : true,
    syncedAt: (profile && profile.syncedAt) || null,
    // 「是否有宿舍」口径：住宿名单里有本班在住学生 / 有房间归属本班 / 台账里记了应住人数，任一满足即为有
    hasDorm,
    // 住宿名单里的实际在住人数（dormCount 是台账值，可能还没同步）
    dormAssignments,
  };
}

// 宿舍事实 + 视图：GET 与 PUT 的响应体保持完全一致，前端改完直接替换本地状态即可
async function profileView(profile, className, canEdit) {
  const [dormAssignments, dormRooms, live] = await Promise.all([
    DormAssignment.countDocuments({ className, status: { $in: ['checked_in', 'guest'] } }),
    DormRoom.countDocuments({ className, enabled: { $ne: false } }),
    liveCount(className),
  ]);
  const hasDorm = dormAssignments > 0 || dormRooms > 0 || live.dormCount > 0;
  return presentProfile(profile, { className, canEdit, hasDorm, dormAssignments, live });
}

// 班级属性会进「录入台对象列表」与「班级排名 / 出勤率分母」，这两处有 60s 进程内缓存 → 改完必须失效，
// 否则操作者会以为「改了没生效」（与班级域 PUT /api/class/profile 同一处理）
function clearBandChaoCaches() {
  try {
    bandChao.clearRankCache();
  } catch (e) {
    /* 缓存清理是可选能力：服务缺失时忽略 */
  }
  try {
    if (typeof classProfilesSvc.clearProfileCache === 'function') classProfilesSvc.clearProfileCache();
  } catch (e) {
    /* 同上 */
  }
}

// 「班级管理」页（全校台账）：列表 / 同步 / 按台账 id 改
// 路由形态与 /:className/profile 不冲突（段数不同），但注册顺序放在前面更直观。

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ===================== 本班的卫生区绑定 =====================
// 关系存在**区域侧**（sanitary_areas.classNames 是数组，支持多班共管 + 权重），
// 这里提供「按班看 / 按班改」的视图，管理员才不用跑到区域列表里一个个勾。
// 改的是「本班加入了哪些区域」，绝不动其他班的归属与权重。

async function profileById(req) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '班级不存在');
  const profile = await ClassProfile.findById(req.params.id);
  if (!profile) throw new ApiError(404, 404, '班级不存在');
  return profile;
}

function presentAreaBrief(a, className) {
  const weight = a.weights && typeof a.weights === 'object' ? Number(a.weights[className]) : NaN;
  const others = (a.classNames || []).filter((c) => c !== className);
  return {
    id: String(a._id),
    name: a.name,
    areaType: a.areaType || 'outdoor',
    location: a.location || '',
    classNames: a.classNames || [],
    // 共管班级数：>0 时前端要提示「本班只按权重分摊」，否则管理员以为整区扣分都算自己班
    sharedWith: others.length,
    weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
    enabled: a.enabled !== false,
  };
}

// 本班负责的卫生区
router.get(
  '/profiles/:id/sanitary',
  wrap(async (req, res) => {
    const profile = await profileById(req);
    const [mine, all] = await Promise.all([
      SanitaryArea.find({ classNames: profile.className, enabled: { $ne: false } }).sort({ areaType: 1, name: 1 }).lean(),
      SanitaryArea.find({ enabled: { $ne: false } }).sort({ areaType: 1, name: 1 }).limit(300).lean(),
    ]);
    ok(res, {
      className: profile.className,
      mine: mine.map((a) => presentAreaBrief(a, profile.className)),
      // 候选：全部启用区域（区域量级小，不分页；前端按 mine 勾选）
      options: all.map((a) => ({ id: String(a._id), name: a.name, areaType: a.areaType || 'outdoor', location: a.location || '' })),
    });
  })
);

// 设置本班负责的卫生区：{ areaIds: [], newAreas: [{ name, areaType, location }] }
// newAreas 是「就地新建并绑定」：全校卫生区目前没有任何独立维护页（后端 /api/admin/union/areas 有接口但无 UI），
// 如果这里不支持新建，新学校进来就是一个空列表 —— 管理员想给班级设卫生区却无处可设（用户明确要这个功能）。
router.put(
  '/profiles/:id/sanitary',
  MANAGE,
  wrap(async (req, res) => {
    const profile = await profileById(req);
    const className = profile.className;
    const body = req.body || {};

    const created = [];
    const wanted = [
      ...new Set((Array.isArray(body.areaIds) ? body.areaIds : []).map((x) => String(x))),
    ].filter((x) => mongoose.isValidObjectId(x));

    // 新建区域：同名区域已存在就不重复建（管理员手打很容易撞上已有名字）
    const news = (Array.isArray(body.newAreas) ? body.newAreas : []).slice(0, 20);
    for (const raw of news) {
      const name = str(raw && raw.name, 40);
      if (!name) continue;
      const hit = await SanitaryArea.findOne({ name }).lean();
      if (hit) {
        wanted.push(String(hit._id));
        continue;
      }
      const doc = await SanitaryArea.create({
        name,
        areaType: str(raw && raw.areaType, 16) || 'outdoor',
        location: str(raw && raw.location, 60),
        classNames: [className],
        departmentId: profile.departmentId || null,
        departmentName: profile.departmentName || '',
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
    if (added.length || removed.length || created.length) clearBandChaoCaches();
    ok(res, { className, added, removed, created });
  })
);

// ===================== 本班学生的宿舍绑定 =====================
// ⚠️ 宿舍是**学生 ↔ 房间**的关系（用户明确纠正：不是班级绑房间，因为存在混宿）。
// 同班学生可能住不同楼，别班学生也可能住进同一间 —— 两种情况都正常，所以只能按学生维护。

// 本班学生名单 + 各自宿舍号（宿舍号来自 dorm_assignments）
router.get(
  '/profiles/:id/dorms',
  wrap(async (req, res) => {
    const profile = await profileById(req);
    const rosterRows = await dormsSvc.rosterWithRooms(profile.className);
    const rooms = await DormRoom.find({ enabled: { $ne: false } })
      .select('buildingId buildingName roomNo')
      .sort({ buildingId: 1, roomNo: 1 })
      .limit(800)
      .lean();
    const buildingMap = new Map();
    for (const r of rooms) {
      const b = r.buildingName || r.buildingId || '';
      if (!b) continue;
      buildingMap.set(b, (buildingMap.get(b) || 0) + 1);
    }
    ok(res, {
      className: profile.className,
      students: rosterRows,
      assigned: rosterRows.filter((s) => s.assigned).length,
      unassigned: rosterRows.filter((s) => !s.assigned).length,
      buildings: [...buildingMap.entries()].map(([name, n]) => ({ name, rooms: n })),
      roomOptions: rooms.slice(0, 300).map((r) => ({
        id: String(r._id),
        label: dormsSvc.roomLabel(r),
      })),
    });
  })
);

// 给一个学生绑宿舍：{ roomId } 或 { roomLabel: '1号楼·201' }（+ bedNo）
router.put(
  '/profiles/:id/dorms/:userId',
  MANAGE,
  wrap(async (req, res) => {
    const profile = await profileById(req);
    if (!mongoose.isValidObjectId(req.params.userId)) throw new ApiError(400, 400, '学生不存在');
    // 必须确认这个学生真的属于该班级 —— 否则能从别的班的学生列表里点到人，把别的班学生挂到本班台账下
    const student = await User.findOne({ _id: req.params.userId, className: profile.className, role: { $ne: 'teacher' } }).lean();
    if (!student) throw new ApiError(403, 403002, '该学生不属于这个班级');
    if (!student.openid) throw new ApiError(400, 400, '该学生还没绑定微信，暂时无法记录住宿');
    const body = req.body || {};
    const out = await dormsSvc.assignStudentRoom({
      student,
      roomId: body.roomId,
      roomLabel: body.roomLabel,
      bedNo: body.bedNo,
    });
    try {
      await classProfilesSvc.refreshDormCounts(profile.className);
    } catch (e) {
      /* 人数回填失败不影响本次绑定结果 */
    }
    ok(res, {
      className: profile.className,
      studentId: student.studentId || '',
      name: student.realName || student.nickname || student.account || '',
      room: dormsSvc.roomLabel(out.room),
      roomId: String(out.room._id),
      createdRoom: !!out.createdRoom, // 房间不存在时自动建档
      movedFrom: out.movedFrom || '',
    });
  })
);

// 退宿：把该生在住记录置 checked_out
router.delete(
  '/profiles/:id/dorms/:userId',
  MANAGE,
  wrap(async (req, res) => {
    const profile = await profileById(req);
    if (!mongoose.isValidObjectId(req.params.userId)) throw new ApiError(400, 400, '学生不存在');
    const student = await User.findOne({ _id: req.params.userId, className: profile.className }).lean();
    if (!student) throw new ApiError(403, 403002, '该学生不属于这个班级');
    const doc = await DormAssignment.findOne({ openid: student.openid, status: { $in: ['checked_in', 'guest'] } });
    if (!doc) return ok(res, { checkedOut: false });
    doc.status = 'checked_out';
    await doc.save();
    try {
      await classProfilesSvc.refreshDormCounts(profile.className);
    } catch (e) {
      /* 同上 */
    }
    ok(res, { checkedOut: true });
  })
);

// ===================== 全校台账列表（班级管理页）=====================

// facets 的院校 / 系部选项按**名字**去重合并（三源并集，见 GET /profiles 的说明）：
// 同名只出现一项，count 累加，并标记它来自哪个源 —— 管理员才能分辨
// 「这个院校是组织架构里配了但还没有班」与「台账里真的没有这个院校」。
function mergeFacet(map, name, patch = {}) {
  const key = str(name, 120);
  if (!key) return; // 空名不进下拉（筛选值必须非空，否则点它等于不筛）
  const cur = map.get(key) || { name: key, count: 0, configured: false, synced: false };
  if (patch.configured) cur.configured = true;
  if (patch.synced) cur.synced = true;
  cur.count += Number(patch.count) || 0;
  map.set(key, cur);
}

// 三源合并后的排序：**有班级的在前**（管理员多数时候是要筛已有台账），同 count 再按名字；
// count 为 0 的「只配置了组织架构」的院校沉到最后，但仍然在选项里（本轮报障正是这种情况）。
function facetList(map) {
  return [...map.entries()]
    .map(([key, v]) => ({
      key,
      label: v.name,
      count: v.count,
      configured: !!v.configured,
      synced: !!v.synced,
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        String(a.label).localeCompare(String(b.label), 'zh-Hans-CN') ||
        String(a.key).localeCompare(String(b.key))
    );
}

// ===== 筛选树（facets.tree）：院校 → 系部 → 专业 =====
// 「未归入组织架构」兜底节点的 key：台账里**连院校名都没有**的行，以及组织架构里 parentId
// 落不到院校 / 系部的游离节点，都收在这里（配置了就必须能看见，班也一个都不能丢）。
// key 用不可能与真实校名相同的哨兵串，并且 GET /profiles 的 school 参数**认这个哨兵**
// （等价于「院校名为空」）—— 「选项的值 → 筛选条件」仍然等价，
// 不会出现「点了 count=N 的节点却筛出 0 个班」（上一轮特意为名字口径规避的那个坑）。
const UNASSIGNED_KEY = '__unassigned__';
const UNASSIGNED_LABEL = '未归入组织架构';

// 树节点：三级同形（level 自描述），子级数组固定存在，前端不用判空。
// count 语义 = **该节点在其层级上「直接归属」的台账班级数**：
//   同一班级会在院校 / 系部 / 专业三级各计 1 次，所以院校节点的 count 等于该院校下的班级总数
//   （与平铺 facets.schools 的 count 语义完全一致），**不是**「只在院校层、没细分到系部的班」；
//   系部节点 count = 该院校下该系部的班数；专业节点 count = 该院校该系部下该专业的班数。
//   → 树的每一级 count 都等于「按该节点筛选」能筛出的班数（见下面 school 哨兵与记账的注释）。
function treeNode(key, label, level) {
  return {
    key,
    label,
    level, // 'school' | 'department' | 'specialty'
    count: 0,
    configured: false, // organizations 里配置过（count=0 就是「配了但还没有班」，仍要能选）
    synced: false, // 学籍里出现过（与平铺 facets 的 synced 同义）
    departments: [], // 院校节点的系部（按 organizations.parentId 挂）
    specialties: [], // 系部节点的专业；「有院校没系部」的班直接挂在该院校节点下
  };
}

// 树索引：`Map<院校key, { node, depts: Map<系部key, node> }>`。
// 系部**只**按 organizations.parentId 的层级关系落位，不靠名字猜父级（见 buildFacetTree 的决策说明）；
// 「院校名不在组织架构里」以及「连院校名都没有」的台账行统一落兜底节点。
function treeCreate() {
  const index = new Map();
  const ensureSchool = (key, label, configured) => {
    let entry = index.get(key);
    if (!entry) {
      entry = { node: treeNode(key, label, 'school'), depts: new Map() };
      index.set(key, entry);
    }
    if (configured) entry.node.configured = true;
    return entry;
  };
  // 取（必要时创建）某院校下的某系部节点：**父级已确定**时才调用（父级未确定的一律走兜底）
  const ensureDept = (schoolKey, deptKey, configured) => {
    const entry = ensureSchool(schoolKey, schoolKey, null);
    let dept = entry.depts.get(deptKey);
    if (!dept) {
      dept = treeNode(deptKey, deptKey, 'department');
      entry.depts.set(deptKey, dept);
    }
    if (configured) dept.configured = true;
    return dept;
  };
  return { index, ensureSchool, ensureDept };
}

// 专业节点：只在父级（系部节点 / 「有院校没系部」的院校节点）内按名字去重
function specialtyNodeOf(parent, specialtyKey, configured) {
  let node = parent.specialties.find((s) => s.key === specialtyKey);
  if (!node) {
    node = treeNode(specialtyKey, specialtyKey, 'specialty');
    parent.specialties.push(node);
  }
  if (configured) node.configured = true;
  return node;
}

// organizations 树 + class_profiles 实际值 + users.distinct 三源并集 → facets.tree / facets.specialties
//
// 决策（用户要求「稳定、可解释」）：**层级关系只认 organizations.parentId**。
//   · 组织架构里的 school / department / specialty 按 parentId 挂（权威层级）；
//   · 台账与学籍里的**文本值**（schoolName / departmentName / specialty）只在「父级已在组织架构里」
//     时才往下钻一级；钻不下去就**停在已经确认的那一级**，绝不靠名字猜父级、也不跨级乱挂：
//       - 院校名在组织架构里、系部名也在**该院校的**系部里 → 挂该系部（count 记在系部与院校两处）；
//       - 院校名在组织架构里、系部名不在（或台账压根没写系部）→ 挂在**该院校节点**上
//         （count 记在院校，专业挂在该院校节点下，并计入 school.unmappedDeptCount）；
//         这样「院校配了、系部名对不上」时院校 count 仍然是真值，不会出现
//         「台账里明明有 20 个班，院校下拉却显示暂无班级」；
//       - 院校名不在组织架构里 / 台账连院校名都没有 → 挂「未归入组织架构」兜底节点，**班一个都不丢**；
//   · 找不到父级的**游离组织节点**（parentId 指不到院校的系部、指不到系部的专业）同样进兜底节点，
//     保证「组织架构里配了就一定看得见」（上一轮报障口径，不能回退）。
// 为什么不做「按观测到共现关系挂」：同一份学籍数据在多数票 / 分组顺序变化下会得到不同的父子关系，
// 树会在两次同步之间变形（与 services/class-profiles.js 明确要求的幂等相冲突）；
// 而「认 parentId、钻不下去就停在上一级 / 兜底」对同一份数据恒定，且能在界面上解释：
// 兜底节点里的项 = 组织架构里还没有对应父级的归属，去组织架构里补父级即可自动归位。
function buildFacetTree({ allProfiles, schoolUsers, deptUsers, schoolOrgs, deptOrgs, specialtyOrgs }) {
  const { index, ensureSchool, ensureDept } = treeCreate();
  const unassigned = () => ensureSchool(UNASSIGNED_KEY, UNASSIGNED_LABEL, false).node;
  const inOrg = (key) => !!key && key !== UNASSIGNED_KEY && index.has(key);

  // ① 组织架构：school 层（权威层级，配了就必须出现，count 先记 0）
  const schoolNameByOrgId = new Map(); // school._id → 名字（树里的 key 就是名字）
  for (const o of schoolOrgs) {
    const name = str(o && o.name, 120);
    if (!name) continue;
    schoolNameByOrgId.set(String(o._id), name);
    ensureSchool(name, name, true);
  }
  // ② 组织架构：department 层按 parentId 挂到院校下；父级找不到 → 兜底节点
  const deptOrgByOrgId = new Map(); // department._id → { schoolKey, deptKey }
  for (const o of deptOrgs) {
    const name = str(o && o.name, 120);
    if (!name) continue;
    const schoolKey = schoolNameByOrgId.get(o.parentId ? String(o.parentId) : '');
    if (!schoolKey) {
      // 游离系部（没配父院校 / 父院校已删）：挂兜底节点，但仍记下它的名字 ——
      // 「院校名不在组织架构里、系部名却是配置过的」台账行能借它显示出正确层级
      deptOrgByOrgId.set(String(o._id), { schoolKey: UNASSIGNED_KEY, deptKey: name });
      ensureDept(UNASSIGNED_KEY, name, true);
      continue;
    }
    deptOrgByOrgId.set(String(o._id), { schoolKey, deptKey: name });
    ensureDept(schoolKey, name, true);
  }
  // ③ 组织架构：specialty 层按 parentId 挂到系部下；父级找不到 → 兜底节点
  //    （挂兜底是为了「组织架构里配了就一定看得见」；它的台账行同样会落到兜底院校下，
  //     所以节点 count 与筛出的班数依旧一致）
  for (const o of specialtyOrgs) {
    const name = str(o && o.name, 120);
    if (!name) continue;
    const parent = deptOrgByOrgId.get(o.parentId ? String(o.parentId) : '');
    if (!parent) {
      specialtyNodeOf(unassigned(), name, true);
      continue;
    }
    specialtyNodeOf(ensureDept(parent.schoolKey, parent.deptKey, true), name, true);
  }

  // ④ 台账行（源 B）：院校 / 系部名对上组织树就归位，对不上就停在已确认的那一级 / 落兜底节点。
  // 这是**唯一**给 count 记账的地方 —— 「节点的 count」与「按该节点筛出的班数」因此天然一致。
  for (const p of allProfiles) {
    const schoolName = str(p.schoolName, 120);
    const deptName = str(p.departmentName, 120);
    const spec = str(p.specialty, 120);
    const school = inOrg(schoolName) ? index.get(schoolName) : null;
    if (!school) {
      // 院校名不在组织架构里 / 连院校名都没有：落兜底节点，班一个都不丢
      const node = unassigned();
      node.count += 1;
      if (spec) specialtyNodeOf(node, spec, false).count += 1;
      continue;
    }
    const dept = deptName ? school.depts.get(deptName) : null;
    if (dept) {
      // 院校与系部都在组织架构里（parentId 层级确认）：系部 count 记该系的班数，专业挂系部下
      dept.count += 1;
      if (spec) specialtyNodeOf(dept, spec, false).count += 1;
      continue;
    }
    // 院校在组织架构里、系部名不在（或台账没写系部）：**不丢** —— 班记在院校节点上，
    // 专业挂在该院校节点下（前端院校节点的系部下拉只有系部，专业下拉会一并读取院校节点的 specialties）。
    // unmappedDeptCount 记录其中「写了系部名但对不上组织架构」的班数：管理员能看出
    // 「这些班的院校是对的、系部还没归位」，去组织架构里补父级即可自动归位。
    school.node.count += 1;
    if (deptName) school.unmappedDeptCount = (school.unmappedDeptCount || 0) + 1;
    if (spec) specialtyNodeOf(school.node, spec, false).count += 1;
  }

  // ⑤ 学籍（源 C）：只打 synced 标记 + 给「学籍里有、组织架构与台账都还没有」的院校建壳。
  // 与平铺 facets.schools / departments 的 synced 同口径（台账里有班的项也来自学籍，因此天然 synced）；
  // **不新建系部 / 专业**：系部层级只由 organizations 决定，凭空造一个会把树的层级关系说成假的。
  for (const raw of schoolUsers || []) {
    const name = str(raw, 120);
    if (!name) continue;
    ensureSchool(name, name, false).node.synced = true;
  }
  for (const raw of deptUsers || []) {
    const name = str(raw, 120);
    if (!name) continue;
    for (const entry of index.values()) {
      const dept = entry.depts.get(name);
      if (dept) dept.synced = true;
    }
  }

  // ⑥ 排序与输出：院校 / 系部 / 专业一律「有班级的在前，同 count 按名字」，
  // 与平铺 facets 的 facetList 同一套排序，前端两处顺序看起来才一致。
  const byCountThenName = (a, b) =>
    b.count - a.count ||
    String(a.label).localeCompare(String(b.label), 'zh-Hans-CN') ||
    String(a.key).localeCompare(String(b.key));
  const tree = [...index.values()]
    .map((entry) => {
      entry.node.departments = [...entry.depts.values()].sort(byCountThenName);
      entry.node.specialties.sort(byCountThenName);
      return entry.node;
    })
    .sort(byCountThenName);

  // 平铺 specialties：与 schools/departments 同形（key = label = 专业名，count = 该专业下的班数），
  // 供旧前端 / 树缺失时的降级路径使用。同名专业跨系部按名字合并（与院校 / 系部名字口径一致）。
  const specMap = new Map();
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.level === 'specialty') mergeFacet(specMap, n.key, { count: n.count, configured: n.configured, synced: n.synced });
      if (n.departments.length) walk(n.departments);
      if (n.specialties.length) walk(n.specialties);
    }
  };
  walk(tree);
  // 组织架构里配了、台账里没班的专业也要出现在平铺列表（同院校 / 系部口径）
  for (const o of specialtyOrgs) mergeFacet(specMap, o && o.name, { configured: true });
  return { tree, specialties: facetList(specMap) };
}

// 台账列表：班级名关键字 + 院校 / 系部 / 年级筛选 + 三个「无/不」筛选（管理员靠这些筛出要改的班）
// facets 一次把「可选院校 / 可选系部 / 可选年级」也带回前端做筛选器选项：
//   年级与班级名一样是从学籍推导出来的，让管理员手敲年级必然出现「2023 / 23级 / 2023级」三种写法。
//   组织树口径（organizations）：school=院校 → department=系部 → specialty=专业，
//   与用户管理页的「院校 / 系部」两个筛选器同名同义。
router.get(
  '/profiles',
  wrap(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { page: 1, limit: 20 });
    const filter = {};
    const keyword = str(req.query.keyword, 60);
    if (keyword) filter.className = new RegExp(escapeRe(keyword), 'i');
    if (req.query.noMorningExercise === '1') filter.hasMorningExercise = false;
    if (req.query.noMorningClass === '1') filter.hasMorningClass = false;
    // 晚自习（用户 2026-10-21）：与无早操/无早八同一套筛选口径
    if (req.query.noNightStudy === '1') filter.hasNightStudy = false;
    if (req.query.noMorningRun === '1') filter.hasMorningRun = false;
    // 班级状态筛选（正常 / 实习 / 毕业）：缺省字段视为正常
    const statusQ = str(req.query.status, 20);
    if (statusQ === 'normal') {
      filter.$and = (filter.$and || []).concat([{ $or: [{ status: 'normal' }, { status: null }, { status: { $exists: false } }] }]);
    } else if (statusQ === 'intern' || statusQ === 'graduated') {
      filter.status = statusQ;
    }
    // 系部：与院校同一口径 —— **名字为主、ObjectId 兼容**。
    // 为什么不能只按 departmentId 筛：名单导入（services/roster.js）只写 schoolName/departmentName，
    // 不写两个 id（id 仅在学生认证绑定 Organization 时才有）。按 id 归组的话，
    // 走导入建号的学校「系部」下拉永远是空的，而同页「院校」正常 —— 一半能用一半不能用比全都缺更糟。
    const department = str(req.query.department || req.query.departmentId, 120);
    if (department) {
      const deptOr = [{ departmentName: department }];
      if (mongoose.isValidObjectId(department)) deptOr.push({ departmentId: department });
      filter.$and = (filter.$and || []).concat([{ $or: deptOr }]);
    }
    // 院校：与 /api/admin/users/filters 的口径就近一致 —— 那边的选项值是 **users.schoolName**（文本），
    // 筛列表时 cond.schoolName = req.query.school。这里额外兼容传 ObjectId（台账上的 class_profiles.schoolId），
    // 因为台账的两类来源（学籍同步 / 组织架构）都可能出现「只有 id」或「只有名字」的行。
    // 长度上限放宽到 120：选项值由 facets 原样带回，截断会让长校名筛不出任何东西。
    // 用 $and 包一层，不占用 filter.$or（留给以后的关键字扩展，也与 gradeMatch 的处理一致）。
    // 哨兵值 UNASSIGNED_KEY（facets.tree 的「未归入组织架构」节点）：它不是一个真实校名，
    // 而是「台账里院校名为空」的行集合 —— 认它才能保证「树里 count=N 的节点点下去筛出 N 个班」，
    // 否则那个节点的选项值会筛出 0 个班（名字口径必须与筛选条件等价，上一轮就是这么统一的）。
    const school = str(req.query.school, 120);
    if (school === UNASSIGNED_KEY) {
      filter.$and = (filter.$and || []).concat([{ $or: [{ schoolName: { $in: [null, ''] } }, { schoolName: { $exists: false } }] }]);
    } else if (school) {
      const schoolOr = [{ schoolName: school }];
      if (mongoose.isValidObjectId(school)) schoolOr.push({ schoolId: school });
      filter.$and = (filter.$and || []).concat([{ $or: schoolOr }]);
    }
    // 专业：与院校 / 系部同一口径 —— **按名字匹配**（class_profiles.specialty）。
    // 长度上限同样 120（选项值由 facets.tree / facets.specialties 原样带回，
    // 截断会让长专业名筛不出任何东西 —— 与 school 的踩坑点同源）。
    // 专业没有 id 兼容分支：organizations.specialty 与台账 specialty 都只是文本，台账上没有 specialtyId。
    const specialty = str(req.query.specialty, 120);
    if (specialty) filter.$and = (filter.$and || []).concat([{ specialty }]);
    // 年级：优先用 grade 字段，同时兜底「grade 为空但班级名推导出该年级」的行（见 gradeMatch 的注释）
    const gradeCond = gradeMatch(req.query.grade);
    if (gradeCond) {
      filter.$and = (filter.$and || []).concat([gradeCond]);
    }

    // facets 用**不带年级筛选**的全量聚合，否则选了一个年级后其他年级就消失、没法切回去；
    // 年级在库里普遍为空，所以按「班级名推导」聚合（与前端展示的 gradeOf 同一口径）。
    //
    // 排序：班级管理页默认「近年优先」——按年级倒序（2026 → 2025 → …），同年按班级名升序，
    // 年级为空的排在最后。grade 字段大量为空、且是「班级名推导」出来的，Mongo 排不了，
    // 只能取回筛选结果后在内存里排（一个学校几百个班，量级完全够用），再手工分页。
    const allRows = await ClassProfile.find(filter)
      .select(
        'className schoolId schoolName departmentId departmentName grade specialty studentCount dormCount homeroomNames classroom hasMorningExercise hasMorningClass hasNightStudy hasMorningRun enabled status remark syncedAt'
      )
      .limit(3000)
      .lean();
    const gradeKey = (r) => gradeOf(r) || '';
    // 异常年级（如冒烟测试班「56级」推成 2056）不能霸占「近年优先」的头部：
    // 只把「2000 ~ 当前年+1」视为有效年级，其余按无年级处理、排到最后。
    const thisYear = Number(dates.todayKey().slice(0, 4));
    const validGrade = (g) => {
      const n = Number(g);
      return n >= 2000 && n <= thisYear + 1;
    };
    allRows.sort((a, b) => {
      const ga = gradeKey(a);
      const gb = gradeKey(b);
      const va = validGrade(ga);
      const vb = validGrade(gb);
      if (!va && !vb) return String(a.className).localeCompare(String(b.className), 'zh-Hans-CN');
      if (!va) return 1; // 无 / 异常年级排最后
      if (!vb) return -1;
      if (ga !== gb) return gb.localeCompare(ga); // 年级倒序：近年在前
      return String(a.className).localeCompare(String(b.className), 'zh-Hans-CN');
    });
    const total = allRows.length;
    const rows = allRows.slice(skip, skip + limit);
    const profileCount = await ClassProfile.estimatedDocumentCount();

    // 年级 / 院校 / 系部选项：全量台账量级很小（一个学校几百个班），直接内存聚合，
    // 避免为了 facets 再开一次 aggregate 并让年级推导逻辑散到查询层
    // 院校 / 系部选项是**三源合并**（本轮修复：用户只看到「北校区」正是因为以前只读了台账这一个源）：
    //   源 A 组织架构 organizations（type=school / department）—— **院校的权威配置**，
    //        配了却还没有班级的院校也必须在选项里，否则管理员配了三个校区、下拉只显示台账里出现过的那一个
    //        （「配置了却看不到」= 本次报障的直接原因）；
    //   源 B class_profiles.schoolName / departmentName —— 台账实际值，即原来的唯一来源，count = 该院校的班级数；
    //   源 C users.distinct('schoolName' / 'departmentName') —— 兜住「学生有院校、台账还没同步」的空窗期
    //        （导入名单后忘了点「从学籍同步」时，下拉不该是空的）。
    // 归组一律按**名字**（与用户管理页 /api/admin/users/filters 的口径一致，也与本接口 school / department
    // 筛选条件、前端筛选取值一致）；count 只统计台账班级数（源 A / C 命中但没有班的项 count=0，照样可选）。
    const [allProfiles, schoolOrgs, deptOrgs, specialtyOrgs, schoolUsers, deptUsers] = await Promise.all([
      // specialty 必须一起取：facets.tree 的第三级（专业）就是按台账实际值建的
      ClassProfile.find({})
        .select('className schoolId schoolName departmentId departmentName grade specialty')
        .lean(),
      // parentId 是树的层级来源（院校 → 系部 → 专业），少取它树就挂不起来
      Organization.find({ type: 'school' }).select('name parentId').lean(),
      Organization.find({ type: 'department' }).select('name parentId').lean(),
      Organization.find({ type: 'specialty' }).select('name parentId').lean(),
      // role != teacher：教师账号的 schoolName 不该给「班级台账」的院校下拉造选项（与学生口径一致，
      // 也与 services/class-profiles.js::aggregateRoster 的 $match 一致）
      User.distinct('schoolName', { schoolName: { $nin: [null, ''] }, role: { $ne: 'teacher' } }),
      User.distinct('departmentName', { departmentName: { $nin: [null, ''] }, role: { $ne: 'teacher' } }),
    ]);
    const gradeMap = new Map();
    const schoolMap = new Map();
    const deptMap = new Map();
    // 源 A：组织架构里配置过的院校 / 系部（count 先记 0，下面台账里命中再累加）
    for (const o of schoolOrgs) mergeFacet(schoolMap, o && o.name, { configured: true });
    for (const o of deptOrgs) mergeFacet(deptMap, o && o.name, { configured: true });
    // 源 C：学籍里有归属但台账还没同步（synced 标记表示「台账里有这个院校的班」）
    for (const name of schoolUsers || []) mergeFacet(schoolMap, name, { synced: true });
    for (const name of deptUsers || []) mergeFacet(deptMap, name, { synced: true });
    for (const p of allProfiles) {
      const g = roster.normalizeGrade(p.grade) || roster.gradeFromClassName(p.className || '');
      if (g) gradeMap.set(g, (gradeMap.get(g) || 0) + 1);
      // 源 B：台账实际值，count = 该院校 / 系部的班级数。
      // 院校按**名字**归组，且只收有名字的台账行 —— 与用户管理页的口径一致
      // （那边的选项是 User.distinct('schoolName', { schoolName: { $nin: [null,''] } })）。
      // 刻意不按 schoolId 兜底成「未命名院校」：选项值必须与筛选条件等价，
      // 否则点它筛出来的班数会比 count 多（同一院校里带名字的行走 schoolName、不带名字的走 schoolId）。
      // 院校名为空的行不丢：它们在不筛院校时照常出现，补法是先做「从学籍同步」。
      if (p.schoolName) mergeFacet(schoolMap, p.schoolName, { count: 1 });
      // 系部同理（与院校、与上面的筛选三处同一口径）。两个依据：
      //   ① 名单导入（services/roster.js）只写 departmentName、没有 id，按 id 归组的话
      //      纯导入建号的学校「系部」下拉永远是空（同页「院校」却正常，一半能用比全都缺更糟）；
      //   ② 与用户管理页等价 —— /api/admin/users/filters 的 departments 就是
      //      User.distinct('departmentName')，那边筛列表也是按名字。
      // 副作用（与用户管理页同源、非本次新增）：不同系部若重名（如两个学院都有「基础部」），
      // 选项会合并计数、点它会同时筛出两个同名系部。要按 id 精确区分得先保证导入链路写 id，属另一件事。
      if (p.departmentName) mergeFacet(deptMap, p.departmentName, { count: 1 });
    }

    const schools = facetList(schoolMap);
    const departments = facetList(deptMap);
    // 院校 → 系部 → 专业 的嵌套树 + 平铺 specialties（同一份三源数据，见 buildFacetTree 的说明）。
    // 平铺列表照旧下发，前端在树缺失 / 异常时可以整段退回平铺，不会白屏或空下拉。
    const { tree, specialties } = buildFacetTree({
      allProfiles,
      schoolUsers,
      deptUsers,
      schoolOrgs,
      deptOrgs,
      specialtyOrgs,
    });

    ok(res, {
      page,
      limit,
      total,
      hasMore: skip + rows.length < total,
      // 人数一律实时统计（学籍 / 住宿名单），不使用台账里的历史快照：
      // 管理员看到的「应到 / 应住」必须和学生转班、退宿后的真实情况一致。
      list: await (async () => {
        const live = await liveCounts(rows.map((r) => r.className));
        return rows.map((r) => {
          const c = live.get(r.className) || { studentCount: 0, dormCount: 0 };
          return {
            id: String(r._id),
            className: r.className,
            schoolId: r.schoolId ? String(r.schoolId) : '',
            schoolName: r.schoolName || '',
            departmentId: r.departmentId ? String(r.departmentId) : '',
            departmentName: r.departmentName || '',
            grade: gradeOf(r), // 空值按班级名推导，前端不再各写一套
            specialty: r.specialty || '',
            studentCount: c.studentCount,
            dormCount: c.dormCount,
            homeroomNames: r.homeroomNames || [],
            classroom: r.classroom || '',
            hasMorningExercise: r.hasMorningExercise !== false,
            hasMorningClass: r.hasMorningClass !== false,
            hasNightStudy: r.hasNightStudy !== false,
            hasMorningRun: r.hasMorningRun !== false,
            enabled: r.enabled !== false,
            // 班级状态：正常 / 实习 / 毕业（缺省 = 正常）
            status: ClassProfile.normalizeStatus(r.status),
            statusText: ClassProfile.STATUS_TEXT[ClassProfile.normalizeStatus(r.status)],
            joinsBandChao: ClassProfile.normalizeStatus(r.status) === 'normal',
            remark: r.remark || '',
            syncedAt: r.syncedAt || null,
          };
        });
      })(),
      facets: {
        grades: [...gradeMap.entries()]
          .sort((a, b) => (a[0] < b[0] ? 1 : -1)) // 新年级在前，管理员最常筛最近的
          .map(([key, count]) => ({ key, label: `${key}级`, count })),
        schools,
        departments,
        // 专业平铺（与 schools / departments 同形）：旧前端 / 树缺失时的降级路径用
        specialties,
        // 院校 → 系部 → 专业 的嵌套树（前端四级筛选的「院校 / 系部 / 专业」三级选项来源）。
        // 每级都带 count（= 该节点直接归属的班级数，见 treeNode 的注释）、configured / synced 来源标记；
        // 组织架构里配了但暂无班级的节点照常出现（上一轮报障口径）。
        tree,
        // 台账还没生成时给个明确信号，前端好提示「先点从学籍同步」
        totalProfiles: profileCount,
        // 调试 / 排查口径：选项里各来源的项数（配置了但 count 0 的院校数一眼可见，便于回答
        // 「组织架构配了三个校区，为什么下拉只有两个」这类问题）
        schoolSource: {
          configured: schoolOrgs.length,
          synced: (schoolUsers || []).length,
          total: schools.length,
          withClasses: schools.filter((s) => s.count > 0).length,
        },
        deptSource: {
          configured: deptOrgs.length,
          synced: (deptUsers || []).length,
          total: departments.length,
          withClasses: departments.filter((d) => d.count > 0).length,
        },
        // 专业来源口径（与院校 / 系部同构）：组织架构 specialty 层的节点数、
        // 台账里的专业数（去重后）、平铺总项数、其中有多少个真的带班
        specialtySource: {
          configured: specialtyOrgs.length,
          synced: new Set(allProfiles.map((p) => str(p.specialty, 120)).filter(Boolean)).size,
          total: specialties.length,
          withClasses: specialties.filter((s) => s.count > 0).length,
        },
      },
    });
  })
);

// 从学籍同步（补新班 + 刷新人数等派生字段）。
// **只补不覆盖**手工设过的早操 / 跑操标记 —— 口径见 services/class-profiles.js 的文件头注释。
router.post(
  '/profiles/sync',
  MANAGE,
  wrap(async (req, res) => {
    const only = str((req.body || {}).className, 60);
    const result = await classProfilesSvc.syncClassProfiles(only ? { className: only } : {});
    ok(res, result);
  })
);

// 批量改班级状态（正常 / 实习 / 毕业）或跑操标记（早操 / 早八 / 参跑）。
// 为什么需要批量：毕业季是整年级改状态、开学初是整年级开/关早操，一个个点几百个班不现实。
// 入参二选一：classNames（勾选的班）或 { school / department / grade } 范围；都不传 = 全校。
//   · status   —— normal / intern / graduated（语义见 models/class-profile.js）
//   · field    —— hasMorningExercise / hasMorningClass / hasNightStudy / hasMorningRun
//   · value    —— 与 field 搭配的布尔值
// 两者可以同时传（先改标记再改状态），返回里分别统计。
router.post(
  '/profiles/status',
  MANAGE,
  wrap(async (req, res) => {
    const body = req.body || {};
    const status = str(body.status, 20);
    const field = str(body.field, 40);
    const FLAG_FIELDS = ['hasMorningExercise', 'hasMorningClass', 'hasNightStudy', 'hasMorningRun'];

    if (status && !['normal', 'intern', 'graduated'].includes(status)) {
      throw new ApiError(400, 400, '班级状态只支持 normal / intern / graduated');
    }
    if (field && !FLAG_FIELDS.includes(field)) {
      throw new ApiError(400, 400, '批量标记只支持早操 / 早八 / 参跑三项');
    }
    if (!status && !field) throw new ApiError(400, 400, '缺少要批量修改的字段');

    const filter = {};
    const classNames = Array.isArray(body.classNames)
      ? [...new Set(body.classNames.map((n) => str(n, 60)).filter(Boolean))]
      : [];
    if (classNames.length) {
      filter.className = { $in: classNames };
    } else {
      const school = str(body.school, 120);
      const department = str(body.department, 120);
      const grade = str(body.grade, 8);
      if (school) filter.schoolName = school;
      if (department) filter.departmentName = department;
      if (grade) {
        const cond = gradeMatch(grade);
        if (cond) filter.$and = (filter.$and || []).concat([cond]);
      }
    }

    const matched = await ClassProfile.countDocuments(filter);
    if (!matched) {
      ok(res, { matched: 0, modified: 0, status, field, banned: 0 });
      return;
    }

    const $set = {};
    if (field) $set[field] = body.value !== false;
    if (status) $set.status = status;

    const r = await ClassProfile.updateMany(filter, { $set });
    clearBandChaoCaches(); // 标记 / 状态变了 → 录入台对象 / 班级榜 / 校园跑统计都要重算

    // 毕业班：把班里学生一并限制登录（复用防作弊的「限制登录」机制，可申诉、可解除）。
    // 实习班**不限制登录**（学生仍可查看自己的数据）。
    let banned = 0;
    if (status === 'graduated') {
      const { count } = await banClassesForGraduation(filter);
      banned = count;
    } else if (status === 'normal') {
      // 从毕业改回正常：解除「因毕业」造成的限制登录，避免学生被永久锁死
      await liftGraduationBans(filter);
    }

    ok(res, {
      matched,
      modified: r.modifiedCount,
      status,
      statusText: status ? ClassProfile.STATUS_TEXT[status] : '',
      field,
      value: field ? body.value !== false : null,
      banned,
    });
  })
);
// 「班级状态 = 毕业」→ 限制该班学生登录；「改回正常」→ 解除毕业造成的限制。
// 复用 anticheat 的 login 限制通道（user.status='banned' + banReason + bannedAt）：
// 学生端会看到可读原因并可申诉，管理员也能在用户详情里单独解除，不必另造一套「毕业锁」。
const GRADUATION_BAN_REASON = '已毕业（班级状态为毕业，账号不可登录）';

async function classNamesOfFilter(filter) {
  const rows = await ClassProfile.find(filter).select('className').lean();
  return rows.map((r) => r.className).filter(Boolean);
}

async function banClassesForGraduation(filter) {
  const names = await classNamesOfFilter(filter);
  if (!names.length) return { count: 0 };
  // 只处理「当前正常」的学生，避免把已被封禁（违规）的账号原因覆盖成毕业
  const r = await User.updateMany(
    { className: { $in: names }, role: { $ne: 'teacher' }, status: { $ne: 'banned' } },
    {
      $set: {
        status: 'banned',
        banReason: GRADUATION_BAN_REASON,
        banType: 'login',
        bannedAt: new Date(),
        bannedUntil: null,
      },
    }
  );
  return { count: r.modifiedCount || 0 };
}

async function liftGraduationBans(filter) {
  const names = await classNamesOfFilter(filter);
  if (!names.length) return { count: 0 };
  const r = await User.updateMany(
    { className: { $in: names }, banReason: GRADUATION_BAN_REASON, status: 'banned' },
    { $set: { status: 'active', banReason: '', banType: '', bannedAt: null, bannedUntil: null } }
  );
  return { count: r.modifiedCount || 0 };
}

router.put(
  '/profiles/:id',
  MANAGE,
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '班级不存在');
    const profile = await ClassProfile.findById(req.params.id);
    if (!profile) throw new ApiError(404, 404, '班级不存在');
    const body = req.body || {};
    const changed = {};
    const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
    const apply = (key, next) => {
      if (same(profile[key], next)) return;
      changed[key] = next;
      profile[key] = next;
    };
    const setBool = (key, label) => {
      if (isBlank(body[key])) return;
      apply(key, boolField(body[key], label));
    };
    setBool('hasMorningExercise', '是否有早操');
    setBool('hasMorningClass', '是否有早八');
    setBool('hasNightStudy', '是否有晚自习');
    setBool('hasMorningRun', '是否参加校园跑');
    setBool('enabled', '是否启用');
    // 班级状态：正常 / 实习 / 毕业
    if (body.status !== undefined) {
      const next = ClassProfile.normalizeStatus(str(body.status, 20));
      if (!['normal', 'intern', 'graduated'].includes(str(body.status, 20))) {
        throw new ApiError(400, 400, '班级状态只支持 normal / intern / graduated');
      }
      apply('status', next);
    }
    if (body.classroom !== undefined) apply('classroom', str(body.classroom, 40));
    if (body.remark !== undefined) apply('remark', str(body.remark, 200));
    // 班级名与院校 / 系部归属不在此改（班级名由学籍推导；改归属应走组织架构 / 名单导入，
    // 台账上的 schoolId/schoolName、departmentId/departmentName 只由 syncClassProfiles 带出）。
    // 人数（studentCount / dormCount）也不让手改：应到取学籍人数、应住取住宿名单人数，
    // 都是实时推导的（services/class-counts.js），手填会在学生转班 / 退宿后立刻失真。
    const unsupported = Object.keys(body).filter(
      (k) =>
        !['hasMorningExercise', 'hasMorningClass', 'hasNightStudy', 'hasMorningRun', 'enabled', 'status', 'classroom', 'remark'].includes(k)
    );
    if (unsupported.length) {
      const countKeys = unsupported.filter((k) => k === 'studentCount' || k === 'dormCount');
      if (countKeys.length) {
        throw new ApiError(400, 400, '应到 / 应住人数由学籍与住宿名单自动识别，不支持手工设置');
      }
      throw new ApiError(400, 400, `这些字段请在名单或组织架构里维护：${unsupported.join('、')}`);
    }

    if (Object.keys(changed).length) {
      await profile.save();
      clearBandChaoCaches();
      // 单班改状态时同步处理登录限制：毕业 → 限制该班学生登录；改回正常 → 解除
      if (changed.status === 'graduated') {
        await banClassesForGraduation({ className: profile.className });
      } else if (changed.status === 'normal') {
        await liftGraduationBans({ className: profile.className });
      }
    }
    const view = await profileView(profile, profile.className, true);
    ok(res, { ...view, changed });
  })
);

// ===== 接口：按班级名读改单个班 =====

// 读班级配置（class.view）
router.get(
  '/:className/profile',
  wrap(async (req, res) => {
    const className = classNameOf(req);
    const profile = await loadOrInitProfile(className);
    if (!profile) {
      // 学籍与台账里都没有这个班：明确 404，别让前端把 0 人当成「这个班真的没人」
      throw new ApiError(404, 404, '班级不存在（请先在「学生名单」里确认班级名，或从学籍同步班级台账）');
    }
    const perms = req.userPermissions || []; // 由 requirePermission('class.view') 写入
    const canEdit = perms.includes('*') || perms.includes('class.manage');
    ok(res, await profileView(profile, className, canEdit));
  })
);

// 改班级配置（class.manage）：className 不可改（URL 为准），字段逐个校验类型
router.put(
  '/:className/profile',
  MANAGE,
  wrap(async (req, res) => {
    const className = classNameOf(req);
    const profile = await loadOrInitProfile(className);
    if (!profile) {
      throw new ApiError(404, 404, '班级不存在（请先在「学生名单」里确认班级名，或从学籍同步班级台账）');
    }
    const body = req.body || {};
    const changed = {};
    const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
    const apply = (key, next) => {
      if (same(profile[key], next)) return;
      changed[key] = next;
      profile[key] = next;
    };

    // 布尔字段：空值不修改（没传 / null / '' 都不当作 false），其余严格校验类型
    const setBool = (key, label) => {
      if (isBlank(body[key])) return;
      apply(key, boolField(body[key], label));
    };
    setBool('hasMorningExercise', '是否有早操');
    setBool('hasMorningClass', '是否有早八');
    setBool('hasNightStudy', '是否有晚自习');
    setBool('hasMorningRun', '是否参加校园跑');
    setBool('enabled', '是否启用');
    // 应到 / 应住人数**不接受手工设置**：它们分别由学籍人数与住宿名单实时推导
    // （services/class-counts.js）。这里显式拒绝而不是静默忽略，
    // 免得旧前端 / 脚本以为「设置成功」，实际读出来还是真实人数。
    if (body.studentCount !== undefined || body.dormCount !== undefined) {
      throw new ApiError(400, 400, '应到 / 应住人数由学籍与住宿名单自动识别，不支持手工设置');
    }
    if (body.grade !== undefined) apply('grade', str(body.grade, 8));
    if (body.specialty !== undefined) apply('specialty', str(body.specialty, 30));
    if (body.homeroomNames !== undefined) apply('homeroomNames', namesField(body.homeroomNames));
    if (body.remark !== undefined) apply('remark', str(body.remark, 200));

    if (Object.keys(changed).length) {
      await profile.save();
      clearBandChaoCaches();
    }
    ok(res, { ...(await profileView(profile, className, true)), changed });
  })
);

// ===== 全校班级状态总览（用户 2026-10-29）=====
//   「增加班级状态页面显示所有班级的考勤、校园跑达标(日、周)，并且可以复制到文本如未达标班级等」
//
// 权限：`class.view`（前缀已挂，见 routes/admin/index.js）。
//   为什么复用它而不是新开权限项：这本来就是「查看班级配置」的读取范畴
//   （全校班级的考勤与达标），新开一项会让现网只有 class.view 的老师**直接失去入口**，
//   而他们恰恰是最需要看这张表的人（学生处 / 年级组长）。
//   写操作仍只走 class.manage，本接口纯只读。
//
// 口径实现全在 services/class-status-board.js（跨三张表聚合 + 可复制文案），
// 这里只做鉴权与取参 —— 避免第二份「达标判定」与班级页/首页漂移。
//
// 筛选参数（用户 2026-10-30「支持筛选，复制时复制的是筛选后的相应内容」）：
//   quick=notDaily|notWeek|zeroToday|attMissing  快捷筛选（白名单，非法值忽略）
//   department=系部名  keyword=班名/系部关键词   view=前端视图名（原样回显）
// 筛选放服务端而不是前端：可复制文案必须服务端单点生成（否则「列表 87%、文案 88%」），
// 若筛选在前端、文案在服务端，两者用的就是不同的行集合 —— 正是要避免的那类不一致。
// 回落：白名单外的取值一律当「未指定」，前端拼错参数时退回全量而不是筛成空。
router.get(
  '/status-board',
  wrap(async (req, res) => {
    const board = require('../../services/class-status-board');
    const str = (v) => String(v ?? '').trim();
    const full = await board.classStatusBoard({ today: str(req.query.today) || undefined, days: req.query.days });
    ok(
      res,
      board.applyBoardFilter(full, {
        // 院校 + 系部成对（同名系部跨校区，只能靠 school 消歧）
        school: str(req.query.school),
        department: str(req.query.department),
        quick: str(req.query.quick),
        // 档位筛选：level × metric（日/周）
        level: str(req.query.level),
        metric: str(req.query.metric),
        keyword: str(req.query.keyword),
        // 复制口径（文案强调哪个指标）
        copy: str(req.query.copy),
      })
    );
  })
);

module.exports = router;
