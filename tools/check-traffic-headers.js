/**
 * 静态检查：EO 链路流量防护（用户 2026-11-09「我严重怀疑会时不时上传数据，因为有腾讯云的EO」）
 *
 * 排查结论（详见 docs/edgeone-traffic.md）：代码里没有任何隐匿/定时上传，
 * EO 流量全部对应正常业务请求；但链路上有 4 个放大因素，本次防护的失败模式全是静默的：
 *   ① /api/* 没有缓存头 → EO 按默认规则缓存 GET 响应 → 学生看到旧榜单/旧公告（脏数据），源站白扣回源流量；
 *   ② /health 没有缓存头 → 探活被边缘缓存 200 → 源站挂了还在「报活」；
 *   ③ nginx 无 gzip → JSON 裸传，流量绝对值虚高；
 *   ④ /uploads 没有 immutable → 边缘缓存期内反复回源校验（SHA 文件名明明可以放心不校验）；
 *   ⑤ 首页 onShow 节流被删 → 切 tab 每次打 7 个请求，EO 请求数回落。
 * 这五条任何一条回退，页面/接口都照常工作 —— 只能靠本检查器盯。
 *
 * 运行：node tools/check-traffic-headers.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let failed = 0;
function ok(name, cond, detail) {
  console.log(`${cond ? '  ok   ' : '  FAIL '}${name}${cond ? '' : '  -> ' + JSON.stringify(detail)}`);
  if (!cond) failed += 1;
}

const APP_JS = read('server', 'src', 'app.js');
// deploy/ 整个目录被 .gitignore 忽略（含真实域名，安全红线）——别的机器克隆下来没有这文件。
// 缺失时跳过 nginx 段（那些断言只能在本机跑），不能让整个检查器崩溃。
const NGINX_CONF = (() => {
  try {
    return read('deploy', 'nginx', 'ttr.tangbo.tech.conf');
  } catch (e) {
    return '';
  }
})();
const NGINX_AVAILABLE = NGINX_CONF.length > 0;
const HOME_JS = read('miniprogram', 'pages', 'home', 'home.js');
const DOC = (() => {
  try {
    return read('docs', 'edgeone-traffic.md');
  } catch (e) {
    return '';
  }
})();

// ===== 1) /api/* 全局 no-store，且必须挂在 API 路由挂载之前 =====
console.log('[1] /api 缓存防护头');
ok('app.js 有 /api no-store 中间件', /app\.use\('\/api',\s*\(req, res, next\) =>\s*\{[\s\S]{0,200}no-store/.test(APP_JS));
const mwIdx = APP_JS.indexOf("app.use('/api', (req, res, next)");
const firstApiRouteIdx = APP_JS.indexOf("app.use('/api/auth'");
ok('中间件挂在 API 路由挂载之前（Express 按注册顺序执行）', mwIdx >= 0 && firstApiRouteIdx > mwIdx, { mwIdx, firstApiRouteIdx });
// console 域自己的 no-store 不能被顺手删掉（两处同值，互不替代：console 走 /console/api 前缀）
ok('console 域 no-store 仍在（不回归）', /no-store/.test(read('server', 'src', 'routes', 'console.js')));

// ===== 2) /health 与 /p/:slug 的缓存头 =====
console.log('\n[2] /health 与 /p/:slug 缓存头');
const healthSeg = (APP_JS.match(/app\.get\('\/health'[\s\S]{0,400}/) || [''])[0];
ok('/health 设 no-store（探活必须打源站）', /no-store/.test(healthSeg));
const pSeg = (APP_JS.match(/app\.get\('\/p\/:slug'[\s\S]{0,700}/) || [''])[0];
ok('/p/:slug 设 public, max-age=60（短缓存）', /public,\s*max-age=60/.test(pSeg));
ok('缓存头在 res.send 之前设置（send 后设头无效）', pSeg.indexOf('Cache-Control') < pSeg.indexOf('res.send'));

// ===== 3) nginx gzip + immutable =====
console.log(`\n[3] nginx 压缩与缓存强化${NGINX_AVAILABLE ? '' : '（deploy/ 不在本机，跳过）'}`);
if (NGINX_AVAILABLE) {
  ok('gzip on', /gzip\s+on;/.test(NGINX_CONF));
  ok('gzip_comp_level 存在', /gzip_comp_level\s+\d+;/.test(NGINX_CONF));
  ok('gzip_min_length 存在（小响应不压，省 CPU）', /gzip_min_length\s+\d+;/.test(NGINX_CONF));
  ok('gzip_proxied any（反代到 Node 的 JSON 也压）', /gzip_proxied\s+any;/.test(NGINX_CONF));
  ok('gzip_types 含 application/json（API 是大头）', /gzip_types[^;]*application\/json/.test(NGINX_CONF));
  ok('gzip_vary on（EO/CDN 按编码正确缓存）', /gzip_vary\s+on;/.test(NGINX_CONF));
  // 图片不该进 gzip_types（JPEG/PNG 已压缩，再压白费 CPU）
  const gzipTypes = (NGINX_CONF.match(/gzip_types[^;]*;/) || [''])[0];
  ok('gzip_types 不含图片格式', !/image\//.test(gzipTypes), gzipTypes);
  const uploadsSeg = (NGINX_CONF.match(/location \/uploads\/[\s\S]{0,400}/) || [''])[0];
  ok('/uploads 带 immutable（SHA 文件名内容永不变）', /immutable/.test(uploadsSeg));
  ok('/uploads 仍保留 7 天 max-age（不回归）', /max-age=604800/.test(uploadsSeg));
}

// ===== 4) 首页 onShow 30 秒节流 =====
console.log('\n[4] 首页刷新节流');
ok('HOME_REFRESH_MIN_GAP 有定义', /const HOME_REFRESH_MIN_GAP\s*=\s*30 \* 1000/.test(HOME_JS));
ok('refresh() 成功路径末尾记 _lastFullRefreshAt', /this\._lastFullRefreshAt\s*=\s*Date\.now\(\)/.test(HOME_JS));
const onShowSeg = (HOME_JS.match(/onShow\(\)\s*\{[\s\S]{0,700}?autoSyncWerun\(\);/) || [''])[0];
ok('onShow 里有节流判断', /_lastFullRefreshAt &&/.test(onShowSeg) && /HOME_REFRESH_MIN_GAP/.test(onShowSeg));
ok('节流跳过时仍同步 tabBar 选中态（syncTabBar 在节流判断之前）', onShowSeg.indexOf('syncTabBar()') < onShowSeg.indexOf('_lastFullRefreshAt &&'));
ok('节流只挂在 onShow：下拉刷新 onPullDownRefresh 不受节流', !/HOME_REFRESH_MIN_GAP/.test((HOME_JS.match(/onPullDownRefresh\(\)\s*\{[\s\S]{0,200}/) || [''])[0]));

// ===== 5) 文档存在且不泄露真实域名（红线）=====
console.log('\n[5] 排查文档');
ok('docs/edgeone-traffic.md 存在', DOC.length > 0);
ok('文档不含真实域名（用 <业务域名> 占位）', DOC.length === 0 || !/tangbo\.tech/.test(DOC));

console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 项`}`);
process.exit(failed === 0 ? 0 : 1);
