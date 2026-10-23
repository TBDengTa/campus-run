const Permission = require('../models/permission');
const PermissionGroup = require('../models/permission-group');
const User = require('../models/user');
const config = require('../config');
const pwd = require('./password');

// 索引迁移：openid 由「唯一」改为「唯一稀疏」（未绑定账号不占 openid）
async function migrateOpenidIndex() {
  const col = User.collection;
  const indexes = await col.indexes();
  const openidIdx = indexes.find((i) => i.name === 'openid_1');
  if (openidIdx && !openidIdx.sparse) {
    await col.dropIndex('openid_1');
    await col.createIndex({ openid: 1 }, { unique: true, sparse: true });
    console.log('[rbac] openid 索引已迁移为唯一稀疏索引');
  }
}

// 旧角色迁移（必须早于任何用户文档 save）：
//   旧枚举 role='admin' → teacher + superadmin 组；'user' 及其它 → student
//   否则带 role='user' 的历史用户一旦被 save()/校验就会撞上新枚举（student/teacher），直接导致启动失败
async function migrateLegacyRoles() {
  const adminCount = await User.countDocuments({ role: 'admin' });
  if (adminCount) {
    await User.updateMany({ role: 'admin' }, { $addToSet: { permissionGroups: 'superadmin' } });
    await User.updateMany({ role: 'admin' }, { $set: { role: 'teacher' } });
    console.log(`[rbac] 已迁移 ${adminCount} 个旧版 admin 账号为 教师 + 超级管理员组`);
  }
  const legacyCount = await User.countDocuments({ role: { $nin: ['student', 'teacher'] } });
  if (legacyCount) {
    const res = await User.updateMany({ role: { $nin: ['student', 'teacher'] } }, { $set: { role: 'student' } });
    console.log(`[rbac] 已迁移 ${res.modifiedCount || legacyCount} 个旧版角色账号为 学生`);
  }
}

// 存量用户账号迁移：补 account（姓名）与初始密码哈希（学号后8），不强制改密
// 只处理从未迁移过的用户（account / mustChangePassword 缺失），避免每次启动重算 1500+ 次 scrypt
async function migrateExistingAccounts() {
  const targets = await User.find({
    $or: [{ account: { $exists: false } }, { mustChangePassword: { $exists: false } }],
  });
  let n = 0;
  for (const u of targets) {
    const sid8 = pwd.last8(u.studentId);
    const patch = { account: u.account || u.realName || '', mustChangePassword: false };
    if (sid8 && !(u.initialHashes || []).length) patch.initialHashes = [pwd.hashPassword(sid8)];
    try {
      // 用 updateOne 覆盖：不触发 schema 校验，历史脏数据不会阻断启动
      await User.updateOne({ _id: u._id }, { $set: patch });
      n += 1;
    } catch (e) {
      console.warn(`[rbac] 账号迁移跳过 ${u.openid}: ${e.message}`);
    }
  }
  if (n) console.log(`[rbac] 已为 ${n} 个存量用户生成账号/初始密码（学号后8）`);
  // 补齐老数据缺失的 resetHashes（管理员重置密码的备份，来自学号后8）
  const noReset = await User.find({
    $and: [
      { $or: [{ resetHashes: { $exists: false } }, { resetHashes: { $size: 0 } }] },
      { studentId: { $exists: true, $nin: [null, ''] } },
    ],
  });
  let m = 0;
  for (const u of noReset) {
    const sid8 = pwd.last8(u.studentId);
    if (sid8) {
      await User.updateOne({ _id: u._id }, { $set: { resetHashes: [pwd.hashPassword(sid8)] } });
      m += 1;
    }
  }
  if (m) console.log(`[rbac] 已为 ${m} 个用户补齐重置密码备份`);
}

// 启动入口（幂等）：索引迁移 + 旧角色归一化 + 账号迁移 + 权限播种
async function seedRbac() {
  await migrateOpenidIndex();
  await migrateLegacyRoles();
  await migrateExistingAccounts();
  return seedPermissions();
}

async function seedPermissions() {
  // 1. 权限目录
  for (const item of Permission.DEFAULT_CATALOG) {
    await Permission.updateOne(
      { key: item.key },
      { $set: { name: item.name, module: item.module, sort: item.sort } },
      { upsert: true }
    );
  }

  // 2. 内置权限组
  // ⚠️ customized=true 的组**跳过覆盖**（用户 2026-10-20 放开内置组编辑后必须配套改这里）：
  //   播种每次启动都 $set 全量字段，若管理员改过的组仍被播种，改动会在下次重启**静默消失**——
  //   比"不能改"更糟（当下生效、之后没效果，没人会想到是重启抹的）。
  //   customized 标记由 PUT /permission-groups/:id 在保存内置组时写入；superadmin 不可编辑，永远走播种。
  for (const g of PermissionGroup.DEFAULT_GROUPS) {
    const exists = await PermissionGroup.findOne({ key: g.key }).lean();
    if (exists && exists.customized) continue;
    await PermissionGroup.updateOne(
      { key: g.key },
      { $set: { name: g.name, permissions: g.permissions, description: g.description, builtIn: true } },
      { upsert: true }
    );
  }

  // 3. 旧角色迁移已在 migrateLegacyRoles() 中提前完成（需早于任何用户文档保存）

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
