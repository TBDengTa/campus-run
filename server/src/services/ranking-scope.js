/**
 * 排行榜「范围」匹配口径（班级 / 系部 / 院系 / 全校）
 *
 * ⚠️ 为什么必须是单一实现：范围条件有**两个消费者** ——
 *   ① 个人榜：`routes/ranking.js::lookupStage()` 在 `$lookup users` 之后按 `u.*` 过滤；
 *   ② 班级榜：`rankClassRows()` 直接在 `users` 上 `$match`（不带前缀）。
 * 两份各写一遍必然漂移（「个人榜看得到、班级榜看不到」），所以统一在这里产出 clauses，
 * 由各自的 `matchOf(clauses, 前缀)` 挂上前缀。
 *
 * ⚠️ 为什么不能只看 `departmentId` / `schoolId`（用户 2026-11-12「点击系部与院系时出现了
 * 请完成学生认证」的真正原因）：名单导入（`services/roster.js`）**只写 schoolName /
 * departmentName 两个名字，不写两个 id**（id 只有在「学生认证绑定组织架构」时才落）。
 * 实测全库 2682 名学生里 1147 人（26 级整届 1144 人）只有名字没有 id ——
 * 按 id 判可用性 + 按 id 过滤，等于把整届 26 级学生的「系部 / 院系」两个范围判成「未认证」，
 * 而他们明明有班级、有系部名。所以口径必须是 **id 为主、名字兜底**，与
 * `routes/admin/class-profile.js` 的院校 / 系部筛选、`services/band-chao.js::resolveOrg` 完全一致。
 */
const mongoose = require('mongoose');
const { ApiError } = require('../utils/response');

// ObjectId / 名字统一取「干净字符串」：id 字段可能是 ObjectId 实例，名字可能带脏空白
function str(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

// ⚠️ **聚合管道不会做 Mongoose 类型转换**：`$match: { schoolId: '十六进制串' }` 与库里的
// ObjectId 类型不相等，一条都匹配不上（且不报错）。这里显式转一次 ObjectId。
// 非法值返回 null（调用方跳过该分支），绝不把裸字符串塞进聚合条件。
function oid(v) {
  const s = str(v);
  if (!s || !mongoose.isValidObjectId(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

// 范围标签与「缺失时该怎么补」的文案（服务端单点下发，前端不自己拼中文）
const SCOPES = {
  class: { label: '班级', needText: '尚未绑定班级，请联系管理员补全学籍' },
  department: { label: '系部', needText: '尚未绑定系部，请联系管理员补全学籍' },
  school: { label: '院系', needText: '尚未绑定院系，请联系管理员补全学籍' },
  all: { label: '全校', needText: '' },
};

/**
 * 范围 → 候选条件组（**OR** 语义）
 * 每个元素是一组「字段全等」，任意一组命中即算在该范围内。
 *
 * @returns {Array<Object>} 空数组 = 全校（不加任何条件）
 * @throws {ApiError} 该范围所需的学籍字段全都没有时 400
 */
function scopeClauses(me, scope) {
  const schoolId = str(me && me.schoolId);
  const schoolName = str(me && me.schoolName);

  // 院校：id 与名字是同一实体的两种存法，任一命中即可
  const schoolClauses = () => {
    const out = [];
    const sid = oid(schoolId);
    if (sid) out.push({ schoolId: sid });
    if (schoolName) out.push({ schoolName });
    return out;
  };

  if (scope === 'class') {
    const className = str(me && me.className);
    if (!className) throw new ApiError(400, 400, '尚未绑定班级，请先完成学生认证');
    // 班名本身就是班级台账的唯一键；院校条件只用于「同名班跨校区」时消歧，两种存法都带上
    const out = [];
    const sid = oid(schoolId);
    if (sid) out.push({ className, schoolId: sid });
    if (schoolName) out.push({ className, schoolName });
    if (!out.length) out.push({ className });
    return out;
  }

  if (scope === 'department') {
    const departmentId = str(me && me.departmentId);
    const departmentName = str(me && me.departmentName);
    if (!departmentId && !departmentName) {
      throw new ApiError(400, 400, '尚未绑定系部，请先完成学生认证');
    }
    const out = [];
    const did = oid(departmentId);
    if (did) out.push({ departmentId: did });
    if (departmentName) {
      // 同名系部会跨校区（实测北校区与洋河校区**都有「计财系」**）：
      // 名字分支必须同时用院校消歧，否则「本院系榜」会混进另一个校区的同名系部 ——
      // 看着能筛、结果是错的，比筛不出来更糟。
      const school = schoolClauses();
      if (school.length) school.forEach((s) => out.push({ departmentName, ...s }));
      else out.push({ departmentName });
    }
    return out;
  }

  if (scope === 'school') {
    const out = schoolClauses();
    if (!out.length) throw new ApiError(400, 400, '尚未绑定院系，请先完成学生认证');
    return out;
  }

  return []; // all 全校
}

// 缓存键：条件组逐项排序后序列化，保证「同一范围必得同一键」（顺序无关、不含随机）
function scopeKey(clauses) {
  if (!clauses || !clauses.length) return 'all';
  return clauses
    .map((c) =>
      Object.entries(c)
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join('&')
    )
    .sort()
    .join('|');
}

/**
 * 条件组 → mongo 条件文档
 * @param {Array<Object>} clauses scopeClauses() 的结果
 * @param {string} prefix 字段前缀（个人榜的 $lookup 之后要写 `u.`，班级榜传空串）
 */
function matchOf(clauses, prefix = '') {
  if (!clauses || !clauses.length) return null;
  const docs = clauses.map((c) => {
    const out = {};
    for (const [k, v] of Object.entries(c)) out[`${prefix}${k}`] = v;
    return out;
  });
  return docs.length === 1 ? docs[0] : { $or: docs };
}

// 多个条件文档合并：单个直接返回，多个用 $and（**不能**用对象展开合并 ——
// 两个条件都含 $or 时展开会静默丢掉前一个，是「筛选看着生效其实没生效」的经典坑）
function mergeMatch(...conds) {
  const list = conds.filter(Boolean);
  if (!list.length) return {};
  if (list.length === 1) return list[0];
  return { $and: list };
}

// 范围可用性：**id 或名字**任一存在即可用（否则整届 26 级学生点系部就报「未认证」）
function availableScopes(me) {
  const has = (v) => !!str(v);
  return [
    { key: 'class', label: SCOPES.class.label, available: has(me && me.className), needText: SCOPES.class.needText },
    {
      key: 'department',
      label: SCOPES.department.label,
      available: has(me && me.departmentId) || has(me && me.departmentName),
      needText: SCOPES.department.needText,
    },
    {
      key: 'school',
      label: SCOPES.school.label,
      available: has(me && me.schoolId) || has(me && me.schoolName),
      needText: SCOPES.school.needText,
    },
    { key: 'all', label: SCOPES.all.label, available: true, needText: '' },
  ];
}

module.exports = { SCOPES, scopeClauses, scopeKey, matchOf, mergeMatch, availableScopes };
