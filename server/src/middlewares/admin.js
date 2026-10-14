const { ApiError } = require('../utils/response');

// 管理端鉴权：requirePermission('user.view') —— 校验用户有效权限
// 有效权限含 '*'（超级管理员组）时放行全部
function requirePermission(perm) {
  return async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 401, '未登录');
      const perms = await req.user.getEffectivePermissions();
      if (!perms.includes('*') && !perms.includes(perm)) {
        throw new ApiError(403, 403002, `无权限（需要 ${perm}）`);
      }
      req.userPermissions = perms;
      next();
    } catch (e) {
      next(e);
    }
  };
}

// 兼容旧调用：任意管理权限即可（首页管理面板判断用）
async function anyManager(req, res, next) {
  try {
    const perms = await req.user.getEffectivePermissions();
    if (!perms.length) throw new ApiError(403, 403002, '无管理权限');
    req.userPermissions = perms;
    next();
  } catch (e) {
    next(e);
  }
}

// 持有任一权限即放行（如上传：广告管理或文件管理）
function requireAnyPermission(perms = []) {
  return async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 401, '未登录');
      const effective = await req.user.getEffectivePermissions();
      if (!effective.includes('*') && !perms.some((p) => effective.includes(p))) {
        throw new ApiError(403, 403002, `无权限（需要 ${perms.join(' 或 ')}）`);
      }
      req.userPermissions = effective;
      next();
    } catch (e) {
      next(e);
    }
  };
}

module.exports = { requirePermission, requireAnyPermission, anyManager };
