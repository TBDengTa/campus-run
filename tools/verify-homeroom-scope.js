// 端到端验证：班主任（**不需要任何管理权限**）可以管理本班学生
//
// 用户 2026-10-22 要求：
//   「班主任没有用户管理权限时，是可以管理自己本班的学生的操作功能
//    如（编辑资料 / 重置密码 / 发放徽章 / 限制功能 / 删除账户）。」
//
// 这个脚本把真实路由挂起来、把 auth 中间件换成「按 header 指定 actor」，
// 然后用**临时学生**跑整套动作（不碰真实学生数据），最后清理临时数据并核对已清干净。
//
// 用法：node tools/verify-homeroom-scope.js
// 需要能连上 .env 里的数据库；不需要启动后端。
const path = require('path');
const serverDir = path.join(__dirname, '..', 'server');
const config = require(path.join(serverDir, 'src', 'config'));
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));
const express = require(path.join(serverDir, 'node_modules', 'express'));

const User = require(path.join(serverDir, 'src', 'models', 'user'));
const UserBadge = require(path.join(serverDir, 'src', 'models', 'user-badge'));
const BanRecord = require(path.join(serverDir, 'src', 'models', 'ban-record'));
const studentScope = require(path.join(serverDir, 'src', 'services', 'student-scope'));

let failed = 0;
function assert(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ← ' + JSON.stringify(extra)}`);
  if (!cond) failed += 1;
}

const TMP_TAG = `homeroom_verify_${Date.now()}`;

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });

  // ---- 1) 纯判定：不变式（不碰库） ----
  const actorBase = { _id: 'a1', role: 'teacher', homeroomClasses: ['C1'] };
  const plainTarget = { _id: 's1', role: 'student', className: 'C1', getEffectivePermissions: async () => [] };
  const adminTarget = { _id: 's2', role: 'student', className: 'C1', getEffectivePermissions: async () => ['user.view'] };
  assert(studentScope.isHomeroomOf(actorBase, plainTarget), '班主任 + 本班学生 → 是本班关系');
  assert(!studentScope.isHomeroomOf(actorBase, { ...plainTarget, className: 'C2' }), '跨班 → 不是本班关系');
  assert(!studentScope.isHomeroomOf(actorBase, { ...plainTarget, role: 'teacher' }), '目标教师 → 不是本班关系');
  assert(!studentScope.isHomeroomOf({ ...actorBase, role: 'student' }, plainTarget), '班委/学生 → 不是本班关系（只读）');
  assert(await studentScope.canManageStudent(actorBase, plainTarget), '普通学生 → 班主任可管理');
  assert(!(await studentScope.canManageStudent(actorBase, adminTarget)), '持管理权限的学生 → 班主任不可管理（交管理员）');

  // ---- 2) 找一组真实「班主任 + 班级」 ----
  const teacher = await User.findOne({ role: 'teacher', homeroomClasses: { $exists: true, $ne: [] } });
  if (!teacher) throw new Error('库里没有配置了班主任班级的教师，无法验证');
  const className = teacher.homeroomClasses[0];
  const studentCount = await User.countDocuments({ role: 'student', className });
  if (!studentCount) throw new Error(`班级「${className}」没有学生，无法验证`);

  // ---- 3) 起真实路由（auth 中间件打桩：按 header 指定 actor） ----
  const authMwPath = require.resolve(path.join(serverDir, 'src', 'middlewares', 'auth'));
  const authMw = require(authMwPath);
  const actors = new Map();
  authMw.auth = (req, res, next) => {
    const key = req.headers['x-actor'] || '';
    const doc = actors.get(key);
    if (!doc) return res.status(401).json({ code: 401, message: 'no actor' });
    req.user = doc;
    next();
  };
  const classRouter = require(path.join(serverDir, 'src', 'routes', 'class'));

  const app = express();
  app.use(express.json());
  app.use('/api/class', classRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code || 500, message: err.message }));
  const port = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s.address().port));
  });
  const BASE = `http://127.0.0.1:${port}`;

  const call = async (who, method, url, body) => {
    const res = await fetch(`${BASE}${url}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-actor': who },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, code: json.code, message: json.message, data: json.data || {} };
  };

  // 被管理的临时学生（普通学生）、临时班委（只读校验）
  const tmp = await User.create({
    openid: `${TMP_TAG}_target`,
    account: `${TMP_TAG}_T`,
    realName: '临时验证学生',
    role: 'student',
    className,
    studentId: `T${Date.now()}`, // 唯一稀疏索引
    gender: 1,
    mustChangePassword: false,
  });
  const tmpOfficer = await User.create({
    openid: `${TMP_TAG}_officer`,
    account: `${TMP_TAG}_O`,
    realName: '临时验证班委',
    role: 'student',
    className,
    isClassOfficer: true,
    studentId: `O${Date.now()}`,
    mustChangePassword: false,
  });

  const actorTeacher = await User.findById(teacher._id);
  const actorOfficer = tmpOfficer;
  actors.set('teacher', actorTeacher);
  actors.set('officer', actorOfficer);

  const q = (extra = '') => `?className=${encodeURIComponent(className)}${extra}`;
  const snapshot = { passwordHash: tmp.passwordHash, initialHashes: tmp.initialHashes, mustChangePassword: tmp.mustChangePassword };
  let deleted = false;

  try {
    // ---- 4) 能力探测 ----
    const mg = await call('teacher', 'GET', `/api/class/student/${tmp._id}/manage${q()}`);
    assert(mg.status === 200 && mg.data.canManage === true, '班主任 GET /manage → canManage:true', mg);
    assert(mg.data.profile && mg.data.profile.realName === '临时验证学生', '返回可编辑资料（姓名）', mg.data.profile);
    assert(Array.isArray(mg.data.banScopes) && mg.data.banScopes.join(',') === 'sync,gps', '班主任可限制的类型 = sync,gps', mg.data.banScopes);

    // 班委（学生身份）调用同一接口 → 403（只读）
    const off = await call('officer', 'GET', `/api/class/student/${tmp._id}/manage${q()}`);
    assert(off.status === 403 && off.code === 403002, '班委 → 403（班级域只读）', off);

    // 跨班：用别的班名请求 → 403
    const other = await call('teacher', 'GET', `/api/class/student/${tmp._id}/manage?className=${encodeURIComponent('不存在的班级')}`);
    assert(other.status === 403, '跨班 className → 403', other);

    // ---- 5) 编辑资料：只允许 姓名/性别/生日 ----
    const okProfile = await call('teacher', 'PUT', `/api/class/student/${tmp._id}/profile${q()}`, {
      account: `${TMP_TAG}_T2`,
      gender: 2,
      birthdate: '2006-03-04',
    });
    assert(okProfile.status === 200, '班主任改姓名/性别/生日 → 200', okProfile);
    const afterProfile = await User.findById(tmp._id);
    assert(afterProfile.realName === `${TMP_TAG}_T2` && afterProfile.gender === 2, '资料已落库', {
      realName: afterProfile.realName,
      gender: afterProfile.gender,
    });

    const badField = await call('teacher', 'PUT', `/api/class/student/${tmp._id}/profile${q()}`, { studentId: '99999999' });
    assert(badField.status === 403 && badField.code === 403005, '改学号 → 403（学籍字段禁改）', badField);

    // 班委改资料 → 403
    const offPut = await call('officer', 'PUT', `/api/class/student/${tmp._id}/profile${q()}`, { gender: 0 });
    assert(offPut.status === 403, '班委改资料 → 403', offPut);

    // ---- 5b) 宿舍：班主任可以给本班学生安排住宿，且**不需要 building.view 就能选楼** ----
    const bld = await call('teacher', 'GET', '/api/class/buildings');
    assert(
      bld.status === 200 && Array.isArray(bld.data.teaching) && Array.isArray(bld.data.dorm),
      '班主任能拿到楼名清单（/api/class/buildings，不需 building.view）',
      bld
    );
    const dormGet = await call('teacher', 'GET', `/api/class/student/${tmp._id}/dorm${q()}`);
    assert(dormGet.status === 200, '班主任读本班学生宿舍面板 → 200', dormGet);
    assert(Array.isArray(dormGet.data.buildings), '宿舍面板自带楼名清单（不再依赖 /api/admin/config/buildings）', dormGet.data.buildings);
    assert(dormGet.data.wechatBound === true, '面板正确回报「已绑微信」（能记住宿）', dormGet.data.wechatBound);

    const dormBuilding = (dormGet.data.buildings[0] && dormGet.data.buildings[0].name) || '1号楼';
    const dormRoomLabel = `${dormBuilding}·测试${String(Date.now()).slice(-4)}`;
    const dormPut = await call('teacher', 'PUT', `/api/class/student/${tmp._id}/dorm${q()}`, {
      roomLabel: dormRoomLabel,
      bedNo: '1',
    });
    assert(dormPut.status === 200 && dormPut.data.room === dormRoomLabel, '班主任给本班学生分配宿舍 → 200', dormPut);
    const dormAfter = await call('teacher', 'GET', `/api/class/student/${tmp._id}/dorm${q()}`);
    assert(dormAfter.data.roomText === dormRoomLabel, '宿舍已落库（再读得到同一间）', dormAfter.data.roomText);

    // 班委不能动宿舍
    const offDorm = await call('officer', 'PUT', `/api/class/student/${tmp._id}/dorm${q()}`, { roomLabel: '1号楼·999' });
    assert(offDorm.status === 403, '班委改宿舍 → 403', offDorm);

    const dormDel = await call('teacher', 'DELETE', `/api/class/student/${tmp._id}/dorm${q()}`);
    assert(dormDel.status === 200 && dormDel.data.checkedOut === true, '班主任退宿 → 200', dormDel);

    // ---- 6) 重置密码 ----
    const rp = await call('teacher', 'POST', `/api/class/student/${tmp._id}/reset-password${q()}`);
    assert(rp.status === 200 && /重置|密码/.test(rp.data.message || ''), '班主任重置本班学生密码 → 200', rp);
    const afterReset = await User.findById(tmp._id);
    assert(afterReset.mustChangePassword === true, '重置后要求下次登录改密', afterReset.mustChangePassword);

    // ---- 7) 限制功能：只能 sync / gps ----
    const banLogin = await call('teacher', 'POST', `/api/class/student/${tmp._id}/ban${q()}`, { scope: 'login', days: 7 });
    assert(banLogin.status === 403, '班主任限制登录 → 403（校级处置）', banLogin);

    const banSync = await call('teacher', 'POST', `/api/class/student/${tmp._id}/ban${q()}`, { scope: 'sync', days: 3, reason: '验证' });
    assert(banSync.status === 200, '班主任限制微信同步 → 200', banSync);
    const afterBan = await User.findById(tmp._id);
    const activeScopes = (afterBan.restrictions ? Object.keys(afterBan.restrictions.toObject ? afterBan.restrictions.toObject() : afterBan.restrictions) : []);
    assert(activeScopes.includes('sync'), '限制已落库（sync）', activeScopes);

    const unban = await call('teacher', 'POST', `/api/class/student/${tmp._id}/unban${q()}`, { scope: 'sync' });
    assert(unban.status === 200 && (unban.data.lifted || []).length === 1, '班主任解除同步限制 → 200 且 lifted=1', unban);

    // ---- 8) 徽章：发放 / 回收 ----
    const sheet = await call('teacher', 'GET', `/api/class/student/${tmp._id}/badges${q()}`);
    assert(sheet.status === 200 && Array.isArray(sheet.data.definitions), '徽章抽屉数据源可读（含 definitions）', {
      status: sheet.status,
      defs: (sheet.data.definitions || []).length,
    });
    const first = (sheet.data.definitions || []).find((d) => d.mode !== 'tier' || true) || null;
    if (first) {
      const grant = await call('teacher', 'POST', `/api/class/student/${tmp._id}/badges${q()}`, { badgeKey: first.key });
      assert(grant.status === 200 && grant.data.granted === true, `班主任发放徽章（${first.key}）→ granted`, grant);
      const revoke = await call('teacher', 'DELETE', `/api/class/student/${tmp._id}/badges/${encodeURIComponent(first.key)}${q()}`);
      assert(revoke.status === 200 && revoke.data.revoked === 1, '班主任回收徽章 → revoked=1', revoke);
    } else {
      console.log('（库里没有启用中的徽章定义，跳过发放用例）');
    }

    // ---- 9) 能力表：班主任能做什么由服务端下发（用户 2026-10-23） ----
    const mgAgain = await call('teacher', 'GET', `/api/class/student/${tmp._id}/manage${q()}`);
    const caps = (mgAgain.data && mgAgain.data.capabilities) || {};
    assert(caps.editProfile === true && caps.resetPassword === true, '能力表：编辑资料 / 重置密码 = 允许', caps);
    assert(caps.badges === true && caps.ban === true && caps.unban === true, '能力表：徽章 / 限制 / 解除 = 允许', caps);
    assert(caps.dorm === true, '能力表：宿舍 = 允许', caps);
    assert(
      caps.deleteAccount === false,
      '能力表：**删除账户 = 不允许**（班主任不该看到这个按钮）',
      caps
    );

    // ---- 9b) 删除账户：班主任 403（前端不画按钮，后端也必须真的拦） ----
    const del = await call('teacher', 'DELETE', `/api/class/student/${tmp._id}${q()}`);
    assert(del.status === 403 && del.code === 403002, '班主任删除本班学生 → 403 403002（不给权限）', del);
    assert(!!(await User.findById(tmp._id)), '学生仍然存在（没有被误删）', true);
    deleted = false; // 交给 finally 正常走「恢复快照 + 删除」

    // ---- 10) 跨班（真实学生）只读拦截 ----
    const outsider = await User.findOne({ role: 'student', className: { $nin: [className, null, ''] } }).select('_id');
    if (outsider) {
      const cross = await call('teacher', 'POST', `/api/class/student/${outsider._id}/reset-password?className=${encodeURIComponent(className)}`);
      assert(cross.status === 403, '跨班学生（用本班班名）→ 403', cross);
    }
  } finally {
    // ---- 清理：临时学生 / 班委 / 密码快照 / 徽章与限制流水 / 住宿记录 ----
    const ids = [tmp._id, tmpOfficer._id];
    await UserBadge.deleteMany({ openid: { $in: [`${TMP_TAG}_target`, `${TMP_TAG}_officer`] } });
    await BanRecord.deleteMany({ userId: { $in: ids } });
    // 住宿：本用例写了一条 assignment 并自动建了一间房，必须清掉并回填班级应住人数，
    // 否则真班级的 dormCount 会因测试永久偏 1。
    const DormAssignment = require(path.join(serverDir, 'src', 'models', 'dorm-assignment'));
    const DormRoom = require(path.join(serverDir, 'src', 'models', 'dorm-room'));
    const classProfilesSvc = require(path.join(serverDir, 'src', 'services', 'class-profiles'));
    await DormAssignment.deleteMany({ openid: { $regex: `^${TMP_TAG}` } });
    const roomRe = /^测试\d{4}$/;
    const rooms = await DormRoom.find({ roomNo: roomRe }).select('_id').lean();
    if (rooms.length) await DormRoom.deleteMany({ _id: { $in: rooms.map((r) => r._id) } });
    try {
      await classProfilesSvc.refreshDormCounts(className);
    } catch (e) {
      /* 回填失败不掩盖测试结论 */
    }
    if (!deleted) {
      await User.updateOne(
        { _id: tmp._id },
        { $set: { ...snapshot, restrictions: { sync: { until: null, reason: '', count: 0, operator: 'system' }, gps: { until: null, reason: '', count: 0, operator: 'system' } } } }
      );
    }
    await User.deleteMany({ _id: { $in: ids } });

    const leftUsers = await User.countDocuments({ account: { $regex: `^${TMP_TAG}` } });
    const leftBadges = await UserBadge.countDocuments({ openid: { $regex: `^${TMP_TAG}` } });
    const leftBans = await BanRecord.countDocuments({ userId: { $in: ids } });
    const leftDorms = await DormAssignment.countDocuments({ openid: { $regex: `^${TMP_TAG}` } });
    const leftRooms = await DormRoom.countDocuments({ roomNo: roomRe });
    console.log(
      `\n清理：残留用户 ${leftUsers} / 徽章 ${leftBadges} / 限制流水 ${leftBans} / 住宿 ${leftDorms} / 测试房间 ${leftRooms}`
    );
    if (leftUsers || leftBadges || leftBans || leftDorms || leftRooms) failed += 1;
  }

  await mongoose.disconnect();
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.stack);
  process.exit(1);
});
