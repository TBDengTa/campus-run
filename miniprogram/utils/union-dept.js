/**
 * 学生会部门的「归属校区」判定 —— 配置页与成员页共用一份。
 *
 * 为什么必须共享（用户 2026-10-21「现在所有部门都是一个、只是在不同校区显示，我需要互不干扰」）：
 * 部门模型旧版只有 scope（school / branch / both），而 branch 的语义是「挂到**所有**校区」，
 * 所以北校区的「生活部」必然同时出现在洋河校区 —— 无法表达两校区各有不同部门。
 * 现在多了 schoolId：有值 = 只属于那一个校区。
 * 判定逻辑如果两个页面各写一份，就会出现「配置页只显示洋河的部门、成员页却能把人分到北校区的部门」，
 * 这正是本仓库这几轮反复在修的「两处各写一份必然漂移」。
 */

// scope 归一：历史/异常值一律按 'both'（与 server models/union-department.js 默认值同口径）
function normalizeScope(scope) {
  return scope === 'school' || scope === 'branch' ? scope : 'both';
}

/**
 * 主席团是**全局唯一**的语义实体：代码里用 `deptKey === 'presidium'` 判定复核权限，
 * 分会主席团也是同一条记录（level='branch' + deptKey='presidium'），不按校区分裂。
 *
 * ⚠️ 因此它**不能**按 scope='both' 在「全校」和每个校区根下各渲染一次
 * （用户 2026-10-21 截图：同一个主席团出现三遍，看起来像三个不同部门）。
 * 只在「全校」根下出现一次即可；分会主席团由成员记录上的 level 决定，与部门树无关。
 */
const PRESIDIUM_KEY = 'presidium';
const isPresidium = (dept) => !!dept && String(dept.key || '') === PRESIDIUM_KEY;

/**
 * 部门是否可用于「某个校区」的成员/配置。
 *
 * @param {{key?:string, schoolId?:string, scope?:string}} dept 部门（schoolId 空 = 不限定校区）
 * @param {string} campusId '' 或 'school' = 校学生会；其余 = 具体校区的组织 id
 * @param {{forDeptTree?:boolean}} [opts]
 *   forDeptTree=true → 用于**部门树展示**：主席团只在「全校」根下出现一次（它是一条全局记录，
 *     不该在每个校区根下各渲染一遍 —— 用户 2026-10-21「图1你这个主席团是一样的代码，需要你不一样」）。
 *   成员/模块的**选择器**不传该项：主席团是「职务」，任何校区都可以有分会主席团
 *     （校区分会主席团 = level='branch' + deptKey='presidium'，作用范围由成员记录上的 schoolId 决定），
 *     所以选校区时它必须仍然可选，否则管理员根本加不了分会主席。
 */
function deptFitsCampus(dept, campusId, opts = {}) {
  if (!dept) return false;
  const isSchoolLevel = !campusId || campusId === 'school';
  // 主席团：部门树只在「全校」层出现；但作为可选职务，两级都可用
  if (isPresidium(dept)) return opts.forDeptTree ? isSchoolLevel : true;
  // 明确归属某校区的部门：只在**那个**校区可选（且永远不能给校级成员）
  if (dept.schoolId) return !isSchoolLevel && String(dept.schoolId) === String(campusId);
  // ⚠️ 用户 2026-10-21「全校仅有主席团没有其他部门了」：
  //   校学生会（全校）层**除主席团外不再有别的部门** —— 分会部门归各校区，不该出现在「全校」下拉里。
  //   旧实现让 scope='both' 在校级也返回 true，于是生活部/学习部/纪检部都出现在「全校」下（用户截图）。
  //   未指定校区的非主席团部门现在只**在各校区分会共用**（不代表它们属于某个特定校区，
  //   那是 schoolId 的职责；这里只决定「哪些校区能选到它」）。
  return !isSchoolLevel;
}

module.exports = { normalizeScope, deptFitsCampus, isPresidium, PRESIDIUM_KEY };
