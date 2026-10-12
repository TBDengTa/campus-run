const Permission = require('../models/permission');
const PermissionGroup = require('../models/permission-group');
const User = require('../models/user');
const config = require('../config');

// 启动时播种权限目录与内置权限组（幂等），并迁移旧版 admin/user 角色
async function seedRbac() {
  // 1. 权限目录
  for (const item of Permission.DEFAULT_CATALOG) {
    await Permission.updateOne(
      { key: item.key },
      { $set: { name: item.name, module: item.module, sort: item.sort } },
      { upsert: true }
    );
  }

  // 2. 内置权限组
  for (const g of PermissionGroup.DEFAULT_GROUPS) {
    await PermissionGroup.updateOne(
      { key: g.key },
      { $set: { name: g.name, permissions: g.permissions, description: g.description, builtIn: true } },
      { upsert: true }
    );
  }

  // 3. 旧角色迁移：role='admin'（旧枚举）→ teacher + superadmin 组；role='user' → student
  const oldAdmins = await User.find({ role: 'admin' });
  for (const u of oldAdmins) {
    u.role = 'teacher';
    if (!u.permissionGroups.includes('superadmin')) u.permissionGroups.push('superadmin');
    await u.save();
  }
  if (oldAdmins.length) console.log(`[rbac] 已迁移 ${oldAdmins.length} 个旧版 admin 账号为 教师+超级管理员组`);

  // 4. 引导管理员：env 配置的 openid 强制授予 superadmin 组
  if (config.adminBootstrapOpenids.length) {
    for (const openid of config.adminBootstrapOpenids) {
      const u = await User.findOne({ openid });
      if (u && !u.permissionGroups.includes('superadmin')) {
        u.permissionGroups.push('superadmin');
        if (u.role !== 'teacher') u.role = 'teacher';
        await u.save();
        console.log(`[rbac] 引导管理员已授权: ${openid}`);
      }
    }
  }
}

module.exports = { seedRbac };
