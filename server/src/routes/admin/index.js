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
// 配置：**不在前缀上挂权限**，改由 routes/admin/config.js 内部按接口各自守卫。
// 原因（用户 2026-10-22 要求「楼名管理需要权限项」）：楼名清单从 config.* 拆出了独立权限
// building.view / building.manage，而宿管只需要维护楼名、不该有 config.view。
// 前缀上挂 config.view 会把 GET /buildings 一并挡掉，子路由里再写细权限也无效。
// 现各接口的守卫：GET / 与 PUT /（计分/反作弊/北斗）→ config.view/config.manage；
//                 GET /buildings → building.view 或 config.view（兼容存量）；
//                 PUT / 的 buildings 字段 → building.manage 或 config.manage（且带其它字段时仍要 config.manage）。
router.use('/config', require('./config'));
router.use('/assessment', requirePermission('assessment.view'), require('./assessment'));
// 学生会 / 班超：成员、部门、检查模块、班级台账、宿舍、卫生区、记录与导出
// （写操作在 routes/admin/union.js 内部逐个挂 union.manage）
router.use('/union', requirePermission('union.view'), require('./union'));
// 班级配置（读 class.view、写 class.manage）：GET/PUT /api/admin/class/:className/profile
// 挂在 /class 而不是 /union 下：班级配置是班主任/学生处的日常入口，与学生会配置分开更直观。
// **不会**与学生端班级域 /api/class/* 冲突 —— 那是 app.js 挂的另一条前缀（成员资格校验，不用权限项）。
router.use('/class', requirePermission('class.view'), require('./class-profile'));
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
