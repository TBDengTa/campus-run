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
router.post(
  '/login',
  wrap(async (req, res) => {
    const { code } = req.body || {};
    if (!code) throw new ApiError(400, 400, '缺少 code');
    const session = await wechat.code2session(code);
    const { openid, session_key: sessionKey, unionid } = session;

    let user = await User.findOne({ openid });
    const isNew = !user;
    if (!user) {
      user = await User.create({ openid, unionid: unionid || '' });
      // 引导管理员
      if (config.adminBootstrapOpenids.includes(openid)) {
        user.role = 'admin';
        await user.save();
      }
    } else if (config.adminBootstrapOpenids.includes(openid) && user.role !== 'admin') {
      user.role = 'admin';
      await user.save();
    }

    await WxSession.updateOne({ openid }, { $set: { sessionKey } }, { upsert: true });

    ok(res, {
      token: signToken(user),
      isNew,
      userInfo: user.toSafeJSON(),
    });
  })
);

// 当前用户信息
router.get(
  '/me',
  auth,
  wrap(async (req, res) => {
    const monitor = await ClassMonitor.findOne({ openid: req.user.openid }).lean();
    const data = req.user.toSafeJSON();
    data.isClassMonitor = !!monitor;
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
    // 学号/姓名/班级变更时可同步班长表
    if ($set.studentId && req.user.role === 'user') {
      const monitor = await ClassMonitor.findOne({ openid: req.user.openid });
      if (monitor) $set.role = req.user.role;
    }
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
