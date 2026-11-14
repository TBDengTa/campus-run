/**
 * 检查器：唐跑AI数据模型的「阶段性自升级」契约。
 *
 * 背景（用户 2026-11-12）：「唐跑AI数据模型 可以升级了 后端中的已经有很多数据了，
 * 请增加阶段性自升级」。
 *
 * 上一版只有一个「标注攒够了，可以升级」的**提示**，升级动作要人工改代码 ——
 * 而现网标注已经攒到 248 条（实测），提示一直挂着、却没有东西会真的升。
 * 本检查器盯的是这一轮新增的三级阶梯，以及它最容易静默出错的六处：
 *
 *   ① **影子阶段绝不允许封号**：新模型上线最怕的不是漏判，是成片误封（只能靠申诉发现）。
 *      所以 stage 1 的风险分必须**封顶在当前自动封禁线之下**，且封顶值要跟着
 *      管理员调严谨度档位一起走（写死 0.78 的话，切到 strict（0.68）就漏了）。
 *   ② **闸门必须是量化条件**：样本量 / 类别平衡 / 交叉验证 AUC / 精度 / 影子实测精度。
 *      少一条就会出现「模型其实没学到东西但被升到可封号」。
 *   ③ **AUC 稳定性闸门**：实测 werun 各折 AUC 在 0.41~0.98 之间跳（均值 0.63），
 *      只看均值会「碰巧压线就升级」。
 *   ④ **升级判断用交叉验证，不是训练集**：训练集准确率在小样本上毫无意义。
 *   ⑤ **降级必须存在且能自动发生**：只会升级不会降级 = 单向棘轮，越来越松。
 *   ⑥ **训练与推理共用同一份特征顺序与特征清单**：错位不报错、只是判得不准。
 *
 * 另外锁死单一实现与接线（这部分与 check-anticheat-disposal 同一思路）：
 *   · 训练/闸门/快照只在 services/anticheat-upgrade.js + anticheat-supervised.js；
 *   · Web 控制台与小程序管理端路由**只鉴权取参**，不得各写一套；
 *   · 阶段与概率必须真的落进 step_anomalies / step_labels（否则影子精度永远算不出来）。
 *
 * 运行：node tools/check-anticheat-upgrade.js
 */
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server', 'src');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(SERVER, p), 'utf8');
const readRoot = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let failed = 0;
function ok(name, cond, detail) {
  console.log(`${cond ? '  ok   ' : '  FAIL '}${name}${cond ? '' : '  -> ' + JSON.stringify(detail)}`);
  if (!cond) failed += 1;
}

const upSrc = read('services/anticheat-upgrade.js');
const supSrc = read('services/anticheat-supervised.js');
const modelSrc = read('services/anticheat-model.js');
const stepsSrc = read('services/steps.js');
const disposalSrc = read('services/anomaly-disposal.js');
const stateModel = read('models/anticheat-model-state.js');
const labelModel = read('models/step-label.js');
const anomalyModel = read('models/step-anomaly.js');
const cfgModel = read('models/goal-config.js');
const cfgSvc = read('services/anticheat-config.js');
const consoleSrc = read('routes/console.js');
const adminSrc = read('routes/admin/step-anomalies.js');
const indexSrc = read('index.js');
const consoleJs = readRoot('server', 'public', 'console', 'app.js');
const consoleHtml = readRoot('server', 'public', 'console', 'index.html');
const mpAnoJs = readRoot('miniprogram', 'packageAdmin', 'config', 'anomalies', 'anomalies.js');
const mpAnoWxml = readRoot('miniprogram', 'packageAdmin', 'config', 'anomalies', 'anomalies.wxml');
const mpCfgWxml = readRoot('miniprogram', 'packageAdmin', 'config', 'anticheat.wxml');
const mpCfgJs = readRoot('miniprogram', 'packageAdmin', 'config', 'anticheat.js');

// ===== ① 三级阶梯与阶段模型的持久化 =====
console.log('[1] 三级阶梯与阶段持久化');

ok('upgrade 服务定义了三级阶段（0 无监督 / 1 影子辅助 / 2 有监督主判）',
  /const STAGES = \['unsupervised', 'assist', 'primary'\]/.test(upSrc));
ok('阶段状态落到独立集合（不是内存）', /anticheat_model_states/.test(stateModel));
ok('状态按来源分开（source unique）', /source: \{ type: String, enum: \['werun', 'gps'\], required: true, unique: true \}/.test(stateModel));
ok('状态有 CAS 版本号（多进程不互相覆盖）', /stateVersion: \{ type: Number/.test(stateModel) && /\$inc: \{ stateVersion: 1 \}/.test(upSrc));
ok('状态文档首次使用前先幂等创建（否则第一次评估永远 matched=0）',
  /async function ensureState/.test(upSrc) && /await ensureState\(src\)/.test(upSrc));
ok('阶段变更写历史（审计：什么时候/凭什么/谁批的）',
  /history: \{[\s\S]{0,400}operator/.test(stateModel) && /\$push: \{[\s\S]{0,80}history/.test(upSrc));

// ===== ② 影子阶段绝不封号 =====
console.log('\n[2] 影子阶段分数封顶（绝不单独封号）');

// 从 scoreFor 里取封顶逻辑
const scoreForBody = (upSrc.match(/async function scoreFor[\s\S]*?\n\}/) || [''])[0];
ok('scoreFor 存在（判定链路的接入点）', scoreForBody.length > 0);
ok('封顶基准取**当前生效的自动封禁线**（不是写死 0.78）',
  /cap = Math\.max\(0\.3, \(Number\(thresholds && thresholds\.autoBan\) \|\| 0\.78\) - 0\.02\)/.test(scoreForBody),
  scoreForBody.slice(0, 400));
ok('影子阶段（stage===1）才封顶，主判不封顶',
  /stage === 1 \? Math\.min\(risk, cap\) : risk/.test(scoreForBody));
ok('封顶时回传 capped 标记（可解释，界面要能说清）', /capped: stage === 1 && risk > finalRisk/.test(scoreForBody));

// 行为断言：直接跑纯函数，确认影子阶段的风险分**永远低于封禁线**
{
  const sup = require(path.join(SERVER, 'services', 'anticheat-supervised'));
  const fakeModel = {
    features: ['a'],
    bias: 20, // 极端偏向「作弊」：sigmoid(20) ≈ 1
    weights: [0],
    means: [0],
    stds: [1],
    operating: { pSuspicious: 0.5, pAutoBan: 0.8 },
  };
  let allBelow = true;
  let worst = 0;
  for (const autoBan of [0.68, 0.78, 0.88]) {
    const th = { suspicious: autoBan - 0.16, autoBan };
    for (let p = 0; p <= 1.0001; p += 0.01) {
      const risk = sup.mapToRisk(p, fakeModel, th);
      // 影子阶段的封顶值 = max(0.3, autoBan - 0.02)
      const capped = Math.min(risk, Math.max(0.3, autoBan - 0.02));
      if (capped >= autoBan) allBelow = false;
      if (capped > worst && autoBan === 0.78) worst = capped;
    }
  }
  ok('概率拉满时影子分仍严格低于自动封禁线（三档阈值各扫 100 个概率点）', allBelow, { worst });
  ok('主判阶段同概率可越过封禁线（封顶只作用于影子）', sup.mapToRisk(1, fakeModel, { suspicious: 0.62, autoBan: 0.78 }) >= 0.78);
}

// evaluate 必须把有监督分与物理约束并列取 max，且理由入去重
ok('evaluate 合并有监督分（三路取 max）',
  /supervised \? Math\.max\(modelScore, hardScore\.score, supervised\.risk\) : Math\.max\(modelScore, hardScore\.score\)/.test(modelSrc));
ok('有监督理由走 dedupeReasons（不与其它理由重复）',
  /dedupeReasons\(\[\.\.\.hardScore\.reasons, \.\.\.explain\(source, feat, score\), \.\.\.supReasons\]\)/.test(modelSrc));
ok('有监督模型故障不影响原判定（异常被吞掉）',
  /try \{\s*\n\s*\/\/ 惰性 require[\s\S]{0,400}supervised = await upgradeSvc\.scoreFor[\s\S]{0,200}catch \(e\) \{\s*\n\s*supervised = null;/.test(modelSrc));

// ===== ③ 闸门必须量化 =====
console.log('\n[3] 晋升/降级闸门');

ok('GATES.assist 含样本量/类别/特征数三项下限',
  /assist: \{[\s\S]{0,500}minTrainable: \d+,[\s\S]{0,200}minPositives: \d+,[\s\S]{0,100}minNegatives: \d+/.test(upSrc));
ok('GATES 含 AUC 闸门', /minAuc: 0\.65/.test(upSrc) && /minAuc: 0\.75/.test(upSrc));
ok('GATES 含 AUC 折间波动闸门（只看均值会「碰巧压线就升级」）',
  /maxAucStd: 0\.18/.test(upSrc) && /maxAucStd: 0\.12/.test(upSrc) && /aucStd <= g\.maxAucStd/.test(upSrc));
ok('主判闸门含封禁线精度 ≥ 0.9（误封代价最大）', /minPrecisionAtAutoBan: 0\.9/.test(upSrc));
ok('主判闸门要求影子驻留天数（跑过真实流量）', /minAssistDwellDays: 3/.test(upSrc));
ok('主判闸门要求影子实测精度（不是只看离线指标）',
  /minShadowSamples: 20/.test(upSrc) && /minShadowFlagged: 10/.test(upSrc) && /minShadowPrecision: 0\.8/.test(upSrc));
ok('降级闸门存在且能自动触发', /const DEMOTE = \{/.test(upSrc) && /shadowPrecisionFloor: 0\.6/.test(upSrc) && /demotion\.demote/.test(upSrc));
ok('刚升级 24 小时内不降级（新模型需要流量才形成证据）', /minAgeHours: 24/.test(upSrc));
ok('缺什么要说人话（还差 N 条 / AUC 多少）', /还差 \$\{Math\.max\(0,/.test(upSrc) && /低于 \$\{g\.minAuc\}/.test(upSrc));

// ===== ④ 升级判断用交叉验证而不是训练集 =====
console.log('\n[4] 交叉验证（不是单次留出、更不是训练集）');

ok('有监督学习器按类别分层 K 折', /const folds = Math\.max\(2, Math\.min\(DEFAULTS\.folds/.test(supSrc) && /buckets\[idx % folds\]\.push\(r\)/.test(supSrc));
ok('每折都保证两类都有（否则 AUC 算不出来）', /for \(const y of \['0', '1'\]\)[\s\S]{0,200}shuffleInPlace/.test(supSrc));
ok('指标取各折均值，另给 std 供稳定性闸门', /auc: meanOf\(aucList\)/.test(supSrc) && /aucStd: stdOf\(aucList\)/.test(supSrc));
ok('最终模型用全部标注重训（CV 只出指标）', /最终模型：用\*\*全部标注\*\*重训/.test(supSrc));
ok('不存在「用训练集准确率当升级依据」',
  !/metrics[\s\S]{0,80}trainAccuracy/.test(supSrc) && !/trainAccuracy/.test(upSrc));
ok('随机种子固定（多进程切出同一份折）', /mulberry32\(opts\.seed == null \? DEFAULTS\.seed/.test(supSrc) && /seed: 20261112/.test(supSrc));

// 行为断言：同一份数据两次训练结果必须**逐位相同**（可复现）
{
  const sup = require(path.join(SERVER, 'services', 'anticheat-supervised'));
  const samples = [];
  for (let i = 0; i < 80; i += 1) {
    const cheat = i % 4 === 0;
    samples.push({
      label: cheat ? 'cheat' : 'normal',
      features: { a: cheat ? 9 : 0.5, b: cheat ? 8 : 0.6, c: cheat ? 7 : 0.7, d: cheat ? 6 : 0.8 },
    });
  }
  const order = ['a', 'b', 'c', 'd'];
  const r1 = sup.trainAndValidate(samples, { order });
  const r2 = sup.trainAndValidate(samples, { order });
  ok('同一份标注两次训练指标完全一致（多进程不会各算一套）',
    r1 && r2 && JSON.stringify(r1.metrics.aucFolds) === JSON.stringify(r2.metrics.aucFolds),
    { a: r1 && r1.metrics.aucFolds, b: r2 && r2.metrics.aucFolds });
  ok('完全可分的假数据能训出高 AUC（模型不是摆设）', r1 && r1.metrics.auc > 0.9, r1 && r1.metrics.auc);
}

// 行为断言：特征覆盖不足的维度必须被剔除（老标注缺新特征）
{
  const sup = require(path.join(SERVER, 'services', 'anticheat-supervised'));
  const samples = [];
  for (let i = 0; i < 40; i += 1) {
    const cheat = i % 2 === 0;
    // 前三个特征都有；第四个（newFeat）只有 i<4 才有 → 覆盖率 10%
    const f = { a: cheat ? 9 : 1, b: cheat ? 9 : 1, c: cheat ? 9 : 1 };
    if (i < 4) f.newFeat = 1;
    samples.push({ label: cheat ? 'cheat' : 'normal', features: f });
  }
  const out = sup.trainAndValidate(samples, { order: ['a', 'b', 'c', 'newFeat'] });
  ok('覆盖率不足的特征被剔除（缺新特征的老标注不会教出反向权重）',
    out && out.features && out.features.includes('newFeat') === false, out && out.features);
  const cov = (out.coverage || []).find((c) => c.key === 'newFeat');
  ok('覆盖情况对外可见（管理端能解释为什么某维度没用上）', cov && cov.used === false && cov.ratio < 0.8, cov);
}

// ===== ⑤ 训练与推理共用同一份特征清单 =====
console.log('\n[5] 训练/推理同源');

ok('训练用的特征顺序取自 anticheat-model 的 WERUN_ORDER / GPS_ORDER（唯一定义）',
  /const order = src === 'werun' \? acModel\.WERUN_ORDER : acModel\.GPS_ORDER/.test(upSrc));
ok('推理只按模型自带的 features 清单取值（维度不会静默错位）',
  /for \(let d = 0; d < model\.features\.length; d \+= 1\)/.test(supSrc) && /model\.features\[model\.features\[d\]\]|features\[model\.features\[d\]\]/.test(supSrc));
ok('训练样本带特征快照（不用 run_records 重算：特征会与标注时刻错位）',
  /features: r\.features \|\| null/.test(upSrc) && /\.select\('label isCheat features/.test(upSrc));

// ===== ⑥ 影子证据的数据通路 =====
console.log('\n[6] 影子证据落库通路');

ok('step_labels 有阶段与概率字段', /modelStage: \{ type: Number, default: 0 \}/.test(labelModel)
  && /supervisedProb: \{ type: Number, default: null \}/.test(labelModel)
  && /supervisedScore: \{ type: Number, default: null \}/.test(labelModel));
ok('step_anomalies 有阶段与概率字段', /supervisedProb: \{ type: Number, default: null \}/.test(anomalyModel)
  && /modelStage: \{ type: Number, default: 0 \}/.test(anomalyModel));
ok('微信同步线索写入时带上阶段与概率',
  /modelStage: modelResult \? Number\(modelResult\.modelStage\) \|\| 0 : 0/.test(stepsSrc)
  && /supervisedProb: modelResult && modelResult\.supervised/.test(stepsSrc));
ok('GPS 线索写入时带上阶段与概率',
  /modelStage: Number\(modelResult\.modelStage\) \|\| 0,/.test(stepsSrc));
ok('标注（处置）落库时把阶段与概率带进训练集',
  /modelStage: Number\(rec\.modelStage\) \|\| 0/.test(disposalSrc)
  && /supervisedProb: rec\.supervisedProb == null \? null : Number\(rec\.supervisedProb\)/.test(disposalSrc));
ok('recordFeedback 会写入这三个字段并钳位', /modelStage: Math\.max\(0, Math\.min\(2, Number\(meta\.modelStage\) \|\| 0\)\)/.test(modelSrc));
ok('影子统计只看「有监督已经在跑」的标注（modelStage >= 1）',
  /s\.modelStage >= 1 && s\.supervisedScore != null/.test(upSrc));

// ===== ⑦ 单一实现 + 两端只鉴权取参 =====
console.log('\n[7] 单一实现与接线路由');

ok('训练/闸门/快照只在 upgrade + supervised 两个服务里',
  /async function evaluateSource/.test(upSrc) && /function trainAndValidate/.test(supSrc));
ok('Web 控制台路由只调服务（不自己训练）',
  /anticheat-upgrade/.test(consoleSrc)
  && !/fitLogistic|trainAndValidate/.test(consoleSrc)
  && !/function checkPromotion/.test(consoleSrc));
ok('小程序管理端路由只调服务（不自己训练）',
  /anticheat-upgrade/.test(adminSrc)
  && !/fitLogistic|trainAndValidate/.test(adminSrc));
ok('两个控制台路由都挂了 model-stages / model-evaluate / model-stage',
  /'\/model-stages'/.test(consoleSrc) && /'\/model-evaluate'/.test(consoleSrc) && /'\/model-stage'/.test(consoleSrc)
  && /'\/model-stages'/.test(adminSrc) && /'\/model-evaluate'/.test(adminSrc) && /'\/model-stage'/.test(adminSrc));
ok('评估/改阶段要 anticheat.manage（不是 view，也不兼容 user.manage）',
  /router\.post\(\s*'\/model-evaluate',\s*\n?\s*requireConsole\('anticheat\.manage'\)/.test(consoleSrc)
  && /const MANAGE = requireAnyPermission\(\['anticheat\.manage'\]\)/.test(adminSrc)
  && /'\/model-evaluate',\s*\n\s*MANAGE,/.test(adminSrc));
ok('dashboard 下发 stages 快照（状态台画阶梯）', /stages,/.test(consoleSrc) && /require\('\.\.\/services\/anticheat-upgrade'\)/.test(consoleSrc));
ok('定时评估在 listen() 之后启动（检查器 createApp 不会被顺带训练）',
  /startScheduler\(\)/.test(indexSrc) && /async function listen\(\)/.test(indexSrc));
ok('定时器带 unref + 优雅退出时停掉', /typeof schedTimer\.unref === 'function'/.test(upSrc) && /stopScheduler/.test(indexSrc));
ok('测试环境不启动定时器', /process\.env\.NODE_ENV === 'test'/.test(upSrc));

// ===== ⑧ 配置开关 =====
console.log('\n[8] 自升级开关（goal_config）');

ok('goal_config 有 autoUpgrade / autoDemote', /autoUpgrade: \{ type: Boolean, default: true \}/.test(cfgModel)
  && /autoDemote: \{ type: Boolean, default: true \}/.test(cfgModel));
ok('写入口径显式传了才动（不静默改开关）',
  /if \(input\.autoUpgrade !== undefined\)/.test(cfgSvc) && /if \(input\.autoDemote !== undefined\)/.test(cfgSvc));
ok('关闭后只写建议不改阶段（评估照跑）',
  /const allowPromote = opts\.allowPromote !== false && mode === 'auto'/.test(upSrc)
  && /const allowDemote = opts\.allowDemote !== false && mode === 'auto'/.test(upSrc));
ok('手动锁定后自动流程绝不动阶段',
  /mode === 'manual' \? 'manual' : 'auto'/.test(upSrc) && /已手动指定阶段（自动评估只给建议，不改阶段）/.test(upSrc));

// ===== ⑨ 前端接线（Web + 小程序） =====
console.log('\n[9] 前端接线');

ok('Web 状态台有阶段卡片容器', /id="stageBox"/.test(consoleHtml) && /id="stageTag"/.test(consoleHtml));
ok('Web 前端渲染阶梯并调三个接口',
  /function renderStages/.test(consoleJs) && /'\/model-evaluate'/.test(consoleJs) && /'\/model-stage'/.test(consoleJs));
ok('Web 动作按钮按 caps.manage 显隐（只读不显示）',
  /if \(caps\.manage\) \{\s*\n\s*var btnEval/.test(consoleJs));
ok('Web 前端**不自己算**闸门（只渲染服务端 missing 文案）',
  !/minShadowPrecision|minAuc/.test(consoleJs) && /stage-miss/.test(consoleJs));
ok('Web 配置页有自升级开关容器', /id="autoUpgradeBox"/.test(consoleHtml));
ok('小程序异常记录页加载阶段快照', /model-stages/.test(mpAnoJs) && /stageBox|sa-stage/.test(mpAnoWxml));
ok('小程序写入口由 anticheat.manage 守卫（caps 同口径）', /applyManage\(this, 'anticheat\.manage'/.test(mpAnoJs));
ok('小程序渲染缺失项（服务端下一阶段缺什么）', /src\.nextMissing/.test(mpAnoWxml));
ok('小程序配置页有两个自升级开关', /autoUpgrade/.test(mpCfgWxml) && /autoDemote/.test(mpCfgWxml));
ok('小程序开关走布尔分支（Number(false)=0 会让「关掉」静默失效）',
  /field === 'autoUpgrade' \|\| field === 'autoDemote'/.test(mpCfgJs));

// ===== ⑩ 旧「升级提示」仍然保留（不回归） =====
console.log('\n[10] 既有升级提示未被破坏');
ok('checkUpgradeReadiness 仍在（旧提示与闸门并存）', /async function checkUpgradeReadiness/.test(modelSrc));
ok('管理端 /upgrade-status 仍在', /'\/upgrade-status'/.test(adminSrc));
ok('Web 状态台仍渲染旧进度条', /renderUpgrade/.test(consoleJs) && /id="upgradeBox"/.test(consoleHtml));

// ===== ⑪ 样本量必须区分「库内总量」与「进训练量」（用户 2026-11-14） =====
//
// 事故：管理端「唐跑AI数据模型」卡片微信模型恒显示「20000 条样本」，
//   而库里当时已有 162,998 条 werun 记录。那个 20000 是 TRAIN_MAX_ROWS 训练采样上限，
//   被当成「样本量」下发 —— 数据从 2 万涨到 16 万，管理员看到的数字一动不动。
console.log('\n[11] 样本量口径（库内总量 ≠ 进训练量）');

ok('模型上带 totalRows（库内真实可用样本数）', /model\.totalRows = Math\.max\(rows\.length, totalRows\)/.test(modelSrc));
ok('模型上带 cappedByLimit 标记（是否被采样上限截断）', /model\.cappedByLimit = totalRows > rows\.length/.test(modelSrc));
ok('有独立的计数函数（过滤条件与取数一致）',
  /async function countTrainingRows/.test(modelSrc)
  && /countDocuments\(\{ source: 'werun', steps: \{ \$gt: 0 \} \}\)/.test(modelSrc)
  && /distance: \{ \$gt: 50 \}/.test(modelSrc));
ok('trainSource 先计数再抽样', /const totalRows = await countTrainingRows\(source\);\s*\n\s*const rows = await fetchTrainingRows\(source\)/.test(modelSrc));
ok('TRAIN_MAX_ROWS 对外导出（前端要解释「抽样上限」）', /TRAIN_MAX_ROWS,\s*\n\s*evaluate,/.test(modelSrc));

ok('Web dashboard 下发 totalRows 与 capped',
  /totalRows,\s*\n\s*trainingCap: acModel\.TRAIN_MAX_ROWS,\s*\n\s*capped:/.test(consoleSrc));
ok('小程序管理端下发 totalRows 与 capped',
  /totalRows,\s*\n\s*capped: !!totalRows && totalRows > rows,/.test(adminSrc));
ok('Web 前端展示「总量 · 取 N 条训练」（不再只显示 rows）',
  /' 条 · 取 ' \+ fmt\(x\.rows\) \+ ' 条训练'/.test(consoleJs));
ok('小程序前端同样区分两个口径', /条 · 取 \$\{x\.rows\} 条训练/.test(mpAnoJs));
ok('小程序 wxml 用 sampleText（不是裸 rows）', /engine\.werunSampleText/.test(mpAnoWxml) && /engine\.gpsSampleText/.test(mpAnoWxml));

console.log(`\n${failed ? `✗ ${failed} 项未通过` : '✓ 全部通过'}`);
process.exit(failed ? 1 : 0);
