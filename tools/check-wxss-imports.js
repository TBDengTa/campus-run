/**
 * 静态检查：WXSS 的 @import 必须指向真实存在的文件。
 *
 * 为什么必须有这个检查器（真实事故）：
 *   「系统设置里的中转页 packageAdmin/config/config」被删时，只确认了「没有 JS/页面引用」，
 *   **漏了 WXSS 的 @import** —— 而 anticheat / points / reward-video / assessment-goals
 *   四个页面的 wxss 都 @import 了它（其中两个整个文件只有这一行）。
 *   结果：WXSS 引用不存在的文件 → 小程序**编译失败** → 用户点任何入口都跳不动。
 *
 * 这类错误在 JS 语法检查、契约自检、页面注册检查里都看不出来，
 * 只有开发者工具编译时才报，反馈链路太长。所以单独立一个检查。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const SKIP_DIRS = new Set(['miniprogram_npm', 'node_modules']);

const bad = [];
let scanned = 0;
let imports = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(p);
      continue;
    }
    if (!entry.name.endsWith('.wxss')) continue;
    scanned += 1;
    const src = fs.readFileSync(p, 'utf8');
    for (const m of src.matchAll(/@import\s+["']([^"']+)["']/g)) {
      imports += 1;
      const spec = m[1];
      // 小程序里以 / 开头的是「项目根目录」绝对路径（相对 miniprogram/）
      const target = spec.startsWith('/')
        ? path.join(ROOT, spec.slice(1))
        : path.resolve(path.dirname(p), spec);
      if (!fs.existsSync(target)) {
        bad.push({ from: path.relative(ROOT, p).replace(/\\/g, '/'), spec });
      }
    }
  }
}

walk(ROOT);

if (bad.length) {
  console.log(`❌ 有 ${bad.length} 处 @import 指向不存在的文件（会导致小程序编译失败）:`);
  for (const b of bad) console.log(`   ${b.from}  ->  ${b.spec}`);
  console.log('\n修法：恢复被引用的 wxss，或把这几个页面的 @import 改到现存文件。');
  process.exit(1);
}

console.log(`检查 ${scanned} 个 wxss / ${imports} 处 @import`);
console.log('所有 WXSS @import 都能解析到真实文件（不会因样式引用缺失导致编译失败）');
