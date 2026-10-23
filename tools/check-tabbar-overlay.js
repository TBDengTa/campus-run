/**
 * 静态检查：tabBar 页上的自定义弹层必须高于 tabBar，且底部要给它留空间。
 *
 * 真实事故（2026-10-22）：网页「我的」页的二维码弹层用了 z-index: 40，
 * 而自定义 tabBar 是 position:fixed + z-index:999 → tabBar 整个盖在弹层上面，
 * 二维码和底部说明全被挡住（用户截图「这码被挡住了」）。
 *
 * 两条规则：
 *   ① tabBar 页（app.json tabBar.list 里的页面）若用了 position:fixed 的弹层/遮罩，
 *      其 z-index 必须 > 999（本项目 tabBar 的层级）；
 *   ② 这些弹层若贴底（bottom:0），底部 padding 必须 ≥ 120rpx
 *      （tabBar 高 112rpx + 自身 16rpx 偏移），否则内容藏在胶囊后面。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const TABBAR_Z = 999;
const TABBAR_SPACE = 120; // rpx

// 1) 找出 tabBar 页的 wxss 路径
let tabPages = [];
try {
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const list = (app.tabBar && app.tabBar.list) || [];
  tabPages = list.map((t) => String(t.pagePath || '')).filter(Boolean);
} catch (e) {
  console.log('  ⚠️ app.json 读取失败，跳过');
  process.exit(0);
}

if (!tabPages.length) {
  console.log('没有 tabBar 页，跳过');
  process.exit(0);
}

const bad = [];
let checked = 0;

for (const pagePath of tabPages) {
  const wxss = path.join(ROOT, `${pagePath}.wxss`);
  if (!fs.existsSync(wxss)) continue;
  checked += 1;
  const src = fs.readFileSync(wxss, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  // 逐个规则块检查
  for (const m of src.matchAll(/([.#][\w-]+)\s*\{([^}]*)\}/g)) {
    const [, sel, body] = m;
    if (!/position:\s*fixed/.test(body)) continue;
    // 只关心「弹层/遮罩」类：z-index >= 10 且贴底或有 bottom:0
    const zMatch = body.match(/z-index:\s*(\d+)/);
    if (!zMatch) continue;
    const z = Number(zMatch[1]);
    // 顶部导航级别的极小 z-index 不管；这里只判「>=10 但 <=999」的浮层
    if (z > TABBAR_Z || z < 10) continue;
    // 是否是覆盖全屏的遮罩 / 贴底面板（判断依据：有 bottom:0 或 top:0+bottom:0）
    if (!/bottom:\s*0/.test(body) && !/top:\s*0[\s\S]*bottom:\s*0/.test(body)) continue;

    bad.push({
      file: path.relative(ROOT, wxss).replace(/\\/g, '/'),
      sel,
      z,
      reason: `z-index ${z} ≤ tabBar(${TABBAR_Z})，会被底部导航盖住`,
    });
  }

  // ② 贴底面板的底部留白
  for (const m of src.matchAll(/([.#][\w-]+)\s*\{([^}]*)\}/g)) {
    const [, sel, body] = m;
    if (!/position:\s*fixed/.test(body)) continue;
    if (!/bottom:\s*0/.test(body)) continue;
    const pad = body.match(/padding:[^;]*calc\(\s*(\d+)rpx/);
    if (!pad) continue;
    const bottomPad = Number(pad[1]);
    if (bottomPad > 0 && bottomPad < TABBAR_SPACE) {
      bad.push({
        file: path.relative(ROOT, wxss).replace(/\\/g, '/'),
        sel,
        z: '-',
        reason: `底部留白 ${bottomPad}rpx < ${TABBAR_SPACE}rpx，内容会藏在 tabBar 后面`,
      });
    }
  }
}

if (bad.length) {
  console.log(`❌ tabBar 页的浮层有 ${bad.length} 处会被底部导航挡住：`);
  for (const b of bad) console.log(`   ${b.file}  ${b.sel} → ${b.reason}`);
  process.exit(1);
}

console.log(`检查 ${checked} 个 tabBar 页 wxss`);
console.log('tabBar 页的浮层层级与底部留白都正确（不会被底部导航遮挡）');
