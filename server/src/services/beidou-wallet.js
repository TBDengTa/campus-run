const BeidouWallet = require('../models/beidou-wallet');
const BeidouCoinLog = require('../models/beidou-coin-log');
const { todayKey } = require('../utils/dates');

/**
 * ===== 北斗运动 3.0 铜版钱包（唯一实现）=====
 *
 * 所有余额变动都必须走这里；路由/页面/脚本不得直接改 `beidou_wallet.balance`。
 *
 * 为什么这样设计：
 *   ① 铜版是**跨天钱包**，不能塞进每人每天的 beidou_day；
 *   ② 扣款用 CAS（balance 做版本号），并发两笔只成功一笔，余额永不为负；
 *   ③ 每笔变动都有带唯一 `idemKey` 的流水，弱网重试/重复点击不会双发；
 *   ④ 不引入 Mongo 事务：流水幂等 + 钱包 CAS + 游戏流水的可恢复状态兜底。
 *
 * 方案见 docs/beidou-economy-plan.md。
 */

const SOURCE_COUNTER = {
  welcome: '', // totalEarned 已统一 +delta，避免重复累加
  video: 'taskEarned',
  checkin: 'taskEarned',
  share: 'taskEarned',
  wheel: 'gameEarned',
  grid: 'gameEarned',
  refund: 'refunded',
};

function isDuplicateKey(e) {
  return !!(e && (e.code === 11000 || e.code === 11001 || /duplicate key/i.test(String(e.message || ''))));
}

/**
 * 取（或建立）钱包。
 *
 * 新手赠送只在**创建钱包那一次**发生；已存在钱包不补发（管理员把 welcomeCoins
 * 从 0 调到 10 不会让老用户凭空多一笔，避免「改配置 = 发钱」）。
 *
 * @param {string} openid
 * @param {{welcomeCoins?:number}} [opts]
 */
async function ensureWallet(openid, opts = {}) {
  if (!openid) throw new Error('ensureWallet: openid required');
  const welcome = Math.max(0, Math.round(Number(opts.welcomeCoins) || 0));
  let wallet = await BeidouWallet.findOne({ openid });
  if (wallet) return wallet;

  try {
    wallet = await BeidouWallet.create({
      openid,
      balance: welcome,
      totalEarned: welcome,
      welcomeGranted: welcome > 0,
    });
    if (welcome > 0) {
      // 赠送流水与钱包创建分开写：钱包建好后写流水（幂等键 welcome 保证并发只有一条）
      await writeLog({
        openid,
        delta: welcome,
        source: 'welcome',
        refId: 'welcome',
        idemKey: 'welcome',
        note: '新手赠送',
        balanceAfter: welcome,
      });
    }
    return wallet;
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    wallet = await BeidouWallet.findOne({ openid });
    if (wallet) return wallet;
    throw e;
  }
}

async function getWallet(openid) {
  return BeidouWallet.findOne({ openid });
}

function dateKeyOf(meta) {
  return (meta && meta.date) || todayKey();
}

async function writeLog(meta) {
  try {
    return await BeidouCoinLog.create({
      openid: meta.openid,
      date: dateKeyOf(meta),
      delta: meta.delta,
      balanceAfter: Number(meta.balanceAfter) || 0,
      source: meta.source,
      game: meta.game || '',
      refId: meta.refId || '',
      idemKey: meta.idemKey,
      note: meta.note || '',
    });
  } catch (e) {
    if (isDuplicateKey(e)) return null; // 重复流水 = 已经入账过
    throw e;
  }
}

/**
 * 发铜版（幂等）。
 *
 * 顺序：先写幂等流水 → 再 `$inc` 钱包 → 回写 balanceAfter。
 * 先写流水是因为 `idemKey` 唯一索引是**并发闸门**：两个重复请求只有一个能插入，
 * 另一个直接返回 duplicated，不会先把余额加了再发现重复。
 *
 * @returns {Promise<{duplicated:boolean, wallet:object|null, delta:number}>}
 */
async function creditCoins(openid, amount, meta = {}) {
  const delta = Math.round(Number(amount) || 0);
  if (!openid || delta <= 0) return { duplicated: false, wallet: await getWallet(openid), delta: 0 };
  if (!meta.idemKey) throw new Error('creditCoins: idemKey required');
  let wallet = await ensureWallet(openid, meta.welcomeOpts);
  const log = await writeLog({
    openid,
    delta,
    source: meta.source,
    game: meta.game,
    refId: meta.refId,
    idemKey: meta.idemKey,
    note: meta.note,
    date: meta.date,
    balanceAfter: 0,
  });
  if (!log) return { duplicated: true, wallet, delta: 0 };

  const inc = {
    balance: delta,
    totalEarned: delta,
  };
  const counter = SOURCE_COUNTER[meta.source];
  if (counter) inc[counter] = delta;
  try {
    wallet = await BeidouWallet.findOneAndUpdate({ openid }, { $inc: inc }, { new: true });
  } catch (e) {
    // 钱包失败 → 撤回流水，保持「有余额必有流水」
    await BeidouCoinLog.deleteOne({ _id: log._id }).catch(() => {});
    throw e;
  }
  await BeidouCoinLog.updateOne({ _id: log._id }, { $set: { balanceAfter: wallet ? wallet.balance : 0 } }).catch(() => {});
  return { duplicated: false, wallet, delta };
}

/**
 * 扣铜版（幂等由调用方的 playId/流水键保证）。
 *
 * 先 CAS 扣余额，再写负流水；流水失败则原路退回余额。
 * 余额不足返回 `{ok:false, reason:'insufficient'}`，不写任何流水。
 */
async function debitCoins(openid, amount, meta = {}) {
  const cost = Math.round(Number(amount) || 0);
  if (!openid || cost <= 0) return { ok: true, wallet: await getWallet(openid), cost: 0 };
  if (!meta.idemKey) throw new Error('debitCoins: idemKey required');
  await ensureWallet(openid, meta.welcomeOpts);
  const wallet = await BeidouWallet.findOneAndUpdate(
    { openid, balance: { $gte: cost } },
    { $inc: { balance: -cost, totalSpent: cost } },
    { new: true }
  );
  if (!wallet) return { ok: false, reason: 'insufficient', wallet: await getWallet(openid), cost };
  const log = await writeLog({
    openid,
    delta: -cost,
    source: meta.source,
    game: meta.game,
    refId: meta.refId,
    idemKey: meta.idemKey,
    note: meta.note,
    date: meta.date,
    balanceAfter: wallet.balance,
  }).catch(async (e) => {
    // 流水写失败 → 退款，避免「余额少了但查不到原因」
    await BeidouWallet.updateOne({ openid }, { $inc: { balance: cost, totalSpent: -cost } }).catch(() => {});
    throw e;
  });
  if (!log) {
    // 幂等键已存在：说明这一笔已经扣过（理论上 play 记录会先挡住），退款避免双扣
    await BeidouWallet.updateOne({ openid }, { $inc: { balance: cost, totalSpent: -cost } }).catch(() => {});
    return { ok: false, reason: 'duplicated', wallet: await getWallet(openid), cost };
  }
  return { ok: true, wallet, cost };
}

/**
 * 游戏扣款 + 保底状态更新（同一次 CAS）。
 *
 * ⚠️ 保底进度必须和扣款绑在同一个 findOneAndUpdate 里：
 *    分开写会出现「两局都读到 losses=4，都认为下一局该保底」，
 *    或者「扣款成功但保底进度被并发覆盖」。
 *
 * @param {string} openid
 * @param {number} cost
 * @param {'wheel'|'grid'} game
 * @param {{losses:number, nextLosses:number, pity:boolean, refId:string, date?:string}} opts
 */
async function debitForPlay(openid, cost, game, opts = {}) {
  const amount = Math.round(Number(cost) || 0);
  const oldLosses = Math.max(0, Math.round(Number(opts.losses) || 0));
  const nextLosses = Math.max(0, Math.round(Number(opts.nextLosses) || 0));
  await ensureWallet(openid, opts.welcomeOpts);
  const lossField = `luck.${game}Losses`;
  const pityField = `luck.${game}PityCount`;
  const inc = { balance: -amount, totalSpent: amount };
  if (opts.pity) inc[pityField] = 1;
  const wallet = await BeidouWallet.findOneAndUpdate(
    { openid, balance: { $gte: amount }, [lossField]: oldLosses },
    { $inc: inc, $set: { [lossField]: nextLosses } },
    { new: true }
  );
  if (!wallet) {
    const current = await getWallet(openid);
    return {
      ok: false,
      reason: current && current.balance < amount ? 'insufficient' : 'conflict',
      wallet: current,
    };
  }
  const log = await writeLog({
    openid,
    delta: -amount,
    source: game,
    game,
    refId: opts.refId,
    idemKey: `cost:${opts.refId}`,
    note: `${game === 'wheel' ? '转盘' : '九宫格'}消耗`,
    date: opts.date,
    balanceAfter: wallet.balance,
  }).catch(async (e) => {
    await BeidouWallet.updateOne(
      { openid },
      { $inc: { balance: amount, totalSpent: -amount, ...(opts.pity ? { [pityField]: -1 } : {}) }, $set: { [lossField]: oldLosses } }
    ).catch(() => {});
    throw e;
  });
  if (!log) {
    await BeidouWallet.updateOne(
      { openid },
      { $inc: { balance: amount, totalSpent: -amount, ...(opts.pity ? { [pityField]: -1 } : {}) }, $set: { [lossField]: oldLosses } }
    ).catch(() => {});
    return { ok: false, reason: 'duplicated', wallet: await getWallet(openid) };
  }
  return { ok: true, wallet, cost: amount };
}

// 当日游戏铜版剩余额度（0 = 不限）
function gameCapRemaining(day, cfg) {
  const cap = (cfg && cfg.economy && cfg.economy.dailyGameCoinCap) || 0;
  const used = (day && day.coin && day.coin.gameEarned) || 0;
  if (!cap) return { cap: 0, used, left: Infinity, reached: false };
  return { cap, used, left: Math.max(0, cap - used), reached: used >= cap };
}

// 保底进度文案（服务端拼，前端不再自己算）
function pityText(after, losses) {
  const afterN = Math.max(0, Math.round(Number(after) || 0));
  const lost = Math.max(0, Math.round(Number(losses) || 0));
  if (!afterN) return '未启用保底';
  const remaining = Math.max(0, afterN - lost);
  if (remaining <= 0) return '保底已就绪：下一局必中';
  return `再抽 ${remaining} 次必中保底`;
}

module.exports = {
  ensureWallet,
  getWallet,
  creditCoins,
  debitCoins,
  debitForPlay,
  gameCapRemaining,
  pityText,
  _logs: { writeLog },
};
