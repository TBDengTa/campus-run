const jwt = require('jsonwebtoken');
const config = require('../config');
const { ApiError } = require('../utils/response');
const User = require('../models/user');

// 游客（未绑定账号）可访问的路径前缀（含路由内相对路径）
const GUEST_ALLOW = ['^/api/auth/', '^/auth/', '^/bind$'];

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
      if (!GUEST_ALLOW.some((p) => new RegExp(p).test(req.path))) {
        throw new ApiError(403, 403003, '请先登录账号');
      }
      return next();
    }

    const user = await User.findById(payload.uid);
    if (!user) throw new ApiError(401, 401, '用户不存在，请重新登录');

    // 封禁校验：到期待自动解封
    if (user.status === 'banned') {
      if (user.bannedUntil && user.bannedUntil <= new Date()) {
        user.status = 'active';
        await user.save();
      } else {
        req.user = user;
        req.banned = {
          reason: user.banReason,
          until: user.bannedUntil,
          banType: user.banType,
        };
        // 封禁用户仅放行白名单路径（登录态/申诉相关）
        const allow = ['^/api/auth/', '^/api/appeals', '^/api/users/me$', '^/api/content/'];
        if (!allow.some((p) => new RegExp(p).test(req.path))) {
          throw new ApiError(403, 403001, `账号已被封禁：${user.banReason || '违规操作'}`, {
            banned: { reason: user.banReason, until: user.bannedUntil },
          });
        }
      }
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { auth };
