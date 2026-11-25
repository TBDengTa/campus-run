const crypto = require('crypto');

const BeidouDay = require('../models/beidou-day');
const BeidouDraw = require('../models/beidou-draw');
const BeidouShareLink = require('../models/beidou-share-link');
const BeidouShareClick = require('../models/beidou-share-click');
const RunRecord = require('../models/run-record');
const User = require('../models/user');
const wechat = require('./wechat');
const rewardVideoSvc = require('./reward-video');
const walletSvc = require('./beidou-wallet');
const gridSvc = require('./beidou-grid');
const cfgSvc = require('./beidou-config');
const { maskName } = require('./name-mask');
const { todayKey, addDays } = require('../utils/dates');

/**
 * ===== 北斗运动 3.0：铜版经济 + 转盘 + 九宫格连线 + 好友点击归因 =====
 *
 * 方案与口径见 docs/beidou-economy-plan.md（改本文件前必读）。
 * 本文件是**唯一编排实现**：路由只鉴权取参，钱包/盘面/配置分别在
 * beidou-wallet.js / beidou-grid.js / beidou-config.js。
 *
 * 四条必须守住的口径：
 *   ① 任务（看视频/签到/分享）只发铜版，**不再发抽奖次数/步数**；
 *   ② 分享必须「另一个已登录用户点开卡片」才发铜版（自己点/重复点/超限都不发）；
 *   ③ 两个玩法都扣铜版、都可能发铜版；结果（index/board/lines/prize）只由服务端定；
 *   ④ 保底与每日上限是硬约束：连续未中到阈值必中低档奖；游戏铜版/步数/分享都有日上限。
 */

const SECTOR_COUNT = cfgSvc.SECTOR_COUNT;
const DEG_PER_SECTOR = cfgSvc.DEG_PER_SECTOR;
const LIMITS = cfgSvc.LIMITS;
const DEFAULT_PRIZES = cfgSvc.DEFAULT_PRIZES;
const DEFAULT_MILESTONES = cfgSvc.DEFAULT_MILESTONES;

const SHARE_PATH = '/pages/splash/splash';

// ===== 旧来源账本（保留给历史流水筛选/文案；v3 铜版为合并钱包）=====

const SOURCE_ORDER = ['prize', 'checkin', 'video', 'share'];
const SOURCE_USED_FIELD = {
  prize: 'usedPrize',
  checkin: 'usedCheckin',
  video: 'usedVideo',
  share: 'usedShare',
};
const SOURCE_FROM_FIELD = {
  prize: 'fromPrize',
  checkin: 'fromCheckin',
  video: 'fromVideo',
  share: 'fromShare',
};
const SOURCE_TEXT = {
  prize: '再来一次',
  checkin: '签到',
  video: '看视频',
  share: '邀请',
  wallet: '铜版钱包',
  unknown: '未记录',
};
const GAME_TEXT = {
  wheel: '转盘',
  grid: '九宫格',
};
const COIN_SOURCE_TEXT = {
  welcome: '新手赠送',
  video: '看视频',
  checkin: '签到',
  share: '好友点击',
  wheel: '转盘产出',
  grid: '九宫格产出',
  refund: '再来一次返还',
};
const SOURCE_TEXT_LONG = {
  prize: '再来一次（上一次抽奖当场回补）',
  checkin: '签到奖励',
  video: '看视频奖励',
  share: '邀请同学奖励',
  wallet: '铜版钱包（v3 起铜版是合并钱包，无法归属到单一来源）',
  unknown: '未记录（本次改造前的历史数据，或次数账本异常）',
};

function sourceNote() {
  return (
    'v3 起铜版是**合并钱包**：同一笔铜版可能来自签到、看视频、邀请或游戏，' +
    '抽奖时无法再像旧「次数池」那样归属到单一来源，因此新流水的 source 统一记为「铜版钱包」。' +
    '旧记录的 再来一次 → 签到 → 看视频 → 邀请 是历史口径，仅用于回看旧数据；' +
    '要分析当前产出结构请用「铜版流水 / 经济概览」。'
  );
}

// ===== 基础工具 =====

function clampInt(value, max, min = 0) {
  return cfgSvc.clampInt(value, max, min);
}

function dayCoin(day) {
  return (day && day.coin) || {};
}

function dayWheel(day) {
  return (day && day.wheel) || {};
}

function dayGrid(day) {
  return (day && day.grid) || {};
}

async function ensureDay(openid, date) {
  const existing = await BeidouDay.findOne({ openid, date });
  if (existing) return existing;
  try {
    return await BeidouDay.create({ openid, date });
  } catch (e) {
    const doc = await BeidouDay.findOne({ openid, date });
    if (doc) return doc;
    throw e;
  }
}

// 今日可玩局数（以钱包余额 + 每日局数上限计算；旧字段 total/used 仍下发）
function remainingOf(wallet, cfg, day) {
  const cost = (cfg && cfg.wheel && cfg.wheel.cost) || 0;
  const balance = (wallet && wallet.balance) || 0;
  const plays = (dayWheel(day).plays) || 0;
  const max = (cfg && cfg.wheel && cfg.wheel.maxPerDay) || 0;
  const affordable = cost > 0 ? Math.floor(balance / cost) : 0;
  const leftByMax = max > 0 ? Math.max(0, max - plays) : Infinity;
  const remaining = Math.max(0, Math.min(affordable, leftByMax));
  return {
    remaining,
    unlimited: max === 0,
    total: plays + remaining,
    used: plays,
    maxPerDay: max,
    cost,
    balance,
  };
}

// 步数封顶余额（dailyStepsCap = 0 视为不封顶）
function capRemaining(day, cfg) {
  const cap = (cfg && cfg.draw && cfg.draw.dailyStepsCap) || 0;
  const used = (day && day.draw && day.draw.stepsAwarded) || 0;
  if (!cap) return { cap: 0, used, left: Infinity, capped: false };
  return { cap, used, left: Math.max(0, cap - used), capped: used >= cap };
}

function coinState(wallet, day, cfg) {
  const w = wallet || {};
  const c = dayCoin(day);
  const cap = (cfg && cfg.economy && cfg.economy.dailyGameCoinCap) || 0;
  const gameEarned = Number(c.gameEarned) || 0;
  return {
    name: (cfg && cfg.coinName) || '铜版',
    iconUrl: (cfg && cfg.coinIconUrl) || '',
    balance: Number(w.balance) || 0,
    earnedToday: Number(c.earned) || 0,
    spentToday: Number(c.spent) || 0,
    taskEarnedToday: (Number(c.fromVideo) || 0) + (Number(c.fromCheckin) || 0) + (Number(c.fromShare) || 0),
    gameEarnedToday: gameEarned,
    refundedToday: Number(c.refunded) || 0,
    dailyGameCap: cap,
    gameCapLeft: cap ? Math.max(0, cap - gameEarned) : -1,
    gameCapReached: !!cap && gameEarned >= cap,
    welcomeCoins: (cfg && cfg.welcomeCoins) || 0,
    welcomeGranted: !!w.welcomeGranted,
  };
}

// 原子占用一局（每日局数上限；0 = 不限）
async function claimDailyPlay(day, game, max) {
  const field = `${game}.plays`;
  const cond = { _id: day._id };
  if (max > 0) cond.$or = [{ [field]: { $lt: max } }, { [field]: { $exists: false } }];
  const updated = await BeidouDay.findOneAndUpdate(
    cond,
    { $inc: { [field]: 1, ...(game === 'wheel' ? { 'draw.used': 1 } : {}) } },
    { new: true }
  );
  if (!updated) return { ok: false, day };
  return { ok: true, day: updated };
}

async function rollbackDailyPlay(day, game) {
  await BeidouDay.updateOne(
    { _id: day._id },
    { $inc: { [`${game}.plays`]: -1, ...(game === 'wheel' ? { 'draw.used': -1 } : {}) } }
  ).catch(() => {});
}

// ===== 保底选奖 =====

function pickSyntheticNone() {
  return { key: 'none', label: '谢谢参与', type: 'none', amount: 0, weight: 1, tier: 'none', percent: 0 };
}

function pickPityWheel(cfg, wallet) {
  const after = (cfg.wheel.pity && cfg.wheel.pity.afterLosses) || 0;
  const losses = (wallet && wallet.luck && wallet.luck.wheelLosses) || 0;
  if (!after || losses < after) return null;
  const wanted = (cfg.wheel.pity && cfg.wheel.pity.prizeKey) || '';
  let prize = cfg.prizes.find((p) => p.key === wanted && p.type !== 'none');
  if (!prize) {
    const coins = cfg.prizes.filter((p) => p.type === 'coin').sort((a, b) => a.amount - b.amount);
    const steps = cfg.prizes.filter((p) => p.type === 'steps').sort((a, b) => a.amount - b.amount);
    prize = coins[0] || steps[0] || { ...pickSyntheticNone(), key: 'pity_coin', label: '保底 1 铜版', type: 'coin', amount: 1 };
  }
  const index = Math.max(0, cfg.sectors.indexOf(prize.key));
  return { prize, index };
}

function pickPityGrid(cfg, wallet) {
  const after = (cfg.grid.pity && cfg.grid.pity.afterLosses) || 0;
  const losses = (wallet && wallet.luck && wallet.luck.gridLosses) || 0;
  if (!after || losses < after) return null;
  const wanted = (cfg.grid.pity && cfg.grid.pity.symbolKey) || '';
  let sym = cfg.grid.symbols.find((s) => s.key === wanted && s.type !== 'none' && s.weight > 0);
  if (!sym) {
    const candidates = cfg.grid.symbols
      .filter((s) => s.type !== 'none' && s.weight > 0)
      .sort((a, b) => (Number(a.amount) || 0) - (Number(b.amount) || 0));
    sym = candidates[0] || null;
  }
  return sym;
}

// ===== 封顶降级 =====

function applyWheelCaps(prize, day, cfg) {
  let finalPrize = prize;
  let capped = false;
  let coinCapped = false;
  const stepsCap = capRemaining(day, cfg);
  const coinCap = walletSvc.gameCapRemaining(day, cfg);

  if (finalPrize.type === 'steps' && stepsCap.cap && finalPrize.amount > stepsCap.left) {
    finalPrize = cfg.prizes.find((p) => p.type === 'none') || pickSyntheticNone();
    capped = true;
  }
  if (finalPrize.type === 'coin' && coinCap.cap) {
    if (coinCap.left <= 0) {
      finalPrize = cfg.prizes.find((p) => p.type === 'none') || pickSyntheticNone();
      coinCapped = true;
    } else if (finalPrize.amount > coinCap.left) {
      finalPrize = { ...finalPrize, amount: coinCap.left };
      coinCapped = true;
    }
  }
  return { prize: finalPrize, capped, coinCapped, stepsCap, coinCap };
}

function applyGridCaps(evaluation, day, cfg) {
  const stepsCap = capRemaining(day, cfg);
  const coinCap = walletSvc.gameCapRemaining(day, cfg);
  let stepsLeft = stepsCap.cap ? stepsCap.left : Infinity;
  let coinLeft = coinCap.cap ? coinCap.left : Infinity;
  let capped = false;
  let coinCapped = false;
  const rewards = [];
  for (const r of evaluation.rewards || []) {
    const row = { ...r };
    if (row.type === 'coin') {
      if (coinCap.cap) {
        if (coinLeft <= 0) {
          coinCapped = true;
          continue;
        }
        if (row.amount > coinLeft) {
          row.expectedAmount = row.amount;
          row.amount = coinLeft;
          coinCapped = true;
          coinLeft = 0;
        } else {
          coinLeft -= row.amount;
        }
      }
      if (row.amount > 0) rewards.push(row);
    } else if (row.type === 'steps') {
      if (stepsCap.cap && row.amount > stepsLeft) {
        capped = true;
        continue;
      }
      stepsLeft -= row.amount;
      if (row.amount > 0) rewards.push(row);
    }
  }
  const coinAmount = rewards.filter((r) => r.type === 'coin').reduce((s, r) => s + r.amount, 0);
  const stepsAmount = rewards.filter((r) => r.type === 'steps').reduce((s, r) => s + r.amount, 0);
  return {
    rewards,
    coinAmount,
    stepsAmount,
    capped,
    coinCapped,
    coinCap,
    stepsCap,
  };
}

// ===== 一次性入账 =====

async function creditTaskCoin(openid, amount, meta) {
  return walletSvc.creditCoins(openid, amount, meta);
}

// 步数入账（唯一出口之一：游戏中的 steps 奖）
async function grantSteps(openid, date, amount) {
  if (!(amount > 0)) return;
  const est = wechat.estimateFromSteps(amount);
  await RunRecord.findOneAndUpdate(
    { openid, date, source: 'beidou' },
    {
      $inc: { steps: amount, distance: est.distance, calories: est.calories, durationSeconds: est.durationSeconds },
      $setOnInsert: { openid, date, source: 'beidou' },
    },
    { upsert: true }
  );
}

function docPrize(doc) {
  if (!doc) return { type: 'none', amount: 0 };
  return {
    key: doc.prizeKey,
    label: doc.prizeLabel || '',
    type: doc.type || 'none',
    amount: Number(doc.amount) || 0,
  };
}

/**
 * 结算一条已经扣过款的游戏流水（幂等）。
 * 只用 doc.status / stepsSettled / 流水 idemKey 保证重放不双发。
 */
async function settleWheelDraw(doc, cfg) {
  if (!doc) return null;
  if (doc.status === 'settled') return doc;
  if (doc.status === 'failed') return doc;
  const prizeInfo = docPrize(doc);

  let wallet = await walletSvc.getWallet(doc.openid);
  if (!wallet) wallet = await walletSvc.ensureWallet(doc.openid, { welcomeCoins: cfg.welcomeCoins });

  // pending：先扣款（保底进度与余额同一次 CAS）
  if (doc.status === 'pending') {
    const losses = (wallet.luck && wallet.luck.wheelLosses) || 0;
    const nextLosses = prizeInfo.type === 'none' ? losses + 1 : 0;
    const debited = await walletSvc.debitForPlay(doc.openid, doc.cost, 'wheel', {
      losses,
      nextLosses,
      pity: !!doc.pity,
      refId: doc.drawId,
      date: doc.date,
      welcomeOpts: { welcomeCoins: cfg.welcomeCoins },
    });
    if (!debited.ok) {
      await BeidouDraw.updateOne(
        { _id: doc._id },
        { $set: { status: 'failed', failReason: debited.reason || 'debit_failed', balanceAfter: debited.wallet ? debited.wallet.balance : 0 } }
      ).catch(() => {});
      return BeidouDraw.findById(doc._id);
    }
    wallet = debited.wallet;
    doc.status = 'debited';
    doc.balanceAfter = wallet.balance;
    await BeidouDraw.updateOne(
      { _id: doc._id },
      { $set: { status: 'debited', balanceAfter: wallet.balance } }
    ).catch(() => {});
    // 成本日计数（只记一次：status 已从 pending 变 debited）
    await BeidouDay.updateOne(
      { openid: doc.openid, date: doc.date },
      { $inc: { 'coin.spent': doc.cost } }
    ).catch(() => {});
  }

  // debited：发奖（全部走幂等键）
  if (prizeInfo.type === 'coin' && prizeInfo.amount > 0) {
    const r = await creditTaskCoin(doc.openid, prizeInfo.amount, {
      source: 'wheel',
      game: 'wheel',
      refId: doc.drawId,
      idemKey: `prize:${doc.drawId}`,
      date: doc.date,
      note: '转盘铜版奖',
      welcomeOpts: { welcomeCoins: cfg.welcomeCoins },
    });
    if (r && r.wallet) wallet = r.wallet;
    if (!r || !r.duplicated) {
      await BeidouDay.updateOne(
        { openid: doc.openid, date: doc.date },
        { $inc: { 'coin.earned': prizeInfo.amount, 'coin.fromWheel': prizeInfo.amount, 'coin.gameEarned': prizeInfo.amount } }
      ).catch(() => {});
    }
  } else if (prizeInfo.type === 'draw') {
    const refund = doc.cost;
    if (refund > 0) {
      const r = await creditTaskCoin(doc.openid, refund, {
        source: 'refund',
        game: 'wheel',
        refId: doc.drawId,
        idemKey: `refund:${doc.drawId}`,
        date: doc.date,
        note: '转盘再来一次返还',
        welcomeOpts: { welcomeCoins: cfg.welcomeCoins },
      });
      if (r && r.wallet) wallet = r.wallet;
      if (!r || !r.duplicated) {
        await BeidouDay.updateOne(
          { openid: doc.openid, date: doc.date },
          { $inc: { 'coin.refunded': refund, 'coin.earned': refund } }
        ).catch(() => {});
      }
    }
  } else if (prizeInfo.type === 'steps' && prizeInfo.amount > 0 && !doc.stepsSettled) {
    await grantSteps(doc.openid, doc.date, prizeInfo.amount);
    await BeidouDay.updateOne(
      { openid: doc.openid, date: doc.date },
      { $inc: { 'draw.stepsAwarded': prizeInfo.amount } }
    ).catch(() => {});
    doc.stepsSettled = true;
  }

  const finalWallet = await walletSvc.getWallet(doc.openid);
  const settled = await BeidouDraw.findOneAndUpdate(
    { _id: doc._id },
    { $set: { status: 'settled', stepsSettled: !!doc.stepsSettled, balanceAfter: finalWallet ? finalWallet.balance : 0 } },
    { new: true }
  );
  return settled;
}

async function settleGridDraw(doc, cfg) {
  if (!doc) return null;
  if (doc.status === 'settled') return doc;
  if (doc.status === 'failed') return doc;
  const prizeInfo = docPrize(doc);
  // v4 混合奖励：优先用 coinAmount/stepsAmount；旧记录回退单类型
  const hasMixedFields = doc.rewards && doc.rewards.length;
  const coinAmount = hasMixedFields
    ? (Number(doc.coinAmount) || 0)
    : (prizeInfo.type === 'coin' ? prizeInfo.amount : 0);
  const stepsAmount = hasMixedFields
    ? (Number(doc.stepsAmount) || 0)
    : (prizeInfo.type === 'steps' ? prizeInfo.amount : 0);

  let wallet = await walletSvc.getWallet(doc.openid);
  if (!wallet) wallet = await walletSvc.ensureWallet(doc.openid, { welcomeCoins: cfg.welcomeCoins });

  if (doc.status === 'pending') {
    const losses = (wallet.luck && wallet.luck.gridLosses) || 0;
    const nextLosses = coinAmount + stepsAmount > 0 ? 0 : losses + 1;
    const debited = await walletSvc.debitForPlay(doc.openid, doc.cost, 'grid', {
      losses,
      nextLosses,
      pity: !!doc.pity,
      refId: doc.drawId,
      date: doc.date,
      welcomeOpts: { welcomeCoins: cfg.welcomeCoins },
    });
    if (!debited.ok) {
      await BeidouDraw.updateOne(
        { _id: doc._id },
        { $set: { status: 'failed', failReason: debited.reason || 'debit_failed', balanceAfter: debited.wallet ? debited.wallet.balance : 0 } }
      ).catch(() => {});
      return BeidouDraw.findById(doc._id);
    }
    wallet = debited.wallet;
    doc.status = 'debited';
    doc.balanceAfter = wallet.balance;
    await BeidouDraw.updateOne(
      { _id: doc._id },
      { $set: { status: 'debited', balanceAfter: wallet.balance } }
    ).catch(() => {});
    await BeidouDay.updateOne(
      { openid: doc.openid, date: doc.date },
      { $inc: { 'coin.spent': doc.cost } }
    ).catch(() => {});
  }

  if (coinAmount > 0) {
    const r = await creditTaskCoin(doc.openid, coinAmount, {
      source: 'grid',
      game: 'grid',
      refId: doc.drawId,
      idemKey: `prize:${doc.drawId}`,
      date: doc.date,
      note: '九宫格铜版奖',
      welcomeOpts: { welcomeCoins: cfg.welcomeCoins },
    });
    if (r && r.wallet) wallet = r.wallet;
    if (!r || !r.duplicated) {
      await BeidouDay.updateOne(
        { openid: doc.openid, date: doc.date },
        { $inc: { 'coin.earned': coinAmount, 'coin.fromGrid': coinAmount, 'coin.gameEarned': coinAmount } }
      ).catch(() => {});
    }
  }
  if (stepsAmount > 0 && !doc.stepsSettled) {
    await grantSteps(doc.openid, doc.date, stepsAmount);
    await BeidouDay.updateOne(
      { openid: doc.openid, date: doc.date },
      { $inc: { 'draw.stepsAwarded': stepsAmount } }
    ).catch(() => {});
    doc.stepsSettled = true;
  }

  const finalWallet = await walletSvc.getWallet(doc.openid);
  return BeidouDraw.findOneAndUpdate(
    { _id: doc._id },
    { $set: { status: 'settled', stepsSettled: !!doc.stepsSettled, balanceAfter: finalWallet ? finalWallet.balance : 0 } },
    { new: true }
  );
}

// ===== 转盘 =====

async function drawRound(user, { drawId } = {}) {
  const openid = user.openid;
  const date = todayKey();
  const cfg = await cfgSvc.loadConfig();
  if (!cfg.enabled) return { success: false, message: '活动未开启' };
  if (!cfg.wheel.enabled) return { success: false, message: '转盘暂未开放' };

  const nonce = String(drawId || '').trim().slice(0, 64);
  if (!nonce) return { success: false, message: '缺少抽奖凭据' };

  let wallet = await walletSvc.ensureWallet(openid, { welcomeCoins: cfg.welcomeCoins });
  let day = await ensureDay(openid, date);

  // 幂等：同一个 drawId 直接返回上次结果；未结算的续跑
  const dup = await BeidouDraw.findOne({ openid, drawId: nonce });
  if (dup) {
    const settled = await settleWheelDraw(dup, cfg);
    wallet = await walletSvc.getWallet(openid);
    day = await ensureDay(openid, date);
    return buildWheelResult(settled, cfg, wallet, day, { duplicated: true });
  }

  const left = remainingOf(wallet, cfg, day);
  if (left.remaining <= 0) {
    return {
      success: false,
      message: wallet.balance < cfg.wheel.cost ? `铜版不足，还差 ${cfg.wheel.cost - wallet.balance} ${cfg.coinName}，去做任务赚铜版吧` : '今日转盘次数已用完',
      ...left,
      coin: coinState(wallet, day, cfg),
    };
  }

  const claim = await claimDailyPlay(day, 'wheel', cfg.wheel.maxPerDay);
  if (!claim.ok) {
    return { success: false, message: '今日转盘次数已用完', ...left, coin: coinState(wallet, day, cfg) };
  }
  day = claim.day;

  // 保底优先；否则 crypto 随机
  const pityPick = pickPityWheel(cfg, wallet);
  const roll = pityPick ? 0 : crypto.randomInt(0, 1e6) / 1e6;
  const picked = pityPick || cfgSvc.pickPrize(cfg.prizes, cfg.sectors, roll);
  const cappedResult = applyWheelCaps(picked.prize, day, cfg);
  const finalPrize = cappedResult.prize;
  const finalIndex = finalPrize.key === picked.prize.key
    ? picked.index
    : Math.max(0, cfg.sectors.indexOf(finalPrize.key));

  let doc;
  try {
    doc = await BeidouDraw.create({
      openid,
      date,
      drawId: nonce,
      game: 'wheel',
      prizeKey: finalPrize.key,
      prizeLabel: finalPrize.label || '',
      prizePercent: finalPrize.percent || 0,
      tier: finalPrize.tier || 'none',
      type: finalPrize.type,
      amount: finalPrize.amount || 0,
      roll,
      index: finalIndex,
      capped: cappedResult.capped,
      coinCapped: cappedResult.coinCapped,
      pity: !!pityPick,
      cost: cfg.wheel.cost,
      rarity: finalPrize.type === 'none' ? 'none' : rarityOf(finalPrize, cfg.prizes),
      status: 'pending',
      source: 'wallet',
    });
  } catch (e) {
    await rollbackDailyPlay(day, 'wheel');
    const again = await BeidouDraw.findOne({ openid, drawId: nonce });
    if (again) {
      const settled = await settleWheelDraw(again, cfg);
      wallet = await walletSvc.getWallet(openid);
      day = await ensureDay(openid, date);
      return buildWheelResult(settled, cfg, wallet, day, { duplicated: true });
    }
    throw e;
  }

  const settled = await settleWheelDraw(doc, cfg);
  if (settled && settled.status === 'failed') {
    await rollbackDailyPlay(day, 'wheel');
    wallet = await walletSvc.getWallet(openid);
    day = await ensureDay(openid, date);
    return {
      success: false,
      message: settled.failReason === 'insufficient'
        ? `铜版不足，还差 ${Math.max(0, cfg.wheel.cost - ((wallet && wallet.balance) || 0))} ${cfg.coinName}`
        : '操作过于频繁，请稍后再试',
      ...remainingOf(wallet, cfg, day),
      coin: coinState(wallet, day, cfg),
    };
  }

  wallet = await walletSvc.getWallet(openid);
  day = await ensureDay(openid, date);
  return buildWheelResult(settled, cfg, wallet, day);
}

function buildWheelResult(doc, cfg, wallet, day, extra = {}) {
  const left = remainingOf(wallet, cfg, day);
  if (!doc || doc.status === 'failed') {
    return {
      success: false,
      message: doc && doc.failReason === 'insufficient'
        ? `铜版不足，还差 ${Math.max(0, cfg.wheel.cost - ((wallet && wallet.balance) || 0))} ${cfg.coinName}`
        : '抽奖失败，请稍后再试',
      ...left,
      coin: coinState(wallet, day, cfg),
    };
  }
  const prize = docPrize(doc);
  return {
    success: doc.status === 'settled',
    duplicated: !!extra.duplicated,
    drawId: doc.drawId,
    game: 'wheel',
    index: doc.index,
    prize: {
      key: prize.key,
      label: prize.label || doc.prizeLabel || '',
      type: prize.type,
      amount: prize.amount,
      percent: doc.prizePercent || 0,
      tier: doc.tier || 'none',
    },
    capped: !!doc.capped,
    coinCapped: !!doc.coinCapped,
    pity: !!doc.pity,
    rarity: doc.rarity || 'normal',
    cost: doc.cost || 0,
    ...left,
    coin: coinState(wallet, day, cfg),
  };
}

// ===== 九宫格 =====

async function playGrid(user, { playId } = {}) {
  const openid = user.openid;
  const date = todayKey();
  const cfg = await cfgSvc.loadConfig();
  if (!cfg.enabled) return { success: false, message: '活动未开启' };
  if (!cfg.grid.enabled) return { success: false, message: '九宫格暂未开放' };

  const nonce = String(playId || '').trim().slice(0, 64);
  if (!nonce) return { success: false, message: '缺少游戏凭据' };

  let wallet = await walletSvc.ensureWallet(openid, { welcomeCoins: cfg.welcomeCoins });
  let day = await ensureDay(openid, date);

  const dup = await BeidouDraw.findOne({ openid, drawId: nonce });
  if (dup) {
    const settled = await settleGridDraw(dup, cfg);
    wallet = await walletSvc.getWallet(openid);
    day = await ensureDay(openid, date);
    return buildGridResult(settled, cfg, wallet, day, { duplicated: true });
  }

  const cost = cfg.grid.cost;
  const plays = dayGrid(day).plays || 0;
  const max = cfg.grid.maxPerDay || 0;
  if (wallet.balance < cost) {
    return {
      success: false,
      message: `铜版不足，还差 ${cost - wallet.balance} ${cfg.coinName}，去做任务赚铜版吧`,
      balance: wallet.balance,
      coin: coinState(wallet, day, cfg),
    };
  }
  if (max > 0 && plays >= max) {
    return {
      success: false,
      message: '今日九宫格次数已用完',
      balance: wallet.balance,
      coin: coinState(wallet, day, cfg),
    };
  }

  const claim = await claimDailyPlay(day, 'grid', max);
  if (!claim.ok) {
    return { success: false, message: '今日九宫格次数已用完', balance: wallet.balance, coin: coinState(wallet, day, cfg) };
  }
  day = claim.day;

  const pitySymbol = pickPityGrid(cfg, wallet);
  const board = gridSvc.drawBoard(cfg.grid.symbols, undefined, {
    pitySymbol: pitySymbol ? pitySymbol.key : '',
  });
  const evaluation = gridSvc.evaluateBoard(board, cfg.grid.symbols);
  const cappedResult = applyGridCaps(evaluation, day, cfg);
  const coinAmount = cappedResult.coinAmount;
  const stepsAmount = cappedResult.stepsAmount;
  const finalType = coinAmount > 0 && stepsAmount > 0
    ? 'mixed'
    : coinAmount > 0
      ? 'coin'
      : stepsAmount > 0
        ? 'steps'
        : 'none';
  const bestTier = cappedResult.rewards.reduce((best, r) => {
    const rank = { none: 0, low: 1, mid: 2, high: 3 };
    return (rank[r.tier] || 0) > (rank[best] || 0) ? r.tier : best;
  }, 'none');
  const rarity = finalType === 'none'
    ? 'none'
    : bestTier === 'high' || cappedResult.rewards.some((r) => r.lines >= 2)
      ? 'rarest'
      : 'normal';
  const rewardLabel = cappedResult.rewards.length
    ? gridSvc.rewardTextOf(cappedResult.rewards, cfg.coinName)
    : (evaluation.totalLines > 0 ? '连线达成，但今日奖励已达上限' : '没有连线');

  let doc;
  try {
    doc = await BeidouDraw.create({
      openid,
      date,
      drawId: nonce,
      game: 'grid',
      prizeKey: cappedResult.rewards[0] ? cappedResult.rewards[0].symbolKey : 'none',
      prizeLabel: rewardLabel,
      prizePercent: cappedResult.rewards.reduce((m, r) => {
        const sym = cfg.grid.symbols.find((s) => s.key === r.symbolKey);
        return Math.max(m, sym ? Number(sym.percent) || 0 : 0);
      }, 0),
      tier: bestTier,
      type: finalType,
      amount: coinAmount > 0 ? coinAmount : stepsAmount,
      coinAmount,
      stepsAmount,
      rewards: cappedResult.rewards,
      roll: (pitySymbol ? 0 : crypto.randomInt(0, 1e6) / 1e6),
      index: 0,
      capped: cappedResult.capped,
      coinCapped: cappedResult.coinCapped,
      pity: !!pitySymbol,
      cost,
      board,
      lines: evaluation.lines,
      rarity,
      status: 'pending',
      source: 'wallet',
    });
  } catch (e) {
    await rollbackDailyPlay(day, 'grid');
    const again = await BeidouDraw.findOne({ openid, drawId: nonce });
    if (again) {
      const settled = await settleGridDraw(again, cfg);
      wallet = await walletSvc.getWallet(openid);
      day = await ensureDay(openid, date);
      return buildGridResult(settled, cfg, wallet, day, { duplicated: true });
    }
    throw e;
  }

  const settled = await settleGridDraw(doc, cfg);
  wallet = await walletSvc.getWallet(openid);
  day = await ensureDay(openid, date);
  const result = buildGridResult(settled, cfg, wallet, day);
  if (result.success && settled) {
    result.board = gridSvc.boardCells(settled.board, cfg.grid.symbols);
    result.lines = (settled.lines || []).map((l) => ({
      ...l,
      prizeText: gridSvc.linePrizeText(l, cfg.grid.symbols, cfg.coinName),
    }));
  }
  return result;
}

function buildGridResult(doc, cfg, wallet, day, extra = {}) {
  if (!doc || doc.status === 'failed') {
    return {
      success: false,
      message: doc && doc.failReason === 'insufficient'
        ? `铜版不足，还差 ${Math.max(0, cfg.grid.cost - ((wallet && wallet.balance) || 0))} ${cfg.coinName}`
        : '开奖失败，请稍后再试',
      balance: (wallet && wallet.balance) || 0,
      coin: coinState(wallet, day, cfg),
    };
  }
  const lines = (doc.lines || []).map((l) => ({
    key: l.key,
    label: l.label,
    symbolKey: l.symbolKey,
    symbolLabel: l.symbolLabel || '',
    type: l.type || 'none',
    amount: l.amount || 0,
    cells: l.cells || [],
  }));
  const rewards = (doc.rewards || []).map((r) => ({
    symbolKey: r.symbolKey,
    label: r.label,
    type: r.type,
    lines: r.lines,
    singleAmount: r.singleAmount,
    amount: r.amount,
    tier: r.tier,
  }));
  const hasRewards = Array.isArray(doc.rewards) && doc.rewards.length > 0;
  const coinAmount = hasRewards ? (Number(doc.coinAmount) || 0) : (doc.type === 'coin' ? doc.amount : 0);
  const stepsAmount = hasRewards ? (Number(doc.stepsAmount) || 0) : (doc.type === 'steps' ? doc.amount : 0);
  return {
    success: doc.status === 'settled',
    duplicated: !!extra.duplicated,
    playId: doc.drawId,
    game: 'grid',
    outcome: {
      key: doc.prizeKey,
      label: doc.prizeLabel,
      lines: lines.length,
    },
    board: gridSvc.boardCells(doc.board, cfg.grid.symbols),
    lines,
    rewards,
    coinAmount,
    stepsAmount,
    rewardText: doc.prizeLabel || gridSvc.rewardTextOf(rewards, cfg.coinName),
    prize: {
      key: doc.prizeKey,
      label: doc.prizeLabel,
      type: doc.type,
      amount: doc.amount,
      lines: lines.length,
      percent: doc.prizePercent || 0,
      tier: doc.tier || 'none',
      rewards,
      coinAmount,
      stepsAmount,
    },
    capped: !!doc.capped,
    coinCapped: !!doc.coinCapped,
    pity: !!doc.pity,
    rarity: doc.rarity || 'normal',
    cost: doc.cost || 0,
    balance: (wallet && wallet.balance) || 0,
    coin: coinState(wallet, day, cfg),
    ...extra,
  };
}

// ===== 看视频（只发铜版）=====

async function reportVideo(user, { watchId } = {}) {
  const openid = user.openid;
  const date = todayKey();
  const cfg = await cfgSvc.loadConfig();
  if (!cfg.enabled) return { success: false, message: '活动未开启' };
  if (!cfg.video.enabled || !cfg.video.coinPerWatch) return { success: false, message: '看视频暂不发放奖励' };

  const nonce = String(watchId || '').trim().slice(0, 64);
  if (!nonce) return { success: false, message: '缺少观看凭据' };

  let day = await ensureDay(openid, date);
  await walletSvc.ensureWallet(openid, { welcomeCoins: cfg.welcomeCoins });

  if ((day.video.watchIds || []).includes(nonce)) {
    const wallet = await walletSvc.getWallet(openid);
    return { success: true, duplicated: true, gainedCoin: 0, coin: coinState(wallet, day, cfg), video: videoState(day, cfg) };
  }
  if (cfg.video.dailyLimit && day.video.count >= cfg.video.dailyLimit) {
    const wallet = await walletSvc.getWallet(openid);
    return {
      success: false,
      message: `今日看视频次数已达上限（${cfg.video.dailyLimit} 次）`,
      coin: coinState(wallet, day, cfg),
      video: videoState(day, cfg),
    };
  }

  const claimed = await BeidouDay.findOneAndUpdate(
    { _id: day._id, 'video.count': day.video.count, 'video.watchIds': { $ne: nonce } },
    {
      $inc: {
        'video.count': 1,
        'video.coin': cfg.video.coinPerWatch,
        'coin.earned': cfg.video.coinPerWatch,
        'coin.fromVideo': cfg.video.coinPerWatch,
      },
      $push: { 'video.watchIds': { $each: [nonce], $slice: -50 } },
    },
    { new: true }
  );
  if (!claimed) {
    const latest = await BeidouDay.findOne({ openid, date });
    if (latest && (latest.video.watchIds || []).includes(nonce)) {
      const wallet = await walletSvc.getWallet(openid);
      return { success: true, duplicated: true, gainedCoin: 0, coin: coinState(wallet, latest, cfg), video: videoState(latest, cfg) };
    }
    const wallet = await walletSvc.getWallet(openid);
    return { success: false, message: '操作过于频繁，请稍后再试', coin: coinState(wallet, latest || day, cfg) };
  }

  try {
    await creditTaskCoin(openid, cfg.video.coinPerWatch, {
      source: 'video',
      refId: nonce,
      idemKey: `video:${nonce}`,
      date,
      note: '看视频奖励',
      welcomeOpts: { welcomeCoins: cfg.welcomeCoins },
    });
  } catch (e) {
    // 发币失败 → 回滚观看计数，用户可重试
    await BeidouDay.updateOne(
      { _id: claimed._id },
      {
        $inc: { 'video.count': -1, 'video.coin': -cfg.video.coinPerWatch, 'coin.earned': -cfg.video.coinPerWatch, 'coin.fromVideo': -cfg.video.coinPerWatch },
        $pull: { 'video.watchIds': nonce },
      }
    ).catch(() => {});
    throw e;
  }

  const wallet = await walletSvc.getWallet(openid);
  return {
    success: true,
    gainedCoin: cfg.video.coinPerWatch,
    gained: 0, // 旧字段：不再发抽奖次数
    coin: coinState(wallet, claimed, cfg),
    video: videoState(claimed, cfg),
    ...remainingOf(wallet, cfg, claimed),
  };
}

function videoState(day, cfg) {
  const count = (day && day.video && day.video.count) || 0;
  const limit = (cfg.video && cfg.video.dailyLimit) || 0;
  return {
    enabled: cfg.video.enabled !== false,
    coinPerWatch: cfg.video.coinPerWatch || 0,
    dailyLimit: limit,
    count,
    remaining: limit ? Math.max(0, limit - count) : -1,
    adUnitId: (cfg.video && cfg.video.adUnitId) || '',
    drawPerWatch: 0, // 旧字段：不再发次数
  };
}

// ===== 签到（只发铜版）=====

async function checkin(user) {
  const openid = user.openid;
  const date = todayKey();
  const cfg = await cfgSvc.loadConfig();
  if (!cfg.enabled) return { success: false, message: '活动未开启' };
  if (!cfg.checkin.enabled) return { success: false, message: '签到暂未开放' };

  let day = await ensureDay(openid, date);
  await walletSvc.ensureWallet(openid, { welcomeCoins: cfg.welcomeCoins });
  if (day.checkin.done) {
    const wallet = await walletSvc.getWallet(openid);
    return { success: false, duplicated: true, message: '今天已经签到过了', coin: coinState(wallet, day, cfg) };
  }

  const yDoc = await BeidouDay.findOne({ openid, date: addDays(date, -1) }).lean();
  const yStreak = yDoc && yDoc.checkin && yDoc.checkin.done ? yDoc.checkin.streak || 0 : 0;
  const streak = yStreak + 1;

  const ms = cfg.checkin.milestones;
  let idx = streak - 1;
  if (idx >= ms.length) idx = cfg.checkin.loopAfter ? idx % ms.length : ms.length - 1;
  const award = ms[idx] || { coin: 0, draw: 0, steps: 0 };
  const coin = Math.max(0, Number(award.coin) || 0);

  const claimed = await BeidouDay.findOneAndUpdate(
    { _id: day._id, 'checkin.done': false },
    {
      $set: {
        'checkin.done': true,
        'checkin.at': new Date(),
        'checkin.streak': streak,
        'checkin.award': { coin, draw: 0, steps: 0 },
      },
      $inc: { 'coin.earned': coin, 'coin.fromCheckin': coin },
    },
    { new: true }
  );
  if (!claimed) {
    const latest = await BeidouDay.findOne({ openid, date });
    const wallet = await walletSvc.getWallet(openid);
    return { success: false, duplicated: true, message: '今天已经签到过了', coin: coinState(wallet, latest || day, cfg) };
  }

  if (coin > 0) {
    try {
      await creditTaskCoin(openid, coin, {
        source: 'checkin',
        refId: date,
        idemKey: `checkin:${date}`,
        date,
        note: '签到奖励',
        welcomeOpts: { welcomeCoins: cfg.welcomeCoins },
      });
    } catch (e) {
      await BeidouDay.updateOne(
        { _id: claimed._id },
        {
          $set: { 'checkin.done': false, 'checkin.award': { coin: 0, draw: 0, steps: 0 } },
          $inc: { 'coin.earned': -coin, 'coin.fromCheckin': -coin },
        }
      ).catch(() => {});
      throw e;
    }
  }

  const wallet = await walletSvc.getWallet(openid);
  return {
    success: true,
    streak,
    award: { coin, draw: 0, steps: 0 },
    gainedCoin: coin,
    coin: coinState(wallet, claimed, cfg),
  };
}

// ===== 分享（好友点开才发铜版）=====

function sharePathOf(token) {
  return `${SHARE_PATH}?bdshare=${encodeURIComponent(token)}`;
}

async function ensureShareToken(user, cfg) {
  const openid = user.openid;
  const date = todayKey();
  const days = Math.max(1, (cfg.share && cfg.share.tokenExpireDays) || 7);
  const now = new Date();
  const existing = await BeidouShareLink.findOne({ ownerOpenid: openid, date });
  if (existing && existing.expiresAt && new Date(existing.expiresAt).getTime() > now.getTime()) {
    return { token: existing.token, path: sharePathOf(existing.token), expiresAt: existing.expiresAt };
  }
  for (let i = 0; i < 3; i += 1) {
    const token = crypto.randomBytes(16).toString('hex');
    try {
      const doc = await BeidouShareLink.findOneAndUpdate(
        { ownerOpenid: openid, date },
        {
          $set: { token, expiresAt: new Date(now.getTime() + days * 86400000) },
          $setOnInsert: { ownerOpenid: openid, date, clicks: 0, rewarded: 0 },
        },
        { upsert: true, new: true }
      );
      return { token: doc.token, path: sharePathOf(doc.token), expiresAt: doc.expiresAt };
    } catch (e) {
      // 极小概率 token 撞唯一索引：换一个重试
      if (i === 2) throw e;
    }
  }
  return { token: '', path: SHARE_PATH, expiresAt: null };
}

/**
 * 好友点开分享卡后上报。
 *
 * 归因只认这一次点击：自己点不算、同一好友每天只算一次、分享者每日上限。
 * 这里不暴露分享者身份给点击者；返回值只说明「这次助力是否成功」。
 */
async function reportShareClick(user, { token } = {}) {
  const visitor = user;
  const openid = visitor.openid;
  const date = todayKey();
  const cfg = await cfgSvc.loadConfig();
  if (!cfg.enabled) return { success: false, message: '活动未开启' };
  if (!cfg.share.enabled) return { success: false, message: '分享暂未开放' };
  const raw = String(token || '').trim();
  if (!/^[a-f0-9]{16,64}$/i.test(raw)) return { success: false, message: '分享链接无效' };

  const link = await BeidouShareLink.findOne({ token: raw });
  if (!link) return { success: false, message: '分享链接已失效' };
  if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
    return { success: false, message: '分享链接已过期' };
  }
  if (link.ownerOpenid === openid) {
    return { success: false, self: true, message: '不能给自己助力' };
  }

  const owner = await User.findOne({ openid: link.ownerOpenid }).select('openid role status').lean();
  if (!owner || owner.role === 'teacher' || owner.status === 'banned') {
    return { success: false, message: '分享者账号不可用' };
  }
  if (visitor.role === 'teacher') return { success: false, message: '教师账号不参与该活动' };
  if (visitor.status === 'banned') return { success: false, message: '账号已被限制' };

  // 同一好友每天只助力一次（唯一索引兜底）
  let click;
  try {
    click = await BeidouShareClick.create({
      token: raw,
      ownerOpenid: link.ownerOpenid,
      visitorOpenid: openid,
      date,
      rewarded: false,
      coin: 0,
    });
  } catch (e) {
    if (e && (e.code === 11000 || /duplicate key/i.test(String(e.message || '')))) {
      return { success: false, duplicated: true, message: '今天已经助力过了' };
    }
    throw e;
  }

  const ownerDay = await ensureDay(link.ownerOpenid, date);
  await walletSvc.ensureWallet(link.ownerOpenid, { welcomeCoins: cfg.welcomeCoins });
  const rewarded = (ownerDay.share && ownerDay.share.rewarded) || 0;
  if (cfg.share.dailyLimit && rewarded >= cfg.share.dailyLimit) {
    await BeidouShareClick.updateOne({ _id: click._id }, { $set: { rewarded: false } }).catch(() => {});
    return { success: false, capped: true, message: '对方今日邀请奖励已达上限' };
  }

  const coin = Math.max(0, Number(cfg.share.coinPerClick) || 0);
  if (coin > 0) {
    const r = await creditTaskCoin(link.ownerOpenid, coin, {
      source: 'share',
      refId: String(click._id),
      idemKey: `share:${String(click._id)}`,
      date,
      note: '好友点击邀请奖励',
      welcomeOpts: { welcomeCoins: cfg.welcomeCoins },
    });
    if (!r || r.duplicated) {
      // 幂等重放：不再重复加日计数
      return { success: true, counted: true, rewarded: true };
    }
  }

  await Promise.all([
    BeidouShareClick.updateOne({ _id: click._id }, { $set: { rewarded: coin > 0, coin } }),
    BeidouShareLink.updateOne(
      { _id: link._id },
      { $inc: { clicks: 1, ...(coin > 0 ? { rewarded: 1 } : {}) } }
    ),
    BeidouDay.updateOne(
      { _id: ownerDay._id },
      {
        $inc: {
          'share.clicks': 1,
          'share.rewarded': coin > 0 ? 1 : 0,
          'share.coin': coin,
          'coin.earned': coin,
          'coin.fromShare': coin,
        },
        $set: { 'share.lastClickAt': new Date() },
      }
    ),
  ]);

  return { success: true, counted: true, rewarded: coin > 0, coin };
}

// 旧分享接口：保留路径，但不再点一下就发奖
async function reportShare(user, { shareId } = {}) {
  const cfg = await cfgSvc.loadConfig();
  if (!cfg.enabled) return { success: false, message: '活动未开启' };
  const date = todayKey();
  const day = await ensureDay(user.openid, date);
  const link = cfg.share.enabled ? await ensureShareToken(user, cfg) : { token: '', path: SHARE_PATH, expiresAt: null };
  return {
    success: false,
    deprecated: true,
    duplicated: false,
    message: '分享后需好友点开链接才可获得奖励',
    shareId: String(shareId || '').trim().slice(0, 64),
    token: link.token,
    path: link.path,
    expiresAt: link.expiresAt,
    ...remainingOf(await walletSvc.ensureWallet(user.openid, { welcomeCoins: cfg.welcomeCoins }), cfg, day),
  };
}

// ===== 今日状态 =====

function fmtClock(d, { withDay = false } = {}) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const hh = String(dt.getHours()).padStart(2, '0');
  const mi = String(dt.getMinutes()).padStart(2, '0');
  if (!withDay) return `${hh}:${mi}`;
  const today = todayKey();
  const yest = addDays(today, -1);
  const key = toDateKeyLocal(dt);
  if (key === today) return `${hh}:${mi}`;
  if (key === yest) return `昨天 ${hh}:${mi}`;
  return `${key.slice(5)} ${hh}:${mi}`;
}

function toDateKeyLocal(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildCheckinCells(checkin, cfg) {
  const ms = ((checkin && checkin.milestones) || cfg.checkin.milestones).slice(0, 7);
  const streak = (checkin && checkin.streak) || 0;
  const done = !!(checkin && checkin.done);
  const todayIdx = checkin && checkin.todayIndex;
  return ms.map((m, i) => {
    const dayNo = i + 1;
    const signed = dayNo <= streak;
    const isToday = !done && todayIdx === i;
    return {
      dayNo,
      signed,
      isToday,
      coin: m.coin || 0,
      draw: 0,
      steps: 0,
      label: `第${dayNo}天`,
      rewardText: m.coin > 0 ? `+${m.coin} ${cfg.coinName}` : '—',
      rewardCoinText: m.coin > 0 ? `+${m.coin}` : '',
      big: false,
    };
  });
}

async function todayState(user) {
  const openid = user.openid;
  const date = todayKey();
  const cfg = await cfgSvc.loadConfig();
  const wallet = await walletSvc.ensureWallet(openid, { welcomeCoins: cfg.welcomeCoins });
  const day = await ensureDay(openid, date);
  const yDoc = await BeidouDay.findOne({ openid, date: addDays(date, -1) }).lean();
  const streak = day.checkin.done
    ? day.checkin.streak
    : (yDoc && yDoc.checkin && yDoc.checkin.done ? yDoc.checkin.streak || 0 : 0);

  const recent = await BeidouDraw.find({
    openid,
    $or: [{ status: 'settled' }, { status: { $exists: false } }],
  }).sort({ createdAt: -1 }).limit(5).lean();
  const byKey = new Map((cfg.prizes || []).map((p) => [p.key, p]));
  const earned = await rewardVideoSvc.earnedToday(openid, date);
  const stepsCap = capRemaining(day, cfg);
  const left = remainingOf(wallet, cfg, day);
  const coin = coinState(wallet, day, cfg);

  const wheelPityReady = cfg.wheel.pity.afterLosses > 0
    && ((wallet.luck && wallet.luck.wheelLosses) || 0) >= cfg.wheel.pity.afterLosses;
  const gridPityReady = cfg.grid.pity.afterLosses > 0
    && ((wallet.luck && wallet.luck.gridLosses) || 0) >= cfg.grid.pity.afterLosses;

  const shareLink = cfg.share.enabled
    ? await ensureShareToken(user, cfg)
    : { token: '', path: SHARE_PATH, expiresAt: null };

  const checkinState = {
    enabled: cfg.checkin.enabled,
    done: !!day.checkin.done,
    streak,
    todayIndex: day.checkin.done
      ? null
      : (streak >= cfg.checkin.milestones.length && cfg.checkin.loopAfter
        ? streak % cfg.checkin.milestones.length
        : Math.min(streak, cfg.checkin.milestones.length - 1)),
    milestones: cfg.checkin.milestones,
    award: day.checkin.award || { coin: 0, draw: 0, steps: 0 },
  };

  return {
    enabled: cfg.enabled,
    date,
    sfxEnabled: cfg.sfxEnabled !== false,
    coin,
    // 保留旧 `draw` 名称：老客户端读 data.draw，不能改名
    draw: {
      enabled: cfg.wheel.enabled,
      cost: cfg.wheel.cost,
      maxPerDay: cfg.wheel.maxPerDay,
      playsToday: dayWheel(day).plays || 0,
      canPlay: cfg.enabled && cfg.wheel.enabled && left.remaining > 0,
      prizes: cfg.prizes,
      sectors: cfg.sectors,
      sectorCount: SECTOR_COUNT,
      ev: cfg.wheel.ev,
      pity: {
        after: cfg.wheel.pity.afterLosses,
        losses: (wallet.luck && wallet.luck.wheelLosses) || 0,
        remaining: Math.max(0, cfg.wheel.pity.afterLosses - ((wallet.luck && wallet.luck.wheelLosses) || 0)),
        ready: wheelPityReady,
        text: walletSvc.pityText(cfg.wheel.pity.afterLosses, (wallet.luck && wallet.luck.wheelLosses) || 0),
      },
      ...left,
    },
    grid: {
      enabled: cfg.grid.enabled,
      cost: cfg.grid.cost,
      maxPerDay: cfg.grid.maxPerDay,
      playsToday: dayGrid(day).plays || 0,
      canPlay: cfg.enabled && cfg.grid.enabled && wallet.balance >= cfg.grid.cost
        && (!cfg.grid.maxPerDay || (dayGrid(day).plays || 0) < cfg.grid.maxPerDay),
      symbols: cfg.grid.symbols,
      outcomes: cfg.grid.outcomes,
      ev: cfg.grid.ev,
      pity: {
        after: cfg.grid.pity.afterLosses,
        symbolKey: cfg.grid.pity.symbolKey || '',
        losses: (wallet.luck && wallet.luck.gridLosses) || 0,
        remaining: Math.max(0, cfg.grid.pity.afterLosses - ((wallet.luck && wallet.luck.gridLosses) || 0)),
        ready: gridPityReady,
        text: walletSvc.pityText(cfg.grid.pity.afterLosses, (wallet.luck && wallet.luck.gridLosses) || 0),
      },
    },
    video: videoState(day, cfg),
    share: {
      enabled: cfg.share.enabled,
      coinPerClick: cfg.share.coinPerClick,
      dailyLimit: cfg.share.dailyLimit,
      rewardedToday: (day.share && day.share.rewarded) || 0,
      clicksToday: (day.share && day.share.clicks) || 0,
      remaining: cfg.share.dailyLimit ? Math.max(0, cfg.share.dailyLimit - ((day.share && day.share.rewarded) || 0)) : -1,
      token: shareLink.token,
      path: shareLink.path,
      expiresAt: shareLink.expiresAt,
      drawPerShare: 0, // 旧字段：不再发次数
    },
    checkin: {
      ...checkinState,
      cells: buildCheckinCells({ ...checkinState, milestones: cfg.checkin.milestones }, cfg),
    },
    cap: { ...stepsCap, capped: day.draw.capped || stepsCap.capped },
    economy: cfg.economy,
    rarityText: buildRarityText(cfg.prizes),
    earned,
    recent: recent.map((r) => {
      const p = byKey.get(r.prizeKey) || {};
      const game = r.game || 'wheel';
      const label = r.prizeLabel
        || (r.type === 'coin' ? `${r.amount} ${cfg.coinName}` : r.type === 'steps' ? `${r.amount} 步` : r.type === 'draw' ? '再来一次' : '谢谢参与');
      return {
        prizeKey: r.prizeKey,
        prizeLabel: label,
        game,
        type: r.type,
        amount: r.amount,
        capped: r.capped,
        coinCapped: r.coinCapped,
        pity: r.pity,
        rarity: r.rarity || (r.type === 'none' ? 'none' : rarityOf({ ...p, type: r.type }, cfg.prizes)),
        linesText: (r.lines || []).map((l) => l.label).filter(Boolean).join(' + '),
        at: r.createdAt,
        atText: fmtClock(r.createdAt),
      };
    }),
  };
}

// ===== 中奖播报 =====

const RARE_PERCENT = 10;

function rarityOf(prize, prizes) {
  if (!prize || prize.type === 'none') return 'none';
  const pct = Number(prize.percent);
  if (!Number.isFinite(pct)) return 'normal';
  const list = (prizes || []).map((p) => Number(p.percent)).filter((n) => Number.isFinite(n));
  const minPct = list.length ? Math.min(...list) : NaN;
  if (Number.isFinite(minPct) && pct <= minPct + 1e-9 && pct <= RARE_PERCENT) return 'rarest';
  if (pct < RARE_PERCENT) return 'rare';
  return 'normal';
}

function buildRarityText(prizes) {
  const list = (prizes || []).filter((p) => Number.isFinite(Number(p.percent)));
  if (!list.length) return '';
  const min = list.reduce((a, b) => (Number(a.percent) <= Number(b.percent) ? a : b));
  const max = list.reduce((a, b) => (Number(a.percent) >= Number(b.percent) ? a : b));
  return `最低概率奖：${min.label} ${min.percent}% · 最高：${max.label} ${max.percent}%`;
}

async function winnersFeed({ limit = 20, excludeOpenid } = {}) {
  const n = Math.min(50, Math.max(1, Number(limit) || 20));
  const cfg = await cfgSvc.loadConfig();
  const byKey = new Map((cfg.prizes || []).map((p) => [p.key, p]));

  const rows = await BeidouDraw.find({
    type: { $ne: 'none' },
    $or: [{ status: 'settled' }, { status: { $exists: false } }],
  })
    .sort({ createdAt: -1 })
    .limit(n * 4)
    .lean();
  if (!rows.length) return { items: [], rarityText: buildRarityText(cfg.prizes) };

  const openids = [...new Set(rows.map((r) => r.openid).filter(Boolean))];
  const users = openids.length
    ? await User.find({ openid: { $in: openids } })
        .select('openid realName nickname privacy role status')
        .lean()
    : [];
  const userOf = new Map(users.map((u) => [u.openid, u]));

  const perUser = new Map();
  const items = [];
  for (const r of rows) {
    if (items.length >= n) break;
    const u = userOf.get(r.openid);
    if (!u) continue;
    if (u.role === 'teacher') continue;
    if (u.status === 'banned') continue;
    if (u.privacy && u.privacy.exitRanking) continue;
    const cnt = perUser.get(r.openid) || 0;
    if (cnt >= 2) continue;
    perUser.set(r.openid, cnt + 1);

    const prize = byKey.get(r.prizeKey) || { key: r.prizeKey, label: r.prizeLabel || '', type: r.type, percent: r.prizePercent };
    items.push({
      nameMasked: maskName(u.realName || u.nickname),
      prizeKey: r.prizeKey,
      prizeLabel: r.prizeLabel || prize.label || (r.type === 'coin' ? `${r.amount} ${cfg.coinName}` : r.type === 'steps' ? `${r.amount} 步` : r.type === 'draw' ? '再来一次' : ''),
      prizeType: r.type,
      game: r.game || 'wheel',
      amount: r.amount || 0,
      rarity: r.rarity || rarityOf({ ...prize, type: r.type, percent: r.percent }, cfg.prizes),
      percent: prize.percent == null ? (r.prizePercent || null) : prize.percent,
      linesText: (r.lines || []).map((l) => l.label).filter(Boolean).join(' + '),
      atText: fmtClock(r.createdAt, { withDay: true }),
      isMine: !!excludeOpenid && r.openid === excludeOpenid,
    });
  }
  return { items, rarityText: buildRarityText(cfg.prizes) };
}

// ===== 旧来源账本工具（保留导出；v3 不再用于新流水）=====

function pickSource(day) {
  const d = (day && day.draw) || {};
  for (const s of SOURCE_ORDER) {
    const from = Number(d[SOURCE_FROM_FIELD[s]]) || 0;
    const used = Number(d[SOURCE_USED_FIELD[s]]) || 0;
    if (from - used > 0) return s;
  }
  return 'unknown';
}

async function migrateDrawIdIndex() {
  const col = BeidouDraw.collection;
  const idx = await col.indexes();
  const names = idx.map((i) => i.name);
  const out = { created: false, dropped: [] };
  if (!names.includes('openid_1_drawId_1')) {
    await col.createIndex({ openid: 1, drawId: 1 }, { unique: true, name: 'openid_1_drawId_1' });
    out.created = true;
  }
  if (names.includes('drawId_1')) {
    await col.dropIndex('drawId_1');
    out.dropped.push('drawId_1');
  }
  if (names.includes('source_1')) {
    await col.dropIndex('source_1');
    out.dropped.push('source_1');
  }
  return out;
}

module.exports = {
  SECTOR_COUNT,
  DEG_PER_SECTOR,
  LIMITS,
  DEFAULT_PRIZES,
  DEFAULT_MILESTONES,
  normalizePrizes: cfgSvc.normalizePrizes,
  buildSectors: cfgSvc.buildSectors,
  pickPrize: cfgSvc.pickPrize,
  normalizeBeidouInput: cfgSvc.normalizeBeidouInput,
  normalizeSymbols: cfgSvc.normalizeSymbols,
  normalizeOutcomes: cfgSvc.normalizeOutcomes,
  buildEffective: cfgSvc.buildEffective,
  toEditableConfig: cfgSvc.toEditableConfig,
  loadConfig: cfgSvc.loadConfig,
  migrateBeidouConfig: cfgSvc.migrateBeidouConfig,
  seedBeidouBuiltinIcons: cfgSvc.seedBeidouBuiltinIcons,
  ensureDay,
  remainingOf,
  capRemaining,
  coinState,
  drawRound,
  playGrid,
  reportVideo,
  reportShare,
  reportShareClick,
  ensureShareToken,
  checkin,
  todayState,
  winnersFeed,
  SOURCE_ORDER,
  SOURCE_USED_FIELD,
  SOURCE_FROM_FIELD,
  SOURCE_TEXT,
  SOURCE_TEXT_LONG,
  GAME_TEXT,
  COIN_SOURCE_TEXT,
  sourceNote,
  pickSource,
  migrateDrawIdIndex,
  rarityOf,
  buildRarityText,
  RARE_PERCENT,
  _models: { BeidouDay, BeidouDraw, BeidouShareLink, BeidouShareClick },
};
