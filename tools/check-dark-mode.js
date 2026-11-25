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
const TAB_JSON = JSON.parse(read('miniprogram', 'custom-tab-bar', 'index.json'));
const HOME_WXSS = read('miniprogram', 'pages', 'home', 'home.wxss');
const CLASS_WXSS = read('miniprogram', 'packageAdmin', 'class', 'class.wxss');
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
// 玻璃化改造（2026-11-23）后口径：tabBar 颜色/玻璃底全部走 --tt-glass-* / --tt-* 令牌，
// 暗色值定义在 app.wxss 暗色令牌块 —— tabBar wxss **不再自写 @media 暗色块**（写了就是硬编码回潮）。
// ⚠️ 令牌「引用存在」不等于「运行时解析得到」：custom-tab-bar 挂在页面内容树之外，
//    令牌块选择器是 page, .page —— 必须 json apply-shared + 根节点挂 page 类，var() 才有值。
//    缺任一条时 background/box-shadow/color 在计算值阶段整条失效 = 全宽平底黑图标栏
//    （2026-11-23 真机截图报障），而下面这些文本断言依然全绿 —— 所以挂载契约单独钉两条。
console.log('\n[2] custom-tab-bar');
ok('json styleIsolation = apply-shared（app.wxss 令牌块才进得去组件）', TAB_JSON.styleIsolation === 'apply-shared', TAB_JSON.styleIsolation);
ok('WXML 根节点挂 page 类（页面树外组件取令牌的唯一途径）', /<view\s+class="[^"]*\bpage\b/.test(TAB_WXML), TAB_WXML.split('\n')[0]);
ok('WXML 不再给 t-icon 传硬编码 color（走 currentColor 继承）', !/t-icon[\s\S]{0,200}color="/.test(TAB_WXML));
ok('颜色着色上移到 .tabbar-item（图标继承层，令牌驱动）', /\.tabbar-item\s*\{[^}]*color:\s*var\(--tt-text-3\)/.test(TAB_WXSS));
ok('选中色走品牌令牌（亮暗自动适配）', /\.tabbar-item\.active\s*\{[^}]*color:\s*var\(--tt-brand\)/.test(TAB_WXSS));
ok('胶囊玻璃底走 --tt-glass-bg-strong 令牌', /\.tabbar\s*\{[^}]*background:\s*var\(--tt-glass-bg-strong\)/.test(TAB_WXSS));
ok('胶囊有 backdrop-filter 玻璃模糊（走令牌）', /backdrop-filter:\s*var\(--tt-glass-blur-strong\)/.test(TAB_WXSS));
ok('app.wxss 暗色块定义玻璃令牌（暗色玻璃底，不再是白底）', /--tt-glass-bg:\s*rgba\(30/.test(darkTokens) && /--tt-glass-bg-strong:\s*rgba\(28/.test(darkTokens));
ok('tabBar 有 backdrop-filter 不支持机型的实底降级', /@supports not[\s\S]*?--tt-glass-fallback-strong/.test(TAB_WXSS));
ok('tabBar wxss 无硬编码色值（全部走令牌）', !/#[0-9a-fA-F]{3,8}\b|rgba\(/.test(TAB_WXSS));

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

// ===== 4) 首页重设计后的暗色口径（2026-11-23：天空插画已删，改 iOS 大标题 + 待办卡 + 小组件）=====
console.log('\n[4] 首页暗色口径');
ok('天空插画已删除（首屏不再有大块亮色场景）', !/\.sky\s*\{/.test(HOME_WXSS));
ok('大标题 / 待办行 / 小组件文字走令牌', /\.home-header-title\s*\{[^}]*var\(--tt-text-1\)/.test(HOME_WXSS) && /\.todo-title\s*\{[^}]*var\(--tt-text-1\)/.test(HOME_WXSS) && /\.widget-label\s*\{[^}]*var\(--tt-text-1\)/.test(HOME_WXSS));
ok('小组件图标底色暗色有半透明 tint 覆盖', /@media \(prefers-color-scheme: dark\)[\s\S]*?\.widget-icon-water\s*\{[^}]*rgba\(/.test(HOME_WXSS));

// ===== 4b) 我的班级页 iOS 重排版暗色口径（2026-11-23）=====
// 玻璃面层/描边/hairline 全走令牌 → 暗色自动适配；页面自写实底就是漏白来源。
console.log('\n[4b] 我的班级页暗色');
ok('class 吸顶头/融合周期行不自写 background（走玻璃令牌）', !/\.cls-topbar\s*\{[^}]*background:/.test(CLASS_WXSS) && !/\.cls-topbar-range\s*\{[^}]*background:/.test(CLASS_WXSS));
ok('class 分组行 hairline 走令牌', /\.cls-row \+ \.cls-row\s*\{[^}]*var\(--tt-line\)/.test(CLASS_WXSS));
// KPI/模块 inset 块允许暗色自适应令牌浅底（--td-bg-color-secondarycontainer 暗色有 #242424 覆写，
// 与 cls-bc-day-list 同口径）；禁止的是硬编码实底（暗色漏白来源）。
ok('class KPI/模块卡不自写硬编码实底（浅底必须走暗色自适应令牌）', (() => {
  const tokenOnly = (sel) => {
    const m = CLASS_WXSS.match(new RegExp(sel.replace('.', '\\.') + '\\s*\\{([^}]*)\\}'));
    const body = (m && m[1]) || '';
    return !/background:/.test(body) || /background:\s*var\(--td-bg-color-secondarycontainer\)/.test(body);
  };
  return tokenOnly('.cls-bc-kpi') && tokenOnly('.cls-bc-module');
})());
ok('class 宽屏左栏 280px 存在', /\.screen-wide \.cls-layout\s*\{[^}]*280px/.test(CLASS_WXSS));

// ===== 5) 跑步页 =====
console.log('\n[5] 跑步页');
ok('.run-page 底色走令牌（不再硬编码 #e9edf2）', /\.run-page\s*\{[^}]*var\(--tt-bg-page\)/.test(RUN_WXSS) && !/#e9edf2/.test(RUN_WXSS));
const chipDark = darkRule(RUN_WXSS, '.state-chip');
ok('顶部状态 chip 有暗色深玻璃覆盖', /rgba\(28,\s*28,\s*30/.test(chipDark));
ok('底部面板 .sheet 有暗色投影覆盖', darkRule(RUN_WXSS, '.sheet').length > 0);

// ===== 6) 北斗运动抽奖页（用户 2026-11-13「背景颜色不对啊请你再优化一下」）=====
// 这个页面原先有 35 处硬编码色值：亮色下「谢谢参与」格是冷蓝灰、页面底是全局冷灰，
// 跟暖橙主题混在一起最刺眼；暗色下更糟 —— 硬编码不随主题变，白卡片直接漏白。
// 所以断言两件事：① 规则内不许出现裸色值（只能 var(--bd-*)）；② --bd-* 必须有暗色重写块。
console.log('\n[6] 北斗运动抽奖页');
const BD_WXSS = read('miniprogram', 'pages', 'reward', 'reward.wxss');
// 去掉两个令牌定义块与所有块注释后，剩下的规则里不应再有裸 hex。
// （注释里会举例写 #f6f7f9 这类值说明「原来是什么」，那不是声明 —— 不剥注释会误报。）
const bdNoTokens = BD_WXSS
  .replace(/page\s*\{[^}]*--bd-page-grad[\s\S]*?\n\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const bareHex = bdNoTokens.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
ok('规则内无裸色值（全部走 --bd-* 令牌）', bareHex.length === 0, bareHex.slice(0, 3));
ok('有 --bd-* 令牌定义块', /--bd-page-grad:/.test(BD_WXSS));
ok('页面底是暖光渐晕（不再直接铺全局冷灰）', /\.bd-page\s*\{[^}]*var\(--bd-page-grad\)/.test(BD_WXSS));
// 收尾色也必须是暖的：上半暖下半冷（用 --tt-bg-page #f6f7f9 收尾）是这次投诉的直接原因。
// 只看**亮色块**：暗色下回落到全局深底是对的，不能一起判。
const bdLightBlock = BD_WXSS.slice(0, BD_WXSS.indexOf('@media (prefers-color-scheme: dark)'));
ok('渐晕整页暖调（亮色收尾不回落全局冷灰）',
  /--bd-page-grad:[^;]*#fffbf6/.test(bdLightBlock) && !/--bd-page-grad:[^;]*var\(--tt-bg-page\)/.test(bdLightBlock));
ok('渐晕停靠点用固定 rpx（超过一屏不会被拉长成整页渐变）',
  /--bd-page-grad:[^;]*\d+rpx/.test(BD_WXSS) && !/--bd-page-grad:[^;]*30%/.test(BD_WXSS));
const bdDarkBlock = BD_WXSS.slice(BD_WXSS.indexOf('@media (prefers-color-scheme: dark)'));
ok('--bd-* 有暗色重写块', /@media \(prefers-color-scheme: dark\)[\s\S]*--bd-page-grad:/.test(BD_WXSS));
ok('暗色下盘面/格子被压暗（不是套用亮色暖橙）',
  /--bd-sector-steps-grad:\s*linear-gradient\(180deg,\s*#4a3320/.test(bdDarkBlock));
ok('暗色下禁用态灰渐变也重写（否则是一块刺眼浅灰板）',
  /--bd-center-off-grad:/.test(bdDarkBlock));
// 「谢谢参与」格底：亮色下必须是暖灰（原来的 #dfe3ea 是冷蓝，跟橙盘不是一系）
ok('「谢谢参与」格底改暖灰（不再冷蓝）',
  /--bd-sector-none-grad:[^;]*#e8dfd6/.test(BD_WXSS) && !/--bd-sector-none-grad:[^;]*#dfe3ea/.test(BD_WXSS));
// 奖项文字对比度：浅灰字在浅暖灰底上读不清（截图里「谢谢」几乎看不见）
ok('空奖文字对比度压深（≥3:1，不再用浅灰）',
  /--bd-val-none:\s*#6b5f54/.test(BD_WXSS) && !/--bd-val-none:\s*#a3968a/.test(BD_WXSS));

console.log(failed ? `\n失败 ${failed} 项` : '\n夜间模式校验通过');process.exit(failed ? 1 : 0);
