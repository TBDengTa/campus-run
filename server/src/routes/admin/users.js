const crypto = require('crypto');
const express = require('express');
const { wrap, ok, ApiError, parsePagination } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const anticheat = require('../../services/anticheat');
const pwd = require('../../services/password');
const roster = require('../../services/roster');
const BanRecord = require('../../models/ban-record');
const User = require('../../models/user');
const PermissionGroup = require('../../models/permission-group');
const Permission = require('../../models/permission');

const router = express.Router();

// 导入学生名单（需 user.import）：body { rows: [...] } 或 { payload: 'CSV/JSON 文本' }
router.post(
  '/import',
  requirePermission('user.import'),
  wrap(async (req, res) => {
    const rows = roster.parseRows(req.body?.rows || req.body?.payload);
    if (!rows.length) throw new ApiError(400, 400, '未解析到数据（支持 JSON 数组或 CSV，表头：姓名,学号,身份证号,学校,院系,班级,专业）');
    const result = await roster.importRows(rows);
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

// 用户列表/搜索
router.get(
  '/',
  wrap(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const cond = {};
    if (req.query.keyword) {
      const kw = req.query.keyword.trim();
      const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      cond.$or = [{ nickname: re }, { realName: re }, { studentId: re }, { openid: kw }, { className: re }];
    }
    if (req.query.status) cond.status = req.query.status;
    if (req.query.role) cond.role = req.query.role;
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
    ok(res, { user, bans });
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
