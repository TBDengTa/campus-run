// 端到端验证：北斗运动 2.0（签到 + 转盘抽步数 + 看视频/分享得次数）
//
// 方案与口径：docs/beidou-lottery-plan.md。
// 本脚本真连库、真起 routes/beidou.js（auth 中间件按 header 打桩成指定 actor），
// 用**临时账号**跑完整链路，最后删干净并核对残留为 0 —— 不碰任何真实学生数据。
//
// 覆盖十节（每节都对应一个会静默出错的点）：
//   ① 纯函数：奖池归一 / 扇区 8 格 / index 与命中奖一致
//   ② 看视频 → 只加抽奖次数，**run_records 一行都不写**（2.0 的核心口径变更）
//   ③ 同一 watchId 重复上报只加一次（幂等）
//   ④ 抽奖 → 步数真的落到 run_records(source='beidou')；流水与步数对账
//   ⑤ 同一 drawId 重复抽奖 → 只消耗 1 次、只发一次步数，且返回同一个 index
//   ⑥ 次数用尽 → success:false（不抛 4xx，前端能展示可读提示）
//   ⑦ **封顶降级**：dailyStepsCap 打到上限后，步数奖变空奖且 capped=true（活动照常进行）
//   ⑧ 签到：断签从第 1 天重来；连签第 3 天发步数；重复签到被拒
//   ⑨ 分享：最小间隔内重复上报被去重（服务端防连点）
//   ⑩ 教师四处（看视频/抽奖/分享/签到）全部 success:false，且不产生任何 run_records
//   ⑪ 旧接口 /api/reward-video/report 只回 success:false，不发步数
//   ⑫ 清理核对：临时数据残留为 0，配置恢复原值
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
      assert(r.success === true, `第 ${i + 1} 次抽奖成功`, r);
      assert(typeof r.index === 'number' && r.index >= 0 && r.index < 8, `第 ${i + 1} 次 index 合法`, r.index);
      if (r.prize && r.prize.type === 'steps') stepsAwarded += r.prize.amount;
      drawCount += 1;
    }
    const beidouRec = await RunRecord.findOne({ openid: student.openid, date: DATE, source: 'beidou' }).lean();
    const flowRows = await BeidouDraw.find({ openid: student.openid, date: DATE }).lean();
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
    const dupFlow = await BeidouDraw.findOne({ drawId: 'd0' }).lean();
    assert(dupRes.index === dupFlow.index, '重复抽奖返回的 index 与首次一致（前端停位不错位）', {
      res: dupRes.index,
      flow: dupFlow.index,
    });

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

    // ---- 12) 旧接口降级 ----
    console.log('\n[11] 旧 /api/reward-video/report 降级');
    const oldBefore = await RunRecord.countDocuments({ openid: student.openid, source: 'beidou' });
    const oldRes = payloadOf(await call('stu', 'POST', '/api/reward-video/report', { watchId: 'old1' }));
    assert(oldRes.success === false && oldRes.deprecated === true, '旧接口只回 success:false + deprecated', oldRes);
    const oldAfter = await RunRecord.countDocuments({ openid: student.openid, source: 'beidou' });
    assert(oldBefore === oldAfter, '旧接口不再写 run_records', { before: oldBefore, after: oldAfter });
  } finally {
    // ---- 13) 清理 + 恢复配置 ----
    console.log('\n[12] 清理与配置恢复');
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
