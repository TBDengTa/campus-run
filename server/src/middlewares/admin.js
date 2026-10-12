const { ApiError } = require('../utils/response');

// 管理端鉴权：须在 auth 之后使用
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return next(new ApiError(403, 403002, '无管理员权限'));
  }
  next();
}

module.exports = { adminOnly };
