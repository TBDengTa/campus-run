const mongoose = require('mongoose');

const { Schema } = mongoose;

const userSchema = new Schema(
  {
    // 绑定的微信 openid（绑定后不可解绑/更换）；未绑定账号为空 → 唯一稀疏索引
    openid: { type: String, unique: true, sparse: true },
    openidBoundAt: { type: Date },
    unionid: { type: String, index: true },
    nickname: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },
    // ===== 账号密码体系 =====
    // 登录账号 = 姓名（同名靠密码区分，不做唯一索引）
    account: { type: String, index: true },
    realName: { type: String, default: '' },
    // 当前密码哈希（scrypt$ salt $ hash）
    passwordHash: { type: String },
    // 初始密码哈希（学号后8/身份证后8），首次改密后清空
    initialHashes: { type: [String], default: [] },
    // 管理员重置专用：初始密码哈希备份（永不失效），重置时同时恢复 initialHashes
    resetHashes: { type: [String], default: [] },
    mustChangePassword: { type: Boolean, default: false },
    failedLogins: { type: Number, default: 0 },
    lockUntil: { type: Date },
    // 不设默认值：studentId 有唯一稀疏索引，多个空串会撞唯一键；未填写时不落字段
    studentId: { type: String, index: { unique: true, sparse: true } },
    schoolId: { type: Schema.Types.ObjectId, ref: 'Organization' },
    schoolName: { type: String, default: '' },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Organization' },
    departmentName: { type: String, default: '' },
    className: { type: String, default: '' },
    specialty: { type: String, default: '' },
    gender: { type: Number, default: 0 }, // 0 未知 1 男 2 女
    birthdate: { type: Date },
    // 用户角色：学生 / 教师（"管理员"由权限组授予，不是角色）
    role: { type: String, enum: ['student', 'teacher'], default: 'student' },
    // 权限：permissionGroups 为权限组 key，permissions 为直接授予的独立权限
    permissionGroups: { type: [String], default: [] },
    permissions: { type: [String], default: [] },
    status: { type: String, enum: ['active', 'banned'], default: 'active' },
    banReason: { type: String, default: '' },
    banType: { type: String, default: '' }, // sync 同步异常 / manual 人工
    bannedUntil: { type: Date },
    bannedAt: { type: Date },
    // 汇总缓存（由跑步记录聚合刷新）
    totalSteps: { type: Number, default: 0 },
    totalDistance: { type: Number, default: 0 }, // 米
    totalDays: { type: Number, default: 0 },
    lastSyncAt: { type: Date },
  },
  { timestamps: true }
);

userSchema.methods.toSafeJSON = function () {
  const obj = this.toJSON();
  delete obj.__v;
  return obj;
};

// 有效权限 = 直接授予 + 权限组展开；'*' 通配全部
userSchema.methods.getEffectivePermissions = async function () {
  const PermissionGroup = require('./permission-group');
  const direct = Array.isArray(this.permissions) ? this.permissions : [];
  if (direct.includes('*')) return ['*'];
  const groupKeys = Array.isArray(this.permissionGroups) ? this.permissionGroups : [];
  const groups = groupKeys.length ? await PermissionGroup.find({ key: { $in: groupKeys } }).lean() : [];
  const set = new Set(direct);
  for (const g of groups) {
    for (const p of g.permissions || []) {
      if (p === '*') return ['*'];
      set.add(p);
    }
  }
  return [...set];
};

userSchema.methods.isManager = async function () {
  const perms = await this.getEffectivePermissions();
  return perms.length > 0;
};

module.exports = mongoose.model('User', userSchema, 'users');
