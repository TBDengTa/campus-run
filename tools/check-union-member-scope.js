/**
 * 学生会成员管理范围（用户 2026-11-12）
 *
 * 用户口径：
 *   1. 校学生会正副主席：可以管理 / 增加全校（院校、部门、层级）的成员；
 *   2. 分院正副主席：只能管理 / 增加**本院（校区）**的成员；
 *   3. 正副部长：只能管理 / 增加**本部门**的成员（校级可跨校区，分院限本校区）；
 *   4. 普通部员：没有成员管理权。
 *
 * 为什么单独一个检查器：这套范围同时被「列表过滤 / 改职务 / 调部门 / 离任 / 扫码加人 /
 * 成员页添加 / 候选人搜索」七个入口复用，任何一处另写判定都会出现
 * 「列表能看到、点修改 403」或「能加到外校区分会」这类静默越权。
 *
 * 运行：node tools/check-union-member-scope.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const svc = require(path.join(ROOT, 'server/src/services/union'));

let failed = 0;
function ok(name, cond, detail) {
  console.log(`${cond ? '  ok   ' : '  FAIL '}${name}${cond ? '' : '  -> ' + JSON.stringify(detail)}`);
  if (!cond) failed += 1;
}

// ===== 构造身份（纯对象，不查库）=====
const schoolPresident = {
  isMember: true,
  isPresidium: true,
  level: 'school',
  schoolIds: [],
  schoolNames: [],
  departmentIds: [],
  roles: [{ role: 'president', deptKey: 'presidium', schoolId: '' }],
};
const branchPresident = {
  isMember: true,
  isPresidium: true,
  level: 'branch',
  schoolIds: ['s1'],
  schoolNames: ['北校区'],
  departmentIds: ['d1'],
  roles: [{ role: 'president', deptKey: 'presidium', schoolId: 's1', schoolName: '北校区' }],
};
const branchVice = {
  isMember: true,
  isPresidium: true,
  level: 'branch',
  schoolIds: ['s1'],
  schoolNames: ['北校区'],
  departmentIds: ['d1'],
  roles: [{ role: 'vice_president', deptKey: 'presidium', schoolId: 's1', schoolName: '北校区' }],
};
const branchMinister = {
  isMember: true,
  isPresidium: false,
  level: 'branch',
  schoolIds: ['s1'],
  schoolNames: ['北校区'],
  departmentIds: ['d1'],
  roles: [{ role: 'minister', deptKey: 'life', schoolId: 's1', schoolName: '北校区' }],
};
const branchViceMinister = {
  isMember: true,
  isPresidium: false,
  level: 'branch',
  schoolIds: ['s1'],
  schoolNames: ['北校区'],
  departmentIds: ['d1'],
  roles: [{ role: 'vice_minister', deptKey: 'life', schoolId: 's1', schoolName: '北校区' }],
};
const schoolMinister = {
  isMember: true,
  isPresidium: false,
  level: 'school',
  schoolIds: [],
  schoolNames: [],
  departmentIds: [],
  roles: [{ role: 'minister', deptKey: 'study', schoolId: '' }],
};
const plainMember = {
  isMember: true,
  isPresidium: false,
  level: 'branch',
  schoolIds: ['s1'],
  schoolNames: ['北校区'],
  departmentIds: ['d1'],
  roles: [{ role: 'member', deptKey: 'life', schoolId: 's1', schoolName: '北校区' }],
};

const slot = (level, schoolId, schoolName, deptKey) => ({ level, schoolId, schoolName, deptKey });
const memberAt = (level, schoolId, schoolName, deptKey, extra = {}) => ({
  level,
  schoolId,
  schoolName,
  deptKey,
  status: 'active',
  ...extra,
});

// ===== 1) 校主席团：全校任何层级 / 校区 / 部门 =====
console.log('[1] 校学生会正副主席（全校）');
ok('校主席团有成员管理权', svc.canManageMembers(schoolPresident));
ok('可加校学生会成员', svc.canManageMemberSlot(schoolPresident, slot('school', '', '', 'life')));
ok('可加北校区分会成员', svc.canManageMemberSlot(schoolPresident, slot('branch', 's1', '北校区', 'life')));
ok('可加洋河校区分会成员', svc.canManageMemberSlot(schoolPresident, slot('branch', 's2', '洋河校区', 'life')));
ok('可加主席团成员（主席）', svc.canManageMemberSlot(schoolPresident, slot('school', '', '', 'presidium')));
ok('可授予主席', svc.canGrantRole(schoolPresident, 'presidium', 'president'));
ok('可授予业务部门部长', svc.canGrantRole(schoolPresident, 'life', 'minister'));
ok('可管理全校任意成员', svc.memberInManageScope(schoolPresident, memberAt('branch', 's2', '洋河校区', 'study')));

// ===== 2) 分院主席团：本院校（校区）内任意部门；不得跨校区 / 校级 =====
console.log('\n[2] 分院正副主席（本院）');
ok('分院主席团有成员管理权', svc.canManageMembers(branchPresident));
ok('可加本院生活部', svc.canManageMemberSlot(branchPresident, slot('branch', 's1', '北校区', 'life')));
ok('可加本院自定义部门', svc.canManageMemberSlot(branchPresident, slot('branch', 's1', '北校区', 'dept7')));
ok('可加本院校主席团', svc.canManageMemberSlot(branchPresident, slot('branch', 's1', '北校区', 'presidium')));
ok('不能加外校区生活部', !svc.canManageMemberSlot(branchPresident, slot('branch', 's2', '洋河校区', 'life')));
ok('不能加校级成员', !svc.canManageMemberSlot(branchPresident, slot('school', '', '', 'life')));
ok('不能加外校区主席团', !svc.canManageMemberSlot(branchPresident, slot('branch', 's2', '洋河校区', 'presidium')));
ok('可管理本院成员', svc.memberInManageScope(branchPresident, memberAt('branch', 's1', '北校区', 'life')));
ok('不能管理外院成员', !svc.memberInManageScope(branchPresident, memberAt('branch', 's2', '洋河校区', 'life')));
ok('不能管理校级成员', !svc.memberInManageScope(branchPresident, memberAt('school', '', '', 'presidium')));
// 老数据兜底：成员记录只有 departmentId（没有 schoolId / schoolName）
ok(
  '可管理只有院系的老成员（departmentId 兜底）',
  svc.memberInManageScope(branchPresident, memberAt('branch', '', '', 'life', { departmentId: 'd1' }))
);
ok(
  '不能管理外院系的老成员',
  !svc.memberInManageScope(branchPresident, memberAt('branch', '', '', 'life', { departmentId: 'd9' }))
);

// ===== 3) 分院副主席：可授予副主席，不能授予主席（不能凭空造平级/上级）=====
console.log('\n[3] 分院副主席的授予上限');
ok('可授予副主席', svc.canGrantRole(branchVice, 'presidium', 'vice_president'));
ok('不能授予主席', !svc.canGrantRole(branchVice, 'presidium', 'president'));
ok('可加本院成员', svc.canManageMemberSlot(branchVice, slot('branch', 's1', '北校区', 'life')));

// ===== 4) 正副部长：本部门；校级可跨校区，分院限本校区 =====
console.log('\n[4] 正副部长（本部门）');
ok('分院部长有成员管理权', svc.canManageMembers(branchMinister));
ok('可加本部门本院成员', svc.canManageMemberSlot(branchMinister, slot('branch', 's1', '北校区', 'life')));
ok('不能加别部门', !svc.canManageMemberSlot(branchMinister, slot('branch', 's1', '北校区', 'study')));
ok('不能加外校区本部门', !svc.canManageMemberSlot(branchMinister, slot('branch', 's2', '洋河校区', 'life')));
ok('可管理本部门本院成员', svc.memberInManageScope(branchMinister, memberAt('branch', 's1', '北校区', 'life')));
ok('不能管理别部门成员', !svc.memberInManageScope(branchMinister, memberAt('branch', 's1', '北校区', 'study')));
ok('不能管理外校区本部门成员', !svc.memberInManageScope(branchMinister, memberAt('branch', 's2', '洋河校区', 'life')));
ok('部长可授予部员', svc.canGrantRole(branchMinister, 'life', 'member'));
ok('部长可授予副部长', svc.canGrantRole(branchMinister, 'life', 'vice_minister'));
ok('部长可授予同级部长', svc.canGrantRole(branchMinister, 'life', 'minister'));
ok('副部长不能授予部长', !svc.canGrantRole(branchViceMinister, 'life', 'minister'));
ok('副部长可授予部员', svc.canGrantRole(branchViceMinister, 'life', 'member'));

console.log('\n[5] 校级部长（可跨校区，但仍限本部门）');
ok('可加本校区分会本部门', svc.canManageMemberSlot(schoolMinister, slot('branch', 's1', '北校区', 'study')));
ok('可加另一校区本部门', svc.canManageMemberSlot(schoolMinister, slot('branch', 's2', '洋河校区', 'study')));
ok('不能加别部门', !svc.canManageMemberSlot(schoolMinister, slot('branch', 's1', '北校区', 'life')));
ok('可管理外校区本部门成员', svc.memberInManageScope(schoolMinister, memberAt('branch', 's2', '洋河校区', 'study')));
ok('不能管理别部门成员', !svc.memberInManageScope(schoolMinister, memberAt('branch', 's1', '北校区', 'life')));

// ===== 6) 普通部员：无成员管理权 =====
console.log('\n[6] 普通部员');
ok('没有成员管理权', !svc.canManageMembers(plainMember));
ok('不能加人', !svc.canManageMemberSlot(plainMember, slot('branch', 's1', '北校区', 'life')));
ok('不能授予职务', !svc.canGrantRole(plainMember, 'life', 'member'));
ok('不能管理成员', !svc.memberInManageScope(plainMember, memberAt('branch', 's1', '北校区', 'life')));

// ===== 7) fail-closed：拿不到院校归属 =====
console.log('\n[7] fail-closed（无法确认院校 → 拒绝）');
const noCampus = {
  isMember: true,
  isPresidium: true,
  level: 'branch',
  schoolIds: [],
  schoolNames: [],
  departmentIds: [],
  roles: [{ role: 'president', deptKey: 'presidium' }],
};
ok('分院主席团缺院校 → 不能加人', !svc.canManageMemberSlot(noCampus, slot('branch', 's1', '北校区', 'life')));
ok('分院主席团缺院校 → 不能管理成员', !svc.memberInManageScope(noCampus, memberAt('branch', 's1', '北校区', 'life')));

// ===== 8) 部门 ↔ 职务匹配（双向，唯一实现）=====
console.log('\n[8] 部门 ↔ 职务');
ok('主席团 + 主席', svc.roleFitsDept('president', 'presidium'));
ok('主席团 + 副主席', svc.roleFitsDept('vice_president', 'presidium'));
ok('主席团 + 部长 不匹配', !svc.roleFitsDept('minister', 'presidium'));
ok('业务部门 + 主席 不匹配', !svc.roleFitsDept('president', 'life'));
ok('业务部门 + 部长', svc.roleFitsDept('minister', 'life'));

// ===== 9) 路由 / 前端接线（静态）=====
console.log('\n[9] 接线');
const unionRoute = read('server', 'src', 'routes', 'union.js');
const membersJs = read('miniprogram', 'packageAdmin', 'union', 'members', 'members.js');
const membersWxml = read('miniprogram', 'packageAdmin', 'union', 'members', 'members.wxml');

ok('用户端新增成员接口存在', /router\.post\(\s*'\/manage\/members'/.test(unionRoute));
ok('用户端候选人接口存在', /'\/manage\/members\/candidates'/.test(unionRoute));
ok('新增成员走 canManageMemberSlot', /canManageMemberSlot\(identity[\s\S]{0,260}deptKey: dept\.key/.test(unionRoute));
ok('新增成员走 canGrantRole', /canGrantRole\(identity, dept\.key, role\)/.test(unionRoute));
ok('扫码加人也走 canManageMemberSlot', /canManageMemberSlot\(identity[\s\S]{0,200}deptKey: dept\.key/.test(unionRoute));
ok('join-options 按本人院校收敛校区', /campusList = allCampuses\.filter/.test(unionRoute));
ok('join-options 支持成员管理页（manage=1）', /forManage = String\(req\.query\.manage/.test(unionRoute));
ok('候选人搜索按院校收敛（departmentId）', /\$in: ids[\s\S]{0,200}departmentId/.test(unionRoute) || /departmentId: \{ \$in: ids \}/.test(unionRoute));
ok('成员页按身份切换候选人接口', /\/api\/union\/manage\/members\/candidates/.test(membersJs));
ok('成员页干部添加走用户端接口', /\/api\/union\/manage\/members'/.test(membersJs));
ok('成员页拉取范围用 manage=1', /auth\.get\('\/api\/union\/manage\/join-options', \{ manage: 1 \}\)/.test(membersJs));
ok('不再把干部引导去扫码（添加抽屉可直接加人）', !/请用扫码加人/.test(membersJs));
ok('候选人组件绑定动态 api', /api="\{\{pickerApi\}\}"/.test(membersWxml));

console.log(`\n成员管理范围自检：${failed} 项失败`);
process.exit(failed ? 1 : 0);
