const crypto = require('crypto');
const express = require('express');
const { wrap, ok, ApiError, parsePagination } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const anticheat = require('../../services/anticheat');
const pwd = require('../../services/password');
const roster = require('../../services/roster');
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
const Appeal = require('../../models/appeal');

const router = express.Router();

// 导入学生名单（需 user.import）：body { rows: [...] } 或 { payload: 'CSV/JSON 文本' }
router.post(
  '/import',
  requirePermission('user.import'),
  wrap(async (req, res) => {
    const mode = req.body?.mode === 'update' ? 'update' : 'create';
    const rows = roster.parseRows(req.body?.rows || req.body?.payload);
    if (!rows.length) throw new ApiError(400, 400, mode === 'update' ? '未解析到数据（表头：学号,性别,出生日期）' : '未解析到数据（表头：学号,姓名,院校,系部,专业,班级,性别,出生日期）');
    const result = await roster.importRows(rows, mode);
    ok(res, result);
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

// 筛选可选项（院校/系部/专业/年级）
// 日/周目标不再返回目标步数：它们是「当日/当周是否达标」，选项由前端固定（已达标/未达标）
router.get(
  '/filters',
  requirePermission('user.view'),
  wrap(async (req, res) => {
    const [schools, departments, specialties, studentIds, gradeValues] = await Promise.all([
      User.distinct('schoolName', { schoolName: { $nin: [null, ''] } }),
      User.distinct('departmentName', { departmentName: { $nin: [null, ''] } }),
      User.distinct('specialty', { specialty: { $nin: [null, ''] } }),
      User.distinct('studentId', { studentId: { $exists: true, $nin: [null, ''] } }),
      User.distinct('grade', { grade: { $exists: true, $nin: [null, ''] } }),
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
    ok(res, { schools, departments, specialties, grades });
  })
);

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
        User.aggregate([...basePipeline, { $sort: { createdAt: -1 } }, { $skip: skip }, { $limit: limit }]),
        User.aggregate([...basePipeline, { $count: 'n' }]),
      ]);
      return ok(res, { list, total: countAgg[0]?.n || 0, page, limit });
    }

    const [list, total] = await Promise.all([
      User.find(cond).sort({ createdAt: -1 }).skip(skip).limit(limit).select('-__v').lean(),
      User.countDocuments(cond),
    ]);
    ok(res, { list, total, page, limit });
  })
);

// 用户详情（含封禁流水 + 有效权限）
router.get(
  '/:id',
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id).select('-__v').lean();
    if (!user) throw new ApiError(404, 404, '用户不存在');
    const bans = await BanRecord.find({ userId: user._id }).sort({ createdAt: -1 }).limit(50).lean();
    const openid = user.openid || '';
    const [recentRuns, waterToday, badgeCount, effective, userGoal] = await Promise.all([
      openid ? RunRecord.find({ openid }).sort({ date: -1, createdAt: -1 }).limit(10).select('date steps distance calories durationSeconds source goalAchieved').lean() : Promise.resolve([]),
      openid ? WaterRecord.findOne({ openid, date: require('../../utils/dates').todayKey() }).select('total target').lean() : Promise.resolve(null),
      openid ? UserBadge.countDocuments({ openid }) : Promise.resolve(0),
      openid ? (async () => { const User = require('../../models/user'); const u = await User.findById(user._id); return u ? await u.getEffectivePermissions() : []; })() : Promise.resolve([]),
      openid ? require('../../models/user-goal').findOne({ openid }).lean() : Promise.resolve(null),
    ]);
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
    ok(res, { user, bans, sport, goal: goalInfo, effectivePermissions: effective });
  })
);

// 封禁（需 user.manage）
router.post(
  '/:id/ban',
  requirePermission('user.manage'),
  wrap(async (req, res) => {
    const { reason, days } = req.body || {};
    const user = await User.findById(req.params.id);
    if (!user) throw new ApiError(404, 404, '用户不存在');
    if ((user.permissionGroups || []).includes('superadmin') || (user.permissions || []).includes('*')) {
      throw new ApiError(400, 400, '不能封禁超级管理员');
    }
    await anticheat.manualBan(user, {
      reason,
      days: Number(days) || 0,
      operator: req.user.openid,
    });
    ok(res, { success: true });
  })
);

// 解封（需 user.manage）
router.post(
  '/:id/unban',
  requirePermission('user.manage'),
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw new ApiError(404, 404, '用户不存在');
    await anticheat.manualUnban(user, req.user.openid);
    ok(res, { success: true });
  })
);

module.exports = router;
