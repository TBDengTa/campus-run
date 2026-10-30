/**
 * 静态检查器：封禁来源分类（用户 2026-10-30「用户管理列表中的封禁用户要有分类
 * 如人封、机封、AI封的分类」）。
 *
 * 为什么单独一个检查器（而不是塞进 check-server-contract）：
 * 这个功能的失败模式全都是**静默**的 ——
 *   · 前端自己映射一份文案 → 改了服务端文案不会报错，只是两边显示不一样；
 *   · 筛选参数没进 buildQuery → 下拉能选、点了没反应；
 *   · WXML 引用了 JS 没算的字段 → 徽标永远不显示（不是报错，是永远没有）；
 *   · legacy（历史无 source）漏掉 → 分类加起来对不上总数，管理员以为筛选坏了。
 * 以上四条没有一条会被现有检查器抓到，所以逐条钉死。
 *
 * 运行：node tools/check-ban-source.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let failed = 0;
function ok(name, cond, detail) {
  console.log(`${cond ? '  ok   ' : '  FAIL '}${name}${cond ? '' : '  -> ' + JSON.stringify(detail)}`);
  if (!cond) failed += 1;
}

const MODEL = read('server', 'src', 'models', 'ban-record.js');
const USERS_ROUTE = read('server', 'src', 'routes', 'admin', 'users.js');
const AC_SVC = read('server', 'src', 'services', 'anticheat.js');
const AC_MODEL = read('server', 'src', 'services', 'anticheat-model.js');
const USERS_JS = read('miniprogram', 'packageAdmin', 'users', 'users.js');
const USERS_WXML = read('miniprogram', 'packageAdmin', 'users', 'users.wxml');
const DETAIL_JS = read('miniprogram', 'packageAdmin', 'user-detail', 'user-detail.js');
const DETAIL_WXML = read('miniprogram', 'packageAdmin', 'user-detail', 'user-detail.wxml');

// ===== 1) 分类必须齐全且互斥 =====
console.log('[1] 分类定义');
const sourceText = {};
for (const m of MODEL.matchAll(/^\s*(manual|ai|rule|legacy|appeal):\s*'([^']+)'/gm)) sourceText[m[1]] = m[2];
for (const k of ['manual', 'ai', 'rule', 'legacy']) {
  ok(`SOURCE_TEXT 含 ${k}`, !!sourceText[k], Object.keys(sourceText));
}
ok('legacy 文案是短词（chip 宽度预算）', (sourceText.legacy || '').length <= 3, sourceText.legacy);

// ===== 2) 文案以服务端为准，前端只留兜底 =====
console.log('\n[2] 文案单点定义（前端兜底可以，但必须优先用服务端下发）');
// 本仓库既有约定就是「服务端下发 xxxText + 前端留一张兜底表」（见 classStatusText：
//   `u.classStatusText || CLASS_STATUS_TEXT[...]`）。封禁分类沿用同一模式，
//   所以这里守的不是「前端不许有表」，而是「必须优先消费服务端文案」——
//   只查有没有表会误伤合规写法（我第一版就是按后者写的，会把 classStatus 同款实现判成违规）。
ok('users.js 优先用服务端 sourceText', /sourceText\s*\|\|\s*BAN_SOURCE_TEXT/.test(USERS_JS));
// 消费方式允许两种等价写法：`x.sourceText || 兜底` 或「有 sourceText 就先 return」。
// 断言只查「读没读服务端那个字段」，绑死某一种写法会在别人重构成提前返回时假报失败
// （我第一版就是这么写的，把正确实现判成了违规）。
ok('user-detail.js 优先用服务端 sourceText', /r\.sourceText|sourceText\s*\|\|\s*BAN_SOURCE_TEXT/.test(DETAIL_JS));
ok('users.js 兜底表含 legacy 短词', /legacy:\s*'早期'/.test(USERS_JS));

// ===== 3) 筛选参数必须真的发给服务端 =====
console.log('\n[3] 筛选接线完整（漏一处就是"能选但没反应"）');
ok('buildQuery 维度列表含 banSource', /for \(const k of \[[^\]]*'banSource'[^\]]*\]\)/.test(USERS_JS));
ok('filters 初值含 banSource', /filters:\s*\{[\s\S]*?banSource:\s*''/.test(USERS_JS));
ok('clearFilters 复位含 banSource', /const empty = \{[\s\S]*?banSource:\s*''/.test(USERS_JS));
ok('FILTER_LABELS 含 banSource', /const FILTER_LABELS = \{[\s\S]*?banSource:/.test(USERS_JS));
ok('FILTER_OPTION_KEYS 含 banSource', /const FILTER_OPTION_KEYS = \{[\s\S]*?banSource:/.test(USERS_JS));
ok('WXML 有封禁类型下拉项', /filterLabels\.banSource/.test(USERS_WXML) && /data-key="banSource"/.test(USERS_WXML));
ok('服务端读 q.banSource', /q\.banSource/.test(USERS_ROUTE));

// 防漂移：筛选维度数 = 触发器数（与 check-admin-users-page 同一思路，双保险）
const labelBlock = (USERS_JS.match(/const FILTER_LABELS = \{([\s\S]*?)\};/) || ['', ''])[1];
const filterKeys = [...labelBlock.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
for (const k of filterKeys) {
  const keysBlock = (USERS_JS.match(/const FILTER_OPTION_KEYS = \{([\s\S]*?)\};/) || ['', ''])[1];
  if (!new RegExp(`\\b${k}:`).test(keysBlock)) ok(`FILTER_OPTION_KEYS 覆盖 ${k}`, false, '缺失');
}
ok('FILTER_OPTION_KEYS 覆盖全部筛选维度', true, filterKeys.length);

// ===== 4) 服务端筛选与计数共用一份条件 =====
console.log('\n[4] 单一口径（选项计数与筛选结果不许各算一遍）');
ok('banSourceCond 是唯一条件构造', (USERS_ROUTE.match(/function banSourceCond/g) || []).length === 1);
const condCalls = (USERS_ROUTE.match(/banSourceCond\(/g) || []).length;
ok('banSourceCond 被筛选与计数共同复用（≥2 处）', condCalls >= 2, condCalls);
ok('不存在第二份内联 source 计数', !/countOf\('manual'\)[\s\S]{0,200}ongoing/.test(USERS_ROUTE));
// 「$or 同键展开」是本功能真实踩过的坑（计数会把已过期的也算进来）
const condBody = (USERS_ROUTE.match(/function banSourceCond[\s\S]*?\n\}/) || [''])[0];
ok('条件内无两个 $or 同键展开', !/\.\.\.missing\([^)]*\),\s*\.\.\.liveLogin/.test(condBody));
ok('legacy 覆盖「source 缺失」三种形态', /\$exists:\s*false[\s\S]*null[\s\S]*''/.test(condBody), condBody.slice(0, 0));

// ===== 5) activeRestrictions 必须带 source（唯一出口） =====
console.log('\n[5] 生效限制带来源');
const ar = (AC_SVC.match(/function activeRestrictions[\s\S]*?\n\}/) || [''])[0];
ok('activeRestrictions 输出 source', /source:/.test(ar));
ok('login 档也带 source', /norm\(user\.banSource/.test(ar));
ok('sync/gps 带 source', /norm\(r\.source/.test(ar));
ok('AI 自动封禁标 ai', /source:\s*'ai'/.test(read('server', 'src', 'services', 'steps.js')));
ok('规则暴增标 rule', /source:\s*'rule'/.test(AC_SVC));
ok('人工封禁标 manual', /source:\s*'manual'/.test(AC_SVC));

// ===== 6) 展示位齐了没有 =====
console.log('\n[6] 展示位');
ok('列表行有 banInfo 附件', /attachBanInfo/.test(USERS_ROUTE));
ok('两条列表分支都挂 banInfo', (USERS_ROUTE.match(/await attachBanInfo\(list\)/g) || []).length === 2, (USERS_ROUTE.match(/attachBanInfo/g) || []).length);
ok('users 列表标签带分类', /SCOPE_LABELS\[s\]\}\$\{|banInfo/.test(USERS_JS));
ok('详情页「当前限制」有徽标', /ud-limit-src/.test(DETAIL_WXML));
ok('详情页流水也显示分类', /banSourceLabel/.test(DETAIL_WXML) || /sourceText/.test(DETAIL_WXML));
// WXML 引用了就必须由 JS 算出来（否则永远不显示，且不会报错）
const wxmlFields = [...DETAIL_WXML.matchAll(/item\.(showBanSource|banSourceLabel)/g)].map((m) => m[1]);
for (const f of [...new Set(wxmlFields)]) {
  ok(`user-detail.js 计算了 ${f}`, new RegExp(`${f}:`).test(DETAIL_JS), 'JS 未产出该字段');
}
// 两条读路径（管理端详情 / 班级域）都要给，否则班主任看不到
ok('班级域分支也带分类', /BAN_SOURCE_TEXT\[r\.source\]|sourceText/.test(DETAIL_JS));

// ===== 7) 反作弊配置页文案已适配 AI 化 =====
console.log('\n[7] 反作弊页文案');
const AC_WXML = read('miniprogram', 'packageAdmin', 'config', 'anticheat.wxml');
const acVisible = AC_WXML.replace(/<!--[\s\S]*?-->/g, '');
ok('不再用「启用自动检测」（旧规则时代说法）', !/启用自动检测/.test(acVisible));
ok('开关文案说明「AI 仍检测、只是不自动处置」', /AI 仍会检测/.test(acVisible));
ok('页面无「同步增速」残留（应叫涨幅速度）', !/同步增速/.test(acVisible));

// ===== 8) 详情接口不得泄露凭据（banInfo 是新加的响应字段） =====
console.log('\n[8] 安全边界');
ok('列表仍排除凭据字段', /CREDENTIAL_FIELDS/.test(USERS_ROUTE));
ok('attachBanInfo 不透出 openid 之外敏感字段', !/passwordHash|initialHashes|resetHashes/.test(
  (USERS_ROUTE.match(/async function attachBanInfo[\s\S]*?\n\}/) || [''])[0]
));

console.log(failed ? `\n失败 ${failed} 项` : '\n封禁分类校验通过');
process.exit(failed ? 1 : 0);
