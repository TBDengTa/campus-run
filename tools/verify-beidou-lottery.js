// 端到端验证：北斗运动 3.0（铜版经济 + 转盘 + 九宫格连线 + 好友点击归因）
//
// 方案与口径：docs/beidou-economy-plan.md。
// 本脚本真连库、真起 routes/beidou.js（auth 按 header 打桩成指定 actor），
// 用临时账号跑完整链路，最后删干净并恢复原配置 —— 不碰真实学生数据。
//
// 用法：node tools/verify-beidou-lottery.js
const path = require('path');
const serverDir = path.join(__dirname, '..', 'server');
const config = require(path.join(serverDir, 'src', 'config'));
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));
const express = require(path.join(serverDir, 'node_modules', 'express'));

const User = require(path.join(serverDir, 'src', 'models', 'user'));
const GoalConfig = require(path.join(serverDir, 'src', 'models', 'goal-config'));
const RunRecord = require(path.join(serverDir, 'src', 'models', 'run-record'));
const BeidouDay = require(path.join(serverDir, 'src', 'models', 'beidou-day'));
const BeidouDraw = require(path.join(serverDir, 'src', 'models', 'beidou-draw'));
const BeidouWallet = require(path.join(serverDir, 'src', 'models', 'beidou-wallet'));
const BeidouCoinLog = require(path.join(serverDir, 'src', 'models', 'beidou-coin-log'));
const BeidouShareLink = require(path.join(serverDir, 'src', 'models', 'beidou-share-link'));
const BeidouShareClick = require(path.join(serverDir, 'src', 'models', 'beidou-share-click'));
const beidouSvc = require(path.join(serverDir, 'src', 'services', 'beidou'));
const cfgSvc = require(path.join(serverDir, 'src', 'services', 'beidou-config'));
const gridSvc = require(path.join(serverDir, 'src', 'services', 'beidou-grid'));
const { todayKey, addDays } = require(path.join(serverDir, 'src', 'utils', 'dates'));

let failed = 0;
function assert(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ← ' + JSON.stringify(extra)}`);
  if (!cond) failed += 1;
}

const TS = Date.now();
const TAG = `bd3_verify_${TS}`;
const DATE = todayKey();

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });

  // ---- 0) 备份原配置 ----
  const cfgDoc = await GoalConfig.getSingleton();
  const originalBeidou = JSON.parse(JSON.stringify(cfgDoc.beidou));

  // ---- 起真实路由（auth 打桩：按 x-actor 指定调用者）----
  const authMw = require(path.join(serverDir, 'src', 'middlewares', 'auth'));
  const realAuth = authMw.auth;
  const actors = new Map();
  const stubAuth = (req, res, next) => {
    const who = req.headers['x-actor'] || '';
    const doc = actors.get(who);
    if (!doc) return res.status(401).json({ code: 401, message: 'unknown actor' });
    req.user = doc;
    next();
  };
  authMw.auth = stubAuth;
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('routes', 'beidou')) || k.includes(path.join('routes', 'reward-video'))) delete require.cache[k];
  }
  const beidouRouter = require(path.join(serverDir, 'src', 'routes', 'beidou'));
  const rewardVideoRouter = require(path.join(serverDir, 'src', 'routes', 'reward-video'));
  const app = express();
  app.use(express.json());
  app.use('/api/beidou', beidouRouter);
  app.use('/api/reward-video', rewardVideoRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code || 500, message: err.message }));
  const port = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s.address().port));
  });
  const BASE = `http://127.0.0.1:${port}`;
  const call = async (who, method, url, body) => {
    const res = await fetch(`${BASE}${url}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-actor': who },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const payloadOf = (r) => (r && r.data && r.data.data) || {};

  const createdUsers = [];
  const openids = [];
  const mkUser = async (suffix, role = 'student', extra = {}) => {
    const u = await User.create({
      openid: `${TAG}_${suffix}`,
      account: `${TAG}_${suffix}`,
      realName: `北斗${suffix}`,
      role,
      status: 'active',
      ...extra,
    });
    createdUsers.push(u._id);
    openids.push(u.openid);
    return u;
  };

  try {
    // ---- 1) 配置迁移幂等 + 老形态回填 ----
    console.log('\n[1] 配置迁移');
    const mig1 = await beidouSvc.migrateBeidouConfig();
    assert(mig1.migrated === false, '已 v4 的配置不再迁移（幂等）', mig1);
    // 造老形态：version 0 + 旧奖池，清掉新字段
    await GoalConfig.collection.updateOne(
      { key: 'default' },
      {
        $set: { 'beidou.version': 0, 'beidou.prizes': cfgSvc.LEGACY_DEFAULT_PRIZES },
        $unset: {
          'beidou.wheel': 1,
          'beidou.grid': 1,
          'beidou.economy': 1,
          'beidou.coinName': 1,
          'beidou.welcomeCoins': 1,
          'beidou.video.coinPerWatch': 1,
          'beidou.share.coinPerClick': 1,
        },
      }
    );
    const mig2 = await beidouSvc.migrateBeidouConfig();
    assert(mig2.migrated === true, '老形态配置被迁移到 v4', mig2);
    const effOld = await beidouSvc.loadConfig();
    assert(effOld.prizes.some((p) => p.type === 'coin'), '迁移后奖池含铜版奖', effOld.prizes.map((p) => p.type));
    assert(effOld.checkin.milestones.every((m) => m.draw === 0 && m.steps === 0 && m.coin > 0), '签到阶梯迁移为只发铜版');
    const mig3 = await beidouSvc.migrateBeidouConfig();
    assert(mig3.migrated === false, '迁移第二次直接 no-op', mig3);
    // 恢复备份，避免影响后续用例
    const freshDoc = await GoalConfig.getSingleton();
    freshDoc.beidou = originalBeidou;
    await freshDoc.save();

    // ---- 2) 纯函数 ----
    console.log('\n[2] 纯函数');
    const prizes = beidouSvc.normalizePrizes(null);
    const sectors = beidouSvc.buildSectors(prizes);
    assert(sectors.length === 8, '扇区恒为 8 格', sectors.length);
    assert(prizes.some((p) => p.type === 'coin'), '默认奖池含铜版奖');
    const e0 = beidouSvc.buildEffective({});
    assert(e0.wheel.ev.returnRate < 100 && e0.grid.ev.returnRate < 100, '默认返奖率低于成本', [e0.wheel.ev, e0.grid.ev]);
    const fallback = beidouSvc.normalizePrizes([{ key: 'x', type: 'none', weight: 0 }]);
    assert(fallback.length === beidouSvc.DEFAULT_PRIZES.length, '权重全 0 回退默认奖池', fallback.length);
    const g0 = gridSvc.evaluateBoard(Array(9).fill('crown'), e0.grid.symbols);
    assert(g0.totalLines === 8, '全皇冠盘面 → 8 条线', g0.totalLines);
    const oneBoard = Array(9).fill('blank');
    [0, 1, 2].forEach((i) => { oneBoard[i] = 'crown'; });
    const gOne = gridSvc.evaluateBoard(oneBoard, e0.grid.symbols);
    assert(gOne.totalLines === 1 && gOne.rewards[0].amount === (e0.grid.symbols.find((s) => s.key === 'crown').amount || 0), '1 线皇冠 = 单线奖', gOne);
    const twoBoard = Array(9).fill('blank');
    [0, 1, 2, 3, 4, 5].forEach((i) => { twoBoard[i] = 'crown'; });
    const gTwo = gridSvc.evaluateBoard(twoBoard, e0.grid.symbols);
    assert(gTwo.totalLines === 2 && gTwo.coinAmount === 2 * (e0.grid.symbols.find((s) => s.key === 'crown').amount || 0), '2 线皇冠 = 单线奖 × 2', gTwo);
    const mixedBoard = Array(9).fill('blank');
    [0, 1, 2].forEach((i) => { mixedBoard[i] = 'crown'; });
    [3, 4, 5].forEach((i) => { mixedBoard[i] = 'foot'; });
    const gMixed = gridSvc.evaluateBoard(mixedBoard, e0.grid.symbols);
    assert(gMixed.coinAmount > 0 && gMixed.stepsAmount > 0, '不同图案的线可同一局混合发铜版+步数', gMixed);
    assert(gMixed.rewards.length === 2, '混合奖励按图案分组', gMixed.rewards);

    // ---- 3) 测试配置 ----
    const doc = await GoalConfig.getSingleton();
    doc.beidou.enabled = true;
    doc.beidou.sfxEnabled = true;
    doc.beidou.coinName = '铜版';
    doc.beidou.welcomeCoins = 100;
    doc.beidou.wheel = { enabled: true, cost: 1, maxPerDay: 0, pity: { afterLosses: 2, prizeKey: 'coin_2' } };
    doc.beidou.grid = {
      ...JSON.parse(JSON.stringify(cfgSvc.DEFAULTS.grid)),
      enabled: true,
      cost: 1,
      maxPerDay: 0,
      pity: { afterLosses: 2, symbolKey: 'star' },
      symbols: [
        { key: 'star', label: '星星', icon: '⭐', iconUrl: '', type: 'coin', amount: 2, weight: 80, tier: 'low' },
        { key: 'blank', label: '空白', icon: '▫', iconUrl: '', type: 'none', amount: 0, weight: 20, tier: 'none' },
      ],
    };
    doc.beidou.economy = { dailyGameCoinCap: 1000, payoutWarnPercent: 100, highTierWarnPercent: 10 };
    doc.beidou.prizes = [
      { key: 'coin_2', label: '2 铜版', type: 'coin', amount: 2, weight: 1, tier: 'low' },
      { key: 'none', label: '谢谢参与', type: 'none', amount: 0, weight: 1, tier: 'none' },
    ];
    doc.beidou.video = { enabled: true, coinPerWatch: 1, dailyLimit: 10, adUnitId: '' };
    doc.beidou.share = { enabled: true, coinPerClick: 1, dailyLimit: 3, tokenExpireDays: 7 };
    doc.beidou.checkin = { enabled: true, loopAfter: true, milestones: Array.from({ length: 7 }, () => ({ coin: 1, draw: 0, steps: 0 })) };
    doc.beidou.draw = { maxPerDay: 0, dailyStepsCap: 3000 };
    await doc.save();

    const stu = await mkUser('stu');
    const friend1 = await mkUser('f1');
    const friend2 = await mkUser('f2');
    const friend3 = await mkUser('f3');
    const friend4 = await mkUser('f4');
    const teacher = await mkUser('tea', 'teacher');
    actors.set('stu', stu);
    actors.set('f1', friend1);
    actors.set('f2', friend2);
    actors.set('f3', friend3);
    actors.set('f4', friend4);
    actors.set('tea', teacher);

    // ---- 4) 首屏 + 新手赠送 ----
    console.log('\n[3] 首屏与新手赠送');
    const today1 = payloadOf(await call('stu', 'GET', '/api/beidou/today'));
    assert(today1.enabled === true, 'today enabled');
    assert(today1.coin && today1.coin.balance === 100, '首次进入赠送 100 铜版', today1.coin);
    assert(today1.draw && today1.draw.cost === 1 && Array.isArray(today1.draw.sectors) && today1.draw.sectors.length === 8, 'today 转盘字段齐全');
    assert(today1.grid && today1.grid.cost === 1 && today1.grid.symbols.length > 0, 'today 九宫格字段齐全');
    assert(today1.share && !!today1.share.token && /bdshare=/.test(today1.share.path), 'today 预生成分享令牌', today1.share);
    assert(today1.checkin.cells.length === 7, 'today 签到 7 格', today1.checkin.cells && today1.checkin.cells.length);
    assert(today1.video.drawPerWatch === 0 && today1.share.drawPerShare === 0, '旧字段不再发次数');
    const today2 = payloadOf(await call('stu', 'GET', '/api/beidou/today'));
    assert(today2.coin.balance === 100, '再次进入不重复赠送', today2.coin.balance);

    // ---- 5) 看视频只发铜版 ----
    console.log('\n[4] 看视频只发铜版');
    const recordsBefore = await RunRecord.countDocuments({ openid: stu.openid });
    const v1 = payloadOf(await call('stu', 'POST', '/api/beidou/video/report', { watchId: 'w1' }));
    assert(v1.success === true && v1.gainedCoin === 1, '看视频 +1 铜版', v1);
    assert(v1.coin.balance === 101, '余额 101', v1.coin.balance);
    const dayV = await BeidouDay.findOne({ openid: stu.openid, date: DATE }).lean();
    assert((dayV.draw.total || 0) === 0, '看视频不再加抽奖次数（draw.total=0）', dayV.draw);
    assert((await RunRecord.countDocuments({ openid: stu.openid })) === recordsBefore, '看视频不写 run_records');
    const v2 = payloadOf(await call('stu', 'POST', '/api/beidou/video/report', { watchId: 'w1' }));
    assert(v2.duplicated === true && v2.gainedCoin === 0, '同一 watchId 幂等', v2);

    // ---- 6) 签到只发铜版 ----
    console.log('\n[5] 签到只发铜版');
    const c1 = payloadOf(await call('stu', 'POST', '/api/beidou/checkin', {}));
    assert(c1.success === true && c1.award.coin === 1 && c1.award.draw === 0 && c1.award.steps === 0, '签到 +1 铜版、不发次数/步数', c1);
    const c2 = payloadOf(await call('stu', 'POST', '/api/beidou/checkin', {}));
    assert(c2.success === false && c2.duplicated === true, '重复签到被拒', c2);
    const dayC = await BeidouDay.findOne({ openid: stu.openid, date: DATE }).lean();
    assert((dayC.draw.stepsAwarded || 0) === 0, '签到不写 stepsAwarded', dayC.draw.stepsAwarded);

    // ---- 7) 分享：好友点开才算 ----
    console.log('\n[6] 分享归因');
    const oldShare = payloadOf(await call('stu', 'POST', '/api/beidou/share/report', { shareId: 's1' }));
    assert(oldShare.success === false && oldShare.deprecated === true, '旧 share/report 只回 deprecated', oldShare);
    const intent = payloadOf(await call('stu', 'POST', '/api/beidou/share/intent', {}));
    assert(intent.success === true && /^[a-f0-9]{16,64}$/.test(intent.token), '分享令牌生成', intent.token);
    const self = payloadOf(await call('stu', 'POST', '/api/beidou/share/click', { token: intent.token }));
    assert(self.success === false && self.self === true, '自己点不算', self);
    const f1 = payloadOf(await call('f1', 'POST', '/api/beidou/share/click', { token: intent.token }));
    assert(f1.success === true && f1.rewarded === true, '好友 1 点开 → 分享者 +1', f1);
    const f1dup = payloadOf(await call('f1', 'POST', '/api/beidou/share/click', { token: intent.token }));
    assert(f1dup.success === false && f1dup.duplicated === true, '同一好友重复点不算', f1dup);
    const f2 = payloadOf(await call('f2', 'POST', '/api/beidou/share/click', { token: intent.token }));
    const f3 = payloadOf(await call('f3', 'POST', '/api/beidou/share/click', { token: intent.token }));
    assert(f2.rewarded === true && f3.rewarded === true, '好友 2/3 各 +1', [f2, f3]);
    const f4 = payloadOf(await call('f4', 'POST', '/api/beidou/share/click', { token: intent.token }));
    assert(f4.success === false && f4.capped === true, '分享者每日 3 次上限', f4);
    const stuWallet = await BeidouWallet.findOne({ openid: stu.openid }).lean();
    assert(stuWallet.balance === 105, '分享者余额 100 + 看视频1 + 签到1 + 分享3 = 105', stuWallet.balance);
    // 过期令牌
    await BeidouShareLink.updateOne({ token: intent.token }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = payloadOf(await call('f4', 'POST', '/api/beidou/share/click', { token: intent.token }));
    assert(expired.success === false && /过期|失效/.test(expired.message || ''), '过期令牌被拒', expired);
    // 教师点开
    const teaClick = payloadOf(await call('tea', 'POST', '/api/beidou/share/click', { token: intent.token }));
    assert(teaClick.success === false, '教师不能助力', teaClick);

    // ---- 8) 转盘：扣币/发币/幂等/保底 ----
    console.log('\n[7] 转盘');
    const gamer = await mkUser('gamer');
    actors.set('gamer', gamer);
    const gToday = payloadOf(await call('gamer', 'GET', '/api/beidou/today'));
    assert(gToday.coin.balance === 100, '玩家余额 100', gToday.coin.balance);
    const d1 = payloadOf(await call('gamer', 'POST', '/api/beidou/draw', { drawId: 'd1' }));
    assert(d1.success === true && !d1.duplicated, '转盘第 1 次成功', d1);
    assert(d1.coin.balance === (d1.prize.type === 'coin' ? 101 : 99), '按奖品类型正确结算余额', d1.prize);
    const dup = payloadOf(await call('gamer', 'POST', '/api/beidou/draw', { drawId: 'd1' }));
    assert(dup.success === true && dup.duplicated === true && dup.prize.key === d1.prize.key, '同一 drawId 幂等返回上次结果', dup);
    const w1 = await BeidouWallet.findOne({ openid: gamer.openid }).lean();
    const logs1 = await BeidouCoinLog.find({ openid: gamer.openid }).lean();
    const sum1 = logs1.reduce((s, x) => s + x.delta, 0);
    assert(sum1 === w1.balance, '钱包余额 = 流水合计', { sum: sum1, balance: w1.balance });
    // 保底：直接设置连续未中，奖池只有 none，下一局必须合成铜版奖
    doc.beidou.prizes = [{ key: 'none', label: '谢谢参与', type: 'none', amount: 0, weight: 1, tier: 'none' }];
    doc.beidou.wheel.pity = { afterLosses: 2, prizeKey: 'coin_2' };
    await doc.save();
    await BeidouWallet.updateOne({ openid: gamer.openid }, { $set: { 'luck.wheelLosses': 2 } });
    const pityDraw = payloadOf(await call('gamer', 'POST', '/api/beidou/draw', { drawId: 'pity1' }));
    assert(pityDraw.success === true && pityDraw.pity === true && pityDraw.prize.type === 'coin', '转盘保底触发并合成铜版奖', pityDraw);
    // 余额不足
    await BeidouWallet.updateOne({ openid: gamer.openid }, { $set: { balance: 0 } });
    const poor = payloadOf(await call('gamer', 'POST', '/api/beidou/draw', { drawId: 'poor1' }));
    assert(poor.success === false && /铜版不足/.test(poor.message || ''), '余额不足拒绝且提示铜版', poor);

    // 恢复奖池，便于后续九宫格与封顶
    doc.beidou.prizes = [
      { key: 'coin_2', label: '2 铜版', type: 'coin', amount: 2, weight: 1, tier: 'low' },
      { key: 'none', label: '谢谢参与', type: 'none', amount: 0, weight: 1, tier: 'none' },
    ];
    doc.beidou.wheel.pity = { afterLosses: 2, prizeKey: 'coin_2' };
    await doc.save();
    await BeidouWallet.updateOne({ openid: gamer.openid }, { $set: { balance: 100, 'luck.wheelLosses': 0 } });

    // ---- 8) 中奖播报：脱敏 / exitRanking 双向 ----
    console.log('\n[7b] 中奖播报');
    const feedA = await mkUser('feedA');
    const feedB = await mkUser('feedB', 'student', { privacy: { exitRanking: true } });
    await BeidouDraw.create({
      openid: feedA.openid, date: DATE, drawId: `${TAG}_feed_a`, game: 'wheel',
      prizeKey: 'coin_2', prizeLabel: '2 铜版', type: 'coin', amount: 2,
      roll: 0.1, index: 0, status: 'settled', source: 'wallet', cost: 1,
    });
    const FEED_B_AMOUNT = 777;
    await BeidouDraw.create({
      openid: feedB.openid, date: DATE, drawId: `${TAG}_feed_b`, game: 'wheel',
      prizeKey: 'probe', prizeLabel: '探测奖', type: 'coin', amount: FEED_B_AMOUNT,
      roll: 0.2, index: 0, status: 'settled', source: 'wallet', cost: 1,
    });
    const feedRes = payloadOf(await call('stu', 'GET', '/api/beidou/winners?limit=50'));
    const feedItems = feedRes.items || [];
    assert(feedItems.every((x) => x.nameMasked && x.nameMasked.length <= 4), '播报名字都是短脱敏串', feedItems.map((x) => x.nameMasked).slice(0, 5));
    assert(!JSON.stringify(feedRes).includes(feedA.realName), '响应体不含完整姓名');
    assert(!feedItems.some((x) => x.amount === FEED_B_AMOUNT), 'exitRanking 学生不进播报');
    await User.updateOne({ _id: feedB._id }, { $set: { 'privacy.exitRanking': false } });
    const feedOpen = await beidouSvc.winnersFeed({ limit: 50 });
    assert((feedOpen.items || []).some((x) => x.amount === FEED_B_AMOUNT), '关掉 exitRanking 后同一人进播报（双向验证）');
    await User.updateOne({ _id: feedB._id }, { $set: { 'privacy.exitRanking': true } });

    // ---- 9) 九宫格：盘面/连线/幂等/保底 ----
    console.log('\n[8] 九宫格');
    const g1 = payloadOf(await call('gamer', 'POST', '/api/beidou/grid/play', { playId: 'g1' }));
    assert(g1.success === true && Array.isArray(g1.board) && g1.board.length === 9, '九宫格返回 9 格', g1.board && g1.board.length);
    assert(Array.isArray(g1.lines) && g1.lines.length === g1.prize.lines, '中奖线数与奖品一致', { lines: g1.lines && g1.lines.length, prize: g1.prize });
    assert(Array.isArray(g1.rewards) && g1.rewards.reduce((s, r) => s + r.lines, 0) === (g1.lines || []).length, 'rewards 按图案分组且线数合计正确', g1.rewards);
    assert(g1.prize.lines === (g1.lines || []).length, '多条线全部返回（老虎机）', g1.prize);
    assert(g1.board.every((c) => typeof c.iconUrl === 'string'), '每格带 iconUrl 字段');
    const gdup = payloadOf(await call('gamer', 'POST', '/api/beidou/grid/play', { playId: 'g1' }));
    assert(gdup.success === true && gdup.duplicated === true, '同一 playId 幂等', gdup);
    // 保底：直接设置连续未中，下一局必须至少 1 线
    doc.beidou.grid.pity = { afterLosses: 2, symbolKey: 'star' };
    await doc.save();
    await BeidouWallet.updateOne({ openid: gamer.openid }, { $set: { 'luck.gridLosses': 2 } });
    const gPity = payloadOf(await call('gamer', 'POST', '/api/beidou/grid/play', { playId: 'gpity1' }));
    assert(gPity.success === true && gPity.pity === true && (gPity.lines || []).length >= 1, '九宫格保底触发且至少有 1 线', gPity);
    assert(gPity.rewards.some((r) => r.symbolKey === 'star'), '保底图案为配置的 star', gPity.rewards);
    doc.beidou.grid.pity = { afterLosses: 2, symbolKey: 'star' };
    await doc.save();

    // ---- 10) 封顶 ----
    console.log('\n[9] 每日上限');
    const capUser = await mkUser('cap');
    actors.set('cap', capUser);
    doc.beidou.prizes = [{ key: 'coin_5', label: '5 铜版', type: 'coin', amount: 5, weight: 1, tier: 'mid' }];
    doc.beidou.economy.dailyGameCoinCap = 2;
    doc.beidou.wheel.cost = 1;
    await doc.save();
    const cap1 = payloadOf(await call('cap', 'POST', '/api/beidou/draw', { drawId: 'c1' }));
    assert(cap1.success === true && cap1.prize.type === 'coin' && cap1.prize.amount === 2 && cap1.coinCapped === true, '铜版奖按剩余额度部分发放', cap1);
    const cap2 = payloadOf(await call('cap', 'POST', '/api/beidou/draw', { drawId: 'c2' }));
    assert(cap2.success === true && cap2.prize.type === 'none' && cap2.coinCapped === true, '额度用尽后降级为空奖', cap2);
    // 步数封顶
    doc.beidou.prizes = [{ key: 'steps_100', label: '100 步', type: 'steps', amount: 100, weight: 1, tier: 'low' }];
    doc.beidou.draw.dailyStepsCap = 1;
    await doc.save();
    const stepCap = payloadOf(await call('cap', 'POST', '/api/beidou/draw', { drawId: 'c3' }));
    assert(stepCap.success === true && stepCap.prize.type === 'none' && stepCap.capped === true, '步数奖超封顶降级为空奖', stepCap);
    const capRec = await RunRecord.findOne({ openid: capUser.openid, date: DATE, source: 'beidou' }).lean();
    assert(!capRec || capRec.steps === 0, '被封顶的步数奖不写 run_records', capRec && capRec.steps);

    // ---- 11) 教师拦截 ----
    console.log('\n[10] 教师拦截');
    const teaBefore = await BeidouWallet.countDocuments({ openid: teacher.openid });
    const tDraw = payloadOf(await call('tea', 'POST', '/api/beidou/draw', { drawId: 'td1' }));
    const tGrid = payloadOf(await call('tea', 'POST', '/api/beidou/grid/play', { playId: 'tg1' }));
    const tVideo = payloadOf(await call('tea', 'POST', '/api/beidou/video/report', { watchId: 'tv1' }));
    const tCheckin = payloadOf(await call('tea', 'POST', '/api/beidou/checkin', {}));
    const tIntent = payloadOf(await call('tea', 'POST', '/api/beidou/share/intent', {}));
    assert([tDraw, tGrid, tVideo, tCheckin, tIntent].every((x) => x.success === false), '教师五个写接口全部 success:false', { tDraw, tGrid, tVideo, tCheckin, tIntent });
    const teaAfter = await BeidouWallet.countDocuments({ openid: teacher.openid });
    assert(teaBefore === teaAfter, '教师不产生钱包', { before: teaBefore, after: teaAfter });

    // ---- 12) 旧 API 兼容 ----
    console.log('\n[11] 旧 API 兼容');
    const compat = payloadOf(await call('stu', 'GET', '/api/beidou/today'));
    assert(compat.draw && typeof compat.draw.remaining === 'number' && Array.isArray(compat.draw.prizes) && Array.isArray(compat.draw.sectors), '旧 draw 字段仍在');
    assert(compat.video.drawPerWatch === 0 && compat.share.drawPerShare === 0, '旧任务字段以 0 兼容');
    assert(compat.checkin.milestones.every((m) => m.draw === 0 && m.steps === 0), '旧签到阶梯字段以 0 兼容');
    const oldReport = payloadOf(await call('stu', 'POST', '/api/reward-video/report', { watchId: 'old1' }));
    assert(oldReport.success === false && oldReport.deprecated === true, '旧 reward-video/report 仍 deprecated', oldReport);

    // ---- 13) 钱包/流水对账 ----
    console.log('\n[12] 钱包与流水对账');
    let bad = 0;
    for (const openid of openids) {
      // gamer 的余额被用例手动 $set 过（测「余额不足」），不参与本次对账
      if (openid === gamer.openid) continue;
      const w = await BeidouWallet.findOne({ openid }).lean();
      if (!w) continue;
      const logs = await BeidouCoinLog.find({ openid }).lean();
      const sum = logs.reduce((s, x) => s + x.delta, 0);
      if (sum !== w.balance || w.balance < 0) bad += 1;
    }
    assert(bad === 0, '所有临时钱包：余额 = 流水合计且非负', bad);
    const draws = await BeidouDraw.find({ openid: { $in: openids } }).lean();
    assert(draws.every((d) => ['wheel', 'grid'].includes(d.game)), '所有流水都有合法 game', draws.filter((d) => !['wheel', 'grid'].includes(d.game)).length);

    // ---- 14) 管理端 ----
    console.log('\n[13] 管理端');
    const adminUser = await mkUser('admin', 'teacher', { permissions: ['*'] });
    actors.set('admin', adminUser);
    const adminAuthMw = require(path.join(serverDir, 'src', 'middlewares', 'auth'));
    const realAdminAuth = adminAuthMw.auth;
    adminAuthMw.auth = stubAuth;
    for (const k of Object.keys(require.cache)) {
      if (k.includes(path.join('routes', 'admin'))) delete require.cache[k];
    }
    const adminApp = express();
    adminApp.use(express.json());
    adminApp.use('/api/admin', require(path.join(serverDir, 'src', 'routes', 'admin')));
    // eslint-disable-next-line no-unused-vars
    adminApp.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code || 500, message: err.message }));
    const adminPort = await new Promise((r) => {
      const s = adminApp.listen(0, '127.0.0.1', () => r(s.address().port));
    });
    const adminCall = async (method, url, body) => {
      const res = await fetch(`http://127.0.0.1:${adminPort}${url}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-actor': 'admin' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    const previewBody = doc.toObject ? doc.toObject().beidou : doc.beidou;
    const preview = payloadOf(await adminCall('POST', '/api/admin/config/beidou-preview', { beidou: previewBody }));
    assert(preview.effective && preview.effective.prizes && preview.effective.wheel.ev, '后台预览返回归一概率/EV', preview.effective && preview.effective.prizes);
    const drawsRes = payloadOf(await adminCall('GET', `/api/admin/config/beidou-draws?game=grid&dateFrom=${DATE}&dateTo=${DATE}&limit=100`));
    assert(drawsRes.list && drawsRes.list.every((x) => x.game === 'grid'), '管理端按 game 筛选九宫格', drawsRes.list && drawsRes.list.map((x) => x.game));
    assert(drawsRes.facets && drawsRes.facets.game && drawsRes.facets.type, '流水分面含 game/type');
    const coinRes = payloadOf(await adminCall('GET', `/api/admin/config/beidou-coin-logs?dateFrom=${DATE}&dateTo=${DATE}&limit=100`));
    assert(coinRes.list && coinRes.totals && coinRes.facets, '铜版流水接口返回列表/合计/分面', coinRes.totals);
    const ecoRes = payloadOf(await adminCall('GET', '/api/admin/config/beidou-economy?days=7'));
    assert(ecoRes.range && ecoRes.byGame && ecoRes.byGame.length === 2, '经济概览返回两种玩法', ecoRes.byGame);
    // 保存回归：编辑态配置的 prizes/grid.symbols 必须保留内部 key，否则 PUT 会报 Path `key` is required
    const editRes = payloadOf(await adminCall('GET', '/api/admin/config'));
    assert(editRes.beidou && (editRes.beidou.prizes || []).every((p) => p && p.key), '管理端编辑态奖池保留 key', editRes.beidou && editRes.beidou.prizes);
    assert(editRes.beidou && (editRes.beidou.grid.symbols || []).every((s) => s && s.key), '管理端编辑态九宫格图案保留 key', editRes.beidou && editRes.beidou.grid.symbols);
    assert(editRes.beidou && (editRes.beidou.checkin.milestones || []).length === 7
      && editRes.beidou.checkin.milestones.every((m, i) => m.dayNo === i + 1), '管理端签到固定 7 行且 dayNo 稳定', editRes.beidou && editRes.beidou.checkin.milestones);
    // 真正走一次保存：历史 bug 是编辑态数组被 spread 成无 key 子文档，PUT 时才报 Path `key` is required
    const saveRes = payloadOf(await adminCall('PUT', '/api/admin/config', { beidou: editRes.beidou }));
    assert(saveRes.beidouEffective && saveRes.beidouEffective.grid && saveRes.beidouEffective.grid.symbols.length > 0, '管理端原样保存配置成功（不再 Path `key` is required）', saveRes.beidouEffective && saveRes.beidouEffective.grid);
    adminAuthMw.auth = realAdminAuth;

    // ---- 15) 清理 ----
    console.log('\n[14] 清理');
    await BeidouWallet.deleteMany({ openid: { $in: openids } });
    await BeidouCoinLog.deleteMany({ openid: { $in: openids } });
    await BeidouShareLink.deleteMany({ ownerOpenid: { $in: openids } });
    await BeidouShareClick.deleteMany({ $or: [{ ownerOpenid: { $in: openids } }, { visitorOpenid: { $in: openids } }] });
    await BeidouDay.deleteMany({ openid: { $in: openids } });
    await BeidouDraw.deleteMany({ openid: { $in: openids } });
    await RunRecord.deleteMany({ openid: { $in: openids } });
    await User.deleteMany({ _id: { $in: createdUsers } });
    const cfgRestore = await GoalConfig.getSingleton();
    cfgRestore.beidou = originalBeidou;
    await cfgRestore.save();

    const left = {
      users: await User.countDocuments({ openid: { $in: openids } }),
      wallets: await BeidouWallet.countDocuments({ openid: { $in: openids } }),
      logs: await BeidouCoinLog.countDocuments({ openid: { $in: openids } }),
      links: await BeidouShareLink.countDocuments({ ownerOpenid: { $in: openids } }),
      clicks: await BeidouShareClick.countDocuments({ $or: [{ ownerOpenid: { $in: openids } }, { visitorOpenid: { $in: openids } }] }),
      days: await BeidouDay.countDocuments({ openid: { $in: openids } }),
      draws: await BeidouDraw.countDocuments({ openid: { $in: openids } }),
      records: await RunRecord.countDocuments({ openid: { $in: openids } }),
    };
    assert(Object.values(left).every((n) => n === 0), '临时数据残留为 0', left);
    const restored = await GoalConfig.getSingleton();
    assert(JSON.stringify(restored.beidou.prizes) === JSON.stringify(originalBeidou.prizes), '奖池配置已恢复原值');
  } finally {
    authMw.auth = realAuth;
    await mongoose.disconnect();
    console.log(failed ? `\n共 ${failed} 处失败` : '\n北斗运动 3.0 端到端验证全部通过');
    process.exit(failed ? 1 : 0);
  }
})().catch((e) => {
  console.error('验证脚本异常：', e);
  process.exit(1);
});
