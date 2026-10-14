const crypto = require('crypto');
const express = require('express');
const { wrap, ok, ApiError, parsePagination } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const anticheat = require('../../services/anticheat');
const pwd = require('../../services/password');
const roster = require('../../services/roster');
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
    const mode = req.body?.mode === 'update' ? 'update' : 'create';
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
router.post(
  '/import/preview',
  requirePermission('user.import'),
  importUpload.single('file'),
  wrap(async (req, res) => {
    const rows = req.file ? roster.parseSheet(req.file.buffer) : roster.parseRows(req.body?.payload);
    if (!rows.length) throw new ApiError(400, 400, '未解析到数据（表格需包含列：姓名,学号）');
    const normalized = [];
    const failed = [];
    rows.forEach((row, i) => {
      const item = roster.normalizeRow(row, i);
      if (item.error) failed.push({ row: i + 1, reason: item.error });
      else normalized.push(item);
    });
    ok(res, {
      cacheId: cachePreview(normalized),
      total: rows.length,
      valid: normalized.length,
      failedCount: failed.length,
      failed,
      preview: normalized.slice(0, 20),
    });
  })
);

// 确认导入：按预览返回的 cacheId + mode 写库；confirm 后缓存即删，换模式需重新解析
router.post(
  '/import/confirm',
  requirePermission('user.import'),
  wrap(async (req, res) => {
    const cacheId = String(req.body?.cacheId || '');
    const cached = previewCache.get(cacheId);
    previewCache.delete(cacheId);
    if (!cached || cached.expireAt <= Date.now()) {
      throw new ApiError(410, 410, '预览已过期，请重新选择文件解析');
    }
    if (!cached.rows.length) throw new ApiError(400, 400, '没有可导入的数据（所有行均异常）');
    const mode = req.body?.mode === 'update' ? 'update' : 'create';
    const result = await roster.importRows(cached.rows, mode);
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
    const empty = { rates: null, earnedCount: 0, goal: null };
    if (!openid) return ok(res, empty);

    const goalsSvc = require('../../services/goals');
    const goal = await goalsSvc.getEffectiveGoal(openid);
    const dailyGoal = (goal && goal.daily && goal.daily.steps) || 0;
    const weeklyGoal = (goal && goal.weekly && goal.weekly.steps) || 0;

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
      const [rows, countAgg] = await Promise.all([
        RunRecord.aggregate([{ $match: { openid } }, groupStage, { $sort: { _id: -1 } }, { $skip: skip }, { $limit: limit }]),
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
      .map((b) => ({
        key: b.key,
        name: b.name,
        icon: b.icon,
        tierColor: b.tierColor,
        earnedAt: byKey.get(b.key).createdAt,
      }))
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
