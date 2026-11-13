const crypto = require('crypto');

const GoalConfig = require('../models/goal-config');
const BeidouDay = require('../models/beidou-day');
const BeidouDraw = require('../models/beidou-draw');
const RunRecord = require('../models/run-record');
const wechat = require('./wechat');
const rewardVideoSvc = require('./reward-video');
const { maskName } = require('./name-mask');
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
    // 音效总开关（管理端可关）：关掉后前端连 WAV 都不合成，省电也省心
    sfxEnabled: b.sfxEnabled !== false,
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
  if (input.sfxEnabled !== undefined) out.sfxEnabled = input.sfxEnabled !== false;

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

  // 先对齐历史来源账本（老文档没有 used* 字段，不对齐会把新抽奖错算成某个来源）
  let day = await ensureDay(openid, date);
  day = await alignLegacyUsage(day);
  if (!day) day = await ensureDay(openid, date);

  // ① 幂等：同一个 drawId 重复提交 → 原样返回上一次结果（不再消耗次数、不再发步数）
  //
  // ⚠️ 必须带 openid 查：幂等的语义是「**这个人**这一笔」，不带 openid 时
  //    两个用户撞出同一个 drawId 就会把对方的结果当成自己的（且对方发的步数会算在头上）。
  const dup = await BeidouDraw.findOne({ openid, drawId: nonce }).lean();
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
  //
  // ⚠️ 同时扣减**来源账本**（usedVideo/usedShare/…）：两边必须在**同一次原子更新**里完成，
  //    否则「used 加了、来源没加」会让来源余额虚高，下一次抽奖就扣错来源。
  //    这里用同一个 $inc 下发，MongoDB 单文档更新本身是原子的。
  const source = pickSource(day);
  const sourceInc = source === 'unknown' ? {} : { [`draw.${SOURCE_USED_FIELD[source]}`]: 1 };
  const claimed = await BeidouDay.findOneAndUpdate(
    { _id: day._id, 'draw.used': day.draw.used },
    { $inc: { 'draw.used': 1, ...sourceInc } },
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
      // 本笔消耗的机会来自哪个渠道（管理端按来源筛选的依据）
      source,
    });
  } catch (e) {
    // 唯一键冲突 = 并发的同一笔：撤销刚占用的次数**与来源账本**（两边都要退，否则来源余额永久偏差）
    await BeidouDay.updateOne(
      { _id: claimed._id },
      { $inc: { 'draw.used': -1, ...(source === 'unknown' ? {} : { [`draw.${SOURCE_USED_FIELD[source]}`]: -1 }) } }
    ).catch(() => {});
    const again = await BeidouDraw.findOne({ openid, drawId: nonce }).lean();
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

/**
 * 启动期幂等迁移：把 `drawId` 的**全局唯一**索引换成 `(openid, drawId)` 按人唯一。
 *
 * 为什么必须显式删旧索引（与 services/dorms.js::migrateSlotIndex 同一类陷阱）：
 * Mongoose 只会新建缺失的索引，**不会替换已存在的同名/同键索引**。
 * 旧的 `drawId_1 unique` 继续存在时，两个用户撞出同一个 drawId，第二条插入会被直接拒掉，
 * 而调用方把它当「重复提交」走了幂等分支 → 返回 success:true + **别人的奖品**，
 * 自己的次数不扣、步数不发，日志里一点痕迹都没有。
 *
 * 旧数据不会与新索引冲突（全局唯一必然蕴含按人唯一），所以先建后删是安全的。
 */
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
  // 冗余索引：source_1 是 source_1_date_-1 的左前缀，留着只多付写放大、不会被选中查询
  if (names.includes('source_1')) {
    await col.dropIndex('source_1');
    out.dropped.push('source_1');
  }
  return out;
}

// ===== 中奖播报（只读，别人也能看到）=====

/**
 * 稀有度：由**服务端**判定，前端不得自己算。
 *
 * 口径（方案 Q4 定档）：
 *   · rarest = 该奖池里 percent 最小 **且 ≤ 10%**（只取最小不够：
 *     奖池很平时「最小」可能也有 25%，人人都成了「最稀有」，播报就没意义了）；
 *   · rare   = percent < 10%；
 *   · normal = 其余。
 *
 * 为什么门槛要写死 10%：这是「值得播报」的门槛，不是概率算法的一部分。
 * 用配置去调它没有意义（调松了就等于全员稀有），所以放常量而不是进 goal_config。
 */
const RARE_PERCENT = 10;

function rarityOf(prize, prizes) {
  if (!prize || prize.type === 'none') return 'none';
  const pct = Number(prize.percent);
  if (!Number.isFinite(pct)) return 'normal';
  const minPct = Math.min(...(prizes || []).map((p) => Number(p.percent)).filter((n) => Number.isFinite(n)));
  if (Number.isFinite(minPct) && pct <= minPct + 1e-9 && pct <= RARE_PERCENT) return 'rarest';
  if (pct < RARE_PERCENT) return 'rare';
  return 'normal';
}

/**
 * 中奖播报：最近 N 条「有人中奖」的记录（不含谢谢参与）。
 *
 * 三条口径：
 *   ① **姓名脱敏，完整姓名永不出服务端**（services/name-mask.js::maskName）；
 *   ② **不参与排名（privacy.exitRanking）的学生不进播报** ——
 *      这类学生表达过「不想被公开」，把他放进滚动播报与他的选择自相矛盾；
 *   ③ **同一人最多占 2 条**，避免一个人连中把整条播报刷满。
 *
 * 空态由前端渲染（接口正常返回空数组 = 今天还没人中奖），不在这里造假数据。
 *
 * @param {{limit?:number, excludeOpenid?:string}} opts
 */
async function winnersFeed({ limit = 20, excludeOpenid } = {}) {
  const n = Math.min(50, Math.max(1, Number(limit) || 20));
  const cfg = await loadConfig();
  const byKey = new Map((cfg.prizes || []).map((p) => [p.key, p]));

  // 多取一些再过滤/去重，避免前面全是被过滤的人导致最终不足 n 条
  const rows = await BeidouDraw.find({ type: { $ne: 'none' } })
    .sort({ createdAt: -1 })
    .limit(n * 4)
    .lean();
  if (!rows.length) return { items: [], rarityText: buildRarityText(cfg.prizes) };

  const openids = [...new Set(rows.map((r) => r.openid).filter(Boolean))];
  const User = require('../models/user');
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
    if (!u) continue; // 用户已删除（账号清理会连带删流水，这里是兜底）
    if (u.role === 'teacher') continue; // 教师不参与（正常不会产生流水）
    if (u.status === 'banned') continue; // 被封禁账号不上播报
    if (u.privacy && u.privacy.exitRanking) continue; // 口径 ②
    const cnt = perUser.get(r.openid) || 0;
    if (cnt >= 2) continue; // 口径 ③
    perUser.set(r.openid, cnt + 1);

    const prize = byKey.get(r.prizeKey) || { key: r.prizeKey, label: '', type: r.type, percent: null };
    items.push({
      // 脱敏名（唯一出口）：完整姓名不下发
      nameMasked: maskName(u.realName || u.nickname),
      prizeKey: r.prizeKey,
      prizeLabel: prize.label || (r.type === 'steps' ? `${r.amount} 步` : r.type === 'draw' ? '再来一次' : ''),
      prizeType: r.type,
      amount: r.amount || 0,
      rarity: rarityOf({ ...prize, type: r.type, percent: prize.percent }, cfg.prizes),
      percent: prize.percent == null ? null : prize.percent,
      // 只给「今天 10:24」这一级，不下发 ISO 串让前端各转一套
      atText: fmtClock(r.createdAt, { withDay: true }),
      isMine: !!excludeOpenid && r.openid === excludeOpenid,
    });
  }
  return { items, rarityText: buildRarityText(cfg.prizes) };
}

// 播报用的时间文案：今天 → 「10:24」，昨天 → 「昨天 10:24」，更早 → 「11-10 10:24」
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

// 本地日历键（与 utils/dates 的 toDateKey 同口径，这里避免额外 require 的循环依赖顾虑）
function toDateKeyLocal(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 概率区间文案（规则区折叠时也能看到关键信息）
function buildRarityText(prizes) {
  const list = (prizes || []).filter((p) => Number.isFinite(Number(p.percent)));
  if (!list.length) return '';
  const min = list.reduce((a, b) => (Number(a.percent) <= Number(b.percent) ? a : b));
  const max = list.reduce((a, b) => (Number(a.percent) >= Number(b.percent) ? a : b));
  return `最低概率奖：${min.label} ${min.percent}% · 最高：${max.label} ${max.percent}%`;
}

// ===== 抽奖来源账本（用户 2026-11-12「抽奖来源筛选(签到、分享、视频)」）=====

/**
 * 次数来源的扣减优先级。
 *
 * 为什么需要它：次数是一个**合并池**（draw.total），抽奖时到底「花的哪一次」本来没有答案。
 * 但管理端要按来源筛选，就必须给每笔消耗一个归属。这里定死顺序，语义是：
 *   ① prize（再来一次）**最先用** —— 它是上一次抽奖当场回补的，等于「接着抽」，
 *      先花掉才不会让「再来一次」永远沉在池底、显得这个奖没生效；
 *   ② checkin（签到）—— 签到是当日一次性动作，次数容易在池里挂着没人用；
 *   ③ video（看视频）—— 主要产出渠道；
 *   ④ share（分享）—— 成本最低的来源，放最后（它本身没有上限，优先花它会让
 *      「签到/看视频」的投入显得没有意义）。
 *
 * ⚠️ 这个顺序一旦对外解释过就不能随便改：它决定了「签到来源的中奖记录」有多少。
 *    改顺序 = 历史统计口径漂移，所以写死在代码里、不进 goal_config。
 */
const SOURCE_ORDER = ['prize', 'checkin', 'video', 'share'];

// 来源 → 中文文案。**唯一定义处**（管理端列表标签、筛选分面、口径说明都读它）。
// 为什么放这里而不是路由/页面：文案与 SOURCE_ORDER 必须同源 ——
// 分两处写，改了优先级顺序后页面还在说老规矩，管理员按说明去理解数据就会理解反。
const SOURCE_TEXT = {
  prize: '再来一次',
  checkin: '签到',
  video: '看视频',
  share: '邀请',
  unknown: '未记录',
};

// 口径说明里用的长文案（解释「这一笔机会是怎么来的」）
const SOURCE_TEXT_LONG = {
  prize: '再来一次（上一次抽奖当场回补）',
  checkin: '签到奖励',
  video: '看视频奖励',
  share: '邀请同学奖励',
  unknown: '未记录（本次改造前的历史数据，或次数账本异常）',
};

/**
 * 来源口径整句（服务端拼，前端只渲染）。
 * 顺序直接从 SOURCE_ORDER 生成，所以改了优先级这句话自动跟着变。
 */
function sourceNote() {
  return (
    '抽奖次数是一个合并池，抽奖时按 ' +
    SOURCE_ORDER.map((s) => SOURCE_TEXT[s]).join(' → ') +
    ' 的优先级从各来源余额里扣一笔，扣到谁就记谁。' +
    '因此「来源」指的是这一笔机会的账本归属，不是用户从哪个页面点进来的。'
  );
}

// 来源 → beidou_day 里「已用」字段名
const SOURCE_USED_FIELD = {
  prize: 'usedPrize',
  checkin: 'usedCheckin',
  video: 'usedVideo',
  share: 'usedShare',
};

// 来源 → beidou_day 里「获得」字段名
const SOURCE_FROM_FIELD = {
  prize: 'fromPrize',
  checkin: 'fromCheckin',
  video: 'fromVideo',
  share: 'fromShare',
};

/**
 * 判定这次抽奖应该扣哪个来源（纯函数，不改状态）。
 *
 * 余额 = 获得 − 已用。按 SOURCE_ORDER 找到第一个有余额的来源。
 * 全部为 0 时返回 'unknown' —— 这**只可能**发生在老数据（本次改造前抽的奖没有 used* 字段）
 * 或者人为改库之后。返回 unknown 而不是随便挑一个，是为了让管理端能明确看到「口径不明」，
 * 而不是把它静默算进某个来源把统计做假。
 *
 * @returns {'video'|'share'|'checkin'|'prize'|'unknown'}
 */
function pickSource(day) {
  const d = (day && day.draw) || {};
  for (const s of SOURCE_ORDER) {
    const from = Number(d[SOURCE_FROM_FIELD[s]]) || 0;
    const used = Number(d[SOURCE_USED_FIELD[s]]) || 0;
    if (from - used > 0) return s;
  }
  return 'unknown';
}

/**
 * 兼容历史数据（本次改造前抽的奖）：
 *
 * 老文档只有 `used`，没有 `usedVideo/usedShare/…`。如果不处理，pickSource 会看到
 * 「fromVideo=3、usedVideo=0」→ 认为视频还有 3 次余额，于是一直把新抽奖算成「视频来源」，
 * 而实际上那 3 次早就抽掉了 —— 来源统计整片失真，且**不会报任何错**。
 *
 * 修正办法：如果「各来源已用之和」< `used`，说明有差额是老数据消耗的，
 * 把这部分差额压到**当前已用最多的那个来源**上（没有就压到 video），
 * 让「∑used* == used」成立。这是一次性对齐，不影响新数据（新数据两边天然相等）。
 *
 * 打补丁时用 `$inc` 而不是 `$set`：并发下不会把别人刚加的数覆盖掉。
 */
async function alignLegacyUsage(day) {
  if (!day || !day._id) return day;
  const d = day.draw || {};
  const used = Number(d.used) || 0;
  let sum = 0;
  for (const s of SOURCE_ORDER) sum += Number(d[SOURCE_USED_FIELD[s]]) || 0;
  if (sum >= used) return day; // 已经对齐（正常情况）
  const gap = used - sum;
  // 压到当前已用最多的来源上；全都为 0 时压到 video（最符合「老版本主要靠看视频」的实际）。
  // ⚠️ best 必须从 0 起而不是 -1：从 -1 起时「全都为 0」会让第一项（prize）满足 `0 > -1`，
  //    于是 gap 被记到 prize 上——注释说压到 video、代码压到 prize，
  //    而 prize 是扣减优先级最高的来源，等于凭空给它欠下余额（来源统计从此说不清）。
  let target = 'video';
  let best = 0;
  for (const s of SOURCE_ORDER) {
    const v = Number(d[SOURCE_USED_FIELD[s]]) || 0;
    if (v > best) {
      best = v;
      target = s;
    }
  }
  try {
    await BeidouDay.updateOne({ _id: day._id }, { $inc: { [`draw.${SOURCE_USED_FIELD[target]}`]: gap } });
  } catch (e) {
    /* 对齐失败不能阻塞抽奖：最坏结果是这一次来源记为 unknown，不影响发奖 */
    return day;
  }
  const fresh = await BeidouDay.findById(day._id);
  return fresh || day;
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
  const byKey = new Map((cfg.prizes || []).map((p) => [p.key, p]));
  // 今日已入账（四项）：真源 = run_records(source='beidou')，与记录页/首页统计同源
  const earned = await rewardVideoSvc.earnedToday(openid, date);
  const cap = capRemaining(day, cfg);

  return {
    enabled: cfg.enabled,
    date,
    // 音效总开关（管理端可关）：前端据此决定是否初始化音频，关闭时连合成都跳过
    sfxEnabled: cfg.sfxEnabled !== false,
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
    // 概率区间：规则区折叠时也要能看到（合规：概率公示不能藏在展开项里）
    rarityText: buildRarityText(cfg.prizes),
    earned,
    // ✅ atText 是本次补的历史 bug：早前只下发 `at`（Date 对象），
    //    而 WXML 渲染的是 `item.atText` → 最近中奖的时间列恒为空白。
    //    时间文案统一在服务端拼（formatDateTime 的口径），前端不自己转。
    recent: recent.map((r) => {
      const p = byKey.get(r.prizeKey) || {};
      return {
        prizeKey: r.prizeKey,
        prizeLabel: p.label || (r.type === 'steps' ? `${r.amount} 步` : r.type === 'draw' ? '再来一次' : '谢谢参与'),
        type: r.type,
        amount: r.amount,
        capped: r.capped,
        rarity: r.type === 'none' ? 'none' : rarityOf({ ...p, type: r.type }, cfg.prizes),
        at: r.createdAt,
        atText: fmtClock(r.createdAt),
      };
    }),
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
  winnersFeed,
  // 来源账本：管理端筛选与统计共用的唯一口径
  SOURCE_ORDER,
  SOURCE_USED_FIELD,
  SOURCE_FROM_FIELD,
  // 来源文案与口径说明：管理端列表标签/分面/说明句都读这里（唯一定义处）
  SOURCE_TEXT,
  SOURCE_TEXT_LONG,
  sourceNote,
  pickSource,
  migrateDrawIdIndex,
  rarityOf,
  buildRarityText,
  RARE_PERCENT,
  // 测试/工具用：暴露给 verify 脚本按需重置
  _models: { BeidouDay, BeidouDraw },
};
