// 扫描：所有用 .tt-sheet 的页面，是否都有「页面私有 sheet 类 + 滚动区确定高度」
// 依据 docs/ui-design.md:79-87「抽屉滚动区必须给确定高度」（本仓库踩过多次）
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'miniprogram_npm') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const wxmls = files.filter((f) => f.endsWith('.wxml'));

const rows = [];
for (const w of wxmls) {
  const src = fs.readFileSync(w, 'utf8');
  if (!/class="[^"]*\btt-sheet\b/.test(src)) continue;
  const wxss = w.replace(/\.wxml$/, '.wxss');
  const wxssSrc = fs.existsSync(wxss) ? fs.readFileSync(wxss, 'utf8') : '';
  const scrollCount = (src.match(/<scroll-view[^>]*class="[^"]*tt-sheet-body/g) || []).length;

  // 判定「滚动区有确定高度」：取该 scroll-view 自己的 class 列表，
  // 只要 wxss 里**任意一个** class（含 tt-sheet-body 或它的后代类）带 height / max-height 即算修好。
  // 不写死 .tt-sheet-body 选择器 —— 有的页面用后代类（如 .hub-sheet .hub-class-scroll），同样有效。
  const scrollEls = [...src.matchAll(/<scroll-view[^>]*class="([^"]*)"/g)].map((m) => m[1]);
  const tokens = new Set();
  for (const c of scrollEls) {
    for (const t of c.split(/\s+/)) {
      const clean = t.replace(/\{\{[\s\S]*?\}\}/g, '').trim();
      if (clean) tokens.add(clean);
    }
  }
  let hasHeightRule = false;
  let ruleText = '';
  for (const m of wxssSrc.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const body = m[2];
    if (!/(^|[;\s])(max-height|height)\s*:/.test(body)) continue;
    // 选择器里出现的类名必须命中该滚动区自身的 class（或其组合，如 .hub-sheet .hub-class-scroll）
    const hit = [...tokens].some((t) => new RegExp(`\\.${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(sel));
    if (hit) {
      hasHeightRule = true;
      ruleText = `${sel} { ${body.trim().replace(/\s+/g, ' ')} }`;
      break;
    }
  }
  // app.wxss 里若给 .tt-sheet-body 本身定了高度，则全局通用（当前没有，故只作说明）
  rows.push({
    page: path.relative(ROOT, w),
    scrollViews: scrollCount,
    ok: scrollCount === 0 ? true : hasHeightRule,
    ruleText,
  });
}

console.log(`用到 .tt-sheet 的页面共 ${rows.length} 个：\n`);
let bad = 0;
for (const r of rows) {
  if (!r.ok) bad += 1;
  console.log(`${r.ok ? 'ok  ' : 'FIX '} ${r.page}  (滚动区 ${r.scrollViews} 个)`);
  if (r.ruleText) console.log(`      ${r.ruleText}`);
}
console.log(`\n需要修的页面：${bad} 个`);
process.exit(bad ? 1 : 0);
