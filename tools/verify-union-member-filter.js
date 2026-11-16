/**
 * 端到端验证（真连库，只读）：用户 2026-11-16 两个报障的回归闸门
 *
 * 报障一：「1号楼(女生宿舍)414 宿舍成员都是 26 级化工的，但是显示的却是 25 级软件」
 *   根因：查宿对象列表与写入归属都读 `dorm_rooms.className / departmentId` ——
 *   那是**建房间那一刻的默认班级快照**，整届换宿后没有任何代码刷新它。
 *   本脚本验证的是修完之后的性质：
 *     · 每间有在住的房间，列表下发的 className 必须等于「在住学生里人数最多的那个班」；
 *     · 归属系部 / 院校必须是**该班台账的归属**，不是房间快照；
 *     · 房间快照故意与在住名单冲突时，以在住名单为准（用临时房间构造，跑完删）；
 *     · 按在住班的系部筛，能筛到；按房间旧快照的系部筛，筛不到（越权/漏展两向都堵）。
 *
 * 报障二：「在学生会成员中无法筛选院校、部门、学年、无法搜索成员均有问题」
 *   根因：`GET /api/union/manage/members` 不读任何筛选参数、不分页、不下发 schools。
 *   本脚本真起路由（auth 打桩成真实主席团成员），逐项验证：
 *     · 院校（校学生会 / 某校区）筛选后结果与库内计数一致，且每条都满足条件；
 *     · 部门筛选、学年筛选、关键词搜索各自生效（结果数 < 全量且逐条满足）；
 *     · 分页真的分页（page=1/2 不重叠，limit 生效）；
 *     · 下发 schools / terms / departments 选项（前端下拉才有东西可选）；
 *     · 范围仍然 fail-closed：分院主席团看不到外校区成员（筛选没能绕过范围）。
 *
 * 用法：node tools/verify-union-member-filter.js
 */
const path = require('path');
const serverDir = path.join(__dirname, '..', 'server');
const config = require(path.join(serverDir, 'src', 'config'));
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));
const express = require(path.join(serverDir, 'node_modules', 'express'));

const User = require(path.join(serverDir, 'src', 'models', 'user'));
const UnionMember = require(path.join(serverDir, 'src', 'models', 'union-member'));
const UnionDepartment = require(path.join(serverDir, 'src', 'models', 'union-department'));
const DormRoom = require(path.join(serverDir, 'src', 'models', 'dorm-room'));
const DormAssignment = require(path.join(serverDir, 'src', 'models', 'dorm-assignment'));
const ClassProfile = require(path.join(serverDir, 'src', 'models', 'class-profile'));
const bandChao = require(path.join(serverDir, 'src', 'services', 'band-chao'));
const checkModules = require(path.join(serverDir, 'src', 'services', 'check-modules'));
const unionSvc = require(path.join(serverDir, 'src', 'services', 'union'));

let failed = 0;
function assert(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ← ' + JSON.stringify(extra === undefined ? '' : extra)}`);
  if (!cond) failed += 1;
}
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });

  // ============================================================
  // 报障一：查宿对象的归属班级 / 系部
  // ============================================================
  console.log('\n[1] 查宿对象：归属班级按在住名单推导（不是房间默认班级快照）');
  const mod = await checkModules.getModule('night_dorm');
  assert(!!mod, 'night_dorm 模块存在（该模块 targetTypes 含 dorm_room）');
  const dormModule = mod || { key: 'night_dorm', targetTypes: ['dorm_room'] };
  assert(
    (dormModule.targetTypes || []).includes('dorm_room'),
    'night_dorm 的受检对象含 dorm_room',
    dormModule.targetTypes
  );

  // 1a) 用真实数据核对：每间有在住的房间，列表里的 className = 在住学生里人数最多的班
  const targets = await bandChao.entryTargets({ moduleDef: dormModule, date: '2026-11-16', period: '', limit: 5000 });
  const rooms = await DormRoom.find({ enabled: { $ne: false } }).select('buildingName roomNo className').lean();
  const roomIdByLabel = new Map(rooms.map((r) => [`${r.buildingName || ''} ${r.roomNo}`.trim(), r]));
  const withLive = await DormAssignment.aggregate([
    { $match: { status: { $in: ['checked_in', 'guest'] } } },
    { $group: { _id: { roomId: '$roomId', className: '$className' }, n: { $sum: 1 } } },
  ]);
  const liveByRoom = new Map();
  for (const a of withLive) {
    const k = String(a._id.roomId);
    if (!liveByRoom.has(k)) liveByRoom.set(k, []);
    liveByRoom.get(k).push({ className: str(a._id.className), n: a.n });
  }
  const dormTargets = (targets.targets || []).filter((t) => t.targetType === 'dorm_room');
  const mismatches = [];
  let checked = 0;
  for (const t of dormTargets) {
    const room = roomIdByLabel.get(str(t.targetName));
    if (!room) continue;
    const live = liveByRoom.get(String(room._id));
    if (!live || !live.length) continue;
    checked += 1;
    const expected = live.slice().sort((a, b) => b.n - a.n || a.className.localeCompare(b.className))[0].className;
    if (str(t.className) !== expected) mismatches.push({ room: t.targetName, got: t.className, expected });
  }
  assert(checked > 0, `有在住名单的房间参与核对（${checked} 间）`, checked);
  assert(
    mismatches.length === 0,
    `每个查宿对象的归属班级 = 在住人数最多的班（${checked} 间）`,
    mismatches.slice(0, 5)
  );
  // 反例形态：必须**确实存在**「房间默认班级 ≠ 在住班级」的样本，否则这条验证是空转
  const snapshotConflicts = [];
  for (const [roomId, live] of liveByRoom) {
    const room = rooms.find((r) => String(r._id) === roomId);
    if (!room) continue;
    if (!live.some((x) => x.className === str(room.className))) snapshotConflicts.push({ room: `${room.buildingName}·${room.roomNo}`, snapshot: room.className, live });
  }
  console.log(`  （数据面：${snapshotConflicts.length} 间房的默认班级与在住班不一致 —— 旧实现正是在这些房间显示错的）`);

  // 1b) 用**临时房间**构造冲突：房间快照写 A 班，在住名单是 B 班（临时的，跑完删干净）
  console.log('\n[2] 构造冲突：房间默认班级 ≠ 在住班级（临时数据，跑完清理）');
  const SCHOOLS = await mongoose.connection.db.collection('organizations').find({ type: 'school' }).toArray();
  const s1 = SCHOOLS[0];
  const s2 = SCHOOLS[1];
  const classA = await ClassProfile.findOne({ schoolId: s1 ? s1._id : undefined, departmentId: { $ne: null } }).lean();
  const classB = await ClassProfile.findOne({
    schoolId: s1 ? s1._id : undefined,
    departmentId: { $ne: null },
    className: { $ne: classA && classA.className },
  }).lean();
  const tmpUserId = new mongoose.Types.ObjectId();
  let tmpRoom = null;
  try {
    if (classA && classB) {
      tmpRoom = await DormRoom.create({
        buildingId: '__verify_tmp_building__',
        buildingName: '__verify_tmp_building__',
        roomNo: `T${Date.now() % 100000}`,
        className: classA.className, // 故意写错（快照）
        departmentId: classA.departmentId,
        departmentName: classA.departmentName,
      });
      const tmpOpenid = `__verify_tmp_${Date.now()}__`;
      await DormAssignment.create({
        userId: tmpUserId,
        openid: tmpOpenid,
        realName: '验证-临时',
        studentId: '',
        className: classB.className, // 真实在住 = B 班
        roomId: tmpRoom._id,
        buildingId: tmpRoom.buildingId,
        buildingName: tmpRoom.buildingName,
        roomNo: tmpRoom.roomNo,
        status: 'checked_in',
      });
      const t2 = await bandChao.entryTargets({ moduleDef: dormModule, date: '2026-11-16', period: '', limit: 5000 });
      const hit = (t2.targets || []).find((x) => x.targetId === String(tmpRoom._id));
      assert(!!hit, '临时房间出现在查宿列表里', !!hit);
      if (hit) {
        assert(str(hit.className) === classB.className, `归属班级取在住班「${classB.className}」而不是快照「${classA.className}」`, { got: hit.className, snapshot: classA.className });
        assert(
          hit.departmentId === String(classB.departmentId),
          `归属系部取在住班的「${classB.departmentName}」而不是快照「${classA.departmentName}」`,
          { gotId: hit.departmentId, gotName: hit.departmentName, want: classB.departmentId }
        );
        assert(hit.residentCount === 1, '应住人数 = 在住人数 1', hit.residentCount);
      }
      // 1c) 两向范围判定：按 B 班系部能筛到、按 A 班系部筛不到
      const deptSetA = new Set([String(classA.departmentId)]);
      const deptSetB = new Set([String(classB.departmentId)]);
      if (String(classA.departmentId) !== String(classB.departmentId)) {
        const inB = await bandChao.entryTargets({
          moduleDef: dormModule,
          date: '2026-11-16',
          period: '',
          scopeDepartmentIds: [...deptSetB],
          scopeSchoolIds: [String(s1._id)],
          scopeSchoolNames: [s1.name],
          limit: 5000,
        });
        const inA = await bandChao.entryTargets({
          moduleDef: dormModule,
          date: '2026-11-16',
          period: '',
          scopeDepartmentIds: [...deptSetA],
          scopeSchoolIds: [String(s1._id)],
          scopeSchoolNames: [s1.name],
          limit: 5000,
        });
        assert(
          (inB.targets || []).some((x) => x.targetId === String(tmpRoom._id)),
          `按在住班系部「${classB.departmentName}」能筛到该房间（不该漏展）`,
          { dept: classB.departmentName }
        );
        assert(
          !(inA.targets || []).some((x) => x.targetId === String(tmpRoom._id)),
          `按旧快照系部「${classA.departmentName}」筛不到该房间（堵住越权）`,
          { dept: classA.departmentName }
        );
      } else {
        console.log('  （跳过范围两向验证：两个班恰好同系部）');
      }
    } else {
      console.log('  （跳过：库里没有同校区两个有系部的班级，无法构造冲突样本）');
    }
  } finally {
    if (tmpRoom) {
      await DormAssignment.deleteMany({ roomId: tmpRoom._id });
      await DormRoom.deleteOne({ _id: tmpRoom._id });
    }
  }

  // ============================================================
  // 报障二：学生会成员列表的筛选 / 搜索 / 分页
  // ============================================================
  console.log('\n[3] 成员列表：院校 / 部门 / 学年 / 搜索 / 分页');
  const presMember = await UnionMember.findOne({ status: 'active', level: 'school', deptKey: 'presidium' }).lean();
  const actor = presMember ? await User.findById(presMember.userId) : null;
  assert(!!actor, '库里有校级主席团成员可作为调用者', !!actor);
  if (actor) {
    // 起真实路由（auth 打桩）
    // ⚠️ 必须用**可变变量** currentActor：`routes/union.js` 是在 require 时
    // `const { auth } = require('../middlewares/auth')` **解构**走的，
    // 之后再改 `authMw.auth` 对它无效（打桩会静默失效，验证就变成了永远用第一个人）。
    const authMw = require(path.join(serverDir, 'src', 'middlewares', 'auth'));
    const savedAuth = authMw.auth;
    let currentActor = actor;
    authMw.auth = (req, res, next) => {
      req.user = currentActor;
      next();
    };
    const unionRouter = require(path.join(serverDir, 'src', 'routes', 'union'));
    const app = express();
    app.use(express.json());
    app.use('/api/union', unionRouter);
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code || 500, message: err.message }));
    const server = await new Promise((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    const BASE = `http://127.0.0.1:${server.address().port}`;
    const get = async (url) => {
      const res = await fetch(`${BASE}${url}`);
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    const dataOf = (r) => (r.data && r.data.data) || {};

    try {
      unionSvc.clearIdentityCache(actor.openid);

      // ① 全量（分页）
      const all = await get('/api/union/manage/members?limit=20');
      const dAll = dataOf(all);
      assert(all.status === 200, '成员列表可访问（200）', { status: all.status, msg: all.data.message });
      assert(Array.isArray(dAll.list) && dAll.list.length === 20, 'limit=20 生效（第一页 20 条）', (dAll.list || []).length);
      assert(dAll.hasMore === true, 'hasMore=true（库内成员多于 20）', dAll.hasMore);
      const dbActive = await UnionMember.countDocuments({ status: 'active' });
      assert(dAll.total <= dbActive, `total(${dAll.total}) 不超过库内在任总数(${dbActive})`, { total: dAll.total, dbActive });

      // ② 院校筛选
      const schoolOnly = await get('/api/union/manage/members?campus=school&limit=100');
      const dSchool = dataOf(schoolOnly);
      const dbSchool = await UnionMember.countDocuments({ status: 'active', level: 'school' });
      assert(dSchool.total === dbSchool, `院校=校学生会 的 total 与库内一致（${dSchool.total} vs ${dbSchool}）`, { got: dSchool.total, want: dbSchool });
      assert((dSchool.list || []).every((m) => m.level === 'school'), '院校=校学生会 的每条都是 level=school', (dSchool.list || []).filter((m) => m.level !== 'school').slice(0, 3));

      const campuses = dAll.schools || [];
      assert(campuses.length > 0, `下发 schools 院校选项（${campuses.length} 个校区）`, campuses);
      if (campuses.length) {
        const c = campuses[0];
        const byCampus = await get(`/api/union/manage/members?campus=${c.id}&limit=100`);
        const dc = dataOf(byCampus);
        const dbCampus = await UnionMember.countDocuments({ status: 'active', level: 'branch', schoolId: new mongoose.Types.ObjectId(c.id) });
        assert(dc.total === dbCampus, `院校=${c.name} 的 total 与库内一致（${dc.total} vs ${dbCampus}）`, { got: dc.total, want: dbCampus });
        assert((dc.list || []).every((m) => m.schoolId === String(c.id)), `院校=${c.name} 的每条都属于该校区`, (dc.list || []).filter((m) => m.schoolId !== String(c.id)).slice(0, 3));
        assert(dc.total < dAll.total, `院校筛选确实收窄了结果（${dc.total} < ${dAll.total}）`, { got: dc.total, all: dAll.total });
      }

      // ③ 部门筛选
      const deptOpts = dAll.departments || [];
      assert(deptOpts.length > 0, `下发 departments 部门选项（${deptOpts.length} 个）`, deptOpts.map((x) => x.key));
      if (deptOpts.length) {
        const dk = deptOpts[0].key;
        const byDept = await get(`/api/union/manage/members?deptKey=${encodeURIComponent(dk)}&limit=100`);
        const dd = dataOf(byDept);
        const dbDept = await UnionMember.countDocuments({ status: 'active', deptKey: dk });
        assert(dd.total === dbDept, `部门=${dk} 的 total 与库内一致（${dd.total} vs ${dbDept}）`, { got: dd.total, want: dbDept });
        assert((dd.list || []).every((m) => m.deptKey === dk), `部门=${dk} 的每条都是该部门`, (dd.list || []).filter((m) => m.deptKey !== dk).slice(0, 3));
        assert(dd.total < dAll.total, `部门筛选确实收窄了结果（${dd.total} < ${dAll.total}）`, { got: dd.total, all: dAll.total });
      }

      // ④ 学年筛选
      const termOpts = dAll.terms || [];
      assert(termOpts.length > 0, `下发 terms 学年选项（${termOpts.length} 个）`, termOpts.map((t) => t.termId));
      assert(!!dAll.currentTerm, '下发 currentTerm（前端默认学年）', dAll.currentTerm);
      if (termOpts.length > 1) {
        const older = termOpts.find((t) => t.termId !== dAll.currentTerm) || termOpts[1];
        const byTerm = await get(`/api/union/manage/members?termId=${encodeURIComponent(older.termId)}&limit=200`);
        const dt = dataOf(byTerm);
        const expected = await UnionMember.countDocuments({ status: 'active', termId: older.termId });
        assert(dt.total === expected, `学年=${older.termId} 的 total 与库内一致（${dt.total} vs ${expected}）`, { got: dt.total, want: expected });
        assert((dt.list || []).every((m) => m.termId === older.termId), `学年=${older.termId} 的每条都是该学年`, (dt.list || []).filter((m) => m.termId !== older.termId).slice(0, 3));
      } else {
        console.log('  （跳过学年收窄验证：可选学年只有 1 个）');
      }

      // ⑤ 关键词搜索（姓名命中 / 不命中）
      if (dAll.list && dAll.list.length) {
        const name = dAll.list[0].realName;
        if (name) {
          const kw = await get(`/api/union/manage/members?keyword=${encodeURIComponent(name)}&limit=100`);
          const dk2 = dataOf(kw);
          assert(dk2.total >= 1 && dk2.total < dAll.total, `搜索「${name}」收窄到 ${dk2.total} 条`, { got: dk2.total, all: dAll.total });
          assert((dk2.list || []).some((m) => m.realName === name), `搜索结果包含「${name}」本人`, (dk2.list || []).map((m) => m.realName));
        }
        const none = await get(`/api/union/manage/members?keyword=${encodeURIComponent('__没有这个人的名字__')}&limit=20`);
        assert(dataOf(none).total === 0, '搜索不存在的名字 → 0 条（不是全量）', dataOf(none).total);
      }

      // ⑥ 分页不重叠
      const p1 = dataOf(await get('/api/union/manage/members?page=1&limit=5')).list || [];
      const p2 = dataOf(await get('/api/union/manage/members?page=2&limit=5')).list || [];
      const ids1 = new Set(p1.map((m) => m.id));
      const overlap = p2.filter((m) => ids1.has(m.id));
      assert(p1.length === 5 && p2.length === 5, 'page=1/2 各返回 5 条', { p1: p1.length, p2: p2.length });
      assert(overlap.length === 0, 'page=1 与 page=2 不重叠（分页真的生效）', overlap.map((m) => m.id));

      // ⑦ 范围没被筛选绕过：分院主席团看不到外校区成员
      const branchPres = await UnionMember.findOne({ status: 'active', level: 'branch', deptKey: 'presidium' }).lean();
      if (branchPres) {
        const branchUser = await User.findById(branchPres.userId);
        if (branchUser) {
          currentActor = branchUser;
          unionSvc.clearIdentityCache(branchUser.openid);
          const own = dataOf(await get('/api/union/manage/members?limit=200'));
          const ownCampus = str(branchPres.schoolId);
          const foreign = (own.list || []).filter((m) => m.level === 'branch' && ownCampus && m.schoolId && m.schoolId !== ownCampus);
          assert(foreign.length === 0, '分院主席团的列表里没有外校区成员（筛选不能绕过范围）', foreign.slice(0, 3));
          // 带上外校区 campus 参数也必须为空（否则就是越权读）
          const otherCampus = campuses.find((c) => c.id !== ownCampus);
          if (otherCampus) {
            const cross = dataOf(await get(`/api/union/manage/members?campus=${otherCampus.id}&limit=200`));
            assert(cross.total === 0, `分院主席团按外校区「${otherCampus.name}」筛 → 0 条（越权被拦）`, { total: cross.total });
          }
        }
      } else {
        console.log('  （跳过越权验证：库里没有分院主席团）');
      }
    } finally {
      authMw.auth = savedAuth;
      await new Promise((r) => server.close(r));
    }
  }

  await mongoose.disconnect();
  console.log(failed ? `\n失败 ${failed} 项` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('ERR', e);
  try {
    await mongoose.disconnect();
  } catch (err) {
    /* ignore */
  }
  process.exit(1);
});
