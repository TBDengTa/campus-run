// 可重复运行：核对 nav-groups.js 是否覆盖了 packageAdmin 的全部页面（对照勘察报告）
// 运行：node tools/check-admin-nav-coverage.js
// 判定标准：每个管理端页面要么有直接入口，要么是「设计上的二级页」（从别的页面进）
const fs = require('fs');
const path = require('path');

const M = path.join(__dirname, '..', 'miniprogram');
const nav = require(path.join(M, 'utils', 'nav-groups.js'));
const app = JSON.parse(fs.readFileSync(path.join(M, 'app.json'), 'utf8'));

// 管理端（packageAdmin + packageUnion + 被管理端引用的主包页）全部页面
const adminPages = [];
for (const sp of app.subpackages || []) {
  if (sp.root !== 'packageAdmin' && sp.root !== 'packageUnion') continue;
  for (const p of sp.pages || []) adminPages.push(`${sp.root}/${p}`);
}

// 设计上的二级页（从其它页面进入，不需要一级入口）——依据勘察报告的 A 表
const SECOND_LEVEL = new Set([
  'packageAdmin/users/account-edit/account-edit', // 用户列表 → 账户编辑
  'packageAdmin/user-detail/user-detail', // 用户列表 / 班级名单 → 用户详情
  'packageAdmin/user-detail/period-detail/period-detail', // 用户详情 / 班级卡 → 运动明细
  'packageUnion/entry/entry', // 学生会工作台 / 首页学生会块 → 检查录入
  'packageUnion/record/record', // 记录列表 → 记录详情
  'packageUnion/roster/roster', // 学生会工作台 / 我的页 → 通讯录
  // 本班宿舍绑定：从「班级管理」列表点「宿舍」进入。
  // 它的 URL 是模板字符串拼的（`...dorms?id=${id}&className=...`），
  // 本脚本只认 nav-groups 的 url 字面量，所以必须显式列进白名单，否则会误报成不可达。
  'packageAdmin/class-manage/dorms/dorms',
  // 学生会成员管理（主席团 / 部长用）：从学生会工作台的「成员管理」进入，URL 无字面量入口
  'packageUnion/members/manage',
]);

// nav-groups 里的一级入口
const linked = new Set();
for (const g of nav.NAV_GROUPS) for (const it of g.items) linked.add(it.url.split('?')[0].replace(/^\//, ''));

const unreachable = adminPages.filter((p) => !linked.has(p) && !SECOND_LEVEL.has(p));
const missingFile = [...linked].filter((p) => p.startsWith('package') && !fs.existsSync(path.join(M, `${p}.js`)));

console.log(`管理端页面 ${adminPages.length} 个 | 一级入口 ${linked.size} 个 | 二级页白名单 ${SECOND_LEVEL.size} 个`);
if (missingFile.length) console.log('入口指向不存在的页面:', missingFile.join(', '));
if (unreachable.length) {
  console.log(`\n既无一级入口、也不在二级页白名单（${unreachable.length} 个）:`);
  for (const p of unreachable) console.log('  -', p);
} else {
  console.log('\n所有管理端页面都有入口或属于设计上的二级页');
}

// 顺带打印最终分类（对照用户要求的 8 类）
console.log('\n分类结构：');
for (const g of nav.NAV_GROUPS) {
  console.log(`  ${g.title}（${g.items.length}）: ${g.items.map((i) => i.label).join('、')}`);
}
process.exit(missingFile.length || unreachable.length ? 1 : 0);
