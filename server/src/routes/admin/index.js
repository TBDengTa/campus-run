const express = require('express');
const { auth } = require('../../middlewares/auth');
const { requirePermission, requireAnyPermission } = require('../../middlewares/admin');

const router = express.Router();

// 管理端全部接口：登录态 + 各模块独立权限校验（用户权限 = 直接权限 + 权限组展开）
router.use(auth);

router.use('/dashboard', requirePermission('dashboard.view'), require('./dashboard'));
router.use('/users', requirePermission('user.view'), require('./users'));
router.use('/appeals', requirePermission('appeal.view'), require('./appeals'));
router.use('/ads', requirePermission('ad.view'), require('./ads'));
router.use('/content', requirePermission('content.view'), require('./content'));
router.use('/config', requirePermission('config.view'), require('./config'));
router.use('/assessment', requirePermission('assessment.view'), require('./assessment'));
router.use('/files', requirePermission('file.view'), require('./files'));
router.use('/upload', requireAnyPermission(['ad.manage', 'file.manage']), require('./upload'));

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
