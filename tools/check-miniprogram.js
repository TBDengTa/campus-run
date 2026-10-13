/**
 * 小程序静态自检：node tools/check-miniprogram.js
 *
 * 覆盖：
 *  1. WXML 损坏检测（整份没有 '<'、或出现「< 被写成 v」这类替换事故）
 *  2. 事件绑定绑到的处理函数在页面 JS 里存在
 *  3. t-icon 名称在 TDesign 图标字体里存在
 *  4. <image src> 本地图片存在
 *  5. class 名在任一 WXSS 里有定义（防止写了类但没样式）
 *  6. WXML 标签配平 / JSON 合法 / WXSS 花括号配平
 *  7. 页面四件套齐全、tabBar 页面与跳转目标已在 app.json 登记
 *  8. 业务页登录闸门：if (!getApp().requireLogin()) return;
 *  9. 主包体积（含 npm 上限 2MB）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const NPM_DIR = 'miniprogram_npm';
const MAX_MAIN_PACKAGE_MB = 2;

// 业务页需要登录闸门（公开页见 AGENTS.md）
const GUARD_PAGES = [
  'pages/home/home',
  'pages/records/records',
  'pages/records/day',
  'pages/records/week',
  'pages/ranking/ranking',
  'pages/profile/profile',
  'pages/run/index',
  'pages/run/detail',
  'pages/water/water',
  'pages/badges/badges',
  'pages/reward/reward',
  'pages/body-data/body-data',
  'pages/appeal/list',
  'pages/appeal/submit',
  'pages/org/bind',
  'pages/password/change',
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === NPM_DIR) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const problems = [];
const hooks = [];
const rel = (p) => path.relative(ROOT, p);
const files = walk(ROOT);
const wxmls = files.filter((f) => f.endsWith('.wxml'));
const wxsss = files.filter((f) => f.endsWith('.wxss'));
const jss = files.filter((f) => f.endsWith('.js'));

// 图标名（TDesign icon font）
const iconCss = path.join(ROOT, NPM_DIR, 'tdesign-miniprogram/icon/icon.wxss');
const iconNames = new Set(
  fs.existsSync(iconCss)
    ? [...fs.readFileSync(iconCss, 'utf8').matchAll(/\.t-icon-([a-z0-9-]+):before/g)].map((m) => m[1])
    : []
);

// 全部 class 定义
const definedClasses = new Set();
for (const f of wxsss) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/\.([a-zA-Z][\w-]*)/g)) definedClasses.add(m[1]);
}

let handlerCount = 0;
let iconUse = 0;
let classUse = 0;

for (const wxml of wxmls) {
  const r = rel(wxml);
  const raw = fs.readFileSync(wxml, 'utf8');

  if (!raw.includes('<')) problems.push(`${r}: 整份文件没有 '<'，疑似损坏`);
  const corrupt = raw.match(/(^|[\s>])v(?:\/?(?:view|text|block|picker|input|button|image|scroll-view|swiper)\b|!--)/g);
  if (corrupt) problems.push(`${r}: 出现「< 被写成 v」${corrupt.length} 处`);

  const src = raw.replace(/<!--[\s\S]*?-->/g, '');
  const jsPath = wxml.replace(/\.wxml$/, '.js');
  const jsSrc = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : '';

  for (const m of src.matchAll(/\b(?:bind|catch|capture-bind|capture-catch)[:]?([a-zA-Z]+)\s*=\s*"([^"]*)"/g)) {
    const fn = m[2].trim();
    if (!fn || fn.includes('{{')) continue;
    handlerCount++;
    if (!new RegExp(`(^|[^\\w.])${fn}\\s*[(:=]`, 'm').test(jsSrc)) problems.push(`${r}: 事件绑定的处理函数未定义 -> ${fn}`);
  }

  for (const m of src.matchAll(/<t-icon[^>]*\bname\s*=\s*"([^"]*)"/g)) {
    const v = m[1];
    const names = v.includes('{{') ? [...v.matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]) : [v];
    for (const n of names) {
      if (!n || n.includes('{{')) continue;
      iconUse++;
      if (!iconNames.has(n)) problems.push(`${r}: t-icon 图标不存在 -> ${n}`);
    }
  }

  for (const m of src.matchAll(/<image[^>]*\bsrc\s*=\s*"([^"]*)"/g)) {
    const v = m[1];
    const list = v.includes('{{') ? [...v.matchAll(/'(\/[^']+)'/g)].map((x) => x[1]) : [v];
    for (const s of list) {
      if (!s || s.includes('{{') || /^https?:/.test(s)) continue;
      if (!fs.existsSync(path.join(ROOT, s.replace(/^\//, '')))) problems.push(`${r}: 图片不存在 -> ${s}`);
    }
  }

  for (const m of src.matchAll(/class="([^"]*)"/g)) {
    const cleaned = m[1].replace(/\{\{[^}]*\}\}/g, ' ');
    const tokens = cleaned
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((c) => c && !/[{}]/.test(c));
    classUse += tokens.length;
    const unknown = tokens.filter((c) => !definedClasses.has(c) && !/^rank-$/.test(c));
    if (!unknown.length) continue;
    // 同一个 class 属性里只要有一个类有样式，其余未定义的就是「修饰钩子」（无害）；
    // 全部未定义说明这个节点完全没有样式，是真问题。
    if (unknown.length === tokens.length) {
      problems.push(`${r}: 节点完全没有样式（class 均未定义）-> .${unknown.join(' .')}`);
    } else {
      hooks.push(`${r}: 未定义的修饰类（同节点其它类已有样式）-> .${unknown.join(' .')}`);
    }
  }

  // 标签配平：**所有**标签都查（含 t-icon / t-switch 等组件标签 —— 少一个 /> 就是白屏）
  const tagNames = new Set([...src.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  for (const tag of tagNames) {
    const open = (src.match(new RegExp(`<${tag}(?=[\\s>/])`, 'g')) || []).length;
    const close = (src.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    const self = (src.match(new RegExp(`<${tag}\\b[^>]*?/>`, 'g')) || []).length;
    if (open - self !== close) {
      problems.push(`${r}: <${tag}> 不配平（会导致该页白屏）open=${open} 自闭合=${self} close=${close}`);
    }
  }

  // wx:else 必须紧跟 wx:if / wx:elif
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/wx:else/.test(lines[i])) continue;
    const indent = lines[i].match(/^\s*/)[0].length;
    let j = i - 1;
    while (j >= 0) {
      const l = lines[j];
      if (l.trim() !== '') {
        if (l.match(/^\s*/)[0].length === indent && /^<[a-zA-Z]/.test(l.trim())) break;
      }
      j--;
    }
    if (j < 0) continue;
    let chunk = '';
    for (let k = j; k <= i; k++) {
      chunk += lines[k] + '\n';
      if (/\/?>\s*$/.test(lines[k])) break;
    }
    if (!/wx:(if|elif)=/.test(chunk)) problems.push(`${r}:${i + 1}: wx:else 前一项缺少 wx:if/wx:elif`);
  }
}

// tabBar 图标名（只查 custom-tab-bar，页面里的 icon: 'none'/'success' 是 showToast 参数，不是图标名）
const tabBarJs = path.join(ROOT, 'custom-tab-bar/index.js');
if (fs.existsSync(tabBarJs)) {
  for (const m of fs.readFileSync(tabBarJs, 'utf8').matchAll(/\b(?:icon|activeIcon):\s*'([a-z0-9-]+)'/g)) {
    iconUse++;
    if (!iconNames.has(m[1])) problems.push(`custom-tab-bar/index.js: 图标不存在 -> ${m[1]}`);
  }
}

// JS 里写死的图标名（t-icon 用 {{item.icon}} 动态绑定时 WXML 查不到，必须在这里兜底）
// 排除 showToast / showModal 的 icon 参数：none / success / error / loading / warn / info
const TOAST_ICONS = new Set(['none', 'success', 'error', 'loading', 'warn', 'info', 'failed', 'exception']);
for (const f of jss) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bicon(?:Name|Active)?:\s*'([a-z0-9-]+)'/g)) {
    const name = m[1];
    if (TOAST_ICONS.has(name)) continue;
    iconUse++;
    if (!iconNames.has(name)) problems.push(`${rel(f)}: JS 里的图标不存在（会渲染空白）-> ${name}`);
  }
}

for (const f of files.filter((x) => x.endsWith('.json'))) {
  try {
    JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    problems.push(`${rel(f)}: JSON 非法 ${e.message}`);
  }
}
for (const f of wxsss) {
  const s = fs.readFileSync(f, 'utf8');
  const o = (s.match(/\{/g) || []).length;
  const c = (s.match(/\}/g) || []).length;
  if (o !== c) problems.push(`${rel(f)}: WXSS 花括号不配平 ${o}/${c}`);
}

const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const pages = [...(appJson.pages || [])];
for (const sp of appJson.subpackages || []) for (const p of sp.pages || []) pages.push(`${sp.root}/${p}`);
for (const p of pages) {
  for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
    if (!fs.existsSync(path.join(ROOT, p + ext))) problems.push(`页面缺文件：${p}${ext}`);
  }
}
for (const t of appJson.tabBar?.list || []) {
  if (!pages.includes(t.pagePath)) problems.push(`tabBar 页面未登记：${t.pagePath}`);
}
for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
  if (!fs.existsSync(path.join(ROOT, `custom-tab-bar/index${ext}`))) problems.push(`缺少 custom-tab-bar/index${ext}`);
}
for (const f of jss) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/wx\.(?:navigateTo|redirectTo|switchTab|reLaunch)\(\{\s*url:\s*[`'"]([^`'"?]+)/g)) {
    const target = m[1].replace(/^\//, '');
    if (!pages.includes(target)) problems.push(`${rel(f)}: 跳转目标未登记 -> ${target}`);
  }
}
for (const p of GUARD_PAGES) {
  const f = path.join(ROOT, p + '.js');
  if (!fs.existsSync(f)) continue;
  if (!fs.readFileSync(f, 'utf8').includes('requireLogin()')) problems.push(`${p}: 缺少登录闸门（getApp().requireLogin()）`);
}

const totalBytes = files.reduce((s, f) => s + fs.statSync(f).size, 0);
const npmBytes = (() => {
  const dir = path.join(ROOT, NPM_DIR);
  if (!fs.existsSync(dir)) return 0;
  const stack = [dir];
  let sum = 0;
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else sum += fs.statSync(p).size;
    }
  }
  return sum;
})();

console.log(
  `检查：WXML ${wxmls.length} / WXSS ${wxsss.length} / JS ${jss.length} / 页面 ${pages.length}\n` +
    `      事件绑定 ${handlerCount} 处、图标 ${iconUse} 处、class ${classUse} 处\n` +
    `      主包 ≈ ${((totalBytes + npmBytes) / 1024 / 1024).toFixed(2)} MB（不含 npm ${(totalBytes / 1024 / 1024).toFixed(2)} MB，上限 ${MAX_MAIN_PACKAGE_MB} MB）`
);
if ((totalBytes + npmBytes) / 1024 / 1024 > MAX_MAIN_PACKAGE_MB) {
  problems.push(`主包体积超出 ${MAX_MAIN_PACKAGE_MB}MB 上限`);
}
if (hooks.length) {
  console.log(`\n提示：${hooks.length} 处未定义的修饰类（不影响显示，仅作样式钩子）：`);
  for (const h of hooks) console.log(' · ' + h);
}
if (problems.length) {
  console.log(`\n发现 ${problems.length} 个问题：`);
  for (const p of problems) console.log(' - ' + p);
  process.exitCode = 1;
} else {
  console.log('\n✅ 全部检查通过');
}
