const mongoose = require('mongoose');

// 权限组：一组权限的命名集合，可整体授予用户
const permissionGroupSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    // '*' 表示全部权限（超级管理员组）
    permissions: { type: [String], default: [] },
    description: { type: String, default: '' },
    builtIn: { type: Boolean, default: false }, // 内置组不可删除
    // 管理员改过内置组 → true：**启动播种不再覆盖它**（用户 2026-10-20 口径）。
    // 为什么需要这个标记：旧规则是「内置组只读、每次启动按默认值重播种」，
    // 若只放开编辑不改播种，管理员改完当下生效、**下次重启被静默抹掉**（假生效，比不能改更糟）。
    // superadmin 组例外：恒 false（不可编辑，见 routes/admin/permission-groups.js）。
    customized: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'permission_groups' }
);

permissionGroupSchema.statics.DEFAULT_GROUPS = [
  {
    key: 'superadmin',
    name: '超级管理员组',
    permissions: ['*'],
    description: '拥有全部权限',
    builtIn: true,
  },
  {
    key: 'teacher',
    name: '教师管理组',
    permissions: [
      'dashboard.view',
      'user.view',
      'appeal.view',
      'appeal.review',
      'content.view',
      'config.view',
      'assessment.view',
    ],
    description: '教师默认管理权限：查看看板/用户/申诉/内容/配置/运动考核，可审核申诉（教师不接触广告）',
    builtIn: true,
  },
];

module.exports = mongoose.model('PermissionGroup', permissionGroupSchema);
