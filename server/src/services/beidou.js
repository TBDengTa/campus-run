const crypto = require('crypto');

const GoalConfig = require('../models/goal-config');
const BeidouDay = require('../models/beidou-day');
const BeidouDraw = require('../models/beidou-draw');
const RunRecord = require('../models/run-record');
const wechat = require('./wechat');
const rewardVideoSvc = require('./reward-video');
const { todayKey, addDays } = require('../utils/dates');

/**
 * ===== 北斗运动 2.0：签到 + 转盘抽步数 + 看视频/分享得次数 =====
 *
 * 方案、口径与红线见 docs/beidou-lottery-plan.md（改本文件前必读）。
 * 本文件是**唯一实现**：routes/beidou.js 只做鉴权与取参，前端只负责渲染与动画。
 *
 * 三条必须守住的口径：
 *   ① 抽奖结果**只由服务端定**：roll、index、prize 全在这里算，前端拿到的 index 只用于停位；
 *   ② 步数只有两个出口：`drawRound()`（转盘）与 `checkin()`（签到第 3/7 天阶梯），
 *      两者都必须过 `capRemaining()`（用户 2026-11-11 的 D7/D8 裁决）；
 *   ③ `draw.stepsAwarded` 是**唯一成本闸门** —— 因为 D11「次数不限」+ D4「点分享即给」
 *      本身没有任何上限，全靠每日步数封顶兜住排行榜与跑分。
 */

// 扇区数固定 8（前端转盘视觉）。奖池项不足 8 个时按权重复制填充到 8 格。
const SECTOR_COUNT = 8;
const DEG_PER_SECTOR = 360 / SECTOR_COUNT;

// 各类上限（管理端保存时夹紧，防止填出天文数字）
const LIMITS = {
  drawPerWatch: 10,
  videoDailyLimit: 200,
  drawPerShare: 10,
  shareDailyLimit: 200,
  shareMinIntervalSec: 3600,
  maxPerDay: 500,
  dailyStepsCap: 200000,
  milestoneDraw: 50,
  milestoneSteps: 50000,
  prizeSteps: 50000,
  prizeWeight: 100000,
  prizeCount: 8,
};

// ===== 数值工具 =====

// 整数夹紧：非法值返回 null（调用方按「未配置」处理）
function clampInt(value, max, min = 0) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ===== 奖池归一（概率公示与抽奖共用的唯一实现）=====

const DEFAULT_PRIZES = [
  { key: 'steps_100', label: '100 步', type: 'steps', amount: 100, weight: 30 },
  { key: 'steps_300', label: '300 步', type: 'steps', amount: 300, weight: 16 },
  { key: 'steps_800', label: '800 步', type: 'steps', amount: 800, weight: 6 },
  { key: 'steps_1500', label: '1500 步', type: 'steps', amount: 1500, weight: 2 },
  { key: 'again', label: '再来一次', type: 'draw', amount: 1, weight: 8 },
  { key: 'none', label: '谢谢参与', type: 'none', amount: 0, weight: 38 },
];

// 签到阶梯默认值（连续 1~7 天）。模型与 loadConfig 各有一份会漂移，
// 所以**只在这里定义**，models/goal-config.js 的 schema default 只是持久化落地形态。
const DEFAULT_MILESTONES = [
  { draw: 1, steps: 0 },
  { draw: 1, steps: 0 },
  { draw: 2, steps: 200 },
  { draw: 1, steps: 0 },
  { draw: 1, steps: 0 },
  { draw: 1, steps: 0 },
  { draw: 3, steps: 500 },
];

/**
 * 归一化奖池：剔除非法项 → 夹紧数值 → 保证至少有一项非零权重。
 *
 * 为什么必须有「回退默认奖池」：管理员如果把所有 weight 填成 0 或全删了，
 * 归一后总和为 0，抽奖会变成「永远抽不中」——页面上看起来一切正常，学生却拿不到任何东西。
 * 这种静默失效比直接报错恶劣得多，所以宁可回退到默认奖池。
 *
 * @returns {Array<{key,label,type,amount,weight,percent}>} percent = 折算百分比（两位小数）
 */
function normalizePrizes(input) {
  const raw = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const key = String(p.key == null ? '' : p.key).trim().slice(0, 32);
    if (!key || seen.has(key)) continue; // key 是幂等/统计口径，重名一律丢弃后者
    const type = ['steps', 'none', 'draw'].includes(p.type) ? p.type : 'none';
    const weight = clampInt(p.weight, LIMITS.prizeWeight, 0);
    // 权重 <= 0 的项不参与抽奖（保留在配置里但不下发，否则前端会画出一个永远抽不到的扇区）
    if (!weight) continue;
    let amount = 0;
    if (type === 'steps') {
      amount = clampInt(p.amount, LIMITS.prizeSteps, 1) || 0;
      if (!amount) continue; // 「0 步」的步数奖没有意义，直接剔除
    } else if (type === 'draw') {
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
    });
    if (out.length >= LIMITS.prizeCount) break;
  }
  if (!out.length) return normalizePrizes(DEFAULT_PRIZES); // 回退默认（递归一层的终止条件是默认值本身合法）
  const total = out.reduce((s, p) => s + p.weight, 0);
  return out.map((p) => ({
    ...p,
    // 概率公示取两位小数；前端只展示，不得自己算（否则管理端改权重后公示会漂移）
    percent: Math.round((p.weight / total) * 10000) / 100,
  }));
}

/**
 * 奖池 → 8 个扇区（按权重复制填充）。
 *
 * 为什么扇区顺序由服务端定：前端若自己排顺序，就会出现「动画停在第 3 格、实际发的是第 5 格的奖」。
 * 这类 bug 在真机上只能靠对账发现，且学生只会觉得「系统骗人」。
 *
 * @returns {Array<string>} 长度 8，元素是 prizeKey
 */
function buildSectors(prizes) {
  const list = Array.isArray(prizes) && prizes.length ? prizes : normalizePrizes(null);
  // 先按原顺序铺一遍（保证每个奖至少出现在它自己的位置上），再按权重轮流补齐
  const sectors = list.slice(0, SECTOR_COUNT).map((p) => p.key);
  if (sectors.length >= SECTOR_COUNT) return sectors;
  // 权重大的项优先被复制（观感上「大奖格子少」仍然成立，因为大奖权重小）
  const pool = [...list].sort((a, b) => b.weight - a.weight);
  let i = 0;
  while (sectors.length < SECTOR_COUNT && pool.length) {
    sectors.push(pool[i % pool.length].key);
    i += 1;
  }
  return sectors;
}

/**
 * 抽奖：给定 roll（0~1）与奖池，返回命中的奖池项与它的扇区下标。
 *
 * index 的判定：先按权重求出命中项，再在 sectors 里找该 key 的**第一个**出现位置。
 * 这样「8 格里有重复 key」时也永远停在一个合法扇区上。
 */
function pickPrize(prizes, sectors, roll) {
  const total = prizes.reduce((s, p) => s + p.weight, 0);
  let acc = 0;
  let hit = prizes[prizes.length - 1];
  for (const p of prizes) {
    acc += p.weight / total;
    if (roll < acc) {
      hit = p;
      break;
    }
  }
  const index = Math.max(0, sectors.indexOf(hit.key));
  return { prize: hit, index };
}

// ===== 配置读取 =====

// 库里的 beidou 段 → 生效配置（含归一后奖池、扇区表、封顶值）
async function loadConfig() {
  const doc = await GoalConfig.getSingleton();
  const b = (doc && doc.beidou) || {};
  const prizes = normalizePrizes(b.prizes);
  const sectors = buildSectors(prizes);
  const checkin = b.checkin || {};
  const milestones = (Array.isArray(checkin.milestones) && checkin.milestones.length
    ? checkin.milestones
    : DEFAULT_MILESTONES
  ).map((m) => ({
    draw: clampInt(m && m.draw, LIMITS.milestoneDraw, 0) || 0,
    steps: clampInt(m && m.steps, LIMITS.milestoneSteps, 0) || 0,
  }));
  return {
    enabled: b.enabled !== false,
    video: {
      drawPerWatch: clampInt(b.video && b.video.drawPerWatch, LIMITS.drawPerWatch, 0) || 0,
      dailyLimit: clampInt(b.video && b.video.dailyLimit, LIMITS.videoDailyLimit, 0) || 0,
      adUnitId: String((b.video && b.video.adUnitId) || '').trim(),
    },
    share: {
      drawPerShare: clampInt(b.share && b.share.drawPerShare, LIMITS.drawPerShare, 0) || 0,
      dailyLimit: clampInt(b.share && b.share.dailyLimit, LIMITS.shareDailyLimit, 0) || 0,
      minIntervalSec: clampInt(b.share && b.share.minIntervalSec, LIMITS.shareMinIntervalSec, 0) || 0,
    },
    checkin: {
      enabled: checkin.enabled !== false,
      milestones,
      loopAfter: checkin.loopAfter !== false,
    },
    draw: {
      maxPerDay: clampInt(b.draw && b.draw.maxPerDay, LIMITS.maxPerDay, 0) || 0,
      dailyStepsCap: clampInt(b.draw && b.draw.dailyStepsCap, LIMITS.dailyStepsCap, 0) || 0,
    },
    prizes,
    sectors,
  };
}

// 管理端保存：只处理显式回传的键（未回传不动），越界夹紧
function normalizeBeidouInput(input = {}) {
  const out = {};
  if (input.enabled !== undefined) out.enabled = input.enabled !== false;

  if (input.video && typeof input.video === 'object') {
    out.video = {};
    const map = [
      ['drawPerWatch', LIMITS.drawPerWatch],
      ['dailyLimit', LIMITS.videoDailyLimit],
    ];
    for (const [k, max] of map) {
      const v = clampInt(input.video[k], max, 0);
      if (v !== null) out.video[k] = v;
    }
    if (input.video.adUnitId !== undefined) {
      out.video.adUnitId = String(input.video.adUnitId || '').trim().slice(0, 64);
    }
  }

  if (input.share && typeof input.share === 'object') {
    out.share = {};
    const map = [
      ['drawPerShare', LIMITS.drawPerShare],
      ['dailyLimit', LIMITS.shareDailyLimit],
      ['minIntervalSec', LIMITS.shareMinIntervalSec],
    ];
    for (const [k, max] of map) {
      const v = clampInt(input.share[k], max, 0);
      if (v !== null) out.share[k] = v;
    }
  }

  if (input.checkin && typeof input.checkin === 'object') {
    out.checkin = {};
    if (input.checkin.enabled !== undefined) out.checkin.enabled = input.checkin.enabled !== false;
    if (input.checkin.loopAfter !== undefined) out.checkin.loopAfter = input.checkin.loopAfter !== false;
    if (Array.isArray(input.checkin.milestones)) {
      // 至少 1 天、最多 30 天（再长就不像「7 天阶梯」了，且前端格子画不下）
      out.checkin.milestones = input.checkin.milestones.slice(0, 30).map((m) => ({
        draw: clampInt(m && m.draw, LIMITS.milestoneDraw, 0) || 0,
        steps: clampInt(m && m.steps, LIMITS.milestoneSteps, 0) || 0,
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
    // 保存时不做「剔除非法项」的语义改写（那会让管理员以为保存丢失），只夹紧数值；
    // 非法项在 loadConfig 的 normalizePrizes 里被忽略，管理端页面会实时显示「归一后概率」
    out.prizes = input.prizes.slice(0, LIMITS.prizeCount).map((p) => ({
      key: String((p && p.key) || '').trim().slice(0, 32),
      label: String((p && p.label) || '').trim().slice(0, 20),
      type: ['steps', 'none', 'draw'].includes(p && p.type) ? p.type : 'none',
      amount: clampInt(p && p.amount, LIMITS.prizeSteps, 0) || 0,
      weight: clampInt(p && p.weight, LIMITS.prizeWeight, 0) || 0,
    }));
  }
  return out;
}

// ===== 当日状态 =====

// 取（或建立）当日文档。唯一索引 + upsert 保证并发下也只有一份。
async function ensureDay(openid, date) {
  const existing = await BeidouDay.findOne({ openid, date });
  if (existing) return existing;
  try {
    return await BeidouDay.create({ openid, date });
  } catch (e) {
    // 并发建档撞唯一索引：对方已经建好了，直接读
    const doc = await BeidouDay.findOne({ openid, date });
    if (doc) return doc;
    throw e;
  }
}

// 今日剩余次数。
//
// 三种口径要分清（混起来就会出现「明明没次数了还能抽」这种刷步漏洞）：
//   · total  = 今日各来源**获得**的次数之和（这个永远是有限的，必须先赚）
//   · used   = 今日**已抽**次数（CAS 版本号）
//   · maxPerDay = 管理员设的每日上限（0 = 不限，遵 D11）
//
// ⚠️ `unlimited` 只表示「**每日上限**不设限」，**不表示次数无限**。
//    抽奖前必须无条件检查 remaining <= 0（不能写成 `if (!unlimited && remaining <= 0)` ——
//    那会让 maxPerDay=0 的默认配置变成「可以无限抽奖」，是直接刷步的漏洞）。
function remainingOf(day, cfg) {
  const total = (day && day.draw && day.draw.total) || 0;
  const used = (day && day.draw && day.draw.used) || 0;
  const max = (cfg && cfg.draw && cfg.draw.maxPerDay) || 0;
  const left = total - used;
  if (!max) return { remaining: Math.max(0, left), unlimited: true, total, used, maxPerDay: 0 };
  return {
    remaining: Math.max(0, Math.min(left, max - used)),
    unlimited: false,
    total,
    used,
    maxPerDay: max,
  };
}

// 封顶余额：dailyStepsCap = 0 视为不封顶
function capRemaining(day, cfg) {
  const cap = (cfg && cfg.draw && cfg.draw.dailyStepsCap) || 0;
  const used = (day && day.draw && day.draw.stepsAwarded) || 0;
  if (!cap) return { cap: 0, used, left: Infinity, capped: false };
  return { cap, used, left: Math.max(0, cap - used), capped: used >= cap };
}

// ===== 一次抽奖 =====

/**
 * 抽奖。
 *
 * 流程与顺序见方案 §5.2（顺序不能换）：
 *   幂等 → CAS 占次数 → 随机 → 封顶判定 → 写流水 → 写 run_records → 刷新聚合
 *
 * @param {object} user  req.user（已过教师/封禁拦截，路由层负责）
 * @param {{drawId?:string}} opts
 * @returns {Promise<object>} { success } 或 { success:false, message }
 */
async function drawRound(user, { drawId } = {}) {
  const openid = user.openid;
  const date = todayKey();
  const cfg = await loadConfig();
  if (!cfg.enabled) return { success: false, message: '活动未开启' };

  const nonce = String(drawId || '').trim().slice(0, 64);
  if (!nonce) return { success: false, message: '缺少抽奖凭据' };

  const day = await ensureDay(openid, date);

  // ① 幂等：同一个 drawId 重复提交 → 原样返回上一次结果（不再消耗次数、不再发步数）
  const dup = await BeidouDraw.findOne({ drawId: nonce }).lean();
  if (dup) {
    const r = remainingOf(day, cfg);
    return {
      success: true,
      duplicated: true,
      index: dup.index,
      prize: { key: dup.prizeKey, type: dup.type, amount: dup.amount },
      capped: dup.capped,
      ...r,
      day,
    };
  }

  // ② 次数校验 + 随机（先算好，CAS 成功后才落库）
  //
  // ⚠️ 这里**无条件**检查 remaining <= 0（不要写成 `if (!left.unlimited && left.remaining <= 0)`）：
  //    `unlimited` 只表示「每日上限不设限」，而**获得的总次数始终有限**。
  //    加了那个前置条件，默认配置（maxPerDay=0）就变成可以无限抽奖 = 直接刷步。
  const left = remainingOf(day, cfg);
  if (left.remaining <= 0) {
    return {
      success: false,
      message: '今日抽奖次数已用完，去看看视频或签到吧',
      ...left,
    };
  }

  // crypto.randomInt 而不是 Math.random：抽奖是「结果即资产」的场景，
  // 用可预测的伪随机数会被脚本按种子反推，也能被「连点观察」摸出规律。
  const roll = crypto.randomInt(0, 1e6) / 1e6;
  let { prize, index } = pickPrize(cfg.prizes, cfg.sectors, roll);

  // ③ 封顶降级：步数奖在额度用尽时**当场降级为谢谢参与**（不是报错，抽奖照常走完）
  //
  // ⚠️ 奖池里可能**没有** type='none' 的项（管理员把「谢谢参与」删了，只留步数奖）。
  //    此时必须自己合成一个「0 步空奖」来降级 —— 否则 prize 仍是步数奖，调用方会把
  //    prize.amount 全额发出去，封顶就成了摆设（这是本方案唯一的成本闸门，不能漏）。
  const cap = capRemaining(day, cfg);
  let capped = false;
  if (prize.type === 'steps') {
    if (cap.cap && prize.amount > cap.left) {
      const nonePrize = cfg.prizes.find((p) => p.type === 'none') || {
        key: 'none',
        label: '谢谢参与',
        type: 'none',
        amount: 0,
        weight: 1,
      };
      prize = nonePrize;
      // 空奖不在扇区表里时（合成的空奖），停到第一个「谢谢参与」扇区；都没有就停 0 号位
      const hit = cfg.sectors.indexOf(nonePrize.key);
      index = hit >= 0 ? hit : Math.max(0, cfg.sectors.indexOf((cfg.prizes.find((p) => p.type === 'none') || {}).key));
      capped = true;
    }
  }

  // ④ CAS 占一次 draw.used（用旧值做版本号；抢输就是并发，不重试不补发）
  const claimed = await BeidouDay.findOneAndUpdate(
    { _id: day._id, 'draw.used': day.draw.used },
    { $inc: { 'draw.used': 1 } },
    { new: true }
  );
  if (!claimed) return { success: false, message: '操作过于频繁，请稍后再试' };

  // ⑤ 写流水（drawId 唯一索引兜底：万一 CAS 之后又撞上，说明是同一笔重试，回滚 used 即可）
  let drawDoc;
  try {
    drawDoc = await BeidouDraw.create({
      openid,
      date,
      drawId: nonce,
      prizeKey: prize.key,
      type: prize.type,
      amount: prize.amount,
      roll,
      index,
      capped,
    });
  } catch (e) {
    // 唯一键冲突 = 并发的同一笔：撤销刚占用的次数，把上一次结果返回
    await BeidouDay.updateOne({ _id: claimed._id }, { $inc: { 'draw.used': -1 } }).catch(() => {});
    const again = await BeidouDraw.findOne({ drawId: nonce }).lean();
    if (again) {
      return {
        success: true,
        duplicated: true,
        index: again.index,
        prize: { key: again.prizeKey, type: again.type, amount: again.amount },
        capped: again.capped,
        ...remainingOf(claimed, cfg),
        day: claimed,
      };
    }
    throw e;
  }

  // ⑥ 按奖品类型入账
  //
  // ⚠️ 数值累加走 $inc，布尔标记走 $set ——**绝不能把布尔字段塞进 $inc**
  //    （MongoDB 会直接报 "Cannot increment with non-numeric argument"，
  //      整个抽奖接口 500，而且是在步数已经算好之后才炸）。
  const inc = {};
  const set = {};
  if (prize.type === 'steps') {
    // 步数出口之一：与签到共用 capRemaining，必须累加 stepsAwarded
    inc['draw.stepsAwarded'] = prize.amount;
    if (cap.cap && cap.used + prize.amount >= cap.cap) set['draw.capped'] = true;

    // 真源 = run_records 当日 source='beidou' 那一条（与记录页/排行榜/跑分/徽章同源）
    const est = wechat.estimateFromSteps(prize.amount);
    await RunRecord.findOneAndUpdate(
      { openid, date, source: 'beidou' },
      {
        $inc: {
          steps: prize.amount,
          distance: est.distance,
          calories: est.calories,
          durationSeconds: est.durationSeconds,
        },
        $setOnInsert: { openid, date, source: 'beidou' },
      },
      { upsert: true }
    );
  } else if (prize.type === 'draw') {
    // 「再来一次」：直接**回补次数**（total += amount），不回补 used
    inc['draw.total'] = prize.amount;
    inc['draw.fromPrize'] = prize.amount;
  }
  // 本次被降级（步数奖 → 空奖）时，把当日标记为已封顶，前端据此常驻提示
  if (capped) set['draw.capped'] = true;

  const update = {};
  if (Object.keys(inc).length) update.$inc = inc;
  if (Object.keys(set).length) update.$set = set;
  const updated = Object.keys(update).length
    ? await BeidouDay.findByIdAndUpdate(day._id, update, { new: true })
    : claimed;

  const r = remainingOf(updated, cfg);
  return {
    success: true,
    index,
    prize: { key: prize.key, label: prize.label, type: prize.type, amount: prize.amount },
    capped,
    stepsAwarded: prize.type === 'steps' ? prize.amount : 0,
    ...r,
    day: updated,
    drawId: nonce,
  };
}

// ===== 看视频得次数 =====

async function reportVideo(user, { watchId } = {}) {
  const openid = user.openid;
  const date = todayKey();
  const cfg = await loadConfig();
  if (!cfg.enabled) return { success: false, message: '活动未开启' };
  if (!cfg.video.drawPerWatch) return { success: false, message: '看视频暂不发放次数' };

  const nonce = String(watchId || '').trim().slice(0, 64);
  if (!nonce) return { success: false, message: '缺少观看凭据' };

  const day = await ensureDay(openid, date);

  // 幂等：同一个 watchId 重复上报只加一次（弱网重试、连点都在发生这件事）
  if ((day.video.watchIds || []).includes(nonce)) {
    return { success: true, duplicated: true, ...remainingOf(day, cfg), day };
  }
  if (cfg.video.dailyLimit && day.video.count >= cfg.video.dailyLimit) {
    return { success: false, message: `今日看视频次数已达上限（${cfg.video.dailyLimit} 次）`, ...remainingOf(day, cfg) };
  }

  // CAS 用 video.count 做版本号：并发下两份请求只有一个能成功
  const claimed = await BeidouDay.findOneAndUpdate(
    { _id: day._id, 'video.count': day.video.count, 'video.watchIds': { $ne: nonce } },
    {
      $inc: { 'video.count': 1, 'draw.total': cfg.video.drawPerWatch, 'draw.fromVideo': cfg.video.drawPerWatch },
      $push: { 'video.watchIds': { $each: [nonce], $slice: -50 } },
    },
    { new: true }
  );
  if (!claimed) {
    const latest = await BeidouDay.findOne({ openid, date });
    if (latest && (latest.video.watchIds || []).includes(nonce)) {
      return { success: true, duplicated: true, ...remainingOf(latest, cfg), day: latest };
    }
    return { success: false, message: '操作过于频繁，请稍后再试', ...remainingOf(latest || day, cfg) };
  }
  return {
    success: true,
    gained: cfg.video.drawPerWatch,
    ...remainingOf(claimed, cfg),
    day: claimed,
  };
}

// ===== 分享得次数 =====

async function reportShare(user, { shareId } = {}) {
  const openid = user.openid;
  const date = todayKey();
  const cfg = await loadConfig();
  if (!cfg.enabled) return { success: false, message: '活动未开启' };
  if (!cfg.share.drawPerShare) return { success: false, message: '分享暂不发放次数' };

  const nonce = String(shareId || '').trim().slice(0, 64);
  const day = await ensureDay(openid, date);

  // 服务端最小间隔：纯技术防连点，**不是次数上限**（用户 2026-11-11 定「次数不限」）
  const minGap = cfg.share.minIntervalSec * 1000;
  if (minGap && day.share.lastAt && Date.now() - new Date(day.share.lastAt).getTime() < minGap) {
    return { success: false, duplicated: true, message: '刚分享过，休息一下再来', ...remainingOf(day, cfg) };
  }
  if (cfg.share.dailyLimit && day.share.count >= cfg.share.dailyLimit) {
    return { success: false, message: `今日邀请次数已达上限（${cfg.share.dailyLimit} 次）`, ...remainingOf(day, cfg) };
  }

  const claimed = await BeidouDay.findOneAndUpdate(
    { _id: day._id, 'share.count': day.share.count },
    {
      $inc: { 'share.count': 1, 'draw.total': cfg.share.drawPerShare, 'draw.fromShare': cfg.share.drawPerShare },
      $set: { 'share.lastAt': new Date() },
    },
    { new: true }
  );
  if (!claimed) return { success: false, message: '操作过于频繁，请稍后再试', ...remainingOf(day, cfg) };

  return {
    success: true,
    gained: cfg.share.drawPerShare,
    shareId: nonce,
    ...remainingOf(claimed, cfg),
    day: claimed,
  };
}

// ===== 签到 =====

/**
 * 签到（连续 7 天阶梯，断签重置）。
 *
 * ⚠️ streak 必须按「昨天的签到状态」推：
 *    昨天签了 → streak + 1；昨天没签 → 1。
 *    **不能**用「累计签到天数」，否则断签的人也能一路领到第 7 天大奖。
 */
async function checkin(user) {
  const openid = user.openid;
  const date = todayKey();
  const cfg = await loadConfig();
  if (!cfg.enabled) return { success: false, message: '活动未开启' };
  if (!cfg.checkin.enabled) return { success: false, message: '签到暂未开放' };

  const day = await ensureDay(openid, date);
  if (day.checkin.done) {
    return { success: false, duplicated: true, message: '今天已经签到过了', ...remainingOf(day, cfg), day };
  }

  // 取昨天的 streak（昨天没签到则从 1 开始）
  const yDoc = await BeidouDay.findOne({ openid, date: addDays(date, -1) }).lean();
  const yStreak = yDoc && yDoc.checkin && yDoc.checkin.done ? yDoc.checkin.streak || 0 : 0;
  const streak = yStreak + 1;

  // 阶梯下标：超过周期后按 loopAfter 决定「重来」还是「一直按最后一天」
  const ms = cfg.checkin.milestones;
  let idx = streak - 1;
  if (idx >= ms.length) idx = cfg.checkin.loopAfter ? (idx % ms.length) : ms.length - 1;
  const award = ms[idx] || { draw: 0, steps: 0 };

  // 步数封顶：签到步数与抽奖共用同一个池子（不另开额度）
  const cap = capRemaining(day, cfg);
  let steps = award.steps;
  let capped = false;
  if (steps > 0 && cap.cap) {
    steps = Math.max(0, Math.min(steps, cap.left));
    if (steps < award.steps) capped = true; // 部分发放也要标记，前端文案说清
  }

  // 原子领取：以 checkin.done:false 为条件（并发重复签到只有一份能成功）
  const inc = {
    'draw.total': award.draw,
    'draw.fromCheckin': award.draw,
  };
  if (steps > 0) inc['draw.stepsAwarded'] = steps;
  const set = {
    'checkin.done': true,
    'checkin.at': new Date(),
    'checkin.streak': streak,
    'checkin.award': { draw: award.draw, steps },
  };
  // 封顶落标记：本次发放后已达上限（含「本来就已经满额」的情形）
  if (cap.cap && cap.used + steps >= cap.cap) set['draw.capped'] = true;

  const claimed = await BeidouDay.findOneAndUpdate(
    { _id: day._id, 'checkin.done': false },
    { $set: set, $inc: inc },
    { new: true }
  );
  if (!claimed) {
    const latest = await BeidouDay.findOne({ openid, date });
    return { success: false, duplicated: true, message: '今天已经签到过了', ...remainingOf(latest || day, cfg) };
  }

  // 步数出口之二：签到阶梯（第 3/7 天）
  if (steps > 0) {
    const est = wechat.estimateFromSteps(steps);
    await RunRecord.findOneAndUpdate(
      { openid, date, source: 'beidou' },
      {
        $inc: { steps, distance: est.distance, calories: est.calories, durationSeconds: est.durationSeconds },
        $setOnInsert: { openid, date, source: 'beidou' },
      },
      { upsert: true }
    );
  }

  return {
    success: true,
    streak,
    award: { draw: award.draw, steps },
    capped,
    ...remainingOf(claimed, cfg),
    day: claimed,
  };
}

// ===== 今日概览（页面首屏）=====

async function todayState(user) {
  const openid = user.openid;
  const date = todayKey();
  const cfg = await loadConfig();
  const day = await ensureDay(openid, date);
  const yDoc = await BeidouDay.findOne({ openid, date: addDays(date, -1) }).lean();
  const streak = day.checkin.done
    ? day.checkin.streak
    : (yDoc && yDoc.checkin && yDoc.checkin.done ? yDoc.checkin.streak || 0 : 0);

  // 最近 5 条中奖记录：前端不自己攒（切页面就没了），统一由服务端下发
  const recent = await BeidouDraw.find({ openid }).sort({ createdAt: -1 }).limit(5).lean();
  // 今日已入账（四项）：真源 = run_records(source='beidou')，与记录页/首页统计同源
  const earned = await rewardVideoSvc.earnedToday(openid, date);
  const cap = capRemaining(day, cfg);

  return {
    enabled: cfg.enabled,
    date,
    video: { ...cfg.video, count: day.video.count, remaining: Math.max(0, cfg.video.dailyLimit - day.video.count) },
    share: { ...cfg.share, count: day.share.count, remaining: cfg.share.dailyLimit ? Math.max(0, cfg.share.dailyLimit - day.share.count) : -1 },
    checkin: {
      enabled: cfg.checkin.enabled,
      done: day.checkin.done,
      streak,
      // 明天签到时按哪一档发：前端画 7 天格子时高亮「今天」用
      todayIndex: day.checkin.done ? null : (streak >= cfg.checkin.milestones.length && cfg.checkin.loopAfter ? streak % cfg.checkin.milestones.length : Math.min(streak, cfg.checkin.milestones.length - 1)),
      milestones: cfg.checkin.milestones,
      award: day.checkin.award,
    },
    draw: {
      ...remainingOf(day, cfg),
      // 奖池与扇区：**顺序由服务端定**，前端不得重排（否则停位与结果对不上）
      prizes: cfg.prizes,
      sectors: cfg.sectors,
      sectorCount: SECTOR_COUNT,
    },
    // 封顶状态：前端要在抽到空奖**之前**就告诉用户「今日步数奖励已到上限」
    cap: { ...cap, capped: day.draw.capped || cap.capped },
    earned,
    recent: recent.map((r) => ({
      prizeKey: r.prizeKey,
      type: r.type,
      amount: r.amount,
      capped: r.capped,
      at: r.createdAt,
    })),
  };
}

module.exports = {
  SECTOR_COUNT,
  DEG_PER_SECTOR,
  LIMITS,
  DEFAULT_PRIZES,
  DEFAULT_MILESTONES,
  normalizePrizes,
  buildSectors,
  pickPrize,
  normalizeBeidouInput,
  loadConfig,
  ensureDay,
  remainingOf,
  capRemaining,
  drawRound,
  reportVideo,
  reportShare,
  checkin,
  todayState,
  // 测试/工具用：暴露给 verify 脚本按需重置
  _models: { BeidouDay, BeidouDraw },
};
