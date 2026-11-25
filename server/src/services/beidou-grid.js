const crypto = require('crypto');

/**
 * ===== 北斗运动九宫格（老虎机式随机盘面，纯函数唯一实现）=====
 *
 * 用户 2026-11-22 定稿：
 *   · 横线 / 竖线 / 斜线，3 个相同**奖品图案** = 1 线；
 *   · 可以有多个线（最多 8 条），每条线各发一次该图案的单线奖；
 *   · 例：皇冠单线奖 1 铜版，连 1 线得 1，连 2 线得 2；
 *   · 不同图案的线分别累计（可同一局同时发铜版和步数）。
 *
 * 盘面是 9 格按图案 weight 独立抽取（老虎机），不再使用 v3 的「先定 0/1/2 线」结果表。
 * 保底：强制一条线为指定图案，其余 6 格仍随机，额外线照常发奖。
 */

const BOARD_SIZE = 9;
const LINE_COUNT = 8;

// 3 行 + 3 列 + 2 对角线；cells 是 0~8 下标（行优先）
const LINES = [
  { key: 'row0', label: '第 1 行', cells: [0, 1, 2] },
  { key: 'row1', label: '第 2 行', cells: [3, 4, 5] },
  { key: 'row2', label: '第 3 行', cells: [6, 7, 8] },
  { key: 'col0', label: '第 1 列', cells: [0, 3, 6] },
  { key: 'col1', label: '第 2 列', cells: [1, 4, 7] },
  { key: 'col2', label: '第 3 列', cells: [2, 5, 8] },
  { key: 'diag0', label: '主对角线', cells: [0, 4, 8] },
  { key: 'diag1', label: '副对角线', cells: [2, 4, 6] },
];

const SYMBOL_TYPE_NONE = 'none';

// 「单局至少中 1 线该图案」的获奖概率（管理端编辑态展示口径，用户 2026-11-25）：
// 8 条线共享格子、彼此不独立，1-(1-p³)^8 会高估；用容斥精确算。
// 每个非空线子集 S：sign=(-1)^(|S|+1)、指数=|S 的格子并集|，项=sign*p^指数。
// 255 个子集的 (sign, 指数) 与 p 无关，模块级预计算一次。
const WIN_TERMS = (() => {
  const terms = [];
  for (let mask = 1; mask < (1 << LINES.length); mask += 1) {
    const union = new Set();
    let bits = 0;
    for (let i = 0; i < LINES.length; i += 1) {
      if (mask & (1 << i)) {
        bits += 1;
        for (const c of LINES[i].cells) union.add(c);
      }
    }
    terms.push({ sign: bits % 2 === 1 ? 1 : -1, pow: union.size });
  }
  return terms;
})();

function lineWinProbability(p) {
  const x = Math.min(1, Math.max(0, Number(p) || 0));
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let sum = 0;
  for (const t of WIN_TERMS) sum += t.sign * Math.pow(x, t.pow);
  return Math.min(1, Math.max(0, sum));
}

// 获奖概率反解单格概率（管理端「填获奖概率反解权重」，用户 2026-11-25）：
// lineWinProbability 单调递增，二分 60 轮精度 ~1e-18，足够权重取整到 1e-4。
function cellProbForWinProbability(q) {
  const target = Math.min(1, Math.max(0, Number(q) || 0));
  if (target <= 0) return 0;
  if (target >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (lineWinProbability(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function symbolMapOf(symbols) {
  return new Map((symbols || []).map((s) => [s.key, s]));
}

function defaultRand() {
  return crypto.randomInt(0, 1e6) / 1e6;
}

function totalWeightOf(symbols) {
  return (symbols || []).reduce((sum, s) => sum + Math.max(0, Number(s.weight) || 0), 0);
}

// 按 weight 抽一个图案（权重 0 的项不会被抽到）
function pickWeighted(symbols, total, rand) {
  if (!symbols || !symbols.length) return null;
  if (!(total > 0)) return symbols[0];
  let roll = rand() * total;
  for (const s of symbols) {
    const w = Math.max(0, Number(s.weight) || 0);
    if (w <= 0) continue;
    roll -= w;
    if (roll < 0) return s;
  }
  // 浮点误差兜底：返回最后一个有权重的项
  for (let i = symbols.length - 1; i >= 0; i -= 1) {
    if ((Number(symbols[i].weight) || 0) > 0) return symbols[i];
  }
  return symbols[0];
}

/**
 * 找盘面里所有「3 个相同奖品图案」的线。空白（type='none'）成线不算中奖。
 */
function findLines(board, symbols) {
  const map = symbolMapOf(symbols);
  const out = [];
  for (const line of LINES) {
    const keys = line.cells.map((i) => board[i]);
    if (!keys[0] || keys.some((k) => k !== keys[0])) continue;
    const sym = map.get(keys[0]);
    if (!sym || sym.type === SYMBOL_TYPE_NONE) continue;
    out.push({
      key: line.key,
      label: line.label,
      symbolKey: sym.key,
      symbolLabel: sym.label || sym.key,
      type: sym.type,
      amount: Number(sym.amount) || 0,
      cells: line.cells.slice(),
    });
  }
  return out;
}

/**
 * 生成 9 格随机盘面。
 * @param {Array} symbols 归一后的图案表（weight 已夹紧）
 * @param {() => number} [rand] 测试可注入
 * @param {{pitySymbol?:string}} [opts] 保底图案 key（强制一条线）
 */
function drawBoard(symbols, rand = defaultRand, opts = {}) {
  const list = Array.isArray(symbols) && symbols.length ? symbols : [];
  const total = totalWeightOf(list);
  const pick = () => {
    const s = pickWeighted(list, total, rand);
    return s ? s.key : '';
  };
  const board = Array.from({ length: BOARD_SIZE }, () => pick());
  const pitySym = opts.pitySymbol ? symbolMapOf(list).get(opts.pitySymbol) : null;
  if (pitySym && pitySym.type !== SYMBOL_TYPE_NONE) {
    const line = LINES[Math.min(LINES.length - 1, Math.floor(rand() * LINES.length))];
    for (const i of line.cells) board[i] = pitySym.key;
  }
  return board;
}

/**
 * 统计一局盘面的奖励（按图案分组，每组奖励 = 单线奖 × 中奖线数）。
 * @returns {{board, lines, rewards, totalLines, coinAmount, stepsAmount, label}}
 */
function evaluateBoard(board, symbols) {
  const map = symbolMapOf(symbols);
  const lines = findLines(board, symbols);
  const bySymbol = new Map();
  for (const line of lines) {
    const sym = map.get(line.symbolKey);
    if (!sym) continue;
    const row = bySymbol.get(sym.key) || {
      symbolKey: sym.key,
      label: sym.label || sym.key,
      type: sym.type,
      singleAmount: Number(sym.amount) || 0,
      lines: 0,
      tier: sym.tier || 'none',
    };
    row.lines += 1;
    bySymbol.set(sym.key, row);
  }
  const rewards = [...bySymbol.values()].map((r) => ({
    symbolKey: r.symbolKey,
    label: r.label,
    type: r.type,
    lines: r.lines,
    singleAmount: r.singleAmount,
    amount: r.singleAmount * r.lines,
    tier: r.tier,
  }));
  const coinAmount = rewards.filter((r) => r.type === 'coin').reduce((s, r) => s + r.amount, 0);
  const stepsAmount = rewards.filter((r) => r.type === 'steps').reduce((s, r) => s + r.amount, 0);
  const labelParts = rewards.map((r) => `${r.label}×${r.lines}线`);
  return {
    board: (board || []).slice(0, BOARD_SIZE),
    lines,
    rewards,
    totalLines: lines.length,
    coinAmount,
    stepsAmount,
    label: labelParts.length ? labelParts.join(' + ') : '没有连线',
  };
}

// 盘面 → 前端渲染格子（图片/emoji/类型/单线奖）
function boardCells(board, symbols) {
  const map = symbolMapOf(symbols);
  return (board || []).map((key, index) => {
    const s = map.get(key) || { key, label: key, icon: '?', iconUrl: '', type: 'none', amount: 0, tier: 'none' };
    return {
      index,
      symbolKey: s.key,
      label: s.label,
      icon: s.icon,
      iconUrl: s.iconUrl || '',
      type: s.type,
      amount: s.amount,
      tier: s.tier,
    };
  });
}

// 单条线的文案
function linePrizeText(line, symbols, coinName) {
  const map = symbolMapOf(symbols);
  const s = map.get(line.symbolKey);
  if (!s) return line.label;
  if (s.type === 'steps') return `${line.label} · ${s.label} +${s.amount} 步`;
  if (s.type === 'coin') return `${line.label} · ${s.label} +${s.amount} ${coinName || '铜版'}`;
  return line.label;
}

// 整局奖励摘要（服务端拼，前端/后台不再自己映射）
function rewardTextOf(rewards, coinName) {
  if (!rewards || !rewards.length) return '没有连线';
  return rewards
    .map((r) => {
      const unit = r.type === 'coin' ? (coinName || '铜版') : '步';
      return `${r.label} ${r.lines} 线 · +${r.amount} ${unit}`;
    })
    .join('；');
}

module.exports = {
  BOARD_SIZE,
  LINE_COUNT,
  LINES,
  findLines,
  lineWinProbability,
  cellProbForWinProbability,
  drawBoard,
  evaluateBoard,
  boardCells,
  linePrizeText,
  rewardTextOf,
};
