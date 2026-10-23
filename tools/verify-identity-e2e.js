// 端到端复现 + 验证：设备本地残留**上一个身份**的令牌，启动后必须自愈成「当前微信绑定的账号」
//
// 用户报障（2026-10-22）：「我登录刘恩琦教师账号后，依旧是陈宇航的教师账号。」
// 成因：解绑微信只清了 user.openid，JWT 30 天内仍有效 → 页面一直拿到上一个身份。
//
// ⚠️ 早期版本把刘恩琦 / 陈宇航两个真实账号写死在脚本里 —— 那很脆：
//   真实数据一改（例如用户用「用另一个账号登录」把微信换绑给了陈宇航），测试就会"失败"，
//   但其实应用行为完全正确。现在改成**自建临时账号**：
//     · A 账号 = 当前微信（stub openid）绑定的账号（期望最终身份）
//     · B 账号 = 本地残留旧令牌所属的账号（旧 openid，带 '*' 以便断言"不再是那个身份"）
//   全程不碰真实账号，结束时清理。
//
// 只替换微信换码（wechat.code2session）与小程序运行时（wx.*），路由/中间件/模型全走真实代码，
// 不需要预先启动后端；需要能连上 .env 里的数据库。
//
// 用法：node tools/verify-identity-e2e.js
const path = require('path');
const serverDir = path.join(__dirname, '..', 'server');
const config = require(path.join(serverDir, 'src', 'config'));
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));
const express = require(path.join(serverDir, 'node_modules', 'express'));
const jwt = require(path.join(serverDir, 'node_modules', 'jsonwebtoken'));

const User = require(path.join(serverDir, 'src', 'models', 'user'));

const TAG = `identity_verify_${Date.now()}`;
const OPENID_CURRENT = `${TAG}_wx_cur`; // 当前微信
const OPENID_OLD = `${TAG}_wx_old`; // 旧微信（本地残留令牌用的）

let failed = 0;
function assert(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ← ' + JSON.stringify(extra)}`);
  if (!cond) failed += 1;
}

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });

  // 临时账号：A = 当前微信绑定（教师），B = 旧令牌所属（另一个教师，带 * 以证明"不再是那个身份"）
  const userA = await User.create({
    openid: OPENID_CURRENT,
    account: `${TAG}_A`,
    realName: `${TAG}_A`,
    role: 'teacher',
    permissionGroups: ['teacher'],
    mustChangePassword: false,
  });
  const userB = await User.create({
    openid: OPENID_OLD,
    account: `${TAG}_B`,
    realName: `${TAG}_B`,
    role: 'teacher',
    permissionGroups: ['superadmin'],
    mustChangePassword: false,
  });

  // 复现「解绑微信后旧令牌仍然有效」：B 先绑过 OPENID_OLD，随后被解绑（openid 清空），
  // 但本地还留着它解绑前签发的令牌 —— 旧实现会让这台设备一直以 B 的身份访问。
  await User.updateOne({ _id: userB._id }, { $unset: { openid: 1, openidBoundAt: 1 } });

  // ---- 1) 起一个只含认证相关路由的真实服务（微信换码打桩 → A 的 openid） ----
  const wechat = require(path.join(serverDir, 'src', 'services', 'wechat'));
  wechat.code2session = async () => ({ openid: OPENID_CURRENT, session_key: 'sk' });

  const authRouter = require(path.join(serverDir, 'src', 'routes', 'auth'));
  const { auth } = require(path.join(serverDir, 'src', 'middlewares', 'auth'));
  const server = express();
  server.use(express.json());
  server.use('/api/auth', authRouter);
  server.get('/api/ping', auth, (req, res) => res.json({ code: 0, data: { account: req.user.account } }));
  // eslint-disable-next-line no-unused-vars
  server.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code || 500, message: err.message }));

  const port = await new Promise((resolve) => {
    const s = server.listen(0, () => resolve(s.address().port));
  });
  const BASE = `http://127.0.0.1:${port}`;

  // ---- 2) 小程序运行时打桩：本地已残留 B 的旧令牌 ----
  const storage = new Map();
  const staleToken = jwt.sign(
    { uid: String(userB._id), openid: OPENID_OLD, role: 'teacher' },
    config.jwtSecret,
    { expiresIn: '30d' }
  );
  storage.set('tt_token', staleToken);
  storage.set('tt_bound', '1');
  storage.set('tt_user', {
    _id: String(userB._id),
    account: `${TAG}_B`,
    realName: `${TAG}_B`,
    role: 'teacher',
    effectivePermissions: ['*'],
  });
  let loginCalls = 0;

  global.wx = {
    getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
    login: ({ success }) => {
      loginCalls += 1;
      success({ code: 'stub-code' });
    },
    request: ({ url, method = 'GET', data, header = {}, success, fail }) => {
      const u = url.replace(/^https?:\/\/[^/]+/, '');
      fetch(`${BASE}${u}`, {
        method,
        headers: { 'content-type': 'application/json', ...header },
        body: method === 'GET' ? undefined : JSON.stringify(data || {}),
      })
        .then(async (r) => success({ statusCode: r.status, data: await r.json().catch(() => ({})) }))
        .catch((e) => fail({ errMsg: String(e.message) }));
    },
    showToast: () => {},
    showModal: () => {},
    reLaunch: () => {},
    switchTab: () => {},
    navigateTo: () => {},
    hideHomeButton: () => {},
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  };
  global.getCurrentPages = () => [];
  let appObj = null;
  global.App = (o) => {
    appObj = o;
  };
  global.getApp = () => appObj;

  // ---- 3) 加载真实的小程序 app.js ----
  // eslint-disable-next-line global-require
  const authSdk = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'request'));
  authSdk.env.BASE_URL = BASE; // 指向上面的打桩服务
  // eslint-disable-next-line global-require
  require(path.join(__dirname, '..', 'miniprogram', 'app.js'));

  // ---- 4) 旧令牌本身必须被服务端拒掉（越权防线） ----
  const stale = await fetch(`${BASE}/api/ping`, { headers: { Authorization: `Bearer ${staleToken}` } });
  assert(stale.status === 401, '已解绑账号的旧令牌访问业务接口 → 401（不能再以旧身份进后台）', stale.status);

  // ---- 5) 启动：ensureLogin 确认身份并自愈到「令牌真正对应的账号」 ----
  //
  // 说明（2026-10-23 变更）：旧令牌现在由服务端判 401，request() 随后**自动重登**
  // （完整 /api/auth/login → 签发新的 deviceToken），所以这一步会 +1 条 login_devices。
  // 这是重登的正常代价，不是「挤掉历史记录」——真正的挤占是每次启动都签发（旧 silent 实现
  // 反而要额外加开关去避免）。下面 6) 断言「同一启动周期不会再签发」。
  const devRowsBefore = await mongoose.connection.db.collection('login_devices').countDocuments({});
  appObj.onLaunch();
  const user = await appObj.ensureLogin();

  assert(!!user, 'ensureLogin 返回了用户信息', user);
  assert(user && user.account === `${TAG}_A`, '启动后身份 = 令牌重登后的账号（不是本地残留的旧身份）', user && user.account);
  assert(user && user.role === 'teacher', '角色 = teacher', user && user.role);
  assert(
    user && !(user.effectivePermissions || []).includes('*'),
    '不再是旧身份（B 的 superadmin）的权限（没有 *）',
    user && user.effectivePermissions
  );

  const stored = storage.get('tt_user') || {};
  assert(stored.account === `${TAG}_A`, '本地存储 tt_user 已被覆盖为当前账号', stored.account);

  const newToken = storage.get('tt_token');
  const payload = jwt.decode(newToken) || {};
  assert(String(payload.uid) === String(userA._id), '本地 token 已换成当前账号（uid 正确）', payload.uid);
  assert(String(payload.openid) === OPENID_CURRENT, '新 token 的 openid = 当前微信', payload.openid);
  assert(loginCalls === 1, '启动只做了一次身份确认（不重复打 wx.login）', loginCalls);
  assert(storage.get('tt_token') !== staleToken, '旧 token 确实被替换掉了', true);

  // ---- 6) 第二次 ensureLogin 不应再确认/签发（同一启动周期只做一次） ----
  const devRowsMid = await mongoose.connection.db.collection('login_devices').countDocuments({});
  await appObj.ensureLogin();
  assert(loginCalls === 1, '同一启动周期内再次 ensureLogin 不再重复确认', loginCalls);

  const devRowsAfter = await mongoose.connection.db.collection('login_devices').countDocuments({});
  assert(devRowsMid === devRowsAfter, '同一启动周期内不会重复签发设备令牌（不会持续挤掉历史记录）', {
    devRowsMid,
    devRowsAfter,
  });
  // 首次确认时因为旧令牌已失效会走一次自动重登 → 允许 +1，但绝不该出现「每次启动都 +N」
  assert(devRowsAfter - devRowsBefore <= 1, '启动最多只新增 1 条设备令牌（旧令牌失效后重登一次）', {
    devRowsBefore,
    devRowsAfter,
  });

  // ---- 7) 清理临时账号 ----
  await User.deleteMany({ account: { $regex: `^${TAG}` } });
  const left = await User.countDocuments({ account: { $regex: `^${TAG}` } });
  console.log(`\n清理：残留临时账号 ${left}`);
  if (left) failed += 1;

  await mongoose.disconnect();
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.stack);
  process.exit(1);
});
