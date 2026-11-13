/**
 * 唐跑AI数据模型 · **阶段性自升级**（用户 2026-11-12「可以升级了，后端中的已经有很多数据了，
 * 请增加阶段性自升级」）。
 *
 * ===== 这个文件解决什么问题 =====
 * 上一版只有一个「标注攒够了，可以升级为有监督模型」的**提示**（anticheat-model.js 的
 * checkUpgradeReadiness），升级动作要人工改代码 —— 而现网标注已经攒到 248 条（2026-11-12 实测），
 * 提示一直是「可以升级」，但没有任何东西会真的升。等于这个能力永远躺在代码里。
 *
 * 本文件把它做成**有台阶、有验证、可回退**的自动过程：
 *
 *   阶段 0 `unsupervised` 无监督（Isolation Forest 独立判定）—— 历史行为，默认
 *   阶段 1 `assist`       有监督影子辅助：分数参与，但**封顶在自动封禁线以下**，
 *                         最多把记录推进待研判队列。同时把「当时的模型概率」记进标注，
 *                         用来积累影子证据。
 *   阶段 2 `primary`      有监督主判：风险分可越过自动封禁线（仍受「自动处置总开关」约束）。
 *
 * 每一级晋升都必须过**量化闸门**（GATES）：样本量、类别平衡、验证集 AUC、
 * 操作点精度/召回、影子阶段的实测精度、驻留时长。任何一项不达标就原地不动，
 * 并把「还差什么」写成中文句子给管理端（`missing`）。
 *
 * ===== 三条硬约束（改这个文件前必读）=====
 *
 * ① **影子阶段（assist）绝不允许封号**。新模型上线最怕的不是漏判，是**成片误封** ——
 *    误封只能靠学生申诉才发现，而申诉链路有延迟。所以第一次上线只给「辅助」权力：
 *    分数封顶在当前自动封禁线以下（`capRisk`），只能把记录推进队列让人看。
 *    这与「涨幅速度」的护栏是同一个思路（见 tools/check-sync-rate.js）。
 *
 * ② **升级判断用验证集，不是训练集**。训练集准确率 95% 在小样本上毫无意义
 *    （模型可以纯粹记住样本）。本文件的时间/指标全部来自 `trainAndValidate` 的留出集，
 *    并按类别分层切分（作弊与正常各自留 30%）。
 *
 * ③ **降级必须能自动发生，且和升级走同一套证据**。模型会过时（作弊手法变了），
 *    影子阶段的实测精度掉到 `shadowPrecisionFloor` 以下就必须退一级 ——
 *    否则「自升级」会变成「单向棘轮」，只会越来越松。
 *
 * ===== 与 goal_config 的关系 =====
 * 自动升降开关在 `goal_config.anticheat.autoUpgrade / autoDemote`（默认都开）。
 * 关掉 autoUpgrade 后评估照常跑、指标照常更新，但**不改阶段**（管理端可看到建议后手动升）。
 * 管理员手动指定过阶段（`mode = 'manual'`）时，自动流程只写建议、绝不动阶段 ——
 * 否则「我刚手动压回去，半夜又被自动升上去了」。
 */
const ModelState = require('../models/anticheat-model-state');
const StepLabel = require('../models/step-label');
const supervise = require('./anticheat-supervised');

// ===========================================================================
// 阶段闸门（唯一口径，管理端 UI 与检查器都从这里读）
// ===========================================================================
/**
 * 每级晋升的门槛。
 *
 * 数字的来源不是拍的，而是对齐 `anticheat-model.js::UPGRADE_RULE`（200/40/80）后
 * 按「每个来源各自训练」拆出来的 —— 那个规则是**全校合计**的口径，
 * 而两个模型各吃自己的标注，所以每级的 minTrainable 明显低于 200。
 */
const GATES = {
  // 0 → 1：从「没有有监督模型」到「有个只能辅助的影子模型」
  assist: {
    minTrainable: 60, // 该来源的可训练标注（不含 device）
    minPositives: 15, // 作弊侧（cheat + minor）
    minNegatives: 30, // 正常
    minAuc: 0.65, // 交叉验证 AUC 均值；0.5 = 瞎猜
    // AUC 的折间标准差上限：均值够但波动大的模型不可信 ——
    // 实测 werun 的 AUC 是 0.63 ± 0.19（各折 0.41~0.98），这种模型等于没学到东西，
    // 只是碰巧在某几折上分对了。不设这条闸门就会「均值刚好压线 → 升级」。
    maxAucStd: 0.18,
    minPrecisionAtSuspicious: 0.5, // 推到「可疑」的那批里至少一半真是作弊
    minFeatures: 4, // 可训练特征数（太少没有区分力）
  },
  // 1 → 2：从「只能辅助」到「可以单独封号」—— 这一级最危险，门槛最严
  primary: {
    minTrainable: 120,
    minPositives: 25,
    minNegatives: 60,
    minAuc: 0.75,
    maxAucStd: 0.12,
    minPrecisionAtAutoBan: 0.9, // 按封禁线判出来的必须九成是真作弊（误封代价最大）
    minRecallAtAutoBan: 0.25, // 也不能为了精度什么都不抓
    minAssistDwellDays: 3, // 在影子阶段至少待够 3 天（跑过真实流量）
    minShadowSamples: 20, // 影子阶段攒到的人工标注
    minShadowFlagged: 10, // 其中被影子模型判为可疑/封禁的数量
    minShadowPrecision: 0.8, // 影子期间实测精度（人工确认作弊的比例）
  },
};

/** 降级闸门：证据掉到这个程度就退一级（比升级闸门宽松，但必须有最小样本量） */
const DEMOTE = {
  minShadowFlagged: 10,
  shadowPrecisionFloor: 0.6,
  minAuc: 0.6,
  // 刚升级的 24 小时内不降级：新模型需要一点真实流量才能形成有效证据
  minAgeHours: 24,
};

const STAGES = ['unsupervised', 'assist', 'primary'];
const STAGE_TEXT = { unsupervised: '无监督', assist: '影子辅助', primary: '有监督主判' };
const STAGE_DESC = {
  unsupervised: 'Isolation Forest 只看「像不像异常」，不需要标注；判定独立生效',
  assist: '有监督模型参与打分，但分数封顶在自动封禁线以下 —— 只能把记录推进待研判，绝不单独封号',
  primary: '有监督模型主判，分数可越过自动封禁线（仍受「自动处置」总开关约束）',
};

// 进程内缓存：同步链路每次判定都要读状态，不能每次查库。
// 阶段变化是低频事件，60 秒的滞后完全可以接受（管理端手动改阶段会主动失效）。
const CACHE_TTL_MS = 60 * 1000;
const stateCache = { at: 0, bySource: {} };
const EVAL_LOCK = { werun: null, gps: null };

function nowMs() {
  return Date.now();
}

function invalidateStateCache() {
  stateCache.at = 0;
}

/**
 * 确保状态文档存在（首次评估前库里没有任何一条）。
 *
 * 为什么要单独一步：CAS 更新用的是 `findOneAndUpdate({source, stateVersion: N})`，
 * 文档不存在时过滤器匹配不到任何东西 —— 直接加 upsert 会与 `$inc: {stateVersion}` 冲突
 * （upsert 试图把过滤器里的 stateVersion=0 与 $inc 后的 1 同时写进新文档）。
 * 所以先幂等建一条默认文档，再做 CAS。真实踩过：不加这一步，第一次评估永远返回 'raced'。
 */
async function ensureState(source) {
  await ModelState.updateOne(
    { source },
    {
      $setOnInsert: {
        source,
        stage: 0,
        stageKey: 'unsupervised',
        mode: 'auto',
        stateVersion: 0,
      },
    },
    { upsert: true }
  );
}

/**
 * 读状态（带缓存）。不存在时**返回默认阶段 0 的对象而不是 null** ——
 * 这样调用方不用到处判空，且「没记录过」与「记录过但停在第 0 阶段」行为一致。
 */
async function getState(source) {
  const src = source === 'gps' ? 'gps' : 'werun';
  if (stateCache.at && nowMs() - stateCache.at < CACHE_TTL_MS && Object.prototype.hasOwnProperty.call(stateCache.bySource, src)) {
    return stateCache.bySource[src];
  }
  let doc = null;
  try {
    doc = await ModelState.findOne({ source: src }).lean();
  } catch (e) {
    doc = null; // 库不可用 → 退回阶段 0（反作弊不能因状态表故障而整体失灵）
  }
  const plain = doc
    ? { ...doc, _id: String(doc._id) }
    : {
        source: src,
        stage: 0,
        stageKey: 'unsupervised',
        mode: 'auto',
        stateVersion: 0,
        model: null,
        metrics: null,
        coverage: [],
        sampleCount: 0,
        trainedAt: null,
        stagedAt: null,
        lastEvaluatedAt: null,
        lastReason: '',
        lastMissing: [],
        history: [],
      };
  stateCache.bySource[src] = plain;
  stateCache.at = nowMs();
  return plain;
}

async function getStates() {
  return { werun: await getState('werun'), gps: await getState('gps') };
}

// ===========================================================================
// 训练数据
// ===========================================================================
/**
 * 拉某来源的可训练标注（含特征快照）。
 *
 * ⚠️ features 必须一起取：训练用的就是判定当下的特征向量，
 *   「用当前 run_records 重算特征」会得到与标注时刻不一致的样本（时间点错位）。
 *   step-label.js 里那句「必须存特征快照，否则这批标注再也无法参与训练」说的就是这里。
 *
 * @param {'werun'|'gps'} source
 * @param {{sampleQuery?: object}} [opts]
 *   sampleQuery：**只给检查器/回测用**的额外筛选（例如「只看某个临时标签前缀的样本」）。
 *   生产路径（evaluateSource / snapshotSource）永远不传它 —— 那样会训出「半个训练集」的模型。
 */
async function loadSamples(source, opts = {}) {
  const src = source === 'gps' ? 'gps' : 'werun';
  const base = {
    source: src,
    $or: [{ label: { $in: StepLabel.TRAINABLE_LABELS } }, { label: null, isCheat: { $exists: true } }],
  };
  // 额外筛选并进 $and（不收进 base.$or，否则会与「可训练类别」这个 $or 互相覆盖）
  const query = opts.sampleQuery ? { $and: [base, opts.sampleQuery] } : base;
  const rows = await StepLabel.find(query)
    .sort({ createdAt: -1 })
    .limit(5000)
    .select('label isCheat features modelStage supervisedProb supervisedScore createdAt')
    .lean();
  return rows
    .map((r) => {
      // 旧数据 label=null → 按 isCheat 兜底（迁移期兼容，不猜 rule/AI）
      const label = StepLabel.LABEL_KINDS.includes(r.label) ? r.label : r.isCheat ? 'cheat' : 'normal';
      return {
        label,
        features: r.features || null,
        weight: StepLabel.TRAIN_WEIGHTS[label] == null ? 1 : StepLabel.TRAIN_WEIGHTS[label],
        modelStage: Number(r.modelStage) || 0,
        supervisedProb: r.supervisedProb == null ? null : Number(r.supervisedProb),
        supervisedScore: r.supervisedScore == null ? null : Number(r.supervisedScore),
        at: r.createdAt ? new Date(r.createdAt).getTime() : 0,
      };
    })
    .filter((s) => s.label !== 'device'); // device 不进训练集（见 step-label.js 文件头）
}

/**
 * 影子证据：只看「有监督模型已经在跑」的那段时间产生的标注。
 * 这是最可信的证据 —— 它不是留出集，而是模型在真实流量上被人工复核的结果。
 */
function shadowStats(samples, thresholds) {
  const live = (samples || []).filter((s) => s.modelStage >= 1 && s.supervisedScore != null);
  const suspLine = Number(thresholds && thresholds.suspicious) || 0.62;
  const banLine = Number(thresholds && thresholds.autoBan) || 0.78;
  const flaggedSusp = live.filter((s) => Number(s.supervisedScore) >= suspLine);
  const flaggedBan = live.filter((s) => Number(s.supervisedScore) >= banLine);
  const cheatSide = (arr) => arr.filter((s) => s.label === 'cheat' || s.label === 'minor').length;
  const prec = (arr) => (arr.length ? cheatSide(arr) / arr.length : null);
  return {
    samples: live.length,
    positives: cheatSide(live),
    flaggedSuspicious: flaggedSusp.length,
    precisionSuspicious: prec(flaggedSusp),
    flaggedAutoBan: flaggedBan.length,
    precisionAutoBan: prec(flaggedBan),
  };
}

// ===========================================================================
// 闸门判断
// ===========================================================================
const pct = (v) => Math.round((Number(v) || 0) * 100);
const num1 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 1000) / 1000);

/**
 * 判断「能不能从 stage 进到 stage+1」。
 * @returns {{ok:boolean, missing:string[], gates:object, detail:object}}
 */
function checkPromotion(target, ctx) {
  const missing = [];
  const { gates, metrics, coverage, samples, shadow, stage, stagedAt } = ctx;
  const positives = (samples || []).filter((s) => s.label === 'cheat' || s.label === 'minor').length;
  const negatives = (samples || []).filter((s) => s.label === 'normal').length;
  const usableFeatures = (coverage || []).filter((c) => c.used).length;

  const need = (cond, text) => {
    if (!cond) missing.push(text);
  };

  if (target === 'assist') {
    const g = GATES.assist;
    need(samples.length >= g.minTrainable, `该来源可训练标注还差 ${Math.max(0, g.minTrainable - samples.length)} 条（现 ${samples.length}，需 ${g.minTrainable}）`);
    need(positives >= g.minPositives, `作弊类标注还差 ${Math.max(0, g.minPositives - positives)} 条（现 ${positives}，需 ${g.minPositives}）`);
    need(negatives >= g.minNegatives, `正常类标注还差 ${Math.max(0, g.minNegatives - negatives)} 条（现 ${negatives}，需 ${g.minNegatives}）`);
    need(usableFeatures >= g.minFeatures, `可训练特征只有 ${usableFeatures} 个（需 ${g.minFeatures} 个；旧标注缺新特征会导致某些维度用不上）`);
    const auc = num1(metrics && metrics.auc);
    need(auc != null && auc >= g.minAuc, `交叉验证 AUC 均值 ${auc == null ? '—' : auc} 低于 ${g.minAuc}（模型排序能力不足）`);
    const aucStd = num1(metrics && metrics.aucStd);
    need(aucStd == null || aucStd <= g.maxAucStd, `各折 AUC 波动 ${aucStd == null ? '—' : aucStd} 超过 ${g.maxAucStd}（模型不稳定，换一批数据就判得不一样）`);
    const prec = num1(metrics && metrics.precisionAtSuspicious);
    need(prec != null && prec >= g.minPrecisionAtSuspicious, `可疑线精度 ${prec == null ? '—' : pct(prec) + '%'} 低于 ${pct(g.minPrecisionAtSuspicious)}%`);
  }

  if (target === 'primary') {
    const g = GATES.primary;
    need(stage === 1, '必须先经过影子辅助阶段');
    const dwellDays = stagedAt ? (nowMs() - new Date(stagedAt).getTime()) / 86400000 : 0;
    need(dwellDays >= g.minAssistDwellDays, `影子阶段驻留 ${dwellDays.toFixed(1)} 天，需满 ${g.minAssistDwellDays} 天`);
    need(samples.length >= g.minTrainable, `该来源可训练标注还差 ${Math.max(0, g.minTrainable - samples.length)} 条（现 ${samples.length}，需 ${g.minTrainable}）`);
    need(positives >= g.minPositives, `作弊类标注还差 ${Math.max(0, g.minPositives - positives)} 条（现 ${positives}，需 ${g.minPositives}）`);
    need(negatives >= g.minNegatives, `正常类标注还差 ${Math.max(0, g.minNegatives - negatives)} 条（现 ${negatives}，需 ${g.minNegatives}）`);
    const auc = num1(metrics && metrics.auc);
    need(auc != null && auc >= g.minAuc, `交叉验证 AUC 均值 ${auc == null ? '—' : auc} 低于 ${g.minAuc}`);
    const aucStd2 = num1(metrics && metrics.aucStd);
    need(aucStd2 == null || aucStd2 <= g.maxAucStd, `各折 AUC 波动 ${aucStd2 == null ? '—' : aucStd2} 超过 ${g.maxAucStd}（模型不稳定）`);
    const precBan = num1(metrics && metrics.precisionAtAutoBan);
    need(precBan != null && precBan >= g.minPrecisionAtAutoBan, `封禁线精度 ${precBan == null ? '—' : pct(precBan) + '%'} 低于 ${pct(g.minPrecisionAtAutoBan)}%`);
    const recallBan = num1(metrics && metrics.recallAtAutoBan);
    need(recallBan != null && recallBan >= g.minRecallAtAutoBan, `封禁线召回 ${recallBan == null ? '—' : pct(recallBan) + '%'} 低于 ${pct(g.minRecallAtAutoBan)}%`);
    // 影子证据：模型真的在真实流量上被人工复核过
    need((shadow.samples || 0) >= g.minShadowSamples, `影子阶段标注还差 ${Math.max(0, g.minShadowSamples - (shadow.samples || 0))} 条（现 ${shadow.samples || 0}，需 ${g.minShadowSamples}）`);
    need((shadow.flaggedSuspicious || 0) >= g.minShadowFlagged, `影子阶段被模型判为可疑的记录还差 ${Math.max(0, g.minShadowFlagged - (shadow.flaggedSuspicious || 0))} 条（需 ${g.minShadowFlagged}）`);
    const sp = num1(shadow.precisionSuspicious);
    need(sp != null && sp >= g.minShadowPrecision, `影子阶段实测精度 ${sp == null ? '—' : pct(sp) + '%'} 低于 ${pct(g.minShadowPrecision)}%`);
  }

  return {
    ok: missing.length === 0,
    missing,
    gates: target === 'assist' ? { ...GATES.assist } : { ...GATES.primary },
    detail: { positives, negatives, usableFeatures, shadow, dwellDays: stagedAt ? Math.round(((nowMs() - new Date(stagedAt).getTime()) / 86400000) * 10) / 10 : 0 },
  };
}

/**
 * 判断「要不要从当前阶段退一级」。
 * 只吃**影子/主判期间**的真实标注（训练集指标不能用来判断线上表现）。
 */
function checkDemotion(ctx) {
  const { stage, metrics, shadow, stagedAt } = ctx;
  if (stage <= 0) return { demote: false, reason: '', missing: [] };
  const ageHours = stagedAt ? (nowMs() - new Date(stagedAt).getTime()) / 3600000 : 0;
  if (ageHours < DEMOTE.minAgeHours) {
    return { demote: false, reason: '', missing: [`当前阶段仅 ${ageHours.toFixed(1)} 小时，需满 ${DEMOTE.minAgeHours} 小时才评估降级`] };
  }
  const auc = num1(metrics && metrics.auc);
  const prec = num1(shadow.precisionSuspicious);
  const flagged = shadow.flaggedSuspicious || 0;

  if (auc != null && auc < DEMOTE.minAuc) {
    return { demote: true, reason: `交叉验证 AUC ${auc} 低于 ${DEMOTE.minAuc}，模型已失去区分力`, missing: [] };
  }
  if (flagged >= DEMOTE.minShadowFlagged && prec != null && prec < DEMOTE.shadowPrecisionFloor) {
    return {
      demote: true,
      reason: `线上实测精度 ${pct(prec)}% 低于 ${pct(DEMOTE.shadowPrecisionFloor)}%（${flagged} 条被判可疑/封禁，人工确认作弊 ${pct(prec)}%）`,
      missing: [],
    };
  }
  return {
    demote: false,
    reason: '',
    missing: flagged < DEMOTE.minShadowFlagged ? [`降级评估需攒够 ${DEMOTE.minShadowFlagged} 条被判可疑的线上标注（现 ${flagged} 条）`] : [],
  };
}

// ===========================================================================
// 评估（训练 → 判定晋升/降级 → CAS 写库）
// ===========================================================================
/**
 * 评估一个来源。
 *
 * @param {'werun'|'gps'} source
 * @param {{operator?:string, force?:boolean, dryRun?:boolean, allowPromote?:boolean, allowDemote?:boolean, sampleQuery?:object}} [opts]
 *   dryRun=true 只算不写（管理端「立即评估」预览用；也用于检查器）
 *   sampleQuery 只给检查器/回测用（限定样本集合），生产路径不传
 */
async function evaluateSource(source, opts = {}) {
  const src = source === 'gps' ? 'gps' : 'werun';
  if (EVAL_LOCK[src]) return EVAL_LOCK[src]; // 并发保护：同一来源同时只跑一次训练
  EVAL_LOCK[src] = (async () => {
    // ⚠️ 惰性 require：anticheat-model 也 require 本文件（evaluate 要问有监督意见），
    //   顶层互相 require 会成环。函数内取用是安全的。
    const acModel = require('./anticheat-model');
    // 特征顺序的唯一来源仍是 anticheat-model（WERUN_ORDER / GPS_ORDER）：
    // 训练与推理必须共用同一份，另写一份必然在某次改特征时静默错位。
    const order = src === 'werun' ? acModel.WERUN_ORDER : acModel.GPS_ORDER;
    const thresholds = acModel.currentThreshold();

    const state = await getState(src);
    const samples = await loadSamples(src, { sampleQuery: opts.sampleQuery });
    const trained = supervise.trainAndValidate(samples, { order });
    const metrics = (trained && trained.metrics) || null;
    const coverage = (trained && trained.coverage) || [];
    const model = trained && trained.model ? trained.model : null;
    const shadow = shadowStats(samples, thresholds);
    const stage = Number(state.stage) || 0;
    const ctx = { gates: null, metrics, coverage, samples, shadow, stage, stagedAt: state.stagedAt };

    // ---- 晋升判断（只在有模型时） ----
    let promoteTo = null;
    let promotion = { ok: false, missing: [] };
    if (model && stage < 2) {
      const target = stage === 0 ? 'assist' : 'primary';
      promotion = checkPromotion(target, ctx);
      if (promotion.ok) promoteTo = target;
    }
    if (!model && stage < 2) {
      promotion = { ok: false, missing: [(trained && trained.metrics && trained.metrics.reason) || '样本不足，无法训练有监督模型'] };
    }

    // ---- 降级判断 ----
    const demotion = checkDemotion({ ...ctx, stagedAt: state.stagedAt });

    // ---- 决定本次动作 ----
    const mode = state.mode === 'manual' ? 'manual' : 'auto';
    let nextStage = stage;
    let action = 'hold';
    let reason = '';
    const allowPromote = opts.allowPromote !== false && mode === 'auto';
    const allowDemote = opts.allowDemote !== false && mode === 'auto';

    if (allowDemote && demotion.demote) {
      nextStage = Math.max(0, stage - 1);
      action = 'demote';
      reason = demotion.reason;
    } else if (allowPromote && promoteTo) {
      nextStage = promoteTo === 'primary' ? 2 : 1;
      action = 'promote';
      reason = `达到${STAGE_TEXT[promoteTo]}闸门：${summarizePromotion(promoteTo, metrics, samples, shadow)}`;
    } else if (mode === 'manual') {
      action = 'hold';
      reason = '已手动指定阶段（自动评估只给建议，不改阶段）';
    } else {
      action = 'hold';
      reason = promotion.ok
        ? '已达下一阶段闸门，但自动升级开关关闭'
        : (promotion.missing[0] || '维持当前阶段');
    }

    const out = {
      source: src,
      stage,
      nextStage,
      action,
      reason,
      mode,
      missing: action === 'promote' || action === 'demote' ? [] : promotion.missing,
      metrics,
      coverage,
      shadow,
      sampleCount: samples.length,
      trainedAt: model ? new Date() : state.trainedAt,
      thresholds,
      // 模型本体只回摘要（完整权重只在管理端详情接口给，避免响应过大）
      modelSummary: model ? { features: model.features, operating: model.operating } : null,
      evaluatedAt: new Date(),
    };

    if (opts.dryRun) return out;

    // ---- 落库（CAS：抢输就放弃，不覆盖别人写的结果）----
    // 先确保文档存在（理由见 ensureState 注释：否则第一次评估永远匹配不到）
    try {
      await ensureState(src);
    } catch (e) {
      /* 建文档失败 → 下面的 CAS 会匹配不到，返回 raced；不影响判定 */
    }
    const set = {
      stage: nextStage,
      stageKey: STAGES[nextStage],
      lastEvaluatedAt: new Date(),
      lastReason: reason,
      lastMissing: out.missing,
      sampleCount: samples.length,
      coverage,
    };
    // 模型与指标**总是**更新（否则停在 0 阶段时管理端看不到「已经训出来了」）
    if (model) {
      set.model = model;
      set.metrics = metrics;
      set.trainedAt = new Date();
    } else if (metrics) {
      set.metrics = metrics; // 训练失败（样本不足）时也记下原因
    }
    if (nextStage !== stage) {
      set.stagedAt = new Date();
    }
    const update = { $set: set, $inc: { stateVersion: 1 } };
    if (nextStage !== stage) {
      update.$push = {
        history: {
          at: new Date(),
          from: stage,
          to: nextStage,
          reason: reason.slice(0, 500),
          operator: opts.operator || 'system',
          metrics: metrics
            ? { auc: metrics.auc, precisionAtAutoBan: metrics.precisionAtAutoBan, samples: metrics.samples, shadowPrecision: shadow.precisionSuspicious }
            : null,
        },
      };
    }
    const written = await ModelState.findOneAndUpdate(
      { source: src, stateVersion: state.stateVersion || 0 },
      update,
      { new: true }
    ).lean();
    invalidateStateCache();
    if (!written) {
      // 另一个进程刚刚写过：本次不重试（下一次评估自然基于新状态）
      return { ...out, action: 'raced', reason: '另一个进程刚刚完成了评估，本次结果不写入' };
    }
    if (nextStage !== stage) {
      console.log(`[anticheat-upgrade] ${src}: ${STAGES[stage]} → ${STAGES[nextStage]}（${reason}）`);
    }
    // 阶段变了 → 阈值基线没变，但「当前生效阶段」影响判定路径，清一下阈值缓存没意义，
    // 清状态缓存即可（已在上方 invalidateStateCache 做过）。
    return { ...out, persisted: true, stateVersion: (written && written.stateVersion) || 0 };
  })();
  try {
    return await EVAL_LOCK[src];
  } finally {
    EVAL_LOCK[src] = null;
  }
}

function summarizePromotion(target, metrics, samples, shadow) {
  const parts = [];
  if (metrics && metrics.auc != null) parts.push(`AUC ${num1(metrics.auc)}`);
  if (target === 'assist') {
    parts.push(`样本 ${samples.length} 条`);
    if (metrics && metrics.precisionAtSuspicious != null) parts.push(`可疑线精度 ${pct(metrics.precisionAtSuspicious)}%`);
  } else {
    if (metrics && metrics.precisionAtAutoBan != null) parts.push(`封禁线精度 ${pct(metrics.precisionAtAutoBan)}%`);
    if (shadow && shadow.flaggedSuspicious) parts.push(`影子实测 ${shadow.flaggedSuspicious} 条/精度 ${pct(shadow.precisionSuspicious)}%`);
  }
  return parts.join(' · ') || '闸门全部通过';
}

/** 两个来源一起评估（定时任务与管理端「立即评估」用） */
async function evaluateAll(opts = {}) {
  const out = [];
  for (const src of ['werun', 'gps']) {
    try {
      out.push(await evaluateSource(src, opts));
    } catch (e) {
      out.push({ source: src, action: 'error', reason: e.message || '评估失败' });
    }
  }
  return out;
}

// ===========================================================================
// 判定链路的接入点
// ===========================================================================
/**
 * 取「有监督模型对这条数据的意见」。
 *
 * 返回 null 表示没有可用模型（阶段 0 / 未训练），调用方按无监督结果走。
 *
 * @param {'werun'|'gps'} source
 * @param {object} features 该来源的特征对象（与训练同源，见 anticheat-model 的特征函数）
 * @param {{suspicious:number, autoBan:number}} thresholds 当前生效阈值
 * @returns {Promise<null|{stage:number, stageKey:string, prob:number, risk:number, capped:boolean}>}
 */
async function scoreFor(source, features, thresholds) {
  const src = source === 'gps' ? 'gps' : 'werun';
  let state;
  try {
    state = await getState(src);
  } catch (e) {
    return null;
  }
  if (!state || !state.model || Number(state.stage) <= 0) return null;
  let prob;
  try {
    prob = supervise.predictProbability(state.model, features);
  } catch (e) {
    return null;
  }
  if (prob == null || !Number.isFinite(prob)) return null;
  const risk = supervise.mapToRisk(prob, state.model, thresholds);
  const stage = Number(state.stage) || 0;
  // 影子阶段封顶（见文件头约束 ①）：**必须低于当前自动封禁线**，
  // 这样无论模型多自信都不可能单独触发封号。
  const cap = Math.max(0.3, (Number(thresholds && thresholds.autoBan) || 0.78) - 0.02);
  const finalRisk = stage === 1 ? Math.min(risk, cap) : risk;
  return {
    stage,
    stageKey: STAGES[stage],
    prob,
    risk: Number(finalRisk.toFixed(6)),
    capped: stage === 1 && risk > finalRisk,
    rawRisk: Number(risk.toFixed(6)),
  };
}

/** 给管理端展示「这条记录当时的有监督概率」时的阶段文案 */
function stageText(stage) {
  return STAGE_TEXT[STAGES[Number(stage) || 0]] || STAGE_TEXT.unsupervised;
}

// ===========================================================================
// 管理端动作（手动指定阶段 = 人工兜底，全部留审计）
// ===========================================================================
/**
 * 手动设定阶段（行为与限制）：
 *   · 只允许在同一来源上设定 0/1/2；
 *   · 写 mode='manual'，自动评估从此只写建议 —— 否则「手动压回去，半夜又被自动升上来」；
 *   · 写 history（operator + note），可追溯「谁在什么时候把它按下去的」；
 *   · 升到 primary 时**不再要求闸门**（人已经看过指标并决定负责），
 *     但历史里会记下当时的指标快照，事后可复核。
 */
async function manualSetStage(source, stage, { operator = '', note = '' } = {}) {
  const src = source === 'gps' ? 'gps' : 'werun';
  const target = Math.max(0, Math.min(2, Number(stage) || 0));
  const state = await getState(src);
  const from = Number(state.stage) || 0;
  const written = await ModelState.findOneAndUpdate(
    { source: src },
    {
      $set: {
        stage: target,
        stageKey: STAGES[target],
        mode: 'manual',
        stagedAt: target === from ? state.stagedAt || null : new Date(),
        lastReason: `管理员手动指定为${STAGE_TEXT[STAGES[target]]}${note ? '：' + note : ''}`,
      },
      $inc: { stateVersion: 1 },
      $push: {
        history: {
          at: new Date(),
          from,
          to: target,
          reason: `管理员手动指定${note ? '：' + String(note).slice(0, 200) : ''}`,
          operator: operator || 'admin',
          metrics: state.metrics ? { auc: state.metrics.auc, samples: state.metrics.samples } : null,
        },
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  invalidateStateCache();
  return { source: src, from, to: target, mode: 'manual', state: written };
}

/** 解除手动锁定：回到自动评估（下一次评估周期就会按闸门重新决定） */
async function releaseManual(source, { operator = '', note = '' } = {}) {
  const src = source === 'gps' ? 'gps' : 'werun';
  const state = await getState(src);
  await ModelState.findOneAndUpdate(
    { source: src },
    {
      $set: { mode: 'auto', lastReason: `解除手动锁定${note ? '：' + note : ''}` },
      $inc: { stateVersion: 1 },
      $push: {
        history: {
          at: new Date(),
          from: Number(state.stage) || 0,
          to: Number(state.stage) || 0,
          reason: `解除手动锁定${note ? '：' + String(note).slice(0, 200) : ''}`,
          operator: operator || 'admin',
          metrics: null,
        },
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  invalidateStateCache();
  return { source: src, mode: 'auto' };
}

// ===========================================================================
// 管理端快照
// ===========================================================================
/**
 * 一个来源的完整阶段快照（管理端「唐跑AI数据模型」卡片直接渲染这份，前端不做二次计算）。
 *
 * 展示字段全部在这里算好：stageText / stageDesc / 阶梯（三级各自的完成度与状态）/
 * nextMissing / metricsText / historyText，避免 Web 台与小程序各写一份文案后漂移。
 */
async function snapshotSource(source) {
  const src = source === 'gps' ? 'gps' : 'werun';
  const acModel = require('./anticheat-model');
  const state = await getState(src);
  const thresholds = acModel.currentThreshold();
  const stage = Number(state.stage) || 0;
  const samples = await loadSamples(src);
  const shadow = shadowStats(samples, thresholds);
  const metrics = state.metrics || null;
  const coverage = Array.isArray(state.coverage) ? state.coverage : [];

  // 下一阶段缺什么（复用与自动评估**同一个**函数：两处各写一套必然出现
  // 「页面说还差 5 条、系统却不升」这种自相矛盾）
  const target = stage === 0 ? 'assist' : stage === 1 ? 'primary' : null;
  let next = null;
  if (target) {
    const chk = checkPromotion(target, {
      metrics,
      coverage,
      samples,
      shadow,
      stage,
      stagedAt: state.stagedAt,
    });
    next = {
      target,
      targetText: STAGE_TEXT[target],
      ok: chk.ok,
      missing: chk.missing,
      gates: chk.gates,
      detail: chk.detail,
    };
  }
  const demoteChk = checkDemotion({ stage, metrics, shadow, stagedAt: state.stagedAt });

  const ladder = [
    {
      stage: 0,
      key: 'unsupervised',
      text: STAGE_TEXT.unsupervised,
      desc: STAGE_DESC.unsupervised,
      done: stage >= 1,
      current: stage === 0,
    },
    {
      stage: 1,
      key: 'assist',
      text: STAGE_TEXT.assist,
      desc: STAGE_DESC.assist,
      done: stage >= 2,
      current: stage === 1,
    },
    {
      stage: 2,
      key: 'primary',
      text: STAGE_TEXT.primary,
      desc: STAGE_DESC.primary,
      done: false,
      current: stage === 2,
    },
  ];

  return {
    source: src,
    sourceText: src === 'gps' ? 'GPS 实跑' : '微信同步',
    stage,
    stageKey: STAGES[stage],
    stageText: STAGE_TEXT[STAGES[stage]],
    stageDesc: STAGE_DESC[STAGES[stage]],
    mode: state.mode || 'auto',
    modeText: state.mode === 'manual' ? '手动锁定' : '自动',
    ladder,
    // 阈值：有监督模型的分数锚定到这两条线（与无监督同一量纲）
    threshold: { suspicious: Number(thresholds.suspicious), autoBan: Number(thresholds.autoBan) },
    sampleCount: samples.length,
    trainableCount: samples.length,
    shadow,
    coverage: coverage.map((c) => ({ key: c.key, percent: Math.round((Number(c.ratio) || 0) * 100), used: !!c.used })),
    coverageText: coverage.length
      ? coverage.filter((c) => !c.used).map((c) => c.key).join('、') || '全部特征均可用'
      : '尚未训练',
    model: state.model
      ? {
          features: state.model.features || [],
          featureCount: (state.model.features || []).length,
          operating: state.model.operating || null,
          trainedAt: state.trainedAt || null,
          trainedText: state.trainedAt ? new Date(state.trainedAt).toISOString() : '',
        }
      : null,
    metrics: metrics
      ? {
          ...metrics,
          aucText: metrics.auc == null ? '—' : Number(metrics.auc).toFixed(2),
          precisionSuspiciousText: metrics.precisionAtSuspicious == null ? '—' : pct(metrics.precisionAtSuspicious) + '%',
          precisionAutoBanText: metrics.precisionAtAutoBan == null ? '—' : pct(metrics.precisionAtAutoBan) + '%',
          recallAutoBanText: metrics.recallAtAutoBan == null ? '—' : pct(metrics.recallAtAutoBan) + '%',
        }
      : null,
    next,
    demotion: { willDemote: !!demoteChk.demote, reason: demoteChk.reason, missing: demoteChk.missing },
    stagedAt: state.stagedAt || null,
    stagedDays: state.stagedAt ? Math.round(((nowMs() - new Date(state.stagedAt).getTime()) / 86400000) * 10) / 10 : 0,
    lastEvaluatedAt: state.lastEvaluatedAt || null,
    lastReason: state.lastReason || '',
    lastMissing: state.lastMissing || [],
    history: (state.history || []).slice(-6).reverse().map((h) => ({
      at: h.at,
      from: Number(h.from) || 0,
      to: Number(h.to) || 0,
      fromText: stageText(h.from),
      toText: stageText(h.to),
      reason: h.reason || '',
      operator: h.operator || 'system',
    })),
  };
}

/** 两个来源 + 全局开关：Web 状态台与小程序配置页共用（文案与口径只有这一份） */
async function snapshot() {
  const GoalConfig = require('../models/goal-config');
  const cfg = await GoalConfig.getSingleton();
  const ac = (cfg && cfg.anticheat) || {};
  const [werun, gps] = await Promise.all([snapshotSource('werun'), snapshotSource('gps')]);
  return {
    autoUpgrade: ac.autoUpgrade !== false,
    autoDemote: ac.autoDemote !== false,
    autoDispose: ac.enabled !== false,
    sources: { werun, gps },
    // 有监督模型能不能独立封号：只有「主判 + 自动处置开启」才可能
    canAutoBan: {
      werun: werun.stage >= 2 && ac.enabled !== false,
      gps: gps.stage >= 2 && ac.enabled !== false,
    },
    ruleText:
      '阶段 0 无监督 → 阶段 1 影子辅助（分数封顶在自动封禁线以下，只进待研判）→ ' +
      '阶段 2 有监督主判（可越过自动封禁线，仍受自动处置总开关约束）。' +
      '每级晋升都要过样本量/类别平衡/留出集 AUC/精度闸门；线上精度掉线会自动降级。',
  };
}

// ===========================================================================
// 定时评估（阶段性自升级的「自动」那一半）
// ===========================================================================
// 为什么是 6 小时：标注是人工产生的，一天也就几十条，比训练耗时更重要的是
// 「别在数据几乎没变的时候反复重训」。管理端可以随时点「立即评估」。
const SCHED_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SCHED_INITIAL_DELAY_MS = 60 * 1000;
let schedTimer = null;

/**
 * 启动定时评估。**刻意放在 index.js 的 listen() 之后**（不是 createApp）：
 *   · 检查器/演示脚本会 createApp 起临时服务，不该顺带跑训练；
 *   · NODE_ENV=test 时直接不启动（测试里显式调用 evaluateSource 更可控）。
 */
function startScheduler({ intervalMs = SCHED_INTERVAL_MS, initialDelayMs = SCHED_INITIAL_DELAY_MS } = {}) {
  if (schedTimer) return { started: false, reason: '已在运行' };
  if (process.env.NODE_ENV === 'test') return { started: false, reason: '测试环境不启动' };
  if (process.env.ANTICHEAT_UPGRADE_SCHEDULER === 'false') return { started: false, reason: '已通过环境变量关闭' };
  const tick = async () => {
    try {
      const GoalConfig = require('../models/goal-config');
      const cfg = await GoalConfig.getSingleton();
      const ac = (cfg && cfg.anticheat) || {};
      // 两个开关都关时不必训练（省 CPU；管理端手动评估仍可强制跑）
      if (ac.autoUpgrade === false && ac.autoDemote === false) return;
      const out = await evaluateAll({ operator: 'scheduler' });
      const changed = out.filter((r) => r.action === 'promote' || r.action === 'demote');
      if (changed.length) {
        console.log(`[anticheat-upgrade] 定时评估完成：${changed.map((r) => `${r.source} ${r.action}→${STAGES[r.nextStage]}`).join('；')}`);
      }
    } catch (e) {
      console.warn('[anticheat-upgrade] 定时评估失败（不影响判定）:', e.message);
    }
  };
  schedTimer = setTimeout(() => {
    schedTimer = setInterval(tick, intervalMs);
    // unref：不因这个定时器阻止进程退出（systemd stop 才不会被拖住 6 小时）
    if (typeof schedTimer.unref === 'function') schedTimer.unref();
    tick();
  }, initialDelayMs);
  if (typeof schedTimer.unref === 'function') schedTimer.unref();
  console.log(`[anticheat-upgrade] 阶段性自升级已启用：每 ${Math.round(intervalMs / 3600000)} 小时评估一次`);
  return { started: true, intervalMs, initialDelayMs };
}

function stopScheduler() {
  if (schedTimer) {
    clearTimeout(schedTimer);
    clearInterval(schedTimer);
    schedTimer = null;
  }
  return { stopped: true };
}

module.exports = {
  GATES,
  DEMOTE,
  STAGES,
  STAGE_TEXT,
  STAGE_DESC,
  getState,
  getStates,
  invalidateStateCache,
  loadSamples,
  shadowStats,
  checkPromotion,
  checkDemotion,
  evaluateSource,
  evaluateAll,
  scoreFor,
  stageText,
  manualSetStage,
  releaseManual,
  snapshotSource,
  snapshot,
  startScheduler,
  stopScheduler,
};
