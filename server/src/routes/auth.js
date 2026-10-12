const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { wrap, ok, ApiError } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const User = require('../models/user');
const WxSession = require('../models/wx-session');
const ClassMonitor = require('../models/class-monitor');
const wechat = require('../services/wechat');

const router = express.Router();

function signToken(user) {
  return jwt.sign({ uid: user._id, openid: user.openid, role: user.role }, config.jwtSecret, {
    expiresIn: `${config.jwtExpireDays}d`,
  });
}

// 登录：code 换 openid，新用户自动注册
// DEV_LOGIN=true 时支持约定 code：dev-student / dev-teacher / dev-admin（本地测试，不调微信接口）
router.post(
  '/login',
  wrap(async (req, res) => {
    const { code } = req.body || {};
    if (!code) throw new ApiError(400, 400, '缺少 code');

    let openid;
    let sessionKey = '';
    if (config.devLogin && /^dev-(student|teacher|admin)$/.test(code)) {
      openid = `dev_${code.replace('dev-', '')}_1`;
      // 预置昵称便于区分测试账号
    } else {
      const session = await wechat.code2session(code);
      openid = session.openid;
      sessionKey = session.session_key;
    }

    let user = await User.findOne({ openid });
    const isNew = !user;
    const isDevLogin = openid.startsWith('dev_');
    if (!user) {
      const devNicknames = {
        dev_student_1: '测试学生',
        dev_teacher_1: '测试教师',
        dev_admin_1: '测试管理员',
      };
      user = await User.create({
        openid,
        role: isDevLogin && openid !== 'dev_student_1' ? 'teacher' : 'student',
        nickname: devNicknames[openid] || '',
        studentId: undefined, // 留空以避开 studentId 唯一稀疏索引的空串冲突
      });
    }
    let changed = false;
    // dev 登录：强制重置为约定角色/权限组，保证切换测试视角可预期
    if (isDevLogin) {
      const preset = {
        dev_admin_1: { role: 'teacher', groups: ['superadmin'] },
        dev_teacher_1: { role: 'teacher', groups: ['teacher'] },
        dev_student_1: { role: 'student', groups: [] },
      }[openid];
      const groupsJson = JSON.stringify(preset.groups);
      if (user.role !== preset.role || JSON.stringify(user.permissionGroups || []) !== groupsJson) {
        user.role = preset.role;
        user.permissionGroups = preset.groups;
        changed = true;
      }
    }
    // 引导管理员（env 配置）→ 超级管理员权限组
    if (config.adminBootstrapOpenids.includes(openid) && !user.permissionGroups.includes('superadmin')) {
      user.permissionGroups.push('superadmin');
      if (user.role !== 'teacher') user.role = 'teacher';
      changed = true;
    }
    if (changed) await user.save();

    if (sessionKey) {
      await WxSession.updateOne({ openid }, { $set: { sessionKey } }, { upsert: true });
    }

    const effective = await user.getEffectivePermissions();
    ok(res, {
      token: signToken(user),
      isNew,
      userInfo: { ...user.toSafeJSON(), effectivePermissions: effective, isManager: effective.length > 0 },
    });
  })
);

// 当前用户信息（含有效权限）
router.get(
  '/me',
  auth,
  wrap(async (req, res) => {
    const monitor = await ClassMonitor.findOne({ openid: req.user.openid }).lean();
    const effective = await req.user.getEffectivePermissions();
    const data = {
      ...req.user.toSafeJSON(),
      effectivePermissions: effective,
      isManager: effective.length > 0,
      isClassMonitor: !!monitor,
    };
    ok(res, data);
  })
);

// 更新资料
router.put(
  '/profile',
  auth,
  wrap(async (req, res) => {
    const allowed = ['nickname', 'avatarUrl', 'realName', 'studentId', 'className', 'specialty', 'gender', 'birthdate'];
    const $set = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) $set[k] = req.body[k];
    }
    if ($set.gender !== undefined) $set.gender = Number($set.gender) || 0;
    if ($set.birthdate) $set.birthdate = new Date($set.birthdate);
    Object.assign(req.user, $set);
    await req.user.save();
    ok(res, req.user.toSafeJSON());
  })
);

// 绑定学校/院系（组织架构）
router.put(
  '/school',
  auth,
  wrap(async (req, res) => {
    const { schoolId, departmentId, className } = req.body || {};
    const Organization = require('../models/organization');
    const $set = {};
    if (schoolId) {
      const school = await Organization.findById(schoolId);
      if (!school) throw new ApiError(400, 400, '学校不存在');
      $set.schoolId = school._id;
      $set.schoolName = school.name;
    }
    if (departmentId) {
      const dept = await Organization.findById(departmentId);
      if (!dept) throw new ApiError(400, 400, '院系不存在');
      $set.departmentId = dept._id;
      $set.departmentName = dept.name;
    }
    if (className !== undefined) $set.className = className;
    Object.assign(req.user, $set);
    await req.user.save();
    ok(res, req.user.toSafeJSON());
  })
);

module.exports = router;
