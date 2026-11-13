// 组织归属解析的静态契约（用户 2026-11-13「部员检查录入提示目标班级没有归属院系」
// +「学生会控制台显示分院学生会」两条报障的回归闸门）
//
// 这个检查器盯的是**口径**，不是行为：行为由 tools/verify-org-scope.js 真连库验证。
// 六条（每条都对应一次真实踩坑）：
//   ① 归属解析只有一份实现（services/org-resolve.js），路由/服务不得自拼 deptByName 反查；
//   ② 写入与名单路径必须走它（resolveClassInfo / resolveTarget），否则「列表能看、一点就 403」复发；
//   ③ `inDepartmentScope` 必须 id 优先、名字仅兜底（有 id 却按名字放行 = 跨校区越权）；
//   ④ 分院展示必须带真实校区名（`${schoolName}学生会`），不再统一 `分院学生会`；
//   ⑤ 台账/学籍/宿舍/卫生区写入时补 id（导入、同步、回填脚本三处），否则整届「只有名字」复发；
//   ⑥ facets.tree 院校 count 必须向上累加（系部命中分支也要 +1），且与列表的 status 口径一致。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'src');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

let failed = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` -> ${detail === undefined ? '' : detail}`}`);
  if (!cond) failed += 1;
};

console.log('[1] 归属解析单一实现');
const orgResolvePath = path.join(SERVER, 'services', 'org-resolve.js');
ok('services/org-resolve.js 存在', fs.existsSync(orgResolvePath));
const orgSrc = read(SERVER, 'services', 'org-resolve.js');
ok('导出 resolveDepartment / resolveDepartmentSync', /resolveDepartment,/.test(orgSrc) && /resolveDepartmentSync,/.test(orgSrc));
ok('同名歧义不猜（返回 ambiguous，不取 list[0]）', /ambiguous: true/.test(orgSrc) && !/candidates\[0\] \|\| list\[0\]/.test(orgSrc));

const consumers = {
  'routes/union.js': read(SERVER, 'routes', 'union.js'),
  'services/band-chao.js': read(SERVER, 'services', 'band-chao.js'),
  'services/roster.js': read(SERVER, 'services', 'roster.js'),
  'services/class-profiles.js': read(SERVER, 'services', 'class-profiles.js'),
};
ok('routes/union.js 引用 org-resolve', /require\('\.\.\/services\/org-resolve'\)/.test(consumers['routes/union.js']));
ok('services/roster.js 导入时补 id', /orgResolve\.loadIndex\(\)/.test(consumers['services/roster.js']) && /resolveDepartmentSync/.test(consumers['services/roster.js']));
ok('services/class-profiles.js 同步时补 id', /resolveDepartmentSync/.test(consumers['services/class-profiles.js']));
ok('band-chao 不再「取第一个同名系部」', !/dept = candidates\[0\] \|\| list\[0\] \|\| null/.test(consumers['services/band-chao.js']));
ok('band-chao 用归属班级的院校消歧（classCampusMap）', /function classCampusMap/.test(consumers['services/band-chao.js']) && /classCampusMap\(/.test(consumers['services/band-chao.js']));

console.log('\n[2] 写入 / 名单路径走统一解析');
const unionRouteSrc = consumers['routes/union.js'];
const resolveClassInfoFn = (unionRouteSrc.match(/async function resolveClassInfo\(className\)[\s\S]*?\n\}/) || [''])[0];
ok('resolveClassInfo 走 orgResolve', /orgResolve\.resolveDepartment\(/.test(resolveClassInfoFn), '直接读 profile.departmentId 会复现 403');
ok('resolveClassInfo 返回 schoolId / schoolName（供宿舍/卫生区消歧）', /schoolId: org\.schoolId/.test(resolveClassInfoFn) && /schoolName: org\.schoolName/.test(resolveClassInfoFn));
const resolveTargetFn = (unionRouteSrc.match(/async function resolveTarget\(moduleDef[\s\S]*?\n\}/) || [''])[0];
ok('resolveTarget 的宿舍分支走 orgResolve', /orgResolve\.resolveDepartment\(\{[\s\S]{0,160}departmentId: room\.departmentId/.test(resolveTargetFn));
ok('resolveTarget 的卫生区分支走 orgResolve', /orgResolve\.resolveDepartment\(\{[\s\S]{0,160}departmentId: area\.departmentId/.test(resolveTargetFn));

console.log('\n[3] 范围判定：id 优先、名字兜底');
const unionSvcSrc = read(SERVER, 'services', 'union.js');
const scopeFn = (unionSvcSrc.match(/function inDepartmentScope\(identity, targetDepartmentId, targetDepartmentName\)[\s\S]*?\n\}/) || [''])[0];
ok('inDepartmentScope 有 id 时只认 id', /if \(want\) return \(identity\.departmentIds \|\| \[\]\)\.filter\(Boolean\)\.includes\(want\);/.test(scopeFn));
ok('inDepartmentScope 仅 id 为空时按名字兜底', /if \(!name\) return false;[\s\S]*?departmentNames/.test(scopeFn));
const canEnterFn = (unionSvcSrc.match(/function canEnterModule\(identity, moduleDef, targetDepartmentId, targetDepartmentName\)[\s\S]*?\n\}/) || [''])[0];
ok('canEnterModule 透传系部名', /inDepartmentScope\(identity, targetDepartmentId, targetDepartmentName\)/.test(canEnterFn));
ok('错误文案带校区名（用户能判断是权限还是数据问题）', /本院校/.test(canEnterFn) && /只能录入/.test(canEnterFn));
ok('scopeFilter 名字分支只在 departmentId 缺失时命中', /\{ departmentName: \{ \$in: names \}, departmentId: null \}/.test(unionSvcSrc));
ok('canReview 走同一份 inDepartmentScope', /return inDepartmentScope\(identity, targetDepartmentId, targetDepartmentName\);/.test(unionSvcSrc));

console.log('\n[4] 控制台显示真实院校名');
ok('buildIdentity 的 levelText 带校区名', /levelText: m\.level === 'school' \? '校学生会' : schoolName \? `\$\{schoolName\}学生会` : '分院学生会'/.test(unionSvcSrc));
ok('/mine 下发 campusName', /campusName: identity\.campusName \|\| ''/.test(unionRouteSrc));
ok('通讯录 levelText 同口径', /levelText: m\.level === 'school' \? '校学生会' : m\.schoolName \? `\$\{m\.schoolName\}学生会` : '分院学生会'/.test(unionRouteSrc));
const adminUnionSrc = read(SERVER, 'routes', 'admin', 'union.js');
ok('管理端成员列表同口径', /levelText: m\.level === 'school' \? '校学生会' : m\.schoolName \? `\$\{m\.schoolName\}学生会` : '分院学生会'/.test(adminUnionSrc));
ok('成员没绑校区时用学籍院校兜底', /fallbackCampus/.test(unionSvcSrc) && /hasBranch && !recordSchoolIds\.length/.test(unionSvcSrc));

console.log('\n[5] 数据面：写入时就带 id');
ok('导入新建用户写 schoolId / departmentId', /schoolId: orgIds\.schoolId \|\| undefined/.test(consumers['services/roster.js']) && /departmentId: orgIds\.departmentId \|\| undefined/.test(consumers['services/roster.js']));
ok('导入更新已有用户补 id', /existing\.schoolId = orgIds\.schoolId/.test(consumers['services/roster.js']));
ok('台账同步补 id 且只补不覆盖', /if \(!set\.schoolId && org\.schoolId\) set\.schoolId = org\.schoolId/.test(consumers['services/class-profiles.js']));
ok('check_records 落库 departmentName', /departmentName: \{ type: String, default: '' \}/.test(read(SERVER, 'models', 'check-record.js')) && /departmentName: target\.departmentName \|\| ''/.test(unionRouteSrc));
const backfillPath = path.join(ROOT, 'server', 'scripts', 'backfill-org-ids.js');
ok('回填脚本存在且默认 dry-run（须显式 --apply）', fs.existsSync(backfillPath) && /const APPLY = process\.argv\.includes\('--apply'\)/.test(fs.readFileSync(backfillPath, 'utf8')));
ok('回填脚本只补空（不覆盖已有 id）', /isBlank\(r\.departmentId\) \? org\.departmentId : ''/.test(fs.readFileSync(backfillPath, 'utf8')));

console.log('\n[6] facets.tree 计数');
const cpSrc = read(SERVER, 'routes', 'admin', 'class-profile.js');
const treeFn = (cpSrc.match(/function buildFacetTree\([\s\S]*?\n\}/) || [''])[0];
ok('系部命中分支也给院校 count +1', /dept\.count \+= 1;\s*\n\s*school\.node\.count \+= 1;/.test(treeFn));
ok('unmappedDeptCount 挂在 node 上（能下发）', /school\.node\.unmappedDeptCount = \(school\.node\.unmappedDeptCount \|\| 0\) \+ 1/.test(treeFn));
ok('treeNode 有 unmappedDeptCount 初值', /unmappedDeptCount: 0,/.test(cpSrc));
ok('facets 台账范围带班级状态（下拉数字 = 点进去的班数）', /const facetScope = \{\};/.test(cpSrc) && /ClassProfile\.find\(facetScope\)/.test(cpSrc));

console.log(failed ? `\n失败 ${failed} 项` : '\n全部通过');
process.exit(failed ? 1 : 0);
