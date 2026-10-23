/**
 * 静态检查：WXSS 里引用的 CSS 变量必须在 app.wxss（或组件内）有定义。
 *
 * 真实事故（2026-10-22）：批量操作栏用了 `var(--tt-bg-card)`，
 * 而项目里的令牌叫 `--tt-card` —— 变量不存在 → 背景透明 → 批量栏看起来"没有背景"，
 * 文字直接叠在列表上。`--tt-radius-lg` 同样不存在，圆角也失效了。
 *
 * 这类错误不会报语法错、不影响编译，只是**样式静默失效**，
 * 只有肉眼在真机上看才能发现（而且很容易被当成"设计就是这样"）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const APP_WXSS = path.join(ROOT, 'app.wxss');

// 1) 收集全局定义（app.wxss 里 `--x: value`）
const appSrc = fs.readFileSync(APP_WXSS, 'utf8');
const defined = new Set();
for (const m of appSrc.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
// TDesign 也提供了一批 --td-*，从它的 style 入口收集
const tdStyle = path.join(ROOT, 'miniprogram_npm', 'tdesign-miniprogram', 'common', 'style', 'index.wxss');
if (fs.existsSync(tdStyle)) {
  const td = fs.readFileSync(tdStyle, 'utf8');
  for (const m of td.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
  // 主题文件里还有更多（theme 目录）
  const themeDir = path.join(ROOT, 'miniprogram_npm', 'tdesign-miniprogram', 'common', 'style');
  if (fs.existsSync(themeDir)) {
    for (const f of fs.readdirSync(themeDir)) {
      if (!f.endsWith('.wxss')) continue;
      const s = fs.readFileSync(path.join(themeDir, f), 'utf8');
      for (const m of s.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
    }
  }
}

const bad = [];
let scanned = 0;
let refs = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'miniprogram_npm') continue;
      walk(p);
      continue;
    }
    if (!entry.name.endsWith('.wxss')) continue;
    scanned += 1;

    // 本文件自己定义的变量也算（组件可在自己 wxss 里定义）
    const src = fs.readFileSync(p, 'utf8');
    const local = new Set();
    for (const m of src.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) local.add(m[1]);

    // 已定义值的变量引用（排除 var(--x, fallback) 里有兜底值的那些 —— 它们安全）
    for (const m of src.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*,/g)) refs += 1; // 带兜底值，跳过不判

    for (const m of src.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)) {
      refs += 1;
      const name = m[1];
      if (defined.has(name) || local.has(name)) continue;
      // TDesign 组件内部变量以 --td- 开头且数量极多，它自己的文件里定义；
      // 我们只关心本项目自己写的 wxss 引用不存在的 --tt-* / 明显拼错的
      bad.push({ file: path.relative(ROOT, p).replace(/\\/g, '/'), name });
    }
  }
}

walk(ROOT);

if (bad.length) {
  const uniq = [];
  const seen = new Set();
  for (const b of bad) {
    const k = b.file + '|' + b.name;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(b);
  }
  console.log(`❌ ${uniq.length} 处 var() 引用了未定义的变量（样式会静默失效）：`);
  for (const b of uniq) console.log(`   ${b.file}  →  ${b.name}`);
  console.log('\n修法：改用已定义的令牌（见 app.wxss 的 --tt-*），或在文件内补上该变量定义。');
  process.exit(1);
}

console.log(`检查 ${scanned} 个 wxss / ${refs} 处 var() 引用`);
console.log('所有 CSS 变量引用都有定义（无静默失效的样式）');
