const express = require('express');
const { auth } = require('../../middlewares/auth');
const { requirePermission, requireAnyPermission } = require('../../middlewares/admin');

const router = express.Router();

// 管理端全部接口：登录态 + 各模块独立权限校验（用户权限 = 直接权限 + 权限组展开）
router.use(auth);

router.use('/dashboard', requirePermission('dashboard.view'), require('./dashboard'));
// 徽章发放 / 回收（badge.manage）**先于** users 路由挂载：users 整体挂在 user.view 下，
// 先挂这个只匹配 /:id/badges* 的 router，才能让「只有 badge.manage、没有 user.view」的角色也能发徽章；
// 其它 /users/* 路径本 router 不匹配，会 next() 落到下面的 users 路由（权限结论不变）。
router.use('/users', require('./user-badges'));
router.use('/users', requirePermission('user.view'), require('./users'));
router.use('/appeals', requirePermission('appeal.view'), require('./appeals'));
router.use('/ads', requirePermission('ad.view'), require('./ads'));
router.use('/content', requirePermission('content.view'), require('./content'));
router.use('/config', requirePermission('config.view'), require('./config'));
router.use('/assessment', requirePermission('assessment.view'), require('./assessment'));
router.use('/files', requirePermission('file.view'), require('./files'));
// 上传：广告素材/文件管理任一即可；content.manage 是为了徽章图标（挂在 /content 下、只需徽章管理权限），
// 具体能传哪个「用途」由 routes/admin/upload.js 的 CATEGORY_PERMS 逐项校验
router.use('/upload', requireAnyPermission(['ad.manage', 'file.manage', 'content.manage']), require('./upload'));

// 权限组管理（增删改，需 permission.manage）
router.use('/permission-groups', requirePermission('permission.manage'), require('./permission-groups'));

// 权限目录 + 权限组（管理用户权限者可用）
router.get(
  '/permissions',
  requirePermission('permission.manage'),
  async (req, res, next) => {
    try {
      const Permission = require('../../models/permission');
      const PermissionGroup = require('../../models/permission-group');
      const [catalog, groups] = await Promise.all([
        Permission.find().sort({ sort: 1 }).lean(),
        PermissionGroup.find().sort({ builtIn: -1, key: 1 }).lean(),
      ]);
      res.json({ code: 0, message: 'ok', data: { catalog, groups } });
    } catch (e) {
      next(e);
    }
  }
);

module.exports = router;
