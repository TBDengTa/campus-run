/**
 * 微信运动步数的**可疑度检测**（用户 2026-10-27 需求）。
 *
 * 背景：现有反作弊只抓「单次同步暴增」一种形态，用户发现还有两类明显异常没被识别：
 *   ① **整数步数**：真实走路几乎不可能恰好是 10000 / 20000 这种整千整百；
 *      刷步工具/脚本往往直接写入整数。
 *   ② **66666 之类的重复数字**：人为构造的「好看数字」，真实运动不可能出现。
 *   ③ 还有一类：**同一天步数完全不变**地反复同步（脚本空转 / 一次刷到位后不再变），
 *      以及**步数增速超过人类极限**（短时间内涨几万步）。
 *
 * 本文件只做**打分**，不直接封禁 —— 这与现有 anticheat 的分工一致：
 *   · 达到自动封禁阈值（score >= AUTO_BAN_SCORE）→ 交给 anticheat.restrict 自动限制；
 *   · 未达阈值 → 只记一条 suspicious 记录，进「异常记录」列表供管理员**手动**处理。
 *     用户明确要求「对于有异常但是没到自动封禁的记录进行查看可以进行手动封禁」。
 *
 * 打分刻意保守：宁可漏判（管理员还能手动看），也不误封正常人。
 * 每一项都是「真实用户几乎不会出现」的特征，正常跑步（哪怕是马拉松）不会命中。
 */

// ===== 判定阈值 =====
// 自动封禁线：命中的特征越多/越明确，分越高；达到 60 分才自动封
const AUTO_BAN_SCORE = 60;
// 进「异常记录」列表的分数门槛（低于它连记录都不建，避免列表被噪音淹没）
const SUSPICIOUS_SCORE = 30;
// 「涨幅速度」的最小可信时间窗（秒）：短于此的同步间隔不判增速（详见 checkStepRate 注释）
const MIN_WINDOW_SEC = 180;

/**
 * 步数「整数化」程度：真实步数末位通常是随机的，
 * 恰好整千/整千整百的概率极低。
 * @returns {{score:number, hit:boolean, label:string}}
 */
function checkRoundNumber(steps) {
  const n = Number(steps) || 0;
  if (n <= 0) return { score: 0, hit: false, label: '' };
  // 整万（10000 / 20000）：几乎不可能是真实步数
  if (n >= 10000 && n % 10000 === 0) return { score: 45, hit: true, label: `整数步数 ${n}` };
  // 整千（5000 / 8000）
  if (n >= 2000 && n % 1000 === 0) return { score: 35, hit: true, label: `整千步数 ${n}` };
  // 整百（1200 / 3600）—— 真实也可能凑巧，分数低
  if (n >= 1000 && n % 100 === 0) return { score: 12, hit: false, label: `整百步数 ${n}` };
  return { score: 0, hit: false, label: '' };
}

/**
 * 「好看数字」：同一位数字重复（66666 / 88888 / 11111），
 * 或 12345 / 54321 这类顺序数字。真实运动不可能刚好出现。
 */
function checkPatternNumber(steps) {
  const s = String(Math.round(Number(steps) || 0));
  if (s.length < 4) return { score: 0, hit: false, label: '' };
  // 全部同一位数字（66666 / 88888）
  if (/^(\d)\1+$/.test(s)) return { score: 50, hit: true, label: `重复数字 ${s}` };
  // 连续递增 / 递减（12345 / 54321）
  const digits = s.split('').map(Number);
  const asc = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const desc = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  if (asc || desc) return { score: 50, hit: true, label: `顺序数字 ${s}` };
  return { score: 0, hit: false, label: '' };
}

/**
 * 步数增速超过人类极限（"涨幅速度"）。
 *
 * ===== 口径（用户 2026-10-29「同步增速这个有点假很容易误封锁」后重写）=====
 * 原来：perSec = 本次新增 / 距上次同步秒数。
 * 问题：**同步间隔 ≠ 运动时长**，分母根本不代表"这步数是在这段时间里走出来的"。
 * 实测会误判（括号里是旧口径算出的速率）：
 *   · 用户走 30 秒 600 步，然后才打开小程序同步 → 600/30 = 20 步/秒（>12 命中 55 分）
 *   · 用户在办公室走 1000 步、一小时后才同步 → 1000/3600 ≈ 0.28（正常）
 *   · 连点两次刷新（间隔 5 秒，微信补 500 步）→ 100 步/秒（必然命中）
 * 这些都是**人正常走路**，只是"什么时候同步"由用户点按钮决定，与走了多久无关。
 *
 * 新口径：加**最小可信时间窗** MIN_WINDOW_SEC = 180 秒。
 *   · 间隔 < 3 分钟（含连点刷新、短间隔补同步）→ **不判定**，因为这么短的时间窗
 *     里"增量/间隔"的噪声远大于信号，判它只会误伤；
 *   · 间隔 ≥ 3 分钟才用 perSec，且阈值同时按 2 分钟起步的物理上限校准。
 * 为什么是 3 分钟：真人从"开始走"到"值得同步"至少几分钟；短于此的两次同步，
 * 增量反映的是**微信侧延迟**而不是人突然加速（微信步数本身有分钟级聚合延迟）。
 *
 * ⚠️ 保留真正的作弊信号：刷步脚本的特征是**单日总量爆炸**（见 checkDailyCap）
 * 与**固定数字模式**（checkPatternNumber）—— 这两条不受时间窗影响，仍然生效。
 * 增速只是辅助信号，宁可漏判也不误封（漏判有人工复核兜底，误封要学生申诉）。
 *
 * @param {number} deltaSteps 本次新增步数
 * @param {number} elapsedMs 距上次同步的毫秒数（<=0 表示未知，跳过）
 */
function checkStepRate(deltaSteps, elapsedMs) {
  const delta = Number(deltaSteps) || 0;
  const ms = Number(elapsedMs) || 0;
  if (delta <= 0 || ms <= 0) return { score: 0, hit: false, label: '' };
  // 时间窗太短：分母不可信，直接不判（详见上面新口径说明）
  if (ms < MIN_WINDOW_SEC * 1000) return { score: 0, hit: false, label: '' };

  const perSec = delta / (ms / 1000);
  // 阈值提高并拉开档次：人类极速约 5 步/秒（冲刺），长距离平均 2~4。
  // 取 15/20 而非原来的 8/12 —— 8 步/秒对"快走 + 微信补同步"太容易撞上。
  if (perSec >= 20) return { score: 45, hit: true, label: `涨幅速度 ${perSec.toFixed(1)} 步/秒（远超人类极限）` };
  if (perSec >= 15) return { score: 30, hit: true, label: `涨幅速度偏快 ${perSec.toFixed(1)} 步/秒` };
  return { score: 0, hit: false, label: '' };
}

/**
 * 单日步数超物理上限（50000 步 ≈ 全程马拉松两倍）。
 * 超过基本只可能是刷步或设备绑在摇步器上。
 */
function checkDailyCap(steps) {
  const n = Number(steps) || 0;
  if (n >= 80000) return { score: 55, hit: true, label: `单日步数 ${n}（远超人类极限）` };
  if (n >= 60000) return { score: 40, hit: true, label: `单日步数 ${n} 异常偏高` };
  return { score: 0, hit: false, label: '' };
}

/**
 * 综合打分：把一次同步的所有特征汇总成一个结论。
 *
 * @param {object} p
 * @param {number} p.cumulativeSteps 本次同步的当日累计步数
 * @param {number} p.deltaSteps 本次新增步数
 * @param {number} p.elapsedMs 距上次同步的毫秒数
 * @param {number} [p.previousSteps] 今天已记录的步数（用于判断「完全没变」）
 * @param {number} [p.sameValueCount] 今天连续多少次同步步数完全相同（脚本空转特征）
 * @returns {{score:number, level:'ok'|'notice'|'suspicious'|'autoBan', reasons:string[], autoBan:boolean, shouldRecord:boolean}}
 */
function scoreSync({ cumulativeSteps, deltaSteps, elapsedMs, previousSteps, sameValueCount } = {}) {
  const reasons = [];
  let score = 0;

  const checks = [
    checkPatternNumber(cumulativeSteps), // 66666 这种最典型，权重最高
    checkRoundNumber(cumulativeSteps),
    checkStepRate(deltaSteps, elapsedMs),
    checkDailyCap(cumulativeSteps),
  ];
  for (const c of checks) {
    if (c.score > 0) {
      score += c.score;
      if (c.label) reasons.push(c.label);
    }
  }

  // 同日步数完全没变却反复同步：脚本空转 / 刷步工具的心跳。
  // 单独一次不算（用户可能只是来回切页面），连续 5 次以上才提示。
  const same = Number(sameValueCount) || 0;
  if (same >= 5 && Number(deltaSteps) === 0) {
    score += 12;
    reasons.push(`连续 ${same} 次同步步数无变化`);
  }

  let level = 'ok';
  if (score >= AUTO_BAN_SCORE) level = 'autoBan';
  else if (score >= SUSPICIOUS_SCORE) level = 'suspicious';
  else if (score > 0) level = 'notice';

  return {
    score,
    level,
    reasons,
    autoBan: level === 'autoBan',
    // 只有 suspicious / autoBan 才落「异常记录」，notice 级不打扰管理员
    shouldRecord: level === 'suspicious' || level === 'autoBan',
  };
}

module.exports = {
  AUTO_BAN_SCORE,
  SUSPICIOUS_SCORE,
  checkRoundNumber,
  checkPatternNumber,
  checkStepRate,
  checkDailyCap,
  scoreSync,
};
