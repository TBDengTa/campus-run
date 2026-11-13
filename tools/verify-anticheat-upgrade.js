/**
 * 端到端验证：唐跑AI数据模型的**阶段性自升级**（用户 2026-11-12）。
 *
 * 真连库、真跑服务（services/anticheat-upgrade.js + anticheat-supervised.js），
 * 用**临时标注/临时账号**跑完整链路，最后删干净并核对残留为 0，
 * 绝不碰任何真实学生数据与真实标注（结束后恢复原状态文档）。
 *
 * 覆盖十一节，每一节都对应一处会静默出错的地方：
 *   ① 三级阶梯定义与阶段状态可持久化（CAS + 首次创建）
 *   ② 样本不足时**不许升级**，且缺什么要说人话
 *   ③ 标注够了但模型没有区分力（随机标签）→ **不许升级**（这是最关键的一节：
 *      只看样本量的闸门会把「恰好攒够 200 条」当成能力，正是用户抱怨的那类假升级）
 *   ④ 标注够 + 可分 → 升到影子辅助，且**分数封顶在自动封禁线以下**（绝不封号）
 *   ⑤ 影子阶段攒够证据 + 离线指标达标 → 才允许升到主判
 *   ⑥ 影子实测精度掉线 → **自动降级**
 *   ⑦ 手动锁定后自动评估只写建议、绝不动阶段；解除锁定后恢复自动
 *   ⑧ 关掉 autoUpgrade → 评估照跑、指标照更、但阶段不动
 *   ⑨ 旧标注（无 modelStage/supervisedProb）不计入影子证据（不猜）
 *   ⑩ 判定链路真接入：evaluate 的 supervised 字段与封顶生效
 *   ⑪ 清理核对：临时标注/账号/状态文档残留为 0
 *
 * 用法：node tools/verify-anticheat-upgrade.js
 */
const path = require('path');
const serverDir = path.join(__dirname, '..', 'server');
const config = require(path.join(serverDir, 'src', 'config'));
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));

const User = require(path.join(serverDir, 'src', 'models', 'user'));
const GoalConfig = require(path.join(serverDir, 'src', 'models', 'goal-config'));
const ModelState = require(path.join(serverDir, 'src', 'models', 'anticheat-model-state'));
const StepLabel = require(path.join(serverDir, 'src', 'models', 'step-label'));
const StepAnomaly = require(path.join(serverDir, 'src', 'models', 'step-anomaly'));
const upgradeSvc = require(path.join(serverDir, 'src', 'services', 'anticheat-upgrade'));
const supSvc = require(path.join(serverDir, 'src', 'services', 'anticheat-supervised'));
const acModel = require(path.join(serverDir, 'src', 'services', 'anticheat-model'));

let failed = 0;
function assert(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ← ' + JSON.stringify(extra)}`);
  if (!cond) failed += 1;
}
const TS = Date.now();
const TAG = `acu_verify_${TS}`;
// 训练样本的隔离条件：**只训本脚本造的标注**。
// 为什么必须隔离：库里真实标注会随人工研判不断增长（实测 2026-11-12 已有 248 条），
// 不隔离的话第 2 节「20 条不够、不该升级」会被真实标注补到 60 条以上 →
// 断言变成随机成败（第一次跑就是这么红的）。生产路径永远不传 sampleQuery。
const isoQuery = { openid: new RegExp(`^${TAG}`) };
const evalOpts = { operator: 'verify', sampleQuery: isoQuery };

// 造一条「按指定规则可分/不可分」的标注，来源固定 gps（特征维度最全，不依赖版本差异）
function makeLabel({ cheat, discriminate, withShadow, prob, score, i }) {
  const base = 300 + (i % 50); // 距离米
  // discriminate=true → 作弊样本的特征明显落在极端区间；false → 两类重叠（模型学不到东西）
  const jitter = discriminate ? 0 : (i * 37) % 400;
  const pace = cheat && discriminate ? 150 : 700 + jitter;
  const features = {
    paceSecPerKm: pace,
    speed: cheat && discriminate ? 20 : 1.2 + jitter / 1000,
    distance: base,
    duration: base / (cheat && discriminate ? 20 : 1.2),
    pointCount: cheat && discriminate ? 400 : 20 + (i % 7),
    gapAvg: 5000,
    gapMax: 60000,
    jitter: cheat && discriminate ? 8 : 0.5 + (i % 5) / 10,
    sparse: 10,
  };
  return {
    userId: new mongoose.Types.ObjectId(),
    openid: `${TAG}_${i}`,
    source: 'gps',
    label: cheat ? 'cheat' : 'normal',
    isCheat: !!cheat,
    modelScore: 0.6,
    ruleScore: 40,
    features,
    modelStage: withShadow ? 1 : 0,
    supervisedProb: withShadow ? prob : null,
    supervisedScore: withShadow ? score : null,
    operator: 'verify',
  };
}

// 造 N 条可分/不可分标注：一半作弊
function makeSamples(n, discriminate, { withShadow = false, shadowPrec = 0.9 } = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const cheat = i % 2 === 0;
    // 影子证据：被模型判为可疑的样本里，cheat 的比例决定实测精度
    const flagged = withShadow && i % 3 === 0;
    // shadowPrec 控制「被判可疑的样本中真作弊的比例」
    const shouldBeCheat = shadowPrec >= 0.9 ? cheat : !cheat;
    out.push(
      makeLabel({
        cheat: flagged ? shouldBeCheat : cheat,
        discriminate,
        withShadow: flagged,
        prob: 0.9,
        score: 0.9,
        i,
      })
    );
  }
  return out;
}

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName, serverSelectionTimeoutMS: 20000 });

  // ---- 0) 备份真实状态与配置，结束后恢复 ----
  const backupStates = await ModelState.find({}).lean();
  const cfg = await GoalConfig.getSingleton();
  const backupAc = JSON.parse(JSON.stringify(cfg.anticheat || {}));
  const createdLabels = [];
  const createdUsers = [];

  try {
    // ==================== 1) 阶梯定义与持久化 ====================
    console.log('\n[1] 三级阶梯与阶段持久化');
    assert(
      JSON.stringify(upgradeSvc.STAGES) === JSON.stringify(['unsupervised', 'assist', 'primary']),
      '阶段定义为 0 无监督 / 1 影子辅助 / 2 有监督主判',
      upgradeSvc.STAGES
    );
    assert(
      upgradeSvc.STAGE_TEXT.unsupervised === '无监督' &&
        upgradeSvc.STAGE_TEXT.assist === '影子辅助' &&
        upgradeSvc.STAGE_TEXT.primary === '有监督主判',
      '阶段中文文案唯一（服务端下发，前端不各写一份）',
      upgradeSvc.STAGE_TEXT
    );

    // 干净的初始态：清掉 gps 状态 + 所有临时标注
    await ModelState.deleteOne({ source: 'gps' });
    await StepLabel.deleteMany({ openid: new RegExp(`^${TAG}`) });
    upgradeSvc.invalidateStateCache();
    const s0 = await upgradeSvc.getState('gps');
    assert(s0.stage === 0 && s0.stageKey === 'unsupervised', '无状态文档时按阶段 0（不判空）', { stage: s0.stage });

    // ==================== 2) 样本不足不许升级 ====================
    console.log('\n[2] 样本不足 → 不许升级，且缺什么要说人话');
    await StepLabel.insertMany(makeSamples(20, true));
    upgradeSvc.invalidateStateCache();
    let r = await upgradeSvc.evaluateSource('gps', evalOpts);
    assert(r.action === 'hold' && r.nextStage === 0, '20 条标注（闸门 60）不升级', { action: r.action, stage: r.nextStage });
    assert(
      r.missing.some((m) => /还差 \d+ 条/.test(m)),
      '缺失项写明还差多少条（不是只说"未达标"）',
      r.missing
    );
    await StepLabel.deleteMany({ openid: new RegExp(`^${TAG}`) });

    // ==================== 3) 标注够但没有区分力 → 仍不许升级 ====================
    console.log('\n[3] 标注够但模型学不到东西 → 仍不许升级（防「假升级」）');
    // 不可分数据：作弊/正常的特征分布重叠，AUC 应接近 0.5
    await StepLabel.insertMany(makeSamples(80, false));
    upgradeSvc.invalidateStateCache();
    r = await upgradeSvc.evaluateSource('gps', evalOpts);
    assert(r.sampleCount >= 60, '样本量已过闸门（确认是本节点在起作用）', r.sampleCount);
    assert(r.action === 'hold', '无区分力的模型不升级（只看条数就会在这里假升级）', { action: r.action, auc: r.metrics && r.metrics.auc });
    assert(
      r.missing.some((m) => /AUC/.test(m)),
      '缺失项点名 AUC 不足',
      r.missing
    );
    await StepLabel.deleteMany({ openid: new RegExp(`^${TAG}`) });

    // ==================== 4) 可分数据 → 升到影子辅助 ====================
    console.log('\n[4] 样本足够 + 可分 → 升到影子辅助（stage 1）');
    await StepLabel.insertMany(makeSamples(80, true));
    upgradeSvc.invalidateStateCache();
    r = await upgradeSvc.evaluateSource('gps', evalOpts);
    assert(r.action === 'promote' && r.nextStage === 1, '升到影子辅助', { action: r.action, next: r.nextStage, reason: r.reason });
    const s1 = await upgradeSvc.getState('gps');
    assert(s1.stage === 1 && s1.stageKey === 'assist', '阶段持久化到库', { stage: s1.stage });
    assert(!!s1.model && Array.isArray(s1.model.features) && s1.model.features.length >= 4, '模型与特征清单已落库', s1.model && s1.model.features);
    assert(!!(s1.history && s1.history.length), '阶段变更写进了历史（审计）', s1.history);
    assert(
      s1.metrics && s1.metrics.auc > 0.65 && s1.metrics.aucStd != null,
      '指标含 AUC 均值与折间波动',
      s1.metrics && { auc: s1.metrics.auc, std: s1.metrics.aucStd }
    );

    // ==================== 5) 影子阶段分数封顶：绝不封号 ====================
    console.log('\n[5] 影子阶段分数封顶（绝不单独封号）');
    const th = acModel.currentThreshold();
    // 用极端特征跑 scoreFor：概率应接近 1，但风险分必须被压在封禁线以下
    const extreme = {
      paceSecPerKm: 100,
      speed: 25,
      distance: 5000,
      duration: 200,
      pointCount: 800,
      gapAvg: 100,
      gapMax: 200,
      jitter: 20,
      sparse: 1,
    };
    const shadowScore = await upgradeSvc.scoreFor('gps', extreme, th);
    assert(!!shadowScore && shadowScore.stage === 1, 'scoreFor 在影子阶段返回有监督意见', shadowScore && shadowScore.stage);
    assert(
      shadowScore && shadowScore.risk < th.autoBan,
      `影子阶段风险分 ${shadowScore && shadowScore.risk.toFixed(3)} 严格低于自动封禁线 ${th.autoBan}`,
      { risk: shadowScore && shadowScore.risk, autoBan: th.autoBan }
    );
    assert(shadowScore && shadowScore.capped === true, '命中封顶时回传 capped 标记', shadowScore && shadowScore.capped);
    assert(shadowScore && shadowScore.prob > 0.9, '模型本身的作弊概率确实很高（证明是封顶在起作用，不是模型没判）', shadowScore && shadowScore.prob);

    // ==================== 6) 影子证据不足 → 不升主判 ====================
    console.log('\n[6] 影子证据不足 → 不升主判');
    r = await upgradeSvc.evaluateSource('gps', evalOpts);
    assert(r.stage === 1 && r.nextStage === 1, '原地停在影子阶段', { action: r.action, stage: r.stage });
    assert(
      r.missing.some((m) => /影子阶段/.test(m) || /驻留/.test(m)),
      '缺失项点明影子阶段的要求（驻留天数/证据条数）',
      r.missing
    );

    // ==================== 7) 影子精度掉线 → 自动降级 ====================
    console.log('\n[7] 影子实测精度掉线 → 自动降级');
    // 先把 stagedAt 回拨 5 天（跨过 minAgeHours=24 与 minAssistDwellDays=3）
    const past = new Date(Date.now() - 5 * 86400000);
    await mongoose.connection.db
      .collection('anticheat_model_states')
      .updateOne({ source: 'gps' }, { $set: { stagedAt: past } });
    upgradeSvc.invalidateStateCache();
    // 补一批「被判可疑但人工都判正常」的标注 → 实测精度 0% < 60%
    const badShadow = [];
    for (let i = 0; i < 16; i += 1) {
      badShadow.push(
        makeLabel({ cheat: false, discriminate: true, withShadow: true, prob: 0.95, score: 0.95, i: 900 + i })
      );
    }
    await StepLabel.insertMany(badShadow);
    upgradeSvc.invalidateStateCache();
    r = await upgradeSvc.evaluateSource('gps', evalOpts);
    assert(r.action === 'demote', '实测精度掉线 → 自动降级', { action: r.action, reason: r.reason });
    const sDown = await upgradeSvc.getState('gps');
    assert(sDown.stage === 0, '降回阶段 0（无监督）', { stage: sDown.stage });
    // 主判阶段绝不能被自动进入过
    assert(sDown.stage < 2, '全程没有被自动升到主判（证据不足时绝不放开封号权）', { stage: sDown.stage });

    // ==================== 8) 手动锁定 ====================
    console.log('\n[8] 手动指定阶段 / 解除锁定');
    const man = await upgradeSvc.manualSetStage('gps', 1, { operator: 'verify', note: '人工确认' });
    assert(man.to === 1 && man.mode === 'manual', '手动指定为影子辅助并锁定', man);
    upgradeSvc.invalidateStateCache();
    const sMan = await upgradeSvc.getState('gps');
    assert(sMan.mode === 'manual', '状态记为手动锁定', sMan.mode);
    assert(
      (sMan.history || []).some((h) => h.operator === 'verify' && /手动/.test(h.reason || '')),
      '手动操作进历史（可追责）',
      sMan.history && sMan.history.slice(-1)
    );
    // 手动锁定期间自动评估不得改阶段（哪怕降级条件成立）
    r = await upgradeSvc.evaluateSource('gps', evalOpts);
    assert(r.action === 'hold' && r.stage === 1, '手动锁定后自动评估只写建议、不改阶段', { action: r.action, stage: r.stage });
    const rel = await upgradeSvc.releaseManual('gps', { operator: 'verify' });
    assert(rel.mode === 'auto', '解除锁定回到自动', rel);
    upgradeSvc.invalidateStateCache();
    assert((await upgradeSvc.getState('gps')).mode === 'auto', '库里的 mode 也是 auto', 'mode');

    // ==================== 9) 关闭 autoUpgrade 不动阶段 ====================
    console.log('\n[9] 自动升级开关关闭时不动阶段（评估照跑）');
    // 清掉坏影子证据，让「该升级」条件重新成立
    await StepLabel.deleteMany({ openid: new RegExp(`^${TAG}_9`) });
    const cfgDoc = await GoalConfig.getSingleton();
    cfgDoc.anticheat.autoUpgrade = false;
    cfgDoc.anticheat.autoDemote = false;
    await cfgDoc.save();
    await ModelState.deleteOne({ source: 'gps' });
    upgradeSvc.invalidateStateCache();
    r = await upgradeSvc.evaluateSource('gps', { ...evalOpts, allowPromote: false, allowDemote: false });
    assert(r.action === 'hold' && r.nextStage === 0, '开关关闭 → 不升级（但评估确实跑完了）', { action: r.action });
    assert(r.metrics && r.metrics.auc != null, '指标照样更新（关的是"自动动阶段"，不是评估）', r.metrics && r.metrics.auc);
    cfgDoc.anticheat.autoUpgrade = true;
    cfgDoc.anticheat.autoDemote = true;
    await cfgDoc.save();

    // ==================== 10) 旧标注不计入影子证据 ====================
    console.log('\n[10] 旧标注（无 modelStage）不计入影子证据');
    const legacy = [];
    for (let i = 0; i < 30; i += 1) {
      const l = makeLabel({ cheat: i % 2 === 0, discriminate: true, i: 500 + i });
      l.modelStage = 0;
      l.supervisedProb = null;
      l.supervisedScore = null;
      legacy.push(l);
    }
    const stats = upgradeSvc.shadowStats(legacy, th);
    assert(stats.samples === 0 && stats.flaggedSuspicious === 0, '没有 modelStage 的标注不算影子证据（不猜）', stats);

    // ==================== 11) 判定链路真接入 ====================
    console.log('\n[11] 判定链路接入 evaluate');
    // 造出一个「影子阶段 + 模型」的状态
    await ModelState.deleteOne({ source: 'gps' });
    await StepLabel.deleteMany({ openid: new RegExp(`^${TAG}`) });
    await StepLabel.insertMany(makeSamples(80, true));
    upgradeSvc.invalidateStateCache();
    await upgradeSvc.evaluateSource('gps', evalOpts);
    upgradeSvc.invalidateStateCache();
    const sCheck = await upgradeSvc.getState('gps');
    assert(sCheck.stage === 1, '（前置）已进入影子阶段', sCheck.stage);
    const evaled = await acModel.evaluate('gps', {
      distance: 5000,
      durationSeconds: 200,
      routePoints: [
        { latitude: 30, longitude: 120, timestamp: 0 },
        { latitude: 30.01, longitude: 120.01, timestamp: 20000 },
      ],
    });
    assert(!!evaled.supervised, 'evaluate 回传有监督意见（判定链路真的接上了）', evaled.supervised);
    assert(evaled.modelStage === 1, 'evaluate 回传 modelStage=1', evaled.modelStage);
    assert(
      evaled.reasons.some((x) => /影子模型/.test(x)),
      '理由里写明是影子模型（管理员知道它还不能封号）',
      evaled.reasons
    );
    assert(
      evaled.supervised.risk < acModel.currentThreshold().autoBan,
      '影子阶段风险分低于封禁线',
      { risk: evaled.supervised.risk, autoBan: acModel.currentThreshold().autoBan }
    );

    // 主判阶段：风险分可以越过封禁线（但要不要真的封仍由「自动处置总开关」决定）
    await upgradeSvc.manualSetStage('gps', 2, { operator: 'verify', note: '验证主判' });
    upgradeSvc.invalidateStateCache();
    const primaryScore = await upgradeSvc.scoreFor('gps', {
      paceSecPerKm: 150,
      speed: 20,
      distance: 5000,
      duration: 250,
      pointCount: 400,
      gapAvg: 5000,
      gapMax: 60000,
      jitter: 8,
      sparse: 12,
    }, acModel.currentThreshold());
    assert(!!primaryScore && primaryScore.stage === 2, '主判阶段 scoreFor 返回 stage 2', primaryScore && primaryScore.stage);
    assert(
      primaryScore && primaryScore.capped === false && primaryScore.risk >= primaryScore.rawRisk,
      '主判阶段不再封顶',
      primaryScore
    );
    const evaledPrimary = await acModel.evaluate('gps', { distance: 5000, durationSeconds: 250, routePoints: [] });
    assert(
      evaledPrimary.reasons.some((x) => /有监督模型判定作弊概率/.test(x)),
      '主判阶段理由文案切换为「有监督模型」',
      evaledPrimary.reasons
    );
  } catch (e) {
    console.error('ERR', e.stack);
    failed += 1;
  } finally {
    // ==================== 12) 清理核对 ====================
    console.log('\n[12] 清理核对');
    await StepLabel.deleteMany({ openid: new RegExp(`^${TAG}`) });
    await StepAnomaly.deleteMany({ openid: new RegExp(`^${TAG}`) });
    await User.deleteMany({ openid: new RegExp(`^${TAG}`) });
    await ModelState.deleteMany({});
    if (backupStates.length) {
      // 恢复真实现场：去掉 _id/__v 让 Mongo 自己生成（否则会被 deleteMany 后的空表接受，但 _id 冲突）
      const clean = backupStates.map((d) => {
        const o = { ...d };
        delete o._id;
        delete o.__v;
        return o;
      });
      if (clean.length) await ModelState.insertMany(clean, { ordered: false }).catch(() => {});
    }
    const cfgRestore = await GoalConfig.getSingleton();
    cfgRestore.anticheat.autoUpgrade = backupAc.autoUpgrade !== false;
    cfgRestore.anticheat.autoDemote = backupAc.autoDemote !== false;
    cfgRestore.anticheat.enabled = backupAc.enabled !== false;
    await cfgRestore.save();
    upgradeSvc.invalidateStateCache();

    const leftLabels = await StepLabel.countDocuments({ openid: new RegExp(`^${TAG}`) });
    const leftAnomalies = await StepAnomaly.countDocuments({ openid: new RegExp(`^${TAG}`) });
    const leftUsers = await User.countDocuments({ openid: new RegExp(`^${TAG}`) });
    assert(leftLabels === 0 && leftAnomalies === 0 && leftUsers === 0, '临时数据残留为 0', { leftLabels, leftAnomalies, leftUsers });
    const restored = await ModelState.find({}).lean();
    assert(
      restored.length === backupStates.length,
      `真实状态文档已恢复（${restored.length}/${backupStates.length}）`,
      restored.map((x) => x.source)
    );
    await mongoose.disconnect();
  }

  console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 阶段性自升级全流程通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.stack);
  process.exit(1);
});
