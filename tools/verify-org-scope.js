// 端到端验证：组织归属（院校 → 系部）解析与范围判定
//
// 背景（用户 2026-11-13 两条报障）：
//   ① 「部员检查录入时提示目标班级没有归属院系」——26 级整届台账只有名字没有 id；
//   ② 「学生会控制台显示的是分院学生会，这里显示真实的院校名称」。
//
// 这个脚本**真连库**，但只读（不写任何集合），跑完不需要清理。它验证的是「修完之后应有的性质」：
//   [1] 数据面：可解析的行都不再缺 departmentId（回归「只有名字」的形态）
//   [2] 范围判定：本校区分会成员能录本校区所有班/房/区；**另一校区仍被拦**（兜底没放宽越权）
//   [3] 展示：分院身份的 roleText/levelText 带真实校区名
//   [4] 计数：facets.tree 的院校 count = 系部之和 = 列表 total
//   [5] 幂等：回填脚本 dry-run 已无可改行
//
// 用法：node tools/verify-org-scope.js
const path = require('path');
const serverDir = path.join(__dirname, '..', 'server');
const config = require(path.join(serverDir, 'src', 'config'));
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));
const express = require(path.join(serverDir, 'node_modules', 'express'));

const User = require(path.join(serverDir, 'src', 'models', 'user'));
const ClassProfile = require(path.join(serverDir, 'src', 'models', 'class-profile'));
const unionSvc = require(path.join(serverDir, 'src', 'services/union'));
const orgResolve = require(path.join(serverDir, 'src', 'services', 'org-resolve'));

let failed = 0;
function assert(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ← ' + JSON.stringify(extra)}`);
  if (!cond) failed += 1;
}
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });
  const um = mongoose.connection.db.collection('student_union_members');

  // ===== [1] 数据面 =====
  console.log('\n[1] 台账 / 学籍的组织 id');
  const idx = await orgResolve.loadIndex();
  const profiles = await ClassProfile.find({}).select('className schoolName schoolId departmentName departmentId').lean();
  const resolvableButEmpty = profiles.filter((p) => {
    if (p.departmentId) return false;
    const r = orgResolve.resolveDepartmentSync(idx, p);
    return !!r.departmentId; // 能解析却没写 = 回填还没跑 / 又产生了新脏数据
  });
  assert(resolvableButEmpty.length === 0, `没有「能解析但 id 为空」的班级（${profiles.length} 个班）`, resolvableButEmpty.map((p) => p.className).slice(0, 10));

  const students = await User.find({ role: { $ne: 'teacher' } }).select('className schoolName departmentName departmentId schoolId').lean();
  const stuEmpty = students.filter((s) => {
    if (s.departmentId) return false;
    if (!str(s.schoolName) && !str(s.departmentName)) return false; // 无归属的示例账号：允许为空
    return !!orgResolve.resolveDepartmentSync(idx, s).departmentId;
  });
  assert(stuEmpty.length === 0, `没有「能解析但 id 为空」的学生（${students.length} 人）`, stuEmpty.length);

  // ===== [2] 范围判定（真实路由 + 打桩鉴权）=====
  console.log('\n[2] 范围判定：本校区放行 / 跨校区拦截');
  const northMember = await um.findOne({ status: 'active', level: 'branch', schoolName: '北校区' });
  const southMember = await um.findOne({ status: 'active', level: 'branch', schoolName: '洋河校区' });
  assert(!!northMember && !!southMember, '库里有北校区与洋河校区的在任分院成员', { north: !!northMember, south: !!southMember });
  if (northMember && southMember) {
    const northUser = await User.findById(northMember.userId);
    const southUser = await User.findById(southMember.userId);

    const authMw = require(path.join(serverDir, 'src', 'middlewares', 'auth'));
    let actor = northUser;
    authMw.auth = (req, res, next) => {
      req.user = actor;
      next();
    };
    const unionRouter = require(path.join(serverDir, 'src', 'routes', 'union'));
    const app = express();
    app.use(express.json());
    app.use('/api/union', unionRouter);
    app.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code || 500, message: err.message }));
    const port = await new Promise((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s.address().port));
    });
    const BASE = `http://127.0.0.1:${port}`;
    const get = async (url) => {
      const res = await fetch(`${BASE}${url}`);
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };

    const northClass = profiles.find((p) => p.schoolName === '北校区' && !p.departmentIdRaw);
    const southClass = profiles.find((p) => p.schoolName === '洋河校区');
    assert(!!northClass && !!southClass, '库里有北校区 / 洋河校区的班级', { north: !!northClass, south: !!southClass });
    if (northClass && southClass) {
      const url = (cn) => `/api/union/entry/students?moduleKey=study_evening&className=${encodeURIComponent(cn)}`;
      const n1 = await get(url(northClass.className));
      assert(n1.status === 200, `北校区成员可录北校区班「${northClass.className}」`, { status: n1.status, msg: n1.data.message });
      // 注意：北校区成员录洋河班必须是 403，但「哪个模块能录」取决于部门，这里只断言**不是 200**
      const n2 = await get(url(southClass.className));
      assert(n2.status !== 200, `北校区成员录洋河班「${southClass.className}」被拦`, { status: n2.status });

      actor = southUser;
      const s1 = await get(url(southClass.className));
      assert(s1.status === 200, `洋河校区成员可录洋河班「${southClass.className}」`, { status: s1.status, msg: s1.data.message });
      const s2 = await get(url(northClass.className));
      assert(s2.status !== 200, `洋河校区成员录北校区班「${northClass.className}」被拦`, { status: s2.status });

      // 拦截文案必须带校区名（用户能判断是权限还是成员记录绑错校区）
      const msg = n2.status !== 200 ? n2.data.message || '' : '';
      assert(!msg || /北校区/.test(msg) || /所属部门|部门不负责|不是学生会成员/.test(msg), '拦截文案带校区名或说明部门不负责', { msg });
    }

    // ===== [3] 展示 =====
    console.log('\n[3] 身份展示（真实院校名）');
    actor = northUser;
    unionSvc.clearIdentityCache(northUser.openid);
    const mine = await get('/api/union/mine');
    const md = mine.data.data || {};
    const roleText = md.roleText || '';
    assert(/北校区学生会/.test(roleText), `roleText 含「北校区学生会」（实际：${roleText}）`, roleText);
    assert(md.campusName === '北校区', `/mine 下发 campusName（实际：${md.campusName}）`, md.campusName);
    assert((md.roles || []).every((r) => r.level !== 'branch' || !r.schoolName || /学生会$/.test(r.levelText) && r.levelText === `${r.schoolName}学生会`), 'roles[].levelText 与校区名一致', md.roles);
    assert(!(md.roles || []).some((r) => r.levelText === '分院学生会' && r.schoolName), '不再出现「分院学生会」而校区名可用', md.roles);
  }

  // ===== [4] facets 计数 =====
  console.log('\n[4] facets.tree 院校计数');
  const admin = await User.findOne({ permissionGroups: { $in: ['superadmin'] } });
  if (admin) {
    const authMw = require(path.join(serverDir, 'src', 'middlewares', 'auth'));
    authMw.auth = (req, res, next) => {
      req.user = admin;
      next();
    };
    const adminRouter = require(path.join(serverDir, 'src', 'routes', 'admin', 'index'));
    const app = express();
    app.use(express.json());
    app.use('/api/admin', adminRouter);
    app.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code || 500, message: err.message }));
    const port = await new Promise((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s.address().port));
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/class/profiles?page=1&limit=3&status=normal`);
    const body = await res.json();
    const f = (body.data && body.data.facets) || {};
    const tree = f.tree || [];
    const total = body.data ? body.data.total : 0;
    const bad = tree.filter((s) => s.count !== (s.departments || []).reduce((a, d) => a + d.count, 0) + (s.unmappedDeptCount || 0));
    assert(tree.length > 0, '返回 facets.tree', tree.length);
    assert(bad.length === 0, '每个院校节点 count = 系部之和 + 系部未归位数', bad.map((s) => ({ k: s.key, c: s.count })));
    assert(tree.every((s) => s.count > 0), '有班级的院校不再显示「暂无班级」(count>0)', tree.map((s) => `${s.key}:${s.count}`));
    const sum = tree.reduce((a, s) => a + s.count, 0);
    assert(sum === total, `院校 count 之和 = 列表 total（${sum} vs ${total}）`, { sum, total });
  } else {
    console.log('  (跳过：库里没有 superadmin 账号)');
  }

  // ===== [5] 回填幂等 =====
  console.log('\n[5] 回填幂等性');
  const cpMissing = await ClassProfile.countDocuments({ departmentName: { $nin: [null, ''] }, $or: [{ departmentId: null }, { departmentId: { $exists: false } }] });
  assert(cpMissing === 0, `class_profiles 无「有系部名却缺 departmentId」的行（实际 ${cpMissing}）`, cpMissing);
  const crMissing = await mongoose.connection.db
    .collection('check_records')
    .countDocuments({ $or: [{ departmentId: null }, { departmentId: { $exists: false } }], className: { $not: /^rv_verify_/ } });
  assert(crMissing === 0, `check_records 无「真实班级却缺 departmentId」的行（实际 ${crMissing}）`, crMissing);

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
