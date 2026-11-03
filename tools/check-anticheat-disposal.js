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
ok('微信同步 AI 封禁前检查开关', /if\s*\(\s*anomaly\s*&&\s*anomaly\.autoBan\s*&&\s*\(await autoDisposeEnabled\(\)\)\s*\)/.test(stepsSrc));
ok('GPS AI 封禁前检查开关', /if\s*\(\s*anomaly\s*&&\s*anomaly\.level\s*===\s*'autoBan'\s*&&\s*\(await autoDisposeEnabled\(\)\)\s*\)/.test(stepsSrc));
const restrictCalls = [...stepsSrc.matchAll(/anticheat\.restrict\(/g)].length;
ok(`steps.js 里 restrict 调用只有 AI 两处（实际 ${restrictCalls}）—— 新增自动路径必须同样过闸门`, restrictCalls === 2, restrictCalls);

// 规则路径各自检查开关（anticheat.js 内部）
const jumpBody = (anticheatSrc.match(/async function checkStepJump[\s\S]*?\n\}/) || [''])[0];
const paceBody = (anticheatSrc.match(/async function checkPace[\s\S]*?\n\}/) || [''])[0];
ok('checkStepJump 检查 config.anticheat.enabled', /if\s*\(\s*!config\.anticheat\.enabled\s*\)\s*return\s*\{\s*violation:\s*false\s*\}/.test(jumpBody));
ok('checkPace 检查 config.anticheat.enabled', /if\s*\(\s*!config\.anticheat\.enabled\s*\)\s*return\s*\{\s*violation:\s*false\s*\}/.test(paceBody));

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

const gpsStart = consoleSrc.indexOf("'/anomalies/:id/gps'");
const gpsEnd = consoleSrc.indexOf("'/anomalies/:id/archive'");
const gpsRoute = gpsStart >= 0 && gpsEnd > gpsStart ? consoleSrc.slice(gpsStart, gpsEnd) : '';
ok('控制台挂载 GET /anomalies/:id/gps 且鉴权 anticheat.view', gpsRoute.length > 0 && /requireConsole\('anticheat\.view'\)/.test(gpsRoute));
ok('轨迹详情指标走 withGpsMetrics（与小程序读路径同一份口径）', /gpsMetrics\.withGpsMetrics/.test(gpsRoute));
ok('数据源优先级含 runRecordId 与快照兜底', /runRecordId/.test(gpsRoute) && /dataSource:\s*'snapshot'/.test(gpsRoute));
ok('非 GPS 线索请求轨迹 → 400', /source !== 'gps'[\s\S]{0,120}400/.test(gpsRoute));

// ===== ⑤ 状态台可见开关状态 =====
console.log('\n[5] 状态台暴露自动处置开关状态');

ok('dashboard 返回 autoDispose 字段', /autoDispose:\s*!!\(goalCfg\.anticheat && goalCfg\.anticheat\.enabled !== false\)/.test(consoleSrc));

console.log(`\n${failed ? `✗ ${failed} 项未通过` : '✓ 全部通过'}`);
process.exit(failed ? 1 : 0);
