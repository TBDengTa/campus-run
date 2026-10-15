const crypto = require('crypto');
const express = require('express');
const { wrap, ok, ApiError, parsePagination } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const anticheat = require('../../services/anticheat');
const pwd = require('../../services/password');
const roster = require('../../services/roster');
const pointsSvc = require('../../services/points');
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

// 重置密码（需 permission.manage）：恢复为初始密码（学号/身份证后8），无初始数据则生成随机码
router.post(
  '/:id/reset-password',
  requirePermission('permission.manage'),
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw new ApiError(404, 404, '用户不存在');

    let message;
    const resetHashes = user.resetHashes || [];
    if (resetHashes.length) {
      // 恢复为名单初始密码，并同步恢复可用的 initialHashes（下次改密用旧密码验证）
      user.passwordHash = resetHashes[0];
      user.initialHashes = [...resetHashes];
      message = '已重置为初始密码（证件/学号后8位）';
    } else {
      const randomPwd = crypto.randomBytes(4).toString('hex');
      user.passwordHash = pwd.hashPassword(randomPwd);
      user.initialHashes = [pwd.hashPassword(randomPwd)];
      user.resetHashes = [pwd.hashPassword(randomPwd)];
      message = `该账号无名单初始密码数据，已生成随机密码：${randomPwd}`;
    }
    user.mustChangePassword = true;
    user.failedLogins = 0;
    user.lockUntil = null;
    await user.save();
    ok(res, { success: true, message });
  })
);


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
    if ((user.permissionGroups || []).includes('superadmin')) throw new ApiError(400, 400, '超级管理员不可删除');
    const openid = user.openid;
    const oid = user.openid;
    const byOpenid = oid
      ? [
          RunRecord.deleteMany({ openid: oid }),
          WaterRecord.deleteMany({ openid: oid }),
          UserBadge.deleteMany({ openid: oid }),
          UserGoal.deleteMany({ openid: oid }),
          require('../../models/body-data').deleteMany({ openid: oid }),
          require('../../models/reward-video-record').deleteMany({ openid: oid }),
          require('../../models/wx-session').deleteMany({ openid: oid }),
          Appeal.deleteMany({ openid: oid }),
        ]
      : [];
    await Promise.all([...byOpenid, BanRecord.deleteMany({ userId: user._id })]);
    await deviceSvc.revokeAllForUser(user._id); // 吊销「记住我」设备令牌（原实现漏删）
    await user.deleteOne();
    ok(res, { success: true, deleted: user.account || user.nickname });
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
router.put(
  '/:id/class-roles',
  requirePermission('user.manage'),
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw new ApiError(404, 404, '用户不存在');
    const { homeroomClasses, isClassOfficer } = req.body || {};

    if (homeroomClasses !== undefined) {
      if (user.role !== 'teacher') throw new ApiError(400, 400, '只有教师账号可以设置为班主任');
      if (!Array.isArray(homeroomClasses)) throw new ApiError(400, 400, 'homeroomClasses 需为数组');
      const classes = [...new Set(homeroomClasses.map((c) => String(c || '').trim()).filter(Boolean))];
      if (classes.length > 20) throw new ApiError(400, 400, '一个班主任最多分配 20 个班级');
      const tooLong = classes.find((c) => c.length > 40);
      if (tooLong) throw new ApiError(400, 400, `班级名过长：${tooLong.slice(0, 20)}…`);
      user.homeroomClasses = classes;
    }

    if (isClassOfficer !== undefined) {
      if (user.role !== 'student') throw new ApiError(400, 400, '只有学生账号可以设为班委');
      if (isClassOfficer && !user.className) {
        throw new ApiError(400, 400, '该学生尚未识别出班级（年级 + 专业），无法设为班委');
      }
      user.isClassOfficer = !!isClassOfficer;
    }

    await user.save();
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

// 筛选可选项（院校/系部/专业/年级/班级）
// 日/周目标不再返回目标步数：它们是「当日/当周是否达标」，选项由前端固定（已达标/未达标）
// classes：班主任分配班级时的候选（在用的班级名，按「年级+专业」推导后的值），不新增班级列表接口
// classMeta：每个班级的年级/院系/系部（班主任班级多选抽屉要按这三层筛选，班名里没有院系/系部），
//            与 classes 一一对应、同序，不改动原有字段
router.get(
  '/filters',
  requirePermission('user.view'),
  wrap(async (req, res) => {
    const [schools, departments, specialties, studentIds, gradeValues, classes, classMeta] = await Promise.all([
      User.distinct('schoolName', { schoolName: { $nin: [null, ''] } }),
      User.distinct('departmentName', { departmentName: { $nin: [null, ''] } }),
      User.distinct('specialty', { specialty: { $nin: [null, ''] } }),
      User.distinct('studentId', { studentId: { $exists: true, $nin: [null, ''] } }),
      User.distinct('grade', { grade: { $exists: true, $nin: [null, ''] } }),
      User.distinct('className', { className: { $nin: [null, ''] }, role: { $ne: 'teacher' } }),
      buildClassMeta(),
    ]);
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
    });
  })
);

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

// 用户列表/搜索 + 多维筛选（院校/系部/专业/年级/日周达标）
router.get(
  '/',
  wrap(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const cond = {};
    const and = []; // 与 keyword 的 $or 并存的条件（不能互相覆盖）
    if (req.query.keyword) {
      const kw = req.query.keyword.trim();
      const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      cond.$or = [{ nickname: re }, { realName: re }, { studentId: re }, { openid: kw }, { className: re }];
    }
    if (req.query.status) cond.status = req.query.status;
    if (req.query.role) cond.role = req.query.role;
    // 管理员不是角色而是权限：直接权限或所在权限组非空即视为管理员（与登录态 isManager 同义）
    if (req.query.manager === '1') {
      and.push({
        $or: [{ permissions: { $exists: true, $ne: [] } }, { permissionGroups: { $exists: true, $ne: [] } }],
      });
    }
    if (req.query.school) cond.schoolName = req.query.school;
    if (req.query.department) cond.departmentName = req.query.department;
    if (req.query.specialty) cond.specialty = req.query.specialty;
    if (req.query.grade) {
      // 年级 = 学号前 4 位（入学年份）；兼容 grade 字段与「2024级xx班」的班级命名
      const g = String(req.query.grade).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      and.push({ $or: [{ grade: g }, { studentId: new RegExp('^' + g) }, { className: new RegExp('^' + g + '级') }] });
    }
    if (and.length) cond.$and = and;

    // 日/周目标筛选 = 「当日 / 当周是否达标」（按用户生效目标：个人计划 > 全局默认）
    // dailyAchieved/weeklyAchieved: '1' 已达标 / '0' 未达标
    const pick = (v) => (['0', '1'].includes(String(v ?? '')) ? String(v) : '');
    const dailyAchieved = pick(req.query.dailyAchieved);
    const weeklyAchieved = pick(req.query.weeklyAchieved);
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
        // 清掉聚合中间字段，响应结构与普通列表一致
        { $project: { g: 0, todayAgg: 0, weekAgg: 0, todaySteps: 0, weekSteps: 0, dailyTarget: 0, weeklyTarget: 0 } },
      ];
      const [list, countAgg] = await Promise.all([
        // 排序必须带唯一的 _id 兜底：createdAt 在名单批量导入时大量同值，
        // 只按它排序的话 skip 翻页两次查询各排各的，第 2 页会重复第 1 页的人
        User.aggregate([...basePipeline, { $sort: { createdAt: -1, _id: -1 } }, { $skip: skip }, { $limit: limit }]),
        User.aggregate([...basePipeline, { $count: 'n' }]),
      ]);
      return ok(res, { list: await attachGoals(list), total: countAgg[0]?.n || 0, page, limit });
    }

    const [list, total] = await Promise.all([
      User.find(cond).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).select('-__v').lean(),
      User.countDocuments(cond),
    ]);
    ok(res, { list: await attachGoals(list), total, page, limit });
  })
);

// 用户详情（含封禁流水 + 有效权限）
router.get(
  '/:id',
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id)
      .select('-__v -passwordHash -initialHashes -resetHashes -failedLogins -lockUntil')
      .lean();
    if (!user) throw new ApiError(404, 404, '用户不存在');
    const bans = await BanRecord.find({ userId: user._id }).sort({ createdAt: -1 }).limit(50).lean();
    const openid = user.openid || '';
    const [recentRuns, waterToday, badgeCount, effective, userGoal, devices, wxSession] = await Promise.all([
      openid ? RunRecord.find({ openid }).sort({ date: -1, createdAt: -1 }).limit(10).select('date steps distance calories durationSeconds source goalAchieved').lean() : Promise.resolve([]),
      openid ? WaterRecord.findOne({ openid, date: dates.todayKey() }).select('total target').lean() : Promise.resolve(null),
      openid ? UserBadge.countDocuments({ openid }) : Promise.resolve(0),
      openid ? (async () => { const u = await User.findById(user._id); return u ? await u.getEffectivePermissions() : []; })() : Promise.resolve([]),
      openid ? require('../../models/user-goal').findOne({ openid }).lean() : Promise.resolve(null),
      LoginDevice.find({ userId: user._id }).sort({ lastUsedAt: -1 }).limit(5).select('label lastUsedAt expiresAt revoked createdAt').lean(),
      openid ? WxSession.findOne({ openid }).select('updatedAt').lean() : Promise.resolve(null),
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
    ok(res, {
      user,
      bans,
      sport,
      goal: goalInfo,
      loginInfo,
      effectivePermissions: effective,
      // 当前生效的限制（限制登录 / 限制微信同步 / 限制 GPS）
      restrictions: anticheat.activeRestrictions(user),
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
    if (!require('mongoose').isValidObjectId(req.params.runId)) throw new ApiError(404, 404, '记录不存在');
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
router.post(
  '/:id/unbind-wechat',
  requirePermission('user.manage'),
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw new ApiError(404, 404, '用户不存在');
    if (!user.openid) throw new ApiError(400, 400, '该账号未绑定微信');
    const openid = user.openid;
    await User.updateOne({ _id: user._id }, { $unset: { openid: 1, openidBoundAt: 1 } });
    await WxSession.deleteMany({ openid });
    await deviceSvc.revokeAllForUser(user._id);
    ok(res, { success: true });
  })
);

// 限制/封禁（需 user.manage）
// body: { scope: 'login' | 'sync' | 'gps', reason, days }（days<=0 视为永久）
router.post(
  '/:id/ban',
  requirePermission('user.manage'),
  wrap(async (req, res) => {
    const { reason, days, scope } = req.body || {};
    const user = await User.findById(req.params.id);
    if (!user) throw new ApiError(404, 404, '用户不存在');
    if ((user.permissionGroups || []).includes('superadmin') || (user.permissions || []).includes('*')) {
      throw new ApiError(400, 400, '不能封禁超级管理员');
    }
    const finalScope = anticheat.SCOPES.includes(scope) ? scope : 'login';
    const info = await anticheat.manualBan(user, {
      scope: finalScope,
      reason,
      days: Number(days) || 0,
      operator: req.user.openid,
    });
    ok(res, { success: true, scope: info.scope, until: info.until, restrictions: anticheat.activeRestrictions(user) });
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
    const scope = ['login', 'sync', 'gps'].includes(req.body?.scope) ? req.body.scope : 'all';
    const { lifted } = await anticheat.manualUnban(user, req.user.openid, scope);
    ok(res, { success: true, lifted, restrictions: anticheat.activeRestrictions(user) });
  })
);

module.exports = router;
