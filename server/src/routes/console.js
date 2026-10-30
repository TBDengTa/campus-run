/**
 * Web 控制台（/console）· 后端 API。
 *
 * 用户 2026-10-29：「就直接 / 路径为登录页面，进入后是状态台与AI训练台的B端页面」。
 *
 * ===== 与小程序 API 的关系（刻意隔离） =====
 * · 小程序：微信 openid → JWT（Authorization 头），身份根是「哪个微信」
 * · 控制台：姓名 + 密码 → 内存会话 sid（HttpOnly Cookie），身份根是「谁知道密码」
 * 两套凭证互不通用：/console/api/* 只认 Cookie，/api/* 只认 JWT。
 * 理由见 services/console-session.js 文件头（XSS 偷到的浏览器凭证不该能调小程序接口）。
 *
 * ===== 登录门槛（用户选「权限 + 必须已改密码」） =====
 * 三道门，缺一不可：
 *  ① 姓名 + 密码校验通过（复用 services/password，与小程序同一套 scrypt 口径）；
 *  ② 有效权限里含任一 anticheat.*（或 '*'）—— 只有反作弊相关角色能进；
 *  ③ **提交的密码不能是本人的初始密码**（initialHashes / resetHashes 命中即拒）。
 * 第 ③ 条是这次设计里最关键的一条：
 * 学生初始密码 = 学号后 8 位、教师初始密码 = 123456（见 user-account-admin.js）。
 * 这两个值**不是秘密** —— 学号在名单里、123456 写在文档里。
 * 只校「密码对不对 + 有没有权限」等于把控制台门牌写成「知道学号就能进」，
 * 而控制台能标注、能封号、能改 AI 阈值。所以必须要求本人先在小程序里改过密码。
 * 注意判定方式是「拿提交的明文去比 initialHashes」，不是读 mustChangePassword 布尔：
 * 后者在管理员重置密码时会改写（admin 一键重置成 123456 就又把门开了），
 * 用真实密码比对不受那个字段影响。
 *
 * ===== 限流 =====
 * 按「账号」与「IP」两个维度分开计（services/console-session），
 * 且**绝不写 user.failedLogins** —— 否则攻击者在浏览器里试密码会顺手把学生的
 * 小程序登录也锁死（用管理端入口把学生锁在门外）。
 */
const express = require('express');
const { wrap, ok, ApiError } = require('../utils/response');
const User = require('../models/user');
const pwd = require('../services/password');
// 教师初始密码常量（123456）：唯一来源在 user-account-admin，这里引用而不是复制，
// 否则那边改了默认值、这边闸门还按老值放人。
const { TEACHER_INITIAL_PASSWORD } = require('../services/user-account-admin');
const session = require('../services/console-session');
const StepAnomaly = require('../models/step-anomaly');
const StepLabel = require('../models/step-label');
const BanRecord = require('../models/ban-record');
const disposal = require('../services/anomaly-disposal');
const acConfig = require('../services/anticheat-config');

const router = express.Router();

// 能进控制台的权限（任一即可）。'*' = 超级管理员。
const CONSOLE_PERMS = ['anticheat.view', 'anticheat.label', 'anticheat.manage', 'anticheat.ban'];

// 本文件是「浏览器直连的 JSON 接口」，错误也要回 JSON（页面按 code 分支处理）
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  // 控制台没有跨站合法调用方（页面同源），一律锁死同源 + 禁嗅探
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

const hasPerm = (perms, need) =>
  Array.isArray(perms) && (perms.includes('*') || perms.includes(need));

/**
 * 逐项能力表（**唯一定义**，/login 与 /me 共用）。
 *
 * 为什么要提成模块级：登录响应与 /me 各写一份时必然漂移 ——
 * 早前登录响应根本没给 caps，页面把 login 的返回值直接当 me 用，
 * caps 恒为 undefined → 前端退回 {view:false} → **超级管理员（'*'）也被判「没有任何查看权限」**。
 * 能力只在这里算一次，两个出口都读它。
 */
const capsOf = (perms) => ({
  view: hasPerm(perms, 'anticheat.view'),
  label: hasPerm(perms, 'anticheat.label'),
  manage: hasPerm(perms, 'anticheat.manage'),
  ban: hasPerm(perms, 'anticheat.ban'),
});

/** 会话守卫：没登录 401；权限不足 403。挂在每个需要身份的接口上。 */
function requireConsole(...needs) {
  return (req, res, next) => {
    const sid = session.readCookie(req.headers.cookie, session.COOKIE_NAME);
    const s = session.get(sid);
    if (!s) return next(new ApiError(401, 401, '登录已过期，请重新登录'));
    if (needs.length && !needs.some((p) => hasPerm(s.perms, p))) {
      return next(new ApiError(403, 403002, '没有该操作的权限'));
    }
    req.console = s;
    next();
  };
}

// ============================ 登录 / 登出 ============================

/**
 * 登录页的运行自检（**无需登录**，但只给运行指标，绝不给反作弊参数）。
 *
 * 为什么根路径还要保留这个：旧版 `/` 是「后端状态页」，运维靠它一眼确认
 * 「进程活着没 / 数据库连上没 / 部署的是哪个构建」。这些是部署自检信息，
 * 不含任何可被利用的业务参数，继续公开是安全的。
 *
 * ⚠️ 这里**不返回**待研判数量、AI 判定阈值、封禁统计：
 *   根路径现在对公网开放，「刷到多少分会被封 / 现在有多少人在被研判」
 *   告诉任何访问者等于教人怎么绕过硬禁。这些数字走需要登录的 /dashboard。
 */
router.get(
  '/public-status',
  wrap(async (req, res) => {
    const mongoose = require('mongoose');
    const dbReady = mongoose.connection && mongoose.connection.readyState === 1;
    const upSec = Math.floor(process.uptime());
    const d = Math.floor(upSec / 86400);
    const h = Math.floor((upSec % 86400) / 3600);
    const m = Math.floor((upSec % 3600) / 60);
    const parts = [];
    if (d) parts.push(`${d} 天`);
    if (h) parts.push(`${h} 小时`);
    if (m) parts.push(`${m} 分`);
    parts.push(`${upSec % 60} 秒`);
    const fmt = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
    const costMs = req.__t0 ? Number(process.hrtime.bigint() - req.__t0) / 1e6 : 0;
    ok(res, {
      apiOk: dbReady,
      dbReady: !!dbReady,
      version: req.app.get('consoleVersion') || '',
      bootText: fmt(Date.now() - Math.floor(process.uptime() * 1000)),
      upText: parts.join(' '),
      costText: costMs < 10 ? costMs.toFixed(1) : String(Math.round(costMs)),
    });
  })
);

router.post(
  '/login',
  wrap(async (req, res) => {
    const account = String((req.body || {}).account || '').trim();
    const password = String((req.body || {}).password || '');
    if (!account || !password) throw new ApiError(400, 400, '请输入姓名和密码');

    // 限流在**查库之前**：否则每 一次尝试都要跑一次 scrypt（~35ms），
    // 撞库成本低得离谱 —— 先卡次数再算哈希。
    const ipKey = `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    const accKey = `acc:${account}`;
    const gate = session.checkThrottle(accKey, ipKey);
    if (gate.blocked) {
      throw new ApiError(
        429,
        429,
        `失败次数过多，请 ${gate.retryMinutes} 分钟后再试（服务端限流，与学生账号的小程序登录无关）`
      );
    }

    // 同名账号可能存在多个（学生与教师可以同名，见 routes/auth.js 的处理）：
    // 控制台按「能用密码 + 有反作弊权限」的那个登，不静默挑第一个
    // —— 否则同名学生可能被当成教师身份登进来。
    const rows = await User.find({ account });
    const matched = [];
    for (const u of rows) {
      const hitPwd = pwd.verifyPassword(password, u.passwordHash) || pwd.matchesAnyInitial(password, u.initialHashes);
      if (!hitPwd) continue;
      matched.push(u);
    }

    if (!matched.length) {
      session.recordFailure(accKey, ipKey);
      // 文案与小程序一致，不暴露「这个姓名存不存在」
      throw new ApiError(400, 400, '账号或密码不正确');
    }

    // ② 权限门槛：候选里筛出能进控制台的
    const allowed = [];
    for (const u of matched) {
      const perms = await u.getEffectivePermissions();
      if (CONSOLE_PERMS.some((p) => hasPerm(perms, p))) allowed.push({ user: u, perms });
    }
    if (!allowed.length) {
      // 密码对但没权限：也计入失败（不告诉攻击者「这个密码是对的」），
      // 文案必须说得清「为什么有密码还进不去」，否则真人会以为是 bug。
      session.recordFailure(accKey, ipKey);
      throw new ApiError(403, 403002, '该账号没有反作弊控制台权限（需要 anticheat.* 权限组）');
    }
    if (allowed.length > 1) {
      // 多个同名且有权限、密码还一样 —— 绝不猜，让人补学号
      throw new ApiError(400, 400902, '存在多个同名且有权限的账号，请用「姓名+学号」区分（当前不支持，请联系管理员核对）');
    }

    const { user, perms } = allowed[0];

    // ③ 初始密码闸门（本文件头详解）：提交口令命中本人任一初始密码 → 拒绝
    // ⚠️ 裸常量 TEACHER_INITIAL_PASSWORD（来自 user-account-admin），**不是** pwd.TEACHER_INITIAL_PASSWORD：
    //    password.js 没有这个导出，写成 pwd.xxx 会得到 undefined，
    //    于是「等于 123456 就拒」这条永远不成立 —— 语法合法、检查器扫不出、静默失效。
    const isInitial =
      pwd.matchesAnyInitial(password, user.initialHashes) ||
      pwd.matchesAnyInitial(password, user.resetHashes) ||
      password === TEACHER_INITIAL_PASSWORD ||
      (!!user.studentId && password === pwd.last8(user.studentId));
    if (isInitial) {
      session.recordFailure(accKey, ipKey);
      throw new ApiError(
        403,
        403006,
        '当前仍是初始密码（教师 123456 / 学生学号后 8 位），不能登录控制台。请先在小程序「我的 → 修改密码」改成自己的密码。'
      );
    }

    // 被限制登录的账号不能进控制台（与小程序同一口径：status=banned 即拒绝）
    if (user.status === 'banned') {
      throw new ApiError(403, 403003, '该账号已被限制登录');
    }

    const sid = session.create(user, perms);
    session.clearFailure(accKey, ipKey);
    res.set('Set-Cookie', session.cookieFor(sid, { secure: req.secure }));
    ok(res, {
      account: user.account || user.realName || '',
      name: user.realName || user.account || '',
      role: user.role,
      perms: CONSOLE_PERMS.filter((p) => hasPerm(perms, p)),
      // caps 与 /me 同源同口径（同一份模块级 capsOf）：登录响应早前没有这个字段，
      // 页面直接拿登录返回值当 me 用 → caps undefined → 超级管理员也被判「无权限」。
      // 现在两处都给，前端无论用哪个都不会错。
      caps: capsOf(perms),
    });
  })
);

router.post(
  '/logout',
  wrap(async (req, res) => {
    const sid = session.readCookie(req.headers.cookie, session.COOKIE_NAME);
    session.destroy(sid);
    res.set('Set-Cookie', session.clearCookie({ secure: req.secure }));
    ok(res, { loggedOut: true });
  })
);

// 当前身份与能力：页面据此渲染导航与按钮（服务端仍是最终闸门）
router.get(
  '/me',
  requireConsole(),
  wrap(async (req, res) => {
    const s = req.console;
    ok(res, {
      account: s.account,
      role: s.role,
      // 逐项能力：前端只读这份画按钮（与小程序 capabilities 同一思路）
      // 与 /login 共用一个 capsOf —— 两份实现必然漂移
      caps: capsOf(s.perms),
      since: new Date(s.createdAt).toISOString(),
    });
  })
);

// ============================ 状态台 ============================
router.get(
  '/dashboard',
  requireConsole('anticheat.view'),
  wrap(async (req, res) => {
    const acModel = require('../services/anticheat-model');
    const now = new Date();

    // ---- 模型：只读缓存，绝不触发训练 ----
    // 状态台默认每 30 秒自动刷新，一次训练要 2~3 秒（GPS 曾实测 30 秒），
    // 放进渲染路径会把页面拖垮（/model-status 超时那次的教训）。
    const peek = (source) => {
      const m = acModel.peekModel(source);
      if (!m) acModel.getModel(source).catch(() => {}); // 后台静默预热
      return {
        ready: !!m,
        rows: (m && m.rows) || 0,
        trees: m && m.forest ? m.forest.length : 0,
        trainedAt: m && m.trainedAt ? new Date(m.trainedAt).toISOString() : null,
      };
    };
    const th = acModel.currentThreshold();

    // ---- 队列与统计 ----
    const [openCount, bannedToday, unlabeledToday, recentBans, activeRestricted] = await Promise.all([
      StepAnomaly.countDocuments({ status: 'open' }),
      StepAnomaly.countDocuments({ status: 'banned', handledAt: { $gte: new Date(now.getTime() - 86400000) } }),
      StepAnomaly.countDocuments({ status: 'open', label: null, createdAt: { $gte: new Date(now.getTime() - 86400000) } }),
      BanRecord.find({ action: 'ban' }).sort({ createdAt: -1 }).limit(10).lean(),
      // 当前仍在限制中的人数（status=banned 未到期）
      User.countDocuments({ status: 'banned' }),
    ]);

    // 待研判队列按 来源 × 标注 分布（与小程序管理端同一口径，前端直接渲染矩阵）
    const matrixRows = await StepAnomaly.aggregate([
      { $match: { status: 'open' } },
      { $group: { _id: { source: '$source', label: '$label' }, n: { $sum: 1 } } },
    ]);
    const matrix = {
      werun: { unlabeled: 0, cheat: 0, minor: 0, device: 0, normal: 0 },
      gps: { unlabeled: 0, cheat: 0, minor: 0, device: 0, normal: 0 },
    };
    for (const r of matrixRows) {
      const src = r._id && r._id.source === 'gps' ? 'gps' : 'werun';
      const key = r._id && r._id.label == null ? 'unlabeled' : r._id.label;
      if (matrix[src][key] != null) matrix[src][key] += r.n;
    }

    const upgrade = await acModel.checkUpgradeReadiness(false);

    // 运行指标：登录页那份 public-status 只有「够部署自检」的量，
    // 这里（已登录）才给累计请求数、内存等运维细节。
    const opsFn = req.app.get('consoleOps');
    const opsSnapshot = typeof opsFn === 'function' ? opsFn() : {};
    const upSec = Math.floor(process.uptime());
    const upParts = [];
    if (Math.floor(upSec / 86400)) upParts.push(`${Math.floor(upSec / 86400)} 天`);
    if (Math.floor((upSec % 86400) / 3600)) upParts.push(`${Math.floor((upSec % 86400) / 3600)} 小时`);
    if (Math.floor((upSec % 3600) / 60)) upParts.push(`${Math.floor((upSec % 3600) / 60)} 分`);
    upParts.push(`${upSec % 60} 秒`);
    const fmtTs = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');

    ok(res, {
      models: { werun: peek('werun'), gps: peek('gps') },
      threshold: {
        suspicious: Number(th.suspicious),
        autoBan: Number(th.autoBan),
        suspiciousText: Number(th.suspicious).toFixed(2),
        autoBanText: Number(th.autoBan).toFixed(2),
      },
      queue: { open: openCount, bannedToday, unlabeledToday, matrix },
      activeRestricted,
      upgrade,
      recentBans: recentBans.map((b) => ({
        at: b.createdAt,
        scope: b.banType || 'login',
        reason: b.reason || '',
        days: b.durationDays || 0,
        operator: b.operator || 'system',
      })),
      labelText: StepLabel.LABEL_TEXT,
      labelKinds: StepLabel.LABEL_KINDS,
      online: session.onlineCount(),
      serverTime: now.toISOString(),
      // 运行指标（登录后才给：累计请求、启动时间、内存）
      ops: {
        served: Number(opsSnapshot.served) || 0,
        bootText: opsSnapshot.bootAt ? fmtTs(opsSnapshot.bootAt) : '—',
        upText: upParts.join(' '),
        rssMb: Number(opsSnapshot.rssMb) || 0,
        dbReady: !!(require('mongoose').connection && require('mongoose').connection.readyState === 1),
      },
    });
  })
);

// ============================ AI 标注台 ============================
// 列表（与 /api/admin/step-anomalies 同一口径：来源×状态×标注三维筛选）
router.get(
  '/anomalies',
  requireConsole('anticheat.view'),
  wrap(async (req, res) => {
    const status = String(req.query.status || 'open');
    const filter = {};
    if (status !== 'all') filter.status = status;
    if (req.query.date) filter.date = String(req.query.date);
    if (req.query.source && req.query.source !== 'all') filter.source = String(req.query.source);

    const labelQ = String(req.query.label || '');
    if (labelQ === 'unlabeled') filter.label = null;
    else if (StepLabel.LABEL_KINDS.includes(labelQ)) filter.label = labelQ;

    if (req.query.keyword) {
      const kw = String(req.query.keyword).trim();
      const isNoise = /^(undefined|null|NaN)$/i.test(kw);
      if (kw && !isNoise) {
        const safe = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [
          { realName: new RegExp(safe, 'i') },
          { studentId: new RegExp(safe, 'i') },
          { className: new RegExp(safe, 'i') },
        ];
      }
    }

    const limit = Math.min(Number(req.query.limit) || 30, 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    const [total, rows] = await Promise.all([
      StepAnomaly.countDocuments(filter),
      StepAnomaly.find(filter).sort({ score: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);

    ok(res, {
      page,
      limit,
      total,
      hasMore: skip + rows.length < total,
      labelText: StepLabel.LABEL_TEXT,
      labelKinds: StepLabel.LABEL_KINDS,
      list: rows.map((r) => ({
        id: String(r._id),
        realName: r.realName || '未命名',
        className: r.className || '',
        studentId: r.studentId || '',
        date: r.date || '',
        source: r.source || 'werun',
        sourceText: r.source === 'gps' ? 'GPS 实跑' : '微信同步',
        cumulativeSteps: r.cumulativeSteps || 0,
        deltaSteps: r.deltaSteps || 0,
        score: r.score || 0,
        modelScore: r.modelScore == null ? null : Number(r.modelScore),
        reasons: r.reasons || [],
        status: r.status,
        autoBanned: !!r.autoBanned,
        label: r.label || null,
        labelText: r.label ? StepLabel.LABEL_TEXT[r.label] : '未标注',
        labeledBy: r.labeledBy || '',
        labeledAt: r.labeledAt || null,
        handleNote: r.handleNote || '',
      })),
    });
  })
);

// 标注（四分类，可改判）
router.post(
  '/anomalies/:id/label',
  requireConsole('anticheat.label'),
  wrap(async (req, res) => {
    ok(
      res,
      await disposal.labelAnomaly(req.params.id, String((req.body || {}).label || ''), {
        note: (req.body || {}).note,
        operator: req.console.account || 'console',
      })
    );
  })
);

// 封禁（需 anticheat.ban —— 与标注分开）
router.post(
  '/anomalies/:id/ban',
  requireConsole('anticheat.ban'),
  wrap(async (req, res) => {
    ok(
      res,
      await disposal.banAnomaly(req.params.id, {
        days: (req.body || {}).days,
        note: (req.body || {}).note,
        operator: req.console.account || 'console',
      })
    );
  })
);

// 排除（= 标注 normal + 移出队列）
router.post(
  '/anomalies/:id/dismiss',
  requireConsole('anticheat.label'),
  wrap(async (req, res) => {
    ok(
      res,
      await disposal.dismissAnomaly(req.params.id, {
        note: (req.body || {}).note,
        operator: req.console.account || 'console',
      })
    );
  })
);

// 模型配置与生效阈值（读 anticheat.view，改需 anticheat.manage）
router.get(
  '/model-status',
  requireConsole('anticheat.view'),
  wrap(async (req, res) => {
    const acModel = require('../services/anticheat-model');
    const GoalConfig = require('../models/goal-config');
    const cfg = await GoalConfig.getSingleton();
    const ac = cfg.anticheat || {};
    ok(res, {
      enabled: ac.enabled !== false,
      aiStrictness: ac.aiStrictness || 'balanced',
      aiSuspiciousThreshold: ac.aiSuspiciousThreshold == null ? null : Number(ac.aiSuspiciousThreshold),
      aiAutoBanThreshold: ac.aiAutoBanThreshold == null ? null : Number(ac.aiAutoBanThreshold),
      maxStepJumpPerSync: ac.maxStepJumpPerSync,
      minPaceSecondsPerKm: ac.minPaceSecondsPerKm,
      banDays: ac.banDays,
      // 档位基线（页面预览用）与实际生效值（含在线校准）分开返回，
      // 别让管理员拿预览当绝对真值 —— 校准会在基线 ±0.06 内浮动。
      effective: acModel.currentThreshold(),
      strictnessOptions: acModel.STRICTNESS_PRESETS || null,
    });
  })
);

// 改 AI 配置（严谨度档位 / 自动封禁开关）—— 独立权限，且**留审计流水**
router.put(
  '/model-config',
  requireConsole('anticheat.manage'),
  wrap(async (req, res) => {
    const GoalConfig = require('../models/goal-config');
    const acModel = require('../services/anticheat-model');
    const body = req.body || {};
    const cfg = await GoalConfig.getSingleton();

    // 只接受反作弊相关字段：其余（跑分/楼名）归管理端 config 页，控制台不越界
    const { changed, anticheat } = acConfig.applyAnticheatInput(cfg, body);
    if (!Object.keys(changed).length) throw new ApiError(400, 400, '没有要修改的字段');

    await cfg.save();
    // 阈值有 30s 进程内缓存：不清就是「改完没生效」，管理员只能等半分钟或重启。
    // 清完立刻预热一次，让随后的 GET /model-status 读到的就是新档位。
    acModel.clearThresholdCache();
    await acModel.warmThreshold().catch(() => {});

    // 审计：谁把 AI 调成了什么 —— 反作弊配置变更必须可追责
    console.log(`[console] ${req.console.account} 修改反作弊配置: ${JSON.stringify(changed)}`);
    ok(res, { changed, anticheat, effective: acModel.currentThreshold() });
  })
);

module.exports = router;
