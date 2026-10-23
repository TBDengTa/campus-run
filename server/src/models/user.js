const mongoose = require('mongoose');

const { Schema } = mongoose;

// 功能限制（反作弊/人工封禁）：只限制某一项能力，不动整个账号
// scope = login（限制登录，走 user.status + bannedUntil）/ sync（限制微信同步）/ gps（限制 GPS 实跑）
const restrictionSchema = new Schema(
  {
    until: { type: Date, default: null }, // null = 永久
    reason: { type: String, default: '' },
    at: { type: Date }, // 最近一次限制时间（用于「24h 内重犯升级」判断）
    count: { type: Number, default: 0 }, // 累计次数
    operator: { type: String, default: 'system' }, // system 自动 / 管理员 openid
  },
  { _id: false }
);

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
    // 班级名（如「23级大数据技术」）：班级域接口（/api/class/*）全部按它过滤，加索引
    className: { type: String, default: '', index: true },
    specialty: { type: String, default: '' },
    // 年级（如 "2024"，展示为 2024级）；名单未提供时前端按学号前 4 位推导
    grade: { type: String, default: '' },
    gender: { type: Number, default: 0 }, // 0 未知 1 男 2 女
    birthdate: { type: Date },
    // 用户角色：学生 / 教师（"管理员"由权限组授予，不是角色）
    role: { type: String, enum: ['student', 'teacher'], default: 'student' },
    // 班主任：教师可被分配多个班级（值为 users.className 的班级名，如「23级大数据技术」）
    // 多键索引：班级域接口按 homeroomClasses.includes(className) 判权，也用于按班级反查班主任
    homeroomClasses: { type: [String], default: [], index: true },
    // 班委（班长等）：学生只能管自己所在班级，且仅查看；可多个学生同时为 true
    isClassOfficer: { type: Boolean, default: false, index: true },
    // 权限：permissionGroups 为权限组 key，permissions 为直接授予的独立权限
    permissionGroups: { type: [String], default: [] },
    permissions: { type: [String], default: [] },
    // 排行榜隐私设置
    privacy: {
      hideClass: { type: Boolean, default: false },
      hideName: { type: Boolean, default: false },
      hidePlan: { type: Boolean, default: false },
      exitRanking: { type: Boolean, default: false },
    },
    status: { type: String, enum: ['active', 'banned'], default: 'active' },
    banReason: { type: String, default: '' },
    banType: { type: String, default: '' }, // login 限制登录 / sync 限制微信同步 / gps 限制 GPS（历史 'manual' 视为 login）
    bannedUntil: { type: Date },
    bannedAt: { type: Date },
    // 单项能力限制（限制登录走上面的 status/bannedUntil，这里只放 sync / gps）
    restrictions: {
      sync: { type: restrictionSchema, default: () => ({}) },
      gps: { type: restrictionSchema, default: () => ({}) },
    },
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
  // 剔除内部字段与**凭据类哈希**：toSafeJSON 的下发场景包含 /api/auth/me 与 login/bind 的 userInfo，
  // 这些哈希一旦下发会被小程序写入本地 storage（真实账号有 passwordHash，dev_* 账号没有，本地测试发现不了）。
  delete obj.__v;
  delete obj.passwordHash;
  delete obj.initialHashes;
  delete obj.resetHashes;
  return obj;
};

// 有效权限 = 直接授予 + 权限组展开 + 权限蕴含展开；'*' 通配全部
//
// ⚠️ 这里是**唯一**计算有效权限的地方：管理端中间件、/api/auth/me 的 effectivePermissions、
// 前端导航显隐全部读它的结果。新增「持 A 即自动拥有 B」这类蕴含，只在
// Permission.PERM_IMPLIES 里声明，然后在这里展开一次 —— 三条链路自动一致。
userSchema.methods.getEffectivePermissions = async function () {
  const PermissionGroup = require('./permission-group');
  const Permission = require('./permission');
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
  return Permission.expandImplies([...set]);
};

userSchema.methods.isManager = async function () {
  const perms = await this.getEffectivePermissions();
  return perms.length > 0;
};

module.exports = mongoose.model('User', userSchema, 'users');
