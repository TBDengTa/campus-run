/**
 * 学生会组织与身份服务
 *
 * 职责：
 *   1. seedUnionDepartments() —— 启动期幂等播种内置部门（主席团 / 生活部 / 学习部 / 纪检部），
 *      写法与 services/rbac.js、services/ads.js 的内置播种一致：内置项不可删、key 不可改；
 *   2. resolveIdentity(user) —— 解析「这个人的学生会身份」：成员记录、可录入模块、复核范围。
 *      **服务端鉴权一律走这里**，客户端下发的字段只用于渲染；
 *   3. presentUser(user) —— 给 /api/auth/me 等出口补 isUnionMember / unionRoles / unionText
 *      （不落库、不建缓存字段，避免成员换届后出现「改了库、客户端还是老身份」的脏读）；
 *   4. 宿舍照片隐私 —— isDormPhotoRecord / canViewDormPhotos / cropPhotos 是**唯一实现处**
 *      （宿舍照片可见者四条判定与「无原图 URL 的模糊占位」形状都在本文件，routes/union.js
 *      的 presentRecord 只调用、不复刻判定）。
 *
 * ===== 院校（校区）→ 院系的「展开」口径（本文件是唯一实现处）=====
 * 学生会成员按**院校（校区）**绑定：union_members.schoolId → organizations.type='school'（北校区 / 洋河校区 / 教师院）。
 * 但 check_records.departmentId 存的是**班级所属院系**（type='department'），
 * 所以不能把校区 id 塞进 departmentId —— 那样分会成员一条记录都看不到。
 * 做法：鉴权时把「成员所绑校区」展开成它下面**全部院系 id**，再喂给既有判定，
 * 于是 canEnterModule / canReview / scopeFilter / bandChao.classRanking **全部原样工作**，
 * check_records 一个字段都不用加。老数据（branch 记录只有 departmentId）继续按老口径并入同一份 id 列表。
 */
const memberModel = require('../models/union-member');
const unionDeptModel = require('../models/union-department');
const CheckModule = require('../models/check-module');
const Organization = require('../models/organization');
const mongoose = require('mongoose');

// 主席团部门 key（复核权与「主席团」身份的判定基准）
const PRESIDIUM_KEY = 'presidium';
const ROLE_TEXT = memberModel.ROLE_TEXT;

// ===== 播种 =====
/**
 * 只有**主席团**每次启动按默认值回写（它的 key 被代码当语义常量用于复核权限判定，
 * 名称/范围被改会让权限口径与显示对不上，所以锁住）。
 *
 * 其余部门（含原来内置的生活部/学习部/纪检部）**只在缺失时创建**，存在即不动 ——
 * 用户 2026-10-21「这几个内置应该不需要内置，我自行配置职责模块即可」。
 * 旧实现对所有 DEFAULT_DEPARTMENTS 都 $set 回写 builtIn/scope/name/dutyModules，
 * 于是学校改名、停用、配职责都会被下次启动**静默抹掉**（与权限组那轮同一类"假生效"）。
 * 删掉的部门也不该被播种"复活"：那是用户明确的意图。
 */
async function seedUnionDepartments() {
  const result = { created: 0, updated: 0 };
  for (const def of unionDeptModel.DEFAULT_DEPARTMENTS) {
    const exists = await unionDeptModel.findOne({ key: def.key }).lean();
    if (!exists) {
      await unionDeptModel.create(def);
      result.created += 1;
      continue;
    }
    if (def.key !== PRESIDIUM_KEY) {
      // ⚠️ 存量库里这三个部门的 builtIn 仍是 true（旧播种写进去的）。
      // 不清掉的话：界面上还挂着「内置」标签、删除接口继续以「内置不可删」拒绝 ——
      // 用户要的「不需要内置」就完全没生效。这里做一次性归位，且只清 builtIn，
      // 不动名称/范围/职责（那些归学校维护）。
      if (exists.builtIn) {
        await unionDeptModel.updateOne({ key: def.key }, { $set: { builtIn: false } });
        result.updated += 1;
      }
      continue; // 普通部门：存在即归学校自己维护
    }
    await unionDeptModel.updateOne(
      { key: def.key },
      { $set: { builtIn: true, scope: def.scope, name: def.name } }
    );
    result.updated += 1;
  }
  return result;
}

// ===== 院校（校区）→ 院系展开 =====

/**
 * 批量查「这些院校（校区）下各有哪些院系」。
 *
 * 假设（与 routes/admin/content.js 的 ORG_CHILD_TYPE 一致）：组织树固定三层
 * school → department → specialty，因此「校区 → 院系」只需查 parentId 一层（不需要递归）。
 * 若未来层级变深（系部挂到 specialty 下），这里要改成递归 —— 改动前请先看 ORG_CHILD_TYPE。
 *
 * 查不到（校区下还没配任何系部 / id 非法）时返回空集合，**不抛错**：
 * 「校区下没有系部」是运营没配好组织架构，不是请求错误，报错会让调用方更难给出可读提示。
 *
 * @param {Array<string|ObjectId>} schoolIds
 * @returns {Promise<{ deptIds: string[], counts: Map<string, number>, names: Map<string,string> }>}
 *          deptIds = 全部院系 id（去重）；counts[校区id] = 该校区下院系数；names 仅内部占位（见 resolveIdentity）
 */
async function campusDepartmentIndex(schoolIds) {
  const ids = (Array.isArray(schoolIds) ? schoolIds : [schoolIds])
    .map((v) => (v === undefined || v === null ? '' : String(v)))
    .filter((v) => v && mongoose.isValidObjectId(v));
  const counts = new Map(ids.map((id) => [id, 0]));
  if (!ids.length) return { deptIds: [], counts, names: new Map() };

  const depts = await Organization.find({ type: 'department', parentId: { $in: ids } })
    .select('_id parentId')
    .lean();
  const deptIdSet = new Set();
  for (const d of depts || []) {
    if (!d || !d._id) continue;
    const did = String(d._id);
    deptIdSet.add(did);
    const pid = d.parentId ? String(d.parentId) : '';
    if (counts.has(pid)) counts.set(pid, counts.get(pid) + 1);
    else counts.set(pid, 1);
  }
  return { deptIds: [...deptIdSet], counts, names: new Map() };
}

/**
 * 把院校（校区）id 展开成其下**全部院系 id**（服务层的单一来源，管理端与鉴权共用）。
 * @param {Array<string|ObjectId>} schoolIds
 * @returns {Promise<string[]>}
 */
async function expandCampusDepartments(schoolIds) {
  const { deptIds } = await campusDepartmentIndex(schoolIds);
  return deptIds;
}

// ===== 身份解析 =====

const CACHE_TTL = 30 * 1000;
const identityCache = new Map(); // openid → { at, identity }

function clearIdentityCache(openid) {
  if (openid) identityCache.delete(openid);
  else identityCache.clear();
}

/**
 * 构建身份对象（不查库，纯计算）
 *
 * @param {Array} memberRecords active 成员记录
 * @param {Array} modules check_modules
 * @param {{deptIds?: string[], counts?: Map<string, number>}} [campusDepts]
 *        由 resolveIdentity 用 IO 查好的「校区 → 院系」展开结果；不传 = 只有老口径的 departmentId。
 *        为什么把 IO 留在调用方：buildIdentity 保持纯函数，方便单测与缓存命中路径复用。
 * @returns {{
 *   isMember: boolean, members: Array, level: 'school'|'branch'|'',
 *   departmentId: string, departmentIds: string[], departments: string[],
 *   schoolIds: string[], schoolNames: string[], campusesMissingDepartments: Array<{id:string,name:string}>,
 *   canEnterDeptKeys: string[],
 *   modules: string[](可录入模块), viewModules: string[](可见模块),
 *   isPresidium: boolean, reviewLevel: ''|'school'|'branch', roles: Array, roleText: string
 * }}
 */
function buildIdentity(memberRecords, modules, campusDepts = {}) {
  const members = memberRecords || [];
  const isMember = members.length > 0;
  const schoolRecords = members.filter((m) => m.level === 'school');
  const branchRecords = members.filter((m) => m.level === 'branch');
  const level = schoolRecords.length ? 'school' : branchRecords.length ? 'branch' : '';

  // 分院身份可能来自多条记录（不同部门 / 不同校区），逐条收集：
  //   ① schoolId（新口径：校区）—— 只作为「绑了哪些院校」的元信息，不直接进鉴权范围；
  //   ② departmentId（老口径：院系）—— 历史数据直接计入鉴权范围（向后兼容）；
  //   ③ campusDepts.deptIds（校区展开出的全部院系）—— 新口径的实际鉴权范围。
  // 老数据里 departmentId 可能为空、新数据里 schoolId 展开可能为空，两者取并集才不会把任何一类人锁死。
  const deptIdSet = new Set();
  const schoolIdSet = new Set();
  const schoolNames = new Map();
  for (const m of branchRecords) {
    if (m.departmentId) deptIdSet.add(String(m.departmentId));
    if (m.schoolId) {
      const sid = String(m.schoolId);
      schoolIdSet.add(sid);
      if (m.schoolName) schoolNames.set(sid, m.schoolName);
    }
  }
  for (const id of campusDepts.deptIds || []) if (id) deptIdSet.add(String(id));

  // 「该院校下还没有系部」：组织架构没配子级 → 分会成员看不到/录不了任何班。
  // 必须让管理端能明确显示，而不是让人以为权限坏了（文案在管理端成员列表/详情）。
  const campusCounts = campusDepts.counts || new Map();
  const campusesMissingDepartments = [...schoolIdSet]
    .filter((sid) => !(campusCounts.get(sid) > 0))
    .map((sid) => ({ id: sid, name: schoolNames.get(sid) || '' }));

  // 可录入的部门 key：所有 active 记录的 deptKey
  // （主席团的 deptKey 仍是 'presidium'，但录入口径由下面的 「主席团短路」单独判定 —— 见 canEnterModule）
  const deptKeys = new Set();
  for (const m of members) if (m.deptKey) deptKeys.add(m.deptKey);

  const presidiumRecords = members.filter((m) => m.deptKey === PRESIDIUM_KEY || ['president', 'vice_president'].includes(m.role));
  const isPresidium = presidiumRecords.length > 0;

  const canEnterDeptKeys = [...deptKeys];
  const canEnter = [];
  const view = [];
  for (const mod of modules || []) {
    // 与 canEnterModule 同一口径（此处**不查库**，范围在真正录入时按目标班级判定）：
    // 主席团跳过部门归属检查 → 所有启用模块都可录入
    const allowed = isPresidium || (mod.entryDeptKeys || []).some((k) => deptKeys.has(k));
    if (allowed) canEnter.push(mod.key);
    if (allowed || isMember) view.push(mod.key);
  }

  // 复核范围：校级主席团全校；分院主席团仅本院校（其下全部院系）；校长助理/部长不参与复核
  const reviewLevel = presidiumRecords.some((m) => m.level === 'school')
    ? 'school'
    : presidiumRecords.some((m) => m.level === 'branch')
      ? 'branch'
      : '';

  const roles = members.map((m) => ({
    id: String(m._id || ''),
    level: m.level,
    levelText: m.level === 'school' ? '校学生会' : '分院学生会',
    // 新口径：院校（校区）—— 前端展示优先用它
    schoolId: m.schoolId ? String(m.schoolId) : '',
    schoolName: m.schoolName || '',
    // 老口径：院系 —— 保留，前端可能仍在消费
    departmentId: m.departmentId ? String(m.departmentId) : '',
    departmentName: m.departmentName || '',
    deptKey: m.deptKey || '',
    deptName: m.deptName || (m.deptKey === PRESIDIUM_KEY ? '主席团' : ''),
    role: m.role,
    roleText: ROLE_TEXT[m.role] || m.role,
    termId: m.termId || '',
    termName: m.termName || '',
  }));

  // 展示文案：如「校学生会 · 生活部 · 部员」，多职务时取第一条并在前端提示条数
  const first = roles[0];
  const roleText = first ? [first.levelText, first.deptName, first.roleText].filter(Boolean).join(' · ') : '';

  const deptIds = [...deptIdSet];
  return {
    isMember,
    members: members.map((m) => ({ ...m, _id: String(m._id) })),
    level,
    departmentIds: deptIds,
    departments: deptIds, // 兼容字段：与 departmentIds 同值（历史出口，勿删）
    schoolIds: [...schoolIdSet],
    schoolNames: [...schoolNames.values()],
    campusesMissingDepartments,
    canEnterDeptKeys,
    modules: canEnter,
    viewModules: view,
    isPresidium,
    reviewLevel,
    roles,
    roleText,
    roleCount: roles.length,
  };
}

/**
 * 解析用户的学生会身份（带 30s 进程内缓存；增删改成员时调 clearIdentityCache 立即失效）
 */
async function resolveIdentity(user, { force = false } = {}) {
  const openid = (user && user.openid) || '';
  if (!openid) return buildIdentity([], []);
  const hit = identityCache.get(openid);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL) return hit.identity;

  const [records, modules] = await Promise.all([
    memberModel.find({ openid, status: 'active' }).sort({ level: 1, createdAt: 1 }).lean(),
    CheckModule.find({ enabled: true }).sort({ sort: 1 }).lean(),
  ]);
  // 校区 → 院系展开：**一次** Organization.find 批量处理全部 schoolId（records 已到手，不重复查成员）
  const schoolIds = [...new Set((records || []).filter((m) => m.level === 'branch' && m.schoolId).map((m) => String(m.schoolId)))];
  const campusDepts = await campusDepartmentIndex(schoolIds);
  const identity = buildIdentity(records, modules, campusDepts);
  identityCache.set(openid, { at: Date.now(), identity });
  return identity;
}

// 该用户是否学生会（活跃）成员：用于 /api/auth/me 与底部导航
async function isUnionMember(user) {
  if (!user || !user.openid) return false;
  const n = await memberModel.countDocuments({ openid: user.openid, status: 'active' });
  return n > 0;
}

/**
 * 给用户出口补学生会字段（/api/auth/me、login、bind 共用）
 * 纯读取，不写库。
 */
async function decorateUser(user, payload = {}) {
  if (!user || !user.openid) return payload;
  const identity = await resolveIdentity(user);
  return {
    ...payload,
    isUnionMember: identity.isMember,
    unionRoles: identity.roles,
    unionText: identity.roleText,
    unionRoleCount: identity.roleCount,
  };
}

// ===== 权限判定（服务端唯一口径）=====

/**
 * 该身份是否主席团（校级 / 分院都算）
 *
 * 判定口径与 buildIdentity 完全一致（`deptKey === 'presidium'` 或 `role ∈ {president, vice_president}`），
 * 且 identity.isPresidium 已算好 —— 这里只做「字段缺失时兜底重算」，避免直接把 identity 对象当纯数据用的
 * 调用方（如单测 / 路由里的临时对象）拿到 undefined 就被当成「不是主席团」。
 * @param {{isPresidium?: boolean, members?: Array}} identity
 */
function isPresidiumIdentity(identity) {
  if (!identity) return false;
  if (identity.isPresidium) return true;
  return (identity.members || []).some(
    (m) => m && (m.deptKey === PRESIDIUM_KEY || ['president', 'vice_president'].includes(m.role))
  );
}

// 能否复核**自己提交**的记录。
//
// 用户 2026-10-19 口径：**主席团可以自审，部长不行。**
// 为什么放开主席团：主席团是最终复核人，而且经常亲自代录（代录时他们就是 inspector）。
//   在这种情形下「禁止自审」会让记录**没有任何人能复核** —— 实测撞到过：
//   库里唯一具备复核资格的就是那条记录的提交人本人，记录永远卡在「待复核」，
//   页面还只剩一个「提交修改」，用户完全不知道发生了什么。
// 为什么部长仍然禁止：部长复核的是**本部门**的记录，自己录自己审等于没有把关，
//   第二人复核正是这个流程存在的意义（部长之间互相复核）。
function canSelfReview(identity) {
  return isPresidiumIdentity(identity);
}

/**
 * 「目标院系是否在本身份范围内」——**唯一实现处**
 *
 * 校级（学生会 level='school'）→ 全校任意院系；分院 → 只限本院校（校区）展开出的全部院系
 * （identity.departmentIds 已并入「校区展开 + 老口径 departmentId」，见 buildIdentity）。
 * 主席团录入短路、录入目标列表、宿舍照片可见者判定全部复用这一份，禁止各处各写一套。
 *
 * ⚠️ **fail-closed**：目标院系为空（如 record.departmentId 缺失）时返回 false ——
 * 宁可判成越权，也不能因为「拿不到归属」就放行（那正是越权的典型入口）。
 * 副作用：`/entry/targets` 用 `canEnterModule(identity, mod, null)` 只做「模块归属」预检；
 * 传 null 时**跳过**院系范围判定（否则分院连录入台都打不开），目标列表本身按
 * identity.departmentIds / schoolIds 收敛（见 services/band-chao.js::entryTargets），写入时再按真实目标校验。
 *
 * @param {Object} identity
 * @param {string|ObjectId|null} targetDepartmentId 目标班级归属院系
 */
function inDepartmentScope(identity, targetDepartmentId) {
  if (!identity) return false;
  if (identity.level === 'school') return true;
  const want = targetDepartmentId === undefined || targetDepartmentId === null ? '' : String(targetDepartmentId);
  if (!want) return false;
  const ids = (identity.departmentIds || []).filter(Boolean);
  return ids.includes(want);
}

/**
 * 能否为「某模块 + 某班级」录入
 * 判定链：① 是学生会成员
 *        ② **主席团短路**（isPresidium）→ 跳过部门归属检查，直接走范围判定
 *        ③ 非主席团：部门在模块 entryDeptKeys 内 → 再走范围判定
 *
 * 主席团范围：校级（level='school'）全校任意班；分会（level='branch'）限本校区展开出的院系
 * （**不放开成全校** —— 分会主席团越权是安全问题）。
 * 边界：其它角色行为与本轮改造前**逐字一致**（部长录别部门的模块仍被拒：reason='你所在的部门不负责这项检查'）。
 */
function canEnterModule(identity, moduleDef, targetDepartmentId) {
  if (!identity || !identity.isMember) return { ok: false, reason: '你还不是学生会成员' };
  const isPresidium = isPresidiumIdentity(identity);
  if (!isPresidium) {
    const allowed = (moduleDef.entryDeptKeys || []).some((k) => identity.canEnterDeptKeys.includes(k));
    if (!allowed) return { ok: false, reason: '你所在的部门不负责这项检查' };
  }
  // null = 只做「模块归属」预检（/entry/targets 列表页先列对象，逐条写时再用真实目标院系校验）。
  // 不能在这里对 null 走 inDepartmentScope：分院身份会被判成「目标班级没有归属院系」，
  // 连录入台都打不开；真正的越权由 entryTargets 按 identity.departmentIds 收敛 + 写入时再次校验。
  if (targetDepartmentId === null || targetDepartmentId === undefined) return { ok: true };
  if (inDepartmentScope(identity, targetDepartmentId)) return { ok: true };
  // 范围判定不通过（此时 identity.level 必为 'branch'）→ 按原因分别给出可读提示，
  // 对外语义与原实现逐字一致
  const want = targetDepartmentId === undefined || targetDepartmentId === null ? '' : String(targetDepartmentId);
  if (!want) return { ok: false, reason: '目标班级没有归属院系，无法确认范围' };
  const ids = (identity.departmentIds || []).filter(Boolean);
  if (!ids.length) {
    // 校区下没有系部（组织架构还没配子级）：给出可读原因，别让人以为权限坏了
    const missing = (identity.campusesMissingDepartments || []).map((c) => c.name || c.id).filter(Boolean);
    return {
      ok: false,
      reason: missing.length
        ? `你所在的院校（${missing.join('、')}）下还没有系部，请先到「组织架构」配置系部`
        : '你还未绑定院校（校区），请让管理员在「学生会成员」里补选院校',
    };
  }
  return { ok: false, reason: '只能录入本院系的检查' };
}

/**
 * 展示口径的可录入模块集合（与 canEnterModule 的部门/主席团部分一致，**不做范围判定** —— 范围依赖目标班级）。
 * 用途：/mine、/modules、/dashboard 的 `canEnter` 标记与前端「哪些模块能录」渲染。
 * 以前这三处各自内联写 `(m.entryDeptKeys||[]).some(k => identity.canEnterDeptKeys.includes(k))`，
 * 主席团短路后必须与 canEnterModule 同步；集中到这里，避免「一边放开、一边不放」的不一致。
 * 已知细微差异：canEnterModule 允许传 null 目标（仅预检模块归属），其它目标则走范围判定。
 */
function canEnterModuleKey(identity, moduleDef) {
  if (!identity || !identity.isMember || !moduleDef) return false;
  if (isPresidiumIdentity(identity)) return true;
  return (moduleDef.entryDeptKeys || []).some((k) => (identity.canEnterDeptKeys || []).includes(k));
}

// 是否有「复核入口」（用于 /mine、工作台、首页块显示待复核入口）：
// 主席团 + 各部门部长/副部长都算；具体某条记录还要用 canReview 再看部门/范围。
function canReviewAny(identity) {
  if (!identity || !identity.isMember) return false;
  if (identity.reviewLevel) return true;
  return (identity.roles || []).some((r) => ['minister', 'vice_minister'].includes(r.role) && r.deptKey);
}

// 能否复核某条记录：部门部长（本部门录入的记录）或主席团。
//   · 校级主席团：全校；
//   · 分院主席团：本院校展开出的院系；
//   · 部长/副部长：record.inspectorDeptKey 或模块 entryDeptKeys 与自己部门 key 一致，
//     再按范围校验（校级部长全校，分院部长限本院校院系）。
function canReview(identity, targetDepartmentId, inspectorDeptKey, moduleDeptKeys = []) {
  if (!identity || !identity.isMember) return false;
  // 部门部长：既可以是「录入这条记录的人所属部门」，也可以是「这个检查模块的归属部门」。
  // 例如主席团代录了一条卫生检查，生活部部长仍应能复核（模块 entryDeptKeys 含 life）。
  const keys = new Set([inspectorDeptKey, ...(moduleDeptKeys || [])].map((k) => String(k || '')).filter(Boolean));
  const isDeptMinister = (identity.roles || []).some(
    (r) => ['minister', 'vice_minister'].includes(r.role) && r.deptKey && keys.has(r.deptKey)
  );
  if (isDeptMinister) {
    if (identity.level === 'school') return true;
    const want = targetDepartmentId ? String(targetDepartmentId) : '';
    return !!want && (identity.departmentIds || []).includes(want);
  }
  if (!identity.reviewLevel) return false;
  if (identity.reviewLevel === 'school') return true;
  const want = targetDepartmentId ? String(targetDepartmentId) : '';
  const ids = identity.departmentIds || [];
  return !!want && ids.includes(want);
}

// ===== 学生会成员管理范围 =====
// 主席团：校级全校；分院限本院校（且只管理分院成员）。
// 部长/副部长：本部门 deptKey 成员，校级部长全校，分院部长限本院校。
function managerDeptKeys(identity) {
  return new Set(
    (identity.roles || [])
      .filter((r) => ['minister', 'vice_minister'].includes(r.role) && r.deptKey)
      .map((r) => r.deptKey)
  );
}

function sameCampus(identity, member) {
  const schoolIds = new Set((identity.schoolIds || []).map(String));
  const schoolNames = new Set((identity.schoolNames || []).filter(Boolean));
  return (
    (member.schoolId && schoolIds.has(String(member.schoolId))) ||
    (member.schoolName && schoolNames.has(member.schoolName)) ||
    false
  );
}

function canManageMembers(identity) {
  if (!identity || !identity.isMember) return false;
  return !!identity.isPresidium || managerDeptKeys(identity).size > 0;
}

function memberInManageScope(identity, member) {
  if (!member || !canManageMembers(identity)) return false;
  if (identity.isPresidium) {
    if (identity.level === 'school') return true;
    return member.level === 'branch' && sameCampus(identity, member);
  }
  const keys = managerDeptKeys(identity);
  if (!keys.has(member.deptKey)) return false;
  if (identity.level === 'school') return true;
  return member.level === 'branch' && sameCampus(identity, member);
}

// ===== 学年（届次）=====
// 学年以 9 月为界：2026-09 ~ 2027-08 = 「2026学年」。跨年自动递增，不需要人工改。
// 历史回溯下限 2024 学年（更早的记录仍可读，只是不再出现在选择器里）。
//
// 届次（第 N 届）与学年一一对应，但**起点是学校的既有习惯**，不能靠公式猜：
//   2026学年 = 第24届（用户明确口径）→ 每往前一个学年届次减 1，2024学年 = 第22届。
// 基准写在下面这个常量里，以后学校改了届次口径只改这一处，页面 / 接口 / 历史数据一起跟着走。
const TERM_MIN_START = 2024;
const TERM_SESSION_BASE = { startYear: 2026, session: 24 };

function academicYearStart(dateKey) {
  const key = /^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || '')) ? String(dateKey) : todayKey();
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  return month >= 9 ? year : year - 1;
}

// 学年 → 届次（第 N 届）：以 TERM_SESSION_BASE 为锚点线性推算
function sessionOf(startYear) {
  return TERM_SESSION_BASE.session + (Number(startYear) - TERM_SESSION_BASE.startYear);
}

function termOf(startYear) {
  const session = sessionOf(startYear);
  return {
    termId: `${startYear}-${startYear + 1}`,
    termName: `${startYear}学年`,
    startYear,
    session,
    sessionName: `第${session}届`,
    // 页面统一展示口径：学年 + 届次
    termLabel: `${startYear}学年 · 第${session}届`,
  };
}

// 可选学年：当前学年 → 2024学年（倒序）；current 标出默认项
function academicTerms(dateKey) {
  const current = academicYearStart(dateKey);
  const list = [];
  for (let year = current; year >= TERM_MIN_START; year -= 1) {
    list.push({ ...termOf(year), current: year === current });
  }
  const now = termOf(current);
  return {
    current: now.termId,
    currentStart: current,
    currentSession: now.session,
    currentLabel: now.termLabel,
    list,
  };
}

// 学年服务只依赖本地日历（不查库），避免每次列表都多一次 IO
function todayKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// 可见范围过滤条件：校级看全校，分院只能看本院校（展开出的院系），非成员看不到任何记录
// 注意：校区下没有系部时 departmentIds 为空 → 返回 null（= 什么都看不到），
// 这是**正确**的安全默认（宁可看不到，也不能越权看到全校）；管理端会提示运营去配组织架构。
function scopeFilter(identity) {
  if (!identity || !identity.isMember) return null;
  if (identity.level === 'school') return {};
  const ids = (identity.departmentIds || []).filter(Boolean);
  if (!ids.length) return null;
  return { departmentId: { $in: ids } };
}

// 启动期幂等迁移：把「成员唯一索引」换成含 schoolId 的版本。
//
// ⚠️ 为什么必须显式删旧索引（与 services/dorms.js::migrateSlotIndex 同一类陷阱）：
//   旧唯一键 = userId+level+departmentId+deptKey+termId（不含 schoolId）。
//   校区口径下分院记录的 departmentId **恒为 null**，于是「北校区分会-生活部」与
//   「洋河校区分会-生活部」在旧键下是**同一个键** → 第二条 create 抛 E11000 → **500**。
//   Mongoose 只会新建缺失索引、**不会替换**已存在的旧索引，所以旧索引会一直留着继续拒收。
//
// 旧索引是自动命名的（建时没给 name），因此按**键模式**识别而不是按名字 —— 这样即使
// 驱动/版本不同导致自动名变化也仍然可靠。
async function migrateMemberUniqueIndex() {
  const UnionMember = require('../models/union-member');
  const cols = await UnionMember.collection.indexes();
  const keyOf = (i) => i.key || {};
  const isOld = (i) =>
    !!i.unique &&
    keyOf(i).userId === 1 &&
    keyOf(i).level === 1 &&
    keyOf(i).departmentId === 1 &&
    keyOf(i).deptKey === 1 &&
    keyOf(i).termId === 1 &&
    keyOf(i).schoolId === undefined;
  const isNew = (i) =>
    !!i.unique &&
    keyOf(i).userId === 1 &&
    keyOf(i).level === 1 &&
    keyOf(i).schoolId === 1 &&
    keyOf(i).departmentId === 1 &&
    keyOf(i).deptKey === 1 &&
    keyOf(i).termId === 1;

  if (!cols.some(isNew)) {
    await UnionMember.collection.createIndex(
      { userId: 1, level: 1, schoolId: 1, departmentId: 1, deptKey: 1, termId: 1 },
      { unique: true, partialFilterExpression: { status: 'active' }, background: true }
    );
    // 新索引建好后，Mongoose 后续 syncIndexes 看到的键集合已一致，不会重复创建
  }
  const old = cols.find(isOld);
  if (old) {
    await UnionMember.collection.dropIndex(old.name);
  }
}

// ===== 宿舍照片隐私（**唯一实现处**）=====
//
// 需求原话：「为保证学生隐私**宿舍照片**拍照后仅检查人、学生会主席团成员、所属部门部长、教师账号可见、**其余模糊**」。
//
// ⚠️ 安全红线：**模糊 = 不下发原图 URL**，不是前端 CSS 把真 URL 糊一层。
//   后者抓包就能拿到原图（等于没做）；本文件下发的模糊占位里**不含任何 url 字段**，
//   `photos` 恒为空数组 —— 客户端拿到的东西里根本没有可还原的地址。
//   任何「为了让前端渲染占位图而塞一个占位 URL」的改法都是在泄密，禁止。
//
// 生效范围：**只作用于「宿舍类照片」**（拍照发生在宿舍场景）。判定依据是记录自身的
//   `targetType === 'dorm_room'` —— 与 check_modules 的模块 targetTypes 对齐：
//   night_dorm（查宿）→ ['dorm_room']；hygiene 三种受检对象里宿舍是 dorm_room，而教室（classroom）/
//   卫生区（area）/ 班级（class）照片**不受限**，正常可见。
//   为什么用 targetType 而不是模块 key：模块定义由 check-modules.js 负责（本文件不读它），
//   且同一模块可能支持多种受检对象；targetType 是写入时固化的场景事实，判起来最准。
//
// 可见者四条（顺序无关，满足任一即放行）——判定全部收敛在 canViewDormPhotos() 里：
//   ① 检查人本人      record.inspectorOpenid === viewer.openid（blank 视为「无检查人」，不放行）
//   ② 学生会主席团成员  unionSvc.canReview(identity, record.departmentId)（校级全校 / 分会本校区展开范围）
//   ③ 所属部门部长     该记录 inspectorDeptKey 对应的部门部长/副部长
//                      （role ∈ {minister, vice_minister} 且 member.deptKey === record.inspectorDeptKey），
//                      范围同 ②（分会部长只看得到本校区记录，看不到的本来就不会出现在列表里）
//   ④ 教师账号        viewer.role === 'teacher'（含班主任；按 AGENTS.md 班主任不需要管理权限）
//
// 已知边界（可接受，已在报告说明）：主席团代录时 inspectorDeptKey='presidium'，
//   此时「所属部门部长」这一条自然无人命中（主席团本身已有 ② 权限）。

const PHOTO_MASK_TEXT = '宿舍照片仅检查人 / 主席团 / 所属部门部长 / 教师可见 · 其余成员已模糊';

/**
 * 该记录的照片是否属于“宿舍照片”（= 是否受隐私规则约束）
 * @param {Object} record 记录（lean 或 doc 均可）
 */
function isDormPhotoRecord(record) {
  return String((record && record.targetType) || '') === 'dorm_room';
}

/**
 * 调用者能否看到该记录的**宿舍原图**
 *
 * @param {Object} record check_record（lean 或 doc 均可）
 * @param {{openid?: string, role?: string, identity?: Object, viewerIdentity?: Object}} viewer
 *        服务端算好的调用者上下文。identity 缺失时只看「检查人本人 / 教师」两条，
 *        主席团与部长两条判成不可见（fail-closed：拿不到身份就不放行）。
 */
function canViewDormPhotos(record, viewer) {
  if (!record || !viewer) return false;
  // ④ 教师账号（含班主任）
  if (viewer.role === 'teacher') return true;
  // ① 检查人本人
  const inspector = String(record.inspectorOpenid || '');
  if (inspector && inspector === String(viewer.openid || '')) return true;
  const identity = viewer.identity || viewer.viewerIdentity || null;
  if (!identity) return false;
  const dep = record.departmentId ? String(record.departmentId) : '';
  // ② 主席团（校级全校 / 分会本校区展开范围）—— 复用 canReview 的既有范围口径
  if (canReview(identity, dep)) return true;
  // ③ 所属部门部长 / 副部长（部门 key 必须与记录的 inspectorDeptKey 相同），范围同 ②
  const deptKey = String(record.inspectorDeptKey || '');
  if (!deptKey) return false;
  if (!inDepartmentScope(identity, dep)) return false;
  return (identity.members || []).some(
    (m) => m && ['minister', 'vice_minister'].includes(m.role) && String(m.deptKey || '') === deptKey
  );
}

/**
 * 照片出口裁剪（**服务端唯一出口**，routes/union.js::presentRecord 调用它）
 *
 * 返回形状（保持向后兼容：`photos` 始终是数组，前端 `wx:for` / `record.photos.length` 不炸）：
 *   - 有权 / 非宿舍照片：{ photos: ['https://...', ...], photosBlurred: false, photoCount: n, photoNote: '' }
 *   - 无权的宿舍照片  ：{ photos: [],            photosBlurred: true,  photoCount: n, photoNote: '…' }
 *
 * ⚠️ 无权限分支**不返回**任何原图 URL（连打码后的 URL 都不给）—— 抓包拿不到原图。
 * 只保留 `photoCount`（「这里本来有几张照片」）用于前端渲染模糊占位。
 *
 * @param {Object} record
 * @param {{withDetails?: boolean, viewer?: Object}|null} opts 调用者上下文（viewer 见 canViewDormPhotos）
 */
function cropPhotos(record, opts = {}) {
  const raw = Array.isArray(record && record.photos) ? record.photos.filter((p) => typeof p === 'string' && p) : [];
  const count = raw.length;
  const dorm = isDormPhotoRecord(record);
  const viewer = opts && opts.viewer;
  // 非宿舍照片：不受隐私规则约束（教室 / 卫生区 / 早操一律原样可见）
  if (!dorm) return { photos: raw, photosBlurred: false, photoCount: count, photoNote: '' };
  if (canViewDormPhotos(record, viewer)) {
    return { photos: raw, photosBlurred: false, photoCount: count, photoNote: '' };
  }
  return { photos: [], photosBlurred: true, photoCount: count, photoNote: count ? PHOTO_MASK_TEXT : '' };
}

module.exports = {
  PRESIDIUM_KEY,
  ROLE_TEXT,
  seedUnionDepartments,
  migrateMemberUniqueIndex,
  resolveIdentity,
  clearIdentityCache,
  isUnionMember,
  decorateUser,
  canEnterModule,
  canEnterModuleKey,
  inDepartmentScope,
  isPresidiumIdentity,
  canReview,
  canSelfReview,
  canReviewAny,
  canManageMembers,
  memberInManageScope,
  academicYearStart,
  termOf,
  academicTerms,
  TERM_MIN_START,
  scopeFilter,
  buildIdentity,
  // 宿舍照片隐私（唯一实现处）：可见者四条判定 + 无原图 URL 的模糊占位
  isDormPhotoRecord,
  canViewDormPhotos,
  cropPhotos,
  PHOTO_MASK_TEXT,
  // 院校（校区）→ 院系展开：管理端成员接口（校验校区、列表提示）也用它，避免各处各写一份
  expandCampusDepartments,
  campusDepartmentIndex,
};
