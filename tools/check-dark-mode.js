/**
 * 静态检查：夜间模式（用户 2026-11-04「小程序夜间模式下很难看，重新美化一下夜间模式的UI效果」）
 *
 * 夜间模式的美化是**三处硬编码缺口 + 一套暗色分层手法**，全部是静默失败模式：
 *   ① 自定义 tabBar 硬编码白胶囊（影响所有 tab 页，暗色页面下最刺眼的一块）；
 *   ② 首页插画蓝天/白云/草地硬编码亮色（首页顶部一整块亮色）；
 *   ③ 跑步页整页底色 #e9edf2 + 顶部白玻璃 chip；
 *   ④ 暗色层次感弱：阴影在暗色下不可见 → 卡片必须靠 --tt-card-border 描边分层，
 *      分割线 --tt-line 必须与卡片次级背景拉开（旧值 #2c2c2c 与 secondarycontainer 同色=隐形）。
 * 另：theme.json 暗色导航栏必须与页面底色同值（#141414），否则顶部有一条色差带。
 *
 * 运行：node tools/check-dark-mode.js
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

const APP_WXSS = read('miniprogram', 'app.wxss');
const APP_JSON = JSON.parse(read('miniprogram', 'app.json'));
const THEME = JSON.parse(read('miniprogram', 'theme.json'));
const TAB_WXML = read('miniprogram', 'custom-tab-bar', 'index.wxml');
const TAB_WXSS = read('miniprogram', 'custom-tab-bar', 'index.wxss');
const HOME_WXSS = read('miniprogram', 'pages', 'home', 'home.wxss');
const RUN_WXSS = read('miniprogram', 'pages', 'run', 'index.wxss');

// 提取某个 @media (prefers-color-scheme: dark) 块内、某选择器的声明段
function darkRule(wxss, selector) {
  const blocks = wxss.match(/@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*?\n\}/g) || [];
  for (const block of blocks) {
    const m = block.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
    if (m) return m[1];
  }
  return '';
}

// ===== 1) 暗色令牌：分层手法三件套 =====
console.log('[1] app.wxss 暗色分层令牌');
// 首个暗色块是整段令牌定义：块内没有顶格的 `}`，第一个顶格 `}` 即块尾
function firstDarkBlock(wxss) {
  const start = wxss.indexOf('@media (prefers-color-scheme: dark)');
  if (start < 0) return '';
  const end = wxss.indexOf('\n}', start);
  return end < 0 ? '' : wxss.slice(start, end + 2);
}
const darkTokens = firstDarkBlock(APP_WXSS);
ok('找到暗色令牌块（非空提取）', /--tt-bg-page/.test(darkTokens));
ok('亮色块定义 --tt-card-border', /--tt-card-border:\s*transparent/.test(APP_WXSS));
ok('暗色块定义 --tt-card-border（描边分层）', /--tt-card-border:\s*rgba\(255,\s*255,\s*255/.test(darkTokens));
ok('暗色 --tt-line 不再是 #2c2c2c（与次级背景同色=隐形）', /--tt-line:/.test(darkTokens) && !/--tt-line:\s*#2c2c2c/.test(darkTokens));
ok('.card 引用描边令牌', /\.card\s*\{[^}]*var\(--tt-card-border\)/.test(APP_WXSS));
ok('.tt-card 引用描边令牌', /\.tt-card\s*\{[^}]*var\(--tt-card-border\)/.test(APP_WXSS));

// ===== 2) 自定义 tabBar 暗色适配 =====
console.log('\n[2] custom-tab-bar');
ok('WXML 不再给 t-icon 传硬编码 color（走 currentColor 继承）', !/t-icon[\s\S]{0,200}color="/.test(TAB_WXML));
ok('颜色着色上移到 .tabbar-item（图标继承层）', /\.tabbar-item\s*\{[^}]*color:\s*#9aa0a6/.test(TAB_WXSS));
const tabDark = darkRule(TAB_WXSS, '.tabbar');
ok('tabBar 有暗色 media query 块', tabDark.length > 0);
ok('暗色胶囊是深色玻璃（不再是白底）', /rgba\(28,\s*28,\s*30/.test(tabDark));
ok('暗色选中色与品牌橙暗色令牌一致（#f09248）', /#f09248/.test(darkRule(TAB_WXSS, '.tabbar-item.active')));

// ===== 3) 导航栏 / tabBar 兜底与页面底色同源 =====
console.log('\n[3] theme.json / app.json');
ok('暗色导航栏与页面底色同值（#141414，无色差带）', THEME.dark.navBgColor === '#141414' && THEME.dark.bgColor === '#141414');
const tabCfg = APP_JSON.tabBar || {};
const refs = ['color', 'selectedColor', 'backgroundColor', 'borderStyle'];
const allRefs = refs.every((k) => typeof tabCfg[k] === 'string' && tabCfg[k].startsWith('@'));
ok('app.json tabBar 兜底色走 @ 主题引用', allRefs, tabCfg);
if (allRefs) {
  const missing = refs.filter((k) => {
    const key = tabCfg[k].slice(1);
    return !(key in THEME.light) || !(key in THEME.dark);
  });
  ok('theme.json 亮/暗两套都有 tabBar 引用的 key', missing.length === 0, missing);
}

// ===== 4) 首页插画夜景化 =====
console.log('\n[4] 首页插画夜景');
for (const sel of ['.sky', '.sky-cloud', '.sky-hill', '.sky-title', '.sky-slogan']) {
  ok(`暗色块覆盖插画 ${sel}`, darkRule(HOME_WXSS, sel).length > 0);
}
ok('夜空不再是亮蓝渐变', !/#9fd8ff/.test(darkRule(HOME_WXSS, '.sky')));

// ===== 5) 跑步页 =====
console.log('\n[5] 跑步页');
ok('.run-page 底色走令牌（不再硬编码 #e9edf2）', /\.run-page\s*\{[^}]*var\(--tt-bg-page\)/.test(RUN_WXSS) && !/#e9edf2/.test(RUN_WXSS));
const chipDark = darkRule(RUN_WXSS, '.state-chip');
ok('顶部状态 chip 有暗色深玻璃覆盖', /rgba\(28,\s*28,\s*30/.test(chipDark));
ok('底部面板 .sheet 有暗色投影覆盖', darkRule(RUN_WXSS, '.sheet').length > 0);

console.log(failed ? `\n失败 ${failed} 项` : '\n夜间模式校验通过');
process.exit(failed ? 1 : 0);
