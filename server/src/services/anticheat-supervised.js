/**
 * 唐跑AI数据模型 · **有监督分类器**（纯 JS 逻辑回归，无新依赖）。
 *
 * ===== 为什么需要这一层 =====
 * `services/anticheat-model.js` 里的 Isolation Forest 是**无监督**的：
 * 它只能回答「这条数据像不像异常」，回答不了「这**就是**作弊」。
 * 无人监督时这是唯一可行做法，但上限就在那里 —— 它不知道哪个方向是作弊，
 * 只能把「罕见」当「可疑」。人力标注（step_labels）积累到一定量后，
 * 有监督模型能直接学「人工认定作弊的那些样本长什么样」，准确率是质变。
 *
 * ===== 四个刻意的设计选择（改这个文件前先读完）=====
 *
 * ① **逻辑回归而不是神经网络**：本仓库没有 GPU / Python，样本量在几百条量级。
 *    几百条样本上训深度模型必然过拟合，而逻辑回归在这类「低维、可解释、小样本」
 *    问题上表现稳定，训练 10ms 级、**权重可逐项读出**（管理员能问「为什么封他」）。
 *    这才是这个数据规模下正确的模型，不是妥协。
 *
 * ② **特征子集按覆盖率挑选**：标注是**跨版本**累积的 —— 2026-10-29 才加了
 *    ruleHits / ruleMax 两个特征，此前的标注快照里没有它们。若直接把这些特征
 *    当 0 喂进去，等于教模型「命中规则的人反而不作弊」（0 会被学成负权重），
 *    比不训练更糟。所以只训练「≥80% 标注快照都有」的特征，并在模型里记下这份清单；
 *    推理时同样只取这几个维度 —— 训练与推理必须用**同一份特征清单**。
 *    （实测：werun 167 条标注里只有 15 条带 ruleHits，所以 werun 模型暂时不用这两个维度。）
 *
 * ③ **类别不平衡与降权**：作弊是少数类。训练时按类别频率反比加权，
 *    否则模型会「全判正常」也能有 90% 准确率 —— 那种模型毫无用处（漏掉所有作弊）。
 *    另外 minor（轻微违规）按 step-label 的 TRAIN_WEIGHTS 降权（默认 0.5）：
 *    它确实是作弊，只是程度轻，全排除会让模型学不到「轻度修饰」这一档。
 *
 * ④ **输出要做「分位映射」，不能直接当分数用**：逻辑回归输出的是概率，
 *    而作弊样本占比只有 10%~20% 时，概率几乎不可能超过 0.78 ——
 *    直接拿 p 去比「自动封禁线 0.78」等于这个模型永远不会触发封禁。
 *    所以训练时在验证集上确定两个**操作点**（pSuspicious / pAutoBan：
 *    分别达到「可疑线精度」「封禁线精度」的概率阈值），运行时把 p 分段线性
 *    映射到 0.5~1 的**风险分**，锚定到当前生效的阈值（见 mapToRisk）。
 *    这样「有监督分」与无监督分同一量纲，管理员调严谨度档位时也自动跟随。
 */
const TRAIN_WEIGHTS = { cheat: 1, minor: 0.5, normal: 1 };

const DEFAULTS = {
  // 交叉验证折数（按类别分层）。见 trainAndValidate 注释：单次留出在小样本下极不稳定。
  folds: 5,
  // 特征覆盖门槛：低于它的特征不进模型（理由见文件头 ②）
  minCoverage: 0.8,
  // 至少要有这么多个特征才训（太少了没有区分力）
  minFeatures: 3,
  // 梯度下降参数（全批量、标准化后收敛很快；固定种子 → 结果可复现）
  epochs: 400,
  lr: 0.35,
  l2: 0.05,
  seed: 20261112,
  // 操作点目标：达到该精度前提下召回最高的概率阈值
  precSuspicious: 0.5,
  precAutoBan: 0.85,
};

// ===== 可复现随机（mulberry32）=====
// 为什么不用 Math.random：同一份标注在两个进程里必须切出**同一份**验证集，
// 否则多进程部署时各进程算出的指标不同、升级结论也不同（A 进程升、B 进程不升）。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function isNum(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

/**
 * 按覆盖率挑选可参与训练的特征（顺序沿用 WERUN_ORDER / GPS_ORDER，保证向量稳定）。
 * @param {Array<object>} samples [{features, label, weight}]
 * @param {string[]} order 该来源的完整特征顺序
 */
function selectFeatures(samples, order, { minCoverage = DEFAULTS.minCoverage } = {}) {
  const total = samples.length;
  if (!total) return [];
  const keep = [];
  for (const key of order) {
    let hit = 0;
    for (const s of samples) {
      if (s.features && isNum(s.features[key])) hit += 1;
    }
    if (hit / total >= minCoverage) keep.push(key);
  }
  return keep;
}

/** 某来源当前的「特征覆盖情况」，给管理端解释「为什么这个维度没用上」 */
function featureCoverage(samples, order) {
  const total = samples.length || 1;
  return order.map((key) => {
    let hit = 0;
    for (const s of samples) if (s.features && isNum(s.features[key])) hit += 1;
    return { key, ratio: hit / total, used: hit / total >= DEFAULTS.minCoverage };
  });
}

function toVector(features, keys) {
  return keys.map((k) => (features && isNum(features[k]) ? Number(features[k]) : 0));
}

/** 标准化参数（均值/标准差），标准差为 0 时按 1 处理（该维度恒定时不放大噪声） */
function standardize(trainVectors) {
  const dim = trainVectors[0].length;
  const means = new Array(dim).fill(0);
  const stds = new Array(dim).fill(1);
  for (let d = 0; d < dim; d += 1) {
    const vals = trainVectors.map((v) => v[d]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    means[d] = mean;
    const sd = Math.sqrt(variance);
    stds[d] = sd > 1e-9 ? sd : 1;
  }
  return { means, stds };
}

function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * 训练逻辑回归（全批量梯度下降 + L2）。
 * @param {Array<{vector:number[], y:0|1, weight:number}>} rows
 * @returns {{bias:number, weights:number[], means:number[], stds:number[], epochs:number, lr:number, l2:number}}
 */
function fitLogistic(rows, { epochs = DEFAULTS.epochs, lr = DEFAULTS.lr, l2 = DEFAULTS.l2 } = {}) {
  const dim = rows[0].vector.length;
  const { means, stds } = standardize(rows.map((r) => r.vector));
  const xs = rows.map((r) => r.vector.map((v, d) => (v - means[d]) / stds[d]));
  let bias = 0;
  const weights = new Array(dim).fill(0);
  const totalW = rows.reduce((a, r) => a + r.weight, 0) || 1;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    let gb = 0;
    const gw = new Array(dim).fill(0);
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      let z = bias;
      for (let d = 0; d < dim; d += 1) z += weights[d] * xs[i][d];
      const err = (sigmoid(z) - r.y) * r.weight;
      gb += err;
      for (let d = 0; d < dim; d += 1) gw[d] += err * xs[i][d];
    }
    bias -= (lr * gb) / totalW;
    for (let d = 0; d < dim; d += 1) weights[d] -= (lr * (gw[d] / totalW + l2 * weights[d]));
  }
  return { bias, weights, means, stds, epochs, lr, l2 };
}

/** 用训练好的模型对一个特征对象求「作弊概率」 */
function predictProbability(model, features) {
  if (!model || !Array.isArray(model.features)) return null;
  let z = Number(model.bias) || 0;
  for (let d = 0; d < model.features.length; d += 1) {
    const raw = features && isNum(features[model.features[d]]) ? Number(features[model.features[d]]) : 0;
    const x = (raw - model.means[d]) / model.stds[d];
    z += model.weights[d] * x;
  }
  return sigmoid(z);
}

// ===== 指标 =====
function precisionRecall(rows, predict, threshold) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const r of rows) {
    const p = predict(r);
    const hit = p >= threshold;
    if (hit && r.y === 1) tp += 1;
    else if (hit && r.y === 0) fp += 1;
    else if (!hit && r.y === 1) fn += 1;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, tp, fp, fn };
}
/** AUC（基于秩，Mann-Whitney U）：对阈值不敏感，用来判断「排序能力」 */
function aucOf(rows, predict) {
  const pos = rows.filter((r) => r.y === 1).map(predict);
  const neg = rows.filter((r) => r.y === 0).map(predict);
  if (!pos.length || !neg.length) return null;
  const sorted = [...rows].map((r) => ({ s: predict(r), y: r.y })).sort((a, b) => a.s - b.s);
  // 同分取平均秩
  let rank = 1;
  let i = 0;
  let sumPosRank = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && Math.abs(sorted[j + 1].s - sorted[i].s) < 1e-12) j += 1;
    const avgRank = (rank + (rank + (j - i))) / 2;
    for (let k = i; k <= j; k += 1) if (sorted[k].y === 1) sumPosRank += avgRank;
    rank += j - i + 1;
    i = j + 1;
  }
  const n1 = pos.length;
  const n0 = neg.length;
  return (sumPosRank - (n1 * (n1 + 1)) / 2) / (n1 * n0);
}

/**
 * 在验证集上挑两个操作点。
 *
 * 为什么必须挑而不是写死 0.5：逻辑回归在小样本 + 类别不平衡下概率分布偏中间的，
 * 「0.5」既可能是过于宽松也可能过于严格，把决策点交给验证集才算真的用到了标注。
 * @returns {{pSuspicious:number, pAutoBan:number, susp:object, ban:object}}
 */
function chooseOperatingPoints(rows, predict, { precSuspicious = DEFAULTS.precSuspicious, precAutoBan = DEFAULTS.precAutoBan } = {}) {
  const grid = [];
  for (let t = 0.05; t <= 0.95 + 1e-9; t += 0.05) grid.push(Math.round(t * 100) / 100);

  // 可疑线：达到目标精度的前提下召回最高（宁可先把人推进队列，也不要漏）
  let susp = null;
  for (const t of grid) {
    const m = precisionRecall(rows, predict, t);
    if (m.tp + m.fp === 0) continue;
    if (m.precision >= precSuspicious && (!susp || m.recall > susp.m.recall || (m.recall === susp.m.recall && t > susp.t))) {
      susp = { t, m };
    }
  }
  // 一条都达不到目标精度 → 退化为 F1 最优（仍比拍一个 0.5 强）
  if (!susp) {
    let best = null;
    for (const t of grid) {
      const m = precisionRecall(rows, predict, t);
      if (m.tp + m.fp === 0) continue;
      if (!best || m.f1 > best.m.f1) best = { t, m };
    }
    susp = best;
  }

  // 封禁线：更高精度（误封的代价比漏判大得多 —— 误封只能靠学生申诉发现）
  let ban = null;
  for (const t of grid) {
    const m = precisionRecall(rows, predict, t);
    if (m.tp + m.fp === 0) continue;
    if (m.precision >= precAutoBan && (!ban || m.recall > ban.m.recall || (m.recall === ban.m.recall && t > ban.t))) {
      ban = { t, m };
    }
  }
  const baseSusp = susp ? susp.t : 0.5;
  // 达不到封禁精度 → 把封禁点抬到可疑点之上（不硬塞一个「没人能满足」的封禁线）
  const baseBan = ban ? ban.t : Math.min(0.95, baseSusp + 0.2);

  const pSuspicious = Math.max(0.05, Math.min(0.95, baseSusp));
  const pAutoBan = Math.max(pSuspicious + 0.05, Math.min(0.99, baseBan));
  return {
    pSuspicious,
    pAutoBan,
    susp: susp ? susp.m : null,
    ban: ban ? ban.m : null,
  };
}

/**
 * 把概率映射成与无监督分**同一量纲**的风险分（0~1，锚定到当前生效阈值）。
 *
 * 分段线性：
 *   p ≤ pSuspicious        → [0, 阈值.suspicious)      （只供解释，不进队列）
 *   pSuspicious..pAutoBan  → [suspicious, autoBan)     （进待研判）
 *   p > pAutoBan           → (autoBan, 1]              （可自动封禁）
 *
 * ⚠️ 锚定的是**当前生效阈值**（含严谨度档位与在线校准），不是写死的 0.62/0.78：
 *   管理员把档位调到 strict 之后，有监督模型的判定也要跟着变严，否则「调了档位
 *   只有无监督那条路变了」——两条通道各按各的线走，管理员永远说不清是谁封的。
 */
function mapToRisk(p, model, thresholds) {
  const prob = Math.max(0, Math.min(1, Number(p) || 0));
  const s = Number(thresholds && thresholds.suspicious) || 0.62;
  const a = Math.max(s + 0.02, Number(thresholds && thresholds.autoBan) || 0.78);
  const ops = (model && model.operating) || {};
  const ps = Math.max(0.02, Math.min(0.98, Number(ops.pSuspicious) || 0.5));
  const pb = Math.max(ps + 0.02, Math.min(0.995, Number(ops.pAutoBan) || 0.8));

  if (prob <= ps) {
    // 低概率区：0.5 是「和人群一样正常」的基准线，与 Isolation Forest 语义对齐
    return Math.max(0, (prob / ps) * 0.5);
  }
  if (prob <= pb) {
    const t = (prob - ps) / (pb - ps);
    return s + t * (a - s);
  }
  const t = (prob - pb) / (1 - pb);
  return Math.min(1, a + t * (1 - a));
}

/**
 * 训练 + 验证 + 定操作点（一步到位；调用方只管要不要据此升级）。
 *
 * @param {Array<{features:object, label:string, weight?:number}>} samples
 * @param {{order:string[], seed?:number, minCoverage?:number}} opts order = 该来源的完整特征顺序
 * @returns {null | {model:object, metrics:object, coverage:Array, features:string[]}}
 */
function trainAndValidate(samples, opts = {}) {
  const order = Array.isArray(opts.order) ? opts.order : [];
  const clean = (Array.isArray(samples) ? samples : []).filter(
    (s) => s && s.features && (s.label === 'cheat' || s.label === 'minor' || s.label === 'normal')
  );
  if (!clean.length) return null;
  const features = selectFeatures(clean, order, { minCoverage: opts.minCoverage });
  if (features.length < DEFAULTS.minFeatures) {
    return {
      model: null,
      metrics: { reason: '可训练特征不足', featureCount: features.length },
      coverage: featureCoverage(clean, order),
      features,
    };
  }

  // 标注 → 训练行（minor 降权；权重取 step-label 的训练权重）
  const rows = clean.map((s) => ({
    features: s.features,
    label: s.label,
    y: s.label === 'normal' ? 0 : 1,
    baseWeight: s.weight == null ? TRAIN_WEIGHTS[s.label] == null ? 1 : TRAIN_WEIGHTS[s.label] : Number(s.weight),
  }));

  const posCount = rows.filter((r) => r.y === 1).length;
  const negCount = rows.length - posCount;
  if (posCount < 2 || negCount < 2) {
    return {
      model: null,
      metrics: { reason: '作弊/正常两类样本不足', posCount, negCount },
      coverage: featureCoverage(clean, order),
      features,
    };
  }

  // ===== 分层 K 折交叉验证（不是单次留出）=====
  //
  // ⚠️ 这里改了实现，原因值得记住（2026-11-12 实测）：
  //   一开始用「单次 70/30 留出」评估，同一份 167 条标注，两次运行给出的
  //   留出集 AUC 分别是 0.65 与 0.46 —— 因为留出集里只有 8 条作弊样本，
  //   一条样本翻转就能让 AUC 掉 0.06。拿这种数字当「能不能自动升级为可封号模型」
  //   的判据，等于用掷骰子决定要不要开始封人。
  //   现在改成按类别分层的 K 折：每折轮流留出，算各折均值。
  //   作弊样本被重复利用 K 次，方差降到约 1/√K，且**每一折的验证集都两类都有**
  //   （普通 K 折在小样本下可能出现某一折没有作弊样本，AUC 直接算不出来）。
  //
  // 随机种子固定 → 同一份标注在任何进程里切出**完全相同**的折，
  // 多进程部署不会出现「A 进程算出 0.7、B 进程算出 0.5」。
  const rand = mulberry32(opts.seed == null ? DEFAULTS.seed : opts.seed);
  const folds = Math.max(2, Math.min(DEFAULTS.folds, Math.min(posCount, negCount)));
  const byClass = { 0: [], 1: [] };
  for (const r of rows) byClass[r.y].push(r);
  // 每类的样本打散后轮流分到各折：类内顺序随机、折间数量尽量均匀
  const buckets = [];
  for (let i = 0; i < folds; i += 1) buckets.push([]);
  for (const y of ['0', '1']) {
    const arr = shuffleInPlace(byClass[y].slice(), rand);
    arr.forEach((r, idx) => buckets[idx % folds].push(r));
  }

  // 逐折训练 + 在留出折上评估
  const foldResults = [];
  for (let f = 0; f < folds; f += 1) {
    const holdout = buckets[f];
    const train = [];
    for (let g = 0; g < folds; g += 1) if (g !== f) train.push(...buckets[g]);
    const trainPos = train.filter((r) => r.y === 1).length;
    const trainNeg = train.length - trainPos;
    if (trainPos < 1 || trainNeg < 1) continue;
    const rowsForFit = train.map((r) => ({
      vector: toVector(r.features, features),
      y: r.y,
      // 类别平衡权重：作弊是少数类，不加权会「全判正常也有高准确率」
      weight: r.baseWeight * (r.y === 1 ? train.length / (2 * trainPos) : train.length / (2 * trainNeg)),
    }));
    const fitted = fitLogistic(rowsForFit, opts);
    const foldModel = {
      features,
      bias: fitted.bias,
      weights: fitted.weights,
      means: fitted.means,
      stds: fitted.stds,
      epochs: fitted.epochs,
    };
    const predict = (r) => predictProbability(foldModel, r.features);
    foldResults.push({
      fold: f,
      model: foldModel,
      holdout,
      predict,
      auc: aucOf(holdout, predict),
      rows: train.length,
    });
  }
  if (!foldResults.length) {
    return {
      model: null,
      metrics: { reason: '交叉验证无法切分（样本过少）', posCount, negCount },
      coverage: featureCoverage(clean, order),
      features,
    };
  }

  // 各折指标取均值（AUC 是主判据）。空值折（某折某一类缺失，理论上被分层排除了）忽略。
  const meanOf = (vals) => {
    const ok = vals.filter((v) => v != null && Number.isFinite(v));
    return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
  };
  const stdOf = (vals) => {
    const ok = vals.filter((v) => v != null && Number.isFinite(v));
    if (ok.length < 2) return null;
    const m = ok.reduce((a, b) => a + b, 0) / ok.length;
    return Math.sqrt(ok.reduce((a, b) => a + (b - m) ** 2, 0) / ok.length);
  };
  const aucList = foldResults.map((r) => r.auc);
  const allHoldout = foldResults.flatMap((r) => r.holdout);
  // 操作点用「各折留出集拼起来」的整体来挑（每折各自挑会让阈值在不同折间漂移）
  const cvPredict = (r) => {
    // 找一个包含该行的折的模型来预测（同一行只会出现在一个折的留出集中）
    const owner = foldResults.find((fr) => fr.holdout.includes(r));
    return owner ? owner.predict(r) : 0.5;
  };
  const ops = chooseOperatingPoints(allHoldout, cvPredict, opts);
  const atSusp = precisionRecall(allHoldout, cvPredict, ops.pSuspicious);
  const atBan = precisionRecall(allHoldout, cvPredict, ops.pAutoBan);

  // ===== 最终模型：用**全部标注**重训（交叉验证只用来出指标与挑操作点）=====
  const allPos = rows.filter((r) => r.y === 1).length;
  const allNeg = rows.length - allPos;
  const finalFit = fitLogistic(
    rows.map((r) => ({
      vector: toVector(r.features, features),
      y: r.y,
      weight: r.baseWeight * (r.y === 1 ? rows.length / (2 * allPos) : rows.length / (2 * allNeg)),
    })),
    opts
  );
  const model = {
    features,
    bias: finalFit.bias,
    weights: finalFit.weights,
    means: finalFit.means,
    stds: finalFit.stds,
    epochs: finalFit.epochs,
    operating: { pSuspicious: ops.pSuspicious, pAutoBan: ops.pAutoBan },
  };

  return {
    model,
    features,
    coverage: featureCoverage(clean, order),
    metrics: {
      // auc = 各折均值（升级闸门看它）；aucStd 让管理员看到「这个数字稳不稳」
      auc: meanOf(aucList),
      aucStd: stdOf(aucList),
      aucFolds: aucList.map((v) => (v == null ? null : Math.round(v * 1000) / 1000)),
      folds: foldResults.length,
      pSuspicious: ops.pSuspicious,
      pAutoBan: ops.pAutoBan,
      precisionAtSuspicious: atSusp.precision,
      recallAtSuspicious: atSusp.recall,
      precisionAtAutoBan: atBan.precision,
      recallAtAutoBan: atBan.recall,
      holdoutRows: allHoldout.length,
      positives: posCount,
      negatives: negCount,
      samples: rows.length,
    },
  };
}

module.exports = {
  DEFAULTS,
  TRAIN_WEIGHTS,
  mulberry32,
  selectFeatures,
  featureCoverage,
  fitLogistic,
  predictProbability,
  precisionRecall,
  aucOf,
  chooseOperatingPoints,
  mapToRisk,
  trainAndValidate,
};
