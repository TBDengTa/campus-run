/**
 * 静态检查：组件若在自己的 wxss 里使用 app.wxss 的公共类（.tt-*），
 * 必须在 json 里声明 "styleIsolation": "apply-shared"。
 *
 * 真实事故（2026-10-22）：新建 components/room-dialog 时漏了 styleIsolation，
 * 组件内引用的 .tt-sheet* 骨架样式全部不生效 →
 * 内容塌成一列、关闭按钮跑到中间、底部保存按钮拉满整行。
 * 这类问题 node --check、契约自检、组件注册检查全看不见，
 * 只有真机/模拟器打开那个弹层才会发现。
 *
 * 判定规则：组件 wxss（或 wxml 的 class）里出现 .tt- 前缀的类
 *           → json 必须有 styleIsolation: apply-shared（或 shared）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const COMP_DIR = path.join(ROOT, 'components');
const bad = [];
let checked = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p);
      continue;
    }
    if (!entry.name.endsWith('.wxml')) continue;
    checked += 1;

    const base = p.replace(/\.wxml$/, '');
    const jsonPath = `${base}.json`;
    const wxssPath = `${base}.wxss`;

    // 只看组件（json 里 component: true）
    let j = {};
    try {
      j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (e) {
      continue;
    }
    if (j.component !== true) continue;

    const iso = String(j.styleIsolation || 'isolated');
    const sharedOk = iso === 'apply-shared' || iso === 'shared';

    // 组件自己的 wxss / wxml 里是否用了 .tt- 公共类
    let usesShared = false;
    if (fs.existsSync(wxssPath)) {
      const css = fs.readFileSync(wxssPath, 'utf8');
      // 排除「注释里提到 .tt-」的误报
      const noComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
      usesShared = /(^|[\s,{])\.[\w-]*\.?tt-[a-z]/.test(noComment) || /\.[a-z-]+ \.tt-/.test(noComment);
      // 更直接的判据：wxss 里出现 .tt- 选择器（含组合写法）
      if (!usesShared) usesShared = /\.tt-[a-z]/.test(noComment);
    }
    if (!usesShared && fs.existsSync(p)) {
      const wxml = fs.readFileSync(p, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      usesShared = /class="[^"]*\btt-[a-z]/.test(wxml);
    }

    if (usesShared && !sharedOk) {
      bad.push({
        file: path.relative(ROOT, jsonPath).replace(/\\/g, '/'),
        iso,
      });
    }
  }
}

walk(COMP_DIR);

if (bad.length) {
  console.log(`❌ ${bad.length} 个组件用了 .tt-* 公共类但没开 styleIsolation: apply-shared：`);
  for (const b of bad) {
    console.log(`   ${b.file}（当前 styleIsolation: ${b.iso}）→ 公共骨架样式不会生效，布局会塌`);
  }
  process.exit(1);
}

console.log(`检查 ${checked} 个组件 wxml`);
console.log('用到 .tt-* 公共类的组件都已声明 styleIsolation: apply-shared');
