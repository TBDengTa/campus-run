/**
 * 学生会域接口??api/union/*?? *
 * ===== 权限模型：学生会成员资格 + 模块归属 + 院系范围（刻意不??requirePermission??====
 *   ??是学生会成员：student_union_members 存在 status=active 记录（services/union.js::resolveIdentity?? *   ??模块归属：成员的 deptKey ??check_modules.entryDeptKeys 内（??hygiene ??['life']?? *   ??院系范围：校级成员全校可录；分院成员只能录本院系班级（目标班级的 departmentId 必须匹配?? *   任一不满????403 + 403002??*不用 403003**：那是「未绑定账号」，会让已登录用户被踢回登录页）
 *
 * 本路??*不提??*跨班级越权读：记录列表一律按 identity 的可见范围过滤（scopeFilter）?? * 班委 / 班主任的只读视图??/api/class/*（成员资格校验），完全分开，避免两套权限互相污染?? *
 * ===== 写入规则（见方案 §5.6??====
 *   - 同一「模??+ 受检对象 + 日期 + 时段」只允许一条生效记录（库层部分唯一索引 + 应用??409 提示?? *   - 补录窗口默认 T+3（services/config 里的 banchao.backfillDays，管理端可改?? *   - cancelled 记录退出统计（早操临时取消用），rejected 可改后重?? *   - 修改??revision + history 留痕，不做物理删?? */
const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { wrap, ok, ApiError, parsePagination } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const dates = require('../utils/dates');
const CheckRecord = require('../models/check-record');
const ClassProfile = require('../models/class-profile');
const Organization = require('../models/organization');
const DormRoom = require('../models/dorm-room');
const DormAssignment = require('../models/dorm-assignment');
const SanitaryArea = require('../models/sanitary-area');
const User = require('../models/user');
const UnionMember = require('../models/union-member');
const UnionDepartment = require('../models/union-department');
const UnionInvite = require('../models/union-invite');

const unionSvc = require('../services/union');
const checkModules = require('../services/check-modules');
const bandChao = require('../services/band-chao');
const roster = require('../services/roster');
const { liveCount } = require('../services/class-counts');

const router = express.Router();
router.use(auth);

const NO_ACCESS = '这项操作不在你的学生会职责范围内';
const CONFIG = {
  // 补录窗口（天）：超过后只能由管理端补??
  backfillDays: Number(process.env.BANCHAO_BACKFILL_DAYS || 3),
};

// ===== 公共小工??=====

function assertMember(identity) {
  if (!identity || !identity.isMember) throw new ApiError(403, 403002, '你还不是学生会成员');
}

// ===== 「学生会总管」（union.steward）在本套用户端接口里的放行 =====
// 成员名单的管理有两条路：管理端 /api/admin/union/*（按 union.view / union.manage 权限，
// 总管经 PERM_IMPLIES 自动蕴含这两项，天然可用），以及这里的 /api/union/manage/*
//（按**学生会身份**：主席团 / 部长）。
// 用户 2026-10-20 要求新增「学生会总管」权限后，总管**即使不是学生会成员**也要能管理成员
//（团委老师 / 学生处干事通常不在成员名单里，却需要维护名单），且范围＝全校。
// 判定顺序刻意是「身份先、权限后」：主席团/部长不额外查权限（省一次组展开）；
// 只有身份不够时才落到总管权限兜底。
async function isSteward(req) {
  const perms = (await req.user.getEffectivePermissions()) || [];
  return perms.includes('union.steward');
}

// 「查看检查记录」的可见范围（用户 2026-10-21「学生会总管是可以查看检查记录的，现在显示无法查看」）。
//
// 为什么需要它：`/records` 与 `/records/:id` 原来只认两种身份 ——
//   ① 学生会成员 → 按身份范围；② 非成员 → 只限自己班（班主任/班委/本班学生）。
// 总管（团委老师/学生处干事）通常**既不在成员名单里、也没有班级**，于是
// 列表落到 `scope = null` 直接 403、详情落到四条放行全不匹配 → 表现就是「无法查看」。
//
// 判定顺序与 assertMemberManager 一致：**身份先、权限后**（成员不额外查权限组，省一次展开）。
// 返回 true = 总管，可见范围 = 全校（与校级主席团同口径）。
async function isRecordSteward(req, identity) {
  if (!identity || !identity.isMember) {
    // 非成员才需要查权限组；成员按身份范围走，不给额外全校视野
    return isSteward(req);
  }
  return false;
}

// 成员管理入口闸门：放行时返回 true=总管（全校范围），false=按身份范围
async function assertMemberManager(req, identity) {
  if (unionSvc.canManageMembers(identity)) return false;
  if (await isSteward(req)) return true;
  throw new ApiError(403, 403002, '只有主席团、部门部长或学生会总管可以调整成员');
}

// ===== 扫码加入用的两个小工具（与 routes/admin/union.js 同名同义）=====
// 为什么不在本文件 require admin/union.js：那是「管理端路由模块」，import 它会把整套
// /api/admin/* 路由树拉进用户端进程的依赖图，且职责混乱。这里只复制**两个纯校验函数**，
// 语义与那份逐字一致（有 check-server-contract 断言两边口径相同）。
const str = (v, max = 120) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

// 部门必须存在（保留 presidium 用于主席团）。返回含 schoolId/scope 的完整关键字段 ——
// 调用方要用它做校区归属校验，只返回 key/name 就没法判。
async function assertDept(deptKey, { allowEmpty = true } = {}) {
  const key = str(deptKey, 32);
  if (!key) {
    if (allowEmpty) return { key: '', name: '', schoolId: null, scope: 'both' };
    throw new ApiError(400, 400, '请选择部门');
  }
  const dept = await UnionDepartment.findOne({ key }).lean();
  if (!dept) throw new ApiError(400, 400, '部门不存在（请先在「部门配置」里添加）');
  return { key: dept.key, name: dept.name, schoolId: dept.schoolId || null, scope: dept.scope || 'both' };
}

// 部门是否可用于该层级/校区：主席团豁免；有 schoolId 只能同校区；无 schoolId 时
// 校级层只允许主席团（用户 2026-10-21「全校仅有主席团没有其他部门了」）。
function assertDeptFitsCampus(dept, level, schoolId) {
  if (!dept || !dept.key) return;
  if (dept.key === unionSvc.PRESIDIUM_KEY) return;
  const want = schoolId ? String(schoolId) : '';
  if (dept.schoolId) {
    if (level === 'school') {
      throw new ApiError(400, 400, `「${dept.name}」属于某个院校的分会，不能作为校学生会部门`);
    }
    if (String(dept.schoolId) !== want) {
      throw new ApiError(400, 400, `「${dept.name}」不属于所选校区，请重新选择部门`);
    }
    return;
  }
  if (level === 'school') {
    throw new ApiError(400, 400, `「${dept.name}」不是学生会主席团，请选择具体院校（校区）`);
  }
}

// 成员是否可被当前账号管理：总管放行全部；否则按身份范围（校/院/本部门）
function memberManageAllowed(isStewardScope, identity, member) {
  return isStewardScope || unionSvc.memberInManageScope(identity, member);
}

async function requireModule(moduleKey) {
  const key = String(moduleKey || '').trim();
  if (!key) throw new ApiError(400, 400, '缺少 moduleKey');
  const mod = await checkModules.getModule(key);
  if (!mod) throw new ApiError(404, 404, '检查模块不存在');
  if (mod.enabled === false) throw new ApiError(400, 400, `${mod.name} 已停用`);
  return mod;
}

function assertDateWithinBackfill(dateKey, { isUpdate = false } = {}) {
  if (!dates.isValidDateKey(dateKey)) throw new ApiError(400, 400, '日期格式应为 YYYY-MM-DD');
  const today = dates.todayKey();
  if (dateKey > today) throw new ApiError(400, 400, '不能录入未来日期的检查');
  if (isUpdate) return;
  const earliest = dates.addDays(today, -Math.max(0, CONFIG.backfillDays));
  if (dateKey < earliest) {
    throw new ApiError(400, 400, `只能补录最??${CONFIG.backfillDays} 天的检查，更早的请联系管理员`);
  }
}

// 班级归属信息（优??class_profiles，缺失时回退 users 聚合）——分院范围校验的基准
async function resolveClassInfo(className) {
  const name = String(className || '').trim();
  if (!name) return null;
  // 人数一律实时统计：应到 = 本班在册学生数、应住 = 本班在住学生数（用户明确要求自动识别）
  const live = await liveCount(name);
  const profile = await ClassProfile.findOne({ className: name }).lean();
  if (profile) {
    return {
      className: name,
      departmentId: profile.departmentId ? String(profile.departmentId) : '',
      departmentName: profile.departmentName || '',
      grade: profile.grade || '',
      studentCount: live.studentCount,
      dormCount: live.dormCount,
      hasMorningExercise: profile.hasMorningExercise !== false,
      hasMorningClass: profile.hasMorningClass !== false,
      // 晚自习（用户 2026-10-21）：录入时据此拦截「本班无晚自习」
      hasNightStudy: profile.hasNightStudy !== false,
    };
  }
  const student = await User.findOne({ className: name, role: { $ne: 'teacher' } })
    .select('departmentId departmentName grade')
    .lean();
  if (!student) return null;
  return {
    className: name,
    departmentId: student.departmentId ? String(student.departmentId) : '',
    departmentName: student.departmentName || '',
    grade: student.grade || '',
    studentCount: live.studentCount,
    dormCount: live.dormCount,
    hasMorningExercise: true,
    hasMorningClass: true,
  };
}

// 解析受检对象 ??归属班级（宿??/ 卫生区经映射反查??*不接受客户端手填班级**??
async function resolveTarget(moduleDef, { targetType, targetId }) {
  const type = String(targetType || '').trim();
  const id = String(targetId || '').trim();
  if (!id) throw new ApiError(400, 400, '缺少受检对象');
  if (!(moduleDef.targetTypes || []).includes(type)) {
    throw new ApiError(400, 400, `${moduleDef.name} 不支持这种受检对象`);
  }

  if (type === 'classroom' || type === 'class') {
    const info = await resolveClassInfo(id);
    if (!info) throw new ApiError(404, 404, '班级不存在（班级台账未初始化，请联系管理员同步）');
    return { ...info, targetType: type, targetId: id, targetName: id, owners: [{ className: id, weight: 1 }] };
  }

  if (type === 'dorm_room') {
    if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 404, '宿舍房间不存在');
    const room = await DormRoom.findById(id).lean();
    if (!room) throw new ApiError(404, 404, '宿舍房间不存在');

    // ⚠️ 归属**不能**??room.className：那是房间的「默认班级」，混宿（一班以上同住一间）??
    // 用它会把整间的得??扣分 100% 记到那一个班头上（用户明确：宿舍是学生绑定，不是班级绑定）??
    // 正确口径：按 dorm_assignments 里这间房??*在住学生所属班??*分组，人数即权重 ??按住宿人数分摊??
    const residents = await DormAssignment.find({ roomId: room._id, status: { $in: ['checked_in', 'guest'] } })
      .select('className')
      .lean();
    const countBy = new Map();
    for (const a of residents) {
      const cn = String(a.className || '').trim();
      if (!cn) continue;
      countBy.set(cn, (countBy.get(cn) || 0) + 1);
    }
    let owners = [...countBy.entries()].map(([className, weight]) => ({ className, weight }));
    // 这间房还没有住宿名单（管理员尚未录入）时才退回房间默认班级，并在录入台上标出来提醒补名单
    if (!owners.length && room.className) owners = [{ className: room.className, weight: 1 }];

    const primaryClass = owners[0] ? owners[0].className : room.className || '';
    const info = primaryClass ? await resolveClassInfo(primaryClass) : null;
    return {
      className: primaryClass,
      departmentId: room.departmentId ? String(room.departmentId) : (info && info.departmentId) || '',
      departmentName: room.departmentName || (info && info.departmentName) || '',
      grade: (info && info.grade) || '',
      studentCount: info ? info.studentCount : 0,
      dormCount: info ? info.dormCount : 0,
      hasMorningExercise: true,
      hasMorningClass: true,
      targetType: type,
      targetId: id,
      targetName: `${room.buildingName || room.buildingId || ''}${room.buildingName ? ' ' : ''}${room.roomNo}`.trim(),
      room,
      owners,
      // 本房间在住人数（应住人数的注入来??—??用户要求「应住是已知数，不让录入人填」）
      residentCount: residents.length,
      // 名单未录????前端可提示「本房间还没有住宿名单，得分暂按默认班级计??
      needsRoster: !owners.length || !countBy.size,
    };
  }

  // area：卫生区可能多班共管，班级归属来自映射表并带权重
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 404, '卫生区不存在');
  const area = await SanitaryArea.findById(id).lean();
  if (!area) throw new ApiError(404, 404, '卫生区不存在');
  const classNames = (area.classNames || []).filter(Boolean);
  const owners = classNames.map((cn) => ({ className: cn, weight: area.weights && area.weights[cn] ? Number(area.weights[cn]) : 1 }));
  let info = null;
  if (classNames.length) info = await resolveClassInfo(classNames[0]);
  return {
    className: classNames[0] || '',
    classNames,
    departmentId: area.departmentId ? String(area.departmentId) : (info && info.departmentId) || '',
    departmentName: area.departmentName || (info && info.departmentName) || '',
    grade: (info && info.grade) || '',
    studentCount: info ? info.studentCount : 0,
    hasMorningExercise: true,
    hasMorningClass: true,
    targetType: type,
    targetId: id,
    targetName: area.name,
    area,
    owners,
  };
}

// ===== 身份 =====

// 我的学生会身份（非成员返??200 + roles: []，首页据此隐藏「学生会块」）
router.get(
  '/mine',
  wrap(async (req, res) => {
    const identity = await unionSvc.resolveIdentity(req.user);
    const modules = await checkModules.listModules();
    ok(res, {
      isMember: identity.isMember,
      roles: identity.roles,
      roleText: identity.roleText,
      roleCount: identity.roleCount,
      level: identity.level,
      reviewLevel: identity.reviewLevel,
      isPresidium: identity.isPresidium,
      canEnter: identity.modules, // 可录入的模块 key
      canReview: unionSvc.canReviewAny(identity),
      canManageMembers: unionSvc.canManageMembers(identity),
      // 当前学年 + 届次（团委换届按学年计）：前端头部展示「2026学年 · 第24届」，跨 9 月自动递增。
      // 届次由 services/union.js 的 TERM_SESSION_BASE 统一推算，页面不要自己算。
      termName: (unionSvc.academicTerms().list[0] || {}).termName || '',
      termSession: (unionSvc.academicTerms().list[0] || {}).session || null,
      termSessionName: (unionSvc.academicTerms().list[0] || {}).sessionName || '',
      termLabel: (unionSvc.academicTerms().list[0] || {}).termLabel || '',
      // ⚠️ 这里只下发模??*元信??*（名??/ 周期 / 可录权限），供导航与列表用；
      // **不含 fields**。录入表单必须再??GET /api/union/modules?moduleKey=xxx 取模板，
      // 否则前端 module.fields ??undefined，抽屉会只剩标题和按钮（??packageUnion/entry/entry.js::load）??
      modules: modules
        .filter((m) => m.enabled !== false)
        .map((m) => ({
          key: m.key,
          name: m.name,
          shortName: m.shortName || m.name,
          ownerDeptName: m.ownerDeptName || '',
          targetTypes: m.targetTypes || [],
          periods: m.periods || [],
          // ??canEnterModule 同源（主席团短路后全校模块都??true），不要在这里另写判??
          canEnter: unionSvc.canEnterModuleKey(identity, m),
          sort: m.sort || 0,
        })),
      classProfileLinked: !!(req.user.className && (await ClassProfile.exists({ className: req.user.className }))),
    });
  })
);

// 学生会通讯录：所有在职成员都能查看（只读，不下发 openid / 学号等敏感字段）
// 学年（届次）按 9 月自动切：没写 termName 的老记录默认归到「当前学年」，不再显示空白。
router.get(
  '/roster',
  wrap(async (req, res) => {
    const identity = await unionSvc.resolveIdentity(req.user);
    assertMember(identity);
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 500));
    const terms = unionSvc.academicTerms();
    const currentTerm = terms.list[0] || {};
    const [total, rows] = await Promise.all([
      UnionMember.countDocuments({ status: 'active' }),
      UnionMember.find({ status: 'active' })
        .sort({ level: 1, schoolName: 1, departmentName: 1, deptName: 1, role: 1, realName: 1 })
        .limit(limit)
        .lean(),
    ]);
    ok(res, {
      total,
      limited: total > rows.length,
      currentTerm: terms.current,
      currentTermName: currentTerm.termName || '',
      currentTermLabel: terms.currentLabel || '',
      currentSessionName: currentTerm.sessionName || '',
      terms: terms.list,
      list: rows.map((m) => ({
        id: String(m._id),
        realName: m.realName || '',
        className: m.className || '',
        level: m.level,
        levelText: m.level === 'school' ? '校学生会' : '分院学生会',
        orgTitle: m.level === 'school' ? '校学生会' : `${m.schoolName || '未设院校'}学生会`,
        schoolName: m.schoolName || '',
        departmentName: m.departmentName || '',
        deptName: m.deptName || (m.deptKey === 'presidium' ? '主席团' : ''),
        roleText: UnionMember.ROLE_TEXT[m.role] || m.role,
        termId: m.termId || terms.current,
        termName: m.termName || currentTerm.termName || '',
        // 届次跟着学年走：老记录缺学年时按当前学年补，届次也一起补齐
        sessionName:
          (terms.list.find((t) => t.termId === (m.termId || terms.current)) || currentTerm).sessionName || '',
      })),
    });
  })
);

// ===== 学生会成员管理（主席团 / 部长，按本校 / 本院 / 本部门收敛）=====

const MANAGE_ROLES = ['member', 'vice_minister', 'minister'];

function presentManageMember(m) {
  return {
    id: String(m._id),
    realName: m.realName || '',
    className: m.className || '',
    level: m.level,
    levelText: m.level === 'school' ? '校学生会' : '分院学生会',
    orgTitle: m.level === 'school' ? '校学生会' : `${m.schoolName || '未设院校'}学生会`,
    schoolName: m.schoolName || '',
    departmentName: m.departmentName || '',
    deptKey: m.deptKey || '',
    deptName: m.deptName || (m.deptKey === 'presidium' ? '主席团' : ''),
    role: m.role,
    roleText: UnionMember.ROLE_TEXT[m.role] || m.role,
    termId: m.termId || '',
    termName: m.termName || '',
  };
}

// ===== 扫码加入学生会（用户 2026-10-22）=====
// 场景：学生在自己主页调出二维码（内容 = 一次性凭证串）→ 学生会干部用微信扫一扫 →
//       打开小程序「加入确认页」→ 选部门 → 确认后加入该部门。
//
// 三条安全约定：
//  ① 凭证**绑学生本人**且一次性（用掉即作废）—— 截图流传也只能用一次，且能追溯到是谁的码；
//  ② 有效期 10 分钟（models/union-invite.js::TTL_MS）—— 太短来不及出示、太长截图风险大；
//  ③ 加入动作走**与成员管理同一套闸门**（assertMemberManager）：
//     只有主席团/部长/副部长/总管能加人，且只能加到自己有权限的部门。

// 学生取自己的凭证（学生本人才能取，否则任何人都能拿别人的码）
//
// 也支持 ?userId=xxx：管理员在「用户详情」页要**替这个学生**生成码给他看。
// 但必须校权 —— 否则任何人都能批量生成别人的入会码（等于绕过凭证的意义）：
//   ① 本人 → 直接放行；
//   ② 他人 → 需要 union.manage / union.steward 这类「能管成员」的权限。
router.get(
  '/invite/mine',
  wrap(async (req, res) => {
    const me = req.user;
    if (!me || !me._id) throw new ApiError(401, 401, '未登录');
    const wantId = str(req.query.userId, 32);
    let targetUser = me;
    if (wantId && wantId !== String(me._id)) {
      if (!mongoose.isValidObjectId(wantId)) throw new ApiError(400, 400, '用户不存在');
      // 谁能替别人生成码：**能管成员的人**（与 assertMemberManager 同口径）+ 超管。
      // 不能只用 config 类管理权限：主席团/部长手里通常只有学生会身份、没有 union.manage，
      // 但「扫码加人」场景里正是他们需要替被扫到的学生取码。
      // ⚠️ 超管必须单独判：它持 '*' 但**不是学生会成员**，canManageMembers 会返回 false。
      const perms = (await me.getEffectivePermissions()) || [];
      let canManageOthers = perms.includes('*');
      if (!canManageOthers) {
        const identity = await unionSvc.resolveIdentity(me);
        canManageOthers = unionSvc.canManageMembers(identity);
      }
      if (!canManageOthers) canManageOthers = await isSteward(req);
      if (!canManageOthers) throw new ApiError(403, 403002, '只能生成自己的二维码');
      const other = await User.findById(wantId).lean();
      if (!other) throw new ApiError(404, 404, '用户不存在');
      // 教师**也可以**有二维码（用户 2026-10-22「所有用户都有码包括教师账户」）：
      // 教师不是学生会成员，所以扫码加人时会被拒（见 /accept 里的教师拦截），
      // 但「能出示自己的码」本身是身份展示能力，没必要禁。
      targetUser = other;
    }

    const userId = targetUser._id;
    const now = new Date();
    // 复用未过期的旧凭证（学生反复打开二维码不该每次都换新）
    let doc = await UnionInvite.findOne({
      userId,
      usedAt: null,
      expiresAt: { $gt: now },
    }).sort({ createdAt: -1 });

    if (!doc) {
      doc = await UnionInvite.create({
        token: crypto.randomBytes(32).toString('hex'),
        userId,
        realName: targetUser.realName || targetUser.nickname || '',
        studentId: targetUser.studentId || '',
        className: targetUser.className || '',
        expiresAt: new Date(now.getTime() + UnionInvite.TTL_MS),
      });
    }
    // 二维码图片（dataURL）：前端直接 <image src> 显示，不必让每台手机各装一个库。
    // 内容就是 qrText（ttkp://union-invite/<token>），干部用微信扫一扫即可识别。
    // 生成失败**不影响**接口：仍返回 token/qrText，前端可回退展示文本 ——
    // 否则「二维码画不出来」会让整个出码功能不可用。
    const qrText = `ttkp://union-invite/${doc.token}`;
    let qrImage = '';
    try {
      const QRCode = require('qrcode');
      qrImage = await QRCode.toDataURL(qrText, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 520,
        color: { dark: '#1c1f23', light: '#ffffff' },
      });
    } catch (e) {
      qrImage = '';
    }
    ok(res, {
      token: doc.token,
      expiresAt: doc.expiresAt,
      realName: doc.realName || '',
      studentId: doc.studentId || '',
      className: doc.className || '',
      qrText,
      qrImage,
    });
  })
);

// 干部「预览」一张凭证：扫完先看清要加的是谁（不消费凭证）
router.get(
  '/invite/:token',
  wrap(async (req, res) => {
    const identity = await unionSvc.resolveIdentity(req.user);
    await assertMemberManager(req, identity);
    const token = str(req.params.token, 64);
    if (!token) throw new ApiError(400, 400, '缺少凭证');
    const doc = await UnionInvite.findOne({ token }).lean();
    if (!doc) throw new ApiError(404, 404, '二维码无效或已过期，请让学生重新打开二维码');
    if (doc.usedAt) throw new ApiError(409, 409001, '这张二维码已经被使用过了，请让学生重新打开');
    if (doc.expiresAt && doc.expiresAt.getTime() < Date.now()) {
      throw new ApiError(409, 409001, '二维码已过期，请让学生重新打开');
    }
    // 已是成员则提前说明，避免干部确认后才发现重复
    const exists = await UnionMember.findOne({ userId: doc.userId, status: 'active' }).lean();
    ok(res, {
      realName: doc.realName || '',
      studentId: doc.studentId || '',
      className: doc.className || '',
      userId: String(doc.userId),
      alreadyMember: !!exists,
      alreadyDeptName: exists ? exists.deptName || '' : '',
      expiresAt: doc.expiresAt,
    });
  })
);

// 干部确认加入：把该学生加进指定部门（消费凭证）
// 复用与 POST /manage/members 相同的校验链（部门存在 → 校区归属 → 名单去重）
router.post(
  '/invite/:token/accept',
  wrap(async (req, res) => {
    const identity = await unionSvc.resolveIdentity(req.user);
    await assertMemberManager(req, identity);
    const token = str(req.params.token, 64);
    const body = req.body || {};
    if (!token) throw new ApiError(400, 400, '缺少凭证');

    const doc = await UnionInvite.findOne({ token });
    if (!doc) throw new ApiError(404, 404, '二维码无效或已过期，请让学生重新打开二维码');
    if (doc.usedAt) throw new ApiError(409, 409001, '这张二维码已经被使用过了，请让学生重新打开');
    if (doc.expiresAt && doc.expiresAt.getTime() < Date.now()) {
      throw new ApiError(409, 409001, '二维码已过期，请让学生重新打开');
    }

    const student = await User.findById(doc.userId).lean();
    if (!student) throw new ApiError(400, 400, '该学生账号不存在');
    if (student.role === 'teacher') throw new ApiError(400, 400, '教师账号不能加入学生会');

    // 部门与层级由干部的**成员记录**决定（他自己在哪个部门/校区，就加到那里），
    // 也允许前端显式传（干部可能同时属于多个部门）——但必须仍在他自己的管理范围内。
    let deptKey = str(body.deptKey, 32);
    if (!deptKey) {
      const own = (identity.members || []).filter((m) => m && m.deptKey && m.status === 'active');
      if (!own.length) throw new ApiError(400, 400, '你在学生会里还没有部门，无法加人');
      deptKey = own[0].deptKey;
    }
    const dept = await assertDept(deptKey, { allowEmpty: false });

    // 层级/校区：跟干部自己的记录一致（校级干部加校级，分会干部加本校区）
    const ownRec =
      (identity.members || []).find((m) => m && m.deptKey === dept.key && m.status === 'active') ||
      (identity.members || []).find((m) => m && m.status === 'active') ||
      {};
    const level = ownRec.level === 'branch' ? 'branch' : 'school';
    const schoolId = level === 'branch' ? ownRec.schoolId || null : null;

    // 部门归属校区校验（与成员管理同一份守卫）
    assertDeptFitsCampus(dept, level, schoolId);

    const dupFilter = { userId: student._id, level, deptKey: dept.key, status: 'active' };
    if (level === 'branch' && schoolId) dupFilter.schoolId = schoolId;
    const exists = await UnionMember.findOne(dupFilter).lean();
    if (exists) throw new ApiError(409, 409001, '该同学已在这个部门了');

    const terms = unionSvc.academicTerms();
    const currentTerm = terms.list[0] || {};
    const created = await UnionMember.create({
      userId: student._id,
      openid: student.openid || '',
      realName: student.realName || student.nickname || student.account || '',
      studentId: student.studentId || '',
      className: student.className || '',
      level,
      schoolId,
      schoolName: level === 'branch' ? ownRec.schoolName || '' : '',
      deptKey: dept.key,
      deptName: dept.name,
      role: 'member',
      status: 'active',
      termId: currentTerm.termId || '',
      termName: currentTerm.termName || '',
    });

    // 消费凭证（记录是谁用的，便于审计）
    doc.usedAt = new Date();
    doc.usedByOpenid = req.user.openid || '';
    doc.usedByName = req.user.realName || req.user.nickname || '';
    await doc.save();
    unionSvc.clearIdentityCache(student.openid);

    ok(res, {
      member: presentManageMember(created.toObject()),
      deptName: dept.name,
      realName: created.realName,
    });
  })
);

router.get(
  '/manage/members',
  wrap(async (req, res) => {    const identity = await unionSvc.resolveIdentity(req.user);
    const steward = await assertMemberManager(req, identity);
    const rows = await UnionMember.find({ status: 'active' })
      .sort({ level: 1, schoolName: 1, departmentName: 1, deptName: 1, role: 1, realName: 1 })
      .lean();
    const terms = unionSvc.academicTerms();
    const currentTerm = terms.list[0] || {};
    const list = rows
      .filter((m) => memberManageAllowed(steward, identity, m))
      .map((m) => {
        const item = presentManageMember(m);
        // 老记录没写学年：按当前学年展示，避免列表出现空字段；届次一并补齐
        const term = terms.list.find((t) => t.termId === item.termId) || currentTerm;
        item.termId = item.termId || currentTerm.termId || '';
        item.termName = item.termName || term.termName || '';
        item.sessionName = term.sessionName || '';
        item.termLabel = term.termLabel || item.termName;
        return item;
      });
    const depts = await UnionDepartment.find({ enabled: true, key: { $ne: 'presidium' } })
      .sort({ sort: 1 })
      .lean();
    ok(res, {
      total: list.length,
      list,
      // 总管视角的文案：他可能不是成员，roleText 会是空的
      scopeText: steward ? '学生会总管（全校）' : identity.roleText,
      currentTermLabel: terms.currentLabel || '',
      currentSessionName: currentTerm.sessionName || '',
      terms: terms.list,
      // 转移部门：校级主席团 / 总管可跨部门；分院主席团与部长仍限自己范围
      canTransfer: steward || !!identity.isPresidium,
      isSteward: !!steward,
      departments: depts.map((d) => ({ key: d.key, name: d.name, scope: d.scope })),
    });
  })
);

router.put(
  '/manage/members/:id',
  wrap(async (req, res) => {
    const identity = await unionSvc.resolveIdentity(req.user);
    const steward = await assertMemberManager(req, identity);
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '成员不存在');
    const member = await UnionMember.findById(req.params.id);
    if (!member || member.status !== 'active') throw new ApiError(404, 404, '成员不存在');
    if (!memberManageAllowed(steward, identity, member)) throw new ApiError(403, 403002, '只能调整本校 / 本院 / 本部门的成员');
    if (member.openid && member.openid === req.user.openid) throw new ApiError(403, 403002, '不能调整自己的职务');

    const body = req.body || {};
    const role = String(body.role || '').trim();
    const deptKey = String(body.deptKey || '').trim();
    if (!role && !deptKey) throw new ApiError(400, 400, '缺少要调整的职务或部门');
    if (role && !MANAGE_ROLES.includes(role)) throw new ApiError(400, 400, '职务只支持部员 / 副部长 / 部长');

    if (deptKey) {
      // 转移部门：校级主席团或总管可以（分院主席团 / 部长不行）
      if (!steward && !identity.isPresidium) throw new ApiError(403, 403002, '只有主席团或学生会总管可以转移成员部门');
      const dept = await UnionDepartment.findOne({ key: deptKey, enabled: true }).lean();
      if (!dept || dept.key === 'presidium') throw new ApiError(400, 400, '目标部门不存在');
      if (dept.scope !== 'both' && dept.scope !== member.level) {
        throw new ApiError(400, 400, '该部门不适用于该成员的层级');
      }
      member.deptKey = dept.key;
      member.deptName = dept.name;
    }
    if (role) member.role = role;
    try {
      await member.save();
    } catch (e) {
      if (e && e.code === 11000) throw new ApiError(400, 400, '该成员已在目标部门');
      throw e;
    }
    unionSvc.clearIdentityCache(member.openid);
    ok(res, { member: presentManageMember(member.toObject()) });
  })
);

router.post(
  '/manage/members/:id/remove',
  wrap(async (req, res) => {
    const identity = await unionSvc.resolveIdentity(req.user);
    const steward = await assertMemberManager(req, identity);
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '成员不存在');
    const member = await UnionMember.findById(req.params.id);
    if (!member || member.status !== 'active') throw new ApiError(404, 404, '成员不存在');
    if (!memberManageAllowed(steward, identity, member)) throw new ApiError(403, 403002, '只能调整本校 / 本院 / 本部门的成员');
    if (member.openid && member.openid === req.user.openid) throw new ApiError(403, 403002, '不能将自己移出学生会');

    member.status = 'left';
    await member.save();
    unionSvc.clearIdentityCache(member.openid);
    ok(res, { removed: true });
  })
);

// 录入模板（前端按 fields 渲染表单，避免两端各写一套字段定义）
router.get(
  '/modules',
  wrap(async (req, res) => {
    const identity = await unionSvc.resolveIdentity(req.user);
    assertMember(identity);
    const list = await checkModules.listModules();
    const want = String(req.query.moduleKey || '').trim();
    const rows = list
      .filter((m) => m.enabled !== false && (!want || m.key === want))
      .map((m) => ({
        key: m.key,
        name: m.name,
        shortName: m.shortName || m.name,
        ownerDeptName: m.ownerDeptName || '',
        targetTypes: m.targetTypes || [],
        periods: m.periods || [],
        // fields 里带 derived: true 的字段是**服务端推??*的只读字段（缺勤 / 未归）：
        // 前端不要渲染成输入框，只在「计算结果」里展示（提交时也不必带，服务端会忽略）
        fields: m.fields || [],
        metrics: m.metrics || [],
        scoring: m.scoring || {},
        // 「没有记录 = 正常」的模块（早八：只记迟到人）：录入台据此把未录显示成「无迟到」、
        // 且不把它算作待办；**入口仍然保留**（有迟到时可进去补录）。
        optionalWhenMissing: m.optionalWhenMissing === true,
        noRecordText: m.noRecordText || '',
        // ??canEnterModule 同源（主席团短路 ??任意模块均可录入??
        canEnter: unionSvc.canEnterModuleKey(identity, m),
      }));
    ok(res, {
      list: rows,
      canEnter: identity.modules,
      canReview: unionSvc.canReviewAny(identity),
      canManageMembers: unionSvc.canManageMembers(identity),
      isPresidium: identity.isPresidium,
      // 名单类字段（缺勤 / 未归名单）单条记录的人数上限：与服务端校验同源，前端据此限制勾??
      studentFieldLimit: checkModules.FIELD_LIMIT,
    });
  })
);

// 应检学生名单（录入台点选「缺??/ 未归 / 迟到」，替代手输姓名学号??// 三种范围（第四轮按用户要求补）：
//   · className（默认）—??班内名单，晚自习 / 早操??//   · roomId           —??**宿内**名单（查宿用；混宿房间可能含别班学生，所以必须按房间取而不是按班）
//   · scope=school     —??**校内**名单（早八用；支??keyword 筛选与分页，跨班搜索）
// 权限链与提交记录一致：模块归属 + 范围（复??resolveTarget 解析受检对象与院系）
router.get(
  '/entry/students',
  wrap(async (req, res) => {
    const identity = await unionSvc.resolveIdentity(req.user);
    assertMember(identity);
    const moduleDef = await requireModule(req.query.moduleKey);

    // ===== 宿内名单（查宿）=====
    const roomId = String(req.query.roomId || '').trim();
    if (roomId) {
      if (!mongoose.isValidObjectId(roomId)) throw new ApiError(400, 400, '房间不存在');
      // 权限：受检对象是宿舍房间时，走与提交记录完全相同的判定（含混宿分摊出的院系??
      const target = await resolveTarget(moduleDef, { targetType: 'dorm_room', targetId: roomId });
      const perm = unionSvc.canEnterModule(identity, moduleDef, target.departmentId);
      if (!perm.ok) throw new ApiError(403, 403002, perm.reason);

      // 在住学生（含借住 guest）→ 反查 users。混宿房间会带出多个班的学生，这??*正确**的：
      // 查宿要按房间核对人，不是按班??
      const assigns = await DormAssignment.find({ roomId, status: { $in: ['checked_in', 'guest'] } })
        .select('openid studentId className buildingName buildingId roomNo bedNo')
        .limit(300)
        .lean();
      const openids = assigns.map((a) => a.openid).filter(Boolean);
      const users = openids.length
        ? await User.find({ openid: { $in: openids }, role: { $ne: 'teacher' } })
            .select('openid realName nickname account studentId className')
            .lean()
        : [];
      const byOpenid = new Map(users.map((u) => [u.openid, u]));
      const list = [];
      for (const a of assigns) {
        const u = byOpenid.get(a.openid);
        if (!u) continue; // 住宿记录对应的账号已删除 / 未绑??
        list.push({
          userId: String(u._id),
          name: u.realName || u.nickname || u.account || '未命名',
          studentId: u.studentId || a.studentId || '',
          className: u.className || a.className || '',
          roomNo: `${a.buildingName || a.buildingId || ''}${a.buildingName ? ' ' : ''}${a.roomNo || ''}`.trim(),
          bedNo: a.bedNo || '',
        });
      }
      list.sort((x, y) => String(x.studentId).localeCompare(String(y.studentId)));
      return ok(res, {
        scope: 'dorm',
        roomId,
        targetName: target.targetName || '',
        // 本房间应住人数（前端「自动计算」卡片的预览值；权威值仍由服务端注入，见 shouldCountCtx??
        residentCount: assigns.length,
        limit: checkModules.FIELD_LIMIT,
        list,
      });
    }

    // ===== 校内名单（早八迟到人）：跨班搜索 + 分页 =====
    if (String(req.query.scope || '') === 'school') {
      const keyword = String(req.query.keyword || '').trim().slice(0, 30);
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      // 范围收敛：校级（含全校主席团）看全校；分会只看本校区展开出的院系
      const cond = { role: { $ne: 'teacher' } };
      if (identity.level !== 'school') {
        const ids = (identity.departmentIds || []).filter(Boolean);
        if (!ids.length) throw new ApiError(403, 403002, '你所在的院校（校区）下还没有系部，请先到「组织架构」配置系部');
        cond.departmentId = { $in: ids };
      }
      if (req.query.className) cond.className = String(req.query.className).trim();
      if (keyword) {
        const re = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        cond.$or = [{ realName: re }, { nickname: re }, { account: re }, { studentId: re }, { className: re }];
      }
      const [total, rows] = await Promise.all([
        User.countDocuments(cond),
        User.find(cond)
          .select('realName nickname account studentId className')
          .sort({ studentId: 1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
      ]);
      return ok(res, {
        scope: 'school',
        page,
        limit,
        total,
        hasMore: page * limit < total,
        list: rows.map((u) => ({
          userId: String(u._id),
          name: u.realName || u.nickname || u.account || '未命名',
          studentId: u.studentId || '',
          className: u.className || '',
          roomNo: '',
        })),
      });
    }

    const className = String(req.query.className || '').trim();
    if (!className) throw new ApiError(400, 400, '缺少 className');

    const target = await resolveTarget(moduleDef, { targetType: 'class', targetId: className });
    const perm = unionSvc.canEnterModule(identity, moduleDef, target.departmentId);
    if (!perm.ok) throw new ApiError(403, 403002, perm.reason);

    const students = await User.find({ className, role: { $ne: 'teacher' } })
      .select('realName nickname account studentId')
      .sort({ studentId: 1 })
      .limit(300)
      .lean();
    const ids = students.map((s) => s.studentId).filter(Boolean);
    // 查宿 / 宿舍类顺带带上房间号（现场核对未归学生住哪间??
    const roomBy = new Map();
    if (ids.length) {
      const assigns = await DormAssignment.find({ studentId: { $in: ids }, status: { $in: ['checked_in', 'guest'] } })
        .select('studentId buildingName buildingId roomNo')
        .lean();
      for (const a of assigns) roomBy.set(a.studentId, `${a.buildingName || a.buildingId || ''} ${a.roomNo || ''}`.trim());
    }

    ok(res, {
      className,
      moduleKey: moduleDef.key,
      // 班级应到人数（前端「自动计算」卡片预览用）：由 resolveClassInfo 实时统计学籍人数得出，
      // 不再依赖 class_profiles.studentCount 的历史快照。
      studentCount: target.studentCount || 0,
      // 应住人数：来自住宿名单（dorm_assignments）实时聚合，查宿预填用。
      dormCount: target.dormCount || 0,
      limit: checkModules.FIELD_LIMIT,
      list: students.map((s) => ({
        userId: String(s._id),
        name: s.realName || s.nickname || s.account || '未命名',
        studentId: s.studentId || '',
        roomNo: roomBy.get(s.studentId) || '',
      })),
    });
  })
);

// 工作台：今日各模块录入进??+ 我的待提交量 + 待复核量
router.get(
  '/dashboard',
  wrap(async (req, res) => {
    const identity = await unionSvc.resolveIdentity(req.user);
    assertMember(identity);
    const date = dates.isValidDateKey(String(req.query.date || '')) ? String(req.query.date) : dates.todayKey();
    const modules = await checkModules.listModules();
    const scope = unionSvc.scopeFilter(identity) || {};

    // 当日我可见范围内的记??
    const records = await CheckRecord.find({ date, voided: { $ne: true }, ...scope })
      .select('moduleKey status inspectorOpenid departmentId className')
      .lean();

    const rows = [];
    for (const m of modules.filter((x) => x.enabled !== false)) {
      const mine = records.filter((r) => r.moduleKey === m.key);
      const entered = mine.filter((r) => ['submitted', 'approved'].includes(r.status)).length;
      // ??canEnterModule 同源（主席团短路 ??全模块可录入，工作台也据此算应录数）
      const canEnter = unionSvc.canEnterModuleKey(identity, m);
      // 「没有记录 = 正常」的模块（早八：只记迟到人）：不应计入「应录 / 未录」
      const optional = m.optionalWhenMissing === true;
      let expected = 0;
      if (canEnter) {
        const t = await bandChao.entryTargets({
          moduleDef: m,
          date,
          period: (m.periods || [])[0] || '',
          // null = 校级全校；数组（含空数组?? 分院范围。空数组必须 fail-closed，不能当成全校??
          scopeDepartmentIds: identity.level === 'school' ? null : identity.departmentIds || [],
          scopeSchoolIds: identity.level === 'school' ? null : identity.schoolIds || [],
          scopeSchoolNames: identity.level === 'school' ? null : identity.schoolNames || [],
          limit: 1000,
        });
        expected = t.summary.total;
      }
      rows.push({
        key: m.key,
        name: m.name,
        shortName: m.shortName || m.name,
        ownerDeptName: m.ownerDeptName || '',
        canEnter,
        // 「没有记录 = 正常」的模块（早八）：**不计入应录总数**（首页/工作台的「应录 N 条」不含它），
        // 但 rawExpected 保留真实对象数，供录入台内部进度（「N 个班 / 已录 M」）使用。
        expected: optional ? 0 : expected,
        rawExpected: expected,
        entered,
        cancelled: mine.filter((r) => r.status === 'cancelled').length,
        // missing 恒为 0（不计待办）；rawMissing 保留真实未录数，供「去补录」参考。
        missing: canEnter && !optional ? Math.max(0, expected - entered) : 0,
        rawMissing: canEnter ? Math.max(0, expected - entered) : 0,
        optionalWhenMissing: optional,
        noRecordText: optional ? m.noRecordText || '无迟到' : '',
      });
    }

    const scopeFilter = unionSvc.scopeFilter(identity) || {};
    const [pendingReview, myToday, myTotal] = await Promise.all([
      CheckRecord.countDocuments({ status: 'submitted', voided: { $ne: true }, ...scopeFilter }),
      CheckRecord.countDocuments({ date, inspectorOpenid: req.user.openid, voided: { $ne: true } }),
      CheckRecord.countDocuments({ inspectorOpenid: req.user.openid, voided: { $ne: true } }),
    ]);

    ok(res, {
      date,
      roles: identity.roles,
      roleText: identity.roleText,
      canReview: unionSvc.canReviewAny(identity),
      canManageMembers: unionSvc.canManageMembers(identity),
      reviewLevel: identity.reviewLevel,
      modules: rows,
      pendingReview,
      myToday,
      myTotal,
      myPendingAppeal: await CheckRecord.countDocuments({ 'appeal.status': 'pending', voided: { $ne: true }, ...scopeFilter }),
    });
  })
);

// 录入台对象列表（含每个对象的录入状态：未录 / 已录 / 已取消）
router.get(
  '/entry/targets',
  wrap(async (req, res) => {
    const identity = await unionSvc.resolveIdentity(req.user);
    assertMember(identity);
    const moduleDef = await requireModule(req.query.moduleKey);
    const perm = unionSvc.canEnterModule(identity, moduleDef, null);
    if (!perm.ok) throw new ApiError(403, 403002, perm.reason);

    const date = dates.isValidDateKey(String(req.query.date || '')) ? String(req.query.date) : dates.todayKey();
    const periods = moduleDef.periods || [];
    const period = String(req.query.period || periods[0] || '');
    const data = await bandChao.entryTargets({
      moduleDef,
      date,
      period,
      // null = 校级全校；数组（含空数组?? 分院范围。空数组必须 fail-closed??
      scopeDepartmentIds: identity.level === 'school' ? null : identity.departmentIds || [],
      scopeSchoolIds: identity.level === 'school' ? null : identity.schoolIds || [],
      scopeSchoolNames: identity.level === 'school' ? null : identity.schoolNames || [],
    });
    ok(res, {
      ...data,
      canEnter: true,
      isPresidium: identity.isPresidium,
      backfillDays: CONFIG.backfillDays,
    });
  })
);

// ===== 记录读写 =====

/**
 * 调用者上下文??*一次算好，整批复用**）—??宿舍照片可见者判??+ 前端可编辑标记共用?? *
 * 为什么单独抽出来：`/records`、`/class/:className` 是数??map，若每条记录各查一次身?? * 就是 N+1（且 identity ??30s 缓存也挡不住每条一??openid 查库??amplified 开销）?? * 约定??*每个请求只调一??buildViewer(req)**，把返回值传??presentRecord ??`viewer`?? *
 * 字段说明?? *   openid  —??检查人本人判定
 *   role    —??教师账号判定（含班主任）
 *   identity—??主席??/ 所属部门部长判定（resolveIdentity 的结果；缓冲??provider 走缓存）
 *   isInspector —??该请求是否“只看我自己的”（`/records?mine=1`），仅用于展示，不参与裁?? *                   （裁剪一律按记录自身??inspectorOpenid 逐条判定，不受列表筛选条件影响）
 */
async function buildViewer(req) {
  const identity = await unionSvc.resolveIdentity(req.user);
  return {
    openid: req.user.openid || '',
    role: req.user.role || '',
    identity,
  };
}

function presentRecord(r, { withDetails = true, viewer = null } = {}) {
  if (!r) return null;
  // 宿舍照片隐私裁剪：宿舍类照片对无权??*不下发原??URL**，只给模糊占位（??services/union.js::cropPhotos）??
  // 这是所有记录出口（详情 / 列表 / 我的 / 工作台最??/ 班级全景）的**唯一裁剪??*??
  // 不要在路由里另写一份判??—??漏一个出口就等于泄露原图??
  const photoView = unionSvc.cropPhotos(r, { viewer });
  const base = {
    id: String(r._id),
    moduleKey: r.moduleKey,
    moduleName: r.moduleName || '',
    date: r.date,
    period: r.period || '',
    targetType: r.targetType,
    targetId: r.targetId,
    targetName: r.targetName || r.className || '',
    className: r.className || '',
    departmentId: r.departmentId ? String(r.departmentId) : '',
    departmentName: r.departmentName || '',
    inspectorName: r.inspectorName || '',
    inspectorDeptKey: r.inspectorDeptKey || '',
    score: r.score,
    deduct: r.deduct,
    metrics: r.metrics || {},
    // 宿舍照片：无权??photos=[]??*零原??URL**?? photosBlurred 标记 + photoCount 用于渲染占位
    photos: photoView.photos,
    photosBlurred: photoView.photosBlurred,
    photoCount: photoView.photoCount,
    photoNote: photoView.photoNote,
    remark: r.remark || '',
    status: r.status,
    statusText:
      r.status === 'approved'
        ? '已复核'
        : r.status === 'rejected'
          ? '已退回'
          : r.status === 'cancelled'
            ? '已取消'
            : '已提交',
    cancelReason: r.cancelReason || '',
    rejectReason: r.rejectReason || '',
    reviewedByName: r.reviewedByName || '',
    reviewedAt: r.reviewedAt || null,
    appeal: r.appeal && r.appeal.status ? r.appeal : null,
    source: r.source,
    revision: r.revision || 1,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
  if (withDetails) {
    base.details = r.details || {};
    // 修改 / 复核 / 取消的留痕（详情页的「复核与修改留痕」区）。
    // ⚠️ 这里曾经**根本没下发 history**：详情页模板写了 wx:for="{{history}}"，但 presentRecord
    // 不返回它 → 列表恒为空、只剩「暂无复核或修改记录」，而库里的 history 其实一直在写
    //（复核 / 取消 / 提交修改都会 push，见 routes/union.js 的三处 history 写入）。
    // 只在 withDetails（= 详情出口）下发：列表出口用了 { withDetails: false }，
    // 那里不需要留痕，避免把每条记录的数组都塞进分页响应。
    base.history = (r.history || []).map((h) => ({
      revision: h.revision,
      at: h.at || null,
      byName: h.byName || '',
      changes: h.changes || {},
    }));
  }
  return base;
}

function fingerprint(r) {
  return {
    date: r.date,
    period: r.period || '',
    targetName: r.targetName || r.className || '',
    status: r.status,
    inspectorName: r.inspectorName || '',
  };
}

/**
 * 单条记录的扣分计算：卫生区多班共管时按权重分?? * 返回 [{ className, deduct, score }]
 */
function splitDeduct(target, moduleDef, details, metrics, totalDeduct) {
  const owners = target.owners && target.owners.length ? target.owners : [{ className: target.className, weight: 1 }];
  if (!owners.length) return [{ className: '', deduct: totalDeduct, score: details.score }];
  if (owners.length === 1) return [{ className: owners[0].className, deduct: totalDeduct, score: details.score }];
  const sum = owners.reduce((a, o) => a + (Number(o.weight) || 1), 0) || owners.length;
  return owners.map((o) => ({
    className: o.className,
    deduct: checkModules.round2((totalDeduct * (Number(o.weight) || 1)) / sum),
    score: details.score,
  }));
}

/**
 * ??fillDerived 准备「应??/ 应住人数」注入上下文??*服务端唯一来源**?? *
 * 用户第四轮口径：应到人数??*已知??*，不该让录入人再数一????表单里没有这个输入框?? * 但它??*出勤率的分母**，所以仍要落库，由服务端从台??/ 住宿名单注入?? *   · 班级类受检对象（class / classroom）→ class_profiles.studentCount（缺台账时回退 users 聚合，见 resolveClassInfo?? *   · 宿舍类受检对象（dorm_room??       ??该房??*在住**学生数（dorm_assignments，含借住 guest?? * 拿不到就返回空对????fillDerived 会退化为「按缺勤名单人数」计算，**不静默报 0**（见那边注释）?? */
function shouldCountCtx(target) {
  const ctx = {};
  if (!target) return ctx;
  if (target.targetType === 'dorm_room') {
    const n = Number(target.residentCount);
    if (Number.isFinite(n) && n > 0) ctx.shouldStay = n;
    return ctx;
  }
  const n = Number(target.studentCount);
  if (Number.isFinite(n) && n > 0) ctx.shouldCount = n;
  return ctx;
}

function normalizePeriods(moduleDef, period) {
  const p = String(period || '').trim();
  const allowed = moduleDef.periods || [];
  if (!p) return allowed[0] || '';
  if (allowed.length && !allowed.includes(p)) throw new ApiError(400, 400, '时段不在该检查模块的范围内');
  return p;
}

// 提交检查记??
router.post(
  '/records',
  wrap(async (req, res) => {
    const identity = await unionSvc.resolveIdentity(req.user);
    assertMember(identity);
    const body = req.body || {};
    const moduleDef = await requireModule(body.moduleKey);

    const target = await resolveTarget(moduleDef, body);
    const perm = unionSvc.canEnterModule(identity, moduleDef, target.departmentId);
    if (!perm.ok) throw new ApiError(403, 403002, perm.reason);

    const date = String(body.date || dates.todayKey()).slice(0, 10);
    assertDateWithinBackfill(date);
    const period = normalizePeriods(moduleDef, body.period);

    // 早操 / 早八 / 晚自习：本班没有这项就不允许录（避免造出无意义的 0 分记录）
    if (moduleDef.key === 'morning_exercise' && target.hasMorningExercise === false) {
      throw new ApiError(400, 400, '本班没有早操安排，无需录入');
    }
    if (moduleDef.key === 'morning_class' && target.hasMorningClass === false) {
      throw new ApiError(400, 400, '本班没有早八安排，无需录入');
    }
    // 晚自习（用户 2026-10-21「部分班级是没有晚自习的所以不涉及考勤」）
    if (moduleDef.key === 'study_evening' && target.hasNightStudy === false) {
      throw new ApiError(400, 400, '本班没有晚自习安排，无需录入');
    }

    const details = checkModules.fillDerived(
      moduleDef.key,
      checkModules.normalizeDetails(moduleDef, body.details),
      shouldCountCtx(target)
    );
    const metrics = checkModules.computeMetrics(moduleDef, details);
    const totalDeduct = checkModules.computeDeduct(moduleDef, details, metrics);
    const split = splitDeduct(target, moduleDef, details, metrics, totalDeduct);

    // 同一「对??+ 日期 + 时段」的重复提交判定：按**归属班级**判，
    // 因为混宿房间 / 共管卫生区一次检查会拆成多条记录（每班一条），不能互相判成重复??
    const ownersForDup = split.map((s) => s.className).filter(Boolean);
    const dup = await CheckRecord.findOne({
      moduleKey: moduleDef.key,
      targetType: target.targetType,
      targetId: target.targetId,
      date,
      period,
      className: { $in: ownersForDup },
      voided: { $ne: true },
    });
    if (dup) {
      throw new ApiError(409, 409001, '该对象当日已有检查记录，请修改原记录', {
        existingId: String(dup._id),
        existing: fingerprint(dup),
      });
    }

    // 多班共管（混宿房??/ 共管卫生区）??**每个归属班级各存一??*，各自的扣分已经按权重分摊好??
    // 只存第一条的话，其余班级的分摊扣分会被静默丢掉（曾经的真??bug）??
    const inspectorName = req.user.realName || req.user.nickname || req.user.account || '';
    const photos = Array.isArray(body.photos) ? body.photos.slice(0, 9).map((p) => String(p).slice(0, 300)) : [];
    const docs = [];
    for (const part of split) {
      if (!part.className) continue;
      docs.push(
        await CheckRecord.create({
          moduleKey: moduleDef.key,
          date,
          period,
          targetType: target.targetType,
          targetId: target.targetId,
          targetName: target.targetName,
          className: part.className,
          departmentId: target.departmentId && mongoose.isValidObjectId(target.departmentId) ? target.departmentId : null,
          grade: target.grade || '',
          inspectorOpenid: req.user.openid || '',
          inspectorName,
          inspectorDeptKey: identity.roles[0] ? identity.roles[0].deptKey : '',
          details,
          metrics,
          score: Number(part.score !== undefined ? part.score : details.score) || 0,
          deduct: part.deduct,
          photos,
          remark: String(body.remark || '').slice(0, 300),
          status: 'submitted',
          source: 'union',
          revision: 1,
          history: [],
        })
      );
    }
    if (!docs.length) throw new ApiError(400, 400, '该对象还没有归属班级，无法记分（请先在班级管理里绑定宿舍 / 卫生区）');
    const doc = docs[0];

    ok(res, {
      // 刚录完，调用者就是检查人（identity 已在上面 resolve 过，直接复用，不重复查库??
      record: presentRecord(doc.toObject ? doc.toObject() : doc, {
        viewer: { openid: req.user.openid || '', role: req.user.role || '', identity },
      }),
      split, // 分摊明细（前端可提示「本次同时计??N 个班级」）
      moduleName: moduleDef.name,
      className: doc.className,
      multiClass: docs.length > 1, // 混宿 / 共管：一条检查同时计入了几个??
      needsRoster: !!target.needsRoster, // 房间还没有住宿名单（按默认班级计），提醒补录
    });
  })
);

// 修改记录（本??/ 本部门部??/ 主席??/ 管理端；改后回到 submitted 重新复核??
router.put(
  '/records/:id',
  wrap(async (req, res) => {
    const identity = await unionSvc.resolveIdentity(req.user);
    assertMember(identity);
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '记录不存在');
    const record = await CheckRecord.findById(req.params.id);
    if (!record || record.voided) throw new ApiError(404, 404, '记录不存在');

    const moduleDef = await requireModule(record.moduleKey);
    const perm = unionSvc.canEnterModule(identity, moduleDef, record.departmentId ? String(record.departmentId) : '');
    if (!perm.ok) throw new ApiError(403, 403002, perm.reason);

    const mine = record.inspectorOpenid && record.inspectorOpenid === req.user.openid;
    const isReviewer = unionSvc.canReview(
      identity,
      record.departmentId ? String(record.departmentId) : '',
      record.inspectorDeptKey,
      moduleDef.entryDeptKeys || []
    );
    if (!mine && !isReviewer) throw new ApiError(403, 403002, '只能修改自己提交的记录');
    if (record.status === 'approved' && !isReviewer) {
      throw new ApiError(403, 403002, '该记录已复核，如需修改请联系主席团或部门部长');
    }

    const body = req.body || {};
    // 「申诉结案」属于**审核动作**，权限与 POST /records/:id/appeal/review 完全同口径：
    //   只有主席团或负责该部门的部长（isReviewer）能结案。
    // ⚠️ 不能只用上面的 `mine` 放行：录入人若能给**自己**的记录结案申诉，
    //    等于自己批准自己的申诉 —— 用户口径明确「申诉、审核只能由主席团或负责相应部门的部长处理」。
    if (body.settleAppeal === true && !isReviewer) {
      throw new ApiError(403, 403002, '只有主席团或负责该部门的部长可以处理申诉');
    }
    // 允许改的字段：明??/ 备注 / 照片 / 时段（对象与日期不可??—??要换对象就作废重录）
    // ⚠️ target 要在 fillDerived 之前解析：应??应住人数由它注入（分母），顺序反了会拿不??ctx??
    const target = await resolveTarget(moduleDef, { targetType: record.targetType, targetId: record.targetId });
    const nextDetails = checkModules.fillDerived(
      moduleDef.key,
      checkModules.normalizeDetails(moduleDef, body.details !== undefined ? body.details : record.details),
      shouldCountCtx(target)
    );
    const changes = {};
    const prevDetails = record.details || {};
    for (const [k, v] of Object.entries(nextDetails)) {
      const before = prevDetails[k];
      if (JSON.stringify(before) !== JSON.stringify(v)) changes[k] = { from: before, to: v };
    }
    if (body.remark !== undefined && String(body.remark || '') !== (record.remark || '')) {
      changes.remark = { from: record.remark || '', to: String(body.remark || '').slice(0, 300) };
      record.remark = String(body.remark || '').slice(0, 300);
    }
    if (Array.isArray(body.photos)) {
      const photos = body.photos.slice(0, 9).map((p) => String(p).slice(0, 300));
      if (JSON.stringify(photos) !== JSON.stringify(record.photos || [])) {
        changes.photos = { from: (record.photos || []).length, to: photos.length };
        record.photos = photos;
      }
    }

    const metrics = checkModules.computeMetrics(moduleDef, nextDetails);
    const totalDeduct = checkModules.computeDeduct(moduleDef, nextDetails, metrics);
    // 共管分摊：按原记录所属班级的权重重新分摊（对象未变，权重也不变；target 已在上面解析过）
    const split = splitDeduct(target, moduleDef, nextDetails, metrics, totalDeduct);
    const mineSplit = split.find((s) => s.className === record.className) || split[0];

    // 留痕要能看出「扣分/得分也变了」：改评价会连带改分数
    const prevDeduct = Number(record.deduct) || 0;
    const prevScore = Number(record.score) || 0;
    record.details = nextDetails;
    record.metrics = metrics;
    record.score = Number(nextDetails.score) || 0;
    record.deduct = mineSplit.deduct;
    // 扣分/得分本身也要进留痕：改评价会连带改分数，只记「评价 差→良」看不出扣了多少
    if (record.deduct !== prevDeduct) changes.deduct = { from: prevDeduct, to: record.deduct };
    if (record.score !== prevScore) changes.score = { from: prevScore, to: record.score };

    // 申诉结案（用户 2026-10-19 口径：申诉成立要**更正记录**，不是把扣分直接清零记满分）：
    //   评审带着 settleAppeal 提交时，说明「这就是改判后的正确内容」——
    //   记录按更正后的数据重算（上面的 details/score/deduct），并直接落成「已复核」，
    //   同时把申诉标记为成立，一条 revision 里把「改了什么 + 申诉结果」一起写进留痕。
    const settleAppeal =
      body.settleAppeal === true &&
      // 双重保险：上面已经拦过非评审者，这里再判一次 —— 结案永远只有评审者能做
      isReviewer &&
      record.appeal &&
      record.appeal.status === 'pending';
    const appealResult = String(body.appealResult || '').trim();
    if (settleAppeal) {
      record.appeal.status = 'approved';
      record.appeal.result = (appealResult || '申诉成立：已按更正后的内容改判').slice(0, 300);
      record.appeal.reviewedBy = req.user.realName || req.user.nickname || req.user.openid || '';
      record.appeal.reviewedAt = new Date();
      record.source = 'appeal';
      changes['appeal.status'] = { from: 'pending', to: 'approved' };
      changes['appeal.result'] = { to: record.appeal.result };
    }
    record.revision = (record.revision || 1) + 1;
    record.history = [
      ...(record.history || []).slice(-19),
      {
        revision: record.revision,
        at: new Date(),
        by: req.user.openid || '',
        byName: req.user.realName || req.user.nickname || '',
        changes,
      },
    ];
    // 被退回的记录改完重新进入待复核；已提交的保持 submitted。
    // 申诉结案的更正直接落成「已复核」——评审本人在改判，不需要再来一轮复核。
    const wasRejected = record.status === 'rejected';
    record.status = settleAppeal ? 'approved' : 'submitted';
    if (settleAppeal) {
      record.reviewedBy = req.user.openid || '';
      record.reviewedByName = req.user.realName || req.user.nickname || '';
      record.reviewedAt = new Date();
      record.rejectReason = '';
    } else {
      record.rejectReason = wasRejected ? '' : record.rejectReason;
    }
    await record.save();

    ok(res, {
      record: presentRecord(record.toObject(), {
        viewer: { openid: req.user.openid || '', role: req.user.role || '', identity },
      }),
      changed: Object.keys(changes).length,
      wasRejected,
    });
  })
);

// 取消记录（早??/ 早八临时取消：退出统计而不是算 0 分；其它模块也可用，须写原因??
router.post(
  '/records/:id/cancel',
  wrap(async (req, res) => {
    const identity = await unionSvc.resolveIdentity(req.user);
    assertMember(identity);
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '记录不存在');
    const record = await CheckRecord.findById(req.params.id);
    if (!record || record.voided) throw new ApiError(404, 404, '记录不存在');
    const moduleDef = await requireModule(record.moduleKey);
    const perm = unionSvc.canEnterModule(identity, moduleDef, record.departmentId ? String(record.departmentId) : '');
    if (!perm.ok) throw new ApiError(403, 403002, perm.reason);

    const mine = record.inspectorOpenid && record.inspectorOpenid === req.user.openid;
    const isReviewer = unionSvc.canReview(
      identity,
      record.departmentId ? String(record.departmentId) : '',
      record.inspectorDeptKey,
      moduleDef.entryDeptKeys || []
    );
    if (!mine && !isReviewer) throw new ApiError(403, 403002, '只能取消自己提交的记录');

    const reason = String((req.body || {}).reason || '').trim();
    if (reason.length < 2) throw new ApiError(400, 400, '请填写取消原因（如「下雨取消」「临时考试」）');

    record.status = 'cancelled';
    record.cancelReason = reason.slice(0, 200);
    record.revision = (record.revision || 1) + 1;
    record.history = [
      ...(record.history || []).slice(-19),
      {
        revision: record.revision,
        at: new Date(),
        by: req.user.openid || '',
        byName: req.user.realName || req.user.nickname || '',
        changes: { status: { from: 'submitted', to: 'cancelled' }, cancelReason: { to: record.cancelReason } },
      },
    ];
    await record.save();
    ok(res, {
      record: presentRecord(record.toObject(), {
        viewer: { openid: req.user.openid || '', role: req.user.role || '', identity },
      }),
    });
  })
);

// 记录列表（按身份可见范围过滤；mine=1 只看我提交的??
router.get(
  '/records',
  wrap(async (req, res) => {
    const identity = await unionSvc.resolveIdentity(req.user);
    const { page, limit, skip } = parsePagination(req.query, { page: 1, limit: 20 });
    // 可见范围（用户 2026-10-19 口径：班主任与班委可查看本班记录）：
    //   ① 学生会成员 → 按身份范围（校级全校 / 分院本院系）；
    //   ② 非成员 → **只限本班**：班主任的 homeroomClasses（可能多个班）+ 本人所在班；
    //   ③ 学生会总管（非成员也可）→ **全校**（用户 2026-10-21「学生会总管是可以查看检查记录的，
    //      现在显示无法查看」：总管既不在成员名单、也没有班级，原来直接落到 scope=null → 403）。
    //      scope 由 buildRecordFilter 的 Object.assign **覆盖** query.className，
    //      所以传 className=别的班也跨不出去（fail-closed）。
    let scope;
    if (identity.isMember) {
      scope = unionSvc.scopeFilter(identity);
    } else if (await isRecordSteward(req, identity)) {
      scope = {}; // 全校
    } else {
      const classes = [
        ...new Set(
          [...(Array.isArray(req.user.homeroomClasses) ? req.user.homeroomClasses : []), req.user.className].filter(Boolean)
        ),
      ];
      scope = classes.length ? { className: { $in: classes } } : null;
    }
    if (!scope) throw new ApiError(403, 403002, NO_ACCESS);

    const query = {
      moduleKey: req.query.moduleKey,
      className: req.query.className,
      status: req.query.status,
      date: req.query.date,
      from: req.query.from,
      to: req.query.to,
      inspectorOpenid: String(req.query.mine || '') === '1' ? req.user.openid : req.query.inspectorOpenid,
    };
    const filter = bandChao.buildRecordFilter(query, scope);
    if (String(req.query.pendingAppeal || '') === '1') filter['appeal.status'] = 'pending';

    const [total, rows] = await Promise.all([
      CheckRecord.countDocuments(filter),
      CheckRecord.find(filter).sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);
    const modules = await checkModules.listModules();
    const nameOf = new Map(modules.map((m) => [m.key, m.shortName || m.name]));
    // ⚠️ **列表??viewer 只在循环外算一??*（openid / role / identity 都不随行变化）—??
    // 放进 map 里就是每条记录一??resolveIdentity（N+1）。identity ??30s 缓存也挡不住这种放大??
    const viewer = { openid: req.user.openid || '', role: req.user.role || '', identity };
    ok(res, {
      page,
      limit,
      total,
      hasMore: skip + rows.length < total,
      list: rows.map((r) => ({
        ...presentRecord(r, { withDetails: false, viewer }),
        moduleName: nameOf.get(r.moduleKey) || r.moduleKey,
      })),
    });
  })
);

// 记录详情
router.get(
  '/records/:id',
  wrap(async (req, res) => {
    const identity = await unionSvc.resolveIdentity(req.user);
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '记录不存在');
    const record = await CheckRecord.findById(req.params.id).lean();
    if (!record || record.voided) throw new ApiError(404, 404, '记录不存在');

    const scope = unionSvc.scopeFilter(identity);
    const dep = record.departmentId ? String(record.departmentId) : '';
    // 可见性分两类（用户 2026-10-19 口径：班主任与班委都可以查看本班并提起申诉）：
    //   ① 学生会成员 → 按身份范围（校级全校 / 分院本院系）；
    //   ② **非成员** → 班级域成员资格：班主任（homeroomClasses 含本班）/ 班委 / 本班学生看**本班**记录；
    //      另外检查人本人始终可见自己提交的记录。
    // ⚠️ 旧实现在这里**无条件 assertMember**，班主任与班委还没走到下面那句就被
    //    「你还不是学生会成员」拦掉（用户截图：「记录不存在或你没有查看权限」），
    //    于是下面 sameClass / isHomeroom 的放行**永远执行不到** —— 等于形同虚设。
    const inScope =
      !!identity.isMember && (identity.level === 'school' || (scope && dep && (identity.departmentIds || []).includes(dep)));
    const sameClass = !!record.className && record.className === req.user.className;
    const isHomeroom = (req.user.homeroomClasses || []).includes(record.className);
    const isInspector = record.inspectorOpenid && record.inspectorOpenid === req.user.openid;
    // 学生会总管：全校可见（用户 2026-10-21；原来四条放行都不匹配 → 「无法查看」）
    const isStewardViewer = await isRecordSteward(req, identity);
    if (!inScope && !sameClass && !isHomeroom && !isInspector && !isStewardViewer) throw new ApiError(403, 403002, NO_ACCESS);

    // 申诉人限定为班委 / 班主任（与 POST /records/:id/appeal 同一口径）
    const isOfficer = req.user.isClassOfficer === true && req.user.className === record.className;

    const moduleDef = await checkModules.getModule(record.moduleKey);
    // 「能不能复核这条记录」= 有复核资格 **且**（不是自己提交的 或 主席团可自审）。
    // 旧实现写死 `!isInspector &&`，导致主席团代录的记录**没有人能复核**（详见 services/union.js::canSelfReview）。
    // 总管：union.steward 的语义就是「管理学生会全部事务，含记录与复核」（见 models/permission.js PERM_IMPLS），
    // 所以给全校复核权；自审限制仍生效（不因为是总管就允许自己录自己审）。
    const reviewPerm =
      unionSvc.canReview(identity, dep, record.inspectorDeptKey, (moduleDef && moduleDef.entryDeptKeys) || []) ||
      isStewardViewer;
    const selfReviewOk = !isInspector || unionSvc.canSelfReview(identity);
    const canReview = reviewPerm && selfReviewOk;
    ok(res, {
      // 详情出口：viewer 传入，宿舍照片对无权者不下发原图 URL（cropPhotos 内判定）
      record: presentRecord(record, { viewer: { openid: req.user.openid || '', role: req.user.role || '', identity } }),
      module: moduleDef
        ? { key: moduleDef.key, name: moduleDef.name, fields: moduleDef.fields || [], metrics: moduleDef.metrics || [] }
        : null,
      canEdit: isInspector || reviewPerm,
      canReview,
      // 既是提交人、又拿不到复核权（即「自己想审但规则不允许」）：页面据此说明原因，
      // 而不是只丢一个「提交修改」让用户猜（用户报障「为什么这个页面是提交修改」）。
      selfReviewBlocked: isInspector && reviewPerm && !unionSvc.canSelfReview(identity),
      canAppeal:
        (isOfficer || isHomeroom) &&
        ['submitted', 'approved'].includes(record.status) &&
        !(record.appeal && record.appeal.status === 'pending'),
    });
  })
);

// 班级检查全景（首页「班超块」与班超门户页共用）
// 规则：学生会成员可按身份看任意班级；否则只允许看自己所在班级（班委 / 班主任走 /api/class/checks??
router.get(
  '/class/:className',
  wrap(async (req, res) => {
    const className = decodeURIComponent(String(req.params.className || '')).trim();
    if (!className) throw new ApiError(400, 400, '缺少班级');
    const identity = await unionSvc.resolveIdentity(req.user);

    const info = await resolveClassInfo(className);
    if (!info) throw new ApiError(404, 404, '班级不存在');
    const scope = unionSvc.scopeFilter(identity);
    const inUnionScope =
      identity.isMember && (identity.level === 'school' || (scope && info.departmentId && (identity.departmentIds || []).includes(info.departmentId)));
    const selfClass = className === req.user.className;
    const homeroom = (req.user.homeroomClasses || []).includes(className);
    if (!inUnionScope && !selfClass && !homeroom) throw new ApiError(403, 403002, NO_ACCESS);

    const range = ['day', 'week', 'month'].includes(String(req.query.range)) ? String(req.query.range) : 'day';
    const date = dates.isValidDateKey(String(req.query.date || '')) ? String(req.query.date) : dates.todayKey();
    const modules = await checkModules.listModules({ force: true });

    const summary = await bandChao.classSummary({
      className,
      date,
      range,
      weekStartKey: req.query.weekStart ? String(req.query.weekStart) : '',
      monthKey: req.query.month ? String(req.query.month) : '',
      // 周口径与 /ranking 同源（services/band-chao.js::rangeOf 的第 5 个参数）：
      // 「当月第 N 周」，不传则回落到 ISO 本周 —— 班超页与排名页的周区间必须一致
      weekNo: req.query.weekNo ? String(req.query.weekNo) : '',
      modules,
    });
    const scopeRange = bandChao.rangeOf(range, date, req.query.weekStart, req.query.month, req.query.weekNo);
    const deptIds = identity.level === 'school' ? [] : identity.departmentIds;
    const ranking = await bandChao.classRanking({
      from: scopeRange.from,
      to: scopeRange.to,
      departmentIds: deptIds,
      className,
    });
    const recent = await CheckRecord.find({ className, voided: { $ne: true }, status: { $in: CheckRecord.COUNTED_STATUS } })
      .sort({ date: -1, createdAt: -1 })
      .limit(10)
      .lean();
    const nameOf = new Map(modules.map((m) => [m.key, m.shortName || m.name]));
    // ??/records：viewer ??map 外算一次（identity ??resolve，不新增查询??
    const viewer = { openid: req.user.openid || '', role: req.user.role || '', identity };

    ok(res, {
      className,
      classInfo: info,
      date,
      ...summary,
      ranking: { rank: ranking.me ? ranking.me.rank : null, total: ranking.total, score: ranking.me ? ranking.me.score : null },
      rankingTop: ranking.top,
      recent: recent.map((r) => ({
        ...presentRecord(r, { withDetails: false, viewer }),
        moduleName: nameOf.get(r.moduleKey) || r.moduleKey,
      })),
    });
  })
);

// 班级排名榜（院校 / 系部 / 年级筛选 + 今日 / 本周 / 本月）
router.get(
  '/ranking',
  wrap(async (req, res) => {
    const identity = await unionSvc.resolveIdentity(req.user);
    const range = ['day', 'week', 'month'].includes(String(req.query.range)) ? String(req.query.range) : 'day';
    const date = dates.isValidDateKey(String(req.query.date || '')) ? String(req.query.date) : dates.todayKey();
    const scopeRange = bandChao.rangeOf(range, date, req.query.weekStart, req.query.month, req.query.weekNo);

    const school = String(req.query.school || '').trim();
    const department = String(req.query.department || '').trim();
    const grade = String(req.query.grade || '').trim();

    const profiles = await ClassProfile.find({})
      .select('className schoolId schoolName departmentId departmentName grade')
      .lean();

    // 可见范围：分院成员始终收敛在本院校 / 本院系；校级成员看全校。
    // 兼容旧参数 scope=department（本校/本院系切换），新前端直接用院校/系部筛选。
    let scoped = profiles;
    if (identity.isMember && identity.level === 'branch') {
      const deptIds = (identity.departmentIds || []).map(String).filter(Boolean);
      const deptNames = new Set();
      if (deptIds.length) {
        const orgs = await Organization.find({ _id: { $in: deptIds } }).select('name').lean();
        for (const o of orgs) if (o.name) deptNames.add(o.name);
      }
      const schoolIds = new Set((identity.schoolIds || []).map(String));
      const schoolNames = new Set((identity.schoolNames || []).filter(Boolean));
      scoped = profiles.filter((p) => {
        if (p.schoolId && schoolIds.has(String(p.schoolId))) return true;
        if (p.schoolName && schoolNames.has(p.schoolName)) return true;
        if (p.departmentId && deptIds.includes(String(p.departmentId))) return true;
        if (p.departmentName && deptNames.has(p.departmentName)) return true;
        return false;
      });
    } else if (String(req.query.scope || '') === 'department') {
      const depId = String(req.user.departmentId || '');
      const depName = req.user.departmentName || '';
      if (!depId && !depName) throw new ApiError(400, 400, '你还没有绑定院系');
      scoped = profiles.filter(
        (p) => (depId && String(p.departmentId || '') === depId) || (depName && p.departmentName === depName)
      );
    }

    const gradeOf = (p) => roster.normalizeGrade(p.grade) || roster.gradeFromClassName(p.className || '');

    let filtered = scoped;
    if (school) {
      filtered = filtered.filter((p) => p.schoolName === school || String(p.schoolId || '') === school);
    }
    if (department) {
      filtered = filtered.filter((p) => p.departmentName === department || String(p.departmentId || '') === department);
    }
    if (grade) filtered = filtered.filter((p) => gradeOf(p) === grade);

    const classNames = [...new Set(filtered.map((p) => p.className).filter(Boolean))];
    const data = await bandChao.classRanking({
      from: scopeRange.from,
      to: scopeRange.to,
      classNames,
      className: req.user.className || '',
      limit: 50,
    });

    const schoolMap = new Map();
    const deptMap = new Map();
    for (const p of scoped) {
      const schoolName = p.schoolName || '';
      if (schoolName && !schoolMap.has(schoolName)) {
        schoolMap.set(schoolName, { value: schoolName, label: schoolName });
      }
      const deptName = p.departmentName || '';
      if (deptName) {
        const key = schoolName + '|' + deptName;
        if (!deptMap.has(key)) {
          deptMap.set(key, { value: deptName, label: deptName, school: schoolName });
        }
      }
    }
    const grades = [...new Set(scoped.map(gradeOf).filter(Boolean))].sort((a, b) => b.localeCompare(a));

    ok(res, {
      range: scopeRange.range,
      rangeLabel: scopeRange.label,
      periodLabel: scopeRange.periodLabel || scopeRange.label,
      // 周选择器文案（带日期段）：「第2周(10月8日至10月14日)」，非周口径为空
      weekLabel: scopeRange.weekLabel || '',
      weekRangeText: scopeRange.weekRangeText || '',
      weekNo: scopeRange.weekNo || null,
      maxWeek: scopeRange.maxWeek || null,
      scope: department ? 'department' : 'school',
      from: scopeRange.from,
      to: scopeRange.to,
      date,
      filters: { school, department, grade },
      facets: {
        schools: [...schoolMap.values()].sort((a, b) => a.label.localeCompare(b.label)),
        departments: [...deptMap.values()].sort((a, b) => a.label.localeCompare(b.label)),
        grades: grades.map((g) => ({ value: g, label: g + '级' })),
      },
      ...data,
    });
  })
);


// ===== 复核 =====

router.post(
  '/records/:id/review',
  wrap(async (req, res) => {
    const identity = await unionSvc.resolveIdentity(req.user);
    assertMember(identity);
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '记录不存在');
    const record = await CheckRecord.findById(req.params.id);
    if (!record || record.voided) throw new ApiError(404, 404, '记录不存在');
    const dep = record.departmentId ? String(record.departmentId) : '';
    const moduleDef = await checkModules.getModule(record.moduleKey);
    if (!unionSvc.canReview(identity, dep, record.inspectorDeptKey, (moduleDef && moduleDef.entryDeptKeys) || [])) throw new ApiError(403, 403002, '只有部门部长或主席团可以复核记录');
    // 禁止自审：**仅对非主席团**（部长/副部长）生效。
    // 主席团可以复核自己提交的记录 —— 否则主席团代录的记录会**没有人能复核**（用户 2026-10-19 口径）。
    if (record.inspectorOpenid && record.inspectorOpenid === req.user.openid && !unionSvc.canSelfReview(identity)) {
      throw new ApiError(403, 403002, '不能复核自己提交的记录');
    }

    const body = req.body || {};
    const approve = body.approve === true || String(body.action || '') === 'approve';
    const reason = String(body.reason || '').trim();
    if (!approve && reason.length < 2) throw new ApiError(400, 400, '退回时必须填写原因');

    record.status = approve ? 'approved' : 'rejected';
    record.rejectReason = approve ? '' : reason.slice(0, 200);
    record.reviewedBy = req.user.openid || '';
    record.reviewedByName = req.user.realName || req.user.nickname || '';
    record.reviewedAt = new Date();
    record.revision = (record.revision || 1) + 1;
    record.history = [
      ...(record.history || []).slice(-19),
      {
        revision: record.revision,
        at: new Date(),
        by: req.user.openid || '',
        byName: record.reviewedByName,
        changes: { status: { from: 'submitted', to: record.status }, rejectReason: { to: record.rejectReason } },
      },
    ];
    await record.save();
    ok(res, {
      record: presentRecord(record.toObject(), {
        viewer: { openid: req.user.openid || '', role: req.user.role || '', identity },
      }),
    });
  })
);

// ===== 申诉（班??/ 班主任对本班记录??====

router.post(
  '/records/:id/appeal',
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '记录不存在');
    const record = await CheckRecord.findById(req.params.id);
    if (!record || record.voided) throw new ApiError(404, 404, '记录不存在');

    const className = record.className || '';
    const isHomeroom = (req.user.homeroomClasses || []).includes(className);
    const isOfficer = req.user.isClassOfficer === true && req.user.className === className;
    // 申诉人限定为班委 / 班主任（方案 §2.3 的能力表：普通学生无任何写能力，申诉也算写入动作??
    if (!className || (!isHomeroom && !isOfficer)) {
      throw new ApiError(403, 403002, '只能由本班班委或班主任对本班记录发起申诉');
    }
    if (!['submitted', 'approved'].includes(record.status)) {
      throw new ApiError(400, 400, '该记录当前状态不支持申诉');
    }
    if (record.appeal && record.appeal.status === 'pending') throw new ApiError(400, 400, '该记录已有一条待处理申诉');

    const reason = String((req.body || {}).reason || '').trim();
    if (reason.length < 5) throw new ApiError(400, 400, '请说明申诉理由（不少于 5 个字）');

    record.appeal = {
      status: 'pending',
      reason: reason.slice(0, 300),
      byOpenid: req.user.openid || '',
      byName: req.user.realName || req.user.nickname || '',
      byRole: isHomeroom ? 'homeroom' : 'officer',
      at: new Date(),
      result: '',
      reviewedBy: '',
      reviewedAt: null,
    };
    await record.save();
    ok(res, {
      // ⚠️ 这里**不能传 identity**：申诉人限定为本班班委 / 班主任，他们通常不是学生会成员，
      //    本处理函数刻意不查 resolveIdentity（少一次查库）。原先这里直接引用了未声明的
      //    `identity` 变量 → 申诉**已经存库**却在组装响应时抛 ReferenceError，
      //    客户端看到「申诉失败」，重试又提示「已有一条待处理申诉」（真实踩过的坑）。
      //    宿舍照片可见性由 canViewDormPhotos 兜底：教师账号 / 检查人本人直接可见，
      //    identity 缺失时其余角色 fail-closed（班委看不到宿舍原图，符合隐私口径）。
      record: presentRecord(record.toObject(), {
        viewer: { openid: req.user.openid || '', role: req.user.role || '', identity: null },
      }),
    });
  })
);

// 申诉处理：viewer 缺省 = 主席??/ 部长两条判成不可见（fail-closed）??// 说明??records/:id/appeal 只允许本班班??/ 班主任调用，而申??*不查学生会身??*
// （班??/ 班主任通常不是学生会成员），因此这里不再额??resolveIdentity —??少一次查库??
router.post(
  '/records/:id/appeal/review',
  wrap(async (req, res) => {
    const identity = await unionSvc.resolveIdentity(req.user);
    assertMember(identity);
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '记录不存在');
    const record = await CheckRecord.findById(req.params.id);
    if (!record || record.voided) throw new ApiError(404, 404, '记录不存在');
    const dep = record.departmentId ? String(record.departmentId) : '';
    const moduleDef = await checkModules.getModule(record.moduleKey);
    if (!unionSvc.canReview(identity, dep, record.inspectorDeptKey, (moduleDef && moduleDef.entryDeptKeys) || [])) throw new ApiError(403, 403002, '只有部门部长或主席团可以处理申诉');
    if (!record.appeal || record.appeal.status !== 'pending') throw new ApiError(400, 400, '该记录没有待处理的申诉');

    const body = req.body || {};
    const approve = body.approve === true;
    const result = String(body.result || '').trim();
    if (!approve && result.length < 2) throw new ApiError(400, 400, '驳回申诉时必须填写理由');

    const prevStatus = record.status;
    const changes = {};
    record.appeal.status = approve ? 'approved' : 'rejected';
    record.appeal.result = result.slice(0, 300);
    record.appeal.reviewedBy = req.user.realName || req.user.nickname || req.user.openid || '';
    record.appeal.reviewedAt = new Date();
    if (approve) {
      // 申诉成立 = 改判（用户 2026-10-19 口径）。
      //
      // ⚠️ 这里刻意**不再自动「撤销扣分 / 记满分」**：申诉成立不等于该班表现满分，
      //    只是原判定不正确；正确做法是**更正记录内容**，按更正后的数据重算扣分。
      //    更正由 PUT /records/:id（带 settleAppeal=true）完成 —— 评审在录入台改数据并结案，
      //    那边会同时写字段级 diff 与申诉结果。本接口只负责两种「不改数据」的收尾：
      //      ① void=true  → 确属误录，作废退出统计；
      //      ② 已更正过（record.source==='appeal' 或 revision 已增）→ 仅结案为「申诉成立」。
      //    其它情况（既不改数据也不作废）直接拒绝 —— 避免回到「点了申诉成立但记录没变」的老问题。
      const voidIt = body.void === true || String(body.action || '') === 'void';
      const corrected = record.source === 'appeal' || (record.revision || 1) > 1;
      if (voidIt) {
        record.status = 'cancelled';
        record.cancelReason = `申诉改判：${result || '申诉成立'}`.slice(0, 200);
        record.source = 'appeal';
        changes.status = { from: prevStatus, to: 'cancelled' };
      } else if (corrected) {
        // 已经通过「更正内容」改过数据：这里只结案，不再动 details/score/deduct
        record.status = 'approved';
        changes.status = { from: prevStatus, to: 'approved' };
      } else {
        throw new ApiError(400, 400, '申诉成立需要更正记录内容（或选择作废），不能只改状态');
      }
    } else {
      changes.status = { from: prevStatus, to: prevStatus };
    }
    // 留痕必须能看出「这次是申诉改判」，而不只是状态跳变
    changes['appeal.status'] = { from: 'pending', to: record.appeal.status };
    if (record.appeal.result) changes['appeal.result'] = { to: record.appeal.result };
    record.revision = (record.revision || 1) + 1;
    record.history = [
      ...(record.history || []).slice(-19),
      {
        revision: record.revision,
        at: new Date(),
        by: req.user.openid || '',
        byName: record.appeal.reviewedBy,
        changes,
      },
    ];
    await record.save();
    ok(res, {
      record: presentRecord(record.toObject(), {
        viewer: { openid: req.user.openid || '', role: req.user.role || '', identity },
      }),
    });
  })
);

module.exports = router;

