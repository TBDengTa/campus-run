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
// 学生会身份（只读装饰）：给 userInfo 补 isUnionMember / unionRoles / unionText，
// 供首页「学生会块」与自定义 tabBar 决定导航项。不落库、不建缓存字段，避免换届后客户端读到老身份。
const unionSvc = require('../services/union');

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
    // silent=true：小程序启动时用来「确认我是谁」的静默调用，只要身份，不要再发设备令牌。
    // 为什么要这个开关：启动确认每次都会跑一遍，若无条件签发 deviceToken，
    // login_devices 单用户上限 5 条会被这些静默调用挤满，把真正的「历史登录一键登录」记录挤掉。
    const { code, silent } = req.body || {};
    if (!code) throw new ApiError(400, 400, '缺少 code');

    let openid;
    let sessionKey = '';
    if (config.devLogin && /^dev-(student|teacher|admin|sadmin|new|new2|new3)$/.test(code)) {
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

    // dev 测试账号：不存在则自动创建（角色/权限组按预设），已存在则强制重置为预设
    const DEV_PRESETS = {
      dev_student_1: { role: 'student', groups: [], nickname: '测试学生' },
      dev_teacher_1: { role: 'teacher', groups: ['teacher'], nickname: '测试教师' },
      dev_admin_1: { role: 'teacher', groups: ['superadmin'], nickname: '测试管理员' },
      dev_sadmin_1: { role: 'student', groups: ['superadmin'], nickname: '测试学生管理员' },
    };

    let user = await User.findOne({ openid });
    if (!user && config.devLogin && openid.startsWith('dev_') && DEV_PRESETS[openid]) {
      const p = DEV_PRESETS[openid];
      user = await User.create({
        openid,
        role: p.role,
        permissionGroups: p.groups,
        nickname: p.nickname,
        account: p.nickname,
        realName: p.nickname,
      });
    }

    if (user) {
      let changed = false;
      // dev 登录：强制重置为约定角色/权限组，保证切换测试视角可预期
      if (config.devLogin && openid.startsWith('dev_')) {
        const preset = DEV_PRESETS[openid];
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
        // 设备令牌：客户端存本地，用于「历史登录一键登录」（silent 静默确认时不签发）
        deviceToken: silent ? undefined : await deviceSvc.issue(user, req),
        bound: true,
        mustChangePassword: !!user.mustChangePassword,
        isNew: false,
        userInfo: await unionSvc.decorateUser(user, {
          ...user.toSafeJSON(),
          effectivePermissions: effective,
          isManager: effective.length > 0,
        }),
      });
    }

    // 未绑定 → 游客 token
    ok(res, { token: signGuest(openid), bound: false });
  })
);

// 登录第二步：姓名 + 密码 绑定/登录（游客 token）
// 规则：账号未被绑定 → 绑定当前微信；
//      已被其他微信绑定 → **学生拒绝、教师允许换绑**（见下面的绑定校验，用户 2026-10-22）；
//      不可由用户自己解绑（解绑走管理端 user.manage）。
//
// ⚠️ 同名账号（学生×教师、或两个同名学生）的消歧口径（用户 2026-10-20「学生与教师账号重名」）：
//   姓名唯一性只按「姓名 + 类型」（routes/admin/users.js），所以重名是**允许共存**的，
//   不能改成全局唯一（现实中同名师生大量存在，且存量已有 41 组同名）。
//   因此这里必须做到三件事，否则会串号 / 误锁：
//   ① 失败计数**只计入本次真正针对的那个账号**：旧实现给所有同名候选都 +1，
//      学生输错 5 次会把同名的教师一起锁掉（一个人手滑锁掉另一个人）。
//   ② 多个候选都能匹配密码时**绝不盲选第一个**（旧实现 matched[0] 会静默登进别人的身份）。
//   ③ 有歧义就要求补学号（400902），由前端展开学号输入框精确匹配。
//   代价：同名且未提供学号时不做失败计数（无法确定该惩罚哪个账号），
//   但攻击者要真登录成功仍必须猜中学号，届时该账号照常计数锁定。
const NEED_STUDENT_ID = 400902;

router.post(
  '/bind',
  auth,
  wrap(async (req, res) => {
    const { account, password, studentId } = req.body || {};
    // 当前微信的 openid 有两个来源（用户 2026-10-22「用另一个教师账号登录」）：
    //   · 游客令牌 → req.guestOpenid（正常的「首次绑定」路径）；
    //   · **已登录账号**的令牌 → 它自己的 openid。用途：登录页发现「这个微信已绑刘恩琦，
    //     但我要登陈宇航」，用户可以选「用陈宇航登录」，此时就是把同一个微信换绑到另一个账号。
    //   没有这条，教师换账号只能靠管理员解绑，测试时直接被卡死（截图里那个死胡同弹窗）。
    const openid = req.guestOpenid || (req.user && req.user.openid) || '';
    if (!openid) throw new ApiError(403, 403003, '请先通过微信登录');
    if (!account || !password) throw new ApiError(400, 400, '请输入姓名和密码');

    const now = new Date();
    const all = await User.find({ account: String(account).trim() });
    if (!all.length) throw new ApiError(400, 400, '账号或密码不正确');

    // 学号收窄：给了就按学号精确锁定唯一账号（同名场景的唯一可靠区分依据）
    const sid = String(studentId || '').trim();
    const candidates = sid ? all.filter((u) => String(u.studentId || '') === sid) : all;
    if (!candidates.length) throw new ApiError(400, 400, '账号或密码不正确');
    const ambiguous = candidates.length > 1;

    const lockedRow = (list) => list.find((u) => u.lockUntil && u.lockUntil > now);

    // ⚠️ 锁定判断必须在密码匹配**之后**（按「未被锁的候选」匹配）：
    //   旧实现先对全部候选查 lockUntil 就直接 429，于是「学生张三被锁」会让同名的「教师张三」
    //   也登录不了 —— 别人的失败连累到自己，且报错文案还误导他去猜密码。
    const unlocked = candidates.filter((u) => !(u.lockUntil && u.lockUntil > now));
    const matched = unlocked.filter(
      (u) => pwd.verifyPassword(password, u.passwordHash) || pwd.matchesAnyInitial(password, u.initialHashes)
    );

    if (!matched.length) {
      // 没匹配上时，若有被锁的候选 → 报锁定（无法区分是不是他在试，宁可给出可行动的提示）
      const locked = lockedRow(candidates);
      if (locked) {
        throw new ApiError(429, 429, `失败次数过多，账号已锁定，请 ${Math.ceil((locked.lockUntil - now) / 60000)} 分钟后再试`);
      }
      // 只在「能确定针对哪个账号」时计数：唯一候选，或已按学号收窄到唯一。
      // 同名且未给学号 → 交给下面的 NEED_STUDENT_ID，不惩罚任何一个人。
      if (!ambiguous) {
        for (const u of candidates) {
          u.failedLogins = (u.failedLogins || 0) + 1;
          if (u.failedLogins >= MAX_FAILED) {
            u.lockUntil = new Date(now.getTime() + LOCK_MINUTES * 60000);
            u.failedLogins = 0;
          }
          await u.save();
        }
      }
      if (ambiguous) throw new ApiError(400, NEED_STUDENT_ID, '存在多个同名账号，请输入学号区分');
      throw new ApiError(400, 400, '账号或密码不正确');
    }

    // 多个同名账号密码都能匹配 → 必须让用户补学号，绝不静默挑一个（会登进别人的身份）
    if (matched.length > 1) {
      throw new ApiError(400, NEED_STUDENT_ID, '存在多个同名账号且密码相同，请输入学号区分');
    }

    const user = matched[0];

    // 微信绑定校验。三条规则，按「谁占着这个微信」与「目标账号是什么角色」交叉判定：
    //
    // ① 学生账号**自己已绑的微信不能换**（一个账号只认第一个绑定的微信）——
    //    否则别人可以用自己微信顶掉学生身份、代跑代签。
    // ② 教师账号不限制换绑（用户 2026-10-22「教师账户不限制微信绑定的登录」）：
    //    换手机、换微信、用另一台设备的微信都能登录同一个教师账号，绑定随之更新。
    //    教师不产生运动数据、不参与排名，绑定只是「这台设备是谁」的标记，卡死它只会让
    //    换了微信的老师永远登不进来（实测撞到：解绑后没有管理员在场就进不去）。
    // ③ **这个微信当前绑在谁身上**（openid 唯一索引，一个微信只能登一个账号）：
    //    · 绑在另一个**教师**账号 → 允许顶替换绑（截图里的场景：同一台手机从刘恩琦切到陈宇航；
    //      两个都是教职工账号，不存在冒名学生身份；原账号令牌因 openid 不一致自动失效）；
    //    · 绑在**学生**账号 → 一律拒绝（学生微信不能被任何账号顶掉）。
    //
    // ⚠️ ③ 的判定**不能只在 rebinding 时做**：目标账号自己还没有 openid（rebinding=false）时
    //    也会撞上「这个微信已经属于别人」，旧实现直接赋值 → Mongo 抛 E11000（500），
    //    而且学生账号能借这条路径抢走教师的微信。所以先查占用方，再决定。
    const isTeacherAccount = user.role === 'teacher';
    const rebinding = !!user.openid && user.openid !== openid;
    const holder = await User.findOne({ openid, _id: { $ne: user._id } })
      .select('account realName role')
      .lean();
    const holderName = holder ? holder.account || holder.realName || '其他账号' : '';

    if (holder) {
      if (!isTeacherAccount) {
        const roleText = holder.role === 'teacher' ? '教师' : '学生';
        throw new ApiError(403, 403004, `当前微信已绑定${roleText}账号「${holderName}」，学生账号不能用它登录`);
      }
      if (holder.role !== 'teacher') {
        throw new ApiError(
          403,
          403004,
          `当前微信已绑定学生账号「${holderName}」，学生账号的微信不能被更换`
        );
      }
      // 教师之间换绑：把「这个微信」从原账号摘掉（openid 有唯一索引，必须先解绑再绑）。
      //
      // ⚠️ 这里**不能**调 revokeAllForUser(holder._id)（用户 2026-10-23 报障：
      //    「历史登录支持一键登录……现在虽然不限制绑定微信，但是会出现历史记录失效」）。
      //    原因：设备令牌（login_devices）是**按账号**签发的、与微信无关 ——
      //    原账号在**其它手机 / 其它微信**上的「一键登录」依然完全合法。
      //    一刀切吊销会把那位老师在别的设备上的历史登录记录全部作废，
      //    而客户端 `quickLogin` 一旦失败就会**删掉本地那条记录**，再也回不来。
      //    真正需要失效的只是「刚才这台设备」的 JWT —— 它由 middlewares/auth.js 的
      //    openid 比对自然判 401，随后 /api/auth/login 按当前微信重新认定身份，无需额外处理。
      await User.updateOne({ _id: holder._id }, { $unset: { openid: 1, openidBoundAt: 1 } });
    } else if (rebinding && !isTeacherAccount) {
      // 学生账号自己已经绑了另一个微信 → 不允许换（规则 ①）
      throw new ApiError(403, 403004, '该账号已绑定其他微信，禁止登录。如为本人操作，请联系管理员处理');
    }

    user.openid = openid;
    // 首次绑定记当时时间；教师换绑则更新为「当前微信的绑定时间」（旧绑定已失效）
    user.openidBoundAt = rebinding ? now : user.openidBoundAt || now;
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
      userInfo: await unionSvc.decorateUser(user, {
        ...user.toSafeJSON(),
        effectivePermissions: effective,
        isManager: effective.length > 0,
      }),
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
    const data = await unionSvc.decorateUser(req.user, {
      ...req.user.toSafeJSON(),
      effectivePermissions: effective,
      isManager: effective.length > 0,
      isClassMonitor: !!monitor,
    });
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
