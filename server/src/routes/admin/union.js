/**
 * 管理端：学生会与班超（/api/admin/union/*）
 *
 * 全部路由挂在 requirePermission('union.view') 下（见 routes/admin/index.js），
 * 写操作逐个 requirePermission('union.manage')，导出 / 作废同样单独校验 —— 不只靠前端隐藏入口。
 *
 * 模块划分：
 *   /members         学生会成员（任期记录）
 *   /departments     学生会部门（内置项不可删）
 *   /modules         检查模块配置（字段 / 部门 / 计分权重）
 *   /class-profiles  班级台账（是否有早操 / 早八、人数）
 *   /dorms           宿舍房间 + 住宿名单（Excel 导入）
 *   /areas           卫生区与责任班级
 *   /records         检查记录查询 / 统计 / 导出 CSV / 作废
 *   /dashboard       班超总览
 */
const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { wrap, ok, ApiError, parsePagination } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const { makeUploader } = require('../../utils/uploader');
const dates = require('../../utils/dates');

const User = require('../../models/user');
const Org = require('../../models/organization');
const UnionMember = require('../../models/union-member');
const UnionDepartment = require('../../models/union-department');
const CheckModule = require('../../models/check-module');
const CheckRecord = require('../../models/check-record');
const ClassProfile = require('../../models/class-profile');
const DormRoom = require('../../models/dorm-room');
const DormAssignment = require('../../models/dorm-assignment');
const SanitaryArea = require('../../models/sanitary-area');

const unionSvc = require('../../services/union');
const checkModules = require('../../services/check-modules');
const classProfilesSvc = require('../../services/class-profiles');
const { liveCounts } = require('../../services/class-counts');
const bandChao = require('../../services/band-chao');
const formula = require('../../services/formula');
const roster = require('../../services/roster');

const router = express.Router();
const MANAGE = requirePermission('union.manage');
const sheetUpload = makeUploader({ memory: true, accept: ['.xlsx', '.xls', '.csv'] });

const ROLE_VALUES = ['president', 'vice_president', 'minister', 'vice_minister', 'member'];
// 主席团专属职务：主席 / 副主席。反过来，业务部门不允许出现这两个职务。
const PRESIDIUM_ROLES = ['president', 'vice_president'];

/**
 * 部门与职务的对应关系校验（用户 2026-10-21：「主席团中怎么能有部长这类的职务呢」）。
 *
 * 规则是**双向**的，缺一不可：
 *   ① 部门 = 主席团 → 职务只能是 主席 / 副主席（不能是部长 / 副部长 / 部员）；
 *   ② 职务 = 主席 / 副主席 → 部门必须是 主席团（不允许挂到生活部这类业务部门）。
 *
 * 为什么必须在服务端拦：前端只是下拉选项，绕过它直接 POST 就能造出
 * 「主席团 · 副部长」这种读起来自相矛盾的成员记录，而成员列表、复核范围、
 * 通讯录分工全都按这两个字段展示与授权（AGENTS.md：校验以服务端为准）。
 */
function assertRoleFitsDept(role, deptKey) {
  const r = String(role || '');
  const d = String(deptKey || '');
  const isPresidiumDept = d === unionSvc.PRESIDIUM_KEY;
  const isPresidiumRole = PRESIDIUM_ROLES.includes(r);
  if (isPresidiumDept && !isPresidiumRole) {
    throw new ApiError(400, 400, '主席团成员只能是主席或副主席，不能设为部长 / 副部长 / 部员');
  }
  if (isPresidiumRole && !isPresidiumDept) {
    throw new ApiError(400, 400, '主席 / 副主席必须挂在主席团，不能归入业务部门');
  }
}
const str = (v, max = 120) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

// ===== 学年（届次）=====
// 统一走 services/union.js::academicTerms（9 月切学年、回溯到 2024 学年），
// 避免管理端 / 用户端各写一套口径。
const academicTerms = () => unionSvc.academicTerms();

// 班级属性（是否有早操 / 早八 / 是否参加校园跑 / 人数）会影响「录入台对象列表」与「班级排名分母」，
// 这两处都有 60s 进程内缓存 → 改完必须失效，否则操作者会以为「改了没生效」
// （与班级域 PUT /api/class/profile、管理端 PUT /api/admin/class/:className/profile 同一处理）
function clearBandChaoCaches() {
  try {
    bandChao.clearRankCache();
  } catch (e) {
    /* 缓存清理是可选能力：服务缺失时忽略 */
  }
  try {
    if (typeof classProfilesSvc.clearProfileCache === 'function') classProfilesSvc.clearProfileCache();
  } catch (e) {
    /* 同上 */
  }
}

function presentMember(m) {
  return {
    id: String(m._id),
    userId: m.userId ? String(m.userId) : '',
    openid: m.openid || '',
    realName: m.realName || '',
    studentId: m.studentId || '',
    className: m.className || '',
    level: m.level,
    levelText: m.level === 'school' ? '校学生会' : '分院学生会',
    // 新口径：院校（校区，organizations.type='school'）—— 前端列表副标题优先显示它
    schoolId: m.schoolId ? String(m.schoolId) : '',
    schoolName: m.schoolName || '',
    // 老口径：院系 —— 保留，老数据（无 schoolId）仍靠它展示
    departmentId: m.departmentId ? String(m.departmentId) : '',
    departmentName: m.departmentName || '',
    deptKey: m.deptKey || '',
    deptName: m.deptName || '',
    role: m.role,
    roleText: UnionMember.ROLE_TEXT[m.role] || m.role,
    termId: m.termId || '',
    termName: m.termName || '',
    status: m.status,
    remark: m.remark || '',
    createdAt: m.createdAt,
  };
}

// 分院成员的「院校下有没有系部」提示：校区展开出 0 个院系 = 该分会成员看不到也录不了任何班。
// 必须在列表里明确显示原因（组织架构没配子级），而不是静默让人以为权限坏了。
// 返回「院校 id → true」的缺失映射，由 GET /members 一次性批量算出（不在每条记录上单独查库）。
async function campusMissingMap(rows) {
  const schoolIds = [
    ...new Set(
      (rows || [])
        .filter((m) => m.level === 'branch' && m.schoolId)
        .map((m) => String(m.schoolId))
    ),
  ];
  if (!schoolIds.length) return new Map();
  const { counts } = await unionSvc.campusDepartmentIndex(schoolIds);
  const missing = new Map();
  for (const sid of schoolIds) if (!(counts.get(sid) > 0)) missing.set(sid, true);
  return missing;
}

// 按「学号 / 姓名 / 账号」解析学生
async function findStudent({ userId, studentId, realName, account }) {
  if (userId && mongoose.isValidObjectId(userId)) {
    const u = await User.findById(userId).lean();
    if (u) return u;
  }
  const or = [];
  if (studentId) or.push({ studentId: String(studentId) });
  if (account) or.push({ account: String(account) });
  if (realName) or.push({ realName: String(realName) }, { account: String(realName) });
  if (!or.length) return null;
  return User.findOne({ $or: or }).lean();
}

// 部门 key 必须存在（保留 presidium 用于主席团）。
// 返回**完整部门文档**的关键字段（含 schoolId/scope）：调用方要用它做校区归属校验，
// 只返回 key/name 的话校验函数拿不到归属，等于没法拦。
async function assertDept(deptKey, { allowEmpty = true } = {}) {
  const key = str(deptKey, 32);
  if (!key) {
    if (allowEmpty) return { key: '', name: '', schoolId: null, scope: 'both' };
    throw new ApiError(400, 400, '请选择部门');
  }
  const dept = await UnionDepartment.findOne({ key }).lean();
  if (!dept) throw new ApiError(400, 400, '部门不存在（请先在「部门配置」里添加）');
  return { key: dept.key, name: dept.name, schoolId: dept.schoolId || null, scope: dept.scope || 'both' };
}

/**
 * 部门是否可用于该校区（权威校验，前端过滤只是体验）。
 *
 * 用户 2026-10-21「现在所有部门都是一个、只是在不同校区显示，我需要互不干扰」：
 * 旧模型只有 scope，而 scope='branch' 表示「挂到**所有**校区」，
 * 所以「北校区生活部」与「洋河生活部」无法区分，随便传哪个 key 都能落库。
 * 现在部门可带 schoolId（只属于该校区），这里统一拦：
 *   ① 带 schoolId 的部门 → 只能给**同一个**校区的分院成员用（校级成员也不许用）；
 *   ② 不带 schoolId → 沿用 scope（school / branch / both）的老口径。
 * ⚠️ 必须在服务端拦：绕过前端直接 POST 就能造出「洋河成员 + 北校区部门」的矛盾数据，
 *   而成员页、鉴权范围、部门统计都会跟着错（AGENTS.md：校验以服务端为准）。
 * @param {object} dept 部门文档（需含 schoolId / scope）
 * @param {'school'|'branch'} level 成员层级
 * @param {string|ObjectId|null} schoolId 分院成员所属校区
 */
function assertDeptFitsCampus(dept, level, schoolId) {
  if (!dept || !dept.key) return;
  // 主席团是全局概念（分会主席团 level='branch' 也挂 presidium），不参与校区归属判定
  if (dept.key === unionSvc.PRESIDIUM_KEY) return;
  const want = schoolId ? String(schoolId) : '';
  if (dept.schoolId) {
    if (level === 'school') {
      throw new ApiError(400, 400, `「${dept.name}」属于某个院校的分会，不能作为校学生会部门`);
    }
    if (String(dept.schoolId) !== want) {
      throw new ApiError(400, 400, `「${dept.name}」不属于所选校区，请重新选择部门`);
    }
    return;
  }
  // 未指定校区的非主席团部门：**校学生会层不再允许**（用户 2026-10-21
  // 「全校仅有主席团没有其他部门了」）。分会层一律可用（scope='school' 的旧数据也放行 —— 那类
  // 是「只属校级」的历史语义，继续拒绝没有意义；真正强制的规则是「校级只能主席团」）。
  if (level === 'school') {
    throw new ApiError(400, 400, `「${dept.name}」不是学生会主席团，请选择具体院校（校区）`);
  }
}


// ===================== 成员 =====================

// 解析分院成员绑定的院校（校区）：必须存在且 type === 'school'。
// 从「院系」上移到「院校」是用户明确纠正过的口径：北校区 / 洋河校区 / 教师院都是 organizations 里的 school 层。
// 这里刻意**不**回落到 department：把院系 id 当校区存会让展开鉴权取到空集合（分会成员一条记录都看不到）。
async function resolveCampusSchool(schoolId, { required = true } = {}) {
  if (!schoolId) {
    if (required) throw new ApiError(400, 400, '分院学生会必须选择院校');
    return { id: null, name: '' };
  }
  if (!mongoose.isValidObjectId(schoolId)) throw new ApiError(400, 400, '院校不存在');
  const org = await Org.findById(schoolId).lean();
  if (!org) throw new ApiError(400, 400, '院校不存在');
  if (org.type !== 'school') throw new ApiError(400, 400, '请选择院校（校区），不是院系');
  return { id: org._id, name: org.name || '' };
}

// 老口径兼容：仍接收院系（department 层）。前端若同时传了校区+院系，两者都落库。
async function resolveLegacyDepartment(departmentId, { required = false } = {}) {
  if (!departmentId) {
    if (required) throw new ApiError(400, 400, '分院学生会必须选择院系');
    return { id: null, name: '' };
  }
  if (!mongoose.isValidObjectId(departmentId)) {
    if (required) throw new ApiError(400, 400, '院系不存在');
    return { id: null, name: '' };
  }
  const org = await Org.findById(departmentId).lean();
  if (!org) {
    if (required) throw new ApiError(400, 400, '院系不存在');
    return { id: null, name: '' };
  }
  return { id: org._id, name: org.name || '' };
}

router.get(
  '/members',
  wrap(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { page: 1, limit: 20 });
    const filter = {};
    if (req.query.level) filter.level = String(req.query.level);
    if (req.query.deptKey) filter.deptKey = String(req.query.deptKey);
    if (req.query.status) filter.status = String(req.query.status);
    // 院校（校区）筛选：新口径；保留 departmentId 筛选以兼容老数据 / 按院系查
    if (req.query.schoolId && mongoose.isValidObjectId(req.query.schoolId)) {
      filter.schoolId = req.query.schoolId;
    }
    if (req.query.departmentId && mongoose.isValidObjectId(req.query.departmentId)) {
      filter.departmentId = req.query.departmentId;
    }
    // 「院校」选择器：campus='' 全部；campus='school' 校学生会；campus=<组织id> 该院校分院学生会。
    // 前端不再暴露「校 / 分院」这类层级术语，一律用院校名（校级就叫「校学生会」）。
    const campus = str(req.query.campus, 40);
    if (campus === 'school') {
      filter.level = 'school';
    } else if (campus && mongoose.isValidObjectId(campus)) {
      filter.level = 'branch';
      filter.schoolId = campus;
    }
    // 学年（届次）：termId 形如 2026-2027；不传 = 全部学年。
    // 早期成员记录没有写 termId/termName（历史数据），筛选「当前学年」时要把它们一并算上，
    // 否则一进页面默认学年就会把所有人过滤掉（看起来像「成员都没了」）。
    const termId = str(req.query.termId, 40);
    const terms = academicTerms();
    if (termId) {
      filter.termId = termId === terms.current ? { $in: [termId, ''] } : termId;
    }
    const keyword = str(req.query.keyword, 40);
    if (keyword) {
      const re = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ realName: re }, { studentId: re }, { className: re }];
    }
    const [total, rows, departments, schools] = await Promise.all([
      UnionMember.countDocuments(filter),
      UnionMember.find(filter).sort({ level: 1, deptKey: 1, role: 1, createdAt: 1 }).skip(skip).limit(limit).lean(),
      UnionDepartment.find().sort({ sort: 1 }).lean(),
      Org.find({ type: 'school' }).sort({ sort: 1, name: 1 }).select('name').lean(),
    ]);
    // 院校下没有系部 → 该分会成员看不到/录不了任何班，列表里逐条给出可读提示
    const missing = await campusMissingMap(rows);
    const currentTerm = terms.list[0] || {};
    ok(res, {
      page,
      limit,
      total,
      hasMore: skip + rows.length < total,
      list: rows.map((m) => {
        const item = presentMember(m);
        const sid = item.schoolId;
        // 无院校系部提示只对「绑了校区、但校区下 0 个院系」的分院成员显示
        item.campusWarning =
          item.level === 'branch' && sid && missing.get(sid)
            ? `该院校（${item.schoolName || '未命名'}）下还没有系部，请到「组织架构」配置，否则该成员看不到也录不了任何班`
            : '';
        // 老记录没有学年：展示时归到当前学年，避免列表出现空格；届次按学年推算
        const term = item.termId ? terms.list.find((t) => t.termId === item.termId) : null;
        const fallback = term || currentTerm;
        item.termName = item.termName || fallback.termName || '';
        item.termId = item.termId || currentTerm.termId || '';
        item.session = fallback.session || null;
        item.sessionName = fallback.sessionName || '';
        item.termLabel = fallback.termLabel || item.termName;
        return item;
      }),
      // schoolId/schoolName 必须一起下发：成员页要按「校区」过滤可选部门
      // （用户 2026-10-21「北校区有生活部、洋河叫卫生部，互不干扰」）。
      // 只给 scope 的话，scope='branch' 的部门会在**所有**校区的成员表单里出现，选错校区无人拦。
      // 校区名复用上面已查的 schools（同一次请求，不再多查一次 Org）。
      departments: (() => {
        const nameOf = new Map((schools || []).map((s) => [String(s._id), s.name || '']));
        return departments.map((d) => ({
          key: d.key,
          name: d.name,
          scope: d.scope,
          schoolId: d.schoolId ? String(d.schoolId) : '',
          schoolName: d.schoolId ? nameOf.get(String(d.schoolId)) || '' : '',
          builtIn: !!d.builtIn,
          enabled: d.enabled !== false,
        }));
      })(),
      // 院校选择器选项：第一项固定为「全校」（= 校级），后面是各院校（校区）
      schools: (schools || []).map((s) => ({ id: String(s._id), name: s.name || '' })),
      terms: terms.list,
      currentTerm: terms.current,
      currentTermLabel: terms.currentLabel || '',
      currentSessionName: (currentTerm && currentTerm.sessionName) || '',
      roleText: UnionMember.ROLE_TEXT,
    });
  })
);

router.post(
  '/members',
  MANAGE,
  wrap(async (req, res) => {
    const body = req.body || {};
    const level = body.level === 'branch' ? 'branch' : 'school';
    const student = await findStudent(body);
    if (!student) throw new ApiError(400, 400, '找不到该学生（请用学号 / 姓名 / 账号精确匹配）');
    if (student.role === 'teacher') throw new ApiError(400, 400, '教师账号不能加入学生会');

    let departmentId = null;
    let departmentName = '';
    let schoolId = null;
    let schoolName = '';
    if (level === 'branch') {
      // 新口径：院校（校区）必填
      const school = await resolveCampusSchool(body.schoolId, { required: true });
      schoolId = school.id;
      schoolName = school.name;
      // 老口径兼容：前端仍传院系时照旧落库
      const legacyDept = await resolveLegacyDepartment(body.departmentId, { required: false });
      departmentId = legacyDept.id;
      departmentName = legacyDept.name;
    }
    const role = ROLE_VALUES.includes(body.role) ? body.role : 'member';
    // 主席团：没选部门时自动落到 presidium；理事类职务（主席/副主席）也必须挂主席团
    let deptKeyInput = body.deptKey;
    if (!deptKeyInput && PRESIDIUM_ROLES.includes(role)) deptKeyInput = unionSvc.PRESIDIUM_KEY;
    const dept = await assertDept(deptKeyInput);
    // 部门 ↔ 职务必须匹配（主席团只有主席/副主席，见 assertRoleFitsDept 注释）
    assertRoleFitsDept(role, dept.key);
    // 部门归属校区校验（用户 2026-10-21「互不干扰」）：见 assertDeptFitsCampus 注释
    assertDeptFitsCampus(dept, level, schoolId);

    // 去重口径：分院成员新口径比「院校」而非「院系」——同一人在同校区同部门同一届次只允许一条，
    // 老数据（只有 departmentId、无 schoolId）仍按院系去重，两类互不误伤。
    const dupFilter = {
      userId: student._id,
      level,
      deptKey: dept.key,
      termId: str(body.termId, 40),
      status: 'active',
    };
    if (level === 'branch') {
      if (schoolId) dupFilter.schoolId = schoolId;
      else if (departmentId) dupFilter.departmentId = departmentId;
    }
    const exists = await UnionMember.findOne(dupFilter).lean();
    if (exists) throw new ApiError(409, 409001, '该成员在此部门已有在任记录');

    const doc = await UnionMember.create({
      userId: student._id,
      openid: student.openid || '',
      realName: student.realName || student.nickname || student.account || '',
      studentId: student.studentId || '',
      className: student.className || '',
      level,
      schoolId,
      schoolName,
      departmentId,
      departmentName,
      deptKey: dept.key,
      deptName: dept.name,
      role,
      termId: str(body.termId, 40),
      termName: str(body.termName, 60),
      remark: str(body.remark, 200),
      createdBy: req.user.openid || '',
    });
    unionSvc.clearIdentityCache(student.openid);
    ok(res, { member: presentMember(doc.toObject()) });
  })
);

router.put(
  '/members/:id',
  MANAGE,
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '成员不存在');
    const doc = await UnionMember.findById(req.params.id);
    if (!doc) throw new ApiError(404, 404, '成员不存在');
    const body = req.body || {};
    if (body.role !== undefined) {
      if (!ROLE_VALUES.includes(body.role)) throw new ApiError(400, 400, '职务不合法');
      doc.role = body.role;
    }
    let deptTouched = null; // 记住这次是否换了部门，供最后的校区归属校验用
    if (body.deptKey !== undefined) {
      const dept = await assertDept(body.deptKey);
      doc.deptKey = dept.key;
      doc.deptName = dept.name;
      deptTouched = dept;
    }
    // 院校（校区）：新口径。编辑时可改，必填（非空）
    if (body.schoolId !== undefined && doc.level === 'branch') {
      const school = await resolveCampusSchool(body.schoolId, { required: true });
      doc.schoolId = school.id;
      doc.schoolName = school.name;
    }
    // 院系：老口径兼容（前端仍传院系时照旧落库）
    if (body.departmentId !== undefined && doc.level === 'branch') {
      const dept = await resolveLegacyDepartment(body.departmentId, { required: false });
      doc.departmentId = dept.id;
      doc.departmentName = dept.name;
    }
    // ⚠️ 校区归属校验必须放在**两者都改完之后**：若先校验部门再改校区，
    // 用的还是旧校区 —— 于是「把洋河成员调进生活部、同时把校区改成北校区」这种
    // 需要拦的组合会被放行（校验时看到的还是洋河）。
    if (deptTouched || body.schoolId !== undefined) {
      const finalDept = deptTouched || (await assertDept(doc.deptKey));
      assertDeptFitsCampus(finalDept, doc.level, doc.schoolId);
    }
    // 部门 ↔ 职务匹配：两者任一被改都要重算最终组合（只改职务到主席团、或只改部门都算）
    if (body.role !== undefined || body.deptKey !== undefined) {
      assertRoleFitsDept(doc.role, doc.deptKey);
    }
    if (body.status !== undefined) doc.status = body.status === 'left' ? 'left' : 'active';
    if (body.termId !== undefined) doc.termId = str(body.termId, 40);
    if (body.termName !== undefined) doc.termName = str(body.termName, 60);
    if (body.remark !== undefined) doc.remark = str(body.remark, 200);
    await doc.save();
    unionSvc.clearIdentityCache(doc.openid);
    ok(res, { member: presentMember(doc.toObject()) });
  })
);

// 成员离任（软删除：保留历史，不物理删除）
router.delete(
  '/members/:id',
  MANAGE,
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '成员不存在');
    const doc = await UnionMember.findById(req.params.id);
    if (!doc) throw new ApiError(404, 404, '成员不存在');
    doc.status = 'left';
    doc.remark = `${doc.remark || ''} 离任于 ${dates.todayKey()}`.trim().slice(0, 200);
    await doc.save();
    unionSvc.clearIdentityCache(doc.openid);
    ok(res, { left: true });
  })
);

/**
 * 批量管理成员（用户 2026-10-21「学生会成员中增加批量管理操作(改职务、调部门、离任)」）。
 *
 * 入参：{ ids: string[], action: 'role' | 'dept' | 'leave', role?, deptKey? }
 *
 * 三条刻意的设计：
 *  ① **逐条校验、逐条落库**，不是一次 updateMany：成员的 level / schoolId 各不相同，
 *     「这个部门该校区能不能用」「主席/副主席是否必须挂主席团」都要按**每条记录**判。
 *     updateMany 一把梭会绕过这些守卫，造出「洋河成员 + 北校区部门」这类矛盾数据。
 *  ② **部分失败不清空已成功的**：几百条里有一条不合规就整体回滚，操作者要重做一遍；
 *     这里返回 { updated, failed:[{id,name,reason}] }，界面上明确告诉他哪几个没成、为什么。
 *  ③ 离任走**软删除**（status='left'），与单条 DELETE 完全同一口径，保留历史记录。
 */
router.post(
  '/members/bulk-update',
  MANAGE,
  wrap(async (req, res) => {
    const body = req.body || {};
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map((v) => String(v)))] : [];
    if (!ids.length) throw new ApiError(400, 400, '请先选择要操作的成员');
    if (ids.length > 200) throw new ApiError(400, 400, '单次最多操作 200 人');
    const action = str(body.action, 20);
    if (!['role', 'dept', 'leave'].includes(action)) throw new ApiError(400, 400, '不支持的操作');

    // 目标职务 / 部门先校验一次（所有成员共用的部分），避免每条重复报同一个错
    let nextRole = '';
    let deptDoc = null;
    if (action === 'role') {
      nextRole = str(body.role, 20);
      if (!ROLE_VALUES.includes(nextRole)) throw new ApiError(400, 400, '职务不合法');
    } else if (action === 'dept') {
      deptDoc = await assertDept(body.deptKey, { allowEmpty: false });
    }

    const docs = await UnionMember.find({ _id: { $in: ids.filter((x) => mongoose.isValidObjectId(x)) } });
    const found = new Map(docs.map((d) => [String(d._id), d]));
    const result = { updated: 0, failed: [] };
    const touchedOpenids = new Set();

    for (const id of ids) {
      const doc = found.get(id);
      if (!doc) {
        result.failed.push({ id, name: '', reason: '成员不存在（可能已被删除）' });
        continue;
      }
      try {
        if (action === 'leave') {
          if (doc.status === 'left') {
            result.failed.push({ id, name: doc.realName || '', reason: '已经是离任状态' });
            continue;
          }
          doc.status = 'left';
          doc.remark = `${doc.remark || ''} 离任于 ${dates.todayKey()}`.trim().slice(0, 200);
        } else if (action === 'role') {
          const finalDept = doc.deptKey || '';
          // 主席/副主席必须挂主席团；反之主席团成员只能是主席/副主席。
          // 单条改职务时会自动把 deptKey 改成 presidium（见 PUT /members/:id），这里保持同口径，
          // 否则「把某人改成主席」会因为他还在生活部而直接被拒 —— 那是限制而不是保护。
          if (PRESIDIUM_ROLES.includes(nextRole)) {
            doc.deptKey = unionSvc.PRESIDIUM_KEY;
            doc.deptName = '';
          }
          assertRoleFitsDept(nextRole, doc.deptKey);
          doc.role = nextRole;
          void finalDept;
        } else {
          // 调部门：必须按**该成员自己的** level / schoolId 校验归属
          assertDeptFitsCampus(deptDoc, doc.level, doc.schoolId);
          doc.deptKey = deptDoc.key;
          doc.deptName = deptDoc.name;
          assertRoleFitsDept(doc.role, doc.deptKey);
        }
        await doc.save();
        touchedOpenids.add(doc.openid);
        result.updated += 1;
      } catch (e) {
        result.failed.push({ id, name: doc.realName || '', reason: e.message || '更新失败' });
      }
    }

    // 身份缓存逐人失效：不就在权限上“改了但没生效”，而且复核范围也会用旧身份
    for (const openid of touchedOpenids) unionSvc.clearIdentityCache(openid);
    ok(res, result);
  })
);

// 候选学生搜索（添加成员用）：学号 / 姓名 / 账号 / 班级 关键字 + 班级 / 院系筛选
// 为什么要这个接口：学生会成员只能从**名单里已存在的账号**里选，让管理员手输学号或姓名
// 一定会出现「张伟 / 张玮」和学号打错 —— 搜索选择是唯一不会错的做法。
// 返回体刻意做薄（姓名 / 学号 / 班级 / 院系 / 是否已是成员 / 是否班主任），够画列表即可。
router.get(
  '/members/candidates',
  wrap(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { page: 1, limit: 20 });
    const cap = Math.min(limit, 50);
    const filter = { role: { $ne: 'teacher' } };
    const keyword = str(req.query.keyword, 40);
    if (keyword) {
      const re = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ realName: re }, { studentId: re }, { account: re }, { className: re }];
    }
    if (req.query.className) filter.className = str(req.query.className, 60);
    // 院校（校区）筛选：添加成员时按选中的院校收敛候选人（学籍里的院校多数只有文本名，故按 schoolName 匹配）
    if (req.query.school) filter.schoolName = str(req.query.school, 60);
    if (req.query.departmentId && mongoose.isValidObjectId(req.query.departmentId)) {
      filter.departmentId = req.query.departmentId;
    }
    // 默认不列已被软删/停用的账号，避免选了以后加不进来
    filter.status = { $ne: 'banned' };

    const [total, rows] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .select('realName nickname account studentId className departmentName specialty openid isClassOfficer homeroomClasses')
        .sort({ studentId: 1, realName: 1 })
        .skip(keyword ? 0 : skip)
        .limit(cap)
        .lean(),
    ]);

    // 已经是学生会成员的人：标记出来，避免重复添加
    const openids = rows.map((r) => r.openid).filter(Boolean);
    const existing = openids.length
      ? await UnionMember.find({ openid: { $in: openids }, status: 'active' })
          .select('openid deptName level')
          .lean()
      : [];
    const existBy = new Map();
    for (const m of existing) {
      const list = existBy.get(m.openid) || [];
      list.push(`${m.level === 'school' ? '校' : '分院'}${m.deptName || ''}`);
      existBy.set(m.openid, list);
    }

    ok(res, {
      page,
      limit: cap,
      total,
      hasMore: skip + rows.length < total,
      list: rows.map((u) => ({
        userId: String(u._id),
        name: u.realName || u.nickname || u.account || '未命名',
        studentId: u.studentId || '',
        className: u.className || '',
        departmentName: u.departmentName || '',
        specialty: u.specialty || '',
        isClassOfficer: !!u.isClassOfficer,
        isHomeroom: (u.homeroomClasses || []).length > 0,
        unionTags: existBy.get(u.openid) || [],
        subText: [u.className, u.departmentName, u.specialty].filter(Boolean).join(' · '),
      })),
    });
  })
);

// 批量添加成员：{ userIds: [], level, schoolId, departmentId, deptKey, role, termName }
// 用途：搜到一个班之后一次把整班班委 / 某个部门的新成员加进来（逐个失败不影响其它）
router.post(
  '/members/bulk',
  MANAGE,
  wrap(async (req, res) => {
    const body = req.body || {};
    const userIds = Array.isArray(body.userIds) ? [...new Set(body.userIds.map((v) => String(v)))] : [];
    if (!userIds.length) throw new ApiError(400, 400, '请先选择要添加的学生');
    if (userIds.length > 100) throw new ApiError(400, 400, '单次最多添加 100 人');

    const level = body.level === 'branch' ? 'branch' : 'school';
    let departmentId = null;
    let departmentName = '';
    let schoolId = null;
    let schoolName = '';
    if (level === 'branch') {
      const school = await resolveCampusSchool(body.schoolId, { required: true });
      schoolId = school.id;
      schoolName = school.name;
      const dept0 = await resolveLegacyDepartment(body.departmentId, { required: false });
      departmentId = dept0.id;
      departmentName = dept0.name;
    }
    const role = ROLE_VALUES.includes(body.role) ? body.role : 'member';
    let deptKeyInput = body.deptKey;
    if (!deptKeyInput && PRESIDIUM_ROLES.includes(role)) deptKeyInput = unionSvc.PRESIDIUM_KEY;
    const dept = await assertDept(deptKeyInput);
    // 批量加人同样要拦校区错配（否则一批人全是「洋河成员 + 北校区部门」）
    assertDeptFitsCampus(dept, level, schoolId);
    // 部门 ↔ 职务匹配：批量导入最容易出现「主席团 + 部员」这种组合
    assertRoleFitsDept(role, dept.key);
    const termId = str(body.termId, 40);

    const users = await User.find({ _id: { $in: userIds.filter((id) => mongoose.isValidObjectId(id)) } }).lean();
    const found = new Map(users.map((u) => [String(u._id), u]));
    const result = { created: 0, skipped: 0, failed: [] };
    const touched = new Set();

    for (const id of userIds) {
      const u = found.get(id);
      if (!u) {
        result.failed.push({ userId: id, reason: '学生不存在' });
        continue;
      }
      if (u.role === 'teacher') {
        result.failed.push({ userId: id, name: u.realName, reason: '教师账号不能加入学生会' });
        continue;
      }
      const dupFilter = { userId: u._id, level, deptKey: dept.key, termId, status: 'active' };
      if (level === 'branch') {
        if (schoolId) dupFilter.schoolId = schoolId;
        else if (departmentId) dupFilter.departmentId = departmentId;
      }
      const dup = await UnionMember.findOne(dupFilter).lean();
      if (dup) {
        result.skipped += 1;
        continue;
      }
      await UnionMember.create({
        userId: u._id,
        openid: u.openid || '',
        realName: u.realName || u.nickname || u.account || '',
        studentId: u.studentId || '',
        className: u.className || '',
        level,
        schoolId,
        schoolName,
        departmentId,
        departmentName,
        deptKey: dept.key,
        deptName: dept.name,
        role,
        termId,
        termName: str(body.termName, 60),
        createdBy: req.user.openid || '',
      });
      touched.add(u.openid);
      result.created += 1;
    }
    touched.forEach((o) => unionSvc.clearIdentityCache(o));
    ok(res, result);
  })
);

// 批量导入成员：{ rows: [{ studentId|realName|account, level, schoolName|schoolId|departmentName|departmentId, deptKey, role, termName }] }
// ⚠️ 导入表的「院校 / 院系」两列：新口径按**院校（校区）**匹配，老表里的**院系名**也继续认（向后兼容）。
//    匹配优先级：schoolId > schoolName（school 层）> 老表 departmentId > departmentName（department 层）。
//    只填了院系名 → 落 departmentId（老口径），展开鉴权时它照样直接计入 departmentIds。
router.post(
  '/members/import',
  MANAGE,
  wrap(async (req, res) => {
    const rows = Array.isArray((req.body || {}).rows) ? req.body.rows : [];
    if (!rows.length) throw new ApiError(400, 400, '没有可导入的数据');
    if (rows.length > 1000) throw new ApiError(400, 400, '单次最多导入 1000 条');

    // 校区（school）与院系（department）分别建索引：同名不同层不互相覆盖
    const [schoolOrgs, deptOrgs] = await Promise.all([
      Org.find({ type: 'school' }).lean().catch(() => []),
      Org.find({ type: 'department' }).lean().catch(() => []),
    ]);
    const schoolByName = new Map(schoolOrgs.map((o) => [o.name, o]));
    const deptByName = new Map(deptOrgs.map((o) => [o.name, o]));
    const depts = await UnionDepartment.find().lean();
    const deptKeys = new Set(depts.map((d) => d.key));
    const deptNameToKey = new Map(depts.map((d) => [d.name, d.key]));

    const result = { created: 0, skipped: 0, failed: [] };
    const touched = new Set();
    for (let i = 0; i < rows.length; i += 1) {
      const raw = rows[i] || {};
      const line = i + 1;
      try {
        const student = await findStudent(raw);
        if (!student) throw new Error('找不到学生');
        if (student.role === 'teacher') throw new Error('教师账号不能加入学生会');
        const level = raw.level === 'branch' || raw.level === '分院' ? 'branch' : 'school';
        let departmentId = null;
        let departmentName = '';
        let schoolId = null;
        let schoolName = '';
        if (level === 'branch') {
          // ① 校区：id 优先，其次按校区名（导入表写「北校区分会 / 北校区 / 洋河校区 / 教师院」）
          const byId = raw.schoolId && mongoose.isValidObjectId(raw.schoolId) ? await Org.findById(raw.schoolId).lean() : null;
          const school =
            (byId && byId.type === 'school' ? byId : null) ||
            schoolByName.get(str(raw.schoolName, 40)) ||
            schoolByName.get(str(raw.school || '', 40)) ||
            null;
          if (school) {
            schoolId = school._id;
            schoolName = school.name;
          }
          // ② 老口径：院系（id 或全名）—— 兼容旧导入表；新表只写院校时这里留空
          const deptById = raw.departmentId && mongoose.isValidObjectId(raw.departmentId) ? await Org.findById(raw.departmentId).lean() : null;
          const dept = (deptById && deptById.type === 'department' ? deptById : null) || deptByName.get(str(raw.departmentName, 40)) || null;
          if (dept) {
            departmentId = dept._id;
            departmentName = dept.name;
          }
          if (!schoolId && !departmentId) {
            throw new Error('院校不存在（请填院校全名，如 北校区 / 洋河校区 / 教师院；旧表填院系全名也可）');
          }
        }
        const role = ROLE_VALUES.includes(raw.role) ? raw.role : 'member';
        let deptKey = str(raw.deptKey, 32) || deptNameToKey.get(str(raw.deptName, 20)) || '';
        if (!deptKey && PRESIDIUM_ROLES.includes(role)) deptKey = unionSvc.PRESIDIUM_KEY;
        if (deptKey && !deptKeys.has(deptKey)) throw new Error(`部门 ${deptKey} 不存在`);
        // 部门 ↔ 职务匹配：导入表里「主席团 + 部长」这种组合必须单行报错，
        // 而不是整批 500 —— 一行写错不该拖累其余几百行。
        try {
          assertRoleFitsDept(role, deptKey);
        } catch (e) {
          throw new Error(e.message || '部门与职务不匹配');
        }
        const deptName = deptKey ? (depts.find((d) => d.key === deptKey) || {}).name || '' : '';

        const dupFilter = { userId: student._id, level, deptKey, termId: str(raw.termId, 40), status: 'active' };
        if (level === 'branch') {
          if (schoolId) dupFilter.schoolId = schoolId;
          else if (departmentId) dupFilter.departmentId = departmentId;
        }
        const dup = await UnionMember.findOne(dupFilter).lean();
        if (dup) {
          result.skipped += 1;
          continue;
        }
        await UnionMember.create({
          userId: student._id,
          openid: student.openid || '',
          realName: student.realName || student.nickname || student.account || '',
          studentId: student.studentId || '',
          className: student.className || '',
          level,
          schoolId,
          schoolName,
          departmentId,
          departmentName,
          deptKey,
          deptName,
          role,
          termId: str(raw.termId, 40),
          termName: str(raw.termName, 60),
          createdBy: req.user.openid || '',
        });
        touched.add(student.openid);
        result.created += 1;
      } catch (e) {
        result.failed.push({ line, name: str(raw.realName || raw.studentId, 30), reason: e.message });
      }
    }
    touched.forEach((o) => unionSvc.clearIdentityCache(o));
    ok(res, result);
  })
);

// ===================== 部门 =====================

router.get(
  '/departments',
  wrap(async (req, res) => {
    // 四个查询并发；departments 与 modules 一起取，是为了把「职责模块」按**真源**反推
    const [list, counts, modules, schoolOrgs] = await Promise.all([
      UnionDepartment.find().sort({ sort: 1, key: 1 }).lean(),
      UnionMember.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: { level: '$level', deptKey: '$deptKey' }, n: { $sum: 1 } } },
      ]),
      CheckModule.find().select('key name entryDeptKeys').lean(),
      // 院校名：schoolId 只是 ObjectId，界面要显示「洋河校区」而不是裸 id
      Org.find({ type: 'school' }).select('name').lean(),
    ]);
    const schoolNameById = new Map(schoolOrgs.map((s) => [String(s._id), s.name || '']));
    const cmap = new Map(counts.map((c) => [`${c._id.level}|${c._id.deptKey}`, c.n]));
    // ⚠️ 职责模块按 check_modules.entryDeptKeys **反推**，不再读 union_departments.dutyModules：
    //   后者是手写的第二份绑定，改了模块的录入部门它不会跟着变 → 界面显示一个与实际鉴权
    //   矛盾的"职责"（用户 2026-10-21「我自行配置职责模块即可」）。
    //   同时返回中文模块名，不再把 hygiene / study_evening 这种内部 key 甩给管理员。
    const dutyByDept = new Map();
    for (const m of modules) {
      for (const k of m.entryDeptKeys || []) {
        if (!dutyByDept.has(k)) dutyByDept.set(k, []);
        dutyByDept.get(k).push({ key: m.key, name: m.name || m.key });
      }
    }
    ok(res, {
      list: list.map((d) => ({
        id: String(d._id),
        key: d.key,
        name: d.name,
        scope: d.scope,
        // 归属校区（空 = 不限定，按 scope 挂到全校/所有院校）。
        // 前端「部门树」与「模块录入部门选择器」都按它分组，实现「北校区生活部 / 洋河卫生部」互不干扰。
        schoolId: d.schoolId ? String(d.schoolId) : '',
        schoolName: d.schoolId ? schoolNameById.get(String(d.schoolId)) || '' : '',
        dutyModules: (dutyByDept.get(d.key) || []).map((m) => m.key),
        dutyNames: (dutyByDept.get(d.key) || []).map((m) => m.name),
        // 主席团按设计就不参与录入（只读 + 复核），所以它「没有职责模块」是**正常状态**，
        // 不是配置缺失。前端需要这个区分，否则会显示成吓人的「未配置」。
        noEntryByDesign: d.key === unionSvc.PRESIDIUM_KEY,
        sort: d.sort || 0,
        enabled: d.enabled !== false,
        builtIn: !!d.builtIn,
        remark: d.remark || '',
        schoolCount: cmap.get(`school|${d.key}`) || 0,
        branchCount: cmap.get(`branch|${d.key}`) || 0,
      })),
      roleText: UnionMember.ROLE_TEXT,
    });
  })
);

/**
 * 部门标识（key）自动生成（用户 2026-10-21「部门标识自动生成」）。
 *
 * key 只是鉴权用的内部唯一键（check_modules.entryDeptKeys 存它），手填既麻烦又容易撞车。
 * 规则：优先用前端给的 key（老客户端仍兼容）；没给就按名称生成 ——
 *   英文/数字名 → 原样小写化（如 sports → sports）
 *   中文名     → dept+序号（如「体育部」→ dept1）；中文无法直接做 key（正则只允许 a-z0-9_-）
 * 冲突时追加 _2、_3…，**不报错**：管理员只想建个部门，不该被迫去猜哪个标识没被占用。
 */
async function generateDeptKey(nameHint, keyHint) {
  const KEY_RE = /^[a-z][a-z0-9_-]{1,31}$/;
  const given = str(keyHint, 32).toLowerCase();
  let base = '';
  if (KEY_RE.test(given)) {
    base = given;
  } else {
    // ⚠️ 只取**开头的**连续英文段，不能用 `replace(/[^a-z0-9]/g,'')` 把中文全清掉 ——
    //   那会把「临时体育部A」变成 "a"、「体育部」变成空串，生成一堆 a/b/c 这种无意义标识。
    //   规则：名称以英文开头 → 取开头那段（SportsTeam → sportsteam）；
    //        中文开头 → 用 dept 前缀，由下面的冲突处理补序号（dept、dept2…）。
    const head = String(nameHint || '').trim().toLowerCase().match(/^[a-z][a-z0-9_-]*/);
    base = head ? head[0].slice(0, 28) : 'dept';
  }
  if (!(await UnionDepartment.exists({ key: base }))) return base;
  // 冲突：base2、base3…（从 2 开始，避免 base1 这种奇怪命名）
  for (let i = 2; i < 200; i += 1) {
    const cand = `${base}${i}`;
    if (!(await UnionDepartment.exists({ key: cand }))) return cand;
  }
  throw new ApiError(400, 400, '部门标识已用尽，请换一个部门名称');
}

router.post(
  '/departments',
  MANAGE,
  wrap(async (req, res) => {
    const body = req.body || {};
    const name = str(body.name, 40);
    if (!name) throw new ApiError(400, 400, '请填写部门名称');
    // 标识自动生成；显式传了合法 key 则沿用（兼容老客户端/脚本）
    const key = await generateDeptKey(name, body.key);
    // schoolId 有值 = 只属于该校区（用户 2026-10-21「北校区有生活部、洋河叫卫生部，互不干扰」）；
    // 此时 scope 强制 'branch'，避免出现 schoolId=洋河 但 scope='school' 的自相矛盾数据。
    const schoolId = str(body.schoolId, 32);
    let schoolDoc = null;
    if (schoolId) {
      if (!mongoose.isValidObjectId(schoolId)) throw new ApiError(400, 400, '院校不存在');
      schoolDoc = await Org.findOne({ _id: schoolId, type: 'school' }).lean();
      if (!schoolDoc) throw new ApiError(400, 400, '院校不存在（部门只能挂到组织架构的「院校」层）');
    }
    const doc = await UnionDepartment.create({
      key,
      name,
      // 不再默认 'both'（那会让部门在每个校区都出现）：没指定校区就归校级
      scope: schoolDoc ? 'branch' : body.scope === 'branch' ? 'branch' : 'school',
      schoolId: schoolDoc ? schoolDoc._id : null,
      sort: Number(body.sort) || 99,
      enabled: body.enabled !== false,
      builtIn: false,
      remark: str(body.remark, 200),
    });
    ok(res, { id: String(doc._id), key: doc.key });
  })
);

router.put(
  '/departments/:id',
  MANAGE,
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '部门不存在');
    const doc = await UnionDepartment.findById(req.params.id);
    if (!doc) throw new ApiError(404, 404, '部门不存在');
    const body = req.body || {};
    // 只有**主席团**还锁着名称/范围（它的 key 与名称被代码当语义常量用于复核权限，
    // 且 seedUnionDepartments 每次启动会回写 —— 允许改就等于「改了当下生效、重启被抹掉」）。
    // 其余部门（含原内置的生活部/学习部/纪检部）现在完全归学校维护，名称与范围都可改。
    if (doc.builtIn) {
      const wantName = body.name !== undefined && str(body.name, 40) !== doc.name;
      const wantScope = body.scope !== undefined && body.scope !== doc.scope;
      if (wantName || wantScope) throw new ApiError(400, 400, '主席团的名称与归属范围固定，不可修改');
    } else {
      if (body.name !== undefined) doc.name = str(body.name, 40) || doc.name;
      if (body.scope !== undefined) doc.scope = ['school', 'branch', 'both'].includes(body.scope) ? body.scope : doc.scope;
    }
    // 归属校区可改，但**有在任成员时禁止**：成员的 deptKey 只存部门标识，
    // 归属变了会让「他在哪个校区」这件事静默改变（成员列表、分会范围判定全部跟着错），
    // 而管理员只是改了一条部门配置，看不出影响了几个人。
    if (body.schoolId !== undefined && str(body.schoolId, 32) !== String(doc.schoolId || '')) {
      const usedBy = await UnionMember.countDocuments({ deptKey: doc.key, status: 'active' });
      if (usedBy) {
        throw new ApiError(400, 400, `该部门还有 ${usedBy} 名在任成员，改归属校区会让他们的校区归属错乱；请先调整成员`);
      }
      const sid = str(body.schoolId, 32);
      if (sid) {
        if (!mongoose.isValidObjectId(sid)) throw new ApiError(400, 400, '院校不存在');
        const schoolDoc = await Org.findOne({ _id: sid, type: 'school' }).lean();
        if (!schoolDoc) throw new ApiError(400, 400, '院校不存在（部门只能挂到组织架构的「院校」层）');
        doc.schoolId = schoolDoc._id;
        doc.scope = 'branch'; // 挂到具体校区就不可能再是「全校」
      } else {
        doc.schoolId = null; // 显式清空 = 回到「不限定校区」，由 scope 决定挂哪几级
      }
    }
    // dutyModules 已废弃（真源是 check_modules.entryDeptKeys，GET 按它反推）：
    // 不再接收写入，否则会出现「存了一份没人用的绑定」，下一个人还会以为它有效。
    if (body.sort !== undefined) doc.sort = Number(body.sort) || 0;
    if (body.enabled !== undefined) doc.enabled = body.enabled !== false;
    if (body.remark !== undefined) doc.remark = str(body.remark, 200);
    await doc.save();
    unionSvc.clearIdentityCache();
    ok(res, { id: String(doc._id) });
  })
);

router.delete(
  '/departments/:id',
  MANAGE,
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '部门不存在');
    const doc = await UnionDepartment.findById(req.params.id);
    if (!doc) throw new ApiError(404, 404, '部门不存在');
    if (doc.builtIn) throw new ApiError(400, 400, '主席团不可删除（复核权限依赖它的标识）');
    const used = await UnionMember.countDocuments({ deptKey: doc.key, status: 'active' });
    if (used) throw new ApiError(400, 400, `还有 ${used} 名在任成员属于该部门，请先调整成员`);
    // ⚠️ 被模块当录入部门引用的，先要求改配置再删：删掉后 check_modules.entryDeptKeys
    //   会留下悬空 key，而鉴权是 fail-closed（services/union.js::canEnterModule 匹配不上就 403）
    //   —— 表现是「那个模块突然谁都录不了」，且界面上看不出原因。
    const holders = await CheckModule.find({ entryDeptKeys: doc.key }).select('name').lean();
    if (holders.length) {
      throw new ApiError(
        400,
        400,
        `「${holders.map((m) => m.name).join('、')}」仍把录入部门设为该部门，请先在「检查模块」里改配置`
      );
    }
    await UnionDepartment.deleteOne({ _id: doc._id });
    ok(res, { deleted: true });
  })
);

// ===================== 检查模块配置 =====================

router.get(
  '/modules',
  wrap(async (req, res) => {
    const [list, departments] = await Promise.all([
      CheckModule.find().sort({ sort: 1 }).lean(),
      UnionDepartment.find().sort({ sort: 1 }).lean(),
    ]);
    ok(res, {
      // list[].fields[].derived = true 的字段是**服务端推算**的只读字段（缺勤 / 未归）：
      // 前端不要渲染成输入框，管理端也不允许把它改成可填（PUT 里会强制回填）
      list,
      departments: departments.map((d) => ({ key: d.key, name: d.name })),
      periodOptions: [
        { key: '', label: '全天' },
        { key: 'morning', label: '早上' },
        { key: 'morning_class', label: '早八' },
        { key: 'daytime', label: '白天' },
        { key: 'evening_study', label: '晚自习' },
        { key: 'night', label: '夜间' },
      ],
    });
  })
);

router.put(
  '/modules/:key',
  MANAGE,
  wrap(async (req, res) => {
    const key = str(req.params.key, 32);
    const doc = await CheckModule.findOne({ key });
    if (!doc) throw new ApiError(404, 404, '检查模块不存在');
    const body = req.body || {};
    if (body.name !== undefined) doc.name = str(body.name, 40) || doc.name;
    if (body.shortName !== undefined) doc.shortName = str(body.shortName, 10);
    if (body.ownerDeptKey !== undefined) doc.ownerDeptKey = str(body.ownerDeptKey, 32);
    if (body.ownerDeptName !== undefined) doc.ownerDeptName = str(body.ownerDeptName, 20);
    if (body.entryDeptKeys !== undefined) {
      if (!Array.isArray(body.entryDeptKeys)) throw new ApiError(400, 400, 'entryDeptKeys 必须是数组');
      const keys = body.entryDeptKeys.map((k) => str(k, 32)).filter(Boolean);
      const found = await UnionDepartment.find({ key: { $in: keys } }).lean();
      const missing = keys.filter((k) => !found.some((f) => f.key === k));
      if (missing.length) throw new ApiError(400, 400, `部门不存在：${missing.join('、')}`);
      doc.entryDeptKeys = keys;
    }
    if (body.periods !== undefined && Array.isArray(body.periods)) doc.periods = body.periods.map((p) => str(p, 24));
    if (body.targetTypes !== undefined && Array.isArray(body.targetTypes)) {
      const allowed = ['classroom', 'dorm_room', 'area', 'class'];
      doc.targetTypes = body.targetTypes.map((t) => str(t, 16)).filter((t) => allowed.includes(t));
    }
    if (body.enabled !== undefined) doc.enabled = body.enabled !== false;
    if (body.sort !== undefined) doc.sort = Number(body.sort) || 0;
    if (body.remark !== undefined) doc.remark = str(body.remark, 200);
    if (body.scoring && typeof body.scoring === 'object') {
      const sc = body.scoring;
      if (['percent', 'rate', 'deduct'].includes(sc.mode)) doc.scoring.mode = sc.mode;
      if (sc.fullScore !== undefined) doc.scoring.fullScore = Math.max(0, Number(sc.fullScore) || 0);
      if (sc.weight !== undefined) doc.scoring.weight = Math.max(0, Number(sc.weight) || 0);
      if (sc.cap !== undefined) doc.scoring.cap = Math.max(0, Number(sc.cap) || 0);
    }
    // 指标公式：管理端可改，保存前必须校验语法（非法公式会让出勤率恒为 0）
    if (Array.isArray(body.metrics)) {
      for (const m of body.metrics) {
        const err = formula.validateFormula(m && m.formula);
        if (err) throw new ApiError(400, 400, `指标「${(m && m.name) || ''}」的公式不合法：${err}`);
      }
      doc.metrics = body.metrics.map((m) => ({
        key: str(m.key, 24),
        name: str(m.name, 20),
        unit: str(m.unit, 8),
        decimals: Number.isFinite(Number(m.decimals)) ? Number(m.decimals) : 0,
        formula: String(m.formula || ''),
        divisor: !!m.divisor,
      }));
    }
    // 字段定义：整体替换（type/key 必须齐全），避免半更新把表单渲染坏掉
    if (Array.isArray(body.fields)) {
      const allowedTypes = ['number', 'int', 'text', 'textarea', 'select', 'students', 'items', 'bool'];
      // 内置模块的派生字段（缺勤 / 未归）不允许被改成可填：客户端传什么都不作数，一律按代码定义强制 true
      // （这两项的公式在 services/check-modules.js::fillDerived 里，放开等于让前端能伪造人数）
      const defDerived = checkModules.derivedKeysOf(key);
      const fields = [];
      for (const f of body.fields) {
        const fkey = str(f && f.key, 32);
        const ftype = str(f && f.type, 16);
        if (!fkey || !allowedTypes.includes(ftype)) throw new ApiError(400, 400, '字段定义不合法（key / type 必填）');
        fields.push({
          key: fkey,
          label: str(f.label, 30),
          type: ftype,
          unit: str(f.unit, 8),
          min: f.min === undefined || f.min === null || f.min === '' ? null : Number(f.min),
          max: f.max === undefined || f.max === null || f.max === '' ? null : Number(f.max),
          maxItems: f.maxItems ? Number(f.maxItems) : null,
          required: !!f.required,
          default: f.default === undefined ? null : f.default,
          options: Array.isArray(f.options) ? f.options.map((o) => str(o, 30)) : [],
          placeholder: str(f.placeholder, 40),
          hint: str(f.hint, 80),
          formula: String(f.formula || ''),
          divisor: !!f.divisor,
          derived: defDerived.has(fkey) || !!f.derived,
        });
      }
      doc.fields = fields;
    }
    await doc.save();
    checkModules.clearCache();
    ok(res, { module: doc.toObject() });
  })
);

// 恢复内置默认（字段 / 指标 / 计分）：只恢复内置模块，且不动 entryDeptKeys
router.post(
  '/modules/:key/reset',
  MANAGE,
  wrap(async (req, res) => {
    const key = str(req.params.key, 32);
    const def = checkModules.defaultOf(key);
    if (!def) throw new ApiError(400, 400, '只有内置模块可以恢复默认');
    const doc = await CheckModule.findOne({ key });
    if (!doc) throw new ApiError(404, 404, '检查模块不存在');
    doc.fields = def.fields;
    doc.metrics = def.metrics;
    doc.scoring = def.scoring;
    doc.targetTypes = def.targetTypes;
    doc.periods = def.periods;
    await doc.save();
    checkModules.clearCache();
    ok(res, { module: doc.toObject() });
  })
);

// ===================== 班级台账 =====================

router.get(
  '/class-profiles',
  wrap(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { page: 1, limit: 20 });
    const filter = {};
    if (req.query.keyword) {
      const re = new RegExp(str(req.query.keyword, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.className = re;
    }
    if (req.query.departmentId && mongoose.isValidObjectId(req.query.departmentId)) filter.departmentId = req.query.departmentId;
    if (req.query.grade) filter.grade = String(req.query.grade);
    if (req.query.noMorningExercise === '1') filter.hasMorningExercise = false;
    if (req.query.noMorningClass === '1') filter.hasMorningClass = false;
    // 「不跑操」筛选（校园跑，与早操是两件事）
    if (req.query.noMorningRun === '1') filter.hasMorningRun = false;

    const [total, rows] = await Promise.all([
      ClassProfile.countDocuments(filter),
      ClassProfile.find(filter).sort({ className: 1 }).skip(skip).limit(limit).lean(),
    ]);
    // 人数实时统计（学籍 / 住宿名单），不使用台账里的历史快照
    const live = await liveCounts(rows.map((r) => r.className));
    ok(res, {
      page,
      limit,
      total,
      hasMore: skip + rows.length < total,
      list: rows.map((r) => {
        const c = live.get(r.className) || { studentCount: 0, dormCount: 0 };
        return {
          id: String(r._id),
          className: r.className,
          departmentId: r.departmentId ? String(r.departmentId) : '',
          departmentName: r.departmentName || '',
          grade: r.grade || '',
          specialty: r.specialty || '',
          studentCount: c.studentCount,
          dormCount: c.dormCount,
          hasMorningExercise: r.hasMorningExercise !== false,
          hasMorningClass: r.hasMorningClass !== false,
          // 晚自习（用户 2026-10-21）：false 的班级不进晚自习考勤、不计分母
          hasNightStudy: r.hasNightStudy !== false,
          // 是否参加校园跑（新增，默认 true）：与「是否有早操」语义分开，两个都是班级配置项
          hasMorningRun: r.hasMorningRun !== false,
          homeroomNames: r.homeroomNames || [],
          enabled: r.enabled !== false,
          syncedAt: r.syncedAt || null,
        };
      }),
    });
  })
);

// 从学籍同步（补新班 + 刷新人数字段，不动早操/早八标记）
router.post(
  '/class-profiles/sync',
  MANAGE,
  wrap(async (req, res) => {
    const result = await classProfilesSvc.syncClassProfiles({ className: str((req.body || {}).className, 60) || undefined });
    clearBandChaoCaches(); // 人数 / 院系 / 年级变了，排名缓存里的班级信息也要跟着刷新
    ok(res, result);
  })
);

// 批量标记早操 / 早八 / 晚自习（按年级或院系，或指定班级列表）
// 注意：校园跑标记（hasMorningRun）**不在**这里批量改 —— services/class-profiles.js::batchSetFlags 的
// 字段白名单只放行 hasMorningExercise / hasMorningClass / hasNightStudy；批量改校园跑需要同时扩那里的白名单
// （该文件不在本轮改动范围内）。单个班级改校园跑走下面的 PUT /class-profiles/:id
// 或 PUT /api/admin/class/:className/profile。
router.post(
  '/class-profiles/flags',
  MANAGE,
  wrap(async (req, res) => {
    const body = req.body || {};
    const FLAG_KEYS = ['hasMorningExercise', 'hasMorningClass', 'hasNightStudy'];
    const field = FLAG_KEYS.includes(body.field) ? body.field : 'hasMorningExercise';
    if (body.scope && body.scope.all === true) {
      const r = await ClassProfile.updateMany({}, { $set: { [field]: body.value !== false } });
      clearBandChaoCaches(); // 标记变了 → 录入台对象与出勤率分母都变了，缓存必须失效
      return ok(res, { matched: r.matchedCount, modified: r.modifiedCount });
    }
    const result = await classProfilesSvc.batchSetFlags({
      scope: {
        grade: body.scope && body.scope.grade,
        departmentId: body.scope && mongoose.isValidObjectId(body.scope.departmentId) ? body.scope.departmentId : undefined,
        classNames: Array.isArray(body.classNames) ? body.classNames : undefined,
      },
      field,
      value: body.value !== false,
    });
    clearBandChaoCaches();
    ok(res, result);
  })
);

router.put(
  '/class-profiles/:id',
  MANAGE,
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '班级不存在');
    const doc = await ClassProfile.findById(req.params.id);
    if (!doc) throw new ApiError(404, 404, '班级不存在');
    const body = req.body || {};
    if (body.hasMorningExercise !== undefined) doc.hasMorningExercise = body.hasMorningExercise !== false;
    if (body.hasMorningClass !== undefined) doc.hasMorningClass = body.hasMorningClass !== false;
    // 晚自习（用户 2026-10-21）：口径同早操，!== false 即 true
    if (body.hasNightStudy !== undefined) doc.hasNightStudy = body.hasNightStudy !== false;
    // 是否参加校园跑（与早操分开的班级配置项，口径同 hasMorningExercise：!== false 即 true）
    if (body.hasMorningRun !== undefined) doc.hasMorningRun = body.hasMorningRun !== false;
    // 应到 / 应住人数不接受手工设置：分别由学籍人数与住宿名单实时统计
    // （services/class-counts.js）。显式拒绝，避免旧前端以为写成功。
    if (body.studentCount !== undefined || body.dormCount !== undefined) {
      throw new ApiError(400, 400, '应到 / 应住人数由学籍与住宿名单自动识别，不支持手工设置');
    }
    if (body.enabled !== undefined) doc.enabled = body.enabled !== false;
    if (body.remark !== undefined) doc.remark = str(body.remark, 200);
    if (body.departmentId !== undefined && body.departmentId) {
      const org = await Org.findById(body.departmentId).lean();
      if (org) {
        doc.departmentId = org._id;
        doc.departmentName = org.name || '';
      }
    }
    if (body.grade !== undefined) doc.grade = str(body.grade, 8);
    await doc.save();
    // 早操 / 校园跑标记与人数会影响录入台对象列表、出勤率分母与班级排名 → 清掉 60s 排名缓存
    clearBandChaoCaches();
    ok(res, { id: String(doc._id) });
  })
);

// ===================== 宿舍（房间 + 住宿名单 + 导入） =====================

function presentRoom(r) {
  return {
    id: String(r._id),
    buildingId: r.buildingId || '',
    buildingName: r.buildingName || '',
    roomNo: r.roomNo,
    floor: r.floor || '',
    departmentId: r.departmentId ? String(r.departmentId) : '',
    departmentName: r.departmentName || '',
    className: r.className || '',
    gender: r.gender || 0,
    capacity: r.capacity || 0,
    residents: r.residents || 0,
    enabled: r.enabled !== false,
    remark: r.remark || '',
  };
}

router.get(
  '/dorms',
  wrap(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { page: 1, limit: 20 });
    const filter = {};
    if (req.query.building) filter.buildingName = String(req.query.building);
    if (req.query.className) filter.className = String(req.query.className);
    if (req.query.departmentId && mongoose.isValidObjectId(req.query.departmentId)) filter.departmentId = req.query.departmentId;
    if (req.query.keyword) filter.roomNo = new RegExp(str(req.query.keyword, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const [total, rows, buildings, assignCount, unassigned] = await Promise.all([
      DormRoom.countDocuments(filter),
      DormRoom.find(filter).sort({ buildingId: 1, roomNo: 1 }).skip(skip).limit(limit).lean(),
      DormRoom.aggregate([{ $group: { _id: { id: '$buildingId', name: '$buildingName' }, rooms: { $sum: 1 } } }]),
      DormAssignment.countDocuments({ status: { $in: ['checked_in', 'guest'] } }),
      DormAssignment.countDocuments({ status: { $in: ['checked_in', 'guest'] }, roomId: null }),
    ]);
    ok(res, {
      page,
      limit,
      total,
      hasMore: skip + rows.length < total,
      list: rows.map(presentRoom),
      buildings: buildings.map((b) => ({ id: b._id.id || '', name: b._id.name || b._id.id || '未命名楼栋', rooms: b.rooms })),
      assignCount,
      unassigned,
    });
  })
);

router.post(
  '/dorms',
  MANAGE,
  wrap(async (req, res) => {
    const body = req.body || {};
    const roomNo = str(body.roomNo, 20);
    if (!roomNo) throw new ApiError(400, 400, '房号必填');
    const buildingId = str(body.buildingId, 20);
    if (await DormRoom.exists({ buildingId, roomNo })) throw new ApiError(409, 409001, '该楼栋下房号已存在');
    const dept = body.departmentId && mongoose.isValidObjectId(body.departmentId) ? await Org.findById(body.departmentId).lean() : null;
    const doc = await DormRoom.create({
      buildingId,
      buildingName: str(body.buildingName, 30) || buildingId,
      roomNo,
      floor: str(body.floor, 10),
      departmentId: dept ? dept._id : null,
      departmentName: dept ? dept.name : str(body.departmentName, 30),
      className: str(body.className, 60),
      gender: [1, 2].includes(Number(body.gender)) ? Number(body.gender) : 0,
      capacity: Math.max(0, Number(body.capacity) || 0),
      remark: str(body.remark, 200),
    });
    ok(res, { room: presentRoom(doc.toObject()) });
  })
);

router.put(
  '/dorms/:id',
  MANAGE,
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '房间不存在');
    const doc = await DormRoom.findById(req.params.id);
    if (!doc) throw new ApiError(404, 404, '房间不存在');
    const body = req.body || {};
    if (body.buildingId !== undefined) doc.buildingId = str(body.buildingId, 20);
    if (body.buildingName !== undefined) doc.buildingName = str(body.buildingName, 30);
    if (body.roomNo !== undefined && str(body.roomNo, 20)) doc.roomNo = str(body.roomNo, 20);
    if (body.floor !== undefined) doc.floor = str(body.floor, 10);
    if (body.className !== undefined) doc.className = str(body.className, 60);
    if (body.capacity !== undefined) doc.capacity = Math.max(0, Number(body.capacity) || 0);
    if (body.gender !== undefined) doc.gender = [1, 2].includes(Number(body.gender)) ? Number(body.gender) : 0;
    if (body.enabled !== undefined) doc.enabled = body.enabled !== false;
    if (body.remark !== undefined) doc.remark = str(body.remark, 200);
    if (body.departmentId !== undefined) {
      const dept = body.departmentId && mongoose.isValidObjectId(body.departmentId) ? await Org.findById(body.departmentId).lean() : null;
      doc.departmentId = dept ? dept._id : null;
      doc.departmentName = dept ? dept.name : '';
    }
    await doc.save();
    ok(res, { room: presentRoom(doc.toObject()) });
  })
);

router.delete(
  '/dorms/:id',
  MANAGE,
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '房间不存在');
    const residents = await DormAssignment.countDocuments({ roomId: req.params.id, status: { $in: ['checked_in', 'guest'] } });
    if (residents) throw new ApiError(400, 400, `该房间还有 ${residents} 名在住学生，请先办理退宿/换房`);
    await DormRoom.deleteOne({ _id: req.params.id });
    ok(res, { deleted: true });
  })
);

// 住宿名单（按房间 or 按班级 or 关键字）
router.get(
  '/dorm-assignments',
  wrap(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { page: 1, limit: 20 });
    const filter = { status: { $in: ['checked_in', 'guest'] } };
    if (req.query.roomId && mongoose.isValidObjectId(req.query.roomId)) filter.roomId = req.query.roomId;
    if (req.query.className) filter.className = String(req.query.className);
    if (req.query.status) filter.status = String(req.query.status);
    if (req.query.keyword) {
      const re = new RegExp(str(req.query.keyword, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ realName: re }, { studentId: re }, { roomNo: re }];
    }
    const [total, rows] = await Promise.all([
      DormAssignment.countDocuments(filter),
      DormAssignment.find(filter).sort({ buildingId: 1, roomNo: 1, bedNo: 1 }).skip(skip).limit(limit).lean(),
    ]);
    ok(res, {
      page,
      limit,
      total,
      hasMore: skip + rows.length < total,
      list: rows.map((r) => ({
        id: String(r._id),
        realName: r.realName || '',
        studentId: r.studentId || '',
        className: r.className || '',
        buildingName: r.buildingName || r.buildingId || '',
        roomNo: r.roomNo || '',
        bedNo: r.bedNo || '',
        roomId: r.roomId ? String(r.roomId) : '',
        status: r.status,
        statusText: r.status === 'guest' ? '借住' : '在住',
        remark: r.remark || '',
      })),
    });
  })
);

// 住宿名单导入预览：multipart 表格（楼栋 / 房号 / 床位 / 学号 / 姓名）或 { payload } 文本
const dormPreviewCache = new Map(); // cacheId → { rows, expireAt }
const DORM_PREVIEW_TTL = 15 * 60 * 1000;

function pickHeader(row, keys) {
  for (const k of keys) {
    for (const rk of Object.keys(row)) {
      if (String(rk).replace(/\s/g, '') === k) return row[rk];
    }
  }
  return '';
}

function normalizeDormRows(rawRows) {
  const rows = [];
  const failed = [];
  rawRows.forEach((raw, i) => {
    const line = i + 1;
    const buildingName = str(pickHeader(raw, '楼栋') || pickHeader(raw, '宿舍楼') || pickHeader(raw, 'building'), 30);
    const roomNo = str(pickHeader(raw, '房号') || pickHeader(raw, '房间号') || pickHeader(raw, 'room'), 20);
    const bedNo = str(pickHeader(raw, '床位') || pickHeader(raw, '床号') || pickHeader(raw, 'bed'), 10);
    const studentId = str(pickHeader(raw, '学号') || pickHeader(raw, 'studentId'), 30);
    const realName = str(pickHeader(raw, '姓名') || pickHeader(raw, 'name'), 30);
    const className = str(pickHeader(raw, '班级') || pickHeader(raw, 'className'), 60);
    const floor = str(pickHeader(raw, '楼层') || pickHeader(raw, 'floor'), 10);
    if (!roomNo) return failed.push({ line, reason: '缺少房号' });
    if (!studentId && !realName) return failed.push({ line, reason: '缺少学号或姓名' });
    rows.push({ line, buildingId: buildingName, buildingName: buildingName || '未命名楼栋', roomNo, bedNo, floor, studentId, realName, className });
  });
  return { rows, failed };
}

router.post(
  '/dorms/import/preview',
  MANAGE,
  sheetUpload.single('file'),
  wrap(async (req, res) => {
    let rawRows = [];
    if (req.file) rawRows = roster.parseSheet(req.file.buffer);
    else rawRows = roster.parseRows((req.body || {}).payload);
    if (!rawRows.length) throw new ApiError(400, 400, '未解析到数据（表头需含「楼栋 / 房号 / 学号」）');
    const { rows, failed } = normalizeDormRows(rawRows);

    // 匹配学生（学号优先，其次姓名）：匹配不到的照样允许导入（房间台账先建，人后面再补）
    const ids = rows.map((r) => r.studentId).filter(Boolean);
    const names = rows.map((r) => r.realName).filter(Boolean);
    const users = await User.find({
      $or: [{ studentId: { $in: ids } }, { realName: { $in: names } }],
    })
      .select('openid realName studentId className')
      .lean();
    const byId = new Map(users.filter((u) => u.studentId).map((u) => [u.studentId, u]));
    const byName = new Map();
    users.forEach((u) => {
      if (u.realName) byName.set(u.realName, u);
    });

    const preview = rows.map((r) => {
      const u = (r.studentId && byId.get(r.studentId)) || (r.realName && byName.get(r.realName)) || null;
      return {
        ...r,
        matched: !!u,
        name: u ? u.realName || '' : r.realName,
        studentId: u ? u.studentId || r.studentId : r.studentId,
        className: (u && u.className) || r.className,
        matchText: u ? '已匹配学籍' : '未匹配到学生（将只建房间台账）',
      };
    });

    const now = Date.now();
    for (const [k, v] of dormPreviewCache) if (v.expireAt <= now) dormPreviewCache.delete(k);
    const cacheId = crypto.randomUUID();
    dormPreviewCache.set(cacheId, { rows: preview, expireAt: now + DORM_PREVIEW_TTL });

    ok(res, {
      cacheId,
      total: rawRows.length,
      valid: preview.length,
      failedCount: failed.length,
      failed,
      matchedCount: preview.filter((p) => p.matched).length,
      preview: preview.slice(0, 20),
    });
  })
);

router.post(
  '/dorms/import/confirm',
  MANAGE,
  wrap(async (req, res) => {
    const cacheId = str((req.body || {}).cacheId, 64);
    const cached = dormPreviewCache.get(cacheId);
    if (!cached || cached.expireAt <= Date.now()) {
      dormPreviewCache.delete(cacheId);
      throw new ApiError(410, 410, '预览已过期，请重新选择文件解析');
    }
    const total = cached.rows.length;
    const chunked = (req.body || {}).offset != null;
    const offset = chunked ? Math.max(0, Math.min(total, Number(req.body.offset) || 0)) : 0;
    const limit = chunked ? Math.max(1, Math.min(500, Number(req.body.limit) || 200)) : total;
    const slice = cached.rows.slice(offset, offset + limit);

    const result = { createdRooms: 0, createdAssignments: 0, moved: 0, skipped: 0, failed: [] };
    const touchedClasses = new Set();
    for (const row of slice) {
      try {
        const room = await DormRoom.findOneAndUpdate(
          { buildingId: row.buildingId || '', roomNo: row.roomNo },
          {
            $setOnInsert: {
              buildingId: row.buildingId || '',
              buildingName: row.buildingName || row.buildingId || '',
              roomNo: row.roomNo,
              floor: row.floor || '',
              className: row.className || '',
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        if (!room.className && row.className) {
          room.className = row.className;
          await room.save();
        }
        const isNewRoom = Math.abs(new Date(room.createdAt).getTime() - Date.now()) < 3000;
        if (isNewRoom) result.createdRooms += 1;

        const u = row.matched
          ? await User.findOne({ studentId: row.studentId }).select('openid realName studentId className').lean()
          : null;
        const openid = u ? u.openid : '';
        if (!openid) {
          result.skipped += 1;
          continue;
        }
        const active = await DormAssignment.findOne({ openid, status: { $in: ['checked_in', 'guest'] } });
        if (active) {
          if (String(active.roomId) === String(room._id) && (active.bedNo || '') === (row.bedNo || '')) {
            result.skipped += 1;
            continue;
          }
          active.status = 'moved';
          active.movedTo = `${room.buildingName || room.buildingId} ${room.roomNo}`;
          await active.save();
          touchedClasses.add(active.className || '');
          result.moved += 1;
        }
        await DormAssignment.create({
          userId: u._id,
          openid,
          realName: u.realName || row.realName || '',
          studentId: u.studentId || row.studentId || '',
          className: u.className || row.className || '',
          roomId: room._id,
          buildingId: room.buildingId,
          buildingName: room.buildingName,
          roomNo: room.roomNo,
          bedNo: row.bedNo || '',
          status: 'checked_in',
        });
        touchedClasses.add(u.className || row.className || '');
        result.createdAssignments += 1;
      } catch (e) {
        result.failed.push({ line: row.line, room: `${row.buildingName} ${row.roomNo}`, reason: e.message });
      }
    }

    // 房间住宿人数与班级应住人数回填（展示用）
    for (const cn of touchedClasses) if (cn) await classProfilesSvc.refreshDormCounts(cn);

    const next = offset + limit;
    const done = !chunked || next >= total;
    if (done) dormPreviewCache.delete(cacheId);
    ok(res, { ...result, offset: next, total, done });
  })
);

// 退宿 / 换房（手工调整）
router.put(
  '/dorm-assignments/:id',
  MANAGE,
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '住宿记录不存在');
    const doc = await DormAssignment.findById(req.params.id);
    if (!doc) throw new ApiError(404, 404, '住宿记录不存在');
    const body = req.body || {};
    if (body.status === 'checked_out') {
      doc.status = 'checked_out';
      await doc.save();
      await classProfilesSvc.refreshDormCounts(doc.className || '');
      return ok(res, { status: doc.status });
    }
    if (body.roomId) {
      if (!mongoose.isValidObjectId(body.roomId)) throw new ApiError(400, 400, '房间不存在');
      const room = await DormRoom.findById(body.roomId).lean();
      if (!room) throw new ApiError(400, 400, '房间不存在');
      doc.status = 'moved';
      doc.movedTo = `${room.buildingName || room.buildingId} ${room.roomNo}`;
      await doc.save();
      await DormAssignment.create({
        userId: doc.userId,
        openid: doc.openid,
        realName: doc.realName,
        studentId: doc.studentId,
        className: doc.className,
        roomId: room._id,
        buildingId: room.buildingId,
        buildingName: room.buildingName,
        roomNo: room.roomNo,
        bedNo: str(body.bedNo, 10),
        status: 'checked_in',
      });
      await classProfilesSvc.refreshDormCounts(doc.className || '');
      return ok(res, { moved: true });
    }
    if (body.bedNo !== undefined) doc.bedNo = str(body.bedNo, 10);
    if (body.remark !== undefined) doc.remark = str(body.remark, 200);
    await doc.save();
    ok(res, { id: String(doc._id) });
  })
);

// ===================== 卫生区 =====================

function presentArea(a) {
  return {
    id: String(a._id),
    name: a.name,
    areaType: a.areaType || 'outdoor',
    location: a.location || '',
    classNames: a.classNames || [],
    weights: a.weights || {},
    departmentId: a.departmentId ? String(a.departmentId) : '',
    departmentName: a.departmentName || '',
    enabled: a.enabled !== false,
    remark: a.remark || '',
  };
}

router.get(
  '/areas',
  wrap(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { page: 1, limit: 20 });
    const filter = {};
    if (req.query.areaType) filter.areaType = String(req.query.areaType);
    if (req.query.className) filter.classNames = String(req.query.className);
    if (req.query.keyword) filter.name = new RegExp(str(req.query.keyword, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const [total, rows] = await Promise.all([
      SanitaryArea.countDocuments(filter),
      SanitaryArea.find(filter).sort({ areaType: 1, name: 1 }).skip(skip).limit(limit).lean(),
    ]);
    ok(res, {
      page,
      limit,
      total,
      hasMore: skip + rows.length < total,
      list: rows.map(presentArea),
      areaTypes: [
        { key: 'classroom', label: '教室区' },
        { key: 'outdoor', label: '室外区' },
        { key: 'corridor', label: '楼道' },
        { key: 'canteen', label: '食堂' },
        { key: 'other', label: '其他' },
      ],
    });
  })
);

router.post(
  '/areas',
  MANAGE,
  wrap(async (req, res) => {
    const body = req.body || {};
    const name = str(body.name, 40);
    if (!name) throw new ApiError(400, 400, '区域名称必填');
    const classNames = Array.isArray(body.classNames) ? body.classNames.map((c) => str(c, 60)).filter(Boolean) : [];
    const weights = {};
    if (body.weights && typeof body.weights === 'object') {
      for (const [k, v] of Object.entries(body.weights)) weights[str(k, 60)] = Math.max(0, Number(v) || 0);
    }
    const dept = body.departmentId && mongoose.isValidObjectId(body.departmentId) ? await Org.findById(body.departmentId).lean() : null;
    const doc = await SanitaryArea.create({
      name,
      areaType: str(body.areaType, 16) || 'outdoor',
      location: str(body.location, 60),
      classNames,
      weights,
      departmentId: dept ? dept._id : null,
      departmentName: dept ? dept.name : str(body.departmentName, 30),
      enabled: body.enabled !== false,
      remark: str(body.remark, 200),
    });
    ok(res, { area: presentArea(doc.toObject()) });
  })
);

router.put(
  '/areas/:id',
  MANAGE,
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '卫生区不存在');
    const doc = await SanitaryArea.findById(req.params.id);
    if (!doc) throw new ApiError(404, 404, '卫生区不存在');
    const body = req.body || {};
    if (body.name !== undefined && str(body.name, 40)) doc.name = str(body.name, 40);
    if (body.areaType !== undefined) doc.areaType = str(body.areaType, 16) || doc.areaType;
    if (body.location !== undefined) doc.location = str(body.location, 60);
    if (body.classNames !== undefined && Array.isArray(body.classNames)) {
      doc.classNames = body.classNames.map((c) => str(c, 60)).filter(Boolean);
    }
    if (body.weights !== undefined && body.weights && typeof body.weights === 'object') {
      const w = {};
      for (const [k, v] of Object.entries(body.weights)) w[str(k, 60)] = Math.max(0, Number(v) || 0);
      doc.weights = w;
    }
    if (body.enabled !== undefined) doc.enabled = body.enabled !== false;
    if (body.remark !== undefined) doc.remark = str(body.remark, 200);
    if (body.departmentId !== undefined) {
      const dept = body.departmentId && mongoose.isValidObjectId(body.departmentId) ? await Org.findById(body.departmentId).lean() : null;
      doc.departmentId = dept ? dept._id : null;
      doc.departmentName = dept ? dept.name : '';
    }
    await doc.save();
    ok(res, { area: presentArea(doc.toObject()) });
  })
);

router.delete(
  '/areas/:id',
  MANAGE,
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '卫生区不存在');
    await SanitaryArea.deleteOne({ _id: req.params.id });
    ok(res, { deleted: true });
  })
);

// ===================== 检查记录（查询 / 统计 / 导出 / 作废） =====================

function recordFilter(req) {
  const filter = {};
  if (req.query.moduleKey) filter.moduleKey = String(req.query.moduleKey);
  if (req.query.className) filter.className = String(req.query.className);
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.departmentId && mongoose.isValidObjectId(req.query.departmentId)) filter.departmentId = req.query.departmentId;
  if (req.query.includeVoided !== '1') filter.voided = { $ne: true };
  const date = str(req.query.date, 10);
  const from = str(req.query.from, 10);
  const to = str(req.query.to, 10);
  if (date) filter.date = date;
  else if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = from;
    if (to) filter.date.$lte = to;
  }
  return filter;
}

router.get(
  '/records',
  wrap(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { page: 1, limit: 20 });
    const filter = recordFilter(req);
    const [total, rows, modules] = await Promise.all([
      CheckRecord.countDocuments(filter),
      CheckRecord.find(filter).sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      checkModules.listModules(),
    ]);
    const cls = await ClassProfile.find({ className: { $in: rows.map((r) => r.className).filter(Boolean) } })
      .select('className departmentName grade')
      .lean();
    const cmap = new Map(cls.map((c) => [c.className, c]));
    const nameOf = new Map(modules.map((m) => [m.key, m.shortName || m.name]));
    ok(res, {
      page,
      limit,
      total,
      hasMore: skip + rows.length < total,
      list: rows.map((r) => ({
        id: String(r._id),
        moduleKey: r.moduleKey,
        moduleName: nameOf.get(r.moduleKey) || r.moduleKey,
        date: r.date,
        period: r.period || '',
        targetType: r.targetType,
        targetName: r.targetName || '',
        className: r.className || '',
        departmentName: (cmap.get(r.className) || {}).departmentName || '',
        inspectorName: r.inspectorName || '',
        inspectorDeptKey: r.inspectorDeptKey || '',
        score: r.score,
        deduct: r.deduct,
        status: r.status,
        appealStatus: (r.appeal && r.appeal.status) || '',
        revision: r.revision || 1,
        voided: !!r.voided,
        createdAt: r.createdAt,
      })),
      modules: modules.map((m) => ({ key: m.key, name: m.shortName || m.name })),
    });
  })
);

router.get(
  '/records/stats',
  wrap(async (req, res) => {
    const filter = recordFilter(req);
    filter.status = { $in: CheckRecord.COUNTED_STATUS };
    const [byClass, byModule, byDay] = await Promise.all([
      CheckRecord.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$className',
            deduct: { $sum: '$deduct' },
            count: { $sum: 1 },
            days: { $addToSet: '$date' },
          },
        },
        { $project: { deduct: 1, count: 1, days: { $size: '$days' } } },
        { $sort: { deduct: -1 } },
        { $limit: 200 },
      ]),
      CheckRecord.aggregate([
        { $match: filter },
        { $group: { _id: '$moduleKey', deduct: { $sum: '$deduct' }, count: { $sum: 1 } } },
      ]),
      CheckRecord.aggregate([
        { $match: filter },
        { $group: { _id: '$date', deduct: { $sum: '$deduct' }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
        { $limit: 400 },
      ]),
    ]);
    const modules = await checkModules.listModules();
    const nameOf = new Map(modules.map((m) => [m.key, m.shortName || m.name]));
    ok(res, {
      classes: byClass.map((c) => ({
        className: c._id || '未分班',
        deduct: Math.round((c.deduct || 0) * 10) / 10,
        avgDeduct: c.days ? Math.round(((c.deduct || 0) / c.days) * 10) / 10 : 0,
        days: c.days,
        score: c.days ? Math.round((100 - (c.deduct || 0) / c.days) * 10) / 10 : null,
        recordCount: c.count,
      })),
      modules: byModule.map((m) => ({
        key: m._id,
        name: nameOf.get(m._id) || m._id,
        deduct: Math.round((m.deduct || 0) * 10) / 10,
        recordCount: m.count,
      })),
      days: byDay.map((d) => ({ date: d._id, deduct: Math.round((d.deduct || 0) * 10) / 10, recordCount: d.count })),
    });
  })
);

// CSV 导出（带 BOM，Excel 直接双击不乱码）；上限 5000 行，超过请缩小区间
router.get(
  '/records/export',
  MANAGE,
  wrap(async (req, res) => {
    const filter = recordFilter(req);
    const rows = await CheckRecord.find(filter).sort({ date: 1, className: 1, moduleKey: 1 }).limit(5000).lean();
    const modules = await checkModules.listModules();
    const nameOf = new Map(modules.map((m) => [m.key, m.name]));
    const header = ['日期', '时段', '检查模块', '受检对象', '班级', '得分', '扣分', '状态', '检查人', '部门', '备注', '申诉'];
    const cell = (v) => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [header.map(cell).join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.date,
          r.period || '',
          nameOf.get(r.moduleKey) || r.moduleKey,
          r.targetName || r.className || '',
          r.className || '',
          r.score,
          r.deduct,
          r.status,
          r.inspectorName || '',
          r.inspectorDeptKey || '',
          r.remark || (r.cancelReason ? `取消：${r.cancelReason}` : ''),
          (r.appeal && r.appeal.status) || '',
        ]
          .map(cell)
          .join(',')
      );
    }
    const csv = `\uFEFF${lines.join('\r\n')}`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="banchao-${dates.todayKey()}.csv"`);
    res.send(csv);
  })
);

// 作废记录（软失效：保留数据与留痕，不计入统计）
router.post(
  '/records/:id/void',
  MANAGE,
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 404, '记录不存在');
    const record = await CheckRecord.findById(req.params.id);
    if (!record) throw new ApiError(404, 404, '记录不存在');
    const reason = str((req.body || {}).reason, 200);
    if (reason.length < 2) throw new ApiError(400, 400, '请填写作废原因');
    record.voided = true;
    record.status = 'cancelled';
    record.cancelReason = `管理员作废：${reason}`.slice(0, 200);
    record.revision = (record.revision || 1) + 1;
    record.history = [
      ...(record.history || []).slice(-19),
      {
        revision: record.revision,
        at: new Date(),
        by: req.user.openid || '',
        byName: req.user.realName || req.user.nickname || '',
        changes: { voided: { from: false, to: true }, reason: { to: reason } },
      },
    ];
    await record.save();
    ok(res, { voided: true });
  })
);

// ===================== 班超总览 =====================

router.get(
  '/dashboard',
  wrap(async (req, res) => {
    const date = dates.isValidDateKey(str(req.query.date, 10)) ? str(req.query.date, 10) : dates.todayKey();
    const modules = await checkModules.listModules();
    const scopeRange = bandChao.rangeOf('week', date);

    const [todayRecords, ranking, appealPending, totalRecords] = await Promise.all([
      CheckRecord.find({ date, voided: { $ne: true } }).select('moduleKey status className inspectorName').lean(),
      bandChao.classRanking({ from: scopeRange.from, to: scopeRange.to, departmentIds: [] }),
      CheckRecord.countDocuments({ 'appeal.status': 'pending', voided: { $ne: true } }),
      CheckRecord.estimatedDocumentCount(),
    ]);

    const byModule = modules
      .filter((m) => m.enabled !== false)
      .map((m) => {
        const rows = todayRecords.filter((r) => r.moduleKey === m.key);
        return {
          key: m.key,
          name: m.shortName || m.name,
          ownerDeptName: m.ownerDeptName || '',
          entered: rows.filter((r) => ['submitted', 'approved'].includes(r.status)).length,
          cancelled: rows.filter((r) => r.status === 'cancelled').length,
          classes: new Set(rows.map((r) => r.className).filter(Boolean)).size,
        };
      });

    const [classCount, memberCount, pendingReview] = await Promise.all([
      ClassProfile.countDocuments({ enabled: { $ne: false } }),
      UnionMember.countDocuments({ status: 'active' }),
      CheckRecord.countDocuments({ status: 'submitted', voided: { $ne: true } }),
    ]);

    ok(res, {
      date,
      classCount,
      memberCount,
      totalRecords,
      pendingReview,
      appealPending,
      modules: byModule,
      weekRange: scopeRange,
      rankingTop: ranking.top,
      rankingBottom: ranking.bottom,
    });
  })
);

module.exports = router;
