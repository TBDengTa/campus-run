// 端到端验证：北斗运动 2.0（签到 + 转盘抽步数 + 看视频/分享得次数）
//
// 方案与口径：docs/beidou-lottery-plan.md。
// 本脚本真连库、真起 routes/beidou.js（auth 中间件按 header 打桩成指定 actor），
// 用**临时账号**跑完整链路，最后删干净并核对残留为 0 —— 不碰任何真实学生数据。
//
// 覆盖范围（每节都对应一个会静默出错的点；方括号编号是稳定标签，历次新增导致有跳号）：
//   [1]  纯函数：奖池归一 / 扇区 8 格 / index 与命中奖一致
//   [2]  看视频 → 只加抽奖次数，**run_records 一行都不写**（2.0 的核心口径变更）
//   [3]  同一 watchId 重复上报只加一次（幂等）
//   [4]  抽奖 → 步数真的落到 run_records(source='beidou')；流水与步数对账
//   [5]  同一 drawId 重复抽奖 → 只消耗 1 次、只发一次步数，且返回同一个 index
//   [5b] drawId **按人隔离**：两个用户用同一个 drawId 各自都要真实入账（不能串号拿别人的奖品）
//   [6]  次数用尽 → success:false（不抛 4xx，前端能展示可读提示）
//   [7]  **封顶降级**：dailyStepsCap 打到上限后，步数奖变空奖且 capped=true（活动照常进行）
//   [8]  签到：断签从第 1 天重来；连签第 3 天发步数；重复签到被拒
//   [9]  分享：最小间隔内重复上报被去重（服务端防连点）
//   [10] 教师四处（看视频/抽奖/分享/签到）全部 success:false，且不产生任何 run_records
//   [12] 中奖播报：脱敏、响应体反向断言不含完整姓名、exitRanking **双向**验证、同一人限 2 条
//   [13] 来源账本与管理端筛选：source 归属正确、∑used* == used、日期/来源筛选、分面计数
//   [13b] 老形态数据对齐：gap 压到 video 而不是 prize（线上 73/80 文档是老形态）
//   [15] 旧接口 /api/reward-video/report 只回 success:false，不发步数
//   [16] 清理核对：临时数据残留为 0，配置恢复原值
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
const beidouSvc = require(path.join(serverDir, 'src', 'services', 'beidou'));
const { todayKey, addDays } = require(path.join(serverDir, 'src', 'utils', 'dates'));

let failed = 0;
function assert(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ← ' + JSON.stringify(extra)}`);
  if (!cond) failed += 1;
}

const TS = Date.now();
const TAG = `bd_verify_${TS}`;
const DATE = todayKey();

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });

  // ---- 00) 先跑索引迁移 ----
  // 本脚本直连库、不经过 index.js 的启动流程，所以必须自己调一次：
  // 库里若还留着旧的 drawId 全局唯一索引，第 5b 节「两个用户同 drawId」会被旧索引拦住，
  // 测出来的是「索引没迁移」而不是业务逻辑，排查会绕远路。
  const mig = await beidouSvc.migrateDrawIdIndex();
  console.log('[0] 索引迁移:', JSON.stringify(mig));

  // ---- 0) 备份原配置（结束时恢复，绝不把测试配置留在库里）----
  const cfgDoc = await GoalConfig.getSingleton();
  const originalBeidou = JSON.parse(JSON.stringify(typeof cfgDoc.toObject === 'function' ? cfgDoc.toObject().beidou : cfgDoc.beidou));
  const originalRewardVideo = JSON.parse(
    JSON.stringify(typeof cfgDoc.toObject === 'function' ? cfgDoc.toObject().rewardVideo : cfgDoc.rewardVideo)
  );

  // ---- 起真实路由（auth 打桩：按 x-actor 指定调用者）----
  const authMw = require(path.join(serverDir, 'src', 'middlewares', 'auth'));
  const actors = new Map();
  authMw.auth = (req, res, next) => {
    const who = req.headers['x-actor'] || '';
    const doc = actors.get(who);
    if (!doc) return res.status(401).json({ code: 401, message: 'unknown actor' });
    req.user = doc;
    next();
  };
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
  // 路由统一包 { code, message, data }
  const payloadOf = (r) => (r && r.data && r.data.data) || {};

  const createdUsers = [];
  const openids = [];

  try {
    // ---- 1) 纯函数口径 ----
    console.log('\n[1] 纯函数：奖池与扇区');
    const prizes = beidouSvc.normalizePrizes(null);
    const sectors = beidouSvc.buildSectors(prizes);
    assert(sectors.length === 8, '扇区恒为 8 格', sectors.length);
    let mismatch = 0;
    for (let i = 0; i < 200; i += 1) {
      const roll = i / 200;
      const { prize, index } = beidouSvc.pickPrize(prizes, sectors, roll);
      if (sectors[index] !== prize.key) mismatch += 1;
    }
    assert(mismatch === 0, '200 次随机下 index 指向的扇区始终等于命中的奖', mismatch);
    const fallback = beidouSvc.normalizePrizes([{ key: 'zero', type: 'none', weight: 0 }]);
    assert(fallback.length === beidouSvc.DEFAULT_PRIZES.length, '权重全 0 → 回退默认奖池', fallback.length);

    // ---- 2) 造两个临时身份：学生 + 教师 ----
    const student = await User.create({
      openid: `${TAG}_stu`,
      account: `${TAG}_stu`,
      realName: '北斗-学生',
      role: 'student',
      className: `${TAG}_C`,
      status: 'active',
    });
    createdUsers.push(student._id);
    openids.push(student.openid);

    const teacher = await User.create({
      openid: `${TAG}_tea`,
      account: `${TAG}_tea`,
      realName: '北斗-教师',
      role: 'teacher',
      status: 'active',
    });
    createdUsers.push(teacher._id);
    openids.push(teacher.openid);

    actors.set('stu', student);
    actors.set('tea', teacher);

    // 测试用配置：奖池只留「100 步」和「谢谢参与」，便于断言
    cfgDoc.beidou.enabled = true;
    cfgDoc.beidou.video = { drawPerWatch: 1, dailyLimit: 100, adUnitId: '' };
    cfgDoc.beidou.share = { drawPerShare: 1, dailyLimit: 0, minIntervalSec: 5 };
    cfgDoc.beidou.draw = { maxPerDay: 0, dailyStepsCap: 3000 };
    cfgDoc.beidou.checkin = { enabled: true, loopAfter: true, milestones: beidouSvc.DEFAULT_MILESTONES };
    cfgDoc.beidou.prizes = [
      { key: 'steps_100', label: '100 步', type: 'steps', amount: 100, weight: 1 },
      { key: 'none', label: '谢谢参与', type: 'none', amount: 0, weight: 0 },
    ];
    // 上面 none 的 weight=0 会被剔除 → 只剩步数奖。为了能测「空奖降级」，把权重给回去
    cfgDoc.beidou.prizes = [
      { key: 'steps_100', label: '100 步', type: 'steps', amount: 100, weight: 1 },
      { key: 'none', label: '谢谢参与', type: 'none', amount: 0, weight: 1 },
    ];
    await cfgDoc.save();

    // ---- 3) 看视频只加次数、不写 run_records ----
    console.log('\n[2] 看视频：只加抽奖次数，不发步数');
    const beforeRecords = await RunRecord.countDocuments({ openid: student.openid });
    const v1 = payloadOf(await call('stu', 'POST', '/api/beidou/video/report', { watchId: 'w1' }));
    assert(v1.success === true, '看视频上报成功', v1);
    assert(v1.gained === 1, '获得 1 次抽奖机会', v1.gained);
    const afterRecords = await RunRecord.countDocuments({ openid: student.openid });
    assert(afterRecords === beforeRecords, '看视频**没有**写 run_records（2.0 核心口径）', {
      before: beforeRecords,
      after: afterRecords,
    });
    const day1 = await BeidouDay.findOne({ openid: student.openid, date: DATE }).lean();
    assert(day1.draw.total === 1, 'draw.total = 1', day1.draw.total);
    assert(day1.video.count === 1, 'video.count = 1', day1.video.count);

    // ---- 4) watchId 幂等 ----
    console.log('\n[3] watchId 幂等');
    const v2 = payloadOf(await call('stu', 'POST', '/api/beidou/video/report', { watchId: 'w1' }));
    assert(v2.duplicated === true, '同一 watchId 返回 duplicated', v2);
    const day2 = await BeidouDay.findOne({ openid: student.openid, date: DATE }).lean();
    assert(day2.draw.total === 1, '次数没有再加（仍为 1）', day2.draw.total);
    assert(day2.video.count === 1, '观看计数没有再加', day2.video.count);

    // ---- 5) 抽奖：步数落库 + 流水对账 ----
    console.log('\n[4] 抽奖：步数落 run_records 且与流水对账');
    // 先多给几次机会，保证能抽到步数奖
    await call('stu', 'POST', '/api/beidou/video/report', { watchId: 'w2' });
    await call('stu', 'POST', '/api/beidou/video/report', { watchId: 'w3' });
    await call('stu', 'POST', '/api/beidou/video/report', { watchId: 'w4' });
    let stepsAwarded = 0;
    let drawCount = 0;
    for (let i = 0; i < 4; i += 1) {
      const r = payloadOf(await call('stu', 'POST', '/api/beidou/draw', { drawId: `d${i}` }));
      if (!r.success) console.log(`    [诊断] 第 ${i + 1} 次抽奖失败：`, JSON.stringify(r).slice(0, 300));
      // ⚠️ 必须断言「不是 duplicated」：幂等分支同样返回 success:true，
      //    只查 success 的话，drawId 与历史残留相撞时这里会「假通过」，
      //    直到后面「流水条数 = 抽奖次数」才炸 —— 报错点离真因很远，很难查。
      assert(r.success === true && !r.duplicated, `第 ${i + 1} 次抽奖成功且是真实入账（非幂等重放）`, r);
      assert(typeof r.index === 'number' && r.index >= 0 && r.index < 8, `第 ${i + 1} 次 index 合法`, r.index);
      if (r.prize && r.prize.type === 'steps') stepsAwarded += r.prize.amount;
      drawCount += 1;
    }
    const dbgFlows = await BeidouDraw.find({ openid: student.openid }).select('drawId date source prizeKey').lean();
    console.log('    [诊断] 抽奖后全量流水：', JSON.stringify(dbgFlows));
    const beidouRec = await RunRecord.findOne({ openid: student.openid, date: DATE, source: 'beidou' }).lean();
    const flowRows = await BeidouDraw.find({ openid: student.openid, date: DATE }).lean();
    // 诊断：流水为空但步数发了 = 有真 bug，把当日状态打出来（不靠猜）
    if (!flowRows.length) {
      const dbgDay = await BeidouDay.findOne({ openid: student.openid, date: DATE }).lean();
      console.log('    [诊断] 流水为空。当日状态 =', JSON.stringify(dbgDay && dbgDay.draw));
      console.log('    [诊断] beidou 记录 =', JSON.stringify(beidouRec && { steps: beidouRec.steps, date: beidouRec.date }));
      const anyFlow = await BeidouDraw.countDocuments({ openid: student.openid });
      console.log('    [诊断] 该用户全量流水条数 =', anyFlow);
    }
    const flowSteps = flowRows.filter((x) => x.type === 'steps' && !x.capped).reduce((s, x) => s + x.amount, 0);
    assert(flowRows.length === drawCount, '流水条数 = 抽奖次数', { flow: flowRows.length, drawCount });
    assert(flowSteps === stepsAwarded, '流水里的步数之和 = 响应里累加的步数', { flowSteps, stepsAwarded });
    assert((beidouRec ? beidouRec.steps : 0) === stepsAwarded, 'run_records 的 beidou 步数 = 流水步数之和', {
      record: beidouRec ? beidouRec.steps : 0,
      stepsAwarded,
    });
    const dayAfterDraw = await BeidouDay.findOne({ openid: student.openid, date: DATE }).lean();
    assert(dayAfterDraw.draw.stepsAwarded === stepsAwarded, 'beidou_day.draw.stepsAwarded 与流水一致', {
      day: dayAfterDraw.draw.stepsAwarded,
      stepsAwarded,
    });

    // ---- 6) drawId 幂等 ----
    console.log('\n[5] drawId 幂等');
    const beforeDup = await BeidouDay.findOne({ openid: student.openid, date: DATE }).lean();
    const dupRes = payloadOf(await call('stu', 'POST', '/api/beidou/draw', { drawId: 'd0' }));
    const afterDup = await BeidouDay.findOne({ openid: student.openid, date: DATE }).lean();
    assert(dupRes.duplicated === true, '同一 drawId 返回 duplicated', dupRes);
    assert(afterDup.draw.used === beforeDup.draw.used, '重复抽奖不消耗次数', {
      before: beforeDup.draw.used,
      after: afterDup.draw.used,
    });
    assert(afterDup.draw.stepsAwarded === beforeDup.draw.stepsAwarded, '重复抽奖不发步数', {
      before: beforeDup.draw.stepsAwarded,
      after: afterDup.draw.stepsAwarded,
    });
    // ⚠️ 必须带 openid 查：drawId 的幂等语义是「同一个人同一笔」，
    //    全局 findOne({drawId}) 会匹配到别的测试运行留下的同名流水（不同账号），
    //    于是 index 对不上、断言随机失败 —— 这与本次修的真实缺陷是同一个根因。
    const dupFlow = await BeidouDraw.findOne({ openid: student.openid, drawId: 'd0' }).lean();
    assert(dupRes.index === dupFlow.index, '重复抽奖返回的 index 与首次一致（前端停位不错位）', {
      res: dupRes.index,
      flow: dupFlow.index,
    });

    // ---- 6b) drawId 按人隔离（真实缺陷回归）----
    // 两个不同用户用**完全相同**的 drawId：都必须各自成功入账。
    // 旧实现是 drawId 全局唯一索引，第二个人会被判成「重复提交」并拿到第一个人的奖品。
    console.log('\n[5b] drawId 按人隔离（跨用户不串号）');
    const peerC = await User.create({
      openid: `${TAG}_peerC`, account: `${TAG}_peerC`, realName: '同ID同学', role: 'student', status: 'active',
    });
    createdUsers.push(peerC._id);
    openids.push(peerC.openid);
    actors.set('peerC', peerC);
    const SHARED_ID = `${TAG}_shared_draw`;
    await call('stu', 'POST', '/api/beidou/video/report', { watchId: `${TAG}_w_shared` });
    await call('peerC', 'POST', '/api/beidou/video/report', { watchId: `${TAG}_w_shared_c` });
    const dayBeforeC = await BeidouDay.findOne({ openid: peerC.openid, date: DATE }).lean();
    const rA = payloadOf(await call('stu', 'POST', '/api/beidou/draw', { drawId: SHARED_ID }));
    const rB = payloadOf(await call('peerC', 'POST', '/api/beidou/draw', { drawId: SHARED_ID }));
    assert(rA.success === true && !rA.duplicated, '用户 A 用该 drawId 首次抽奖成功', rA);
    assert(rB.success === true && !rB.duplicated, '用户 B 用**同一个** drawId 也首次抽奖成功（不串号）', rB);
    const dayAfterC = await BeidouDay.findOne({ openid: peerC.openid, date: DATE }).lean();
    assert(dayAfterC.draw.used === dayBeforeC.draw.used + 1, '用户 B 的次数被真实扣减（不是返回了 A 的结果）', {
      before: dayBeforeC.draw.used, after: dayAfterC.draw.used,
    });
    const sharedRows = await BeidouDraw.find({ drawId: SHARED_ID }).lean();
    assert(sharedRows.length === 2, '同一个 drawId 在库里存了两条（按人唯一）', sharedRows.length);
    assert(
      sharedRows.map((x) => x.openid).sort().join(',') === [student.openid, peerC.openid].sort().join(','),
      '两条流水分属两个用户', sharedRows.map((x) => x.openid)
    );

    // ---- 7) 次数用尽 ----
    console.log('\n[6] 次数用尽');
    const leftNow = await BeidouDay.findOne({ openid: student.openid, date: DATE }).lean();
    const remainNow = leftNow.draw.total - leftNow.draw.used;
    assert(remainNow >= 0, '剩余次数非负', remainNow);
    // 把剩余次数全部用掉（每次都用新 drawId）
    for (let i = 0; i < remainNow; i += 1) {
      await call('stu', 'POST', '/api/beidou/draw', { drawId: `exhaust_${i}` });
    }
    const exhausted = await call('stu', 'POST', '/api/beidou/draw', { drawId: 'exhaust_final' });
    assert(exhausted.status === 200, '次数用尽返回 200（不是 4xx）', exhausted.status);
    const exData = payloadOf(exhausted);
    assert(exData.success === false, '次数用尽 success:false', exData);
    assert(/次数/.test(exData.message || ''), '提示里说明是次数问题', exData.message);

    // ---- 8) 封顶降级（本方案最关键的一条）----
    console.log('\n[7] 每日步数封顶降级');
    // 造一个新账号，把封顶设成 100，且奖池里**只有步数奖**（保证每次都命中步数奖）
    const capped = await User.create({
      openid: `${TAG}_cap`,
      account: `${TAG}_cap`,
      realName: '北斗-封顶',
      role: 'student',
      status: 'active',
    });
    createdUsers.push(capped._id);
    openids.push(capped.openid);
    actors.set('cap', capped);
    cfgDoc.beidou.prizes = [{ key: 'steps_100', label: '100 步', type: 'steps', amount: 100, weight: 1 }];
    cfgDoc.beidou.draw = { maxPerDay: 0, dailyStepsCap: 100 };
    await cfgDoc.save();
    // 给 3 次机会
    for (let i = 0; i < 3; i += 1) {
      await call('cap', 'POST', '/api/beidou/video/report', { watchId: `cw${i}` });
    }
    const capRaw = await call('cap', 'POST', '/api/beidou/draw', { drawId: 'cd1' });
    const cap1 = payloadOf(capRaw);
    if (!cap1.success) console.log('    （封顶用例首次抽奖返回）', capRaw.status, JSON.stringify(capRaw.data).slice(0, 300));
    assert(cap1.success === true && cap1.prize && cap1.prize.amount === 100, '第 1 次命中步数奖', cap1.prize);
    assert(cap1.capped === false, '第 1 次未封顶', cap1.capped);
    const cap2 = payloadOf(await call('cap', 'POST', '/api/beidou/draw', { drawId: 'cd2' }));
    // 奖池里只有步数奖、没有 none 项 → 服务端必须**合成**一个 0 步空奖来降级。
    // 如果这里回的还是 100 步，说明封顶是假的（本方案唯一的成本闸门）。
    const cap2Steps = cap2.prize && cap2.prize.type === 'steps' ? cap2.prize.amount : 0;
    assert(cap2.capped === true, '第 2 次标记 capped', cap2.capped);
    assert(cap2.prize && cap2.prize.type === 'none', '奖池无空奖项时合成 0 步空奖降级', cap2.prize);
    assert(cap2Steps === 0, '第 2 次不再超发步数', { prize: cap2.prize, capped: cap2.capped });
    const capDay = await BeidouDay.findOne({ openid: capped.openid, date: DATE }).lean();
    assert(capDay.draw.stepsAwarded <= 100, '当日累计发步数不超过封顶值', capDay.draw.stepsAwarded);

    // 恢复正常的奖池配置，继续后面的用例
    cfgDoc.beidou.prizes = [
      { key: 'steps_100', label: '100 步', type: 'steps', amount: 100, weight: 1 },
      { key: 'none', label: '谢谢参与', type: 'none', amount: 0, weight: 1 },
    ];
    cfgDoc.beidou.draw = { maxPerDay: 0, dailyStepsCap: 3000 };
    await cfgDoc.save();

    // ---- 9) 签到：断签重置 / 第 3 天发步数 / 重复签到被拒 ----
    console.log('\n[8] 签到');
    const ck = await User.create({
      openid: `${TAG}_ck`,
      account: `${TAG}_ck`,
      realName: '北斗-签到',
      role: 'student',
      status: 'active',
    });
    createdUsers.push(ck._id);
    openids.push(ck.openid);
    actors.set('ck', ck);

    const c1 = payloadOf(await call('ck', 'POST', '/api/beidou/checkin', {}));
    assert(c1.success === true, '首次签到成功', c1);
    assert(c1.streak === 1, '首次签到 streak = 1', c1.streak);
    const c2 = payloadOf(await call('ck', 'POST', '/api/beidou/checkin', {}));
    assert(c2.success === false && c2.duplicated === true, '重复签到被拒', c2);

    // 造「昨天已签到、streak=2」→ 今天签应为 3，且第 3 档发 200 步
    const y = addDays(DATE, -1);
    await BeidouDay.deleteOne({ openid: ck.openid, date: DATE });
    await BeidouDay.deleteMany({ openid: ck.openid, date: y });
    await BeidouDay.create({
      openid: ck.openid,
      date: y,
      checkin: { done: true, streak: 2, at: new Date(), award: { draw: 1, steps: 0 } },
    });
    const c3 = payloadOf(await call('ck', 'POST', '/api/beidou/checkin', {}));
    assert(c3.success === true && c3.streak === 3, '昨天连签 2 天 → 今天 streak = 3', c3.streak);
    assert(c3.award && c3.award.steps === 200, '第 3 天发 200 步（DEFAULT_MILESTONES）', c3.award);
    const ckRec = await RunRecord.findOne({ openid: ck.openid, date: DATE, source: 'beidou' }).lean();
    assert(ckRec && ckRec.steps === 200, '签到步数落到 run_records', ckRec ? ckRec.steps : null);

    // 断签：昨天没签到（删掉昨天）→ 今天应为 streak=1
    const ck2 = await User.create({
      openid: `${TAG}_ck2`,
      account: `${TAG}_ck2`,
      realName: '北斗-断签',
      role: 'student',
      status: 'active',
    });
    createdUsers.push(ck2._id);
    openids.push(ck2.openid);
    actors.set('ck2', ck2);
    // 前天签过（streak=5），昨天没签 → 今天必须从 1 重来
    const before2 = addDays(DATE, -2);
    await BeidouDay.create({
      openid: ck2.openid,
      date: before2,
      checkin: { done: true, streak: 5, at: new Date(), award: { draw: 1, steps: 0 } },
    });
    const c4 = payloadOf(await call('ck2', 'POST', '/api/beidou/checkin', {}));
    assert(c4.success === true && c4.streak === 1, '断签后 streak 重置为 1（不是 6）', c4.streak);

    // ---- 10) 分享最小间隔 ----
    //
    // ⚠️ 这里必须把间隔调大，否则测的是「网络往返时间」而不是「最小间隔」：
    //    本脚本连的是远程库（一次写 + 一次读回）在慢网络下可能就要 1~2 秒，
    //    默认 5 秒的窗口对 CI/弱网来说太窄 —— 会随机转绿/转红（已实际复现：
    //    同一份代码两次运行结果不同）。用 60 秒把它变成确定性的断言。
    console.log('\n[9] 分享计次与最小间隔');
    cfgDoc.beidou.share = { drawPerShare: 1, dailyLimit: 0, minIntervalSec: 60 };
    await cfgDoc.save();
    const sh1 = payloadOf(await call('stu', 'POST', '/api/beidou/share/report', { shareId: 's1' }));
    assert(sh1.success === true, '首次分享计次成功', sh1);
    const sh2 = payloadOf(await call('stu', 'POST', '/api/beidou/share/report', { shareId: 's2' }));
    assert(sh2.success === false && sh2.duplicated === true, '间隔内的第二次分享被去重（防连点）', sh2);
    // 还原为常规配置，避免影响后续用例
    cfgDoc.beidou.share = { drawPerShare: 1, dailyLimit: 0, minIntervalSec: 5 };
    await cfgDoc.save();

    // ---- 11) 教师四处拦截 ----
    console.log('\n[10] 教师拦截');
    const teaBefore = await RunRecord.countDocuments({ openid: teacher.openid });
    const tv = payloadOf(await call('tea', 'POST', '/api/beidou/video/report', { watchId: 'tw1' }));
    const td = payloadOf(await call('tea', 'POST', '/api/beidou/draw', { drawId: 'td1' }));
    const ts = payloadOf(await call('tea', 'POST', '/api/beidou/share/report', { shareId: 'ts1' }));
    const tc = payloadOf(await call('tea', 'POST', '/api/beidou/checkin', {}));
    assert(tv.success === false && td.success === false && ts.success === false && tc.success === false,
      '教师四个写接口全部 success:false', { tv, td, ts, tc });
    const teaAfter = await RunRecord.countDocuments({ openid: teacher.openid });
    assert(teaBefore === teaAfter, '教师没有产生任何 run_records', { before: teaBefore, after: teaAfter });
    const teaDay = await BeidouDay.countDocuments({ openid: teacher.openid });
    assert(teaDay === 0, '教师没有 beidou_day 文档', teaDay);

    // ---- 12) 中奖播报：脱敏 / 过滤 / 稀有度 ----
    console.log('\n[12] 中奖播报');
    // 造两个同学：一个正常、一个开了「不参与排名」（后者不该出现在播报里）
    const peerA = await User.create({
      openid: `${TAG}_peerA`, account: `${TAG}_peerA`, realName: '陈宇航',
      role: 'student', status: 'active',
    });
    createdUsers.push(peerA._id);
    openids.push(peerA.openid);
    const peerB = await User.create({
      openid: `${TAG}_peerB`, account: `${TAG}_peerB`, realName: '李晓明',
      role: 'student', status: 'active', privacy: { exitRanking: true, hideName: false, hideClass: false, hidePlan: false },
    });
    createdUsers.push(peerB._id);
    openids.push(peerB.openid);

    // 直接写流水（绕开抽奖概率，保证两档稀有度都出现）
    await BeidouDraw.create({
      openid: peerA.openid, date: DATE, drawId: `${TAG}_feed_a`,
      prizeKey: 'steps_100', type: 'steps', amount: 100, roll: 0.1, index: 0, capped: false,
    });
    // peerB 用**唯一金额**做标记（777 不是任何奖池项的金额），
    // 这样能精确判定「这个人有没有进播报」—— 按名字判定不可靠：
    // 真实库里本来就有别的学生中奖，脱敏后同样可能出现「李**」。
    const PEER_B_AMOUNT = 777;
    await BeidouDraw.create({
      openid: peerB.openid, date: DATE, drawId: `${TAG}_feed_b`,
      prizeKey: 'steps_probe', type: 'steps', amount: PEER_B_AMOUNT, roll: 0.2, index: 0, capped: false,
    });

    actors.set('stu', student);
    const feedRes = await call('stu', 'GET', '/api/beidou/winners?limit=50');
    const feed = payloadOf(feedRes);
    const feedItems = feed.items || [];
    const names = feedItems.map((x) => x.nameMasked);
    assert(names.includes('陈**'), '播报里出现脱敏名「陈**」', names.slice(0, 5));
    assert(!names.some((n) => String(n).includes('宇')), '播报不含未脱敏姓名（陈宇航）', names.slice(0, 5));
    assert(feedItems.every((x) => typeof x.nameMasked === 'string' && x.nameMasked.length <= 4), '所有名字都是短脱敏串', names.slice(0, 5));
    assert(feedItems.every((x) => x.prizeLabel), '每条都有奖品名');
    assert(typeof feed.rarityText === 'string' && feed.rarityText.includes('最低概率奖'), '有概率区间文案', feed.rarityText);

    // 反向断言：响应 JSON 里不得出现完整姓名
    const rawJson = JSON.stringify(feedRes.data);
    assert(!rawJson.includes('陈宇航'), '整个响应体不含完整姓名 陈宇航');
    assert(!rawJson.includes('李晓明'), '整个响应体不含完整姓名 李晓明');

    // exitRanking 过滤：用唯一金额精确判定（先确认「开着隐私时不出现」，再关掉确认「出现了」）
    const hasBWithPrivacy = feedItems.some((x) => x.amount === PEER_B_AMOUNT);
    assert(!hasBWithPrivacy, 'exitRanking 的学生不进播报（按唯一金额精确判定）', { PEER_B_AMOUNT });
    await User.updateOne({ _id: peerB._id }, { $set: { 'privacy.exitRanking': false } });
    const feedOpen = await beidouSvc.winnersFeed({ limit: 50 });
    const hasBWithoutPrivacy = (feedOpen.items || []).some((x) => x.amount === PEER_B_AMOUNT);
    assert(hasBWithoutPrivacy, '关掉 exitRanking 后同一人就能进播报（证明过滤真的在生效）', { PEER_B_AMOUNT });
    await User.updateOne({ _id: peerB._id }, { $set: { 'privacy.exitRanking': true } });

    // ---- 13) 抽奖来源账本 + 管理端筛选 ----
    console.log('\n[13] 抽奖来源账本与筛选');
    // 造一个干净账号，只通过「看视频」赚次数 → 抽出来的每一笔来源都应是 video
    const srcUser = await User.create({
      openid: `${TAG}_src`, account: `${TAG}_src`, realName: '来源测试',
      role: 'student', status: 'active',
    });
    createdUsers.push(srcUser._id);
    openids.push(srcUser.openid);
    actors.set('src', srcUser);
    // 配置：只留步数奖与空奖，方便断言
    cfgDoc.beidou.prizes = [
      { key: 'steps_100', label: '100 步', type: 'steps', amount: 100, weight: 1 },
      { key: 'none', label: '谢谢参与', type: 'none', amount: 0, weight: 1 },
    ];
    cfgDoc.beidou.draw = { maxPerDay: 0, dailyStepsCap: 3000 };
    cfgDoc.beidou.share = { drawPerShare: 1, dailyLimit: 0, minIntervalSec: 0 }; // 关掉间隔便于连续分享
    await cfgDoc.save();

    // ① 只看视频 2 次 → 抽 2 次，两笔来源都应是 video
    await call('src', 'POST', '/api/beidou/video/report', { watchId: 'src_v1' });
    await call('src', 'POST', '/api/beidou/video/report', { watchId: 'src_v2' });
    const s1 = payloadOf(await call('src', 'POST', '/api/beidou/draw', { drawId: 'src_d1' }));
    const s2 = payloadOf(await call('src', 'POST', '/api/beidou/draw', { drawId: 'src_d2' }));
    assert(s1.success === true && s2.success === true, '视频来源的两次抽奖都成功');
    const srcFlows = await BeidouDraw.find({ openid: srcUser.openid, date: DATE }).sort({ createdAt: 1 }).lean();
    assert(srcFlows.every((f) => f.source === 'video'), '两笔流水的 source 都是 video（账本归属正确）', srcFlows.map((f) => f.source));

    // ② 再加签到 → 按优先级 checkin 应先于 video 被扣
    //    先把剩余视频次数抽完，再签到拿次数
    const daySrc1 = await BeidouDay.findOne({ openid: srcUser.openid, date: DATE }).lean();
    const leftV = daySrc1.draw.total - daySrc1.draw.used;
    for (let i = 0; i < leftV; i += 1) {
      await call('src', 'POST', '/api/beidou/draw', { drawId: `src_ex_${i}` });
    }
    await call('src', 'POST', '/api/beidou/checkin', {});
    const ckDraw = payloadOf(await call('src', 'POST', '/api/beidou/draw', { drawId: 'src_ck_draw' }));
    assert(ckDraw.success === true, '签到后再抽一次成功', ckDraw);
    const ckFlow = await BeidouDraw.findOne({ openid: srcUser.openid, drawId: 'src_ck_draw' }).lean();
    assert(ckFlow && ckFlow.source === 'checkin', '签到给的次数抽奖记为 checkin（优先级生效）', ckFlow && ckFlow.source);

    // ③ 分享来源（此时签到次数已用完，share 应被扣）
    await call('src', 'POST', '/api/beidou/share/report', { shareId: 'src_sh1' });
    const shDraw = payloadOf(await call('src', 'POST', '/api/beidou/draw', { drawId: 'src_sh_draw' }));
    assert(shDraw.success === true, '分享后再抽一次成功', shDraw);
    const shFlow = await BeidouDraw.findOne({ openid: srcUser.openid, drawId: 'src_sh_draw' }).lean();
    assert(shFlow && shFlow.source === 'share', '邀请给的次数抽奖记为 share', shFlow && shFlow.source);

    // ④ 账本自洽：各来源已用之和 == used
    const daySrc2 = await BeidouDay.findOne({ openid: srcUser.openid, date: DATE }).lean();
    const sumUsed = (daySrc2.draw.usedVideo || 0) + (daySrc2.draw.usedShare || 0)
      + (daySrc2.draw.usedCheckin || 0) + (daySrc2.draw.usedPrize || 0);
    assert(sumUsed === daySrc2.draw.used, '各来源已用之和 == draw.used（账本自洽）', {
      sumUsed, used: daySrc2.draw.used,
    });
    // ⑤ 各来源已用不超过各自获得
    assert(
      (daySrc2.draw.usedVideo || 0) <= (daySrc2.draw.fromVideo || 0)
        && (daySrc2.draw.usedShare || 0) <= (daySrc2.draw.fromShare || 0)
        && (daySrc2.draw.usedCheckin || 0) <= (daySrc2.draw.fromCheckin || 0),
      '各来源已用 ≤ 各自获得（不会扣成负数）',
      { usedVideo: daySrc2.draw.usedVideo, fromVideo: daySrc2.draw.fromVideo }
    );

    // ⑥ 管理端按来源筛选
    //
    // ⚠️ 管理端路由的 auth 是在 routes/admin/index.js 里 **解构**拿到的：
    //      `const { auth } = require('../../middlewares/auth'); router.use(auth)`
    //    所以「改模块上的 auth 属性」对它无效（它拿的是当时的函数引用）。
    //    正确做法是**先**把中间件的导出替换掉，再 require 路由（require 有缓存，
    //    但这里路由模块还没被加载过，所以换成新函数后再加载即可）。
    //    同时必须挂 /api/admin（不是直接挂 config），因为 auth 是挂在父路由上的。
    const adminAuthMw = require(path.join(serverDir, 'src', 'middlewares', 'auth'));
    const realAuth = adminAuthMw.auth;
    adminAuthMw.auth = (req, res, next) => {
      const who = req.headers['x-actor'] || '';
      const doc = actors.get(who);
      if (!doc) return res.status(401).json({ code: 401, message: 'unknown actor' });
      req.user = doc;
      next();
    };
    // 清掉 admin 路由的 require 缓存（若之前已加载过，解构到的还是旧函数）
    for (const k of Object.keys(require.cache)) {
      if (k.includes(path.join('routes', 'admin'))) delete require.cache[k];
    }
    const adminUser = await User.create({
      openid: `${TAG}_admin`,
      account: `${TAG}_admin`,
      realName: '管理探针',
      role: 'teacher',
      permissions: ['*'],
      status: 'active',
    });
    createdUsers.push(adminUser._id);
    openids.push(adminUser.openid);
    actors.set('admin', adminUser);

    const adminApp = express();
    adminApp.use(express.json());
    adminApp.use('/api/admin', require(path.join(serverDir, 'src', 'routes', 'admin')));
    adminApp.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code || 500, message: err.message }));
    const adminPort = await new Promise((r) => {
      const s = adminApp.listen(0, '127.0.0.1', () => r(s.address().port));
    });
    const adminCall = async (url) => {
      const res = await fetch(`http://127.0.0.1:${adminPort}${url}`, { headers: { 'x-actor': 'admin' } });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    // 用完恢复真实 auth，避免影响后续用例
    const restoreAuth = () => {
      adminAuthMw.auth = realAuth;
    };
    // 只筛 source=checkin，且限定今天
    const fRes = await adminCall(`/api/admin/config/beidou-draws?source=checkin&dateFrom=${DATE}&dateTo=${DATE}&limit=100`);
    const fData = payloadOf(fRes);
    assert(fRes.status === 200, '管理端筛选接口 200', { status: fRes.status, msg: fRes.data && fRes.data.message });
    assert(Array.isArray(fData.list), '返回 list', typeof fData.list);
    assert(fData.list.every((x) => x.source === 'checkin'), '筛 source=checkin 只回 checkin 记录', fData.list.map((x) => x.source));
    assert(fData.list.length >= 1, '确实筛到了签到来源的记录', fData.list.length);
    assert(fData.list.every((x) => x.sourceText === '签到'), '来源中文文案由服务端下发', fData.list[0] && fData.list[0].sourceText);
    // 分面计数：排除 source 本身后，各来源都应 > 0（因为该账号各来源都抽过）
    const facet = (fData.facets && fData.facets.source) || [];
    assert(facet.length === 5, '来源分面 5 项齐全（含 unknown）', facet.length);
    assert(facet.some((x) => x.key === 'video' && x.count > 0), '分面里 video 有计数（不受当前筛选影响）', facet);
    // 日期筛选：用一个不可能有数据的日期
    const emptyRes = await adminCall('/api/admin/config/beidou-draws?dateFrom=1990-01-01&dateTo=1990-01-02');
    const emptyData = payloadOf(emptyRes);
    assert(emptyData.total === 0, '日期范围筛到空 → total 0（不是忽略筛选回全量）', emptyData.total);
    // 日期倒序自动纠正
    const revRes = await adminCall(`/api/admin/config/beidou-draws?dateFrom=${DATE}&dateTo=1990-01-01`);
    const revData = payloadOf(revRes);
    assert(revData.filters.dateFrom === '1990-01-01', '日期倒序被自动纠正', revData.filters);

    // 来源口径整句：必须由服务端拼好，且顺序与代码里的 SOURCE_ORDER 一致。
    // 这句早先写死在 WXML 里，改了优先级顺序页面还在说老规矩（管理员会按反的说明理解数据）。
    const expectOrder = beidouSvc.SOURCE_ORDER.map((s) => beidouSvc.SOURCE_TEXT[s]).join(' → ');
    assert(
      typeof fData.sourceNote === 'string' && fData.sourceNote.includes(expectOrder),
      '来源口径整句按 SOURCE_ORDER 生成（改了顺序文案自动跟着变）',
      { note: fData.sourceNote, expectOrder }
    );
    const srcDesc = payloadOf(await adminCall('/api/admin/config/beidou-draws/sources'));
    assert(srcDesc.order && srcDesc.order.join(',') === beidouSvc.SOURCE_ORDER.join(','), '来源说明接口的 order 与 service 一致', srcDesc.order);
    assert(!!srcDesc.text && srcDesc.text.prize === beidouSvc.SOURCE_TEXT.prize, '来源短文案来自 service', srcDesc.text);

    // ---- 13b) 老形态数据对齐：gap 必须压到 video，不能压到 prize ----
    // 线上实测 73/80 的 beidou_day 是老形态（used>0 但 usedVideo/usedShare/usedCheckin/usedPrize 全为 0）。
    // alignLegacyUsage 早先用 `best = -1` 找「已用最多的来源」，全都为 0 时第一项（prize）会满足 0 > -1，
    // 于是把差额记到 prize 上 —— 注释说压到 video、代码压到 prize。
    // 后果：账本看起来自洽（∑used* == used），但 prize 凭空欠下一大笔，
    // 之后真正由「再来一次」产生的次数会被这笔欠款一直压着、错归到 video，来源统计从此说不清。
    console.log('\n[13b] 老形态来源账本对齐');
    const legacyUser = await User.create({
      openid: `${TAG}_legacy`, account: `${TAG}_legacy`, realName: '老数据同学', role: 'student', status: 'active',
    });
    createdUsers.push(legacyUser._id);
    openids.push(legacyUser.openid);
    actors.set('legacy', legacyUser);
    await BeidouDay.create({
      openid: legacyUser.openid,
      date: DATE,
      // 刻意不写 used* 字段 = 改造前的落库形态
      draw: { total: 3, used: 3, fromVideo: 3, fromCheckin: 0, fromShare: 0, fromPrize: 0, stepsAwarded: 0, capped: false },
    });
    // 老形态已用完（total==used），先补一次视频再抽，才会走到对齐
    await call('legacy', 'POST', '/api/beidou/video/report', { watchId: 'lg_v1' });
    const lgDraw = payloadOf(await call('legacy', 'POST', '/api/beidou/draw', { drawId: 'lg_d1' }));
    assert(lgDraw.success === true && !lgDraw.duplicated, '老形态账号补次数后能正常抽奖', lgDraw);
    const lgDay = await BeidouDay.findOne({ openid: legacyUser.openid, date: DATE }).lean();
    assert((lgDay.draw.usedPrize || 0) === 0, '差额没有被压到 prize（缺陷回归点）', {
      usedPrize: lgDay.draw.usedPrize, usedVideo: lgDay.draw.usedVideo,
    });
    assert(lgDay.draw.usedVideo >= 3, '差额压到 video（符合注释口径：老版本主要靠看视频）', lgDay.draw.usedVideo);
    const lgSum = (lgDay.draw.usedVideo || 0) + (lgDay.draw.usedShare || 0)
      + (lgDay.draw.usedCheckin || 0) + (lgDay.draw.usedPrize || 0);
    assert(lgSum === lgDay.draw.used, '对齐后账本自洽：∑used* == used', { sum: lgSum, used: lgDay.draw.used });
    // 对齐是幂等的：再抽一次不应把差额重复压一遍
    const beforeAlignAgain = (await BeidouDay.findOne({ openid: legacyUser.openid, date: DATE }).lean()).draw.usedVideo;
    await call('legacy', 'POST', '/api/beidou/video/report', { watchId: 'lg_v2' });
    await call('legacy', 'POST', '/api/beidou/draw', { drawId: 'lg_d2' });
    const afterAlignAgain = (await BeidouDay.findOne({ openid: legacyUser.openid, date: DATE }).lean()).draw.usedVideo;
    assert(afterAlignAgain === beforeAlignAgain + 1, '重复对齐不会把差额压两遍（只 +1 是本次真实消耗）', {
      before: beforeAlignAgain, after: afterAlignAgain,
    });

    // ---- 15) 旧接口降级 ----
    console.log('\n[15] 旧 /api/reward-video/report 降级');
    const oldBefore = await RunRecord.countDocuments({ openid: student.openid, source: 'beidou' });
    const oldRes = payloadOf(await call('stu', 'POST', '/api/reward-video/report', { watchId: 'old1' }));
    assert(oldRes.success === false && oldRes.deprecated === true, '旧接口只回 success:false + deprecated', oldRes);
    const oldAfter = await RunRecord.countDocuments({ openid: student.openid, source: 'beidou' });
    assert(oldBefore === oldAfter, '旧接口不再写 run_records', { before: oldBefore, after: oldAfter });
  } finally {
    // ---- 16) 清理 + 恢复配置 ----
    console.log('\n[16] 清理与配置恢复');
    try {
      await BeidouDay.deleteMany({ openid: { $in: openids } });
      await BeidouDraw.deleteMany({ openid: { $in: openids } });
      await RunRecord.deleteMany({ openid: { $in: openids } });
      await User.deleteMany({ _id: { $in: createdUsers } });
      // 恢复原配置（逐字段写回，避免把 schema 之外的字段带回去）
      const doc = await GoalConfig.getSingleton();
      doc.beidou = originalBeidou;
      doc.rewardVideo = originalRewardVideo;
      await doc.save();

      const left = {
        users: await User.countDocuments({ openid: { $in: openids } }),
        days: await BeidouDay.countDocuments({ openid: { $in: openids } }),
        draws: await BeidouDraw.countDocuments({ openid: { $in: openids } }),
        records: await RunRecord.countDocuments({ openid: { $in: openids } }),
      };
      assert(left.users === 0 && left.days === 0 && left.draws === 0 && left.records === 0, '临时数据残留为 0', left);
      const restored = await GoalConfig.getSingleton();
      assert(
        JSON.stringify(restored.beidou.prizes) === JSON.stringify(originalBeidou.prizes),
        '奖池配置已恢复原值'
      );
    } catch (e) {
      assert(false, '清理阶段抛错', e.message);
    }
    await mongoose.disconnect();
    console.log(failed ? `\n共 ${failed} 处失败` : '\n北斗运动 2.0 端到端验证全部通过');
    process.exit(failed ? 1 : 0);
  }
})().catch((e) => {
  console.error('验证脚本异常：', e);
  process.exit(1);
});
