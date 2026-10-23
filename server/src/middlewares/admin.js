const { ApiError } = require('../utils/response');

// 管理端鉴权：requirePermission('user.view') —— 校验用户有效权限
// 有效权限含 '*'（超级管理员组）时放行全部
//
// 支持**多权限任一满足**：requirePermission('building.view', 'config.view')
// 用途：某些能力后来拆出了更专门的权限项（如楼名从 config.* 拆出 building.*），
// 而存量权限组里只有旧项。任一满足既能收紧到新权限，又不会把老账号当场锁死。
function requirePermission(...permsWanted) {
  const list = permsWanted.filter(Boolean);
  const label = list.join(' 或 ');
  return async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 401, '未登录');
      const perms = await req.user.getEffectivePermissions();
      const granted = perms.includes('*') || list.some((p) => perms.includes(p));
      if (!granted) {
        throw new ApiError(403, 403002, `无权限（需要 ${label}）`);
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
