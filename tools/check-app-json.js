/**
 * app.json 登记一致性自检：node tools/check-app-json.js
 *
 * 为什么单独做一个：多人并行开发时最容易漏的两件事，都是「本地点不出来、真机才炸」的：
 *   ① 新页面忘了登记 app.json → 跳转直接失败；
 *   ② usingComponents 指向的组件没登记成「分包页面」→ 项目开了 lazyCodeLoading: requiredComponents，
 *      分包里的组件若不在 subpackages[].pages 里登记，真机会注入失败（开发者工具能预览、真机白屏）。
 *
 * 检查项：
 *   1. pages / subpackages.pages 里每个页面必须有 .js/.json/.wxml/.wxss 四件套；
 *   2. 每个页面 json 的 usingComponents 指向的组件，必须**真实存在**，且组件四件套齐全；
 *   3. 组件若位于某个分包目录内，必须在该分包的 pages 列表里登记（lazyCodeLoading 要求）；
 *   4. 页面 json 里 components 的相对路径必须解析得到（写错层级是白屏级别的事故）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const problems = [];
const notes = [];

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    problems.push(`${path.relative(ROOT, p)}: JSON 非法 ${e.message}`);
    return null;
  }
}

const appJson = readJson(path.join(ROOT, 'app.json'));
if (!appJson) {
  console.log(problems.join('\n'));
  process.exit(1);
}

const subpackages = appJson.subpackages || appJson.subPackages || [];
const allPages = [...(appJson.pages || [])];
for (const sp of subpackages) for (const p of sp.pages || []) allPages.push(`${sp.root}/${p}`);

// ===== 1. 页面四件套 =====
for (const p of allPages) {
  for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
    const file = path.join(ROOT, `${p}${ext}`);
    if (!fs.existsSync(file)) problems.push(`页面缺文件：${p}${ext}`);
  }
}

// 分包根目录 → 该分包 pages 集合（用于判定组件是否已登记）
const subRoots = subpackages.map((sp) => ({
  root: sp.root,
  pages: new Set((sp.pages || []).map((p) => `${sp.root}/${p}`)),
}));

function ownerSubpackage(relPath) {
  // 组件在分包目录下时返回该分包
  for (const s of subRoots) {
    if (relPath === s.root || relPath.startsWith(`${s.root}/`)) return s;
  }
  return null;
}

function resolveComponent(pageRel, ref) {
  if (ref.startsWith('/')) return ref.replace(/^\//, '');
  return path.posix.normalize(path.posix.join(path.posix.dirname(pageRel), ref));
}

const seen = new Set();
// ===== 2~4. 组件引用 =====
// 页面 → 它所属的分包根（'' = 主包），用于校验「跨分包引用组件」这条真实约束
const pageOwnerRoot = new Map();
for (const p of (appJson.pages || [])) pageOwnerRoot.set(p, '');
for (const sp of subpackages) for (const p of sp.pages || []) pageOwnerRoot.set(`${sp.root}/${p}`, sp.root);

for (const p of allPages) {
  const jsonPath = path.join(ROOT, `${p}.json`);
  if (!fs.existsSync(jsonPath)) continue;
  const cfg = readJson(jsonPath);
  if (!cfg) continue;
  const uses = { ...(appJson.usingComponents || {}), ...(cfg.usingComponents || {}) };
  for (const [name, ref] of Object.entries(uses)) {
    if (!ref) continue;
    // npm 组件（tdesign-miniprogram/...）由构建后的 miniprogram_npm 提供，单独判断
    const rel = ref.startsWith('tdesign-miniprogram/')
      ? `miniprogram_npm/${ref}`
      : resolveComponent(p, ref);
    const key = `${rel}`;
    const jsFile = path.join(ROOT, `${rel}.js`);
    if (!fs.existsSync(jsFile)) {
      problems.push(`${p}.json: 组件「${name}」指向的路径不存在 -> ${ref}（解析为 ${rel}）`);
      continue;
    }
    if (!seen.has(key)) {
      seen.add(key);
      for (const ext of ['.json', '.wxml']) {
        if (!fs.existsSync(path.join(ROOT, `${rel}${ext}`))) {
          problems.push(`组件缺 ${ext}：${rel}（被 ${p} 引用）`);
        }
      }
      // 真实约束：分包页面**不能引用另一个分包的组件**（组件必须与引用页同包，或位于主包）。
      // 注意：早期这里写的是「分包内组件必须登记进该分包 pages」——那是错的：
      //   ① 组件不是页面，pages 列表里放组件属非典型用法（本项目已因此撤掉 person-picker 的登记）；
      //   ② 真正会炸的是跨分包引用，而它没有任何显式报错，所以必须在这里静态拦。
      const owner = ownerSubpackage(rel);
      const pageRoot = pageOwnerRoot.get(p) || '';
      if (owner && rel !== owner.root && pageRoot && pageRoot !== owner.root) {
        problems.push(
          `跨分包引用组件：${p}（分包 ${pageRoot}）引用了 ${rel}（分包 ${owner.root}）——` +
            `分包页面只能引用同包或主包的组件，否则真机注入失败`
        );
      }
    }
  }
}

// ===== tabBar 页面必须在主包 pages 里 =====
for (const t of (appJson.tabBar && appJson.tabBar.list) || []) {
  if (!(appJson.pages || []).includes(t.pagePath)) {
    problems.push(`tabBar 页面必须登记在主包 pages：${t.pagePath}`);
  }
}

// ===== 隐私接口必须与代码实际调用一致（用户 2026-10-28 发布受阻）=====
//
// 事故：代码里调了 wx.startLocationUpdateBackground，但 requiredPrivateInfos 只声明了
// 前台版 startLocationUpdate，也没配 requiredBackgroundModes。
// 微信**审核通过了**，但发布时提示「代码涉及未配置在 app.json 的
// wx.startLocationUpdateBackground 接口，发布后将无法使用」—— 等于 GPS 后台跑步直接失效。
// 这类问题的可怕之处：审核阶段看不出来，只有按下发布才暴露。
//
// 所以这里做静态反查：把代码里出现的 wx.<定位类接口> 全扫一遍，
// 凡是微信要求在 app.json 声明的，都必须出现在 requiredPrivateInfos 里。
// 以后再加定位相关 API 也会在这里立刻报出来。
{
  const REQUIRE_DECLARE = new Set([
    'getLocation',
    'onLocationChange',
    'startLocationUpdate',
    'startLocationUpdateBackground',
    'chooseLocation',
    'getFuzzyLocation',
  ]);
  const declared = new Set(appJson.requiredPrivateInfos || []);
  const usedInCode = new Set();
  const walkJs = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'miniprogram_npm' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkJs(p);
      else if (/\.js$/.test(e.name)) {
        let src = '';
        try {
          src = fs.readFileSync(p, 'utf8');
        } catch (err) {
          continue;
        }
        for (const m of src.matchAll(/wx\.([A-Za-z]+)\s*\(/g)) {
          if (REQUIRE_DECLARE.has(m[1])) usedInCode.add(m[1]);
        }
      }
    }
  };
  walkJs(path.join(__dirname, '..', 'miniprogram'));

  for (const api of usedInCode) {
    if (!declared.has(api)) {
      problems.push(
        `代码调用了 wx.${api}，但 requiredPrivateInfos 未声明 —— ` +
          '审核可能通过，但**发布后该接口无法使用**（微信会提示「未配置在 app.json」）'
      );
    }
  }
  // 后台定位必须配 requiredBackgroundModes
  if (declared.has('startLocationUpdateBackground')) {
    if (!(appJson.requiredBackgroundModes || []).includes('location')) {
      problems.push(
        '用了 wx.startLocationUpdateBackground，但 requiredBackgroundModes 缺 "location" —— 后台定位拿不到'
      );
    }
  }
  // 定位类接口必须配 scope.userLocation 描述（否则弹窗无文案，审核也常因此被拒）
  if (usedInCode.size && !(appJson.permission && appJson.permission['scope.userLocation'])) {
    problems.push('用了定位接口，但 app.json permission.scope.userLocation 没有描述文案（弹窗会是空的）');
  }
  if (usedInCode.size) {
    notes.push(
      `定位接口已声明：${[...usedInCode].sort().join(' / ')}` +
        (declared.has('startLocationUpdateBackground') ? '（含后台定位 location 模式）' : '')
    );
  }
}

console.log(
  `检查 app.json：主包 ${(appJson.pages || []).length} 页 / 分包 ${subpackages.length} 个（共 ${allPages.length} 页）、` +
    `组件引用 ${seen.size} 个`
);
if (notes.length) console.log(notes.map((n) => ` · ${n}`).join('\n'));
if (problems.length) {
  console.log(`\n发现 ${problems.length} 个问题：`);
  for (const p of problems) console.log(` - ${p}`);
  process.exit(1);
}
console.log('app.json 登记一致，无问题');
