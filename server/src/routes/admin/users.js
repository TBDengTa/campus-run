const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const { wrap, ok, ApiError, parsePagination } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const anticheat = require('../../services/anticheat');
const pwd = require('../../services/password');
const roster = require('../../services/roster');
const pointsSvc = require('../../services/points');
const dormsSvc = require('../../services/dorms');
const classProfilesSvc = require('../../services/class-profiles');
const DormAssignment = require('../../models/dorm-assignment');
const DormRoom = require('../../models/dorm-room');
const { makeUploader } = require('../../utils/uploader');
const dates = require('../../utils/dates');
const BanRecord = require('../../models/ban-record');
const User = require('../../models/user');
const GoalConfig = require('../../models/goal-config');
const PermissionGroup = require('../../models/permission-group');
const Permission = require('../../models/permission');
const UserGoal = require('../../models/user-goal');
const RunRecord = require('../../models/run-record');
const WaterRecord = require('../../models/water-record');
const UserBadge = require('../../models/user-badge');
const Badge = require('../../models/badge');
const WxSession = require('../../models/wx-session');
const LoginDevice = require('../../models/login-device');
const deviceSvc = require('../../services/login-device');
const Appeal = require('../../models/appeal');
const Organization = require('../../models/organization');
// 账号级管理动作的唯一实现（重置密码 / 删除账号 / 限制 / 解除限制）：
// 班级域（班主任管本班学生）与这里共用同一份实现，避免两套逻辑分裂（见该 service 文件头）。
const accountAdmin = require('../../services/user-account-admin');
// 班主任对本班学生的管理权判定（与班级域写接口同一份，见 services/student-scope.js）
const studentScope = require('../../services/student-scope');
// 班委 / 班主任班级写入（与班级域 PUT /student/:userId/officer 共用同一份校验）
const classRoles = require('../../services/class-roles');
// 宿舍（住宿记录）的读写唯一实现：班级域「班主任给本班学生设宿舍」共用，
// 并负责下发楼名清单（教师权限组不需要 building.view 也能填宿舍）
const studentDorm = require('../../services/student-dorm');

const router = express.Router();

// 导入学生名单（需 user.import）：body { rows: [...] } 或 { payload: 'CSV/JSON 文本' }
router.post(
  '/import',
  requirePermission('user.import'),
  wrap(async (req, res) => {
    const mode = ['smart', 'update', 'create'].includes(req.body?.mode) ? req.body.mode : 'create';
    const rows = roster.parseRows(req.body?.rows || req.body?.payload);
    if (!rows.length) throw new ApiError(400, 400, mode === 'update' ? '未解析到数据（表头：学号,性别,出生日期）' : '未解析到数据（表头：学号,姓名,院校,系部,专业,班级,性别,出生日期）');
    const result = await roster.importRows(rows, mode);
    ok(res, result);
  })
);

// ===== 名单导入预览/确认：先解析预览（不入库），确认后才写库 =====
const importUpload = makeUploader({ memory: true, accept: ['.xlsx', '.xls', '.csv'] });
const PREVIEW_TTL = 15 * 60 * 1000;
const previewCache = new Map(); // cacheId → { rows, expireAt }

function cachePreview(rows) {
  const now = Date.now();
  for (const [k, v] of previewCache) {
    if (v.expireAt <= now) previewCache.delete(k);
  }
  const cacheId = crypto.randomUUID();
  previewCache.set(cacheId, { rows, expireAt: now + PREVIEW_TTL });
  return cacheId;
}

// 解析预览：multipart 表格文件（xlsx/xls/csv）或 { payload } 文本，返回归一化预览与异常明细
// mode='smart'（智能）：列名识别 + 字段推导后预览（预览即推导结果），并标记每行是新增还是更新
router.post(
  '/import/preview',
  requirePermission('user.import'),
  importUpload.single('file'),
  wrap(async (req, res) => {
    const mode = ['smart', 'update', 'create'].includes(req.body?.mode) ? req.body.mode : '';
    let rows = req.file ? roster.parseSheet(req.file.buffer) : roster.parseRows(req.body?.payload);
    if (!rows.length) throw new ApiError(400, 400, '未解析到数据（智能模式只需保证「学号」列）');
    if (mode === 'smart') rows = await roster.smartFillRows(rows);

    const normalized = [];
    const failed = [];
    rows.forEach((row, i) => {
      const item = roster.normalizeRow(row, i);
      if (item.error) failed.push({ row: i + 1, reason: item.error });
      else normalized.push(item);
    });

    // 智能模式：批量标记库中已有学号（= 将更新）
    let existingIds = new Set();
    if (mode === 'smart' && normalized.length) {
      const docs = await User.find({ studentId: { $in: normalized.map((r) => r.studentId) } })
        .select('studentId')
        .lean();
      existingIds = new Set(docs.map((d) => d.studentId));
    }

    ok(res, {
      cacheId: cachePreview(normalized),
      mode,
      total: rows.length,
      valid: normalized.length,
      failedCount: failed.length,
      failed,
      preview: normalized.slice(0, 20).map((r) =>
        mode === 'smart' ? { ...r, exists: existingIds.has(r.studentId) } : r
      ),
    });
  })
);

// 确认导入：按预览返回的 cacheId + mode 写库
// 支持分片：传 offset/limit 时每次只导入一片并保留缓存（前端驱动进度条、可断点续传）；
// 不传则一次性导入全部并清缓存（兼容）。最后一片完成后缓存即删。
router.post(
  '/import/confirm',
  requirePermission('user.import'),
  wrap(async (req, res) => {
    const cacheId = String(req.body?.cacheId || '');
    const cached = previewCache.get(cacheId);
    if (!cached || cached.expireAt <= Date.now()) {
      previewCache.delete(cacheId);
      throw new ApiError(410, 410, '预览已过期，请重新选择文件解析');
    }
    const total = cached.rows.length;
    const chunked = req.body?.offset != null;
    const offset = chunked ? Math.max(0, Math.min(total, Number(req.body.offset) || 0)) : 0;
    const limit = chunked ? Math.max(1, Math.min(1000, Number(req.body.limit) || 200)) : total;

    if (!total) {
      previewCache.delete(cacheId);
      throw new ApiError(400, 400, '没有可导入的数据（所有行均异常）');
    }
    const mode = ['smart', 'update', 'create'].includes(req.body?.mode) ? req.body.mode : 'create';
    const result = await roster.importRows(cached.rows.slice(offset, offset + limit), mode);
    // 分片内的行号换算回文件全局行号
    const failed = result.failed.map((f) => (typeof f.row === 'number' ? { ...f, row: f.row + offset } : f));
    const done = !chunked || offset + limit >= total;
    if (done) previewCache.delete(cacheId);
    ok(res, {
      mode: result.mode,
      offset,
      limit: result.total,
      total,
      created: result.created,
      updated: result.updated,
      failed,
      done,
    });
  })
);

// 创建教师账号（需 permission.manage）：初始密码系统随机生成，仅本次响应返回
router.post(
  '/teachers',
  requirePermission('permission.manage'),
  wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) throw new ApiError(400, 400, '请填写教师姓名（作为登录账号）');
    const exists = await User.findOne({ account: name, role: 'teacher' });
    if (exists) throw new ApiError(400, 400, '已存在同名教师账号');
    const initialPassword = pwd.last8(req.body?.initialPassword) || crypto.randomBytes(4).toString('hex');
    const user = await User.create({
      account: name,
      realName: name,
      nickname: name,
      role: 'teacher',
      schoolName: String(req.body?.school || '').trim(),
      departmentName: String(req.body?.department || '').trim(),
      passwordHash: pwd.hashPassword(initialPassword),
      initialHashes: [pwd.hashPassword(initialPassword)],
      mustChangePassword: true,
    });
    ok(res, { _id: user._id, account: user.account, initialPassword });
  })
);

// 密码变更（需 permission.manage）：两个动作，用户 2026-10-26「重置密码」改称「密码变更」
//   body { mode:'initial' }               → 恢复初始密码（教师 123456 / 学生 学号或身份证后8位）
//   body { mode:'set', password:'xxx' }   → 设置密码（不强制改密）
//   ⚠️ 不传 mode 时按 initial 处理：老前端（改名前）只发空 body，行为与改造前一致，不会 400。
// 实现见 services/user-account-admin.js（班级域「班主任改本班学生密码」共用同一份）
router.post(
  '/:id/reset-password',
  requirePermission('permission.manage'),
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw new ApiError(404, 404, '用户不存在');
    const body = req.body || {};
    const r = await accountAdmin.changeUserPassword(user, {
      mode: body.mode || 'initial',
      password: body.password,
    });
    ok(res, { success: true, mode: r.mode, message: r.message });
  })
);

// 重置密码 / 删除账号的实现都搬到了 services/user-account-admin.js：
// 班级域（班主任管本班学生）与管理端必须走同一份实现，见该文件头。


// 创建账户（学生/教师通用，需 permission.manage）
router.post(
  '/account',
  requirePermission('permission.manage'),
  wrap(async (req, res) => {
    const {
      role, account, initialPassword, gender, birthdate,
      school, department, specialty, className,
      studentId, grade,
    } = req.body || {};
    const name = String(account || '').trim();
    if (!name) throw new ApiError(400, 400, '账号（姓名）必填');
    if (!['student', 'teacher'].includes(role)) throw new ApiError(400, 400, '账户类型只能为 student/teacher');
    if (await User.findOne({ account: name, role })) throw new ApiError(400, 400, '已存在同名同类型账户');

    const password = String(initialPassword || '').trim() || crypto.randomBytes(4).toString('hex');
    // 年级：显式传入优先，否则按学号前 4 位（入学年份）推导
    const effectiveGrade = String(grade || '').trim() || roster.gradeFromStudentId(studentId);
    const doc = await User.create({
      account: name,
      realName: name,
      nickname: name,
      role,
      gender: Number(gender) || 0,
      birthdate: birthdate ? new Date(birthdate) : undefined,
      studentId: studentId ? String(studentId).trim() : undefined,
      schoolName: String(school || '').trim(),
      departmentName: String(department || '').trim(),
      specialty: String(specialty || '').trim(),
      // 班级自动识别：年级（学号前 4 位）+ 专业；显式传入时以传入值为原值做保留判断
      className: roster.classNameFromGradeSpecialty(effectiveGrade, specialty, className),
      grade: effectiveGrade,
      passwordHash: pwd.hashPassword(password),
      initialHashes: [pwd.hashPassword(password)],
      resetHashes: [pwd.hashPassword(password)],
      mustChangePassword: true,
    });
    ok(res, { _id: doc._id, account: doc.account, role: doc.role, initialPassword: password });
  })
);

// 编辑账户基础信息（需 permission.manage）
router.put(
  '/:id/profile',
  requirePermission('permission.manage'),
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw new ApiError(404, 404, '用户不存在');
    const { account, gender, birthdate, school, department, specialty, className, studentId, grade } = req.body || {};
    if (account !== undefined) {
      const name = String(account).trim();
      if (!name) throw new ApiError(400, 400, '账号不能为空');
      const dup = await User.findOne({ account: name, role: user.role, _id: { $ne: user._id } });
      if (dup) throw new ApiError(400, 400, '已存在同名同类型账户');
      user.account = name;
      user.realName = name;
    }
    if (gender !== undefined) user.gender = Number(gender) || 0;
    if (birthdate !== undefined) user.birthdate = birthdate ? new Date(birthdate) : null;
    if (school !== undefined) user.schoolName = String(school).trim();
    if (department !== undefined) user.departmentName = String(department).trim();
    if (specialty !== undefined) user.specialty = String(specialty).trim();
    if (className !== undefined) user.className = String(className).trim();
    if (grade !== undefined) user.grade = String(grade).trim();
    if (studentId !== undefined) {
      const sid = String(studentId).trim();
      if (sid) {
        const dup = await User.findOne({ studentId: sid, _id: { $ne: user._id } });
        if (dup) throw new ApiError(400, 400, '学号已被其他用户使用');
        user.studentId = sid;
      }
    }
    // 未显式给年级时，用学号前 4 位（入学年份）对齐：推得出来才覆盖，推不出来（老学号形态）保留原年级
    // —— 存量数据 grade 普遍为空，这里对齐后班级推导才有年级可用
    if (grade === undefined) {
      const derived = roster.gradeFromStudentId(user.studentId);
      if (derived) user.grade = derived;
    }
    // 未显式传班级时按「年级 + 专业」推导（管理端账户编辑页就是这样：班级只读、不提交）
    if (className === undefined) {
      user.className = roster.classNameFromGradeSpecialty(user.grade, user.specialty, user.className);
    }
    await user.save();
    ok(res, user.toSafeJSON());
  })
);

// 删除用户及全部关联数据（需 permission.manage；超管不可删）
router.delete(
  '/:id',
  requirePermission('permission.manage'),
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw new ApiError(404, 404, '用户不存在');
    const deleted = await accountAdmin.deleteUserCascade(user);
    ok(res, { success: true, deleted });
  })
);

// 修改用户角色/权限（需 permission.manage）
router.put(
  '/:id/permissions',
  requirePermission('permission.manage'),
  wrap(async (req, res) => {
    const { role, permissionGroups, permissions } = req.body || {};
    const user = await User.findById(req.params.id);
    if (!user) throw new ApiError(404, 404, '用户不存在');

    if (role !== undefined) {
      if (!['student', 'teacher'].includes(role)) throw new ApiError(400, 400, '角色只能为 student/teacher');
      user.role = role;
    }
    if (Array.isArray(permissionGroups)) {
      const valid = await PermissionGroup.find({ key: { $in: permissionGroups } }).distinct('key');
      const invalid = permissionGroups.filter((k) => !valid.includes(k));
      if (invalid.length) throw new ApiError(400, 400, `权限组不存在: ${invalid.join(', ')}`);
      user.permissionGroups = [...new Set(permissionGroups)];
    }
    if (Array.isArray(permissions)) {
      if (permissions.includes('*')) throw new ApiError(400, 400, '独立权限不可直接授予 *，请使用超级管理员组');
      const valid = await Permission.find({ key: { $in: permissions } }).distinct('key');
      const invalid = permissions.filter((k) => !valid.includes(k));
      if (invalid.length) throw new ApiError(400, 400, `权限不存在: ${invalid.join(', ')}`);
      user.permissions = [...new Set(permissions)];
    }
    await user.save();
    const effective = await user.getEffectivePermissions();
    ok(res, { ...user.toSafeJSON(), effectivePermissions: effective, isManager: effective.length > 0 });
  })
);

// 班主任班级 / 班委（需 user.manage）
// body: { homeroomClasses?: string[]（教师，多选）, isClassOfficer?: boolean（学生开关） }
// 只改这两个班级身份字段，不动角色/权限；班级域接口（/api/class/*）按这些字段做成员资格校验
//
// 校验与写入实现搬到了 services/class-roles.js（用户 2026-10-24）：
// 班主任也要能开关本班学生的班委（PUT /api/class/student/:userId/officer），
// 两个入口必须共用同一份校验，否则口径迟早漂移（AGENTS.md：禁止另写一套）。
router.put(
  '/:id/class-roles',
  requirePermission('user.manage'),
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw new ApiError(404, 404, '用户不存在');
    const { homeroomClasses, isClassOfficer } = req.body || {};
    if (homeroomClasses !== undefined) await classRoles.setHomeroomClasses(user, homeroomClasses);
    if (isClassOfficer !== undefined) await classRoles.setClassOfficer(user, isClassOfficer);
    ok(res, {
      success: true,
      _id: user._id,
      role: user.role,
      className: user.className || '',
      homeroomClasses: user.homeroomClasses || [],
      isClassOfficer: !!user.isClassOfficer,
    });
  })
);

// ===== 学生宿舍（按学生绑定，不是班级绑房间）=====
// ⚠️ 口径（用户明确纠正过）：权威数据是 dorm_assignments（学生 openid ↔ roomId），
// 一间房可能混住几个班的学生，所以「谁住哪间」只能挂在学生身上；班级管理那边
// （packageAdmin/class-manage/dorms）用的是同一套 services/dorms.js，两处不得各写一套逻辑。
// 写权限与本页其他写接口（班主任班级/班委、解绑微信、封禁）一致：user.manage。

// 班级应住人数回填（dormCount）已随宿舍逻辑一起搬到 services/student-dorm.js，
// 本文件不再保留一份（两处各写一遍就会出现「管理端回填、班级域不回填」的分裂）。

/**
 * 学生会身份（用户详情页展示用）：查该用户的在任成员记录。
 * 返回 { isMember, levelText, roles: [{ deptName, roleText, levelText, schoolName, termName }], text }
 * 这是**只读展示**：改成员走管理端「学生会成员」页或用户端成员管理。
 * ⚠️ 关联键双路：openid 或 userId 任一命中。成员记录的 openid 是建档时的快照，
 * 学生没绑微信时是空串（实测踩过），只按 openid 查会让这些成员永远显示「未加入」；
 * userId 是建档就有的稳定键。
 */
async function presentUnionInfo(openid, userId) {
  const or = [];
  if (openid) or.push({ openid });
  if (userId && mongoose.isValidObjectId(userId)) or.push({ userId });
  if (!or.length) return { isMember: false, roles: [], text: '' };
  const UnionMember = require('../../models/union-member');
  const rows = await UnionMember.find({ status: 'active', $or: or })
    .select('level schoolName departmentName deptKey deptName role termId termName')
    .sort({ level: 1, createdAt: 1 })
    .lean();
  if (!rows.length) return { isMember: false, roles: [], text: '' };
  const terms = require('../../services/union').academicTerms();
  const currentTerm = terms.list[0] || {};
  const roles = rows.map((m) => {
    const term = terms.list.find((t) => t.termId === m.termId) || currentTerm;
    return {
      level: m.level,
      levelText: m.level === 'school' ? '校学生会' : `${m.schoolName || '院校'}学生会`,
      deptName: m.deptName || (m.deptKey === 'presidium' ? '主席团' : ''),
      role: m.role,
      roleText: UnionMember.ROLE_TEXT[m.role] || m.role,
      termName: m.termName || term.termName || '',
      termLabel: term.termLabel || m.termName || '',
    };
  });
  const first = roles[0];
  return {
    isMember: true,
    count: roles.length,
    roles,
    text: [first.levelText, first.deptName, first.roleText].filter(Boolean).join(' · '),
    levelText: first.levelText,
    termLabel: first.termLabel,
  };
}

// 宿舍的读/写实现都在 services/student-dorm.js（管理端与班级域共用同一份）：
// currentDorm / buildDormPayload / assignDorm / checkoutDorm 一律从那里取，
// 本文件只保留路由与鉴权。

// 单个学生的宿舍视图（读走 user.view：本路由整体挂在 user.view 下）
// 视图与写入逻辑都在 services/student-dorm.js：班级域「班主任给本班学生设宿舍」共用同一份，
// 楼名清单也由它下发（教师权限组不需要 building.view 才能选中宿舍楼）。
router.get(
  '/:id/dorm',
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '用户不存在');
    const user = await User.findById(req.params.id).select('openid role className').lean();
    if (!user) throw new ApiError(404, 404, '用户不存在');
    ok(res, await studentDorm.buildDormPayload(user));
  })
);

// 给一个学生绑宿舍：{ roomLabel: '1号楼·201' } 或 { roomId } + 可选 bedNo
// 房间不存在时 assignStudentRoom 会按「楼号·门号」自动建档；换房自动把旧记录置 moved
router.put(
  '/:id/dorm',
  requirePermission('user.manage'),
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 400, '用户不存在');
    const student = await User.findById(req.params.id)
      .select('openid realName nickname account studentId className departmentId departmentName role')
      .lean();
    if (!student) throw new ApiError(404, 404, '用户不存在');
    ok(res, await studentDorm.assignDorm(student, req.body || {}));
  })
);

// 退宿：把该生在住记录置 checked_out（历史记录保留，之后可重新绑定）
router.delete(
  '/:id/dorm',
  requirePermission('user.manage'),
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 400, '用户不存在');
    const student = await User.findById(req.params.id).select('openid role className').lean();
    if (!student) throw new ApiError(404, 404, '用户不存在');
    ok(res, await studentDorm.checkoutDorm(student));
  })
);

// 众数取值：非空字符串里出现最多的那个（并列时取字典序最小的，保证多次调用结果稳定）
function modeOf(values) {
  const count = new Map();
  for (const v of values || []) {
    const t = String(v == null ? '' : v).trim();
    if (!t) continue;
    count.set(t, (count.get(t) || 0) + 1);
  }
  let best = '';
  let bestN = -1;
  for (const key of [...count.keys()].sort()) {
    const n = count.get(key);
    if (n > bestN) {
      best = key;
      bestN = n;
    }
  }
  return best;
}

// 班级 → { className, grade, departmentName, schoolName }
// 班级名的层级只到「年级后两位 + 专业」，院系/系部不在班名里，只能从该班学生数据上取：
// 一次聚合按 className 分组（className 已有索引），院系/系部取众数（去掉空值，避免少数脏数据带偏）；
// 年级优先按学号前 4 位（roster.gradeFromStudentId 同口径），学号推导不出再落到班名前缀（roster.gradeFromClassName）
async function buildClassMeta() {
  const groups = await User.aggregate([
    { $match: { role: 'student', className: { $nin: [null, ''] } } },
    {
      $group: {
        _id: '$className',
        grades: { $addToSet: '$grade' },
        sidYears: { $addToSet: { $substrCP: [{ $ifNull: ['$studentId', ''] }, 0, 4] } },
        departments: { $addToSet: '$departmentName' },
        schools: { $addToSet: '$schoolName' },
      },
    },
  ]);
  return groups.map((g) => ({
    className: g._id,
    grade:
      modeOf((g.sidYears || []).map((y) => roster.gradeFromStudentId(y))) ||
      modeOf(g.grades) ||
      roster.gradeFromClassName(g._id),
    departmentName: modeOf(g.departments),
    schoolName: modeOf(g.schools),
  }));
}

// ===== 院校 → 系部 → 专业 联动树（新增 tree 键，供管理端「用户管理」页做级联筛选）=====
// 数据来源是两套「同一件事的不同写法」，必须合并，只取任何一套都会漏选项：
//   ① organizations（权威层级，父子靠 parentId，type = school|department|specialty）
//      —— 组织架构里配了但还没人挂上去的节点也要能选（刚建好的院系/专业）；
//   ② users 上 schoolName/departmentName/specialty 三个文本字段（名单导入只写名字，没有 id）
//      —— 组织树没配、只有数据里存在的组合也要能选（纯导入建号的学校，否则选了院校下一级全空）。
// 聚合一次拿到三种粒度的分桶（$facet），再按 school → department → specialty 组装；
// 与组织树 merge 时同名去重、count 累加。两边都没有的层不造节点：空 schoolName 不进树、空 specialty 不造节点。
// 计数口径（count）：**该节点直接匹配的用户数**，用列表接口同样的等值条件可复现（三个查询参数独立收窄）：
//   school.count    = users 里 schoolName 等于该院校名的学生数（不限系部/专业，即 `?school=X` 的 total）
//   department.count= users 里 schoolName=X 且 departmentName=Y 的学生数（即 `?school=X&department=Y` 的 total）
//   specialty.count = users 里 schoolName=X 且 departmentName=Y 且 specialty=Z 的学生数
//                    （即 `?school=X&department=Y&specialty=Z` 的 total）
// 所以父节点是「本级全量」而不是子树求和（school.count ≥ 其各系部 count 之和 ≥ 其各专业 count 之和）。
// 注意只有 (院校, 专业)、缺系部的数据：只计入院校数，不造无父级的专业节点。
// source 标记：configured = 组织架构里有这个节点，observed = 用户数据里观察到这个节点（两者可同时为 true）。
function trimName(v) {
  return String(v == null ? '' : v).trim();
}

function ensureNode(map, name) {
  let node = map.get(name);
  if (!node) {
    node = { name, count: 0, configured: false, observed: false };
    map.set(name, node);
  }
  return node;
}

function sortNodes(a, b) {
  return a.name.localeCompare(b.name, 'zh-Hans-CN');
}

async function buildFilterTree() {
  const [orgs, rows] = await Promise.all([
    Organization.find().select('name type parentId').lean(),
    // 与 buildClassMeta 同口径：只统计学生（教师不计入系部/专业人数）。
    // 三种粒度的桶对应列表接口三种筛选深度的 total，保证 count 口径可复现：
    //   scope='school'     按 schoolName 分组 —— 对应 `?school=X`（含没填系部/专业的那些人）
    //   scope='department' 按 schoolName + departmentName 分组 —— 对应 `?school=X&department=Y`
    //   scope='specialty'  按三元组分组 —— 对应 `?school=X&department=Y&specialty=Z`
    User.aggregate([
      { $match: { role: 'student', schoolName: { $nin: [null, ''] } } },
      {
        $facet: {
          school: [{ $group: { _id: { schoolName: '$schoolName' }, count: { $sum: 1 } } }],
          department: [
            { $match: { departmentName: { $nin: [null, ''] } } },
            { $group: { _id: { schoolName: '$schoolName', departmentName: '$departmentName' }, count: { $sum: 1 } } },
          ],
          specialty: [
            { $match: { departmentName: { $nin: [null, ''] }, specialty: { $nin: [null, ''] } } },
            {
              $group: {
                _id: { schoolName: '$schoolName', departmentName: '$departmentName', specialty: '$specialty' },
                count: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]).then((r) => r[0] || {}),
  ]);
  const buckets = (scope) => (Array.isArray(rows[scope]) ? rows[scope] : []);

  const schools = new Map();
  const departmentsBySchool = new Map();
  const specialtiesByPath = new Map();
  const ensureDept = (schoolName) => {
    let m = departmentsBySchool.get(schoolName);
    if (!m) {
      m = new Map();
      departmentsBySchool.set(schoolName, m);
    }
    return m;
  };
  const ensureSpec = (key) => {
    let m = specialtiesByPath.get(key);
    if (!m) {
      m = new Map();
      specialtiesByPath.set(key, m);
    }
    return m;
  };
  const ensureSchool = (name) => {
    const node = ensureNode(schools, name);
    node.configured = true;
    return node;
  };

  // ① 组织架构（权威层级）：这里**只认 parentId**，逐级向上走校验类型，
  //    不做「按名字找父级」—— 同名系部挂在两个院校下时按名字反查会挂错学校。
  //    孤儿节点（系部没挂院校 / 专业没挂系部）不进树：树是按院校分层的，它无处安放，
  //    但它只要在数据里出现过，就会由下面的 ② 补进来（此时按数据路径落位）。
  const byId = new Map(
    orgs.map((o) => [String(o._id), { name: trimName(o.name), type: o.type, parentId: String(o.parentId || '') }])
  );
  for (const node of byId.values()) {
    if (!node.name) continue;
    if (node.type === 'school') {
      ensureSchool(node.name);
      continue;
    }
    const parent = byId.get(node.parentId);
    if (!parent || !parent.name) continue;
    if (node.type === 'department') {
      if (parent.type !== 'school') continue;
      ensureSchool(parent.name);
      ensureNode(ensureDept(parent.name), node.name).configured = true;
      continue;
    }
    if (node.type === 'specialty') {
      if (parent.type !== 'department') continue;
      const grand = byId.get(parent.parentId);
      if (!grand || grand.type !== 'school' || !grand.name) continue;
      ensureSchool(grand.name);
      ensureNode(ensureDept(grand.name), parent.name).configured = true;
      ensureNode(ensureSpec(`${grand.name}\u0000${parent.name}`), node.name).configured = true;
    }
  }

  // ② 用户数据共现：只要数据里有这个组合，三层节点就都出现（并按上面口径给各层计数）
  //    先铺「系部」与「专业」两层（它们保证有完整路径），再单独补「只有院校」的桶，
  //    这样 orphan 级不会污染父级计数（专业计数 = 精确三元组；系部计数 = 该路径全量）。
  for (const g of buckets('specialty')) {
    const _id = g._id || {};
    const schoolName = trimName(_id.schoolName);
    const departmentName = trimName(_id.departmentName);
    const specialty = trimName(_id.specialty);
    if (!schoolName || !departmentName || !specialty) continue; // 空名不造节点
    const n = Number(g.count) || 0;
    const s = ensureNode(schools, schoolName);
    s.observed = true;
    ensureNode(ensureDept(schoolName), departmentName).observed = true;
    const sp = ensureNode(ensureSpec(`${schoolName}\u0000${departmentName}`), specialty);
    sp.observed = true;
    sp.count += n;
  }
  for (const g of buckets('department')) {
    const _id = g._id || {};
    const schoolName = trimName(_id.schoolName);
    const departmentName = trimName(_id.departmentName);
    if (!schoolName || !departmentName) continue;
    const d = ensureNode(ensureDept(schoolName), departmentName);
    d.observed = true;
    d.count += Number(g.count) || 0;
  }
  for (const g of buckets('school')) {
    const _id = g._id || {};
    const schoolName = trimName(_id.schoolName);
    if (!schoolName) continue; // 空院校不进树
    const s = ensureNode(schools, schoolName);
    s.observed = true;
    s.count += Number(g.count) || 0;
  }

  const toNode = (n, sourceKey) => ({
    name: n.name,
    label: `${n.name}（${n.count}）`,
    count: n.count,
    configured: n.configured,
    observed: n.observed,
    [sourceKey]: n.configured && n.observed ? 'both' : n.configured ? 'configured' : 'observed',
  });

  return [...schools.values()].sort(sortNodes).map((school) => ({
    ...toNode(school, 'source'),
    children: [...(departmentsBySchool.get(school.name)?.values() || [])].sort(sortNodes).map((department) => ({
      ...toNode(department, 'source'),
      children: [...(specialtiesByPath.get(`${school.name}\u0000${department.name}`)?.values() || [])]
        .sort(sortNodes)
        .map((specialty) => toNode(specialty, 'source')),
    })),
  }));
}

// 筛选可选项（院校/系部/专业/年级/班级）
// 日/周目标不再返回目标步数：它们是「当日/当周是否达标」，选项由前端固定（已达标/未达标）
// classes：班主任分配班级时的候选（在用的班级名，按「年级+专业」推导后的值），不新增班级列表接口
// classMeta：每个班级的年级/院系/系部（班主任班级多选抽屉要按这三层筛选，班名里没有院系/系部），
//            与 classes 一一对应、同序，不改动原有字段
// tree：院校 → 系部 → 专业 的联动树（新增键；上方三个平铺数组保持原样，老客户端继续可用）
router.get(
  '/filters',
  requirePermission('user.view'),
  wrap(async (req, res) => {
    const [schools, departments, specialties, studentIds, gradeValues, classes, classMeta, tree, officerN, unionRows] = await Promise.all([
      User.distinct('schoolName', { schoolName: { $nin: [null, ''] } }),
      User.distinct('departmentName', { departmentName: { $nin: [null, ''] } }),
      User.distinct('specialty', { specialty: { $nin: [null, ''] } }),
      User.distinct('studentId', { studentId: { $exists: true, $nin: [null, ''] } }),
      User.distinct('grade', { grade: { $exists: true, $nin: [null, ''] } }),
      User.distinct('className', { className: { $nin: [null, ''] }, role: { $ne: 'teacher' } }),
      buildClassMeta(),
      buildFilterTree(),
      User.countDocuments({ isClassOfficer: true }),
      require('../../models/union-member').find({ status: 'active' }).select('openid userId').lean(),
    ]);
    const ClassProfile = require('../../models/class-profile');
    // 班级状态计数（按**学生人数**，不是班级数）：与列表接口 `?classStatus=X` 的 total 同口径，
    // 管理员在下拉里看到的数字必须等于点进去的人数，否则会被当成筛选坏了。
    // 做法：class_profiles 取状态 → 该班学生数（users 一次聚合）→ 按状态累加人数。
    const studentCountByClass = await User.aggregate([
      { $match: { role: 'student', className: { $nin: [null, ''] } } },
      { $group: { _id: '$className', n: { $sum: 1 } } },
    ]);
    const cntByClass = new Map(studentCountByClass.map((r) => [r._id, r.n]));
    const profilesForCount = await ClassProfile.find({}).select('className status').lean();
    const classStatusCounts = { normal: 0, intern: 0, graduated: 0 };
    for (const p of profilesForCount) {
      classStatusCounts[ClassProfile.normalizeStatus(p.status)] += cntByClass.get(p.className) || 0;
    }
    // 班主任人数：单独查（教师账号量小，一次 count 足够）
    const homeroomN = await User.countDocuments({ role: 'teacher', homeroomClasses: { $exists: true, $ne: [] } });
    // 学生会成员数：按**去重后的人头**数（一人可能有多条在任记录：跨部门 / 跨院校），
    // 且必须 openid OR userId 双路映射到 users，否则未绑微信的成员会被漏计。
    const unionOpenids = new Set(unionRows.map((r) => r.openid).filter(Boolean));
    const unionUserIds = unionRows
      .map((r) => (r.userId ? String(r.userId) : ''))
      .filter((s) => mongoose.isValidObjectId(s))
      .map((s) => new mongoose.Types.ObjectId(s));
    const unionOr = [];
    if (unionOpenids.size) unionOr.push({ openid: { $in: [...unionOpenids] } });
    if (unionUserIds.length) unionOr.push({ _id: { $in: unionUserIds } });
    const unionN = unionOr.length ? await User.countDocuments({ $or: unionOr }) : 0;
    // 年级：grade 字段优先，缺失的存量数据按学号前 4 位（入学年份）推导
    const grades = [
      ...new Set(
        [
          ...(gradeValues || []).map((g) => String(g).replace(/级$/, '').trim()),
          ...(studentIds || []).map((sid) => roster.gradeFromStudentId(sid)),
        ].filter(Boolean)
      ),
    ].sort().reverse();
    const sortedClasses = [...(classes || [])].sort();
    const metaByClass = new Map((classMeta || []).map((m) => [m.className, m]));
    ok(res, {
      schools,
      departments,
      specialties,
      grades,
      classes: sortedClasses,
      // 与 classes 同序，只保留有学生数据的班级（前端按 className 取用，取不到时降级为无副标题）
      classMeta: sortedClasses.map((c) => metaByClass.get(c)).filter(Boolean),
      // 院校 → 系部 → 专业 联动树（前端「用户管理」页级联筛选用）；上面各键保持原样不动
      tree,
      // ===== 新增两组筛选的选项与计数 =====
      // 计数直接给到前端，避免「下拉里看到 9（班数）点进去 395（人数）」这类口径错位。
      classStatuses: ['normal', 'intern', 'graduated'].map((k) => ({
        value: k,
        label: ClassProfile.STATUS_TEXT[k],
        count: classStatusCounts[k] || 0,
      })),
      identities: [
        { value: 'officer', label: '班委', count: officerN || 0 },
        { value: 'homeroom', label: '班主任', count: homeroomN || 0 },
        { value: 'union', label: '学生会成员', count: unionN || 0 },
      ],
    });
  })
);

// 列表与详情一律不取的凭据/风控内部字段（AGENTS.md 安全红线：哈希绝不下发客户端）。
// 详情原本就写了这条排除串，列表以前漏了 —— 本轮给列表补上（小程序侧无人读取这些字段）。
// 串本身是 mongoose 的 select 形式，聚合分支再转成 $project 的 { 字段: 0 }。
const CREDENTIAL_FIELDS = '-__v -passwordHash -initialHashes -resetHashes -failedLogins -lockUntil';
const credentialProjection = CREDENTIAL_FIELDS.split(' ').reduce((acc, k) => ({ ...acc, [k.replace(/^-/, '')]: 0 }), {});

// 列表行附带运动目标（个人计划 > 全局默认）：按本页 openid 批量查一次 user_goals，供学生行展示计划名
const attachGoals = async (list) => {
  const openids = [...new Set(list.map((u) => u.openid).filter(Boolean))];
  const goals = openids.length
    ? await UserGoal.find({ openid: { $in: openids } }).select('openid planName').lean()
    : [];
  const byOpenid = new Map(goals.map((g) => [g.openid, g]));
  for (const u of list) {
    const g = byOpenid.get(u.openid);
    u.goal = { planName: (g && g.planName) || '' };
  }
  return list;
};

// 列表行附带宿舍（dorm_assignments 是在住权威数据）：
// **只查一次** —— 用本页学生的 openid 集合做 `find({ openid: { $in } , status: { $in: ['checked_in','guest'] } })`，
// 再在内存里用 Map（openid → 行）做一次 join，逐行赋值。
// 为什么不能逐行查：列表一页 20 条就是 20 次 round-trip（N+1），翻页时线性放大；
// 一次 $in 查询走的是 dorm_assignments 上已有的 openid 唯一部分索引（partialFilterExpression
// 正好只含 checked_in/guest），一页最多一次查询，条数等于已绑宿舍的人数。
// 教师行不给宿舍（教师不住学生宿舍），u.dorm 保持 null。
const attachDorms = async (list) => {
  const openids = [...new Set(list.filter((u) => u.role !== 'teacher').map((u) => u.openid).filter(Boolean))];
  const rows = openids.length
    ? await DormAssignment.find({ openid: { $in: openids }, status: { $in: ['checked_in', 'guest'] } })
        .select('openid roomId buildingId buildingName roomNo bedNo')
        .lean()
    : [];
  const byOpenid = new Map(rows.map((r) => [r.openid, r]));
  for (const u of list) {
    const r = u.role === 'teacher' ? null : byOpenid.get(u.openid);
    u.dorm = r
      ? {
          roomText: dormsSvc.roomLabel(r),
          roomId: r.roomId ? String(r.roomId) : '',
          bedNo: r.bedNo || '',
        }
      : null;
  }
  return list;
};

// 列表行附带「班级状态 + 学生会身份」（用户 2026-10-20：绑定的班级被设为实习/毕业也要显示，
// 学生会、班委等身份同理要能一眼看到）。
// 与 attachDorms 同一套做法：**按本页一次批量查**，内存 join，绝不逐行查（N+1）。
//   · 班级状态：class_profiles.status（normal/intern/graduated）。老数据没有该字段 → 按「正常」，
//     与 models/class-profile.js::normalizeStatus 同口径，不能显示成空。
//   · 学生会身份：student_union_members 在任记录。关联键**必须 openid OR userId 双路**——
//     成员记录的 openid 是建档快照，学生未绑微信时为空串（实测存在），只按 openid 查会漏人。
const attachClassAndUnion = async (list) => {
  const classNames = [...new Set(list.map((u) => u.className).filter(Boolean))];
  const openids = [...new Set(list.map((u) => u.openid).filter(Boolean))];
  const userIds = [...new Set(list.map((u) => u._id).filter(Boolean))];
  const ClassProfile = require('../../models/class-profile');
  const UnionMember = require('../../models/union-member');
  const [profiles, members] = await Promise.all([
    classNames.length
      ? ClassProfile.find({ className: { $in: classNames } }).select('className status').lean()
      : Promise.resolve([]),
    openids.length || userIds.length
      ? UnionMember.find({
          status: 'active',
          $or: [{ openid: { $in: openids } }, { userId: { $in: userIds } }],
        })
          .select('openid userId level schoolName deptKey deptName role')
          .lean()
      : Promise.resolve([]),
  ]);
  const statusByClass = new Map(profiles.map((p) => [p.className, ClassProfile.normalizeStatus(p.status)]));
  // 同一人可能有多条在任记录（跨部门 / 跨院校），全部收进数组，文案取第一条、标签可显示「+N」
  const unionByUser = new Map();
  const pushUnion = (key, row) => {
    if (!key) return;
    const arr = unionByUser.get(key) || [];
    if (!arr.some((x) => x._id === String(row._id))) arr.push(row);
    unionByUser.set(key, arr);
  };
  for (const m of members) {
    if (m.openid) pushUnion(String(m.openid), m);
    if (m.userId) pushUnion(String(m.userId), m);
  }
  for (const u of list) {
    const st = u.role === 'teacher' ? '' : statusByClass.get(u.className) || '';
    u.classStatus = st || '';
    u.classStatusText = st && st !== 'normal' ? ClassProfile.STATUS_TEXT[st] : '';
    const mine = unionByUser.get(String(u.openid || '')) || unionByUser.get(String(u._id || '')) || [];
    u.unionRoles = mine.map((m) => ({
      deptName: m.deptName || (m.deptKey === 'presidium' ? '主席团' : ''),
      roleText: UnionMember.ROLE_TEXT[m.role] || m.role,
      levelText: m.level === 'school' ? '校学生会' : `${m.schoolName || '院校'}学生会`,
    }));
    u.isUnionMember = mine.length > 0;
    const first = u.unionRoles[0];
    u.unionText = first ? [first.deptName, first.roleText].filter(Boolean).join(' · ') : '';
    u.unionMore = mine.length > 1 ? mine.length - 1 : 0;
  }
  return list;
};

// 用户列表/搜索 + 多维筛选（院校/系部/专业/年级/日周达标）
/**
 * 列表与分面计数**共用**的条件构造（用户 2026-10-21「括号中的人数要根据筛选实时计算」）。
 * 两处各写一份必然漂移 → 出现「下拉写着 1424、点进去只有 364」这种比不显示数字更糟的假承诺。
 * @param {object} q     查询参数（req.query 或它的子集）
 * @param {string|null} omit 跳过哪个维度的条件（分面计数按维度传入；列表传 null）
 * @returns {Promise<{cond: object, daily: string, weekly: string}>}
 */
async function buildUserMatch(q, omit) {
  const cond = {};
  const and = []; // 与 keyword 的 $or 并存的条件（不能互相覆盖）
  const keep = (dim) => omit !== dim;
  if (q.keyword) {
    const kw = String(q.keyword).trim();
    const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    cond.$or = [{ nickname: re }, { realName: re }, { studentId: re }, { openid: kw }, { className: re }];
  }
  if (q.status) cond.status = q.status;
  if (q.role) cond.role = q.role;
  // 管理员不是角色而是权限：直接权限或所在权限组非空即视为管理员（与登录态 isManager 同义）
  if (q.manager === '1') {
    and.push({
      $or: [{ permissions: { $exists: true, $ne: [] } }, { permissionGroups: { $exists: true, $ne: [] } }],
    });
  }
  if (keep('school') && q.school) cond.schoolName = q.school;
  if (keep('department') && q.department) cond.departmentName = q.department;
  if (keep('specialty') && q.specialty) cond.specialty = q.specialty;
  // 班级状态（正常 / 实习 / 毕业）：状态存在 class_profiles 上，users 里只有 className，
  // 所以先按状态取出班名再 $in 收窄。'normal' 必须**包含老数据缺字段**的情况
  //（与 ClassProfile.normalizeStatus 同口径：非 intern/graduated 一律算正常），
  // 否则 44 个没有 status 字段的班会在「正常」筛选里凭空消失。
  if (keep('classStatus') && q.classStatus) {
    const ClassProfile = require('../../models/class-profile');
    const want = String(q.classStatus);
    if (!['normal', 'intern', 'graduated'].includes(want)) throw new ApiError(400, 400, '班级状态只能为 normal/intern/graduated');
    const stFilter = want === 'normal' ? { status: { $nin: ['intern', 'graduated'] } } : { status: want };
    const names = await ClassProfile.find(stFilter).distinct('className');
    // 空集合直接给一个不可能命中的值：宁可返回 0 人，也不能退化成「不过滤」（那会显示全校）
    and.push({ className: { $in: names.length ? names : ['__none__'] } });
  }
  // 身份筛选（班委 / 班主任 / 学生会成员）：与「管理员 Tab」是不同维度，可叠加
  if (keep('identity') && q.identity) {
    and.push(await identityCondition(String(q.identity)));
  }
  if (keep('grade') && q.grade) {
    // 年级 = 学号前 4 位（入学年份）；兼容 grade 字段与「2024级xx班」的班级命名。
    // 走 gradeCondition()：分面计数与列表必须用**同一个表达式**，否则数字与结果对不上。
    and.push(gradeCondition(String(q.grade).replace(/级$/, '').trim()));
  }
  if (and.length) cond.$and = and;
  const pick = (v) => (['0', '1'].includes(String(v ?? '')) ? String(v) : '');
  return { cond, daily: pick(q.dailyAchieved), weekly: pick(q.weeklyAchieved) };
}

/**
 * 身份维度的查询条件（列表与分面计数共用）。
 * ⚠️ userId 是 ObjectId：必须转成 ObjectId 再进 $in。
 * 列表有两条分支（aggregate 与 find），aggregate 的 $match **不会**替我们做字符串→ObjectId 的
 * 类型转换，直接塞字符串会一个都匹配不上（表现是「筛选学生会成员 → 0 人」，静默错）。
 */
async function identityCondition(kind) {
  if (kind === 'officer') return { isClassOfficer: true };
  if (kind === 'homeroom') return { role: 'teacher', homeroomClasses: { $exists: true, $ne: [] } };
  if (kind === 'union') {
    const UnionMember = require('../../models/union-member');
    const rows = await UnionMember.find({ status: 'active' }).select('openid userId').lean();
    const openids = [...new Set(rows.map((r) => r.openid).filter(Boolean))];
    const userIds = [
      ...new Set(
        rows
          .map((r) => (r.userId ? String(r.userId) : ''))
          .filter(Boolean)
          .map((s) => (mongoose.isValidObjectId(s) ? new mongoose.Types.ObjectId(s) : null))
          .filter(Boolean)
      ),
    ];
    const or = [];
    if (openids.length) or.push({ openid: { $in: openids } });
    if (userIds.length) or.push({ _id: { $in: userIds } });
    // 双路关联（openid 或 userId 任一命中）：成员记录未绑微信时 openid 是空串（实测存在）
    return or.length ? { $or: or } : { _id: null };
  }
  throw new ApiError(400, 400, '身份只能为 officer/homeroom/union');
}

/**
 * 各筛选维度的**实时**人数（用户 2026-10-21「括号中的人数要根据筛选实时计算才对」）。
 * 旧行为：选项计数来自 buildFilterTree()，那是**整库全量**（不带任何筛选条件），
 * 所以选了年级 2025 之后系部仍写着全校人数 —— 点进去对不上，比不显示数字更误导。
 *
 * 口径（与列表严格一致，复用 buildUserMatch）：
 *   某维度 D 的计数 = 「除 D 以外所有已选条件」命中的人里，按 D 的值分组计数。
 *   排除自身是必须的：否则选了「计财系」后其它系部全变 0，管理员没法切换到别的系部。
 *
 * ⚠️ 刻意**不**给日/周目标计数：它们的选项本来就没有 count 字段，
 *   要算得跑 run_records 聚合（全库最贵的一张表），而这两个维度只有「已达标/未达标」两项、
 *   信息量极低。宁可没有数字，也不给一个昂贵的或口径不对的数字。
 * @returns {Promise<null|{school:object,department:object,specialty:object,grade:object,classStatus:object,identity:object}>}
 */
async function userFacets(q) {
  const pick = (v) => (['0', '1'].includes(String(v ?? '')) ? String(v) : '');
  if (pick(q.dailyAchieved) || pick(q.weeklyAchieved)) return null;
  const [school, department, specialty, grade, classStatus, identity] = await Promise.all([
    groupCount(await buildUserMatch(q, 'school'), 'schoolName'),
    groupCount(await buildUserMatch(q, 'department'), 'departmentName'),
    groupCount(await buildUserMatch(q, 'specialty'), 'specialty'),
    gradeFacet(await buildUserMatch(q, 'grade')),
    classStatusFacet(await buildUserMatch(q, 'classStatus')),
    identityFacet(await buildUserMatch(q, 'identity')),
  ]);
  return { school, department, specialty, grade, classStatus, identity };
}

/** 一次 $group 拿到某字段的全部取值人数（空值不计数） */
async function groupCount({ cond }, field) {
  const rows = await User.aggregate([
    { $match: cond },
    { $group: { _id: `$${field}`, n: { $sum: 1 } } },
  ]);
  const out = {};
  for (const r of rows) if (r._id) out[String(r._id)] = r.n;
  return out;
}

/**
 * 年级条件（列表与分面计数**共用同一个表达式**）。
 * 年级 = 学号前 4 位（入学年份），但存量数据 grade 字段普遍为空，所以要三选一兜底。
 * 分面计数不能自己另推一套（比如按 className 前两位算）：口径一旦与列表不同，
 * 「年级 2025（N）」点进去就不是 N —— 正是本轮要修的那个问题。
 */
function gradeCondition(g) {
  const esc = String(g).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { $or: [{ grade: g }, { studentId: new RegExp('^' + esc) }, { className: new RegExp('^' + esc + '级') }] };
}

/**
 * 年级候选值（与 /filters 的 grades 同口径：grade 字段 ∪ 学号前 4 位 ∪ 班名前缀）。
 * 一次聚合拿全，避免逐值 distinct。
 */
async function gradeCandidates() {
  const rows = await User.aggregate([
    {
      $facet: {
        g: [{ $match: { grade: { $nin: [null, ''] } } }, { $group: { _id: '$grade' } }],
        s: [
          { $match: { studentId: { $nin: [null, ''] } } },
          { $group: { _id: { $substr: ['$studentId', 0, 4] } } },
        ],
        c: [
          { $match: { className: { $regex: '^[0-9]{2}级' } } },
          { $group: { _id: { $concat: ['20', { $substr: ['$className', 0, 2] }] } } },
        ],
      },
    },
  ]);
  const f = rows[0] || {};
  const out = new Set();
  for (const list of [f.g || [], f.s || [], f.c || []]) {
    for (const r of list) {
      const y = String(r._id || '').replace(/级$/, '').trim();
      if (/^(19|20)[0-9]{2}$/.test(y)) out.add(y);
    }
  }
  return [...out].sort().reverse();
}

/**
 * 年级逐个候选值计数（用 gradeCondition，与列表完全同一表达式）。
 * 刻意不用「按有效年级 $group」：列表是三选一 $or，一个学生可能同时命中多个来源，
 * 分组只能挑一个 → 计数与列表 total 对不上。候选值只有个位数（2020~2026），
 * 逐值 countDocuments 的代价可以接受，换来的是口径绝对一致。
 */
async function gradeFacet(match) {
  const candidates = await gradeCandidates();
  const counts = await Promise.all(candidates.map((g) => User.countDocuments(andWrap(match.cond, gradeCondition(g)))));
  const out = {};
  candidates.forEach((g, i) => {
    if (counts[i]) out[g] = counts[i];
  });
  return out;
}

/** 班级状态：状态在 class_profiles 上，按状态取班名再数人（与列表 classStatus 同一实现） */
async function classStatusFacet(match) {
  const ClassProfile = require('../../models/class-profile');
  const [profiles, perClass] = await Promise.all([
    ClassProfile.find({}).select('className status').lean(),
    User.aggregate([
      { $match: andWrap(match.cond, { role: 'student', className: { $nin: [null, ''] } }) },
      { $group: { _id: '$className', n: { $sum: 1 } } },
    ]),
  ]);
  const cnt = new Map(perClass.map((r) => [r._id, r.n]));
  const out = { normal: 0, intern: 0, graduated: 0 };
  for (const p of profiles) out[ClassProfile.normalizeStatus(p.status)] += cnt.get(p.className) || 0;
  return out;
}

/** 身份：三个值各数一次（复用 identityCondition，含学生会 openid/userId 双路的坑） */
async function identityFacet(match) {
  const [officer, homeroom, union] = await Promise.all([
    User.countDocuments(andWrap(match.cond, await identityCondition('officer'))),
    User.countDocuments(andWrap(match.cond, await identityCondition('homeroom'))),
    User.countDocuments(andWrap(match.cond, await identityCondition('union'))),
  ]);
  return { officer, homeroom, union };
}

/** cond 里可能已有 $and/$or，追加条件必须并进 $and，不能覆盖 */
function andWrap(cond, extra) {
  return { ...cond, $and: [...(cond.$and || []), extra] };
}

router.get(
  '/',
  wrap(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    // 条件构造与分面计数共用 buildUserMatch（**不要**在这里再写一份，见其注释）
    const { cond, daily: dailyAchieved, weekly: weeklyAchieved } = await buildUserMatch(req.query, null);
    // 各维度实时人数**随列表一起返回**，但只在 `withFacets=1` 时算：
    //   前端只在**筛选条件变化**（reload）时带这个参数，翻页（onReachBottom → load）不带。
    //   放在同一个响应里而不是单开 /facets：两次请求之间数据可能已变，且要处理响应交错；
    //   同一次请求天然保证「数字」与「列表结果」同时刻、同口径（用户报的就是这个不一致）。
    const facetsP = String(req.query.withFacets) === '1' ? userFacets(req.query) : Promise.resolve(undefined);
    if (dailyAchieved || weeklyAchieved) {
      const today = dates.todayKey();
      const { startKey } = dates.weekRange(today);
      const globalConfig = await GoalConfig.getSingleton();
      const globalDaily = Number(globalConfig.daily?.steps) || 0;
      const globalWeekly = Number(globalConfig.weekly?.steps) || 0;
      // 按日期区间汇总该用户 run_records 的步数（werun + gps + beidou 全部来源）
      const stepsLookup = (as, from, to) => ({
        $lookup: {
          from: 'run_records',
          let: { oid: '$openid' },
          pipeline: [
            {
              $match: {
                $expr: { $and: [{ $eq: ['$openid', '$$oid'] }, { $gte: ['$date', from] }, { $lte: ['$date', to] }] },
              },
            },
            { $group: { _id: null, steps: { $sum: '$steps' } } },
          ],
          as,
        },
      });
      const expr = [];
      if (dailyAchieved) {
        expr.push({ [dailyAchieved === '0' ? '$lt' : '$gte']: ['$todaySteps', '$dailyTarget'] });
      }
      if (weeklyAchieved) {
        expr.push({ [weeklyAchieved === '0' ? '$lt' : '$gte']: ['$weekSteps', '$weeklyTarget'] });
      }
      const basePipeline = [
        { $match: cond },
        { $lookup: { from: 'user_goals', localField: 'openid', foreignField: 'openid', as: 'g' } },
        { $addFields: { g: { $arrayElemAt: ['$g', 0] } } },
        stepsLookup('todayAgg', today, today),
        stepsLookup('weekAgg', startKey, today),
        {
          $addFields: {
            todaySteps: { $ifNull: [{ $arrayElemAt: ['$todayAgg.steps', 0] }, 0] },
            weekSteps: { $ifNull: [{ $arrayElemAt: ['$weekAgg.steps', 0] }, 0] },
            dailyTarget: { $ifNull: ['$g.daily.steps', globalDaily] },
            weeklyTarget: { $ifNull: ['$g.weekly.steps', globalWeekly] },
          },
        },
        { $match: { $expr: { $and: expr } } },
        // 清掉聚合中间字段，响应结构与普通列表一致；凭据/风控内部字段同样排除（与 find 分支同口径）
        { $project: { g: 0, todayAgg: 0, weekAgg: 0, todaySteps: 0, weekSteps: 0, dailyTarget: 0, weeklyTarget: 0, ...credentialProjection } },
      ];
      const [list, countAgg] = await Promise.all([
        // 排序必须带唯一的 _id 兜底：createdAt 在名单批量导入时大量同值，
        // 只按它排序的话 skip 翻页两次查询各排各的，第 2 页会重复第 1 页的人
        User.aggregate([...basePipeline, { $sort: { createdAt: -1, _id: -1 } }, { $skip: skip }, { $limit: limit }]),
        User.aggregate([...basePipeline, { $count: 'n' }]),
      ]);
      // 目标与宿舍都在 list 上就地补字段（批量查询，互不依赖，并发跑）
      await Promise.all([attachGoals(list), attachDorms(list), attachClassAndUnion(list)]);
      // 达标筛选存在时 userFacets 直接返回 null（见其注释），await 它没有额外开销
      return ok(res, { list, total: countAgg[0]?.n || 0, page, limit, facets: await facetsP });
    }

    const [list, total] = await Promise.all([
      User.find(cond).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).select(CREDENTIAL_FIELDS).lean(),
      User.countDocuments(cond),
    ]);
    await Promise.all([attachGoals(list), attachDorms(list), attachClassAndUnion(list)]);
    ok(res, { list, total, page, limit, facets: await facetsP });
  })
);

// ===== 批量操作 =====
/**
 * 每个动作**沿用单条接口的权限**，而不是给批量另设一个万能权限。
 * 为什么：批量只是把 N 次单条合成一次请求，能力边界必须与单条**完全一致** ——
 * 否则会出现「没有 permission.manage 的人能用批量删号」这种越权升级。
 * 删除 / 重置密码走 permission.manage（与 DELETE /:id、POST /:id/reset-password 同）。
 */
const BATCH_ACTIONS = {
  officer: { perm: 'user.manage', label: '设为/取消班委' },
  ban: { perm: 'user.manage', label: '限制账号' },
  unban: { perm: 'user.manage', label: '解除限制' },
  transfer: { perm: 'permission.manage', label: '转移院校/系部/专业/年级' },
  // 批量只支持「恢复初始密码」；「设置密码」需要逐人不同的明文，走用户详情页单条操作
  'reset-password': { perm: 'permission.manage', label: '恢复初始密码' },
  delete: { perm: 'permission.manage', label: '删除账号' },
};
// 单次上限：批量删号会级联删多张表，放开到几千条会把请求线程占满（也超出「一次操作」的人工核对能力）
const BATCH_MAX = 500;

/**
 * 组织架构索引（school → department → specialty，父子只认 parentId）。
 * 批量转移必须按它校验目标值：
 *   ① 前端已改成级联选择（不再有自由输入），但**服务端不能只信前端**（AGENTS.md：权限与校验以服务端为准）；
 *   ② 旧实现 `String(school).trim()` 直接落库，任何字符串都能写进 schoolName —— 打错一个字，
 *      该生就从「北校区」凭空变成一个不存在的院校，筛选与班超分组全部对不上。
 * 只认 parentId、不按名字猜父级，与 routes/admin/class-profile.js::buildFacetTree 同一口径
 * （同名系部挂在两个校区时按名字反查会挂错）。
 */
async function buildOrgIndex() {
  const orgs = await Organization.find().select('name type parentId').lean();
  const byId = new Map(orgs.map((o) => [String(o._id), o]));
  const schools = new Map(); // name → { id, departments: Map<name, { id, specialties: Map<name, id> }> }
  for (const o of orgs) {
    const name = String(o.name || '').trim();
    if (!name) continue;
    if (o.type === 'school') {
      if (!schools.has(name)) schools.set(name, { id: o._id, departments: new Map() });
      continue;
    }
    const parent = byId.get(String(o.parentId || ''));
    const pName = parent ? String(parent.name || '').trim() : '';
    if (o.type === 'department') {
      if (!parent || parent.type !== 'school' || !pName) continue; // 游离系部：无法定位所属院校
      if (!schools.has(pName)) schools.set(pName, { id: parent._id, departments: new Map() });
      const s = schools.get(pName);
      if (!s.departments.has(name)) s.departments.set(name, { id: o._id, specialties: new Map() });
      continue;
    }
    if (o.type === 'specialty') {
      if (!parent || parent.type !== 'department' || !pName) continue;
      const gp = byId.get(String(parent.parentId || ''));
      const gName = gp ? String(gp.name || '').trim() : '';
      if (!gp || gp.type !== 'school' || !gName || !schools.has(gName)) continue;
      const s = schools.get(gName);
      if (!s.departments.has(pName)) s.departments.set(pName, { id: parent._id, specialties: new Map() });
      s.departments.get(pName).specialties.set(name, o._id);
    }
  }
  return schools;
}

/** 新院校整批校验一次（循环外）：打错一个字就拒绝，而不是让 500 人各失败一次掩盖真因 */
function assertTransferSchool(schools, schoolName) {
  const name = String(schoolName || '').trim();
  if (!name) return;
  if (!schools.has(name)) {
    throw new ApiError(400, 400, `院校不存在：${name}（请到「组织架构」页添加后再转移）`);
  }
}

/**
 * 校验并解析单个学生的转移补丁。
 * ⚠️ 同时回填 schoolId / departmentId：users 上这两个 id 有 1535 人是填过的，
 *   旧实现只改 *Name 不改 *Id → 转移后 id 仍指向**旧校区**的组织节点，
 *   按 id 归组的口径（学生会分会范围、班级台账等）会把该生算回原校区。
 *
 * 系部 / 专业必须按「该生转移后所属院校」判定：一批里可能混着两个校区的人，
 * 而两校区都有同名系部（北校区/洋河校区各有计财系），只查名字会放过跨校区错配。
 * 解析不了的只让该生失败并给出原因（整批混选时这才有意义）。
 * @param {Map} schools buildOrgIndex() 的结果
 * @param {object} body { school?, department?, specialty? } 只含要改的维度
 * @param {string} currentSchoolName 该生转移前的院校（没改院校时用它定位系部/专业）
 * @param {string} currentDeptName 该生转移前的系部名（**只转院校时靠它重新解析 departmentId**）
 */
function resolveTransferTarget(schools, body, currentSchoolName, currentDeptName) {
  const patch = {};
  const schoolName = String(body.school || '').trim();
  let school = null;
  if (schoolName) {
    school = schools.get(schoolName);
    if (!school) throw new ApiError(400, 400, `院校不存在：${schoolName}（请到「组织架构」页添加后再转移）`);
    patch.schoolName = schoolName;
    patch.schoolId = school.id;
  }
  // 判定归属的院校：新院校优先，否则该生原院校
  const scopeName = schoolName || String(currentSchoolName || '').trim();
  const scope = school || (scopeName ? schools.get(scopeName) : null);
  const deptName = String(body.department || '').trim();
  if (deptName) {
    if (!scope) {
      throw new ApiError(400, 400, `该生所属院校无法在组织架构里定位（当前「${scopeName || '空'}」），无法转移系部`);
    }
    const dept = scope.departments.get(deptName);
    if (!dept) throw new ApiError(400, 400, `「${scopeName}」下没有系部：${deptName}`);
    patch.departmentName = deptName;
    patch.departmentId = dept.id;
  } else if (school && currentDeptName) {
    // ⚠️ **只转院校**（没指定新系部）时也必须重新解析 departmentId：
    //   两校区的系部**同名**（北校区 / 洋河校区都有「计财系」，是两个不同的 organization 节点），
    //   若沿用旧 id，该生的 schoolId 已经是新校区、departmentId 却还挂在旧校区节点上，
    //   按 id 归组（学生会分会范围 / 班级台账）会把他算回原校区 —— 名字对、id 错更难排查。
    const dept = scope.departments.get(String(currentDeptName).trim());
    if (dept) {
      patch.departmentId = dept.id;
    } else {
      // 新校区没有同名系部（如该生原系部只存在于旧校区）→ 清掉旧 id，
      // 宁可留空让台账显示「未归入组织架构」，也不能留一个指向别校的错 id。
      patch.departmentId = null;
      patch.transferNote = `「${currentDeptName}」在「${schoolName}」下不存在，已清空系部归属，请核对`;
    }
  }
  const specName = String(body.specialty || '').trim();
  if (specName) {
    if (!scope) {
      throw new ApiError(400, 400, `该生所属院校无法在组织架构里定位（当前「${scopeName || '空'}」），无法转移专业`);
    }
    if (deptName) {
      const d = scope.departments.get(deptName);
      if (!d || !d.specialties.has(specName)) throw new ApiError(400, 400, `「${deptName}」下没有专业：${specName}`);
    } else if (![...scope.departments.values()].some((d) => d.specialties.has(specName))) {
      // 没给系部 → 该院校下任一系部有这个专业即允许（不猜具体系部，也不跨院校放行）
      throw new ApiError(400, 400, `「${scopeName}」下没有专业：${specName}`);
    }
    patch.specialty = specName;
  }
  return patch;
}

router.post(
  '/batch',
  wrap(async (req, res) => {
    const { ids, action } = req.body || {};
    const spec = BATCH_ACTIONS[String(action || '')];
    if (!spec) throw new ApiError(400, 400, `不支持的批量操作：${action || '（空）'}`);
    if (!Array.isArray(ids) || !ids.length) throw new ApiError(400, 400, '请先选择要操作的用户');
    if (ids.length > BATCH_MAX) throw new ApiError(400, 400, `一次最多处理 ${BATCH_MAX} 个账号（当前 ${ids.length} 个）`);

    // 本路由整体挂在 user.view 下，这里再按动作校验对应权限
    const perms = await req.user.getEffectivePermissions();
    if (!perms.includes('*') && !perms.includes(spec.perm)) {
      throw new ApiError(403, 403002, `无权限（需要 ${spec.perm}）`);
    }

    const users = await User.find({ _id: { $in: ids.filter((x) => mongoose.isValidObjectId(x)) } });
    // 转移要先拿到组织架构索引：① 目标值必须是真实存在的节点（不接受自由输入）；
    // ② 要按名字反查 organizationId 一并写回 schoolId / departmentId。
    // 整批只建一次索引（一次 Organization.find），不在循环里查库。
    let orgSchools = null;
    if (action === 'transfer') {
      orgSchools = await buildOrgIndex();
      assertTransferSchool(orgSchools, req.body.school);
    }
    // 逐条**串行**处理：
    //   ① 删除会级联动 8 张表 + 住宿记录，并发跑容易在同一房间/同一班名上互相踩；
    //   ② 单条失败不能中断整批 —— 要如实回报「成功 N 个、失败 M 个，以及每个失败的原因」，
    //      否则管理员面对半成功状态只能猜（比整体回滚更常见的真实诉求）。
    const done = [];
    const failed = [];
    for (const user of users) {
      const name = user.account || user.nickname || user.realName || String(user._id);
      try {
        if (action === 'officer') {
          if (user.role !== 'student') throw new ApiError(400, 400, '只有学生账号可以设为班委');
          const on = !!req.body.isClassOfficer;
          if (on && !user.className) throw new ApiError(400, 400, '该学生尚未识别出班级，无法设为班委');
          user.isClassOfficer = on;
          await user.save();
          done.push({ _id: String(user._id), name, result: on ? '已设为班委' : '已取消班委' });
        } else if (action === 'ban') {
          const info = await accountAdmin.banUser(user, {
            scope: req.body.scope,
            reason: req.body.reason || '批量限制',
            days: req.body.days,
            operator: req.user.openid,
          });
          done.push({ _id: String(user._id), name, result: `已限制（${info.scope}）` });
        } else if (action === 'unban') {
          const { lifted } = await accountAdmin.unbanUser(user, { scope: req.body.scope, operator: req.user.openid });
          done.push({ _id: String(user._id), name, result: lifted && lifted.length ? `已解除 ${lifted.length} 项` : '原本无生效限制' });
        } else if (action === 'transfer') {
          if (user.role === 'teacher') throw new ApiError(400, 400, '教师账号不参与班级转移');
          const { grade } = req.body || {};
          // 院校/系部/专业按组织架构校验并解析（含 id 回填）；不存在的值 → 该生失败并说明原因。
          // 按「该生转移前的院校」判定，所以一批里混两个校区也能各自正确处理。
          const patch = resolveTransferTarget(orgSchools, req.body || {}, user.schoolName, user.departmentName);
          if (patch.schoolName !== undefined) user.schoolName = patch.schoolName;
          if (patch.schoolId !== undefined) user.schoolId = patch.schoolId;
          if (patch.departmentName !== undefined) user.departmentName = patch.departmentName;
          if (patch.departmentId !== undefined) user.departmentId = patch.departmentId;
          if (patch.specialty !== undefined) user.specialty = patch.specialty;
          // 年级是 4 位年份，不属于组织架构（由学号前 4 位推导），单独校验格式即可
          if (grade !== undefined) {
            const g = String(grade).trim();
            if (g && !/^\d{4}$/.test(g)) throw new ApiError(400, 400, `年级需为 4 位年份（如 2024），当前「${g}」`);
            user.grade = g;
          }
          // 年级没显式给时用学号前 4 位对齐（与 PUT /:id/profile 同口径），否则班级推导会拿不到年级
          if (grade === undefined) {
            const derived = roster.gradeFromStudentId(user.studentId);
            if (derived) user.grade = derived;
          }
          // 班级按「年级 + 专业」重算：转移了专业/年级却不改班名，会出现「23级机电班挂在大数据专业下」的脏数据
          user.className = roster.classNameFromGradeSpecialty(user.grade, user.specialty, user.className);
          await user.save();
          // 只转院校、但该生原系部在新校区不存在时 → 我们清空了系部归属。
          // 这个副作用**必须报出来**，否则管理员以为只是换了个校区，实际系部已经没了。
          done.push({
            _id: String(user._id),
            name,
            result: `已转移（${user.className || '未分班'}）${patch.transferNote ? ' · ' + patch.transferNote : ''}`,
          });
        } else if (action === 'reset-password') {
          // 批量只做「恢复初始密码」（设置密码需要逐人不同的明文，不适合批处理）
          const msg = await accountAdmin.resetUserPassword(user);
          done.push({ _id: String(user._id), name, result: msg || '已恢复初始密码' });
        } else if (action === 'delete') {
          await accountAdmin.deleteUserCascade(user);
          done.push({ _id: String(user._id), name, result: '已删除' });
        }
      } catch (e) {
        failed.push({ _id: String(user._id), name, reason: e && e.message ? e.message : '操作失败' });
      }
    }
    // 没找到的 id（被删过 / id 非法）也要如实报出来，不能静默吞掉
    const found = new Set(users.map((u) => String(u._id)));
    const missing = ids.filter((x) => !found.has(String(x))).map((x) => String(x));
    ok(res, { action, label: spec.label, done, failed, missing, total: ids.length });
  })
);

// 用户详情（含封禁流水 + 有效权限）
router.get(
  '/:id',
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id)
      // 凭据字段排除口径**必须与列表分支同一份常量**：以前这里是重复的硬编码字符串，
      // 新增凭据字段时只改 CREDENTIAL_FIELDS 就会让详情漏出去（AGENTS.md 红线）
      .select(CREDENTIAL_FIELDS)
      .lean();
    if (!user) throw new ApiError(404, 404, '用户不存在');
    const bans = await BanRecord.find({ userId: user._id }).sort({ createdAt: -1 }).limit(50).lean();
    const openid = user.openid || '';
    const [recentRuns, waterToday, badgeCount, effective, userGoal, devices, wxSession, dorm] = await Promise.all([
      openid ? RunRecord.find({ openid }).sort({ date: -1, createdAt: -1 }).limit(10).select('date steps distance calories durationSeconds source goalAchieved').lean() : Promise.resolve([]),
      openid ? WaterRecord.findOne({ openid, date: dates.todayKey() }).select('total target').lean() : Promise.resolve(null),
      openid ? UserBadge.countDocuments({ openid }) : Promise.resolve(0),
      openid ? (async () => { const u = await User.findById(user._id); return u ? await u.getEffectivePermissions() : []; })() : Promise.resolve([]),
      openid ? require('../../models/user-goal').findOne({ openid }).lean() : Promise.resolve(null),
      LoginDevice.find({ userId: user._id }).sort({ lastUsedAt: -1 }).limit(5).select('label lastUsedAt expiresAt revoked createdAt').lean(),
      openid ? WxSession.findOne({ openid }).select('updatedAt').lean() : Promise.resolve(null),
      // 当前宿舍（在读详情直接用，省一次请求）：教师 / 未绑微信 / 未在住 → null
      user.role === 'teacher' ? Promise.resolve(null) : studentDorm.currentDorm(openid),
    ]);
    const lastLogin = devices.reduce((acc, d) => {
      const t = d.lastUsedAt || d.createdAt;
      return t && (!acc || t > acc) ? t : acc;
    }, null);
    const loginInfo = {
      // 绑定状态：openid 只脱敏展示
      wechatBound: !!openid,
      wechatOpenidMasked: openid ? `${openid.slice(0, 2)}***${openid.slice(-4)}` : '',
      wechatBoundAt: user.openidBoundAt || null,
      lastLogin,
      lastWxSessionAt: wxSession ? wxSession.updatedAt : null,
      lastSyncAt: user.lastSyncAt || null,
      devices,
    };
    const sport = {
      totalSteps: user.totalSteps || 0,
      totalDistance: user.totalDistance || 0,
      totalDays: user.totalDays || 0,
      recentRuns: recentRuns.map((r) => ({
        ...r,
        distanceKm: ((r.distance || 0) / 1000).toFixed(2),
      })),
      waterToday: waterToday || { total: 0, target: 0 },
      badgeCount,
    };
    const goalInfo = userGoal
      ? { planName: userGoal.planName || '', daily: userGoal.daily || null, weekly: userGoal.weekly || null, autoMatched: userGoal.autoMatched }
      : null;
    // 学生会身份（用户详情页要显示）：成员记录是独立集合，按 openid 查在任记录。
    // 这里只读、不改；改成员走管理端「学生会成员」或用户端成员管理。
    const unionInfo = await presentUnionInfo(user.openid || '', user._id);
    // 班主任对本班学生的管理权（用户 2026-10-22）：管理端只读详情也要把这个能力告诉前端，
    // 否则「有 user.view 的班主任」进详情页看不到任何按钮（它走的是管理端这条读路径）。
    // 判定口径与班级域写接口完全同一份：services/student-scope.js。
    const targetDoc = await User.findById(user._id);
    const canManageStudent = targetDoc ? await studentScope.canManageStudent(req.user, targetDoc) : false;
    ok(res, {
      user,
      bans,
      sport,
      goal: goalInfo,
      loginInfo,
      // 当前宿舍（dorm_assignments 在住记录）：{ roomText, roomId, bedNo, status }；
      // null = 未分配 / 未绑微信 / 教师 —— 省掉详情页为了显示一行宿舍再多打一次请求
      dorm,
      union: unionInfo,
      effectivePermissions: effective,
      // 当前生效的限制（限制登录 / 限制微信同步 / 限制 GPS）
      restrictions: anticheat.activeRestrictions(user),
      canManageStudent,
    });
  })
);

// 用户全景运动数据：日/周记录窗口 + 综合达标率 + 饮水历史 + 徽章记录 + 生效目标
router.get(
  '/:id/sport-detail',
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id).select('openid').lean();
    if (!user) throw new ApiError(404, 404, '用户不存在');
    const openid = user.openid || '';
    const pointsConfig = await pointsSvc.loadEffective();
    const empty = { rates: null, earnedCount: 0, goal: null, points: { total: 0, today: 0, week: 0, config: pointsSvc.publicConfig(pointsConfig) } };
    if (!openid) return ok(res, empty);

    const goalsSvc = require('../../services/goals');
    const goal = await goalsSvc.getEffectiveGoal(openid);
    const dailyGoal = (goal && goal.daily && goal.daily.steps) || 0;
    const weeklyGoal = (goal && goal.weekly && goal.weekly.steps) || 0;

    // 跑分窗口：今日 / 本周（周一起）/ 全历史（公式与口径见 services/points.js 文件头注释）
    const { today, weekStart } = pointsSvc.currentWindows();
    const [pointsToday, pointsWeek, pointsTotal] = await Promise.all([
      pointsSvc.sumPointsByDay(openid, { from: today, to: today, config: pointsConfig }),
      pointsSvc.sumPointsByDay(openid, { from: weekStart, to: today, config: pointsConfig }),
      pointsSvc.sumPointsTotal(openid, { config: pointsConfig }),
    ]);

    // 全历史按日聚合（一次查询同时供达标率计算与展示窗口切分）
    const dayAgg = await RunRecord.aggregate([
      { $match: { openid } },
      {
        $group: {
          _id: '$date',
          steps: { $sum: '$steps' },
          distance: { $sum: '$distance' },
          calories: { $sum: '$calories' },
          durationSeconds: { $sum: '$durationSeconds' },
          recordCount: { $sum: 1 },
          // 达标时该日多条 werun 记录都被置 true：取 max 再配合步数判定，按天去重不重复计
          werunAchieved: { $max: { $cond: [{ $eq: ['$source', 'werun'] }, '$goalAchieved', false] } },
        },
      },
    ]);
    const dayRows = dayAgg
      .map((d) => ({ ...d, date: d._id, achieved: !!d.werunAchieved || (dailyGoal > 0 && d.steps >= dailyGoal) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    // 周归并（周一起始，与用户端 /weeks 同口径）
    const weekBounds = (dateKey) => {
      const d = new Date(`${dateKey}T00:00:00`);
      const diff = (d.getDay() + 6) % 7; // 周一=0
      const start = new Date(d.getTime());
      start.setDate(d.getDate() - diff);
      const end = new Date(start.getTime());
      end.setDate(start.getDate() + 6);
      return { start: dates.toDateKey(start), end: dates.toDateKey(end) };
    };
    const weekMap = new Map();
    for (const d of dayRows) {
      const wk = weekBounds(d.date);
      let w = weekMap.get(wk.start);
      if (!w) {
        w = { weekStart: wk.start, weekEnd: wk.end, steps: 0, distance: 0, activeDays: 0 };
        weekMap.set(wk.start, w);
      }
      w.steps += d.steps;
      w.distance += d.distance;
      w.activeDays += 1;
    }
    const weekRows = [...weekMap.values()]
      .map((w) => ({ ...w, achieved: weeklyGoal > 0 && w.steps >= weeklyGoal }))
      .sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));

    const achievedDays = dayRows.filter((d) => d.achieved).length;
    const achievedWeeks = weekRows.filter((w) => w.achieved).length;
    const rates = {
      dailyRate: dayRows.length ? Math.round((achievedDays / dayRows.length) * 100) : null,
      dailyAchieved: achievedDays,
      dailyTotal: dayRows.length,
      weeklyRate: weekRows.length ? Math.round((achievedWeeks / weekRows.length) * 100) : null,
      weeklyAchieved: achievedWeeks,
      weeklyTotal: weekRows.length,
    };

    // 明细列表（日/周/饮水/徽章）改由 GET /:id/records 分页提供，这里只回达标率、徽章数与目标，
    // 避免详情接口每次把全量明细拉给前端
    const earnedCount = await UserBadge.countDocuments({ openid });

    ok(res, {
      rates,
      earnedCount,
      goal: { planName: (goal && goal.planName) || '', daily: goal && goal.daily, weekly: goal && goal.weekly },
      // 跑分汇总（学校衡量标准）：total 全历史 / today 今日 / week 本周（周一起）
      points: {
        total: pointsTotal.total || 0,
        today: pointsToday.total || 0,
        week: pointsWeek.total || 0,
        todaySteps: pointsToday.steps || 0,
        weekSteps: pointsWeek.steps || 0,
        date: today,
        weekStart,
        config: pointsSvc.publicConfig(pointsConfig),
      },
    });
  })
);

// 用户运动明细（分页）：type=runs 最近运动 / daily 日记录 / weekly 周记录 / water 饮水 / badges 徽章
// 与详情接口同一套口径，但只取当前页，避免「一次加载全部」
router.get(
  '/:id/records',
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id).select('openid').lean();
    if (!user) throw new ApiError(404, 404, '用户不存在');
    const openid = user.openid || '';
    const type = ['runs', 'daily', 'weekly', 'water', 'badges'].indexOf(req.query.type) >= 0 ? req.query.type : 'runs';
    const { page, limit, skip } = parsePagination(req.query, { page: 1, limit: 20 });
    if (!openid) return ok(res, { type, list: [], total: 0, page, limit, hasMore: false });

    const goalsSvc = require('../../services/goals');
    const goal = await goalsSvc.getEffectiveGoal(openid);
    const dailyGoal = (goal && goal.daily && goal.daily.steps) || 0;
    const weeklyGoal = (goal && goal.weekly && goal.weekly.steps) || 0;
    // 跑分配置（日/周记录每条都要附跑分，公式见 services/points.js 文件头注释）
    const pointsConfig = await pointsSvc.loadEffective();

    // ===== 最近运动：单条记录直接分页 =====
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

    // ===== 日记录：按日聚合后分页（Mongo 侧 skip/limit，不再拉全量到 Node） =====
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
      const rows = await RunRecord.aggregate([
        { $match: { openid } },
        groupStage,
        { $sort: { _id: -1 } },
        { $skip: skip },
        { $limit: limit },
      ]);
      const from = rows.length ? rows[rows.length - 1]._id : '';
      const to = rows.length ? rows[0]._id : '';
      const [countAgg, pointsByDay] = await Promise.all([
        RunRecord.aggregate([{ $match: { openid } }, groupStage, { $count: 'n' }]),
        // 跑分只算当前页的日期区间（不拉全历史）
        from ? pointsSvc.sumPointsByDay(openid, { from, to, config: pointsConfig }) : Promise.resolve({ byDay: [] }),
      ]);
      const pointsMap = new Map((pointsByDay.byDay || []).map((p) => [p.date, p.points]));
      const list = rows.map((d) => ({
        date: d._id,
        steps: d.steps,
        distanceKm: ((d.distance || 0) / 1000).toFixed(2),
        recordCount: d.recordCount,
        achieved: !!d.werunAchieved || (dailyGoal > 0 && d.steps >= dailyGoal),
        goalSteps: dailyGoal,
        points: pointsMap.get(d._id) || 0,
      }));
      const total = countAgg[0]?.n || 0;
      return ok(res, { type, list, total, page, limit, hasMore: skip + list.length < total });
    }

    // ===== 周记录：Mongo 侧按 ISO 周分组（周一起始），再分页；周起止在 Node 侧算出 =====
    if (type === 'weekly') {
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
      const rows = await RunRecord.aggregate([
        { $match: { openid } },
        weekStage,
        { $sort: { '_id.y': -1, '_id.w': -1 } },
        { $skip: skip },
        { $limit: limit },
      ]);
      // 该页覆盖的日期区间（首尾周的起止），跑分只算这个区间
      const firstRange = rows.length ? isoWeekRange(rows[0]._id.y, rows[0]._id.w) : null;
      const lastRange = rows.length ? isoWeekRange(rows[rows.length - 1]._id.y, rows[rows.length - 1]._id.w) : null;
      const [countAgg, weekPoints] = await Promise.all([
        RunRecord.aggregate([{ $match: { openid } }, weekStage, { $count: 'n' }]),
        // 每 ISO 周的跑分（周目标基础分 + 超出加分，不叠加该周日跑分）
        firstRange
          ? pointsSvc.sumPointsByWeek(openid, { from: lastRange.start, to: firstRange.end, config: pointsConfig })
          : Promise.resolve([]),
      ]);
      const pointsMap = new Map(weekPoints.map((w) => [w.weekStart, w.points]));
      const list = rows.map((r) => {
        const range = isoWeekRange(r._id.y, r._id.w);
        return {
          weekStart: range.start,
          weekEnd: range.end,
          steps: r.steps,
          distance: r.distance,
          activeDays: r.activeDays,
          achieved: weeklyGoal > 0 && r.steps >= weeklyGoal,
          goalSteps: weeklyGoal,
          points: pointsMap.get(range.start) || 0,
        };
      });
      const total = countAgg[0]?.n || 0;
      return ok(res, { type, list, total, page, limit, hasMore: skip + list.length < total });
    }

    // ===== 饮水 =====
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

    // ===== 徽章（按获得时间倒序分页） =====
    const [allBadges, earned] = await Promise.all([
      Badge.find({ enabled: true }).sort({ sort: 1 }).lean(),
      UserBadge.find({ openid }).lean(),
    ]);
    const byKey = new Map(earned.map((b) => [b.badgeKey, b]));
    const badges = allBadges
      .filter((b) => byKey.has(b.key))
      .map((b) => {
        const row = byKey.get(b.key);
        return {
          key: b.key,
          name: b.name,
          icon: b.icon,
          tierColor: b.tierColor,
          earnedAt: row.createdAt,
          // 展示用：本行记录时的等级（存量已由 scripts/backfill-badge-level.js 回填）+ 阶梯组，
          // 等级徽章在管理端也带上「达标里程 · Lv2」这类上下文，避免同名组看不出级别
          level: Number(row.level) || 0,
          tierGroup: b.tierGroup || '',
          tierLevel: Number(b.tierLevel) || 0,
          mode: b.mode || '',
        };
      })
      .sort((a, b) => new Date(b.earnedAt) - new Date(a.earnedAt));
    const list = badges.slice(skip, skip + limit);
    ok(res, { type, list, total: badges.length, page, limit, hasMore: skip + list.length < badges.length });
  })
);

// ISO 周（周一为一周起始）→ { start, end } 日历键
function isoWeekRange(isoYear, isoWeek) {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7; // 周一=0
  const week1Monday = new Date(jan4.getTime() - jan4Dow * 86400000);
  const start = new Date(week1Monday.getTime() + (isoWeek - 1) * 7 * 86400000);
  const end = new Date(start.getTime() + 6 * 86400000);
  const key = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { start: key(start), end: key(end) };
}

// 某条运动记录详情（管理端视角：可看任意用户的记录）
// 用户端 /api/run/detail/:id 只按「当前登录用户」查，管理员点别人的记录会 404「记录不存在」
router.get(
  '/:id/runs/:runId',
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.runId)) throw new ApiError(404, 404, '记录不存在');
    const user = await User.findById(req.params.id).select('openid realName nickname account').lean();
    if (!user) throw new ApiError(404, 404, '用户不存在');
    const record = await RunRecord.findOne({ _id: req.params.runId, openid: user.openid }).lean();
    if (!record) throw new ApiError(404, 404, '记录不存在');
    ok(res, {
      ...record,
      ownerName: user.realName || user.nickname || user.account || '',
    });
  })
);

// 用户某一「日 / 周」的运动明细：type=day&date=YYYY-MM-DD 或 type=week&weekStart=YYYY-MM-DD(周一)
// 返回汇总（步数/距离/时长/记录数）、达标判定、周视图按天拆分、以及每条记录
router.get(
  '/:id/period',
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id).select('openid').lean();
    if (!user) throw new ApiError(404, 404, '用户不存在');
    const openid = user.openid || '';
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
      return ok(res, { type, from, to, summary: { steps: 0, distance: 0, calories: 0, durationSeconds: 0, recordCount: 0 }, records: [], days: [], goalSteps: 0, achieved: false });
    }

    const goalsSvc = require('../../services/goals');
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
    const goalSteps = (type === 'week' ? goal && goal.weekly && goal.weekly.steps : goal && goal.daily && goal.daily.steps) || 0;
    const achieved = goalSteps > 0 && summary.steps >= goalSteps;

    // 按天拆分（周视图用；日视图就一天），达标按「日目标」判定
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
    // 跑分：该时段跑分（周取周跑分，日取当日跑分）+ 按天拆分的日跑分
    const [dayPointsRes, weekPointsRes] = await Promise.all([
      pointsSvc.sumPointsByDay(openid, { from, to }),
      type === 'week' ? pointsSvc.sumPointsByWeek(openid, { from, to }) : Promise.resolve([]),
    ]);
    const dayPointsMap = new Map((dayPointsRes.byDay || []).map((p) => [p.date, p.points]));
    const days = [...dayMap.values()]
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .map((d) => ({ ...d, achieved: dayGoal > 0 && d.steps >= dayGoal, points: dayPointsMap.get(d.date) || 0 }));

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
      // 该时段跑分：周 = 周目标基础分 + 超出加分（不叠加日跑分）；日 = 当日跑分
      points: type === 'week' ? (weekPointsRes[0] && weekPointsRes[0].points) || 0 : dayPointsRes.total || 0,
      dayPointsTotal: dayPointsRes.total || 0,
    });
  })
);

// 解绑微信（需 user.manage）：清绑定字段 + 微信会话 + 记住我设备令牌；运动等业务数据保留
// 实现见 services/user-account-admin.js::unbindWechat（班级域「班主任对本班学生解绑」共用同一份）
router.post(
  '/:id/unbind-wechat',
  requirePermission('user.manage'),
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw new ApiError(404, 404, '用户不存在');
    await accountAdmin.unbindWechat(user);
    ok(res, { success: true });
  })
);

// 限制/封禁（需 user.manage）
// body: { scope: 'login' | 'sync' | 'gps', reason, days }（days<=0 视为永久）
// 实现见 services/user-account-admin.js::banUser（班级域「班主任限制本班学生功能」共用）
router.post(
  '/:id/ban',
  requirePermission('user.manage'),
  wrap(async (req, res) => {
    const { reason, days, scope } = req.body || {};
    const user = await User.findById(req.params.id);
    if (!user) throw new ApiError(404, 404, '用户不存在');
    const info = await accountAdmin.banUser(user, { scope, reason, days, operator: req.user.openid });
    ok(res, { success: true, scope: info.scope, until: info.until, restrictions: info.restrictions });
  })
);

// 解除限制（需 user.manage）
// body: { scope: 'login' | 'sync' | 'gps' | 'all' }（默认全部解除）
router.post(
  '/:id/unban',
  requirePermission('user.manage'),
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw new ApiError(404, 404, '用户不存在');
    const r = await accountAdmin.unbanUser(user, { scope: req.body?.scope, operator: req.user.openid });
    ok(res, { success: true, lifted: r.lifted, restrictions: r.restrictions });
  })
);

module.exports = router;
