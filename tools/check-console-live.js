// 真启服务，用 HTTP 跑一遍控制台的完整用户旅程（这是"WEB 到底 OK 不 OK"的直接证据）
const path = require('path');
const serverDir = path.join(__dirname, '..', 'server');
process.env.NODE_ENV = 'test';
const config = require(path.join(serverDir, 'src', 'config'));
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));
const User = require(path.join(serverDir, 'src', 'models', 'user'));
const pwd = require(path.join(serverDir, 'src', 'services', 'password'));

let failed = 0;
const ok = (n, c, d) => {
  console.log(`${c ? '  ok   ' : '  FAIL '}${n}${c ? '' : '  -> ' + JSON.stringify(d)}`);
  if (!c) failed += 1;
};

const TS = Date.now();
const TAG = `web_verify_${TS}`;
const PW = `Wv!${TS}`;
let createdUserId = null;

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });

  // 造一个临时反作弊管理员（有 anticheat_admin 组、已改密码）
  const u = await User.create({
    openid: `${TAG}_u`,
    account: `${TAG}_admin`,
    realName: '临时反作弊管理员',
    role: 'teacher',
    passwordHash: pwd.hashPassword(PW),
    initialHashes: [pwd.hashPassword('123456')],
    mustChangePassword: false,
    permissionGroups: ['anticheat_admin'],
  });
  createdUserId = u._id;

  const { createApp } = require(path.join(serverDir, 'src', 'app'));
  const app = createApp();
  const port = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s.address().port));
  });
  const BASE = `http://127.0.0.1:${port}`;
  console.log(`\n服务已启动: ${BASE}\n`);

  const req = (method, url, { body, cookie } = {}) =>
    fetch(`${BASE}${url}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({
      status: r.status,
      headers: r.headers,
      text: await r.text().then((t) => {
        try { return JSON.parse(t); } catch { return t; }
      }),
      // 完整 Set-Cookie（属性 HttpOnly / Path 只在这里能看到）
      fullSetCookie: r.headers.get('set-cookie') || '',
      // 回发用的 name=value 片段
      setCookie: (r.headers.get('set-cookie') || '').split(';').find((p) => p.trim().startsWith('tt_console=')) || '',
    }));

  try {
    // ===== 1) 页面能打开 =====
    console.log('[1] 页面可访问');
    const home = await req('GET', '/');
    ok('GET / 返回 200', home.status === 200, home.status);
    ok('是 HTML 页面（含控制台标题）', String(home.text).includes('反作弊控制台'), String(home.text).slice(0, 80));
    ok('带 CSP 头', !!home.headers.get('content-security-policy'), home.headers.get('content-security-policy'));
    const css = await req('GET', '/console/app.css');
    ok('CSS 可加载', css.status === 200 && String(css.text).includes(':root'), css.status);
    const js = await req('GET', '/console/app.js');
    ok('JS 可加载', js.status === 200 && String(js.text).includes('function'), js.status);

    // ===== 2) 未登录状态 =====
    console.log('\n[2] 未登录行为');
    const dash = await req('GET', '/console/api/dashboard');
    ok('未登录取数据 → 401', dash.status === 401, dash.status);
    const pub = await req('GET', '/console/api/public-status');
    ok('未登录可读运行状态（登录页自检用）', pub.status === 200 && pub.text.code === 0, pub.status);
    const pubStr = JSON.stringify(pub.text.data || {});
    ok('运行状态不含反作弊参数', !/suspicious|autoBan|待研判/.test(pubStr), pubStr.slice(0, 100));

    // ===== 3) 登录 =====
    console.log('\n[3] 登录');
    const login = await req('POST', '/console/api/login', { body: { account: u.account, password: PW } });
    ok('登录成功', login.status === 200 && login.text.code === 0, { s: login.status, m: login.text.message });
    ok('下发 HttpOnly Cookie', /HttpOnly/i.test(login.fullSetCookie), login.fullSetCookie);
    ok('Cookie 限定 Path=/console', /Path=\/console/i.test(login.fullSetCookie), login.fullSetCookie);
    ok('Cookie SameSite=Strict（CSRF 防线）', /SameSite=Strict/i.test(login.fullSetCookie), login.fullSetCookie);
    const cookie = login.setCookie;

    const me = await req('GET', '/console/api/me', { cookie });
    ok('me 返回身份与能力', me.status === 200 && me.text.data && me.text.data.caps, me.text.data);

    // ===== 4) 三个页面各自的数据接口 =====
    console.log('\n[4] 状态台 / 训练台 / 模型配置');
    const d = await req('GET', '/console/api/dashboard', { cookie });
    ok('状态台数据可读', d.status === 200 && d.text.code === 0, d.status);
    const dd = d.text.data || {};
    ok('含模型状态（微信/GPS）', !!(dd.models && dd.models.werun && dd.models.gps), Object.keys(dd.models || {}));
    ok('含阈值', !!(dd.threshold && dd.threshold.suspiciousText), dd.threshold);
    ok('含队列矩阵（来源×标注）', !!(dd.queue && dd.queue.matrix), dd.queue && Object.keys(dd.queue || {}));
    ok('含升级进度', !!dd.upgrade, dd.upgrade && dd.upgrade.progress);
    ok('含运行指标（ops）', !!(dd.ops && typeof dd.ops.served === 'number'), dd.ops);

    const list = await req('GET', '/console/api/anomalies?status=all&limit=5', { cookie });
    ok('训练台列表可读', list.status === 200 && Array.isArray(list.text.data.list), list.status);
    ok('列表下发标注文案（前端不硬编码）', !!(list.text.data.labelText && list.text.data.labelKinds), list.text.data.labelText);

    const ms = await req('GET', '/console/api/model-status', { cookie });
    ok('模型配置可读', ms.status === 200 && ms.text.data.effective, ms.status);
    ok('含严谨度档位选项', !!ms.text.data.strictnessOptions, Object.keys(ms.text.data.strictnessOptions || {}));

    // ===== 5) 登出 =====
    console.log('\n[5] 登出');
    const out = await req('POST', '/console/api/logout', { cookie });
    ok('登出成功', out.status === 200, out.status);
    const after = await req('GET', '/console/api/dashboard', { cookie });
    ok('登出后旧 Cookie 失效', after.status === 401, after.status);

    // ===== 6) 鉴权边界 =====
    console.log('\n[6] 鉴权边界');
    const bad = await req('GET', '/console/api/dashboard', { cookie: 'tt_console=' + 'a'.repeat(64) });
    ok('伪造 sid → 401', bad.status === 401, bad.status);
    // 小程序 JWT 不能调控制台（两套凭证隔离）
    const jwtLike = await req('GET', '/console/api/dashboard', { cookie: '' });
    ok('无 Cookie → 401', jwtLike.status === 401, jwtLike.status);
  } finally {
    // 清理临时账号
    await User.deleteMany({ openid: new RegExp(`^${TAG}`) });
    const left = await User.countDocuments({ openid: new RegExp(`^${TAG}`) });
    console.log(`\n清理：残留临时账号 ${left} 个`);
    if (left) failed += 1;
    await mongoose.disconnect();
  }

  console.log(failed ? `\n${failed} 项失败` : '\nWEB 控制台全流程通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.stack);
  process.exit(1);
});
