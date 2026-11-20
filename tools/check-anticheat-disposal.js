/**
 * 检查器：自动处置开关必须覆盖**全部**自动封禁路径 + 处置三动作单一实现。
 *
 * 背景（用户 2026-11-03 原话）：「AI 严谨度与自动处置关闭了依旧没有效果，依然会主动封禁」。
 *
 * 根因：goal_config.anticheat.enabled 只在两条规则路径
 * （anticheat.js checkStepJump / checkPace）检查；两条 AI 路径
 * （steps.js syncWerunDay 微信同步、saveGpsRun GPS）不读开关，score 达线照封。
 * 管理员关掉开关后系统仍在封号 —— 开关是假的，比没有开关更糟。
 *
 * 顺带锁死同批引入的契约：
 *   ① 自动封禁必须回写线索（status='banned' + autoBanned=true）——
 *      此前 autoBanned 字段全库无写入点，「已封禁」筛选形同虚设；
 *   ② 处置三动作（封禁 / 排除 / 归档）实现只准存在于 services/anomaly-disposal.js，
 *      Web 控制台与小程序管理端路由只做鉴权与取参；
 *   ③ GPS 线索必须带轨迹快照（route）并在落库后回填 runRecordId，
 *      控制台轨迹详情接口的指标必须走 withGpsMetrics 同一份实现。
 *
 * 运行：node tools/check-anticheat-disposal.js
 */
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server', 'src');
const read = (p) => fs.readFileSync(path.join(SERVER, p), 'utf8');

let failed = 0;
function ok(name, cond, detail) {
  console.log(`${cond ? '  ok   ' : '  FAIL '}${name}${cond ? '' : '  -> ' + JSON.stringify(detail)}`);
  if (!cond) failed += 1;
}

const stepsSrc = read('services/steps.js');
const anticheatSrc = read('services/anticheat.js');
const disposalSrc = read('services/anomaly-disposal.js');
const consoleSrc = read('routes/console.js');
const adminAnomalySrc = read('routes/admin/step-anomalies.js');
const modelSrc = read('models/step-anomaly.js');

// ===== ① 自动处置开关覆盖所有自动封禁路径 =====
console.log('[1] 自动处置开关（anticheat.enabled）覆盖全部自动封禁路径');

ok('steps.js 定义了统一闸门 autoDisposeEnabled()', /async function autoDisposeEnabled\(\)[\s\S]{0,200}anticheat\.enabled\s*===\s*false/.test(stepsSrc));

// ⚠️ 这两条原来写成「匹配一整行 if 条件」的字面量正则：闸门条件一换行、
//   或中间插一行注释，断言就假红（本轮加「已被人工推翻」闸门时真实踩到）。
//   改成**结构化**判定：取那条 autoBan 判断的 if 条件本身，再检查里面同时有
//   自动处置开关与解封闸门 —— 换行/注释/加条件都不影响，但漏掉闸门一定红。
function ifCondOf(src, markerRe) {
  const m = markerRe.exec(src);
  if (!m) return '';
  // ⚠️ 要往**前**找包住这个标记的那个 `if (`，不能往后找第一个左括号：
  //   条件本身是多行且里面还有别的括号时（liftedCoversClueDate(...)），
  //   往后找会取到内层函数的括号，条件文本就截断在错误位置了。
  let open = -1;
  let from = 0;
  for (;;) {
    const i = src.indexOf('(', from);
    if (i < 0 || i > m.index) break;
    // 只认 `if (` / `if(` 后面的那个括号（head 取的是左括号**之前**的 6 个字符）
    const head = src.slice(Math.max(0, i - 6), i);
    if (/\bif\s*$/.test(head)) open = i;
    from = i + 1;
  }
  if (open < 0) return '';
  let depth = 0;
  for (let k = open; k < src.length; k += 1) {
    if (src[k] === '(') depth += 1;
    else if (src[k] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, k);
    }
  }
  return '';
}
// 标记用**正则**而不是字面量：条件被写成多行（本轮加了两个闸门后就是多行）时，
// indexOf 的字符串标记会找不到，于是取到空串 → 断言假红。
const werunBanCond = ifCondOf(stepsSrc, /anomaly\s*&&\s*anomaly\.autoBan/);
const gpsBanCond = ifCondOf(stepsSrc, /anomaly\s*&&\s*anomaly\.level\s*===\s*'autoBan'/);
ok('微信同步 AI 封禁前检查自动处置开关', /autoDisposeEnabled\(\)/.test(werunBanCond), werunBanCond.slice(0, 160));
ok('GPS AI 封禁前检查自动处置开关', /autoDisposeEnabled\(\)/.test(gpsBanCond), gpsBanCond.slice(0, 160));
// ===== 解封闸门覆盖两条 AI 通道（用户 2026-11-19「解封的会被重复封禁」）=====
ok('微信同步 AI 封禁前过「已被人工推翻」闸门', /liftedCoversClueDate\(\s*user,\s*'sync'/.test(werunBanCond), werunBanCond.slice(0, 200));
ok('GPS AI 封禁前过「已被人工推翻」闸门', /liftedCoversClueDate\(\s*user,\s*'gps'/.test(gpsBanCond), gpsBanCond.slice(0, 200));
ok('两条 AI 通道都排除 settled 线索（已处置的不复活）', /anomaly\.settled/.test(stepsSrc) && /anomalySettled/.test(stepsSrc));
const restrictCalls = [...stepsSrc.matchAll(/anticheat\.restrict\(/g)].length;
ok(`steps.js 里 restrict 调用只有 AI 两处（实际 ${restrictCalls}）—— 新增自动路径必须同样过闸门`, restrictCalls === 2, restrictCalls);

// 规则路径各自检查开关（anticheat.js 内部）
const jumpBody = (anticheatSrc.match(/async function checkStepJump[\s\S]*?\n\}/) || [''])[0];
const paceBody = (anticheatSrc.match(/async function checkPace[\s\S]*?\n\}/) || [''])[0];
ok('checkStepJump 检查 config.anticheat.enabled', /if\s*\(\s*!config\.anticheat\.enabled\s*\)\s*return\s*\{\s*violation:\s*false\s*\}/.test(jumpBody));
ok('checkPace 检查 config.anticheat.enabled', /if\s*\(\s*!config\.anticheat\.enabled\s*\)\s*return\s*\{\s*violation:\s*false\s*\}/.test(paceBody));
// ===== 规则通道也必须过解封闸门（用户 2026-11-19「解封的会被重复封禁」）=====
// 只在 AI 侧加闸门是不够的：库里实测「单次同步暴增 / 配速异常」这类**规则**流水
// 同样大量出现在 unban 之后 —— 四条自动处置路径必须过同一个 liftedCoversClueDate。
ok('checkStepJump（规则通道）过解封闸门', /liftedCoversClueDate\(\s*user,\s*'sync',\s*date\s*\)/.test(jumpBody),
  (jumpBody.match(/if \(liftedCoversClueDate[\s\S]{0,120}/) || ['规则通道没有闸门'])[0]);
ok('checkPace（规则通道）过解封闸门', /liftedCoversClueDate\(\s*user,\s*'gps',\s*ctx\.dateKey\s*\)/.test(paceBody),
  (paceBody.match(/if \(liftedCoversClueDate[\s\S]{0,120}/) || ['规则通道没有闸门'])[0]);
ok('checkPace 接住调用方传的 dateKey（缺日期不拦=不放松反作弊）',
  /async function checkPace\(user, distanceMeters, durationSeconds, ctx = \{\}\)/.test(paceBody)
    && /if \(!dateKey\) return false;/.test((anticheatSrc.match(/function liftedCoversClueDate[\s\S]*?\n\}/) || [''])[0]),
  'dateKey 缺失时的兜底行为没有钉住');
ok('解封闸门唯一实现挂在 anticheat（steps.js 不复制一份）',
  /function liftedCoversClueDate\(user, scope, dateKey\)/.test(anticheatSrc)
    && !/function liftedCoversClueDate\(user, scope, dateKey\)/.test(stepsSrc)
    && /const liftedCoversClueDate = anticheat\.liftedCoversClueDate;/.test(stepsSrc),
  '闸门被复制成两份');
ok('日历键走 utils/dates::toDateKey（不许 toISOString 切片：UTC 会把北京早晨的解封算成前一天）',
  /dates\.toDateKey\(liftedAt\)/.test(anticheatSrc)
    && !/toISOString\(\)\.slice\(0, 10\)/.test((anticheatSrc.match(/function liftedCoversClueDate[\s\S]*?\n\}/) || [''])[0]),
  '解封闸门自己切 UTC 日期');

// ===== ② 自动封禁必须回写线索 =====
console.log('\n[2] 自动封禁回写线索（status=banned + autoBanned=true）');

ok('steps.js 定义了 markAutoBanned 回写函数', /async function markAutoBanned[\s\S]{0,400}autoBanned:\s*true/.test(stepsSrc));
ok('微信同步路径回写（anomaly.anomalyId）', /await markAutoBanned\(anomaly\.anomalyId, reason\);/.test(stepsSrc));
ok('GPS 路径回写（anomalyId）', /await markAutoBanned\(anomalyId, reason\);/.test(stepsSrc));

// ===== ③ 处置三动作单一实现 =====
console.log('\n[3] 处置动作单一实现（封禁 / 排除 / 归档）');

ok('disposal 服务实现 archiveAnomaly（归档=记录违规不封禁）', /async function archiveAnomaly[\s\S]{0,600}status = 'dismissed'/.test(disposalSrc));
ok('disposal 导出 archiveAnomaly', /module\.exports\s*=\s*\{\s*labelAnomaly,\s*banAnomaly,\s*dismissAnomaly,\s*archiveAnomaly\s*\}/.test(disposalSrc));
ok('归档未标注记录时默认 minor（而不是替管理员改成正常/作弊）', /if\s*\(!rec\.label\)\s*\{[\s\S]{0,200}rec\.label = 'minor'/.test(disposalSrc));

const consoleArchive = (consoleSrc.match(/router\.post\(\s*'\/anomalies\/:id\/archive'[\s\S]{0,400}?\n\);/) || [''])[0];
ok('控制台挂载 POST /anomalies/:id/archive 且鉴权 anticheat.label', /requireConsole\('anticheat\.label'\)/.test(consoleArchive) && /disposal\.archiveAnomaly/.test(consoleArchive));
ok('控制台归档路由不含自己的业务实现（只取参调服务）', consoleArchive.length > 0 && !/rec\.status\s*=/.test(consoleArchive));

const adminArchive = (adminAnomalySrc.match(/router\.post\(\s*'\/:id\/archive'[\s\S]{0,400}?\n\);/) || [''])[0];
ok('管理端挂载 POST /:id/archive 且调 disposal.archiveAnomaly', /disposal\.archiveAnomaly/.test(adminArchive));

// ===== ④ GPS 轨迹数据通路 =====
console.log('\n[4] GPS 轨迹快照与详情接口');

ok('step_anomalies 有 route 轨迹快照字段', /route:\s*\{[\s\S]{0,200}lat:\s*Number[\s\S]{0,100}lng:\s*Number/.test(modelSrc));
ok('step_anomalies 有 runRecordId 关联字段', /runRecordId:\s*\{\s*type:\s*mongoose\.Schema\.Types\.ObjectId/.test(modelSrc));
ok('saveGpsRun 创建线索时写轨迹快照（downsamplePoints）', /route:\s*routeSnapshot/.test(stepsSrc) && /downsamplePoints\(normalizePoints\(/.test(stepsSrc));
ok('RunRecord 落库后回填 runRecordId', /\$set:\s*\{\s*runRecordId:\s*doc\._id\s*\}/.test(stepsSrc));

// 2026-11-03 第二轮：轨迹详情抽成 services/anomaly-gps-detail.js 唯一实现
// （小程序管理端也要画路线图，两端路由只准鉴权取参，各写一份必然漂移）。
const gpsSvc = read('services/anomaly-gps-detail.js');
ok('anomaly-gps-detail service 存在（唯一实现）', /async function anomalyGpsDetail/.test(gpsSvc));
ok('轨迹详情指标走 withGpsMetrics（与小程序读路径同一份口径）', /gpsMetrics\.withGpsMetrics/.test(gpsSvc));
ok('数据源优先级含 runRecordId 与快照兜底', /runRecordId/.test(gpsSvc) && /dataSource:\s*'snapshot'/.test(gpsSvc));
ok('非 GPS 线索请求轨迹 → 400', /source !== 'gps'[\s\S]{0,120}400/.test(gpsSvc));
const gpsStart = consoleSrc.indexOf("'/anomalies/:id/gps'");
const gpsEnd = consoleSrc.indexOf("'/anomalies/:id/archive'");
const gpsRoute = gpsStart >= 0 && gpsEnd > gpsStart ? consoleSrc.slice(gpsStart, gpsEnd) : '';
ok('控制台挂载 GET /anomalies/:id/gps（anticheat.view）且只调 service', gpsRoute.length > 0 && /requireConsole\('anticheat\.view'\)/.test(gpsRoute) && /anomalyGpsDetail/.test(gpsRoute) && !/withGpsMetrics/.test(gpsRoute));
ok('管理端挂载 GET /:id/gps（小程序画轨迹）且只调 service', /'\/:id\/gps'[\s\S]{0,300}anomalyGpsDetail/.test(adminAnomalySrc) && !/withGpsMetrics/.test(adminAnomalySrc));
ok('admin 列表下发 features（2026-11-03 小程序对齐 Web 详情的速度/配速等指标）', /features: r\.features \|\| null/.test(adminAnomalySrc));

// ===== ⑤ 状态台可见开关状态 =====
console.log('\n[5] 状态台暴露自动处置开关状态');

ok('dashboard 返回 autoDispose 字段', /autoDispose:\s*!!\(goalCfg\.anticheat && goalCfg\.anticheat\.enabled !== false\)/.test(consoleSrc));

// ===== ⑥ 同步历史（增速研判）单一实现 + 同步时间 =====
console.log('\n[6] 同步历史增速（2026-11-03 用户「同步增速要看历史判断」+「增加记录时的同步时间」）');

const histSrc = read('services/sync-rate-history.js');
ok('sync-rate-history service 存在（唯一实现）', /async function syncRateHistory/.test(histSrc));
ok('间隔 < MIN_WINDOW_SEC 不给增速（与判定同一窗口口径）', /MIN_WINDOW_SEC/.test(histSrc) && /short = true/.test(histSrc));
ok('跨天参照取前一天最后一条（addDays -1）', /addDays\(rec\.date, -1\)/.test(histSrc));
const histRefs = (consoleSrc.match(/sync-rate-history/g) || []).length + (adminAnomalySrc.match(/sync-rate-history/g) || []).length;
ok(`两端路由都挂 sync-history 且只取参（引用 ${histRefs} 处）`, histRefs >= 2 && !/function syncRateHistory/.test(consoleSrc + adminAnomalySrc));
ok('console 列表下发 createdAt（同步时间）', /createdAt: r\.createdAt \|\| null/.test(consoleSrc));
ok('console 前端默认展开（collapsed 反转）+ 同步时间展示', (() => {
  const appJs = require('fs').readFileSync(path.join(SERVER, '..', 'public', 'console', 'app.js'), 'utf8');
  return /var collapsed = \{\}/.test(appJs) && /!collapsed\[r\.id\]/.test(appJs) && /同步时间/.test(appJs) && /buildSyncHistory/.test(appJs);
})());

console.log(`\n${failed ? `✗ ${failed} 项未通过` : '✓ 全部通过'}`);
process.exit(failed ? 1 : 0);
