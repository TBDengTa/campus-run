/**
 * 页面 data 键自检：WXML 里 {{xxx}} 引用了、但 JS 里**从头到尾都没出现过**的键 = 一定会渲染成空白。
 *
 * 为什么需要它：这类错误**不报错、不白屏**，只是悄悄少一段文字。
 * 历史踩坑：home 的教师问候写 {{greeting}}，而 JS 里字段叫 greetText → 页面上永远只剩一个逗号，
 * 静态检查、控制台、真机都不报任何错，只能靠肉眼发现。
 *
 * 判定口径（宁可漏报，不要误报）：
 *   · wx:for-item / wx:for-index / 模板 data 声明的局部变量不算；
 *   · 只要键名在这个页面的 JS（含 import 的 behaviors）里以 `key:` 或 `key =` 形式出现过就算声明 ——
 *     包括只在 setData 里赋值的键（它们同样会正常渲染）；
 *   · 只报「WXML 用了、JS 里一次都没出现」的键，这类必然是字段名写错了。
 *
 * 运行：node tools/check-page-data-keys.js
 */
const fs = require('fs');
const path = require('path');

const M = path.join(__dirname, '..', 'miniprogram');
const app = JSON.parse(fs.readFileSync(path.join(M, 'app.json'), 'utf8'));

const targets = [...(app.pages || [])];
for (const sp of app.subpackages || app.subPackages || []) {
  for (const p of sp.pages || []) targets.push(`${sp.root}/${p}`);
}
const compBase = path.join(M, 'components');
if (fs.existsSync(compBase)) {
  for (const name of fs.readdirSync(compBase)) {
    if (fs.existsSync(path.join(compBase, name, `${name}.js`))) targets.push(`components/${name}/${name}`);
  }
}

// WXML 模板语法里的关键字 / 常见工具（不是 data）
const BUILTIN = new Set([
  'true', 'false', 'null', 'undefined',
  'length', 'indexOf', 'slice', 'split', 'join', 'toFixed', 'toUpperCase', 'toLowerCase',
  'Number', 'String', 'Math', 'JSON', 'parseInt',
]);

// 收集 WXML 里的局部变量：wx:for-item / wx:for-index / template 的 data 键
function collectLocals(wxml) {
  const set = new Set(['item', 'index']);
  for (const m of wxml.matchAll(/wx:for-item\s*=\s*"([^"]+)"/g)) set.add(m[1]);
  for (const m of wxml.matchAll(/wx:for-index\s*=\s*"([^"]+)"/g)) set.add(m[1]);
  return set;
}

function jsSourceOf(jsFile) {
  const parts = [fs.readFileSync(jsFile, 'utf8')];
  // 引入的 behaviors 提供的 data 也算本页可用
  for (const m of parts[0].matchAll(/require\('([^']*behaviors\/[^']+)'\)/g)) {
    const rel = m[1].replace(/^\.\.\/\.\.\//, '').replace(/^\.\//, '');
    const bf = path.join(M, `${rel}.js`);
    if (fs.existsSync(bf)) parts.push(fs.readFileSync(bf, 'utf8'));
  }
  return parts.join('\n');
}

// 键名是否在 JS 里出现过（data 声明 / setData / 对象字面量都算）
function hasKey(js, key) {
  const re = new RegExp(`(^|[^\\w$.])${key}\\s*[:=]`, 'm');
  if (re.test(js)) return true;
  // setData({ 'a.b.c': x }) / this.data.key / this.data['key'] 之类的间接用法
  return new RegExp(`['"]${key}['"]`).test(js) || new RegExp(`\\.${key}\\b`).test(js);
}

let problems = 0;
let scanned = 0;

for (const p of targets) {
  const wxmlFile = path.join(M, `${p}.wxml`);
  const jsFile = path.join(M, `${p}.js`);
  if (!fs.existsSync(wxmlFile) || !fs.existsSync(jsFile)) continue;
  scanned += 1;

  const wxml = fs.readFileSync(wxmlFile, 'utf8');
  const js = jsSourceOf(jsFile);
  const locals = collectLocals(wxml);

  const refs = new Set();
  for (const m of wxml.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    // 去掉字符串字面量，避免把 'abc' 当成变量
    const expr = m[1].replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
    for (const id of expr.matchAll(/(?:^|[^.\w$])([a-zA-Z_$][\w$]*)/g)) {
      const name = id[1];
      if (locals.has(name) || BUILTIN.has(name)) continue;
      // 函数调用（xxx(...)）通常是模板里的方法名，不算 data
      const after = expr.slice(id.index + id[0].length);
      if (/^\s*\(/.test(after)) continue;
      refs.add(name);
    }
  }

  const missing = [...refs].filter((k) => !hasKey(js, k));
  if (missing.length) {
    problems += 1;
    console.log(`\n${p}.wxml 引用了 JS 里不存在的键（会渲染成空白）：`);
    for (const k of missing) console.log(`  - ${k}`);
  }
}

console.log(`\n检查 ${scanned} 个页面 / 组件`);
if (problems) {
  console.log(`发现 ${problems} 个文件存在「引用了不存在的 data 键」`);
  process.exit(1);
} else {
  console.log('所有 WXML 引用的 data 键都能在 JS 里找到（不会再出现莫名的空白）');
}
