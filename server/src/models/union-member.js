const mongoose = require('mongoose');

// 学生会成员（任期记录）：同一人可以有多条（校级 + 分院、或多个部门，历史届次另存为 left 记录）
//
// 与 users 的关系：users.unionRoles / users.isUnionMember 是**派生缓存**（由 services/union.js::syncUserUnionCache
// 在增删改成员后刷新），客户端据此决定首页「学生会块」与底部导航项；服务端鉴权一律以本集合实时查询为准。
//
// 会员不是「管理员」：role 仍是 student，不分配权限组，因此进不了 /api/admin/*（见方案 §3.2）。
const unionMemberSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    openid: { type: String, default: '', index: true },
    realName: { type: String, default: '' },
    studentId: { type: String, default: '' },
    className: { type: String, default: '' },

    level: { type: String, enum: ['school', 'branch'], required: true },
    // level='branch' 时**应填院校（校区）**：organizations 里 type='school' 的节点（北校区 / 洋河校区 / 教师院）。
    // 鉴权不直接比对 schoolId，而是由 services/union.js::resolveIdentity 把它展开成
    // 「该院校下全部 type='department' 子节点 id」再喂给既有判定（check_records.departmentId 存的是班级所属院系，
    // 校区 id 塞进 departmentId 会让分会成员一条记录都看不到 —— 展开法见 services/union.js 文件头）。
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
    schoolName: { type: String, default: '' },
    // 老口径（历史 / 兼容）：level='branch' 的记录**曾经**绑的是院系（department 层）。
    // 当前库里没有已录入成员，但字段保留：① 老数据的 departmentId 仍直接计入 identity.departmentIds；
    // ② 管理端编辑成员时若前端仍传院系，照旧落库。不要因为「新口径绑院校」就把这两个字段删掉。
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
    departmentName: { type: String, default: '' },

    // 部门 key：对应 union_departments.key；主席团成员用 'presidium'
    deptKey: { type: String, default: '' },
    deptName: { type: String, default: '' },

    role: {
      type: String,
      enum: ['president', 'vice_president', 'minister', 'vice_minister', 'member'],
      required: true,
    },

    termId: { type: String, default: '' }, // 届次标识，如 2025-2026-1（可为空）
    termName: { type: String, default: '' }, // 届次展示名，如「2025-2026 学年第一学期」

    status: { type: String, enum: ['active', 'left'], default: 'active', index: true },
    remark: { type: String, default: '' },
    createdBy: { type: String, default: '' }, // 管理员 openid
  },
  { timestamps: true, collection: 'student_union_members' }
);

// 「我是谁」：一人多条
unionMemberSchema.index({ openid: 1, status: 1 });
// 部门维度：分院看本部门全部成员
unionMemberSchema.index({ level: 1, departmentId: 1, deptKey: 1, status: 1 });
// 院校维度（本轮新增）：分院成员按院校（校区）聚合 —— 展开鉴权范围时用它先捞出 branch 记录
unionMemberSchema.index({ level: 1, schoolId: 1, deptKey: 1, status: 1 });
// 同一个人 + 同一**院校** + 同一部门 + 同 level + 同届次只允许一条 active —— 防止重复录入把权限算两遍。
// ⚠️ 键里必须含 schoolId：新口径的分院记录 departmentId 恒为 null，若唯一键仍只看 departmentId，
//    「北校区分会」与「洋河校区分会」的同名部门会被数据库当成同一个键而拒收第二条（E11000 → 500）。
//    老格式记录（schoolId 为 null）在含 schoolId 的键下仍按原粒度去重，兼容不变。
// ⚠️ 存量库的旧索引（不含 schoolId）**必须显式删除重建**：Mongoose 只会新建缺失索引、不会替换旧索引，
//    旧索引留在库里会继续按 departmentId=null 拒收跨校区第二条。
//    迁移写法参照 services/dorms.js::migrateSlotIndex（建新 + dropIndex 旧名），当前集合为空，代价为零。
unionMemberSchema.index(
  { userId: 1, level: 1, schoolId: 1, departmentId: 1, deptKey: 1, termId: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } }
);

// 职务展示名（服务端统一出口，前端不要再各写一套判断）
unionMemberSchema.statics.ROLE_TEXT = {
  president: '主席',
  vice_president: '副主席',
  minister: '部长',
  vice_minister: '副部长',
  member: '部员',
};

// 是否主席团（校级主席团 = 全校复核权；分院主席团 = 本院系复核权）
unionMemberSchema.methods.isPresidium = function () {
  return this.deptKey === 'presidium' || ['president', 'vice_president'].includes(this.role);
};

module.exports = mongoose.model('UnionMember', unionMemberSchema, 'student_union_members');
