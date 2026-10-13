const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { wrap, ok, ApiError } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const User = require('../models/user');
const WxSession = require('../models/wx-session');
const ClassMonitor = require('../models/class-monitor');
const wechat = require('../services/wechat');
const pwd = require('../services/password');
const deviceSvc = require('../services/login-device');

const router = express.Router();

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

function signToken(user) {
  return jwt.sign({ uid: user._id, openid: user.openid, role: user.role }, config.jwtSecret, {
    expiresIn: `${config.jwtExpireDays}d`,
  });
}

function signGuest(openid) {
  return jwt.sign({ openid, guest: true }, config.jwtSecret, { expiresIn: '2h' });
}

// 登录第一步：wx.login code 换会话
// - openid 已绑定账号 → 正式 token（bound: true）
// - openid 未绑定 → 游客 token（bound: false），需走 /bind 完成姓名密码登录+绑定
router.post(
  '/login',
  wrap(async (req, res) => {
    const { code } = req.body || {};
    if (!code) throw new ApiError(400, 400, '缺少 code');

    let openid;
    let sessionKey = '';
    if (config.devLogin && /^dev-(student|teacher|admin|new|new2|new3)$/.test(code)) {
      // dev-new / dev-new2 / dev-new3：未绑定微信的测试号（用于走姓名密码绑定流程）
      if (/^dev-new\d?$/.test(code)) {
        openid = `dev_wechat_${code.replace('dev-', '')}`;
      } else {
        openid = `dev_${code.replace('dev-', '')}_1`;
      }
    } else {
      const session = await wechat.code2session(code);
      openid = session.openid;
      sessionKey = session.session_key;
    }

    if (sessionKey) {
      await WxSession.updateOne({ openid }, { $set: { sessionKey } }, { upsert: true });
    }

    const user = await User.findOne({ openid });
    if (user) {
      let changed = false;
      // dev 登录：强制重置为约定角色/权限组，保证切换测试视角可预期
      if (config.devLogin && openid.startsWith('dev_')) {
        const preset = {
          dev_admin_1: { role: 'teacher', groups: ['superadmin'] },
          dev_teacher_1: { role: 'teacher', groups: ['teacher'] },
          dev_student_1: { role: 'student', groups: [] },
        }[openid];
        if (preset && (user.role !== preset.role || JSON.stringify(user.permissionGroups || []) !== JSON.stringify(preset.groups))) {
          user.role = preset.role;
          user.permissionGroups = preset.groups;
          changed = true;
        }
      }
      // 引导管理员（env 配置）→ 超级管理员权限组
      if (config.adminBootstrapOpenids.includes(openid) && !(user.permissionGroups || []).includes('superadmin')) {
        user.permissionGroups = [...(user.permissionGroups || []), 'superadmin'];
        if (user.role !== 'teacher') user.role = 'teacher';
        changed = true;
      }
      if (changed) await user.save();

      const effective = await user.getEffectivePermissions();
      return ok(res, {
        token: signToken(user),
        // 设备令牌：客户端存本地，用于「历史登录一键登录」
        deviceToken: await deviceSvc.issue(user, req),
        bound: true,
        mustChangePassword: !!user.mustChangePassword,
        isNew: false,
        userInfo: { ...user.toSafeJSON(), effectivePermissions: effective, isManager: effective.length > 0 },
      });
    }

    // 未绑定 → 游客 token
    ok(res, { token: signGuest(openid), bound: false });
  })
);

// 登录第二步：姓名 + 密码 绑定/登录（游客 token）
// 规则：账号未被绑定 → 绑定当前微信；已被其他微信绑定 → 拒绝；不可解绑
router.post(
  '/bind',
  auth,
  wrap(async (req, res) => {
    const { account, password } = req.body || {};
    if (!req.guestOpenid) throw new ApiError(403, 403003, '请先通过微信登录');
    if (!account || !password) throw new ApiError(400, 400, '请输入姓名和密码');

    const now = new Date();
    const candidates = await User.find({ account: String(account).trim() });
    if (!candidates.length) throw new ApiError(400, 400, '账号或密码不正确');

    const locked = candidates.find((u) => u.lockUntil && u.lockUntil > now);
    if (locked) {
      throw new ApiError(429, 429, `失败次数过多，账号已锁定，请 ${Math.ceil((locked.lockUntil - now) / 60000)} 分钟后再试`);
    }

    // 在同名候选中按密码匹配
    const matched = candidates.filter(
      (u) => pwd.verifyPassword(password, u.passwordHash) || pwd.matchesAnyInitial(password, u.initialHashes)
    );
    if (!matched.length) {
      for (const u of candidates) {
        u.failedLogins = (u.failedLogins || 0) + 1;
        if (u.failedLogins >= MAX_FAILED) {
          u.lockUntil = new Date(now.getTime() + LOCK_MINUTES * 60000);
          u.failedLogins = 0;
        }
        await u.save();
      }
      throw new ApiError(400, 400, '账号或密码不正确');
    }

    const user = matched[0];
    // 绑定校验：一个账号只认第一个绑定的微信
    if (user.openid && user.openid !== req.guestOpenid) {
      throw new ApiError(403, 403004, '该账号已绑定其他微信，禁止登录。如为本人操作，请联系管理员处理');
    }

    user.openid = req.guestOpenid;
    user.openidBoundAt = user.openidBoundAt || now;
    user.failedLogins = 0;
    user.lockUntil = null;
    if (!user.account) user.account = String(account).trim();
    if (!user.realName) user.realName = user.account;
    await user.save();

    const effective = await user.getEffectivePermissions();
    ok(res, {
      token: signToken(user),
      deviceToken: await deviceSvc.issue(user, req),
      bound: true,
      mustChangePassword: !!user.mustChangePassword,
      isNew: false,
      userInfo: { ...user.toSafeJSON(), effectivePermissions: effective, isManager: effective.length > 0 },
    });
  })
);

// 修改密码：验证旧密码（或初始密码）→ 设置新密码、清初始哈希、解除强制改密
router.post(
  '/password/change',
  auth,
  wrap(async (req, res) => {
    if (req.guestOpenid) throw new ApiError(403, 403003, '请先绑定账号');
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) throw new ApiError(400, 400, '请填写旧密码和新密码');
    const invalid = pwd.validateNewPassword(newPassword);
    if (invalid) throw new ApiError(400, 400, invalid);
    if (oldPassword === newPassword) throw new ApiError(400, 400, '新密码不能与旧密码相同');

    const user = await User.findById(req.user._id);
    const oldOk = pwd.verifyPassword(oldPassword, user.passwordHash) || pwd.matchesAnyInitial(oldPassword, user.initialHashes);
    if (!oldOk) throw new ApiError(400, 400, '旧密码不正确');

    user.passwordHash = pwd.hashPassword(newPassword);
    user.initialHashes = [];
    user.mustChangePassword = false;
    user.failedLogins = 0;
    user.lockUntil = null;
    await user.save();
    ok(res, { success: true });
  })
);

// 隐私设置（排行榜展示）
router.put(
  '/privacy',
  auth,
  wrap(async (req, res) => {
    if (req.guestOpenid) throw new ApiError(403, 403003, '请先绑定账号');
    const allowed = ['hideClass', 'hideName', 'hidePlan', 'exitRanking'];
    for (const k of allowed) {
      if (req.body[k] !== undefined) req.user.privacy[k] = !!req.body[k];
    }
    await req.user.save();
    ok(res, req.user.privacy);
  })
);

// 当前用户信息（含有效权限）
router.get(
  '/me',
  auth,
  wrap(async (req, res) => {
    if (req.guestOpenid) throw new ApiError(403, 403003, '请先绑定账号');
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

// 设备令牌一键登录：本地历史登录记录里存的 deviceToken 直接换取正式 token
// 规则：令牌随机 32 字节、只存哈希、30 天有效、可撤销；每次使用后轮换（旧的立即失效）
router.post(
  '/device-login',
  wrap(async (req, res) => {
    const { deviceToken } = req.body || {};
    if (!deviceToken) throw new ApiError(400, 400, '缺少 deviceToken');

    const doc = await deviceSvc.verify(deviceToken);
    if (!doc) throw new ApiError(401, 401001, '该登录记录已失效，请重新输入姓名和密码登录');

    const user = await User.findById(doc.userId);
    if (!user) throw new ApiError(401, 401001, '账号不存在，请重新登录');

    // 轮换：立即撤销旧令牌并下发新令牌（客户端需覆盖本地历史记录）
    await deviceSvc.revoke(deviceToken);
    const newDeviceToken = await deviceSvc.issue(user, req);

    const effective = await user.getEffectivePermissions();
    ok(res, {
      token: signToken(user),
      deviceToken: newDeviceToken,
      bound: true,
      mustChangePassword: !!user.mustChangePassword,
      userInfo: { ...user.toSafeJSON(), effectivePermissions: effective, isManager: effective.length > 0 },
    });
  })
);

// 撤销设备令牌（用户在登录页删除某条历史登录记录时调用）
router.post(
  '/device-revoke',
  wrap(async (req, res) => {
    const { deviceToken } = req.body || {};
    if (!deviceToken) throw new ApiError(400, 400, '缺少 deviceToken');
    await deviceSvc.revoke(deviceToken);
    ok(res, { revoked: true });
  })
);

// 更新资料
// 注意：学籍信息（姓名/学号/院系/班级/专业/年级）来自学校名单导入，学生不能自行修改
const ENROLLMENT_FIELDS = ['realName', 'studentId', 'schoolName', 'schoolId', 'departmentName', 'departmentId', 'className', 'specialty', 'grade'];

router.put(
  '/profile',
  auth,
  wrap(async (req, res) => {
    if (req.guestOpenid) throw new ApiError(403, 403003, '请先绑定账号');
    const touched = ENROLLMENT_FIELDS.filter((k) => req.body && req.body[k] !== undefined);
    if (touched.length) {
      throw new ApiError(403, 403005, `学籍信息由学校名单同步，不能自行修改（${touched.join('、')}）`);
    }
    const allowed = ['nickname', 'avatarUrl', 'gender', 'birthdate'];
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

// 绑定学校/院系（组织架构）：学生不能改学籍，仅教师/管理员可代为处理
router.put(
  '/school',
  auth,
  wrap(async (req, res) => {
    if (req.guestOpenid) throw new ApiError(403, 403003, '请先绑定账号');
    if (req.user.role === 'student') {
      throw new ApiError(403, 403005, '学籍信息由学校名单同步，学生不能自行修改；如有误请联系管理员');
    }
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
