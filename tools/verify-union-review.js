// 端到端验证：学生会复审台（分数分类 + 批量审核）
//
// 用户 2026-11-02 需求二：
//   「在学生会检查中的复审中，支持分数分类，并对每块显示检查人、检查信息(简化)、检查图片，
//    并增加批量审核功能。」
//
// 这个脚本真连库、真挂 routes/union.js（auth 中间件按 header 打桩成指定 actor），
// 用**临时记录**跑完整链路，最后删干净并核对残留为 0 —— 不碰任何真实检查记录。
//
// 覆盖的十条（每一条都对应一个会静默出错的点）：
//   ① 队列按扣分分档，四档计数之和 = 待复核总数
//   ② 点某档只返回该档的记录（服务端 bandCond 与 bandOf 同源）
//   ③ 每条带检查人 / 简化信息 / 检查图片 / canReview
//   ④ 自审禁令：部长自己的记录在队列里 canReview=false，批量也过不去
//   ⑤ 批量通过：可复核的通过、不可复核的**逐条失败并给原因**（不整批回滚）
//   ⑥ 批量同样写 history / reviewedByName / reviewedAt（与单条逐字一致）
//   ⑦ 批量退回必须填原因（<2 字直接 400）
//   ⑧ 无复核资格（普通部员）→ 403
//   ⑨ 非成员（班主任 / 教师）→ 403
//   ⑩ 已复核的记录不在队列里（不会重复审）
//
// 用法：node tools/verify-union-review.js
const path = require('path');
const serverDir = path.join(__dirname, '..', 'server');
const config = require(path.join(serverDir, 'src', 'config'));
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));
const express = require(path.join(serverDir, 'node_modules', 'express'));

const CheckRecord = require(path.join(serverDir, 'src', 'models', 'check-record'));
const User = require(path.join(serverDir, 'src', 'models', 'user'));
const UnionMember = require(path.join(serverDir, 'src', 'models', 'union-member'));
const checkModules = require(path.join(serverDir, 'src', 'services', 'check-modules'));
const reviewSvc = require(path.join(serverDir, 'src', 'services', 'union-review'));
const unionSvc = require(path.join(serverDir, 'src', 'services', 'union'));

let failed = 0;
function assert(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ← ' + JSON.stringify(extra)}`);
  if (!cond) failed += 1;
}

const TS = Date.now();
const TAG = `rv_verify_${TS}`;

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });

  // ---- 0) 起真实路由（auth 打桩：按 x-actor 指定调用者）----
  const authMw = require(path.join(serverDir, 'src', 'middlewares', 'auth'));
  const actors = new Map();
  authMw.auth = (req, res, next) => {
    const who = req.headers['x-actor'] || '';
    if (who === 'anon') return res.status(401).json({ code: 401, message: '未登录' });
    const doc = actors.get(who);
    if (!doc) return res.status(401).json({ code: 401, message: 'unknown actor' });
    req.user = doc;
    next();
  };
  const unionRouter = require(path.join(serverDir, 'src', 'routes', 'union'));
  const app = express();
  app.use(express.json());
  app.use('/api/union', unionRouter);
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

  const createdUsers = [];
  const createdRecords = [];
  const createdMembers = [];

  try {
    // ---- 1) 造四个临时身份 ----
    // 主席团（校级，可自审）
    const presidium = await User.create({
      openid: `${TAG}_pres`,
      account: `${TAG}_pres`,
      realName: '复审-主席团',
      role: 'student',
      className: `${TAG}_C`,
    });
    createdUsers.push(presidium._id);
    // 生活部部长（可复核本部门，不可自审）
    const minister = await User.create({
      openid: `${TAG}_min`,
      account: `${TAG}_min`,
      realName: '复审-部长',
      role: 'student',
      className: `${TAG}_C`,
    });
    createdUsers.push(minister._id);
    // 普通部员（无复核权）
    const member = await User.create({
      openid: `${TAG}_mem`,
      account: `${TAG}_mem`,
      realName: '复审-部员',
      role: 'student',
      className: `${TAG}_C`,
    });
    createdUsers.push(member._id);
    // 非成员（班主任/教师）
    const teacher = await User.create({
      openid: `${TAG}_tea`,
      account: `${TAG}_tea`,
      realName: '复审-教师',
      role: 'teacher',
    });
    createdUsers.push(teacher._id);

    const mk = async (user, role, deptKey, level = 'school') => {
      const doc = await UnionMember.create({
        userId: user._id,
        openid: user.openid,
        realName: user.realName,
        className: user.className || '',
        level,
        deptKey,
        deptName: deptKey === 'presidium' ? '主席团' : '生活部',
        role,
        status: 'active',
      });
      createdMembers.push(doc._id);
      return doc;
    };
    await mk(presidium, 'president', 'presidium');
    await mk(minister, 'minister', 'life');
    await mk(member, 'member', 'life');
    unionSvc.clearIdentityCache();
    actors.set('pres', presidium);
    actors.set('min', minister);
    actors.set('mem', member);
    actors.set('tea', teacher);
    actors.set('anon', null);

    // ---- 2) 造四条待复核记录（四档扣分各一条）----
    // 扣分档位必须由真实分数派生，所以直接指定 deduct（这就是落库字段本身）
    // ⚠️ 10 分制（用户 2026-11-12）：deduct 与 score 都在 10 分刻度上（score = 满分 − 扣分），
    //   档位边界 0 / 0.5 / 1。造百分制数值会让分档断言测的是"旧刻度下的巧合"。
    // ⚠️ 每条必须**独立 targetId**：uniq_slot_active_v2 唯一键是
    //   (moduleKey, targetType, targetId, date, period, className)，
    //   同一教室同一天只能有一条生效记录 —— 复用 targetId 会直接 E11000（第一次就踩到了）。
    const date = require(path.join(serverDir, 'src', 'utils', 'dates')).todayKey();
    const FULL = require(path.join(serverDir, 'src', 'services', 'check-modules')).FULL_SCORE;
    const mkRec = async ({ deduct, inspector, inspectorName, deptKey, slot, extra = {} }) => {
      const doc = await CheckRecord.create({
        moduleKey: 'hygiene',
        date,
        period: '',
        targetType: 'classroom',
        targetId: `${TAG}_room_${slot}`,
        targetName: `${TAG}_教室${slot}`,
        className: `${TAG}_C`,
        departmentId: null,
        inspectorOpenid: inspector,
        inspectorName,
        inspectorDeptKey: deptKey,
        details: { grade: ['良'], score: FULL - deduct, photos: [] },
        metrics: { ratios: {}, values: { score: FULL - deduct } },
        score: FULL - deduct,
        deduct,
        scoreScale: FULL,
        photos: [],
        remark: '端到端验证用临时记录',
        status: 'submitted',
        source: 'union',
        ...extra,
      });
      createdRecords.push(doc._id);
      return doc;
    };

    const recFull = await mkRec({ deduct: 0, inspector: minister.openid, inspectorName: '复审-部长', deptKey: 'life', slot: 'a' });
    const recLow = await mkRec({ deduct: 0.4, inspector: presidium.openid, inspectorName: '复审-主席团', deptKey: 'presidium', slot: 'b' });
    const recMid = await mkRec({ deduct: 0.8, inspector: presidium.openid, inspectorName: '复审-主席团', deptKey: 'presidium', slot: 'c' });
    const recHigh = await mkRec({ deduct: 2, inspector: presidium.openid, inspectorName: '复审-主席团', deptKey: 'presidium', slot: 'd' });

    // ---- 3) 队列：分档与计数 ----
    console.log('\n[1] 队列分档');
    const q = await call('pres', 'GET', `/api/union/review/queue?limit=50`);
    assert(q.status === 200, '主席团进队列 → 200', q.status);
    const bands = (q.data.data && q.data.data.bands) || [];
    assert(bands.length === 4, '下发四个分档', bands.map((b) => b.key));
    // 计数只统计这四条（临时记录共用同一天，可能混入真实记录，所以只看增量口径：
    // 校验「每档计数 ≥ 该档临时记录数」+「四档之和 = total」）
    const sum = bands.reduce((a, b) => a + (b.count || 0), 0);
    assert(sum === q.data.data.total, '四档计数之和 = total（分类不丢记录）', { sum, total: q.data.data.total });
    const seen = (q.data.data.list || []).filter((r) => String(r.targetId || r.targetName).includes(TAG));
    assert(seen.length === 4, '四条临时记录都在队列里', seen.length);
    for (const [doc, want] of [
      [recFull, 'full'],
      [recLow, 'low'],
      [recMid, 'mid'],
      [recHigh, 'high'],
    ]) {
      const row = (q.data.data.list || []).find((r) => r.id === String(doc._id));
      assert(!!row && row.bandKey === want, `#${doc.deduct} 分 → ${want}`, row && row.bandKey);
    }
    // 每条都要有检查人 / 简化信息 / 图片字段（图片为空时是空数组，不是 undefined）
    const r0 = (q.data.data.list || []).find((r) => r.id === String(recMid._id));
    assert(!!r0 && r0.inspectorName === '复审-主席团', '队列带检查人', r0 && r0.inspectorName);
    assert(!!r0 && typeof r0.summary === 'string' && r0.summary.includes('评价'), '队列带简化检查信息', r0 && r0.summary);
    assert(!!r0 && Array.isArray(r0.photos), '队列带图片数组', r0 && typeof r0.photos);
    assert(!!r0 && r0.canReview === true, '主席团可复核别人提交的记录', r0 && r0.canReview);

    // 分档筛选：只返回该档
    const qLow = await call('pres', 'GET', `/api/union/review/queue?band=low&limit=50`);
    const lows = (qLow.data.data.list || []).filter((r) => String(r.targetId || r.targetName).includes(TAG));
    assert(lows.length === 1 && lows[0].id === String(recLow._id), 'band=low 只返回轻微扣分那条', lows.map((r) => r.deduct));

    // ---- 4) 自审禁令：部长自己提交的那条 ----
    console.log('\n[2] 自审禁令');
    const qMin = await call('min', 'GET', `/api/union/review/queue?limit=50`);
    assert(qMin.status === 200, '部长进队列 → 200', qMin.status);
    const minFull = (qMin.data.data.list || []).find((r) => r.id === String(recFull._id));
    assert(!!minFull, '部长看得到本部门记录（列表可见）', minFull && minFull.id);
    assert(!!minFull && minFull.canReview === false, '部长自己提交的记录 canReview=false', minFull && minFull.canReview);
    assert(
      !!minFull && /不能复核自己提交的记录/.test(minFull.reviewBlockReason || ''),
      '不可复核原因写明「不能复核自己提交的记录」',
      minFull && minFull.reviewBlockReason
    );

    // ---- 5) 批量审核：可复核的通过、不可复核的逐条失败 ----
    console.log('\n[3] 批量审核');
    // 部长批量通过 4 条：他自己那条必须失败，另外 3 条（主席团录入）应当成功
    const ids = [recFull, recLow, recMid, recHigh].map((d) => String(d._id));
    const batch = await call('min', 'POST', '/api/union/review/batch', { ids, approve: true });
    assert(batch.status === 200, '部长批量通过 → 200', batch.status);
    const results = (batch.data.data && batch.data.data.results) || [];
    assert(results.length === 4, '逐条回传 4 条结果', results.length);
    const okIds = results.filter((r) => r.ok).map((r) => r.id);
    const badIds = results.filter((r) => !r.ok);
    assert(!okIds.includes(String(recFull._id)), '自审那条**没有**被通过（批量没绕过禁令）', okIds);
    assert(badIds.length === 1 && badIds[0].id === String(recFull._id), '只有自审那条失败', badIds);
    assert(/不能复核自己提交的记录/.test(badIds[0].message || ''), '失败原因逐条回显', badIds[0].message);
    assert(batch.data.data.success === 3 && batch.data.data.failed === 1, '成功 3 / 失败 1（不整批回滚）', batch.data.data);

    // 落库校验：通过的确实 approved，未通过的仍是 submitted
    const afterBatch = await CheckRecord.find({ _id: { $in: [recFull._id, recLow._id] } }).lean();
    const byId = new Map(afterBatch.map((r) => [String(r._id), r]));
    assert(byId.get(String(recLow._id)).status === 'approved', '被通过的那条 → approved', byId.get(String(recLow._id)).status);
    assert(byId.get(String(recFull._id)).status === 'submitted', '没通过的那条仍是 submitted', byId.get(String(recFull._id)).status);

    // ---- 6) 留痕与单条逐字一致 ----
    console.log('\n[4] 批量也写留痕');
    const approved = byId.get(String(recLow._id));
    assert(approved.reviewedBy === minister.openid, '批量写了 reviewedBy', approved.reviewedBy);
    assert(approved.reviewedByName === '复审-部长', '批量写了 reviewedByName', approved.reviewedByName);
    assert(!!approved.reviewedAt, '批量写了 reviewedAt', approved.reviewedAt);
    assert((approved.revision || 1) === 2, '批量把 revision +1', approved.revision);
    assert(Array.isArray(approved.history) && approved.history.length === 1, '批量写了 history（与单条一致）', approved.history && approved.history.length);
    assert(
      approved.history[0].changes.status.from === 'submitted' && approved.history[0].changes.status.to === 'approved',
      'history 记录 from→to 状态',
      approved.history[0].changes
    );

    // ---- 7) 批量退回：必须填原因 ----
    console.log('\n[5] 批量退回');
    const noReason = await call('pres', 'POST', '/api/union/review/batch', { ids: [String(recFull._id)], approve: false });
    assert(noReason.status === 400, '退回不填原因 → 400', noReason.status);
    const rejectOk = await call('pres', 'POST', '/api/union/review/batch', {
      ids: [String(recFull._id)],
      approve: false,
      reason: '照片与记录不符',
    });
    assert(rejectOk.status === 200, '主席团退回（主席团可自审）→ 200', rejectOk.status);
    const rejected = await CheckRecord.findById(recFull._id).lean();
    assert(rejected.status === 'rejected' && rejected.rejectReason === '照片与记录不符', '退回落库带原因', {
      s: rejected.status,
      r: rejected.rejectReason,
    });

    // ---- 8) 权限闸门 ----
    console.log('\n[6] 权限闸门');
    const byMember = await call('mem', 'GET', '/api/union/review/queue');
    assert(byMember.status === 403, '普通部员进队列 → 403', byMember.status);
    const batchByMember = await call('mem', 'POST', '/api/union/review/batch', { ids, approve: true });
    assert(batchByMember.status === 403, '普通部员批量 → 403', batchByMember.status);
    const byTeacher = await call('tea', 'GET', '/api/union/review/queue');
    assert(byTeacher.status === 403, '非成员（教师）进队列 → 403', byTeacher.status);
    const byAnon = await call('anon', 'GET', '/api/union/review/queue');
    assert(byAnon.status === 401, '未登录 → 401', byAnon.status);

    // ---- 9) 已复核的不再进队列 ----
    console.log('\n[7] 队列只含待复核');
    const qAfter = await call('pres', 'GET', `/api/union/review/queue?limit=50`);
    const stillThere = (qAfter.data.data.list || []).filter(
      (r) => r.id === String(recLow._id) || r.id === String(recFull._id)
    );
    assert(stillThere.length === 0, '已通过 / 已退回的记录不在队列里', stillThere.map((r) => r.status));

    // ---- 10) 服务层口径（不经 HTTP，直接单测分档与判定）----
    console.log('\n[8] 服务层口径');
    // 10 分制（用户 2026-11-12）：边界 0 / 0.5 / 1，闭区间逐档递减。
    // 用「迟到 1 人 = 0.05 分」这种真实粒度一起验：分档最小的可观测值必须落进「轻微」，
    // 不能因为太小而掉回「满分」（那会让「迟到了但界面显示满分」成为常态）。
    assert(
      reviewSvc.bandOf(0).key === 'full' &&
        reviewSvc.bandOf(0.05).key === 'low' &&
        reviewSvc.bandOf(0.5).key === 'low' &&
        reviewSvc.bandOf(0.5 + 1e-9).key === 'mid' &&
        reviewSvc.bandOf(1).key === 'mid' &&
        reviewSvc.bandOf(1.01).key === 'high',
      '分档闭区间正确（10 分制 0 / 0.5 / 1）',
      [0, 0.05, 0.5, 1, 1.01].map((d) => reviewSvc.bandOf(d).key)
    );
    // 档位条件与分档必须同源：用 bandCond 反查能命中同一批（这是「徽标数字与点进去条数一致」的根）
    const lowCond = reviewSvc.bandCond('low');
    assert(lowCond.deduct.$gt === 0 && lowCond.deduct.$lte === 0.5, 'bandCond(low) 是 (0, 0.5]', lowCond);
    const identityOfPres = await unionSvc.resolveIdentity(presidium);
    const identityOfMin = await unionSvc.resolveIdentity(minister);
    const modDef = await checkModules.getModule('hygiene');
    const selfCheck = reviewSvc.reviewableOf(
      { status: 'submitted', voided: false, inspectorOpenid: presidium.openid, inspectorDeptKey: 'presidium', departmentId: null },
      { identity: identityOfPres, openid: presidium.openid, moduleDef: modDef }
    );
    assert(selfCheck.ok === true, '主席团可自审（同一口径）', selfCheck);
    const minSelf = reviewSvc.reviewableOf(
      { status: 'submitted', voided: false, inspectorOpenid: minister.openid, inspectorDeptKey: 'life', departmentId: null },
      { identity: identityOfMin, openid: minister.openid, moduleDef: modDef }
    );
    assert(minSelf.ok === false && /不能复核自己提交的记录/.test(minSelf.reason), '部长不可自审（同一口径）', minSelf);
    // 结果对象里也带节目
    assert(typeof q.data.data.list[0].summary === 'string' || q.data.data.list.length === 0, 'summary 是字符串');
  } finally {
    // ---- 清理：临时数据一条不留（按 tag 兜底删，不依赖 try 内的变量）----
    await CheckRecord.deleteMany({ $or: [{ targetId: new RegExp(`^${TAG}`) }, { className: `${TAG}_C` }] });
    await UnionMember.deleteMany({ openid: new RegExp(`^${TAG}`) });
    await User.deleteMany({ openid: new RegExp(`^${TAG}`) });
    if (createdRecords.length) await CheckRecord.deleteMany({ _id: { $in: createdRecords } });
    if (createdMembers.length) await UnionMember.deleteMany({ _id: { $in: createdMembers } });
    if (createdUsers.length) await User.deleteMany({ _id: { $in: createdUsers } });
    unionSvc.clearIdentityCache();

    const left = {
      users: await User.countDocuments({ openid: new RegExp(`^${TAG}`) }),
      members: await UnionMember.countDocuments({ openid: new RegExp(`^${TAG}`) }),
      records: await CheckRecord.countDocuments({ className: `${TAG}_C` }),
    };
    console.log(`\n清理：残留用户 ${left.users} / 成员 ${left.members} / 记录 ${left.records}`);
    if (left.users || left.members || left.records) failed += 1;
    await mongoose.disconnect();
  }

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.stack);
  process.exit(1);
});
