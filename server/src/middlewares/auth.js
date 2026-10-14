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
