/**
 * 静态检查：小程序页面/组件的**引用完整性**。
 *
 * 真实事故（2026-10-21）：新建「楼名管理」页时把 require 写成
 * `../../../utils/request`（该文件在 packageAdmin/config/，正确应是 `../../utils/request`），
 * 于是 require 失败 → 页面 JS 直接抛错 → **整页点击全部失效，只剩滑动**。
 * 这类错误 node --check 不报（语法是对的）、契约自检看不到、导航检查也看不到。
 *
 * 检查三件事：
 *   ① JSON 里 usingComponents 的组件路径存在（裸包名走 miniprogram_npm 解析）
 *   ② JS 里 require('./...') 的相对路径存在
 *   ③ WXML 用到的 t-xxx 组件在该页 json 或 app.json 里注册过
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const NPM = path.join(ROOT, 'miniprogram_npm');
const bad = [];
let jsonCount = 0;
let jsCount = 0;
let wxmlCount = 0;

const exists = (base) =>
  fs.existsSync(base) || fs.existsSync(base + '.js') || fs.existsSync(base + '.json') || fs.existsSync(path.join(base, 'index.js'));

function resolveComponent(fromFile, spec) {
  if (/^plugin:/.test(spec)) return true;
  // 裸包名（tdesign-miniprogram/button/button）从 miniprogram_npm 解析
  if (!spec.startsWith('.') && !spec.startsWith('/')) return exists(path.join(NPM, spec));
  const base = spec.startsWith('/') ? path.join(ROOT, spec.slice(1)) : path.resolve(path.dirname(fromFile), spec);
  return exists(base);
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'miniprogram_npm') continue;
      walk(p);
      continue;
    }
    const rel = path.relative(ROOT, p).replace(/\\/g, '/');

    if (entry.name.endsWith('.json')) {
      jsonCount += 1;
      let j;
      try {
        j = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (err) {
        bad.push(`JSON 解析失败: ${rel}（${err.message}）`);
        continue;
      }
      for (const [name, spec] of Object.entries(j.usingComponents || {})) {
        if (!resolveComponent(p, spec)) bad.push(`组件缺失: ${rel} -> ${name} = ${spec}`);
      }
      continue;
    }

    if (entry.name.endsWith('.js')) {
      jsCount += 1;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
        const target = path.resolve(path.dirname(p), m[1]);
        if (!exists(target)) bad.push(`require 悬空: ${rel} -> ${m[1]}`);
      }
      continue;
    }

    if (entry.name.endsWith('.wxml')) {
      wxmlCount += 1;
      const jsonPath = p.replace(/\.wxml$/, '.json');
      let localUC = {};
      if (fs.existsSync(jsonPath)) {
        try {
          localUC = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).usingComponents || {};
        } catch (e) {
          /* 上面的 JSON 分支会报 */
        }
      }
      const src = fs.readFileSync(p, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      const used = new Set();
      for (const m of src.matchAll(/<(t-[a-z0-9-]+)/g)) used.add(m[1]);
      for (const comp of used) {
        if (!(comp in localUC) && !(comp in GLOBAL_UC)) {
          bad.push(`组件未注册: ${rel} 用到 <${comp}>（该页 json 与 app.json 都没注册）`);
        }
      }
    }
  }
}

let GLOBAL_UC = {};
try {
  GLOBAL_UC = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')).usingComponents || {};
} catch (e) {
  bad.push(`app.json 读取失败: ${e.message}`);
}

walk(ROOT);

if (bad.length) {
  console.log(`❌ 发现 ${bad.length} 个引用问题（这些会让页面 JS 抛错、点击全部失效）:`);
  for (const b of bad) console.log(`   ${b}`);
  process.exit(1);
}

console.log(`检查 ${jsonCount} 个 json / ${jsCount} 个 js / ${wxmlCount} 个 wxml`);
console.log('组件注册、usingComponents、require 相对路径全部可解析');
