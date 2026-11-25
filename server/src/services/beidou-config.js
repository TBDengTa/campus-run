const GoalConfig = require('../models/goal-config');
const gridSvc = require('./beidou-grid');
const config = require('../config');

/**
 * ===== 北斗运动 3.0 配置与纯函数（唯一实现）=====
 *
 * 本文件负责：默认值、归一化、保存输入夹紧、有效配置（含概率/期望返还）、启动期配置迁移。
 * 玩法/钱包/盘面分别在 services/beidou.js、beidou-wallet.js、beidou-grid.js。
 *
 * 三条纪律：
 *   ① 概率与期望返还只在这里算（用户端公示、后台预览、端到端验证共用同一份），
 *      前端/路由不得再写一套 —— 否则「后台预览 30%、用户端公示 25%」这类漂移查不出来；
 *   ② 非法配置（权重全 0、奖池全删、九宫格符号不存在）必须**回退默认值**，
 *      绝不能出现「保存成功但永远抽不中」；
 *   ③ 保存输入只夹紧、不静默丢项；真正剔除非法项发生在 buildEffective（后台会显示原因）。
 */

const SECTOR_COUNT = 8;
const DEG_PER_SECTOR = 360 / SECTOR_COUNT;

const LIMITS = {
  coinNameLen: 8,
  welcomeCoins: 1000,
  drawPerWatch: 10,
  videoDailyLimit: 200,
  coinPerClick: 10,
  shareDailyLimit: 200,
  shareTokenExpireDays: 30,
  maxPerDay: 500,
  dailyStepsCap: 200000,
  coinCost: 10000,
  coinPrize: 100000,
  milestoneCoin: 100,
  milestoneDraw: 50,
  milestoneSteps: 50000,
  // 签到固定 7 天一轮；旧配置/页面脏数据最多保留 7 行（用户 2026-11-22 报「后台签到变成 21 行」）
  milestoneCount: 7,
  prizeSteps: 50000,
  prizeWeight: 100000,
  prizeCount: 8,
  gridSymbolCount: 8,
  gridOutcomeCount: 12,
  gridMaxLines: 2,
  pityAfterLosses: 100,
  dailyGameCoinCap: 1000000,
  payoutWarnPercent: 1000,
  highTierWarnPercent: 100,
};

// 整数夹紧：非法值返回 null（调用方按「未配置」处理）
function clampInt(value, max, min = 0) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// 小数夹紧（权重允许 0.1 这类小数）
function clampNum(value, max, min = 0) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

// ===== 默认值（唯一来源；goal-config schema 的 default 只是持久化形态）=====

const DEFAULT_PRIZES = [
  { key: 'coin_2', label: '2 铜版', type: 'coin', amount: 2, weight: 30, tier: 'low' },
  { key: 'coin_5', label: '5 铜版', type: 'coin', amount: 5, weight: 14, tier: 'mid' },
  { key: 'steps_100', label: '100 步', type: 'steps', amount: 100, weight: 20, tier: 'low' },
  { key: 'steps_300', label: '300 步', type: 'steps', amount: 300, weight: 10, tier: 'mid' },
  { key: 'steps_800', label: '800 步', type: 'steps', amount: 800, weight: 4, tier: 'high' },
  { key: 'coin_20', label: '20 铜版', type: 'coin', amount: 20, weight: 2, tier: 'high' },
  { key: 'again', label: '再来一次', type: 'draw', amount: 1, weight: 6, tier: 'none' },
  { key: 'none', label: '谢谢参与', type: 'none', amount: 0, weight: 14, tier: 'none' },
];

// 历史默认奖池（迁移时用于判断老配置形态；不作为 v3 默认）
const LEGACY_DEFAULT_PRIZES = [
  { key: 'steps_100', label: '100 步', type: 'steps', amount: 100, weight: 30 },
  { key: 'steps_300', label: '300 步', type: 'steps', amount: 300, weight: 16 },
  { key: 'steps_800', label: '800 步', type: 'steps', amount: 800, weight: 6 },
  { key: 'steps_1500', label: '1500 步', type: 'steps', amount: 1500, weight: 2 },
  { key: 'again', label: '再来一次', type: 'draw', amount: 1, weight: 8 },
  { key: 'none', label: '谢谢参与', type: 'none', amount: 0, weight: 38 },
];

// 签到阶梯默认值（连续 1~7 天，每天 1 铜版；v3 不再发次数/步数）
const DEFAULT_MILESTONES = Array.from({ length: 7 }, () => ({ coin: 1, draw: 0, steps: 0 }));

const DEFAULT_GRID_SYMBOLS = [
  { key: 'star', label: '星星', icon: '⭐', iconUrl: '', type: 'coin', amount: 5, weight: 30, tier: 'low' },
  { key: 'medal', label: '奖牌', icon: '🏅', iconUrl: '', type: 'coin', amount: 10, weight: 15, tier: 'mid' },
  { key: 'foot', label: '足迹', icon: '👣', iconUrl: '', type: 'steps', amount: 100, weight: 15, tier: 'mid' },
  { key: 'crown', label: '皇冠', icon: '👑', iconUrl: '', type: 'coin', amount: 1, weight: 10, tier: 'high' },
  { key: 'blank', label: '空白', icon: '▫', iconUrl: '', type: 'none', amount: 0, weight: 30, tier: 'none' },
];

// v3 旧「0/1/2 线结果表」：保留作为迁移/旧数据参考，不再参与新玩法
const DEFAULT_GRID_OUTCOMES = [
  { key: 'none', label: '没有连线', lines: 0, symbolKey: '', weight: 60 },
  { key: 'line_star', label: '星星连线', lines: 1, symbolKey: 'star', weight: 22 },
  { key: 'line_medal', label: '奖牌连线', lines: 1, symbolKey: 'medal', weight: 10 },
  { key: 'line_foot', label: '足迹连线', lines: 1, symbolKey: 'foot', weight: 5 },
  { key: 'line_crown', label: '皇冠连线', lines: 1, symbolKey: 'crown', weight: 2 },
  { key: 'line_double_star', label: '星星双线', lines: 2, symbolKey: 'star', weight: 0.9 },
  { key: 'line_double_crown', label: '皇冠双线', lines: 2, symbolKey: 'crown', weight: 0.1 },
];

const DEFAULTS = {
  enabled: true,
  sfxEnabled: true,
  coinName: '铜版',
  welcomeCoins: 10,
  economy: {
    dailyGameCoinCap: 200,
    payoutWarnPercent: 100,
    highTierWarnPercent: 10,
  },
  wheel: {
    enabled: true,
    cost: 5,
    maxPerDay: 0,
    pity: { afterLosses: 5, prizeKey: 'coin_2' },
  },
  grid: {
    enabled: true,
    cost: 6,
    maxPerDay: 0,
    pity: { afterLosses: 5, symbolKey: 'star', outcomeKey: '' },
    symbols: DEFAULT_GRID_SYMBOLS,
    outcomes: DEFAULT_GRID_OUTCOMES,
  },
  video: { enabled: true, coinPerWatch: 1, dailyLimit: 10, adUnitId: '' },
  share: { enabled: true, coinPerClick: 1, dailyLimit: 3, tokenExpireDays: 7 },
  checkin: { enabled: true, loopAfter: true, milestones: DEFAULT_MILESTONES },
  draw: { maxPerDay: 0, dailyStepsCap: 3000 },
};

const PRIZE_TYPES = ['steps', 'coin', 'none', 'draw'];
const TIERS = ['low', 'mid', 'high', 'none'];
const SYMBOL_TYPES = ['coin', 'steps', 'none'];

// ===== 配置读取辅助 =====

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pickObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// ===== 奖池归一 =====

/**
 * 归一化奖池：剔除非法项 → 夹紧数值 → 保证至少有一项非零权重。
 * percent 是折算百分比（两位小数）；用户端公示 / 后台预览都读它。
 */
function normalizePrizes(input) {
  const raw = asArray(input);
  const out = [];
  const seen = new Set();
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const key = String(p.key == null ? '' : p.key).trim().slice(0, 32);
    if (!key || seen.has(key)) continue;
    const type = PRIZE_TYPES.includes(p.type) ? p.type : 'none';
    const weight = clampNum(p.weight, LIMITS.prizeWeight, 0);
    if (!weight) continue;
    let amount = 0;
    if (type === 'steps') {
      amount = clampInt(p.amount, LIMITS.prizeSteps, 1) || 0;
      if (!amount) continue;
    } else if (type === 'coin') {
      amount = clampInt(p.amount, LIMITS.coinPrize, 1) || 0;
      if (!amount) continue;
    } else if (type === 'draw') {
      // 「再来一次」按本局成本返还，amount 只作历史字段；要求 >0 仅为了配置不为空
      amount = clampInt(p.amount, LIMITS.milestoneDraw, 1) || 0;
      if (!amount) continue;
    }
    seen.add(key);
    out.push({
      key,
      label: String(p.label == null ? '' : p.label).trim().slice(0, 20) || key,
      type,
      amount,
      weight,
      tier: TIERS.includes(p.tier) ? p.tier : type === 'none' || type === 'draw' ? 'none' : 'low',
    });
    if (out.length >= LIMITS.prizeCount) break;
  }
  if (!out.length) return normalizePrizes(DEFAULT_PRIZES);
  const total = out.reduce((s, p) => s + p.weight, 0);
  return out.map((p) => ({
    ...p,
    percent: Math.round((p.weight / total) * 10000) / 100,
  }));
}

/**
 * 奖池 → 8 个扇区（按权重复制填充）。顺序由服务端定，前端不得重排。
 */
function buildSectors(prizes) {
  const list = Array.isArray(prizes) && prizes.length ? prizes : normalizePrizes(null);
  const sectors = list.slice(0, SECTOR_COUNT).map((p) => p.key);
  if (sectors.length >= SECTOR_COUNT) return sectors;
  const pool = [...list].sort((a, b) => b.weight - a.weight);
  let i = 0;
  while (sectors.length < SECTOR_COUNT && pool.length) {
    sectors.push(pool[i % pool.length].key);
    i += 1;
  }
  return sectors;
}

// 给定 roll（0~1）与奖池，返回命中项与扇区下标
function pickPrize(prizes, sectors, roll) {
  const list = Array.isArray(prizes) && prizes.length ? prizes : normalizePrizes(null);
  const secs = Array.isArray(sectors) && sectors.length ? sectors : buildSectors(list);
  const total = list.reduce((s, p) => s + p.weight, 0);
  let acc = 0;
  let hit = list[list.length - 1];
  for (const p of list) {
    acc += p.weight / total;
    if (roll < acc) {
      hit = p;
      break;
    }
  }
  const index = Math.max(0, secs.indexOf(hit.key));
  return { prize: hit, index };
}

// ===== 九宫格配置归一 =====

// 旧配置没有 weight 时按图案给一个可用默认值（迁移/读取兜底）
function defaultSymbolWeight(key, type) {
  const known = DEFAULT_GRID_SYMBOLS.find((s) => s.key === key);
  if (known) return known.weight;
  if (type === 'none') return 30;
  return 10;
}

function normalizeSymbols(input) {
  const raw = asArray(input);
  const out = [];
  const seen = new Set();
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const key = String(s.key == null ? '' : s.key).trim().slice(0, 32);
    if (!key || seen.has(key)) continue;
    const type = SYMBOL_TYPES.includes(s.type) ? s.type : 'none';
    let amount = 0;
    if (type === 'coin') amount = clampInt(s.amount, LIMITS.coinPrize, 1) || 0;
    if (type === 'steps') amount = clampInt(s.amount, LIMITS.prizeSteps, 1) || 0;
    if (type !== 'none' && !amount) continue; // 「0 铜版/0 步」的奖品符号没有意义
    const rawWeight = s.weight === undefined || s.weight === null || s.weight === ''
      ? defaultSymbolWeight(key, type)
      : clampNum(s.weight, LIMITS.prizeWeight, 0);
    const weight = rawWeight == null ? defaultSymbolWeight(key, type) : rawWeight;
    seen.add(key);
    out.push({
      key,
      label: String(s.label == null ? '' : s.label).trim().slice(0, 20) || key,
      icon: String(s.icon == null ? '' : s.icon).trim().slice(0, 4) || '▫',
      iconUrl: String(s.iconUrl == null ? '' : s.iconUrl).trim().slice(0, 512),
      type,
      amount,
      weight,
      tier: TIERS.includes(s.tier) ? s.tier : type === 'none' ? 'none' : 'low',
      // 目标单局获奖概率%（空串=权重模式）；编辑态填概率反解权重的入口字段
      winTarget: s.winTarget === undefined || s.winTarget === null ? '' : String(s.winTarget).trim().slice(0, 8),
    });
    if (out.length >= LIMITS.gridSymbolCount) break;
  }
  if (!out.length) return normalizeSymbols(DEFAULT_GRID_SYMBOLS);
  // 兜底一个空白符号（生成盘面时的填充物）；已满 8 个时替换最后一个
  if (!out.some((s) => s.type === 'none')) {
    if (out.length >= LIMITS.gridSymbolCount) out.pop();
    out.push({ key: 'blank', label: '空白', icon: '▫', iconUrl: '', type: 'none', amount: 0, weight: 30, tier: 'none', winTarget: '' });
  }
  // 目标概率模式（用户 2026-11-25「权重调的是单局获奖概率」）：填了 winTarget 的奖品符号
  // 由目标获奖概率反解单格概率 p，weight = p×10000；未填目标的符号（含空白）按现有权重占比
  // 分剩余概率。Σp>1 不可实现 → 目标概率按比例缩放，最终以「单局获奖概率」显示值为准。
  const targeted = out.filter((s) => s.type !== 'none' && s.winTarget !== '');
  if (targeted.length) {
    let ps = targeted.map((s) => gridSvc.cellProbForWinProbability(clampNum(s.winTarget, 100, 0) / 100));
    let sumT = ps.reduce((a, b) => a + b, 0);
    if (sumT > 1) ps = ps.map((p) => p / sumT);
    const rest = Math.max(0, 1 - ps.reduce((a, b) => a + b, 0));
    const others = out.filter((s) => !targeted.includes(s));
    const wSum = others.reduce((a, s) => a + (Number(s.weight) || 0), 0);
    others.forEach((s) => {
      s.weight = Math.round(rest * (wSum > 0 ? (Number(s.weight) || 0) / wSum : 1 / others.length) * 10000);
    });
    targeted.forEach((s, i) => { s.weight = Math.round(ps[i] * 10000); });
  }
  // 至少要有一个「有权重、会中奖」的奖品符号，否则九宫格永远不会中奖
  if (!out.some((s) => s.type !== 'none' && s.weight > 0)) return normalizeSymbols(DEFAULT_GRID_SYMBOLS);
  // 补归一概率（单格出现率）与期望线数（8 * p^3）
  const total = out.reduce((sum, s) => sum + (Number(s.weight) || 0), 0);
  return out.map((s) => {
    const p = total > 0 ? (Number(s.weight) || 0) / total : 0;
    return {
      ...s,
      percent: Math.round(p * 10000) / 100,
      // 空白不会兑奖，期望中奖线数按 0 展示（避免后台把空白线也算进返奖）
      expectedLines: s.type === 'none' ? 0 : Math.round(8 * p * p * p * 10000) / 10000,
      // 单局获奖概率（≥1 线，容斥精确）：管理端编辑态展示口径，不是单格概率
      winPercent: s.type === 'none' ? 0 : Math.round(gridSvc.lineWinProbability(p) * 10000) / 100,
    };
  });
}

// 内置图标 seed（用户 2026-11-25「上传不上去请直接添加」）：皇冠/红星/1 铜币随仓库部署在
// /beidou/*.png；启动时**只补空** iconUrl（star/crown）与空 coinIconUrl，绝不覆盖管理员上传的图；幂等。
const BUILTIN_ICON_FILES = { star: 'star.png', crown: 'crown.png' };
async function seedBeidouBuiltinIcons() {
  const base = config.publicBaseUrl || config.adPageBaseUrl;
  if (!base) return { seeded: [] };
  const doc = await GoalConfig.getSingleton();
  const b = doc.beidou || {};
  const seeded = [];
  const symbols = Array.isArray(b.grid && b.grid.symbols) ? b.grid.symbols : [];
  for (const s of symbols) {
    const file = BUILTIN_ICON_FILES[s.key];
    if (file && !s.iconUrl) {
      s.iconUrl = `${base}/beidou/${file}`;
      seeded.push(`symbol:${s.key}`);
    }
  }
  if (!b.coinIconUrl) {
    b.coinIconUrl = `${base}/beidou/coin.png`;
    seeded.push('coinIcon');
  }
  if (!seeded.length) return { seeded: [] };
  doc.beidou = b;
  await doc.save();
  return { seeded };
}

function normalizeOutcomes(input, symbols) {
  const syms = Array.isArray(symbols) && symbols.length ? symbols : normalizeSymbols(null);
  const symMap = new Map(syms.map((s) => [s.key, s]));
  const raw = asArray(input);
  const out = [];
  const seen = new Set();
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue;
    const key = String(o.key == null ? '' : o.key).trim().slice(0, 32);
    if (!key || seen.has(key)) continue;
    const weight = clampNum(o.weight, LIMITS.prizeWeight, 0);
    if (!weight) continue;
    const lines = clampInt(o.lines, LIMITS.gridMaxLines, 0) || 0;
    const symbolKey = String(o.symbolKey || '').trim().slice(0, 32);
    if (lines > 0) {
      const sym = symMap.get(symbolKey);
      // 线数 >0 必须指向一个存在的奖品符号；否则这条结果无法生成盘面
      if (!sym || sym.type === 'none') continue;
    }
    seen.add(key);
    out.push({
      key,
      label: String(o.label == null ? '' : o.label).trim().slice(0, 20) || key,
      lines,
      symbolKey: lines > 0 ? symbolKey : '',
      weight,
    });
    if (out.length >= LIMITS.gridOutcomeCount) break;
  }
  if (!out.length) return normalizeOutcomes(DEFAULT_GRID_OUTCOMES, syms);
  const total = out.reduce((s, o) => s + o.weight, 0);
  return out.map((o) => ({
    ...o,
    percent: Math.round((o.weight / total) * 10000) / 100,
  }));
}

// ===== 保存输入归一（只夹紧，不静默丢项）=====

function normalizeBeidouInput(input = {}) {
  const out = {};
  if (input.enabled !== undefined) out.enabled = input.enabled !== false;
  if (input.sfxEnabled !== undefined) out.sfxEnabled = input.sfxEnabled !== false;
  if (input.coinName !== undefined) {
    out.coinName = String(input.coinName || '').trim().slice(0, LIMITS.coinNameLen) || '铜版';
  }
  if (input.coinIconUrl !== undefined) {
    out.coinIconUrl = String(input.coinIconUrl || '').trim().slice(0, 512);
  }
  if (input.welcomeCoins !== undefined) {
    const v = clampInt(input.welcomeCoins, LIMITS.welcomeCoins, 0);
    if (v !== null) out.welcomeCoins = v;
  }

  if (input.economy && typeof input.economy === 'object') {
    out.economy = {};
    const map = [
      ['dailyGameCoinCap', LIMITS.dailyGameCoinCap],
      ['payoutWarnPercent', LIMITS.payoutWarnPercent],
      ['highTierWarnPercent', LIMITS.highTierWarnPercent],
    ];
    for (const [k, max] of map) {
      const v = clampInt(input.economy[k], max, 0);
      if (v !== null) out.economy[k] = v;
    }
  }

  if (input.wheel && typeof input.wheel === 'object') {
    out.wheel = {};
    if (input.wheel.enabled !== undefined) out.wheel.enabled = input.wheel.enabled !== false;
    for (const [k, max] of [['cost', LIMITS.coinCost], ['maxPerDay', LIMITS.maxPerDay]]) {
      const v = clampInt(input.wheel[k], max, 0);
      if (v !== null) out.wheel[k] = v;
    }
    if (input.wheel.pity && typeof input.wheel.pity === 'object') {
      out.wheel.pity = {};
      const after = clampInt(input.wheel.pity.afterLosses, LIMITS.pityAfterLosses, 0);
      if (after !== null) out.wheel.pity.afterLosses = after;
      if (input.wheel.pity.prizeKey !== undefined) {
        out.wheel.pity.prizeKey = String(input.wheel.pity.prizeKey || '').trim().slice(0, 32);
      }
    }
  }

  if (input.grid && typeof input.grid === 'object') {
    out.grid = {};
    if (input.grid.enabled !== undefined) out.grid.enabled = input.grid.enabled !== false;
    for (const [k, max] of [['cost', LIMITS.coinCost], ['maxPerDay', LIMITS.maxPerDay]]) {
      const v = clampInt(input.grid[k], max, 0);
      if (v !== null) out.grid[k] = v;
    }
    if (input.grid.pity && typeof input.grid.pity === 'object') {
      out.grid.pity = {};
      const after = clampInt(input.grid.pity.afterLosses, LIMITS.pityAfterLosses, 0);
      if (after !== null) out.grid.pity.afterLosses = after;
      if (input.grid.pity.symbolKey !== undefined) {
        out.grid.pity.symbolKey = String(input.grid.pity.symbolKey || '').trim().slice(0, 32);
      }
      // 旧字段保留（不再使用）
      if (input.grid.pity.outcomeKey !== undefined) {
        out.grid.pity.outcomeKey = String(input.grid.pity.outcomeKey || '').trim().slice(0, 32);
      }
    }
    if (Array.isArray(input.grid.symbols)) {
      out.grid.symbols = input.grid.symbols.slice(0, LIMITS.gridSymbolCount).map((s) => ({
        key: String((s && s.key) || '').trim().slice(0, 32),
        label: String((s && s.label) || '').trim().slice(0, 20),
        icon: String((s && s.icon) || '').trim().slice(0, 4),
        iconUrl: String((s && s.iconUrl) || '').trim().slice(0, 512),
        type: SYMBOL_TYPES.includes(s && s.type) ? s.type : 'none',
        amount: clampInt(s && s.amount, LIMITS.coinPrize, 0) || 0,
        // 权重显式回传 0 = 该图案不再出现；未回传=默认
        weight: clampNum(s && s.weight, LIMITS.prizeWeight, 0) || 0,
        tier: TIERS.includes(s && s.tier) ? s.tier : 'none',
        // 目标单局获奖概率%（编辑态填概率反解权重）；空串=权重模式
        winTarget: s && s.winTarget !== undefined && s.winTarget !== null ? String(s.winTarget).trim().slice(0, 8) : '',
      }));
    }
    if (Array.isArray(input.grid.outcomes)) {
      out.grid.outcomes = input.grid.outcomes.slice(0, LIMITS.gridOutcomeCount).map((o) => ({
        key: String((o && o.key) || '').trim().slice(0, 32),
        label: String((o && o.label) || '').trim().slice(0, 20),
        lines: clampInt(o && o.lines, LIMITS.gridMaxLines, 0) || 0,
        symbolKey: String((o && o.symbolKey) || '').trim().slice(0, 32),
        weight: clampNum(o && o.weight, LIMITS.prizeWeight, 0) || 0,
      }));
    }
  }

  if (input.video && typeof input.video === 'object') {
    out.video = {};
    if (input.video.enabled !== undefined) out.video.enabled = input.video.enabled !== false;
    for (const [k, max] of [['coinPerWatch', LIMITS.drawPerWatch], ['dailyLimit', LIMITS.videoDailyLimit]]) {
      const v = clampInt(input.video[k], max, 0);
      if (v !== null) out.video[k] = v;
    }
    if (input.video.adUnitId !== undefined) {
      out.video.adUnitId = String(input.video.adUnitId || '').trim().slice(0, 64);
    }
  }

  if (input.share && typeof input.share === 'object') {
    out.share = {};
    if (input.share.enabled !== undefined) out.share.enabled = input.share.enabled !== false;
    for (const [k, max] of [
      ['coinPerClick', LIMITS.coinPerClick],
      ['dailyLimit', LIMITS.shareDailyLimit],
      ['tokenExpireDays', LIMITS.shareTokenExpireDays],
    ]) {
      const v = clampInt(input.share[k], max, 0);
      if (v !== null) out.share[k] = v;
    }
  }

  if (input.checkin && typeof input.checkin === 'object') {
    out.checkin = {};
    if (input.checkin.enabled !== undefined) out.checkin.enabled = input.checkin.enabled !== false;
    if (input.checkin.loopAfter !== undefined) out.checkin.loopAfter = input.checkin.loopAfter !== false;
    if (Array.isArray(input.checkin.milestones)) {
      out.checkin.milestones = input.checkin.milestones.slice(0, LIMITS.milestoneCount).map((m) => ({
        coin: clampInt(m && m.coin, LIMITS.milestoneCoin, 0) || 0,
        draw: 0,
        steps: 0,
      }));
    }
  }

  if (input.draw && typeof input.draw === 'object') {
    out.draw = {};
    if (input.draw.maxPerDay !== undefined) {
      const v = clampInt(input.draw.maxPerDay, LIMITS.maxPerDay, 0);
      if (v !== null) out.draw.maxPerDay = v;
    }
    if (input.draw.dailyStepsCap !== undefined) {
      const v = clampInt(input.draw.dailyStepsCap, LIMITS.dailyStepsCap, 0);
      if (v !== null) out.draw.dailyStepsCap = v;
    }
  }

  if (Array.isArray(input.prizes)) {
    out.prizes = input.prizes.slice(0, LIMITS.prizeCount).map((p) => {
      const type = PRIZE_TYPES.includes(p && p.type) ? p.type : 'none';
      return {
        key: String((p && p.key) || '').trim().slice(0, 32),
        label: String((p && p.label) || '').trim().slice(0, 20),
        type,
        amount: clampInt(p && p.amount, LIMITS.coinPrize, 0) || 0,
        weight: clampNum(p && p.weight, LIMITS.prizeWeight, 0) || 0,
        tier: TIERS.includes(p && p.tier) ? p.tier : (type === 'none' || type === 'draw' ? 'none' : 'low'),
      };
    });
  }
  return out;
}

// ===== 有效配置（用户端/后台预览共用）=====

function normalizeMilestones(input) {
  const raw = asArray(input);
  if (!raw.length) return DEFAULT_MILESTONES.map((m) => ({ ...m }));
  const list = raw.slice(0, LIMITS.milestoneCount).map((m) => ({
    // v3 只认 coin；旧 draw/steps 不再生效（用户 2026-11-22：签到只发 1 铜版）
    coin: clampInt(m && m.coin, LIMITS.milestoneCoin, 0) || 0,
    draw: 0,
    steps: 0,
  }));
  // 签到固定 7 天一轮：旧配置/脏数据不足 7 行时用默认值补齐，避免用户端格子数量漂移
  while (list.length < LIMITS.milestoneCount) {
    list.push({ ...DEFAULT_MILESTONES[list.length] });
  }
  return list;
}

function cloneDefault(value) {
  if (Array.isArray(value)) return value.map((v) => (v && typeof v === 'object' ? { ...v } : v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = cloneDefault(value[k]);
    return out;
  }
  return value;
}

function wheelEv(prizes, cost) {
  const list = prizes || [];
  const coin = list.reduce((s, p) => {
    const pct = Number(p.percent) || 0;
    if (p.type === 'coin') return s + (pct / 100) * (Number(p.amount) || 0);
    if (p.type === 'draw') return s + (pct / 100) * cost;
    return s;
  }, 0);
  const steps = list.reduce(
    (s, p) => s + (p.type === 'steps' ? (Number(p.percent) || 0) / 100 * (Number(p.amount) || 0) : 0),
    0
  );
  const high = list.reduce(
    (s, p) => s + (p.tier === 'high' ? Number(p.percent) || 0 : 0),
    0
  );
  return {
    coinReturn: Math.round(coin * 100) / 100,
    stepReturn: Math.round(steps * 100) / 100,
    returnRate: cost > 0 ? Math.round((coin / cost) * 10000) / 100 : 0,
    highTierPercent: Math.round(high * 100) / 100,
  };
}

// 老虎机式九宫格：单格概率 p，8 条线期望中奖线数 = 8p³
function gridEv(symbols, cost) {
  let coin = 0;
  let steps = 0;
  let high = 0;
  let expectedLines = 0;
  for (const s of symbols || []) {
    const p = (Number(s.percent) || 0) / 100;
    const lines = 8 * p * p * p;
    if (s.type !== 'none') expectedLines += lines;
    if (s.type === 'coin') coin += lines * (Number(s.amount) || 0);
    if (s.type === 'steps') steps += lines * (Number(s.amount) || 0);
    if (s.tier === 'high') high += Number(s.percent) || 0;
  }
  return {
    coinReturn: Math.round(coin * 100) / 100,
    stepReturn: Math.round(steps * 100) / 100,
    returnRate: cost > 0 ? Math.round((coin / cost) * 10000) / 100 : 0,
    highTierPercent: Math.round(high * 100) / 100,
    expectedLines: Math.round(expectedLines * 10000) / 10000,
  };
}

function buildWarnings({ wheel, grid, economy, share, effective }) {
  const w = [];
  const add = (level, code, message) => w.push({ level, code, message });
  if (!effective.prizes.length) add('error', 'no_prize', '转盘奖池为空，将回退默认奖池');
  if (!effective.prizes.some((p) => p.type !== 'none')) add('error', 'no_win_prize', '转盘没有可中奖项，将回退默认奖池');
  if (!effective.prizes.some((p) => p.type === 'coin')) {
    add('warn', 'no_coin_prize', '转盘没有铜版奖：用户只消耗铜版、无法从转盘获得铜版');
  }
  if (!(wheel.cost > 0)) add('warn', 'wheel_cost_zero', '转盘单局成本为 0，存在无限免费抽奖风险');
  if (wheel.ev.returnRate >= economy.payoutWarnPercent) {
    add('warn', 'wheel_return_high', `转盘铜版返还率 ${wheel.ev.returnRate}% ≥ 预警线 ${economy.payoutWarnPercent}%`);
  }
  if (wheel.ev.highTierPercent > economy.highTierWarnPercent) {
    add('warn', 'wheel_high_tier', `转盘高价值奖占比 ${wheel.ev.highTierPercent}% > ${economy.highTierWarnPercent}%`);
  }
  if (!(grid.cost > 0)) add('warn', 'grid_cost_zero', '九宫格单局成本为 0，存在无限免费游玩风险');
  if (!grid.symbols.some((s) => s.type !== 'none' && s.weight > 0)) {
    add('error', 'grid_no_symbol', '九宫格没有可中奖图案（权重>0），将回退默认配置');
  }
  if (!(grid.ev.expectedLines > 0)) {
    add('error', 'grid_no_line', '九宫格期望线数为 0，当前权重下永远连不成线');
  }
  if (!grid.symbols.some((s) => s.type === 'coin')) {
    add('warn', 'grid_no_coin', '九宫格没有铜版奖：用户只消耗铜版、无法从九宫格获得铜版');
  }
  if (grid.ev.returnRate >= economy.payoutWarnPercent) {
    add('warn', 'grid_return_high', `九宫格铜版返还率 ${grid.ev.returnRate}% ≥ 预警线 ${economy.payoutWarnPercent}%`);
  }
  if (grid.ev.highTierPercent > economy.highTierWarnPercent) {
    add('warn', 'grid_high_tier', `九宫格高价值图案单格出现率 ${grid.ev.highTierPercent}% > ${economy.highTierWarnPercent}%`);
  }
  if (!(economy.dailyGameCoinCap > 0)) add('warn', 'game_cap_zero', '每日游戏铜版产出上限为 0（不限），存在通胀风险');
  if (!(wheel.pity.afterLosses > 0)) add('warn', 'wheel_pity_off', '转盘保底已关闭');
  if (!(grid.pity.afterLosses > 0)) add('warn', 'grid_pity_off', '九宫格保底已关闭');
  if (!(share.dailyLimit > 0)) add('warn', 'share_limit_zero', '分享每日奖励次数不限，建议设为 3');
  return w;
}

/**
 * 原始 beidou 段 → 生效配置（用户端/后台预览/迁移共用）。
 * @param {object} raw goal_config.beidou 的普通对象
 */
function buildEffective(raw) {
  const b = pickObject(raw);
  const prizes = normalizePrizes(b.prizes);
  const sectors = buildSectors(prizes);
  const economy = {
    dailyGameCoinCap: clampInt(pickObject(b.economy).dailyGameCoinCap, LIMITS.dailyGameCoinCap, 0) ?? DEFAULTS.economy.dailyGameCoinCap,
    payoutWarnPercent: clampInt(pickObject(b.economy).payoutWarnPercent, LIMITS.payoutWarnPercent, 0) ?? DEFAULTS.economy.payoutWarnPercent,
    highTierWarnPercent: clampInt(pickObject(b.economy).highTierWarnPercent, LIMITS.highTierWarnPercent, 0) ?? DEFAULTS.economy.highTierWarnPercent,
  };
  const wheelCfg = pickObject(b.wheel);
  const wheelPityRaw = pickObject(wheelCfg.pity);
  const wheel = {
    enabled: wheelCfg.enabled !== false,
    cost: clampInt(wheelCfg.cost, LIMITS.coinCost, 0) ?? DEFAULTS.wheel.cost,
    maxPerDay: clampInt(wheelCfg.maxPerDay, LIMITS.maxPerDay, 0) ?? DEFAULTS.wheel.maxPerDay,
    pity: {
      afterLosses: clampInt(wheelPityRaw.afterLosses, LIMITS.pityAfterLosses, 0) ?? DEFAULTS.wheel.pity.afterLosses,
      prizeKey: String(wheelPityRaw.prizeKey || DEFAULTS.wheel.pity.prizeKey).trim().slice(0, 32),
    },
  };
  const gridCfg = pickObject(b.grid);
  const gridPityRaw = pickObject(gridCfg.pity);
  const gridSymbols = normalizeSymbols(gridCfg.symbols);
  // v3 旧结果表仅保留用于兼容/迁移映射，不再参与玩法
  const legacyOutcomes = normalizeOutcomes(gridCfg.outcomes, gridSymbols);
  let pitySymbolKey = String(gridPityRaw.symbolKey || '').trim().slice(0, 32);
  if (!pitySymbolKey && gridPityRaw.outcomeKey) {
    const oldOutcome = legacyOutcomes.find((o) => o.key === gridPityRaw.outcomeKey);
    if (oldOutcome && oldOutcome.symbolKey) pitySymbolKey = oldOutcome.symbolKey;
  }
  if (!pitySymbolKey || !gridSymbols.some((s) => s.key === pitySymbolKey && s.type !== 'none')) {
    const firstPrize = gridSymbols.find((s) => s.type !== 'none' && s.weight > 0);
    pitySymbolKey = firstPrize ? firstPrize.key : '';
  }
  const grid = {
    enabled: gridCfg.enabled !== false,
    cost: clampInt(gridCfg.cost, LIMITS.coinCost, 0) ?? DEFAULTS.grid.cost,
    maxPerDay: clampInt(gridCfg.maxPerDay, LIMITS.maxPerDay, 0) ?? DEFAULTS.grid.maxPerDay,
    pity: {
      afterLosses: clampInt(gridPityRaw.afterLosses, LIMITS.pityAfterLosses, 0) ?? DEFAULTS.grid.pity.afterLosses,
      symbolKey: pitySymbolKey,
    },
  };
  const videoCfg = pickObject(b.video);
  const video = {
    enabled: videoCfg.enabled !== false,
    coinPerWatch: clampInt(videoCfg.coinPerWatch, LIMITS.drawPerWatch, 0) ?? DEFAULTS.video.coinPerWatch,
    dailyLimit: clampInt(videoCfg.dailyLimit, LIMITS.videoDailyLimit, 0) ?? DEFAULTS.video.dailyLimit,
    adUnitId: String(videoCfg.adUnitId || '').trim().slice(0, 64),
  };
  const shareCfg = pickObject(b.share);
  const share = {
    enabled: shareCfg.enabled !== false,
    coinPerClick: clampInt(shareCfg.coinPerClick, LIMITS.coinPerClick, 0) ?? DEFAULTS.share.coinPerClick,
    dailyLimit: clampInt(shareCfg.dailyLimit, LIMITS.shareDailyLimit, 0) ?? DEFAULTS.share.dailyLimit,
    tokenExpireDays: clampInt(shareCfg.tokenExpireDays, LIMITS.shareTokenExpireDays, 1) ?? DEFAULTS.share.tokenExpireDays,
  };
  const checkinCfg = pickObject(b.checkin);
  const checkin = {
    enabled: checkinCfg.enabled !== false,
    loopAfter: checkinCfg.loopAfter !== false,
    milestones: normalizeMilestones(checkinCfg.milestones),
  };
  const drawCfg = pickObject(b.draw);
  const draw = {
    maxPerDay: clampInt(drawCfg.maxPerDay, LIMITS.maxPerDay, 0) ?? DEFAULTS.draw.maxPerDay,
    dailyStepsCap: clampInt(drawCfg.dailyStepsCap, LIMITS.dailyStepsCap, 0) ?? DEFAULTS.draw.dailyStepsCap,
  };

  const wheelWithEv = { ...wheel, prizes, sectors, sectorCount: SECTOR_COUNT, ev: wheelEv(prizes, wheel.cost) };
  const gridWithEv = {
    ...grid,
    symbols: gridSymbols,
    // 旧字段保留（后台不再展示、新玩法不再读取），仅兼容旧客户端/旧数据
    outcomes: legacyOutcomes,
    ev: gridEv(gridSymbols, grid.cost),
  };
  const effective = {
    version: 4,
    enabled: b.enabled !== false,
    sfxEnabled: b.sfxEnabled !== false,
    coinName: (String(b.coinName || '').trim().slice(0, LIMITS.coinNameLen) || DEFAULTS.coinName),
    coinIconUrl: String(b.coinIconUrl || '').trim().slice(0, 512),
    welcomeCoins: clampInt(b.welcomeCoins, LIMITS.welcomeCoins, 0) ?? DEFAULTS.welcomeCoins,
    economy,
    wheel: wheelWithEv,
    grid: gridWithEv,
    video,
    share,
    checkin,
    draw,
    prizes,
    sectors,
    sectorCount: SECTOR_COUNT,
    milestones: checkin.milestones,
  };
  effective.warnings = buildWarnings({ wheel: wheelWithEv, grid: gridWithEv, economy, share, effective });
  return effective;
}

// 未归一的有效配置（给后台编辑用：保留管理员输入的原始权重/数值，只补缺失字段）
function toEditableConfig(raw) {
  const b = pickObject(raw);
  const deep = (defaults, value) => {
    const v = pickObject(value);
    const out = {};
    for (const k of Object.keys(defaults)) {
      if (defaults[k] && typeof defaults[k] === 'object' && !Array.isArray(defaults[k])) {
        out[k] = deep(defaults[k], v[k]);
      } else {
        out[k] = v[k] !== undefined ? v[k] : cloneDefault(defaults[k]);
      }
    }
    // 保留默认值里没有的旧字段（drawPerShare 等），避免后台保存时静默丢失
    for (const k of Object.keys(v)) if (out[k] === undefined) out[k] = v[k];
    return out;
  };
  const editable = deep(DEFAULTS, b);
  const plainOf = (x) => (x && typeof x.toObject === 'function' ? x.toObject() : { ...(x || {}) });
  editable.version = 4;
  editable.enabled = b.enabled !== false;
  editable.sfxEnabled = b.sfxEnabled !== false;
  if (b.coinName !== undefined) editable.coinName = String(b.coinName || '').trim().slice(0, LIMITS.coinNameLen) || DEFAULTS.coinName;
  if (b.coinIconUrl !== undefined) editable.coinIconUrl = String(b.coinIconUrl || '').trim().slice(0, 512);
  if (Array.isArray(b.prizes) && b.prizes.length) {
    editable.prizes = b.prizes.map((p) => {
      const plain = plainOf(p);
      const type = plain.type;
      return {
        ...plain,
        tier: TIERS.includes(plain.tier)
          ? plain.tier
          : (type === 'none' || type === 'draw' ? 'none' : 'low'),
      };
    });
  }
  if (Array.isArray(b.grid && b.grid.symbols) && b.grid.symbols.length) {
    editable.grid.symbols = b.grid.symbols.map((s) => {
      const plain = plainOf(s);
      return {
        ...plain,
        iconUrl: String(plain.iconUrl || '').slice(0, 512),
        weight: plain.weight !== undefined ? plain.weight : defaultSymbolWeight(plain.key, plain.type),
      };
    });
  }
  if (b.grid && b.grid.pity) {
    const pityPlain = plainOf(b.grid.pity);
    editable.grid.pity = {
      ...editable.grid.pity,
      ...pityPlain,
      symbolKey: String(pityPlain.symbolKey || '').slice(0, 32),
    };
  }
  if (Array.isArray(b.grid && b.grid.outcomes) && b.grid.outcomes.length) {
    editable.grid.outcomes = b.grid.outcomes.map(plainOf);
  }
  if (Array.isArray(b.checkin && b.checkin.milestones) && b.checkin.milestones.length) {
    editable.checkin.milestones = b.checkin.milestones.slice(0, LIMITS.milestoneCount).map((m, i) => {
      const plain = plainOf(m);
      return {
        ...plain,
        // 稳定 wx:key：旧数据没有 dayNo 时，后台 wx:for 会因 key 相同在输入时重复渲染（7 行变 21 行）
        dayNo: i + 1,
        coin: clampInt(plain.coin, LIMITS.milestoneCoin, 0) ?? 1,
        draw: 0,
        steps: 0,
      };
    });
  }
  return editable;
}

// 读库 → 生效配置（每次实时读，保存即生效）
async function loadConfig() {
  const doc = await GoalConfig.getSingleton();
  return buildEffective(doc && doc.beidou);
}

/**
 * 启动期配置迁移：v2（抽奖次数）→ v3（铜版经济）→ v4（九宫格随机盘面/图标）。
 *
 * ⚠️ 必须读**原始文档**判断版本：Mongoose 对新字段有 schema default，
 * 直接读 doc.beidou.version 会把老文档也看成新版本，迁移就永远不会跑。
 * 只回填新字段，不覆盖管理员已调过的权重/成本/上限。
 */
async function migrateBeidouConfig() {
  const raw = await GoalConfig.collection.findOne({ key: 'default' });
  if (!raw || !raw.beidou) return { migrated: false, reason: 'no-config' };
  const version = Number(raw.beidou.version) || 0;
  if (version >= 4) return { migrated: false, reason: 'already-v4' };

  const doc = await GoalConfig.getSingleton();
  const b = doc.beidou || {};
  const filled = [];

  // ===== v2 → v3（保留原迁移逻辑；已是 v3 的库直接跳过）=====
  if (version < 3) {
    b.version = 3;
    if (b.coinName === undefined || b.coinName === '') b.coinName = DEFAULTS.coinName;
    if (b.welcomeCoins === undefined) b.welcomeCoins = DEFAULTS.welcomeCoins;
    if (!b.economy) b.economy = { ...DEFAULTS.economy };
    if (!b.wheel) b.wheel = { ...DEFAULTS.wheel, pity: { ...DEFAULTS.wheel.pity } };
    if (!b.wheel.pity) b.wheel.pity = { ...DEFAULTS.wheel.pity };
    if (b.wheel.cost === undefined) b.wheel.cost = DEFAULTS.wheel.cost;
    if (b.wheel.maxPerDay === undefined) b.wheel.maxPerDay = Number(b.draw && b.draw.maxPerDay) || 0;
    if (b.wheel.pity.afterLosses === undefined) b.wheel.pity.afterLosses = DEFAULTS.wheel.pity.afterLosses;
    if (!b.wheel.pity.prizeKey) b.wheel.pity.prizeKey = DEFAULTS.wheel.pity.prizeKey;

    if (!b.grid) b.grid = { ...DEFAULTS.grid, pity: { ...DEFAULTS.grid.pity }, symbols: DEFAULT_GRID_SYMBOLS.map((s) => ({ ...s })), outcomes: DEFAULT_GRID_OUTCOMES.map((o) => ({ ...o })) };
    if (!b.grid.pity) b.grid.pity = { ...DEFAULTS.grid.pity };
    if (b.grid.cost === undefined) b.grid.cost = DEFAULTS.grid.cost;
    if (b.grid.maxPerDay === undefined) b.grid.maxPerDay = 0;
    if (b.grid.pity.afterLosses === undefined) b.grid.pity.afterLosses = DEFAULTS.grid.pity.afterLosses;
    if (!Array.isArray(b.grid.symbols) || !b.grid.symbols.length) b.grid.symbols = DEFAULT_GRID_SYMBOLS.map((s) => ({ ...s }));
    if (!Array.isArray(b.grid.outcomes) || !b.grid.outcomes.length) b.grid.outcomes = DEFAULT_GRID_OUTCOMES.map((o) => ({ ...o }));

    if (!b.video) b.video = { ...DEFAULTS.video };
    if (b.video.coinPerWatch === undefined) b.video.coinPerWatch = DEFAULTS.video.coinPerWatch;
    if (b.video.enabled === undefined) b.video.enabled = true;
    if (b.video.drawPerWatch === undefined) b.video.drawPerWatch = 0;

    if (!b.share) b.share = { ...DEFAULTS.share };
    if (b.share.coinPerClick === undefined) b.share.coinPerClick = DEFAULTS.share.coinPerClick;
    if (b.share.enabled === undefined) b.share.enabled = true;
    if (b.share.tokenExpireDays === undefined) b.share.tokenExpireDays = DEFAULTS.share.tokenExpireDays;
    if (b.share.drawPerShare === undefined) b.share.drawPerShare = 0;

    if (!b.checkin) b.checkin = { enabled: true, loopAfter: true, milestones: DEFAULT_MILESTONES.map((m) => ({ ...m })) };
    if (!Array.isArray(b.checkin.milestones) || !b.checkin.milestones.length) {
      b.checkin.milestones = DEFAULT_MILESTONES.map((m) => ({ ...m }));
    } else {
      b.checkin.milestones = b.checkin.milestones.slice(0, LIMITS.milestoneCount).map((m) => ({
        coin: clampInt(m && m.coin, LIMITS.milestoneCoin, 0) ?? 1,
        draw: 0,
        steps: 0,
      }));
    }

    // 奖池：没有铜版奖就追加默认铜版奖，并裁到 8 项
    let prizes = Array.isArray(b.prizes) ? b.prizes.map((p) => (p && p.toObject ? p.toObject() : p)) : [];
    if (!prizes.some((p) => p && p.type === 'coin')) {
      const additions = DEFAULT_PRIZES.filter((p) => p.type === 'coin');
      if (prizes.length > LIMITS.prizeCount - additions.length) {
        const keep = prizes.slice(0, LIMITS.prizeCount - additions.length);
        const removed = prizes.slice(keep.length).map((p) => (p && p.key) || '?');
        prizes = keep;
        filled.push(`prizes.trim:${removed.join(',')}`);
      }
      prizes = prizes.concat(additions.map((p) => ({ ...p })));
      filled.push('prizes.coin');
    }
    b.prizes = prizes;
  }

  // ===== v3 → v4：九宫格随机盘面 / 图标 / 保底图案 =====
  b.version = 4;
  if (b.coinIconUrl === undefined) b.coinIconUrl = '';
  if (!b.grid) b.grid = { ...DEFAULTS.grid, pity: { ...DEFAULTS.grid.pity } };
  if (!b.grid.pity) b.grid.pity = { ...DEFAULTS.grid.pity };
  if (!Array.isArray(b.grid.symbols) || !b.grid.symbols.length) {
    b.grid.symbols = DEFAULT_GRID_SYMBOLS.map((s) => ({ ...s }));
    filled.push('grid.symbols');
  }
  const rawOutcomes = Array.isArray(b.grid.outcomes) ? b.grid.outcomes : [];
  // 旧 v3 默认图案的金额（用于识别「schema default weight=10」的存量文档）
  const LEGACY_AMOUNTS = { star: 3, medal: 6, foot: 100, crown: 30 };
  b.grid.symbols = b.grid.symbols.map((s) => {
    const plain = s && s.toObject ? s.toObject() : { ...(s || {}) };
    const next = {
      ...plain,
      iconUrl: String(plain.iconUrl || '').slice(0, 512),
    };
    if (next.weight === undefined || next.weight === null || next.weight === '') {
      next.weight = defaultSymbolWeight(next.key, next.type);
      filled.push(`symbol.weight:${next.key}`);
    } else if (
      Number(next.weight) === 10
      && LEGACY_AMOUNTS[next.key] !== undefined
      && Number(next.amount) === LEGACY_AMOUNTS[next.key]
    ) {
      // v3 文档在 schema 新增 weight 后被 Mongoose 自动补成 10；这不是管理员配置的权重
      next.weight = defaultSymbolWeight(next.key, next.type);
      filled.push(`symbol.weight.legacy:${next.key}`);
    }
    return next;
  });
  let pitySymbol = String(b.grid.pity.symbolKey || '').slice(0, 32);
  if (!pitySymbol && b.grid.pity.outcomeKey) {
    const old = rawOutcomes.find((o) => o && o.key === b.grid.pity.outcomeKey);
    if (old && old.symbolKey) pitySymbol = String(old.symbolKey).slice(0, 32);
  }
  if (!pitySymbol || !b.grid.symbols.some((s) => s.key === pitySymbol && s.type !== 'none')) {
    const first = b.grid.symbols.find((s) => s.type !== 'none');
    pitySymbol = first ? first.key : 'star';
  }
  b.grid.pity.symbolKey = pitySymbol;
  // 旧 outcomeKey 保留原值，不再使用
  if (b.grid.pity.outcomeKey === undefined) b.grid.pity.outcomeKey = '';

  await doc.save();
  return {
    migrated: true,
    filled,
    version: 4,
  };
}

module.exports = {
  SECTOR_COUNT,
  DEG_PER_SECTOR,
  LIMITS,
  DEFAULT_PRIZES,
  LEGACY_DEFAULT_PRIZES,
  DEFAULT_MILESTONES,
  DEFAULT_GRID_SYMBOLS,
  DEFAULT_GRID_OUTCOMES,
  DEFAULTS,
  PRIZE_TYPES,
  TIERS,
  SYMBOL_TYPES,
  clampInt,
  clampNum,
  normalizePrizes,
  buildSectors,
  pickPrize,
  normalizeSymbols,
  seedBeidouBuiltinIcons,
  normalizeOutcomes,
  normalizeBeidouInput,
  normalizeMilestones,
  buildEffective,
  toEditableConfig,
  loadConfig,
  migrateBeidouConfig,
  wheelEv,
  gridEv,
};
