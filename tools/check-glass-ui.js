// 可重复运行：玻璃拟态 UI（Glassmorphism 2.0）+ 三端响应式 + 统一工作台 的静态契约检查
// （用户 2026-11-23「导航栏改成 iOS 玻璃拟态 + iPhone/iPad/Mac 三端适配 + 多身份统一工作台」）
// 运行：node tools/check-glass-ui.js
//
// 守住的核心口径（回退任何一条都会静默复发）：
//   ① 玻璃令牌单一来源在 app.wxss（亮/暗两套），页面/组件只引用不自定义；
//   ② blur 20~40px；-webkit- 前缀必须带（iOS WebView）；
//   ③ @supports not 降级到高不透明实底（老机型不支持 backdrop-filter 时不能糊成透明一片）；
//   ④ 200ms ease-out 过渡；按压压缩、hover 提亮只在 @media (hover:hover) 内；
//   ⑤ 宽屏块（.screen-regular/.screen-wide/.tabbar-wide）内一律 px 禁 rpx
//     （rpx 按窗口宽换算，宽窗口会把字号/圆角放大数倍 —— wcamera 横屏踩过同类坑）；
//   ⑥ 断点唯一实现 utils/screen.js（600/900），三个核心页接 screenBehavior；
//     app.json 必须 resizable:true —— 缺它窗口尺寸永不变化，整套响应式静默失效；
//   ⑦ tabBar 动态项只有唯一「工作台」，旧的多身份互挤 tab 常量不许回潮；
//   ⑧ 核心页不留裸 .tt-card（实底卡混在玻璃页里 = 漏改），公共交互类必须真的被 WXML 用上；
//   ⑨ tabBar 挂载契约：json apply-shared + 根节点 page 类 + 被引用令牌亮暗都有定义
//     （组件在页面树外，缺任一条 var() 计算值失效 = 平底黑栏，文本断言抓不到）。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
let failed = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -> ${detail}`}`);
  if (!cond) failed += 1;
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 顶层块切分（含嵌套 @media/@supports：header + 完整 body），先去注释
function topBlocks(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const header = src.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') depth -= 1;
      j += 1;
    }
    blocks.push({ header, body: src.slice(open + 1, j - 1) });
    i = j;
  }
  return blocks;
}

// 递归找「选择器命中 re」的块（@media/@supports 会往里钻）
function findBlocks(css, re, out = []) {
  for (const b of topBlocks(css)) {
    if (/^@(media|supports)/.test(b.header)) findBlocks(b.body, re, out);
    else if (re.test(b.header)) out.push(b);
  }
  return out;
}

function walkFiles(dir, ext, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'miniprogram_npm' || name === 'node_modules') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkFiles(p, ext, out);
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

const APP = read('app.wxss');
const TAB_WXSS = read('custom-tab-bar/index.wxss');
const TAB_JS = read('custom-tab-bar/index.js');
const TAB_WXML = read('custom-tab-bar/index.wxml');
const TAB_JSON = JSON.parse(read('custom-tab-bar/index.json'));

// ===== [1] 玻璃令牌单一来源（app.wxss 亮/暗两套） =====
console.log('[1] 玻璃令牌单一来源');
const GLASS_TOKENS = [
  '--tt-glass-bg', '--tt-glass-bg-strong', '--tt-glass-bg-hover',
  '--tt-glass-blur', '--tt-glass-blur-strong', '--tt-glass-border',
  '--tt-glass-edge', '--tt-glass-shadow', '--tt-glass-fallback', '--tt-glass-fallback-strong',
];
for (const t of GLASS_TOKENS) {
  const defs = APP.match(new RegExp(`${t}:`, 'g')) || [];
  check(`app.wxss 定义 ${t}（亮+暗两处）`, defs.length >= 2, `只有 ${defs.length} 处`);
}
check('app.wxss 定义 --tt-ambient（亮+暗）', (APP.match(/--tt-ambient:/g) || []).length >= 2, '缺环境光令牌');
{
  const offenders = [];
  for (const f of walkFiles(ROOT, '.wxss')) {
    if (path.resolve(f) === path.resolve(path.join(ROOT, 'app.wxss'))) continue;
    const css = fs.readFileSync(f, 'utf8');
    if (/--tt-glass-[a-z-]+\s*:/.test(css) || /--tt-ambient\s*:/.test(css)) {
      offenders.push(path.relative(ROOT, f));
    }
  }
  check('页面/组件不自定义玻璃令牌（只引用）', offenders.length === 0, offenders.join('、'));
}

// ===== [2] blur 规格：20~40px =====
console.log('\n[2] blur 规格 20~40px');
{
  const blurs = [...APP.matchAll(/--tt-glass-blur(?:-strong)?:\s*blur\((\d+)px\)/g)].map((m) => Number(m[1]));
  check('玻璃 blur 令牌存在', blurs.length >= 4, `只解析到 ${blurs.length} 个`);
  check('全部落在 20~40px', blurs.every((n) => n >= 20 && n <= 40), blurs.join(','));
}

// ===== [3] 玻璃公共类：双前缀 backdrop-filter + 令牌面层 + 200ms ease-out =====
console.log('\n[3] .tt-glass / .tt-glass-float 实现');
for (const cls of ['.tt-glass', '.tt-glass-float']) {
  const b = findBlocks(APP, new RegExp(`^${cls.replace('.', '\\.')}$`))[0];
  check(`${cls} 存在`, !!b, '未定义');
  if (!b) continue;
  check(`${cls} backdrop-filter 走令牌（含 -webkit- 前缀）`,
    /-webkit-backdrop-filter:\s*var\(--tt-glass-blur/.test(b.body) && /(^|\s)backdrop-filter:\s*var\(--tt-glass-blur/.test(b.body),
    b.body.slice(0, 120));
  check(`${cls} 面层/描边/柔影全走令牌`,
    /background:\s*var\(--tt-glass-bg/.test(b.body) && b.body.includes('var(--tt-glass-border)') && b.body.includes('var(--tt-glass-shadow)'),
    '有硬编码面层或阴影');
  check(`${cls} 过渡 200ms ease-out`, /transition:[^;]*0\.2s ease-out/.test(b.body), '缺 0.2s ease-out');
}
{
  const amb = findBlocks(APP, /^\.tt-ambient-page$/)[0];
  check('.tt-ambient-page 背景走 --tt-ambient', !!amb && /background:\s*var\(--tt-ambient\)/.test(amb.body), '未接线');
  check('.tt-ambient-page 铺满一屏（min-height，内容不足时不露纯色底缝）',
    !!amb && /min-height:\s*100vh/.test(amb.body), '缺 min-height');
}

// ===== [4] 交互：按压压缩 / hover 提亮（仅 hover 设备）/ 动效减弱 =====
console.log('\n[4] 交互契约');
{
  const press = findBlocks(APP, /^\.tt-glass-press:active$/)[0];
  check('按压轻微压缩（scale<1）', !!press && /transform:\s*scale\(0\.9\d*\)/.test(press.body), '缺按压反馈');
  const hoverMedia = topBlocks(APP).find((b) => /^@media \(hover: hover\)/.test(b.header));
  check('hover 提亮包在 @media (hover:hover) 内（触屏不粘滞）',
    !!hoverMedia && hoverMedia.body.includes('.tt-glass-hover:hover') && hoverMedia.body.includes('var(--tt-glass-bg-hover)'),
    '缺 hover 媒体查询');
  const tabHover = topBlocks(TAB_WXSS).find((b) => /^@media \(hover: hover\)/.test(b.header));
  check('tabBar hover 同样只在可 hover 设备生效', !!tabHover && tabHover.body.includes('.tabbar-item:hover'), 'tabBar 缺 hover 守卫');
  check('tabBar 按压压缩', /\.tabbar-item:active \.tabbar-pill\s*\{[^}]*scale\(0\.9/.test(TAB_WXSS), '缺按压反馈');
  for (const [name, css] of [['app.wxss', APP], ['tabBar', TAB_WXSS]]) {
    const rm = topBlocks(css).find((b) => /^@media \(prefers-reduced-motion: reduce\)/.test(b.header));
    check(`${name} 尊重 prefers-reduced-motion`, !!rm && rm.body.includes('transition: none'), '缺动效减弱块');
  }
}

// ===== [5] 降级链：@supports not → 高不透明实底 =====
console.log('\n[5] backdrop-filter 降级链');
for (const [name, css, token] of [['app.wxss', APP, '--tt-glass-fallback'], ['tabBar', TAB_WXSS, '--tt-glass-fallback-strong']]) {
  const sup = topBlocks(css).find((b) => /^@supports not/.test(b.header) && b.header.includes('backdrop-filter'));
  check(`${name} 有 @supports not 降级且引用实底令牌`, !!sup && sup.body.includes(`var(${token})`), '缺降级链');
}

// ===== [6] 宽屏块内一律 px、禁 rpx =====
console.log('\n[6] 宽屏块禁 rpx（.screen-regular / .screen-wide / .tabbar-wide）');
{
  const files = ['app.wxss', 'custom-tab-bar/index.wxss', 'pages/home/home.wxss', 'pages/hub/hub.wxss', 'pages/profile/profile.wxss', 'packageAdmin/class/class.wxss'];
  const wideRe = /\.screen-regular|\.screen-wide|\.tabbar-wide/;
  const offenders = [];
  for (const rel of files) {
    for (const b of findBlocks(read(rel), wideRe)) {
      if (/\drpx/.test(b.body)) offenders.push(`${rel} { ${b.header.slice(0, 60)} }`);
    }
  }
  check('宽屏选择器块内无 rpx', offenders.length === 0, offenders.slice(0, 5).join(' | '));
}

// ===== [7] 断点唯一实现 + 三核心页接线 =====
console.log('\n[7] 响应式基建与三页接线');
{
  const screenJs = read('utils/screen.js');
  check('utils/screen.js 断点 600/900', /REGULAR_MIN\s*=\s*600/.test(screenJs) && /WIDE_MIN\s*=\s*900/.test(screenJs), '断点漂移');
  check('utils/screen.js 导出 modeOf/currentMode/onResize',
    ['modeOf', 'currentMode', 'onResize'].every((k) => screenJs.includes(k)), '缺导出');
  const defOffenders = walkFiles(ROOT, '.js')
    .filter((f) => /const\s+(REGULAR_MIN|WIDE_MIN)\s*=/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f))
    .filter((rel) => rel.replace(/\\/g, '/') !== 'utils/screen.js');
  check('断点常量只在 utils/screen.js 定义（禁止各页自拼）', defOffenders.length === 0, defOffenders.join('、'));

  const behavior = read('behaviors/screen.js');
  check('screen behavior：attached 挂 screenMode + onResize，detached 解绑',
    /attached/.test(behavior) && /onResize/.test(behavior) && /detached/.test(behavior) && /screenMode/.test(behavior),
    'behavior 生命周期不完整（会泄漏监听）');

  // resizable 是三端响应式的**总开关**：官方「响应显示区域变化」明确 —— 缺它时显示区域尺寸
  // 自页面初始化起就不变（iPad 不随屏幕旋转、Windows/Mac 不进大屏模式也不能拉伸窗口），
  // wx.onWindowResize 永不触发 → screenMode 恒 compact → 双栏/三栏版式在 iPad/PC 上完全不生效。
  // 这类失效不报错、不白屏，静态检查其余各条还全绿，所以必须单独钉住。
  const appJsonForScreen = JSON.parse(read('app.json'));
  check('app.json resizable = true（iPad 旋转 / PC 大屏模式的唯一开关）',
    appJsonForScreen.resizable === true, '缺 resizable，窗口尺寸不会变化，响应式恒 compact');

  for (const page of ['home', 'hub', 'profile']) {
    const js = read(`pages/${page}/${page}.js`);
    const wxml = read(`pages/${page}/${page}.wxml`);
    check(`${page} 接 screenBehavior`, js.includes("require('../../behaviors/screen')") && /behaviors:\s*\[[^\]]*screenBehavior/.test(js), '未挂 behavior');
    check(`${page} 根节点挂 screen-{{screenMode}} + tt-ambient-page`,
      wxml.includes('screen-{{screenMode}}') && wxml.includes('tt-ambient-page'), '根类缺失');
  }
  // 我的班级页（2026-11-23 iOS 重排版）同样接三端 + 环境光
  {
    const js = read('packageAdmin/class/class.js');
    const wxml = read('packageAdmin/class/class.wxml');
    check('class 接 screenBehavior', js.includes("require('../../behaviors/screen')") && /behaviors:\s*\[[^\]]*screenBehavior/.test(js), '未挂 behavior');
    check('class 根节点挂 screen-{{screenMode}} + tt-ambient-page',
      wxml.includes('screen-{{screenMode}}') && wxml.includes('tt-ambient-page'), '根类缺失');
  }
}

// ===== [8] 三端布局：单列 / 双栏 / 三栏 =====
console.log('\n[8] 三端布局');
{
  const home = read('pages/home/home.wxss');
  const profile = read('pages/profile/profile.wxss');
  const hub = read('pages/hub/hub.wxss');
  const colOf = (css, sel) => {
    const b = findBlocks(css, new RegExp(sel.replace(/[.]/g, '\\.') + '$'))[0];
    return b ? (b.body.match(/columns:\s*(\d)/) || [])[1] : null;
  };
  check('home：iPad 双列 / Mac·PC 三列', colOf(home, '.screen-regular .home-grid') === '2' && colOf(home, '.screen-wide .home-grid') === '3', '列数不符');
  check('profile：iPad 双列 / Mac·PC 三列', colOf(profile, '.screen-regular .profile-grid') === '2' && colOf(profile, '.screen-wide .profile-grid') === '3', '列数不符');
  check('home/profile 卡片不跨列断块（break-inside: avoid）',
    /\.home-cell\s*\{[^}]*break-inside:\s*avoid/.test(home) && /\.profile-cell\s*\{[^}]*break-inside:\s*avoid/.test(profile),
    '卡片会被 columns 从中间切开');
  check('hub：iPad 分组双栏 grid', /\.screen-regular \.hub-groups\s*\{[^}]*grid-template-columns:\s*1fr 1fr/.test(hub), '缺双栏');
  check('hub：手机/iPad 入口每行 4 个',
    /\.hub-card\s*\{[^}]*display: grid[^}]*repeat\(4, minmax\(0, 1fr\)\)/.test(hub) &&
      /\.screen-regular \.hub-card\s*\{[^}]*repeat\(4, minmax\(0, 1fr\)\)/.test(hub),
    '缺 4 列宫格');
  check('hub：Mac·PC 入口每行 5 个',
    /\.screen-wide \.hub-card\s*\{[^}]*repeat\(5, minmax\(0, 1fr\)\)/.test(hub),
    '缺 5 列宫格');
  check('hub：班级 chips 跨整行（不被宫格压成一个小格）',
    /\.hub-classes\s*\{[^}]*grid-column:\s*1 \/ -1/.test(hub),
    '班级 chips 未跨列');
  check('hub：Mac·PC 左身份栏(300px sticky) + 右自适应网格',
    /\.screen-wide \.hub-layout\s*\{[^}]*grid-template-columns:\s*300px minmax\(0, 1fr\)/.test(hub)
      && /\.screen-wide \.hub-side\s*\{[^}]*position:\s*sticky/.test(hub)
      && /repeat\(auto-fill, minmax\(280px, 1fr\)\)/.test(hub),
    '缺三栏 dashboard 布局');
  check('tabBar 宽屏居中胶囊（.tabbar-wide px 定宽）',
    /\.tabbar-wide\s*\{[^}]*translateX\(-50%\)[^}]*width:\s*560px/.test(TAB_WXSS), '宽屏 tabBar 未居中');
}

// ===== [9] 统一工作台：唯一动态项，旧互挤常量不回潮 =====
console.log('\n[9] 统一工作台（多身份导航整合）');
{
  check('tabBar 只有唯一动态项 WORKBENCH_TAB', TAB_JS.includes('WORKBENCH_TAB'), '缺工作台常量');
  const legacy = ['STUDENT_TAB_HUB', 'BANCHAO_TAB', 'UNION_TAB', 'TEACHER_TABS_ADMIN', 'TEACHER_TABS_CLASS'].filter((k) => TAB_JS.includes(k));
  check('旧「多身份互挤」tab 常量已移除', legacy.length === 0, legacy.join('、'));
  check('WXML 有玻璃药丸 + 宽屏类接线', TAB_WXML.includes('tabbar-pill') && TAB_WXML.includes('tabbar-wide'), '结构缺接线');
  const appJson = JSON.parse(read('app.json'));
  check('app.json tabBar.custom = true', appJson.tabBar && appJson.tabBar.custom === true, '自定义 tabBar 被关');
  const hubTab = (appJson.tabBar.list || []).find((t) => t.pagePath === 'pages/hub/hub');
  check('app.json 工作台 tab 文案 =「工作台」', !!hubTab && hubTab.text === '工作台', JSON.stringify(hubTab));
  const nav = require(path.join(ROOT, 'utils/nav-groups.js'));
  const unionGroup = nav.NAV_GROUPS.find((g) => g.key === 'union');
  check('nav-groups 学生会组含检查录入（unionEntry，取消学生会 tab 后入口不丢）',
    !!unionGroup && unionGroup.items.some((i) => i.only === 'unionEntry' && i.url === '/pages/union/union'),
    '工作台里找不到检查录入');
}

// ===== [10] 玻璃面层覆盖 + 交互类真的被用上 =====
console.log('\n[10] 核心页玻璃覆盖与交互接线');
{
  // 核心页里不许留裸 .tt-card：环境光玻璃页中夹一张实底卡，观感是「漏改了一块」
  // （真实踩过：profile 的「运动与健康 / 账号与帮助」两张菜单卡漏挂 tt-glass）。
  const bare = [];
  for (const page of ['home', 'hub', 'profile']) {
    const wxml = read(`pages/${page}/${page}.wxml`).replace(/<!--[\s\S]*?-->/g, '');
    for (const m of wxml.matchAll(/class="([^"]*)"/g)) {
      if (/\btt-card\b/.test(m[1]) && !/\btt-glass\b/.test(m[1])) bare.push(`${page}: ${m[1]}`);
    }
  }
  {
    const wxml = read('packageAdmin/class/class.wxml').replace(/<!--[\s\S]*?-->/g, '');
    for (const m of wxml.matchAll(/class="([^"]*)"/g)) {
      if (/\btt-card\b/.test(m[1]) && !/\btt-glass\b/.test(m[1])) bare.push(`class: ${m[1]}`);
    }
  }
  check('核心页每张 tt-card 都挂 tt-glass（无实底漏改）', bare.length === 0, bare.join(' | '));

  // 公共交互类定义了却没人用 = 死代码：按压/悬停反馈在真机上根本不出现
  const wxmlAll = walkFiles(ROOT, '.wxml').map((f) => fs.readFileSync(f, 'utf8'));
  for (const cls of ['tt-glass-press', 'tt-glass-hover', 'tt-glass-float']) {
    check(`${cls} 被实际使用（不是只定义不接线）`, wxmlAll.some((s) => s.includes(cls)), '全仓 WXML 无一处使用');
  }

  // 悬浮层玻璃化的级联陷阱：页面 wxss 在 app.wxss **之后**生效，
  // 浮层自己的规则里再写 background 会把 .tt-glass-float 的面层整个盖掉（不报错，只是回到实底）。
  // .tt-sheet 的实底保留给未玻璃化的其它页面，靠后定义的 .tt-glass-float 覆盖，不需要改。
  const sheetRules = [
    ['pages/profile/profile.wxss', '.pf-qr-sheet'],
    ['packageAdmin/class/class.wxss', '.cls-sheet'],
  ];
  for (const [rel, sel] of sheetRules) {
    const b = findBlocks(read(rel), new RegExp(`^${sel.replace('.', '\\.')}$`))[0];
    check(`${rel} ${sel} 不自写 background（否则盖掉玻璃面层）`,
      !!b && !/(^|;|\s)background\s*:/.test(b.body), '浮层仍是实底');
  }
}

// ===== [11] tabBar 令牌可达性（挂载契约） =====
// var() 失效发生在**计算值阶段**：变量名合法、引用语法合法，但选择器命中不到消费节点的祖先时
// 整条 background/box-shadow/color 被丢弃 —— 文本正则（「引用存在」「变量名出现过」）天然抓不到。
// custom-tab-bar 挂在页面内容树之外，令牌块选择器是 page, .page，故必须：
//   ① json styleIsolation apply-shared（否则 app.wxss 类选择器进不去组件）；
//   ② 根节点挂 page 类（否则 .page 令牌块命中不到组件根）；
//   ③ 组件引用的每个令牌在亮/暗两个 .page 块里都有定义。
// 缺任一条 = 全宽平底黑图标栏（2026-11-23 真机截图报障），其余断言仍全绿。
console.log('\n[11] tabBar 令牌可达性（挂载契约）');
{
  check('tabBar json styleIsolation = apply-shared', TAB_JSON.styleIsolation === 'apply-shared', JSON.stringify(TAB_JSON));
  const rootClass = (TAB_WXML.match(/<view\s+class="([^"]*)"/) || [])[1] || '';
  check('tabBar 根节点挂 page 类', /\bpage\b/.test(rootClass), rootClass);
  const tokenBlocks = findBlocks(APP, /\.page\b/);
  const used = [...new Set([...TAB_WXSS.matchAll(/var\((--tt-[a-z0-9-]+)/g)].map((m) => m[1]))];
  check('tabBar 确实引用了 --tt-* 令牌（非硬编码）', used.length > 0, '一个令牌都没引用');
  const unreachable = used.filter((n) => tokenBlocks.filter((b) => b.body.includes(`${n}:`)).length < 2);
  check('每个被引用令牌在亮/暗 .page 块都有定义', unreachable.length === 0, unreachable.join('、'));
}

console.log(`\n玻璃拟态 UI 校验：失败 ${failed}`);
process.exit(failed ? 1 : 0);