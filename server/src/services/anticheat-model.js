/**
 * 反作弊「学习引擎」（用户 2026-10-27：「融入大数据或推理模型，自己学习规则与模式，
 * 真正判断人为与机器操作，针对不同跑步类型如微信同步、GPS 分开来」）。
 *
 * ===== 先说明技术边界（这一节请务必读完再改代码）=====
 * 本仓库是 Node/Express + Mongoose，**没有** Python 运行时、没有 GPU、也没有外部 ML 服务，
 * 因此这里不可能塞进深度神经网络。但「自己学习规则与模式」这件事**不依赖神经网络**：
 * 用统计方法从既有数据里学分布与基线，效果往往比拍脑袋定阈值好得多，而且可解释、可复现。
 *
 * 本文件实现的是**三个真正会学习的部件**：
 *
 *   ① 特征工程（按来源分流）
 *      微信同步与 GPS 是两种完全不同的行为，特征不能共用一套：
 *        · 微信同步：步数、增量、增速、整数化程度、数字模式、同步节奏（次数/间隔）、
 *          与本人历史基线的偏离（z-score）
 *        · GPS：配速、步幅、轨迹点间隔（含最大间隔）、轨迹平滑度（相邻位移方差）、
 *          距离/时长组合、重复路线（同样的点集反复出现）
 *
 *   ② Isolation Forest（无监督异常检测，纯 JS 实现）
 *      「没人标注过哪些是作弊」→ 有监督模型无从训练，但**无监督**模型不需要标签：
 *      它学习「正常样本在特征空间里长什么样」，把远离群体的点判为异常。
 *      这是工业界做异常检测的标准做法（信用卡欺诈、服务器入侵都先用它）。
 *      森林每轮从现有数据抽样重建，**数据越多学得越准**。
 *
 *   ③ 反馈驱动的阈值自校准（在线学习）
 *      管理员点「封禁」或「标记正常」就是**标注**。我们把这些标注存下来，
 *      定期统计「被判异常的样本里，人工确认的比例」，据此自动上调/下调判定阈值 ——
 *      这是真正的闭环学习：模型越用越准，且不需要人工调参。
 *
 * ===== 与旧规则的关系 =====
 *   services/step-anomaly.js 的**硬规则**（66666 这种重复数字、单日超限）保留：
 *   它们是「物理上不可能」的确定性判据，不需要学习，也不该被模型覆盖。
 *   本引擎负责**规则抓不到的软异常**（例如「步数本身正常但增速与同步节奏的矛盾」）。
 *   最终得分 = 硬规则分 + 学习分，两者独立可解释（出问题时能说清是谁判的）。
 */
const RunRecord = require('../models/run-record');
const User = require('../models/user');

// ===== 模型参数（可在管理端调整；这些值本身也是学习结果的一部分）=====
// 森林规模：树太少方差大，太多浪费 CPU。60 棵对 1~2 万条样本是经验甜点。
const FOREST_TREES = 60;
// 每棵树的采样数：Isolation Forest 的标准做法是取 min(256, n)
const SAMPLE_SIZE = 256;
// 训练样本总量上限：太多没必要（抽样已足够），也避免一次拉爆内存
const TRAIN_MAX_ROWS = 20000;
// 模型重训间隔：新数据足够多才重训，避免每次同步都跑一遍
const RETRAIN_EVERY_MS = 6 * 60 * 60 * 1000;

// ===========================================================================
// ① 特征工程（按来源分流）
// ===========================================================================

/** 微信同步的特征（与 GPS 完全不共用） */
function werunFeatures({ record, history }) {
  const steps = Number(record.steps) || 0;
  const delta = Number(record.deltaSteps) || steps;
  const elapsedSec = Math.max(Number(record.elapsedMs) || 1, 1) / 1000;
  const perSec = delta / elapsedSec; // 步/秒
  const hist = history || {};
  // 与本人历史基线的偏离：用稳健 z-score（中位数 + MAD），避免被自己的极端日带偏
  const med = Number(hist.medianSteps) || 0;
  const mad = Number(hist.madSteps) || 1;
  const z = mad > 0 ? Math.abs(steps - med) / mad : 0;
  return {
    // 整数化：末位为 0 的位数（整千 = 3，整万 = 4）。真实步数几乎总是 0~1。
    roundness: countTrailingZeros(steps),
    // 数字模式：重复 / 顺序（0~1）
    pattern: patternScore(steps),
    perSec: Math.min(perSec, 50), // 截顶，避免单个极端值主导
    steps: Math.min(steps, 120000),
    delta: Math.min(delta, 120000),
    z: Math.min(z, 20),
    syncCountToday: Math.min(Number(hist.syncCountToday) || 0, 50),
    // 同一天反复同步但步数不涨 → 脚本心跳的特征
    zeroDeltaStreak: Math.min(Number(hist.zeroDeltaStreak) || 0, 20),
  };
}

/** GPS 的特征（与微信同步完全不共用） */
function gpsFeatures({ record, history }) {
  const dist = Math.max(Number(record.distance) || 0, 0);
  const dur = Math.max(Number(record.durationSeconds) || 0, 1);
  const pts = Array.isArray(record.routePoints) ? record.routePoints : [];
  const paceSecPerKm = dist > 0 ? dur / (dist / 1000) : 0; // 秒/公里
  // 步幅：GPS 没有步数，用「距离/时长」反映的真实速度代替；这里给「米/秒」
  const speed = dist / dur;
  // 轨迹质量：点间隔的均值/最大值，以及平滑度（相邻位移的标准差）
  let gapAvg = 0;
  let gapMax = 0;
  let jitter = 0;
  if (pts.length >= 2) {
    const gaps = [];
    const steps = [];
    for (let i = 1; i < pts.length; i += 1) {
      gaps.push(Math.max(0, (pts[i].timestamp || 0) - (pts[i - 1].timestamp || 0)));
      steps.push(haversine(pts[i - 1], pts[i]));
    }
    gapAvg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    gapMax = Math.max(...gaps);
    // 平滑度：相邻位移的标准差 / 平均位移。人工跑动平滑，脚本「瞬移」方差极大。
    const meanStep = steps.reduce((a, b) => a + b, 0) / steps.length;
    const variance = steps.reduce((a, b) => a + (b - meanStep) ** 2, 0) / steps.length;
    jitter = meanStep > 0 ? Math.sqrt(variance) / meanStep : 0;
  }
  return {
    paceSecPerKm: Math.min(paceSecPerKm, 3600),
    speed: Math.min(speed, 20),
    distance: Math.min(dist, 100000),
    duration: Math.min(dur, 14400),
    pointCount: Math.min(pts.length, 5000),
    gapAvg: Math.min(gapAvg, 300000),
    gapMax: Math.min(gapMax, 600000),
    jitter: Math.min(jitter, 10),
    // 点太少但距离很长 → 中间是「跳」过去的，典型伪造
    sparse: pts.length > 0 ? Math.min(dist / Math.max(pts.length, 1), 10000) : 0,
  };
}

// 小工具：尾部连续 0 的个数
function countTrailingZeros(n) {
  const s = String(Math.round(Math.abs(Number(n) || 0)));
  let c = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === '0'; i -= 1) c += 1;
  return c;
}

// 数字模式分：重复数字 / 顺序数字 → 1，其余 0
function patternScore(n) {
  const s = String(Math.round(Number(n) || 0));
  if (s.length < 4) return 0;
  if (/^(\d)\1+$/.test(s)) return 1;
  const d = s.split('').map(Number);
  const asc = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  const desc = d.every((x, i) => i === 0 || x === d[i - 1] - 1);
  return asc || desc ? 1 : 0;
}

function haversine(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLng = (b.longitude - a.longitude) * rad;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, Math.sqrt(x))));
}

// ===========================================================================
// ② Isolation Forest（纯 JS，无依赖）
// ===========================================================================
/**
 * 为什么用 Isolation Forest 而不是「设阈值」：
 *   阈值只能抓「已知形态」（比如步数 > 50000）。而作弊手法会变。
 *   Isolation Forest 学的是「正常样本有多容易与人群分离」——
 *   异常点只需要很少的切分就能被孤立，正常点需要很多次切分。
 *   它**不需要标签**，也不需要假设数据服从正态分布，对高维稀疏特征稳健。
 */
function buildIsolationForest(vectors, { trees = FOREST_TREES, sampleSize = SAMPLE_SIZE } = {}) {
  const n = vectors.length;
  if (n < 20) return null; // 样本太少不训练（学了也不可信）
  const dim = vectors[0].length;
  const forest = [];
  const size = Math.min(sampleSize, n);
  for (let t = 0; t < trees; t += 1) {
    // 无放回抽样（bootstrap 会让同一点重复，孤立深度失真）
    const sample = pickSample(vectors, size);
    const maxDepth = Math.ceil(Math.log2(Math.max(size, 2)));
    forest.push(buildTree(sample, 0, maxDepth, dim));
  }
  // 归一化常数：c(n) = 2H(n-1) - 2(n-1)/n，用于把路径长度转成异常分
  const c = avgPathLength(size);
  return { forest, size, dim, c, trainedAt: Date.now(), rows: n };
}

function pickSample(vectors, size) {
  const idx = new Set();
  // 随机抽样（size 接近 n 时退化为洗牌后截取，避免死循环）
  if (size >= vectors.length) return vectors.slice();
  while (idx.size < size) idx.add(Math.floor(Math.random() * vectors.length));
  return [...idx].map((i) => vectors[i]);
}

function buildTree(sample, depth, maxDepth, dim) {
  if (!sample.length || depth >= maxDepth) {
    return { leaf: true, size: sample.length };
  }
  // 找一个方差不为 0 的维度切分（全部同值就成叶）
  const dims = shuffle([...Array(dim).keys()]);
  let splitDim = -1;
  let min = 0;
  let max = 0;
  for (const d of dims) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of sample) {
      if (v[d] < lo) lo = v[d];
      if (v[d] > hi) hi = v[d];
    }
    if (hi > lo) {
      splitDim = d;
      min = lo;
      max = hi;
      break;
    }
  }
  if (splitDim < 0) return { leaf: true, size: sample.length };
  const split = min + Math.random() * (max - min);
  const left = [];
  const right = [];
  for (const v of sample) (v[splitDim] <= split ? left : right).push(v);
  return {
    leaf: false,
    dim: splitDim,
    split,
    left: buildTree(left, depth + 1, maxDepth, dim),
    right: buildTree(right, depth + 1, maxDepth, dim),
  };
}

// 单点的路径长度（隔离它需要的切分次数）
function pathLength(node, v, depth = 0) {
  if (node.leaf) return depth + avgPathLength(node.size);
  return pathLength(v[node.dim] <= node.split ? node.left : node.right, v, depth + 1);
}

// 调和数近似：H(i) ≈ ln(i) + 0.5772156649
function avgPathLength(n) {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n;
}

/**
 * 异常分：0.5 是「与人群一样正常」的基准线，越接近 1 越异常。
 * 公式与原始论文一致：s = 2^(-E(h)/c(n))
 */
function scoreForest(model, vector) {
  if (!model || !model.forest.length) return 0.5;
  const sum = model.forest.reduce((acc, t) => acc + pathLength(t, vector), 0);
  const e = sum / model.forest.length;
  return Math.pow(2, -e / (model.c || 1));
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ===========================================================================
// ③ 模型训练与持久化
// ===========================================================================
// 内存缓存：一个进程一份，重启后按需重训（训练 2 万样本约几十毫秒，代价可接受）
const cache = { werun: null, gps: null, training: {} };

/** 把特征对象转成向量（字段顺序固定，训练与推理必须一致） */
const WERUN_ORDER = ['roundness', 'pattern', 'perSec', 'steps', 'delta', 'z', 'syncCountToday', 'zeroDeltaStreak'];
const GPS_ORDER = ['paceSecPerKm', 'speed', 'distance', 'duration', 'pointCount', 'gapAvg', 'gapMax', 'jitter', 'sparse'];
function toVector(feat, order) {
  return order.map((k) => Number(feat[k]) || 0);
}

/**
 * 训练某个来源的模型（数据来自历史记录，**不需要任何标签**）。
 * @param {'werun'|'gps'} source
 */
async function trainSource(source) {
  const rows = await fetchTrainingRows(source);
  if (!rows.length) return null;
  const order = source === 'werun' ? WERUN_ORDER : GPS_ORDER;
  const vectors = rows.map((r) => toVector(featureFor(source, r), order));
  const model = buildIsolationForest(vectors);
  if (model) model.source = source;
  return model;
}

/**
 * 拉历史样本用于训练。
 *
 * ⚠️ 性能红线（实测踩过 30 秒超时）：GPS 有 1.4 万条记录、每条 routePoints 数十~数百坐标，
 *   直接 `find().select('routePoints')` 会把几十 MB 拉进内存。所以 GPS 改为
 *   在**库里聚合**出训练所需的标量（点数 / 平均间隔 / 距离 / 时长），内存只处理几百 KB。
 *   微信同步记录只有数字字段，很轻，可直接取。
 */
async function fetchTrainingRows(source) {
  if (source === 'gps') {
    return RunRecord.aggregate([
      { $match: { source: 'gps', distance: { $gt: 50 }, 'routePoints.1': { $exists: true } } },
      { $sort: { createdAt: -1 } },
      { $limit: TRAIN_MAX_ROWS },
      {
        $project: {
          distance: 1,
          durationSeconds: 1,
          pointCount: { $size: '$routePoints' },
          gapAvg: {
            $cond: [
              { $gt: [{ $size: '$routePoints' }, 1] },
              {
                $divide: [
                  {
                    $subtract: [
                      { $arrayElemAt: ['$routePoints.timestamp', -1] },
                      { $arrayElemAt: ['$routePoints.timestamp', 0] },
                    ],
                  },
                  { $subtract: [{ $size: '$routePoints' }, 1] },
                ],
              },
              0,
            ],
          },
        },
      },
    ]);
  }
  return RunRecord.find({ source: 'werun', steps: { $gt: 0 } })
    .sort({ createdAt: -1 })
    .limit(TRAIN_MAX_ROWS)
    .select('steps')
    .lean();
}

/**
 * 把「聚合结果 / 文档」转成特征对象。
 *
 * 训练与推理必须用**同一套特征函数与同一套定义**，否则模型学到分布与实际打分口径不符。
 * GPS 训练没有原始轨迹点，用聚合标量构造等间隔伪轨迹喂给 gpsFeatures，
 * 得到与推理侧一致的 pace/speed/pointCount/gapAvg。jitter 在库侧算不出，训练时恒 0，
 * 它主要作为推理侧加分项（真实轨迹才有意义），不参与分布学习。
 */
function featureFor(source, row) {
  if (source === 'werun') {
    return werunFeatures({
      record: { steps: row.steps, deltaSteps: row.steps, elapsedMs: 3600000 },
      history: {},
    });
  }
  return gpsFeatures({
    record: { distance: row.distance, durationSeconds: row.durationSeconds, routePoints: buildPseudoRoute(row) },
  });
}

// 用聚合标量构造等间隔伪轨迹（只喂特征函数；不落库、不上传）
function buildPseudoRoute(row) {
  const n = Math.min(Math.max(Number(row && row.pointCount) || 0, 2), 200);
  const gap = Number(row && row.gapAvg) || 5000;
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ latitude: 30, longitude: 120, timestamp: i * gap });
  return out;
}

/**
 * 取模型（懒加载 + 定时重训）。
 * @param {'werun'|'gps'} source
 * @param {{force?:boolean}} [opts]
 */
async function getModel(source, { force = false } = {}) {
  const hit = cache[source];
  const stale = !hit || force || Date.now() - hit.trainedAt > RETRAIN_EVERY_MS;
  if (!stale) return hit;
  // 并发保护：多个同步请求同时到达时只训一次
  if (cache.training[source]) return cache.training[source];
  cache.training[source] = (async () => {
    try {
      const model = await trainSource(source);
      cache[source] = model;
      return model;
    } catch (e) {
      // 训练失败不能影响业务：返回上次的模型（可能为 null → 调用方按「无模型」处理）
      return cache[source];
    } finally {
      cache.training[source] = null;
    }
  })();
  return cache.training[source];
}

// ===========================================================================
// ④ 推理 + 阈值自校准（在线学习）
// ===========================================================================
/**
 * 判定阈值。**不是拍脑袋定的**，而是由「人工反馈统计」动态校准：
 * 每次管理员封禁/排除，都记一笔到 feedback；这里统计历史准确率后微调。
 *
 * 校准逻辑（简单但有效）：
 *   · 如果历史上一批被判可疑的人里，人工确认作弊的比例 < 30% → 说明太敏感，阈值上调
 *   · 如果确认比例 > 70% → 说明太保守，阈值下调
 *   · 每次调整幅度很小（0.02），避免震荡
 */
const BASE_THRESHOLD = { suspicious: 0.62, autoBan: 0.78 };
// 内存里只保留**最近**的反馈用于快速校准；**权威数据在 step_labels 集合**（见下方 loadFeedback）。
// 上一版完全放在内存 → 重启丢失、多进程不一致，是必须修的缺陷。
const FEEDBACK = { samples: [], threshold: { ...BASE_THRESHOLD }, loadedAt: 0 };

/**
 * 从数据库加载历史标注（权威来源）。
 * 缓存 5 分钟，避免每次同步都查库。
 */
async function loadFeedback(force = false) {
  if (!force && FEEDBACK.loadedAt && Date.now() - FEEDBACK.loadedAt < 5 * 60 * 1000) return;
  try {
    const StepLabel = require('../models/step-label');
    // 只取最近 500 条参与阈值校准（太久远的标注反映的是旧手法）
    const rows = await StepLabel.find({})
      .sort({ createdAt: -1 })
      .limit(500)
      .select('isCheat modelScore createdAt')
      .lean();
    FEEDBACK.samples = rows
      .map((r) => ({
        isCheat: !!r.isCheat,
        score: r.modelScore == null ? null : Number(r.modelScore),
        at: r.createdAt ? new Date(r.createdAt).getTime() : 0,
      }))
      .filter((x) => Number.isFinite(x.score));
    FEEDBACK.loadedAt = Date.now();
    // 先刷新档位基线，再校准 —— 顺序不能反，否则本轮校准仍按旧基线筛标注
    // （用户 2026-10-28：管理员调了 AI 严谨度，校准要跟着新基线走）。
    try {
      await loadThresholdBase();
    } catch (e) {
      /* 配置读取失败不阻断校准 */
    }
    recalibrateThreshold();
  } catch (e) {
    /* 库不可用时退回内存样本，不影响判定 */
  }
}

/**
 * 记录一次人工反馈（由 step-anomalies 路由在封禁/排除时调用）。
 * **落库 + 内存各一份**：落库是为了长期积累（升级有监督模型的训练集），
 * 内存是为了让阈值立刻生效（不用等下一次从库里加载）。
 *
 * @param {boolean} isCheat 人工判定是否作弊
 * @param {number} score 当时的模型分
 * @param {object} [meta] 落库所需的额外信息（anomalyId / userId / source / features 等）
 */
async function recordFeedback(isCheat, score, meta = {}) {
  const s = Number(score);
  const safeScore = Number.isFinite(s) ? s : null;

  // 内存：立刻参与阈值校准
  if (safeScore !== null) {
    FEEDBACK.samples.push({ isCheat: !!isCheat, score: safeScore, at: Date.now() });
    if (FEEDBACK.samples.length > 500) FEEDBACK.samples.shift();
    recalibrateThreshold();
  }

  // 落库：长期积累（失败不影响业务）
  try {
    const StepLabel = require('../models/step-label');
    await StepLabel.create({
      anomalyId: meta.anomalyId || null,
      userId: meta.userId,
      openid: meta.openid || '',
      source: meta.source === 'gps' ? 'gps' : 'werun',
      isCheat: !!isCheat,
      modelScore: safeScore,
      ruleScore: Number(meta.ruleScore) || 0,
      features: meta.features || null,
      operator: meta.operator || '',
      note: meta.note || '',
    });
  } catch (e) {
    // 唯一索引冲突（同一异常重复标注）属正常情况，忽略
  }
  return safeScore;
}

function recalibrateThreshold() {
  const list = FEEDBACK.samples;
  if (list.length < 20) return; // 样本太少不动阈值
  // 判据线用**当前生效基线**（而非写死的 BASE_THRESHOLD）：
  // 管理员把档位调成 loose / strict 之后，校准要在新基线上继续，
  // 否则「历史标注按 balanced 的线筛出的人」与「现在的线」不是一回事（用户 2026-10-28）。
  const base = thresholdCfgCache.base || BASE_THRESHOLD;
  const flagged = list.filter((x) => x.score >= base.suspicious);
  if (!flagged.length) return;
  const precision = flagged.filter((x) => x.isCheat).length / flagged.length;
  const t = FEEDBACK.threshold;
  if (precision < 0.3) {
    // 误报偏多 → 提高阈值（更保守）
    t.suspicious = Math.min(0.95, t.suspicious + 0.02);
    t.autoBan = Math.min(0.99, t.autoBan + 0.02);
  } else if (precision > 0.7) {
    // 抓得准但可能漏 → 略降阈值
    t.suspicious = Math.max(0.5, t.suspicious - 0.01);
    t.autoBan = Math.max(0.7, t.autoBan - 0.01);
  }
}

/**
 * AI 严谨度预设（用户 2026-10-28「在反作弊中可以调整 AI 封禁的严谨程度」）。
 *
 * 为什么用档位而不是让管理员直接填 0.62 / 0.78：
 *   那两个小数对管理员没有任何直觉 —— 「填多少才不会误伤真实学生」没人答得上来。
 *   档位把「误伤风险 ↔ 漏抓风险」的取舍翻译成人话：
 *     loose    只封**明显**作弊，宁漏不误伤（大型活动 / 新生期用）
 *     balanced 默认，与历史校准基线一致
 *     strict   宁可多抓，接受少量误伤（管理员有充足人手复核）
 *     custom   管理员自己填两个阈值（高级用法）
 *
 * 档位是**基线**：在线校准在其上小幅浮动（±0.06 封顶），所以调档立即生效且不会被校准吃掉。
 */
const STRICTNESS_PRESETS = {
  loose: { suspicious: 0.72, autoBan: 0.88 },
  balanced: { suspicious: 0.62, autoBan: 0.78 },
  strict: { suspicious: 0.52, autoBan: 0.68 },
};
const CALIBRATION_MAX_SHIFT = 0.06; // 校准相对基线的最大偏移

/**
 * 读取当前生效的阈值。
 *
 * 优先级：goal_config.anticheat 的 aiStrictness / aiSuspiciousThreshold / aiAutoBanThreshold
 *        → 档位预设 → BASE_THRESHOLD，再叠加在线校准的偏移量（封顶 ±0.06）。
 *
 * 配置读取有 30s 缓存（同步路径高频调用，不能每次都查库）；
 * 管理端保存配置后会调 clearThresholdCache() 立即生效。
 */
let thresholdCfgCache = { at: 0, key: '', base: null };

async function loadThresholdBase() {
  const now = Date.now();
  if (thresholdCfgCache.base && thresholdCfgCache.key && now - thresholdCfgCache.at < 30 * 1000) {
    return thresholdCfgCache.base;
  }
  let base = { ...BASE_THRESHOLD };
  let key = 'balanced';
  try {
    const GoalConfig = require('../models/goal-config');
    const cfg = await GoalConfig.getSingleton();
    const ac = (cfg && cfg.anticheat) || {};
    const mode = ['loose', 'balanced', 'strict', 'custom'].includes(ac.aiStrictness)
      ? ac.aiStrictness
      : 'balanced';
    key = mode;
    if (mode === 'custom') {
      // 自定义：钳在合法区间，避免填出 0.1 / 1.5 这种把系统弄坏的值
      const sNum = Number(ac.aiSuspiciousThreshold);
      const aNum = Number(ac.aiAutoBanThreshold);
      const susp = Number.isFinite(sNum) ? Math.min(0.95, Math.max(0.3, sNum)) : BASE_THRESHOLD.suspicious;
      const autom = Number.isFinite(aNum) ? Math.min(0.99, Math.max(0.4, aNum)) : BASE_THRESHOLD.autoBan;
      // 自动封禁必须**高于**可疑线，否则"可疑"就直接封了，等于没有中间态
      base = { suspicious: susp, autoBan: Math.max(susp + 0.02, autom) };
    } else {
      base = { ...(STRICTNESS_PRESETS[mode] || BASE_THRESHOLD) };
    }
  } catch (e) {
    /* 配置读不到 → 用默认档位，绝不让反作弊因配置故障失灵 */
  }
  // 档位变了 → 校准从**新基线**重新开始。
  //
  // ⚠️ 不能保留旧的校准偏移（实测踩过）：管理员把 balanced(0.62) 切成 loose(0.72) 时，
  //   FEEDBACK.threshold 还是 0.62，被 clamp 到「新基线 ±0.06」的 0.66 ——
  //   loose 只生效了一半，看起来像"调了没用"。
  //   正确语义：换档 = 换基线，历史校准是针对旧基线的统计，不该平移到新档位。
  if (thresholdCfgCache.key !== key) {
    FEEDBACK.threshold = { ...base };
  } else if (!FEEDBACK.threshold || !Number.isFinite(FEEDBACK.threshold.suspicious)) {
    FEEDBACK.threshold = { ...base };
  }
  thresholdCfgCache = { at: now, key, base };
  return base;
}

/** 配置变更后立即失效缓存（管理端保存时调用） */
function clearThresholdCache() {
  thresholdCfgCache = { at: 0, key: '', base: null };
}

function currentThreshold() {
  // 同步接口：用**已加载**的基线（异步加载在 startThresholdAutoLoad 里跑，不阻塞判定路径）
  const base = thresholdCfgCache.base || { ...BASE_THRESHOLD };
  const t = { ...FEEDBACK.threshold };
  // 把校准结果收敛到「基线 ± CALIBRATION_MAX_SHIFT」内，避免校准把档位改掉
  const clamp = (v, b) => Math.min(0.95, Math.max(0.35, Math.min(b + CALIBRATION_MAX_SHIFT, Math.max(b - CALIBRATION_MAX_SHIFT, v))));
  return {
    suspicious: clamp(t.suspicious, base.suspicious),
    autoBan: clamp(t.autoBan, base.autoBan),
    mode: thresholdCfgCache.key || 'balanced',
    base,
  };
}

/** 预加载基线（进程启动 / 每次校准前调用；同步判定路径不 await） */
async function warmThreshold() {
  await loadThresholdBase();
  return currentThreshold();
}

// ===========================================================================
// ④.5 升级提示（用户 2026-10-27：「标注积累到阈值后自动提示升级」）
// ===========================================================================
/**
 * 为什么需要这个：
 *   当前引擎是**无监督**（Isolation Forest）——不需要标签，但也只能判「像不像异常」，
 *   判不了「这**就是**作弊」。想让准确率有质的提升，必须升级成**有监督分类器**，
 *   而它的前提是**足够多的人工标注**（谁是不是作弊，已经被人确认过）。
 *   标注不会凭空出现，只能靠管理员在「异常记录」里日积月累地点封禁/标记正常。
 *   所以系统要自己盯着：**攒够了吗？够了我提醒管理员可以升级了。**
 *
 * 阈值怎么定的（这些数字是经验值，全都可解释）：
 *   · MIN_LABELS_TOTAL = 200：少于 200 条，分类器很容易过拟合到几个人的习惯上；
 *   · MIN_PER_CLASS = 40：作弊/正常各至少 40 条。极端不平衡时模型会「全判正常」也能有高准确率，
 *     那种模型毫无用处（漏掉所有作弊），所以两类都要够；
 *   · MIN_PER_SOURCE = 80：微信与 GPS 是两套模型，**各自**都要攒够，不能拿微信的标注去训 GPS。
 *
 * 为什么「自动提示」而不是「自动升级」：
 *   升级有监督模型会**改变判定行为**（可能突然封掉一批以前不封的人），
 *   这种决策必须由人确认。系统只负责在数据够的时候把话说到位，并提供一键查看。
 */
const UPGRADE_RULE = {
  minTotal: 200,
  minPerClass: 40,
  minPerSource: 80,
};

/**
 * 评估「是否可以升级为有监督模型」。
 * @param {boolean} [force] 强制重新统计（否则 5 分钟内走缓存）
 * @returns {Promise<{
 *   ready:boolean, total:number, perSource:object, perClass:object,
 *   missing:string[], rule:object, suggestion:string, progress:number
 * }>}
 */
async function checkUpgradeReadiness(force = false) {
  const STAMP = 5 * 60 * 1000;
  if (!force && UPGRADE_CACHE.at && Date.now() - UPGRADE_CACHE.at < STAMP) return UPGRADE_CACHE.value;

  const out = {
    ready: false,
    total: 0,
    perSource: { werun: { total: 0, cheat: 0, normal: 0 }, gps: { total: 0, cheat: 0, normal: 0 } },
    perClass: { cheat: 0, normal: 0 },
    missing: [],
    rule: { ...UPGRADE_RULE },
    suggestion: '',
    progress: 0,
  };
  try {
    const StepLabel = require('../models/step-label');
    const agg = await StepLabel.aggregate([
      {
        $group: {
          _id: { source: '$source', isCheat: '$isCheat' },
          n: { $sum: 1 },
        },
      },
    ]);
    for (const row of agg) {
      const src = row._id && row._id.source === 'gps' ? 'gps' : 'werun';
      const isCheat = !!(row._id && row._id.isCheat);
      out.perSource[src].total += row.n;
      if (isCheat) {
        out.perSource[src].cheat += row.n;
        out.perClass.cheat += row.n;
      } else {
        out.perSource[src].normal += row.n;
        out.perClass.normal += row.n;
      }
      out.total += row.n;
    }

    // 缺什么就明说：管理员看到「还差 62 条作弊标注」比看到「未就绪」有用得多
    if (out.total < UPGRADE_RULE.minTotal) {
      out.missing.push(`总标注还差 ${UPGRADE_RULE.minTotal - out.total} 条`);
    }
    if (out.perClass.cheat < UPGRADE_RULE.minPerClass) {
      out.missing.push(`作弊标注还差 ${UPGRADE_RULE.minPerClass - out.perClass.cheat} 条`);
    }
    if (out.perClass.normal < UPGRADE_RULE.minPerClass) {
      out.missing.push(`正常标注还差 ${UPGRADE_RULE.minPerClass - out.perClass.normal} 条`);
    }
    for (const src of ['werun', 'gps']) {
      const label = src === 'gps' ? 'GPS' : '微信同步';
      if (out.perSource[src].total < UPGRADE_RULE.minPerSource) {
        out.missing.push(`${label} 标注还差 ${UPGRADE_RULE.minPerSource - out.perSource[src].total} 条`);
      }
    }
    out.ready = out.missing.length === 0;

    // 进度条：取三个维度里最小的完成度（短板决定能不能升级）
    const ratios = [
      out.total / UPGRADE_RULE.minTotal,
      out.perClass.cheat / UPGRADE_RULE.minPerClass,
      out.perClass.normal / UPGRADE_RULE.minPerClass,
      out.perSource.werun.total / UPGRADE_RULE.minPerSource,
      out.perSource.gps.total / UPGRADE_RULE.minPerSource,
    ].map((x) => Math.min(1, Math.max(0, x || 0)));
    out.progress = Math.round(Math.min(...ratios) * 100);

    out.suggestion = out.ready
      ? '标注数量已达标：可以升级为有监督模型，判定准确率会有明显提升（建议在数据量再增后操作）。'
      : `继续积累标注即可升级为有监督模型。当前进度 ${out.progress}%：${out.missing.join('；')}`;
  } catch (e) {
    out.suggestion = '标注统计失败（数据库不可用）';
  }
  UPGRADE_CACHE.at = Date.now();
  UPGRADE_CACHE.value = out;
  return out;
}
const UPGRADE_CACHE = { at: 0, value: null };

/**
 * 标注数量变化后清掉缓存，让「异常记录」页立刻看到最新进度 ——
 * 否则管理员刚标完一条，页面还显示上一分钟的数字，会以为没生效。
 */
function invalidateUpgradeCache() {
  UPGRADE_CACHE.at = 0;
  UPGRADE_CACHE.value = null;
}

// ===========================================================================
// ⑤ 对外接口：给一次记录打分（带来源分流）
// ===========================================================================
/**
 * @param {'werun'|'gps'} source
 * @param {object} record 记录数据（werun: steps/deltaSteps/elapsedMs；gps: distance/durationSeconds/routePoints）
 * @param {object} [history] 该用户的历史基线（werun 用）
 * @returns {Promise<{score:number, level:string, reasons:string[], threshold:object}>}
 */
async function evaluate(source, record, history = {}) {
  const model = await getModel(source);
  const order = source === 'werun' ? WERUN_ORDER : GPS_ORDER;
  const feat = source === 'werun' ? werunFeatures({ record, history }) : gpsFeatures({ record, history });
  const vector = toVector(feat, order);
  const modelScore = scoreForest(model, vector);

  // ===== 物理约束层（与模型分数取 max，不取代模型）=====
  //
  // 为什么必须有这一层：Isolation Forest 学的是「历史数据里什么罕见」，
  // 而 GPS 的训练集里**几乎没有作弊样本**（真人跑出来的都正常），
  // 于是模型对「配速 1.5 分/公里」这种从未见过的极端值给不出高分
  // （实测只有 0.60，被判 ok —— 这显然不对）。
  // 物理约束恰好补这个盲区：**有些事人根本做不到**，与「罕不罕见」无关。
  //   · 模型擅长：抓「组合上的不协调」（步数不大但增速与同步节奏矛盾这类）
  //   · 物理约束擅长：抓「绝对不可能」（配速快于世界纪录、步数超生理上限）
  // 两者并列，取较大值；任一命中都要给管理员看到理由。
  const hardScore = physicalScore(source, feat);
  const score = Math.max(modelScore, hardScore.score);

  const th = currentThreshold();
  let level = 'ok';
  if (score >= th.autoBan) level = 'autoBan';
  else if (score >= th.suspicious) level = 'suspicious';

  // 可解释性：把「最偏离」的特征挑出来，管理员才知道为什么判异常。
  // 物理约束命中的理由优先展示（它比模型分更硬、更容易说服人）。
  // 合并后必须**语义去重**（否则「同步增速 50 步/秒」会以 3 种写法出现 3 次）
  const reasons = dedupeReasons([...hardScore.reasons, ...explain(source, feat, score)]).slice(0, 4);
  // features 一并返回：调用方要把它存进异常记录，供将来训练有监督模型用
  return { score, level, reasons, threshold: th, modelRows: model ? model.rows : 0, modelScore, hardScore: hardScore.score, features: feat };
}

/**
 * 物理约束：人做不到的事。返回一个 0~1 的分数（>= autoBan 阈值即直接封）。
 *
 * 阈值取自运动生理学/世界纪录，留了余量，不会误伤真实高手：
 *   配速：世界纪录约 2'50"/km（男子）。设 3 分钟/公里为绝对下限，慢于此不管。
 *   速度：人类短跑极速约 12.4 m/s，但那是 100m 冲刺；GPS 记录通常是长跑，按 12 m/s 封顶。
 *   步数：单日极限按 10 万步（超马选手的极端值）封顶。
 */
function physicalScore(source, feat) {
  const reasons = [];
  let score = 0;

  if (source === 'gps') {
    // 配速快于 3 分钟/公里（= 180 秒）→ 人类极限之外
    if (feat.paceSecPerKm > 0 && feat.paceSecPerKm < 180) {
      score = Math.max(score, 0.92);
      reasons.push(`配速 ${(feat.paceSecPerKm / 60).toFixed(1)} 分/公里，快于人类极限`);
    }
    // 平均速度 > 12 m/s（43 km/h）→ 只可能是骑电动车/开车
    if (feat.speed > 12) {
      score = Math.max(score, 0.92);
      reasons.push(`平均速度 ${(feat.speed * 3.6).toFixed(0)} km/h，超过人类跑速`);
    }
    // 距离与轨迹点严重不匹配：不到 10 个点却有 1 公里以上 → 中间是「跳」过去的
    if (feat.pointCount > 0 && feat.pointCount < 10 && feat.distance > 1000) {
      score = Math.max(score, 0.85);
      reasons.push(`仅 ${feat.pointCount} 个轨迹点却记录 ${Math.round(feat.distance)} 米`);
    }
    // 短时长配长距离（10 分钟内跑 5 公里以上）
    if (feat.duration > 0 && feat.duration < 600 && feat.distance > 5000) {
      score = Math.max(score, 0.9);
      reasons.push(`${Math.round(feat.duration / 60)} 分钟记录 ${(feat.distance / 1000).toFixed(1)} 公里`);
    }
  } else {
    // 微信同步：单日步数超生理上限
    if (feat.steps > 100000) {
      score = Math.max(score, 0.95);
      reasons.push(`单日 ${feat.steps} 步，超出人类生理上限`);
    } else if (feat.steps > 70000) {
      score = Math.max(score, 0.8);
      reasons.push(`单日 ${feat.steps} 步异常偏高`);
    }
    // 增速：>15 步/秒 持续（等于每秒跨 15 步）
    if (feat.perSec > 15) {
      score = Math.max(score, 0.9);
      reasons.push(`同步增速 ${feat.perSec.toFixed(1)} 步/秒，机器写入特征`);
    }
  }
  return { score, reasons };
}

/**
 * 解释性：按特征偏离程度排序，取最主要的两条。
 * 这是「可解释 AI」的最小实现 —— 没有它，管理员无法信任模型的判断。
 */
function explain(source, feat, score) {
  if (score < 0.55) return [];
  const out = [];
  if (source === 'werun') {
    if (feat.pattern >= 1) out.push('步数是重复/顺序数字');
    if (feat.roundness >= 3) out.push(`步数末位有 ${feat.roundness} 个 0（整数化）`);
    if (feat.perSec > 8) out.push(`同步增速 ${feat.perSec.toFixed(1)} 步/秒`);
    if (feat.z > 4) out.push(`步数偏离本人基线 ${feat.z.toFixed(1)} 倍`);
    if (feat.zeroDeltaStreak >= 5) out.push('同日多次同步但步数不涨');
  } else {
    // 配速的「人类极限」判据已由 physicalScore 给出，这里不重复（避免同一理由出现两次）
    if (feat.paceSecPerKm > 180 && feat.paceSecPerKm < 240) {
      out.push(`配速 ${(feat.paceSecPerKm / 60).toFixed(1)} 分/公里偏快`);
    }
    if (feat.jitter > 3) out.push('轨迹平滑度异常（相邻位移方差过大）');
    if (feat.sparse > 2000) out.push('轨迹点过少但与距离不匹配');
    if (feat.gapMax > 120000) out.push('轨迹存在超长间隔（定位中断）');
  }
  return out.slice(0, 3);
}

/**
 * 理由去重（**语义级，不是字符串级**）。
 *
 * 用户 2026-10-27 反馈列表里同一件事出现两三次：
 *   「步数增速 168.5 步/秒」「同步增速 50.0 步/秒，机器写入特征」「同步增速 50.0 步/秒」
 * 字符串去重对此无效（文字不同、含义相同）。这里按「类别」归一：
 *   · 同一类别只保留一条，优先保留**信息更多**的（带具体数字的胜过泛指）；
 *   · 类别由关键词识别（数字模式 / 整数化 / 增速 / 基线 / 单日总量 / 配速 / 平滑度 …）。
 * 这样管理员看到的永远是「几条不同的问题」，而不是同一句话的几种写法。
 */
const REASON_KINDS = [
  { kind: 'pattern', re: /重复|顺序数字/ },
  { kind: 'round', re: /整数化|末位/ },
  { kind: 'rate', re: /增速|步\/秒/ },
  { kind: 'baseline', re: /基线/ },
  { kind: 'daily', re: /单日|生理上限/ },
  { kind: 'pace', re: /配速/ },
  { kind: 'speed', re: /速度|km\/h/ },
  { kind: 'jitter', re: /平滑度/ },
  { kind: 'sparse', re: /轨迹点/ },
  { kind: 'gap', re: /间隔/ },
  { kind: 'sync', re: /步数不涨|无变化/ },
];

function dedupeReasons(list) {
  const best = new Map();
  for (const raw of list || []) {
    const text = String(raw || '').trim();
    if (!text) continue;
    const hit = REASON_KINDS.find((k) => k.re.test(text));
    const kind = hit ? hit.kind : text; // 认不出类别的按原文各自保留
    const prev = best.get(kind);
    const hasNum = /\d/.test(text);
    const prevHasNum = prev ? /\d/.test(prev) : false;
    if (!prev || (hasNum && !prevHasNum) || (hasNum === prevHasNum && text.length > prev.length)) {
      best.set(kind, text);
    }
  }
  return [...best.values()];
}

/**
 * 只读当前缓存的模型（**不触发训练**）。
 * 管理端「模型状态」用它：否则打开页面就要等 3 秒训练，前端会超时。
 */
function peekModel(source) {
  return cache[source] || null;
}

module.exports = {
  STRICTNESS_PRESETS,
  clearThresholdCache,
  warmThreshold,
  // 特征工程（可用于离线分析 / 单测）
  werunFeatures,
  gpsFeatures,
  physicalScore,
  dedupeReasons,
  // 模型
  buildIsolationForest,
  scoreForest,
  getModel,
  peekModel,
  trainSource,
  evaluate,
  // 反馈学习
  recordFeedback,
  loadFeedback,
  checkUpgradeReadiness,
  invalidateUpgradeCache,
  currentThreshold,
  recalibrateThreshold,
  // 给管理端展示用的常量
  WERUN_ORDER,
  GPS_ORDER,
  BASE_THRESHOLD,
  // 测试用：清缓存
  _clearCache: () => {
    cache.werun = null;
    cache.gps = null;
  },
};
