/**
 * 组织归属解析（院校 → 系部 → 专业）的**唯一实现**
 *
 * 为什么需要它（2026-11-13 用户报障「部员检查录入时提示目标班级没有归属院系」）：
 *   名单导入（services/roster.js）历来**只写名字不写 id**（schoolName / departmentName），
 *   而鉴权、`check_records.departmentId`、`scopeFilter` 全按 **id** 判范围 ——
 *   于是「整届 26 级班级/学生/宿舍」都只有名字，分院成员录这些班时就被
 *   `services/union.js::inDepartmentScope` fail-closed 拦掉。
 *
 * 本文件把「名字 → 组织节点」的反查收敛成一份实现，供：
 *   · `services/band-chao.js::resolveOrg`（录入台对象列表，历史上已自带一份错误版本，改为调用本文件）
 *   · `routes/union.js::resolveClassInfo`（写入 / 名单 / 范围校验的基准）
 *   · `routes/union.js::resolveTarget`（宿舍房 / 卫生区）
 *   · `services/roster.js` 导入、`services/class-profiles.js` 同步（写入时就把 id 补上，不再产生新脏数据）
 *
 * 三条硬约束（改这里之前先读）：
 *   ① **id 优先、名字兜底**：有 id 就直接用 id（并校验它确实挂在给定院校下）；
 *      只有「id 为空」时才按名字反查 —— **绝不**在 id 存在但越界时用名字把它「救回来」，
 *      那等于把跨校区的越权数据洗成合法；
 *   ② **同名歧义不猜**：同名系部在两个校区各有一个（北校区/洋河校区都有「计财系」），
 *      只给名字、又没有可消歧的院校时返回 `ambiguous`，由调用方 fail-closed；
 *      **不要**再退回「取第一个」（旧 `resolveOrg` 的 `list[0]` 正是跨校区错判的成因）；
 *   ③ 解析结果只做「补齐」，不覆盖已有的一致值：`repaired` 标记用于排查，
 *      写入方据此决定是否回填 id。
 */
const mongoose = require('mongoose');
const Organization = require('../models/organization');

const CACHE_TTL = 60 * 1000;
let cache = { at: 0, index: null };

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const oid = (v) => (mongoose.isValidObjectId(v) ? String(v) : '');

/**
 * 组织架构索引（60s 进程内缓存；组织架构改动不频繁，但每 60s 会自然刷新）。
 * 索引里同时保留「按 id」与「按名字」两种视图，避免调用方各自再建一份 Map
 * （仓库里已有 4 份同类实现，口径漂移就是这次报障的间接成因）。
 */
async function loadIndex() {
  if (cache.index && Date.now() - cache.at < CACHE_TTL) return cache.index;
  const orgs = await Organization.find({}).select('name type parentId').lean();
  const byId = new Map(orgs.map((o) => [String(o._id), o]));
  const schools = new Map();
  const schoolsByName = new Map();
  const depts = new Map();
  const deptsByName = new Map();
  const specsByKey = new Map(); // `${schoolName}\u0000${deptName}` → Set(specialtyName)

  for (const o of orgs) {
    const name = str(o.name);
    if (!name) continue;
    if (o.type === 'school') {
      const school = { id: String(o._id), name };
      schools.set(school.id, school);
      schoolsByName.set(name, school);
      continue;
    }
    const parent = byId.get(str(o.parentId));
    if (o.type === 'department') {
      if (!parent || parent.type !== 'school') continue; // 游离系部：无法定位院校，不参与解析
      const dept = { id: String(o._id), name, schoolId: String(parent._id), schoolName: str(parent.name) };
      depts.set(dept.id, dept);
      if (!deptsByName.has(name)) deptsByName.set(name, []);
      deptsByName.get(name).push(dept);
      continue;
    }
    if (o.type === 'specialty') {
      if (!parent || parent.type !== 'department') continue;
      const grand = byId.get(str(parent.parentId));
      if (!grand || grand.type !== 'school') continue;
      const key = `${str(grand.name)}\u0000${str(parent.name)}`;
      if (!specsByKey.has(key)) specsByKey.set(key, new Set());
      specsByKey.get(key).add(name);
    }
  }

  cache = { at: Date.now(), index: { schools, schoolsByName, depts, deptsByName, specsByKey } };
  return cache.index;
}

function clearOrgResolveCache() {
  cache = { at: 0, index: null };
}

/**
 * 解析一行记录的组织归属（**同步版**，调用方已持有 index —— 批量导入/同步时避免每行一次 IO）。
 *
 * @param {Object} idx loadIndex() 的结果
 * @param {Object} row { schoolId?, schoolName?, departmentId?, departmentName? }
 * @returns {{
 *   departmentId: string, departmentName: string, schoolId: string, schoolName: string,
 *   resolved: boolean, ambiguous: boolean, repaired: boolean,
 *   candidates: Array<{departmentId:string, schoolName:string}>,
 *   reason: ''|'dept-not-found'|'school-not-found'|'ambiguous'|'conflict'
 * }}
 */
function resolveDepartmentSync(idx, row) {
  const r = row || {};
  const wantDeptId = oid(r.departmentId);
  const wantDeptName = str(r.departmentName);
  const wantSchoolId = oid(r.schoolId);
  const wantSchoolName = str(r.schoolName);

  const schoolFrom = (dept) => {
    if (!dept) return { schoolId: wantSchoolId, schoolName: wantSchoolName };
    return { schoolId: dept.schoolId, schoolName: dept.schoolName };
  };
  const empty = (reason, extra = {}) => ({
    departmentId: '',
    departmentName: wantDeptName,
    schoolId: wantSchoolId || (wantSchoolName ? (idx.schoolsByName.get(wantSchoolName) || {}).id || '' : ''),
    schoolName: wantSchoolName || schoolFrom(oid(r.schoolId) ? idx.depts.get(wantDeptId) : null).schoolName || '',
    resolved: false,
    ambiguous: reason === 'ambiguous',
    repaired: false,
    candidates: [],
    reason,
    ...extra,
  });

  // ① 有 id：直接用（但校验它确实是一个「挂在院校下」的系部）
  if (wantDeptId) {
    const dept = idx.depts.get(wantDeptId);
    if (dept) {
      const schoolMismatch = wantSchoolId && dept.schoolId !== wantSchoolId;
      if (!schoolMismatch) {
        return {
          departmentId: dept.id,
          departmentName: dept.name,
          schoolId: dept.schoolId,
          schoolName: dept.schoolName,
          resolved: true,
          ambiguous: false,
          repaired: false,
          candidates: [],
          reason: '',
        };
      }
      // id 指向别的校区：**不猜**，按名字在该校区里重解析（解析不出就 fail-closed）
      const fixed = resolveByName(idx, wantDeptName, wantSchoolId, wantSchoolName);
      if (fixed.resolved) {
        return { ...fixed, repaired: true, reason: 'conflict' };
      }
      return { ...empty('conflict'), candidates: fixed.candidates };
    }
    // id 非法 / 已删：继续尝试按名字
  }

  // ② 无 id（或 id 失效）：按名字反查，必须唯一
  if (!wantDeptName) return empty('dept-not-found');
  return resolveByName(idx, wantDeptName, wantSchoolId, wantSchoolName);
}

/** 异步版（自己取 index）：单行解析的常用入口 */
async function resolveDepartment(row) {
  return resolveDepartmentSync(await loadIndex(), row);
}

function resolveByName(idx, deptName, schoolId, schoolName) {
  const list = idx.deptsByName.get(str(deptName)) || [];
  if (!list.length) {
    return {
      departmentId: '',
      departmentName: str(deptName),
      schoolId,
      schoolName,
      resolved: false,
      ambiguous: false,
      repaired: false,
      candidates: [],
      reason: 'dept-not-found',
    };
  }
  const pick = (dept) => ({
    departmentId: dept.id,
    departmentName: dept.name,
    schoolId: dept.schoolId,
    schoolName: dept.schoolName,
    resolved: true,
    ambiguous: false,
    repaired: false,
    candidates: [],
    reason: '',
  });
  const candidatesOf = () => list.map((d) => ({ departmentId: d.id, schoolName: d.schoolName }));

  if (schoolId) {
    const hit = list.filter((d) => d.schoolId === schoolId);
    if (hit.length === 1) return pick(hit[0]);
    if (hit.length > 1) return { ...pick(hit[0]), resolved: false, ambiguous: true, candidates: candidatesOf(), reason: 'ambiguous' };
    return { departmentId: '', departmentName: str(deptName), schoolId, schoolName, resolved: false, ambiguous: false, repaired: false, candidates: candidatesOf(), reason: 'school-not-found' };
  }
  if (schoolName) {
    const school = idx.schoolsByName.get(str(schoolName));
    if (!school) return { departmentId: '', departmentName: str(deptName), schoolId: '', schoolName: str(schoolName), resolved: false, ambiguous: false, repaired: false, candidates: candidatesOf(), reason: 'school-not-found' };
    const hit = list.filter((d) => d.schoolId === school.id);
    if (hit.length === 1) return pick(hit[0]);
    if (hit.length > 1) return { ...pick(hit[0]), resolved: false, ambiguous: true, candidates: candidatesOf(), reason: 'ambiguous' };
    return { departmentId: '', departmentName: str(deptName), schoolId: school.id, schoolName: school.name, resolved: false, ambiguous: false, repaired: false, candidates: candidatesOf(), reason: 'dept-not-found' };
  }
  // 只有名字：全库唯一才认，同名（跨校区）一律判歧义 —— **绝不取第一个**
  if (list.length === 1) return pick(list[0]);
  return { departmentId: '', departmentName: str(deptName), schoolId: '', schoolName: '', resolved: false, ambiguous: true, repaired: false, candidates: candidatesOf(), reason: 'ambiguous' };
}

/**
 * 从「某班级」推出一行的院校（宿舍房 / 卫生区没有 schoolName 时的兜底）。
 * @param {Object} classProfile class_profiles 行（含 schoolName / schoolId）
 * @returns {{schoolId: string, schoolName: string}}
 */
function campusOfClass(classProfile) {
  const p = classProfile || {};
  return { schoolId: oid(p.schoolId), schoolName: str(p.schoolName) };
}

/**
 * 专业的归属校验（院校 + 系部 + 专业 三元组）：用于导入时提示「这个专业不在该系部下」。
 * @returns {Promise<boolean|null>} null = 组织架构里没有该（院校/系部）组合，无法判断
 */
async function specialtyBelongsTo(schoolName, deptName, specialty) {
  const idx = await loadIndex();
  const set = idx.specsByKey.get(`${str(schoolName)}\u0000${str(deptName)}`);
  if (!set) return null;
  return set.has(str(specialty));
}

module.exports = {
  loadIndex,
  resolveDepartment,
  resolveDepartmentSync,
  campusOfClass,
  specialtyBelongsTo,
  clearOrgResolveCache,
};
