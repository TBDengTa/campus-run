// 扫描：8 个分类里，是否存在「原始条目 ≥2、但任一角色下只剩 1 条可见」的分类。
// 这类分类会在「单条目不弹浮层」的规则下产生非预期的直接跳页（每个人跳的页还可能不同），
// 属于配置隐患 —— 要么合并条目，要么确认这是有意的。
// 运行：node tools/scan-nav-single-item.js
const path = require('path');
const ROOT = path.join(__dirname, '..', 'miniprogram');
const nav = require(path.join(ROOT, 'utils', 'nav-groups.js'));

// 覆盖真实会出现的管理端身份组合
const CONTEXTS = [
  { name: '超级管理员', ctx: { isSuper: true, perms: ['*'], isAdmin: true, isClassRole: false, isUnionMember: false } },
  { name: '全局配置管理员', ctx: { isSuper: false, perms: ['config.view', 'config.manage'], isAdmin: true, isClassRole: false, isUnionMember: false } },
  { name: '用户管理员', ctx: { isSuper: false, perms: ['user.view', 'user.manage', 'user.import', 'permission.manage'], isAdmin: true, isClassRole: false, isUnionMember: false } },
  { name: '内容管理员', ctx: { isSuper: false, perms: ['content.view', 'content.manage'], isAdmin: true, isClassRole: false, isUnionMember: false } },
  { name: '广告管理员', ctx: { isSuper: false, perms: ['ad.view', 'ad.manage'], isAdmin: true, isClassRole: false, isUnionMember: false } },
  { name: '考核管理员', ctx: { isSuper: false, perms: ['assessment.view', 'assessment.manage'], isAdmin: true, isClassRole: false, isUnionMember: false } },
  { name: '学生会管理员', ctx: { isSuper: false, perms: ['union.view', 'union.manage'], isAdmin: true, isClassRole: false, isUnionMember: true } },
  { name: '班主任(无权限)', ctx: { isSuper: false, perms: [], isAdmin: false, isClassRole: true, isUnionMember: false } },
  { name: '班委(无权限)', ctx: { isSuper: false, perms: [], isAdmin: false, isClassRole: true, isUnionMember: false } },
  { name: '学生会成员学生', ctx: { isSuper: false, perms: [], isAdmin: false, isClassRole: false, isUnionMember: true } },
];

// 期望「单条目直接跳」的分类（用户点名：申诉审核）
const EXPECT_SINGLE = new Set(['appeal']);

let issues = 0;
for (const { name, ctx } of CONTEXTS) {
  const groups = nav.visibleGroups(ctx);
  const lines = [];
  for (const g of groups) {
    const raw = (g.items || []).length;
    if (raw !== 1) continue;
    lines.push(`${g.title}（${g.items[0].label}）`);
    // 原始就 1 条的：单条目直接跳是预期行为，只提示
  }
  // 重点检查：原始 ≥2 但某角色下只剩 1 条可见
  for (const g of nav.NAV_GROUPS) {
    const raw = (g.items || []).length;
    if (raw < 2) continue;
    const visible = ((nav.visibleGroups(ctx).find((x) => x.key === g.key) || {}).items || []).length;
    if (visible === 1) {
      issues += 1;
      console.log(`⚠️  ${name}：「${g.title}」原始 ${raw} 条，该角色下只剩 1 条可见 → 会直接跳「${(nav.visibleGroups(ctx).find((x) => x.key === g.key) || {}).items[0].label}」`);
    }
  }
  console.log(`${name}：${groups.length} 组` + (lines.length ? ` | 单条目分类（直接跳）：${lines.join('、')}` : ''));
  // 单条目分类清单里必须包含 appeal
  if (lines.some((l) => l.startsWith('申诉审核')) && !EXPECT_SINGLE.has('appeal')) issues += 1;
}

console.log(`\n隐患数：${issues}`);
process.exit(0);
