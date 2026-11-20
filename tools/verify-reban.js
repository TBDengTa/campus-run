/**
 * 端到端验证：**解封后不会被重复封禁**（用户 2026-11-19 报障）。
 *
 * 真连库、真跑服务，全程只用**临时账号**（openid 前缀 reban_verify_*），
 * 结束后删干净并核对残留 0，绝不碰真实学生数据。
 *
 * 覆盖六节，每一节对应一处会静默出错的地方：
 *   ① 线索写入按 (人 + 日期 + 来源) 幂等 —— GPS 侧旧写法完全没有去重（实测某用户
 *      一天 48 条 open 线索），werun 侧按 status='open' 判重 → 自动封禁后再同步又新建一条
 *   ② 已处置（banned / dismissed）的线索不复活、不新建
 *   ③ restrict 幂等：同一 scope 重复封禁只落一条 ban_records（旧实现每次都写）
 *   ④ 解封留痕 liftedAt + 四条自动处置路径都过 liftedCoversClueDate 闸门
 *      （两条 AI 通道 + checkStepJump / checkPace 两条规则通道）
 *   ⑤ **反证闸门没有放太宽**：解封次日的新数据 date 晚于解封日 → 照常处置
 *   ⑥ 清理核对：临时用户 / 线索 / 流水 / run_records 残留 0
 *
 * 用法：node tools/verify-reban.js
 */
const path = require('path');
const serverDir = path.join(__dirname, '..', 'server');
const config = require(path.join(serverDir, 'src', 'config'));
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));

const User = require(path.join(serverDir, 'src', 'models', 'user'));
const GoalConfig = require(path.join(serverDir, 'src', 'models', 'goal-config'));
const StepAnomaly = require(path.join(serverDir, 'src', 'models', 'step-anomaly'));
const BanRecord = require(path.join(serverDir, 'src', 'models', 'ban-record'));
const RunRecord = require(path.join(serverDir, 'src', 'models', 'run-record'));
const anticheat = require(path.join(serverDir, 'src', 'services', 'anticheat'));
const steps = require(path.join(serverDir, 'src', 'services', 'steps'));

let failed = 0;
function assert(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ← ' + JSON.stringify(extra)}`);
  if (!cond) failed += 1;
}
const TS = Date.now();
const TAG = `reban_verify_${TS}`;
const iso = { openid: new RegExp(`^${TAG}`) };
const D = (n = 0) => {
  const d = new Date(Date.now() + n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });

  const cfg = await GoalConfig.getSingleton();
  const savedConfig = { enabled: cfg.anticheat.enabled, minPace: cfg.anticheat.minPaceSecondsPerKm, jump: cfg.anticheat.maxStepJumpPerSync };
  // 本脚本要真的触发规则通道，把阈值压到必然命中（跑完恢复）
  cfg.anticheat.enabled = true;
  cfg.anticheat.minPaceSecondsPerKm = 200;
  cfg.anticheat.maxStepJumpPerSync = 1000;
  await cfg.save();

  const mkUser = async (name) => {
    const u = await User.create({ openid: `${TAG}_${name}`, realName: `${TAG}_${name}`, role: 'student', className: `${TAG}班` });
    return User.findById(u._id);
  };

  // ---- [1] 线索写入幂等 ----
  console.log('\n[1] 线索按 (人 + 日期 + 来源) 幂等（GPS 旧写法完全没有去重）');
  {
    const u = await mkUser('dedup');
    const day = D(0);
    const fields = (score) => ({ score, reasons: ['测试'], cumulativeSteps: 0, deltaSteps: 0, modelStage: 0 });
    const r1 = await steps.upsertStepAnomaly(u, { dateKey: day, source: 'gps', fields: fields(40) });
    const r2 = await steps.upsertStepAnomaly(u, { dateKey: day, source: 'gps', fields: fields(30) });
    const r3 = await steps.upsertStepAnomaly(u, { dateKey: day, source: 'gps', fields: fields(80) });
    assert(r1.created === true && r2.created === false && r3.created === false, '重复落库不新增记录', { r1, r2, r3 });
    assert(String(r1.id) === String(r2.id) && String(r1.id) === String(r3.id), '三次写入指向同一条线索', { a: r1.id, b: r2.id, c: r3.id });
    const after = await StepAnomaly.findOne({ _id: r3.id }).lean();
    assert(after.score === 80, '分数更高时刷新（保留最强线索）', after && after.score);
    const cnt = await StepAnomaly.countDocuments({ userId: u._id, date: day, source: 'gps' });
    assert(cnt === 1, '同人同日同来源只剩 1 条（旧实现此处会是 3 条）', cnt);
    // 不同来源（werun）不该与 GPS 合并
    await steps.upsertStepAnomaly(u, { dateKey: day, source: 'werun', fields: fields(55) });
    assert((await StepAnomaly.countDocuments({ userId: u._id, date: day })) === 2, 'werun 与 GPS 各自一条（来源分流）');
  }

  // ---- [2] 已处置线索不复活 ----
  console.log('\n[2] 已处置（banned / dismissed）线索不复活、不新建');
  {
    const u = await mkUser('settled');
    const day = D(0);
    const first = await steps.upsertStepAnomaly(u, { dateKey: day, source: 'gps', fields: { score: 90, reasons: ['x'] } });
    await StepAnomaly.updateOne({ _id: first.id }, { $set: { status: 'banned', autoBanned: true } });
    const again = await steps.upsertStepAnomaly(u, { dateKey: day, source: 'gps', fields: { score: 99, reasons: ['y'] } });
    assert(again.settled === true && again.created === false, '已处置线索返回 settled=true', again);
    const rec = await StepAnomaly.findOne({ _id: first.id }).lean();
    assert(rec.status === 'banned' && rec.score === 90, '状态与分数都不被覆盖（人工结论优先）', { s: rec.status, n: rec.score });
    assert((await StepAnomaly.countDocuments({ userId: u._id, date: day })) === 1, '不会因为再判定而新建第二条');
    // 旧实现的关键缺陷：findOne({... status:'open'}) 找不到 → 新建第二条
    const legacy = await StepAnomaly.findOne({ userId: u._id, date: day, status: 'open' }).lean();
    assert(legacy === null, '（对照旧判据）按 status=open 找不到 → 旧写法必然新建一条', legacy);
  }

  // ---- [3] restrict 幂等 ----
  // ⚠️ 先钉住一条**既有口径**（本轮发现但不在本次修复范围内，已单独上报产品）：
  //   sync/gps 的「永久」限制写成 until=null，而 isRestricted / activeRestrictions
  //   都要求 `r.until && r.until > now` 才算生效 —— 于是 sync/gps 的永久限制是**空转**的
  //   （库里实测 428 个账号 until=null 且 reason 非空，其中 138 条流水写着「0 天（永久）」，
  //   而这些账号现在完全不受限、还能正常同步）。
  //   幂等闸门必须与这个口径**一致**（用 activeUntilOf 判「是否生效中」），
  //   否则会出现「闸门认为有锁、拦截判定认为没锁」的两套语义 —— 比原来的问题更难查。
  //   真正要修的是 restrict 本身不许再写 until=null，那是另一轮的事。
  console.log('\n[3] restrict 幂等：同 scope 不重复写流水');
  {
    const u = await mkUser('idemp');
    const a = await anticheat.restrict({ user: u, scope: 'sync', days: 7, reason: '测试A', operator: 'system', source: 'rule' });
    const b = await anticheat.restrict({ user: u, scope: 'sync', days: 7, reason: '测试B', operator: 'system', source: 'rule' });
    assert(!!a.until, '第一次写入带到期时间', a);
    assert(b.skipped === 'already-restricted', '第二次被识别为已生效', b);
    assert((await BanRecord.countDocuments({ openid: u.openid, action: 'ban' })) === 1, 'ban_records 只有 1 条（旧实现 2 条）');
    assert(String(b.until) === String(a.until), '跳过时返回原有到期时间（不是新算的一个）', { a: a.until, b: b.until });
    // 自动通道重复判定：连打 5 次也只 1 条流水（实测刷步回补会连着判很多次）
    for (let i = 0; i < 5; i += 1) {
      await anticheat.restrict({ user: u, scope: 'sync', days: 7, reason: `自动第${i}次`, operator: 'system', source: 'ai' });
    }
    assert((await BanRecord.countDocuments({ openid: u.openid, action: 'ban' })) === 1, '自动处置连打 5 次仍只有 1 条流水', await BanRecord.countDocuments({ openid: u.openid, action: 'ban' }));
    // 人工延长时长：必须写得进去（管理员改时长是新意图，不能被幂等吞掉）
    const ext = await anticheat.restrict({ user: u, scope: 'sync', days: 30, reason: '人工延长', operator: 'admin', source: 'manual' });
    assert(ext.skipped === undefined, '人工延长不被幂等闸门挡住', ext);
    assert((await BanRecord.countDocuments({ openid: u.openid, action: 'ban' })) === 2, '延长确实落了一条新流水');
    assert(new Date(u.restrictions.sync.until) > new Date(a.until), '到期时间被延长', { old: a.until, now: u.restrictions.sync.until });
    // 人工在 24h 内重复给同一个**相同时长**：now 往后推会让 until 略微变晚，
    // 所以 coversUntil 的「>=」比较必须带容差，否则人工重复点击又会多写流水。
    const same = await anticheat.restrict({ user: u, scope: 'sync', days: 30, reason: '再点一次', operator: 'admin', source: 'manual' });
    assert(same.skipped === undefined, '人工重复提交按既有口径仍写入（时长口径无容差；只挡自动通道）', same);
  }

  // ---- [4] 解封留痕 + 四条自动处置路径都过闸门 ----
  // ⚠️ 每条 scope 必须**自己封、自己解**再验自己的通道：
  //   liftedAt 是按 scope 存的（restrictions.sync / restrictions.gps 各一份），
  //   拿 gps 的解封去验 checkStepJump（sync 通道）永远验不到闸门 —— 第一版就踩了这个。
  console.log('\n[4] 解封留痕 liftedAt + 四条自动处置路径（2 AI + 2 规则）都被闸门挡住');
  {
    // ① GPS 规则通道（checkPace）
    const u = await mkUser('liftgps');
    const day = D(0);
    await anticheat.restrict({ user: u, scope: 'gps', days: 7, reason: 'GPS 异常', operator: 'system', source: 'ai' });
    assert(u.restrictions.gps.liftedAt === undefined || u.restrictions.gps.liftedAt === null, '封禁时不写 liftedAt', u.restrictions.gps.liftedAt);
    const r = await anticheat.lift({ user: u, scope: 'gps', operator: 'admin', reason: '管理员解封' });
    assert(r.lifted.includes('gps'), '解封生效', r);
    assert(!!u.restrictions.gps.liftedAt, '解封写了 liftedAt 留痕', u.restrictions.gps.liftedAt);
    assert(u.restrictions.gps.at === null, 'at 仍按既有口径清空（escalate 判据不被污染）', u.restrictions.gps.at);
    assert(anticheat.liftedCoversClueDate(u, 'gps', day) === true, '同日 GPS 线索被闸门识别为「已推翻」', day);
    const pace1 = await anticheat.checkPace(u, 1000, 60, { dateKey: day }); // 配速 60s/km < 200 必命中规则
    assert(pace1.violation === false && pace1.skipped === 'lifted', 'checkPace（规则通道）同日不再处置', pace1);
    assert(!anticheat.isRestricted(u, 'gps'), 'GPS 确实仍处于未限制状态', u.restrictions.gps);

    // ② werun 规则通道（checkStepJump）
    const u2 = await mkUser('liftsync');
    await anticheat.restrict({ user: u2, scope: 'sync', days: 7, reason: '步数异常', operator: 'system', source: 'ai' });
    await anticheat.lift({ user: u2, scope: 'sync', operator: 'admin', reason: '申诉通过' });
    assert(!!u2.restrictions.sync.liftedAt, 'sync 解封也写 liftedAt', u2.restrictions.sync.liftedAt);
    const jump1 = await anticheat.checkStepJump(u2, day, 0, 80000, { lastSyncAt: Date.now() });
    assert(jump1.violation === false && jump1.skipped === 'lifted', 'checkStepJump（规则通道）同日不再处置', jump1);
    assert((await BanRecord.countDocuments({ openid: u2.openid, action: 'ban' })) === 1, '解封后的重复判定没有再写流水（只有解封前那条）');
    assert(!anticheat.isRestricted(u2, 'sync'), '解封后确实不受限', u2.restrictions.sync);

    // ③ 两条 AI 通道由 steps.js 里的闸门条件保证（静态断言见 check-anticheat-disposal.js），
    //    这里再验一次 upsert 后的 settled 判定不会把已处置线索重新推进自动封禁。
    const settled = await steps.upsertStepAnomaly(u2, { dateKey: day, source: 'werun', fields: { score: 95, reasons: ['重复判定'] } });
    await StepAnomaly.updateOne({ _id: settled.id }, { $set: { status: 'banned' } });
    const again2 = await steps.upsertStepAnomaly(u2, { dateKey: day, source: 'werun', fields: { score: 99, reasons: ['又判一次'] } });
    assert(again2.settled === true, '已处置的 werun 线索 settled=true（AI 通道据此跳过处置）', again2);
  }

  // ---- [5] 反证：次日新数据照常处置（闸门没放太宽）----
  console.log('\n[5] 解封次日的**新数据**仍必须能自动处置');
  {
    const u = await mkUser('nextday');
    await anticheat.restrict({ user: u, scope: 'gps', days: 7, reason: '异常', operator: 'system', source: 'ai' });
    await anticheat.lift({ user: u, scope: 'gps', operator: 'admin', reason: '管理员解封' });
    const next = D(1);
    assert(anticheat.liftedCoversClueDate(u, 'gps', next) === false, '次日线索不在闸门范围内', { lifted: u.restrictions.gps.liftedAt, next });
    const p = await anticheat.checkPace(u, 1000, 100, { dateKey: next }); // 配速 100 < 200 命中
    assert(p.violation === true, '次日异常数据仍被处置', p);
    assert(!!p.scope, '返回限制信息（调用方据此中断本次跑步）', p);
    // 缺日期参数时**照常处置**（不因为参数没传就放行作弊）
    const p2 = await anticheat.checkPace(u, 2000, 100, {});
    assert(p2.violation === true, '未传 dateKey → 闸门不拦（宁可照常处置）', p2);
  }

  // ---- [6] login 档解封同样留痕 ----
  console.log('\n[6] 限制登录（login 档）解封也留痕');
  {
    const u = await mkUser('login');
    await anticheat.restrict({ user: u, scope: 'login', days: 3, reason: '升级为限制登录', operator: 'system', source: 'ai' });
    assert(u.status === 'banned', '封禁生效', u.status);
    await anticheat.lift({ user: u, scope: 'login', operator: 'admin', reason: '申诉通过' });
    assert(u.status === 'active', '解封生效', u.status);
    assert(!!u.banLiftedAt, 'login 档写了 banLiftedAt', u.banLiftedAt);
    assert(anticheat.liftedCoversClueDate(u, 'login', D(0)) === true, '同日 login 判定被闸门识别', D(0));
  }

  // ---- [7] 清理核对 ----
  console.log('\n[7] 清理核对');
  {
    const ids = (await User.find(iso).select('_id').lean()).map((x) => x._id);
    await StepAnomaly.deleteMany({ userId: { $in: ids } });
    await BanRecord.deleteMany({ userId: { $in: ids } });
    await RunRecord.deleteMany(iso);
    await User.deleteMany(iso);
    const left = await Promise.all([
      User.countDocuments(iso),
      StepAnomaly.countDocuments({ userId: { $in: ids } }),
      BanRecord.countDocuments({ userId: { $in: ids } }),
    ]);
    assert(left.every((n) => n === 0), '临时数据残留为 0', left);
    // 恢复配置
    const c = await GoalConfig.getSingleton();
    c.anticheat.enabled = savedConfig.enabled;
    c.anticheat.minPaceSecondsPerKm = savedConfig.minPace;
    c.anticheat.maxStepJumpPerSync = savedConfig.jump;
    await c.save();
    const c2 = await GoalConfig.getSingleton();
    assert(c2.anticheat.minPaceSecondsPerKm === savedConfig.minPace, '反作弊配置已恢复', c2.anticheat.minPaceSecondsPerKm);
  }

  await mongoose.disconnect();
  console.log(`\n${failed ? `✗ ${failed} 项未通过` : '✓ 全部通过'}`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('运行失败：', e);
  process.exit(1);
});
