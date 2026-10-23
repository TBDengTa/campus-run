const jwt = require('jsonwebtoken');
const config = require('../config');
const { ApiError } = require('../utils/response');
const User = require('../models/user');
const anticheat = require('../services/anticheat');

// 游客（未绑定账号）可访问的路径前缀
const GUEST_ALLOW = ['^/api/auth/', '^/auth/', '^/bind$'];

// 被封禁（限制登录）的用户仍需能访问的路径：登录态、申诉、公告
const BANNED_ALLOW = ['^/api/auth/', '^/api/appeals', '^/api/users/me$', '^/api/content/'];

// 取「挂载路径 + 路由内路径」的完整路径：
// 这些中间件是挂在各 router 上（router.use(auth)），此时 req.path 是去掉挂载前缀的相对路径，
// 只匹配 req.path 会让白名单全部失效（被封禁用户连申诉接口都进不来）。
function fullPath(req) {
  const base = req.baseUrl || '';
  return `${base}${req.path || ''}`;
}

function isAllowed(req, patterns) {
  const path = fullPath(req);
  return patterns.some((p) => new RegExp(p).test(path));
}

// 小程序端鉴权：校验 JWT，挂载 req.user（全量用户文档）
// 游客 token（未绑定账号）→ req.guestOpenid，仅放行 GUEST_ALLOW 路径，其余 403003
async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new ApiError(401, 401, '未登录');
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch (e) {
      throw new ApiError(401, 401, '登录已过期，请重新登录');
    }

    // 游客：未完成账号绑定
    if (payload.guest) {
      req.guestOpenid = payload.openid;
      if (!isAllowed(req, GUEST_ALLOW)) {
        throw new ApiError(403, 403003, '请先登录账号');
      }
      return next();
    }

    const user = await User.findById(payload.uid);
    if (!user) throw new ApiError(401, 401, '用户不存在，请重新登录');

    // ⚠️ 令牌必须与「签发时绑定的微信」强一致（用户 2026-10-22「登录刘恩琦后依旧是陈宇航」）。
    //
    // 成因：JWT 有效期 30 天，而管理员「取消绑定微信」只清了 `user.openid`，**旧令牌仍然有效**。
    // 于是那台设备继续带着陈宇航的令牌请求 → /api/auth/me 按 uid 查出来还是陈宇航
    // （超级管理员界面、权限组、系统设置全在），用户在登录页重新输入刘恩琦也没用：
    // 只是本地 token 换了，陈宇航的旧 token 在另一处仍是活的，页面拿到哪个就显示哪个。
    // 极端表现：账号已经解绑（openid 为空），旧设备还能拿它进后台 —— 这是越权，不只是显示问题。
    //
    // 判定口径：令牌里的 openid 是签发那一刻的绑定，与当前 `user.openid` 不一致就说明
    // 绑定被改过（解绑 → 空；换绑 → 另一个 openid），一律 401。
    // 客户端 401 会自动用 `wx.login` 重新拿 code 登录 → 身份重新按**当前微信**确定 → 自愈。
    // 没有 openid 声明的老令牌（早期版本签发）不做判定，避免把所有人一次性踢下线；
    // 游客令牌在上面已经单独 return，不会走到这里。
    if (payload.openid !== undefined && String(payload.openid) !== String(user.openid || '')) {
      throw new ApiError(401, 401, '账号绑定的微信已变更，请重新登录');
    }

    // 限制登录校验：到期待自动解除（走统一服务，顺便清干净 banType/bannedAt 并留流水）
    if (user.status === 'banned' && user.bannedUntil && user.bannedUntil <= new Date()) {
      await anticheat.lift({ user, scope: 'login', operator: 'system', reason: '封禁到期自动解除' });
    }

    if (user.status === 'banned') {
      req.user = user;
      req.banned = { reason: user.banReason, until: user.bannedUntil, banType: 'login' };
      // 被封禁用户仅放行白名单路径（登录态 / 申诉 / 公告）
      if (!isAllowed(req, BANNED_ALLOW)) {
        throw new ApiError(403, 403001, `账号已被限制登录：${user.banReason || '违规操作'}`, {
          banned: { reason: user.banReason, until: user.bannedUntil, banType: 'login' },
        });
      }
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { auth };
