// 端到端验证：教师账号不受「一个账号只能绑一个微信」的限制，学生仍然受限
//
// 用户 2026-10-22：「教师账户不限制微信绑定的登录。」
//
// 场景：
//   ① 教师账号已绑定微信 A，用微信 B 登录（姓名+密码）→ 必须成功，绑定更新为 B；
//   ② 学生账号已绑定微信 C，用微信 D 登录 → 仍然 403 403004（学生会代跑代签，不能放开）；
//   ③ 微信 E 已经绑在别的账号上时，教师想用它登录 → 明确报「该微信已绑定某某」，不抛唯一索引错误。
//
// 用临时账号跑，最后清理并核对已清干净。需要能连数据库；不需要启动后端。
// 用法：node tools/verify-teacher-rebind.js
const path = require('path');
const serverDir = path.join(__dirname, '..', 'server');
const config = require(path.join(serverDir, 'src', 'config'));
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));
const express = require(path.join(serverDir, 'node_modules', 'express'));
const jwt = require(path.join(serverDir, 'node_modules', 'jsonwebtoken'));

const User = require(path.join(serverDir, 'src', 'models', 'user'));
const pwd = require(path.join(serverDir, 'src', 'services', 'password'));

let failed = 0;
function assert(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ← ' + JSON.stringify(extra)}`);
  if (!cond) failed += 1;
}

const TAG = `rebind_verify_${Date.now()}`;
const PASSWORD = 'Verify123456';

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });

  const authRouter = require(path.join(serverDir, 'src', 'routes', 'auth'));
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code || 500, message: err.message }));
  const port = await new Promise((r) => {
    const s = app.listen(0, () => r(s.address().port));
  });
  const BASE = `http://127.0.0.1:${port}`;

  // 游客令牌（真实 signGuest 同构）：/bind 用 req.guestOpenid 作为「当前微信」
  const guestToken = (openid) => jwt.sign({ openid, guest: true }, config.jwtSecret, { expiresIn: '2h' });
  const postBind = async (token, account) => {
    const r = await fetch(`${BASE}/api/auth/bind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ account, password: PASSWORD }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const bind = (openid, account) => postBind(guestToken(openid), account);
  // 已登录态调用（登录页「用「X」登录」走的就是这条：带当前账号的正式令牌）
  const bindWithToken = (token, account) => postBind(token, account);

  const hash = pwd.hashPassword(PASSWORD);
  const teacher = await User.create({
    openid: `${TAG}_wx_a`,
    account: `${TAG}_T`,
    realName: `${TAG}_T`,
    role: 'teacher',
    passwordHash: hash,
    mustChangePassword: false,
  });
  const student = await User.create({
    openid: `${TAG}_wx_stu_old`,
    account: `${TAG}_S`,
    realName: `${TAG}_S`,
    role: 'student',
    className: '24软件技术',
    studentId: `R${Date.now()}`,
    passwordHash: hash,
    mustChangePassword: false,
  });
  // 另一个「占用微信 E」的账号
  const holder = await User.create({
    openid: `${TAG}_wx_e`,
    account: `${TAG}_H`,
    realName: `${TAG}_H`,
    role: 'student',
    className: '24软件技术',
    studentId: `H${Date.now()}`,
    passwordHash: hash,
    mustChangePassword: false,
  });
  // 第二个教师账号（用来验证「同一微信上教师 A → 教师 B」的换绑）
  const teacher2 = await User.create({
    openid: `${TAG}_wx_t2`,
    account: `${TAG}_T2`,
    realName: `${TAG}_T2`,
    role: 'teacher',
    passwordHash: hash,
    mustChangePassword: false,
  });
  // 未绑定任何微信的学生账号（用来验证「不能借它抢走教师的微信」）
  const student2 = await User.create({
    account: `${TAG}_S2`,
    realName: `${TAG}_S2`,
    role: 'student',
    className: '24软件技术',
    studentId: `S${Date.now()}`,
    passwordHash: hash,
    mustChangePassword: false,
  });

  try {
    // ① 教师：换微信登录
    const t1 = await bind(`${TAG}_wx_b`, `${TAG}_T`);
    assert(t1.status === 200 && t1.body.code === 0, '教师用另一个微信登录 → 成功（不再 403）', t1);
    const teacherAfter = await User.findById(teacher._id);
    assert(teacherAfter.openid === `${TAG}_wx_b`, '教师绑定已更新为新微信', teacherAfter.openid);
    assert(!!t1.body.data.token && t1.body.data.bound === true, '返回正式 token（bound:true）', {
      token: !!t1.body.data.token,
      bound: t1.body.data.bound,
    });
    const payload = jwt.decode(t1.body.data.token) || {};
    assert(payload.openid === `${TAG}_wx_b`, '新令牌的 openid = 新微信', payload.openid);
    assert(String(payload.uid) === String(teacher._id), '令牌身份仍是这个教师账号（没有串号）', payload.uid);

    // ①b 再换一次（教师可反复换）
    const t2 = await bind(`${TAG}_wx_c`, `${TAG}_T`);
    assert(t2.status === 200, '教师再次换微信登录 → 仍成功', t2);
    assert((await User.findById(teacher._id)).openid === `${TAG}_wx_c`, '绑定再次更新', true);

    // ② 学生：仍然不允许换微信
    const s1 = await bind(`${TAG}_wx_stu_new`, `${TAG}_S`);
    assert(s1.status === 403 && s1.body.code === 403004, '学生换微信登录 → 403 403004（限制保留）', s1);
    assert(
      /已绑定其他微信/.test(s1.body.message || ''),
      '学生被拒的文案明确指向「已绑定其他微信」',
      s1.body.message
    );
    assert((await User.findById(student._id)).openid === `${TAG}_wx_stu_old`, '学生绑定没有被改动', true);

    // ③ 该微信已绑在**学生**账号上 → 教师也不能抢（学生微信不可被顶掉）
    const t3 = await bind(`${TAG}_wx_e`, `${TAG}_T`);
    assert(t3.status === 403 && t3.body.code === 403004, '目标微信已被学生账号占用 → 403', t3);
    assert(
      new RegExp(`${TAG}_H`).test(t3.body.message || '') && /学生/.test(t3.body.message || ''),
      '错误文案指出「学生账号」与占用方（不是数据库唯一索引报错）',
      t3.body.message
    );
    assert((await User.findById(holder._id)).openid === `${TAG}_wx_e`, '学生账号的绑定未被抢走', true);

    // ④ 同一微信上从教师 A 切到教师 B（截图里的死胡同）：
    //    用**已登录态**（A 的正式令牌）调 /bind，目标教师 B 允许顶替换绑。
    //    这正是登录页「用「B」登录」走的路径。
    const devBeforeA = await mongoose.connection.db
      .collection('login_devices')
      .countDocuments({ userId: teacher._id, revoked: { $ne: true } });
    const t4 = await bindWithToken(t2.body.data.token, `${TAG}_T2`);
    assert(t4.status === 200 && t4.body.code === 0, '已登录态下用另一个教师账号登录 → 成功（换绑）', t4);
    const aAfter = await User.findById(teacher._id);
    const bAfter = await User.findById(teacher2._id);
    assert(!aAfter.openid, '原教师账号的微信绑定已被摘除', aAfter.openid);
    assert(bAfter.openid === `${TAG}_wx_c`, '目标教师账号接管了这个微信', bAfter.openid);
    const t4payload = jwt.decode(t4.body.data.token) || {};
    assert(String(t4payload.uid) === String(teacher2._id), '返回的令牌是目标教师账号（没有串号）', t4payload.uid);
    const devAfterA = await mongoose.connection.db
      .collection('login_devices')
      .countDocuments({ userId: teacher._id, revoked: { $ne: true } });
    // ⚠️ 用户 2026-10-23 报障「历史登录一键登录……会出现历史记录失效」：
    // 换绑**不能**吊销原账号的设备令牌 —— 设备令牌按账号签发、与微信无关，
    // 原账号在其它手机上的「一键登录」仍然合法。旧实现 revokeAllForUser 把它们全作废了。
    assert(
      devBeforeA > 0 && devAfterA === devBeforeA,
      '换绑**不吊销**原账号的设备令牌（其它设备的一键登录记录保持有效）',
      { devBeforeA, devAfterA }
    );

    // ④b 原账号的设备令牌在换绑后**仍然能一键登录**（「历史登录不失效」的直接证据）
    const devA = await mongoose.connection.db
      .collection('login_devices')
      .findOne({ userId: teacher._id, revoked: { $ne: true } });
    assert(!!devA, '原账号仍有可用的设备令牌记录', !!devA);
    const oneClick = await fetch(`${BASE}/api/auth/device-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceToken: t2.body.data.deviceToken }),
    });
    const oneClickBody = await oneClick.json().catch(() => ({}));
    assert(
      oneClick.status === 200 && oneClickBody.code === 0,
      '换绑后原账号的一键登录仍然有效（不被误作废）',
      { status: oneClick.status, body: oneClickBody }
    );
    const ocPayload = jwt.decode((oneClickBody.data || {}).token) || {};
    assert(
      String(ocPayload.uid) === String(teacher._id),
      '一键登录进入的仍是原账号（没有串到别的身份）',
      ocPayload.uid
    );

    // ⑤ 已登录态也不能把**学生**账号顶掉
    //    注意这里用的是**换绑后**（teacher2）的令牌：原账号 A 的令牌在换绑瞬间就失效了（下面 ⑥ 验证）
    const t5 = await bindWithToken(t4.body.data.token, `${TAG}_S2`);
    assert(t5.status === 403 && t5.body.code === 403004, '已登录态下登录另一个学生账号 → 403', t5);

    // ⑤b 原账号 A 的令牌必须失效（否则换绑后旧身份还能继续用）
    const stale = await fetch(`${BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${t2.body.data.token}` },
    });
    assert(stale.status === 401, '换绑后原账号的旧令牌 → 401（不能继续用旧身份）', stale.status);

    // ⑥ 未绑定微信的学生账号，也不能借「第一次绑定」抢走教师占着的微信
    //    （旧实现会在这一步撞唯一索引 E11000 → 500）
    const t6 = await bind(`${TAG}_wx_c`, `${TAG}_S2`);
    assert(t6.status === 403 && t6.body.code === 403004, '学生账号抢教师已绑的微信 → 403（不是 500）', t6);
    assert((await User.findById(student2._id)).openid === undefined, '该学生仍未被绑定', true);
    assert((await User.findById(teacher2._id)).openid === `${TAG}_wx_c`, '教师的绑定未被抢走', true);
  } finally {
    await User.deleteMany({ account: { $regex: `^${TAG}` } });
    const left = await User.countDocuments({ account: { $regex: `^${TAG}` } });
    console.log(`\n清理：残留临时账号 ${left}`);
    if (left) failed += 1;
  }

  await mongoose.disconnect();
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.stack);
  process.exit(1);
});
