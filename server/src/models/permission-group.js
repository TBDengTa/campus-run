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
      'ad.view',
      'content.view',
      'config.view',
    ],
    description: '教师默认管理权限：查看看板/用户/申诉/广告/内容/配置，可审核申诉',
    builtIn: true,
  },
];

module.exports = mongoose.model('PermissionGroup', permissionGroupSchema);
