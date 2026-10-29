// 端到端验证：Web 控制台（/console）的登录闸门 + 标注/封禁权限分离 + 四分类标注
//
// 用户 2026-10-29 需求：
//   「AI 反作弊中的标注要能分开…支持分类…后端的状态中要支持登录，进入后有状态台与
//    AI 反作弊标注…需要独立权限组」，并确认「标注与封禁分开」。
//
// 这个脚本**不打桩 auth**（控制台的登录态是它自己要被验证的东西），
// 而是真发 HTTP 请求走完整 Cookie 链路：登录 → 拿 me → 调接口 → 断言。
// 临时账号跑完即删，并核对残留为 0。
//
// 用法：node tools/verify-console.js
// 需要能连上 .env 里的数据库；不需要另外启动后端。
const path = require('path');
const serverDir = path.join(__dirname, '..', 'server');
const config = require(path.join(serverDir, 'src', 'config'));
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));

const User = require(path.join(serverDir, 'src', 'models', 'user'));
const StepAnomaly = require(path.join(serverDir, 'src', 'models', 'step-anomaly'));
const StepLabel = require(path.join(serverDir, 'src', 'models', 'step-label'));
const BanRecord = require(path.join(serverDir, 'src', 'models', 'ban-record'));
const PermissionGroup = require(path.join(serverDir, 'src', 'models', 'permission-group'));
const pwd = require(path.join(serverDir, 'src', 'services', 'password'));
const session = require(path.join(serverDir, 'src', 'services', 'console-session'));
const disposal = require(path.join(serverDir, 'src', 'services', 'anomaly-disposal'));
const anticheatSvc = require(path.join(serverDir, 'src', 'services', 'anticheat'));

let failed = 0;
function assert(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ← ' + JSON.stringify(extra)}`);
  if (!cond) failed += 1;
}

const TS = Date.now();
const TMP_TAG = `console_verify_${TS}`;
// 强密码：绝不能在 initialHashes / resetHashes 里，否则会被「初始密码闸门」拒（那是另一条用例）
const STRONG_PW = `Cv!${TS}`;

const created = { users: [], anomalies: [], labels: [], bans: [] };
// 真实 GoalConfig 的备份（finally 里要恢复，所以必须声明在 try 外层）
let acBackup = null;

/** 从响应头里取会话 Cookie 的值（只看我们自己那个） */
function cookieOf(res) {
  const raw = res.headers.get('set-cookie') || '';
  const hit = String(raw).split(';').find((p) => p.trim().startsWith(`${session.COOKIE_NAME}=`));
  return hit ? hit.trim() : '';
}
/** 完整 Set-Cookie 头（HttpOnly / SameSite 这些属性只在这里能看到，
 *  cookieOf 返回的是要回发的 name=value，属性本就被剥掉 —— 断言属性必须用这个） */
function setCookieHeader(res) {
  return String(res.headers.get('set-cookie') || '');
}

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });

  // ---- 0) 起真实 app（完整中间件 + 全部路由）----
  process.env.NODE_ENV = 'test'; // 关掉 morgan，输出干净
  const { createApp } = require(path.join(serverDir, 'src', 'app'));
  const app = createApp();
  const port = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s.address().port));
  });
  const BASE = `http://127.0.0.1:${port}`;

  const req = (method, url, { body, cookie } = {}) =>
    fetch(`${BASE}${url}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({
      status: r.status,
      data: await r.json().catch(() => ({})),
      cookie: cookieOf(r),
      setCookie: setCookieHeader(r),
    }));

  try {
    // ==================== 1) 权限项与两个独立权限组 ====================
    console.log('\n[1] 独立权限组');
    // 只播种**这两个新组**（幂等 upsert），不调 seedRbac()：
    // 后者会跑 migrateExistingAccounts()，在真实库上重算 1500+ 用户的 scrypt 哈希
    // （约 1 分钟）并重写全表 —— 验证脚本不该有这种副作用。
    const groupsToSeed = PermissionGroup.DEFAULT_GROUPS.filter((g) => g.key.startsWith('anticheat_'));
    assert(groupsToSeed.length === 2, 'DEFAULT_GROUPS 含两个反作弊组', groupsToSeed.map((g) => g.key));
    for (const g of groupsToSeed) {
      await PermissionGroup.updateOne(
        { key: g.key },
        { $set: { name: g.name, permissions: g.permissions, description: g.description, builtIn: true } },
        { upsert: true }
      );
    }
    const analyst = await PermissionGroup.findOne({ key: 'anticheat_analyst' }).lean();
    const adminGrp = await PermissionGroup.findOne({ key: 'anticheat_admin' }).lean();
    assert(!!analyst && !!adminGrp, '两个内置反作弊权限组已播种');
    assert(
      analyst && analyst.permissions.includes('anticheat.label') && !analyst.permissions.includes('anticheat.ban'),
      '研判员组：有 label、无 ban',
      analyst && analyst.permissions
    );
    assert(
      adminGrp && adminGrp.permissions.includes('anticheat.ban') && adminGrp.permissions.includes('anticheat.manage'),
      '管理员组：label + ban + manage 齐',
      adminGrp && adminGrp.permissions
    );

    // ==================== 2) 造临时账号 ====================
    console.log('\n[2] 临时账号');
    // A：研判员（能标注，不能封禁）—— 已改过密码
    const analystUser = await User.create({
      openid: `${TMP_TAG}_analyst`,
      account: `${TMP_TAG}_A`,
      realName: `${TMP_TAG}_A`,
      role: 'teacher',
      passwordHash: pwd.hashPassword(STRONG_PW),
      initialHashes: [pwd.hashPassword('123456')],
      resetHashes: [pwd.hashPassword('123456')],
      mustChangePassword: false,
      permissionGroups: ['anticheat_analyst'],
    });
    // B：反作弊管理员
    const adminUser = await User.create({
      openid: `${TMP_TAG}_admin`,
      account: `${TMP_TAG}_B`,
      realName: `${TMP_TAG}_B`,
      role: 'teacher',
      passwordHash: pwd.hashPassword(STRONG_PW),
      initialHashes: [pwd.hashPassword('123456')],
      resetHashes: [pwd.hashPassword('123456')],
      mustChangePassword: false,
      permissionGroups: ['anticheat_admin'],
    });
    // C：只有教师管理组（无任何 anticheat 权限）
    const plainUser = await User.create({
      openid: `${TMP_TAG}_plain`,
      account: `${TMP_TAG}_C`,
      realName: `${TMP_TAG}_C`,
      role: 'teacher',
      passwordHash: pwd.hashPassword(STRONG_PW),
      initialHashes: [pwd.hashPassword('123456')],
      mustChangePassword: false,
      permissionGroups: ['teacher'],
    });
    // D：有权限但**仍是初始密码**（验证第三道闸门）
    const initPwUser = await User.create({
      openid: `${TMP_TAG}_init`,
      account: `${TMP_TAG}_D`,
      realName: `${TMP_TAG}_D`,
      role: 'teacher',
      passwordHash: pwd.hashPassword('123456'),
      initialHashes: [pwd.hashPassword('123456')],
      resetHashes: [pwd.hashPassword('123456')],
      mustChangePassword: true,
      permissionGroups: ['anticheat_admin'],
    });
    // 目标学生（异常记录挂在他身上）
    const student = await User.create({
      openid: `${TMP_TAG}_stu`,
      account: `${TMP_TAG}_S`,
      realName: `${TMP_TAG}_S`,
      role: 'student',
      className: `${TMP_TAG}_班`,
      studentId: `2${String(TS).slice(1, 8)}`,
      passwordHash: pwd.hashPassword('12345678'),
      initialHashes: [pwd.hashPassword('12345678')],
    });
    created.users.push(analystUser._id, adminUser._id, plainUser._id, initPwUser._id, student._id);

    // 有效权限应自动展开内置组
    const aPerms = await analystUser.getEffectivePermissions();
    assert(aPerms.includes('anticheat.label') && aPerms.includes('anticheat.view'), '研判员有效权限含 label/view', aPerms);
    assert(!aPerms.includes('anticheat.ban'), '研判员有效权限不含 ban', aPerms);

    // ==================== 3) 公开状态接口：不给反作弊参数 ====================
    console.log('\n[3] 根路径与控制台入口');
    const home = await fetch(`${BASE}/`);
    const homeText = await home.text();
    assert(home.status === 200 && /反作弊控制台/.test(homeText), 'GET / 返回控制台页面');
    const csp = home.headers.get('content-security-policy') || '';
    assert(/script-src 'self'/.test(csp) && !/unsafe-inline/.test(csp), "CSP 放行 'self' 且不含 unsafe-inline", csp);
    assert((home.headers.get('x-frame-options') || '').toUpperCase() === 'DENY', 'X-Frame-Options=DENY');
    const chome = await fetch(`${BASE}/console`);
    assert(chome.status === 200, 'GET /console 同页可访问', chome.status);
    const cssRes = await fetch(`${BASE}/console/app.css`);
    assert(cssRes.status === 200, '静态 app.css 可加载（外链，供 CSP style-src self）');
    const jsRes = await fetch(`${BASE}/console/app.js`);
    assert(jsRes.status === 200, '静态 app.js 可加载');

    const pub = await req('GET', '/console/api/public-status');
    assert(pub.status === 200 && pub.data.code === 0, '未登录可读 public-status');
    const pubJson = JSON.stringify(pub.data.data || {});
    assert(
      !/suspicious|autoBan|待研判|threshold/i.test(pubJson),
      'public-status **不含** AI 阈值与待研判数（防教人绕过硬禁）',
      pubJson.slice(0, 220)
    );

    // ==================== 4) 登录闸门 ====================
    console.log('\n[4] 登录三道门');
    const badPw = await req('POST', '/console/api/login', { body: { account: analystUser.account, password: 'wrong-pw' } });
    assert(badPw.status === 400, '错误密码 → 400', badPw);

    const noPerm = await req('POST', '/console/api/login', { body: { account: plainUser.account, password: STRONG_PW } });
    assert(noPerm.status === 403 && /权限/.test(noPerm.data.message || ''), '有密码但无反作弊权限 → 403', noPerm.data);

    const initGate = await req('POST', '/console/api/login', { body: { account: initPwUser.account, password: '123456' } });
    assert(
      initGate.status === 403 && /初始密码/.test(initGate.data.message || ''),
      '用初始密码 123456 登录 → 拒绝（第三道闸门）',
      initGate.data
    );

    const okLogin = await req('POST', '/console/api/login', { body: { account: analystUser.account, password: STRONG_PW } });
    assert(okLogin.status === 200 && okLogin.data.code === 0, '研判员改过密码后可登录', okLogin.data);
    assert(
      /HttpOnly/.test(okLogin.setCookie) && /SameSite=Strict/.test(okLogin.setCookie),
      '会话 Cookie 是 HttpOnly + SameSite=Strict',
      okLogin.setCookie
    );
    assert(/Path=\/console/.test(okLogin.setCookie), 'Cookie 限定 Path=/console（不给全站带上会话凭证）', okLogin.setCookie);
    const analystCookie = okLogin.cookie;

    const meA = await req('GET', '/console/api/me', { cookie: analystCookie });
    assert(meA.data.data && meA.data.data.caps.label === true && meA.data.data.caps.ban === false, 'me 的能力表：可标注、不可封禁', meA.data.data && meA.data.data.caps);

    const adminLogin = await req('POST', '/console/api/login', { body: { account: adminUser.account, password: STRONG_PW } });
    const adminCookie = adminLogin.cookie;
    assert(adminLogin.status === 200 && !!adminCookie, '反作弊管理员可登录');

    const anon = await req('GET', '/console/api/dashboard');
    assert(anon.status === 401, '未登录取 dashboard → 401', anon.status);

    // ==================== 5) 四分类标注 ====================
    console.log('\n[5] 标注四分类（device 不进训练集）');
    const mkAnomaly = async (label, source) => {
      const rec = await StepAnomaly.create({
        userId: student._id,
        openid: student.openid,
        realName: student.realName,
        className: student.className,
        studentId: student.studentId,
        date: new Date().toISOString().slice(0, 10),
        source,
        cumulativeSteps: 66666,
        deltaSteps: 3000,
        score: 72,
        reasons: [`重复数字 66666`, source === 'gps' ? '配速异常' : '同步增速 12.0 步/秒'],
        status: 'open',
        modelScore: 0.81,
        features: { steps: 66666, ruleHits: 2, ruleMax: 0.9 },
      });
      created.anomalies.push(rec._id);
      return rec;
    };

    const recA = await mkAnomaly(null, 'werun');
    const lb = await req('POST', `/console/api/anomalies/${recA._id}/label`, {
      cookie: analystCookie,
      body: { label: 'device', note: '手机放桌上被补同步' },
    });
    assert(lb.status === 200 && lb.data.code === 0, '研判员标注 device → 200', lb.data);
    assert(lb.data.data.trainable === false, 'device 标注回 trainable=false（不进训练集）', lb.data.data);
    assert(lb.data.data.status === 'dismissed', 'device 自动移出待研判队列', lb.data.data.status);

    const savedLabel = await StepLabel.findOne({ anomalyId: recA._id }).lean();
    created.labels.push(savedLabel && savedLabel._id);
    assert(savedLabel && savedLabel.label === 'device', 'step_labels 落了 label=device', savedLabel && savedLabel.label);
    assert(savedLabel && savedLabel.isCheat === false, 'device 的兼容字段 isCheat=false', savedLabel && savedLabel.isCheat);

    // 改判：同一条从 device 改成 cheat
    const recB = await mkAnomaly(null, 'gps');
    await req('POST', `/console/api/anomalies/${recB._id}/label`, { cookie: analystCookie, body: { label: 'normal' } });
    const rev = await req('POST', `/console/api/anomalies/${recB._id}/label`, { cookie: analystCookie, body: { label: 'cheat' } });
    assert(rev.status === 200, '改判（normal → cheat）→ 200', rev.data);
    const labelB = await StepLabel.findOne({ anomalyId: recB._id }).lean();
    created.labels.push(labelB && labelB._id);
    assert(labelB && labelB.label === 'cheat' && labelB.isCheat === true, '改判后落库为 cheat', labelB && { l: labelB.label, c: labelB.isCheat });
    assert(labelB && labelB.revision >= 2, `改判不是新增重复样本（revision=${labelB && labelB.revision}）`);
    const dupCount = await StepLabel.countDocuments({ anomalyId: recB._id });
    assert(dupCount === 1, '一条异常只有一条标注（改判是 update 不是 insert）', dupCount);

    // 非法 label
    const recC = await mkAnomaly(null, 'werun');
    const badLabel = await req('POST', `/console/api/anomalies/${recC._id}/label`, { cookie: analystCookie, body: { label: 'maybe' } });
    assert(badLabel.status === 400, '非法 label → 400', badLabel.status);

    // minor 也可标
    const minorRes = await req('POST', `/console/api/anomalies/${recC._id}/label`, { cookie: analystCookie, body: { label: 'minor' } });
    assert(minorRes.status === 200 && minorRes.data.data.trainable === true, '标注 minor → 200 且可训练', minorRes.data.data);

    // ==================== 6) 标注与封禁权限分离 ====================
    console.log('\n[6] 标注 / 封禁 权限分离');
    const recD = await mkAnomaly(null, 'werun');
    const analystBan = await req('POST', `/console/api/anomalies/${recD._id}/ban`, { cookie: analystCookie, body: { days: 3 } });
    assert(analystBan.status === 403, '研判员封禁 → 403（无 anticheat.ban）', analystBan.status);
    const stillOpen = await StepAnomaly.findById(recD._id).lean();
    assert(stillOpen && stillOpen.status === 'open', '被拒的封禁没有改动记录状态', stillOpen && stillOpen.status);

    const adminBan = await req('POST', `/console/api/anomalies/${recD._id}/ban`, { cookie: adminCookie, body: { days: 3, note: '验证用' } });
    created.bans.push(student._id);
    assert(adminBan.status === 200 && adminBan.data.data.banned === true, '管理员封禁 → 200', adminBan.data);
    assert(adminBan.data.data.days === 3, '封禁天数按传入值', adminBan.data.data.days);

    const afterBan = await StepAnomaly.findById(recD._id).lean();
    assert(afterBan.status === 'banned' && afterBan.label === 'cheat', '封禁隐含标注 cheat（认知线与处置线都落）', { s: afterBan.status, l: afterBan.label });
    const labelD = await StepLabel.findOne({ anomalyId: recD._id }).lean();
    created.labels.push(labelD && labelD._id);
    assert(labelD && labelD.label === 'cheat', '封禁产生的标注落 step_labels（进训练集）', labelD && labelD.label);
    // ⚠️ 异常记录里的封禁是 scope='sync'（限制微信同步），**不是**限制登录，
    // 所以 user.status 仍是 active —— 断言要看 restrictions.sync，而不是 status=banned。
    const stu2 = await User.findById(student._id).lean();
    const syncR = (stu2.restrictions || {}).sync || {};
    assert(syncR.until && new Date(syncR.until) > new Date(), '限制微信同步已落库（restrictions.sync.until 在未来）', syncR);
    assert(stu2.status !== 'banned', 'scope=sync 不会把账号整体置为 banned（只限同步）', stu2.status);
    // 解封，避免临时学生带着限制被删（也验证 lift 路径可用）
    await anticheatSvc.manualUnban(await User.findById(student._id), 'verify', 'sync');

    // device 已标的记录被封禁时不应被覆盖成 cheat
    const recE = await mkAnomaly(null, 'werun');
    await req('POST', `/console/api/anomalies/${recE._id}/label`, { cookie: analystCookie, body: { label: 'device' } });
    const banDevice = await req('POST', `/console/api/anomalies/${recE._id}/ban`, { cookie: adminCookie, body: { days: 1 } });
    const afterE = await StepAnomaly.findById(recE._id).lean();
    assert(banDevice.status === 200 && afterE.label === 'device', '已标 device 的记录被处置时不覆盖成 cheat', afterE.label);
    const labelE = await StepLabel.findOne({ anomalyId: recE._id }).lean();
    created.labels.push(labelE && labelE._id);
    assert(labelE && labelE.label === 'device', '训练集里这条仍是 device（不被污染）', labelE && labelE.label);

    // ==================== 7) 队列矩阵：标注要能分开 ====================
    console.log('\n[7] 列表与状态台按 来源×标注 分开');
    const listRes = await req('GET', '/console/api/anomalies?status=all&limit=100', { cookie: analystCookie });
    assert(listRes.status === 200 && Array.isArray(listRes.data.data.list), '列表可读', listRes.status);
    const onlyDevice = await req('GET', '/console/api/anomalies?status=all&label=device&limit=50', { cookie: analystCookie });
    const devRows = (onlyDevice.data.data.list || []).filter((x) => x.id !== 'undefined');
    assert(onlyDevice.status === 200 && devRows.every((x) => x.label === 'device'), 'label=device 筛选只回 device 行', devRows.map((x) => x.label));
    const werunOnly = await req('GET', '/console/api/anomalies?status=all&source=werun&limit=50', { cookie: analystCookie });
    assert((werunOnly.data.data.list || []).every((x) => x.source === 'werun'), 'source=werun 筛选生效', (werunOnly.data.data.list || []).map((x) => x.source));

    const dash = await req('GET', '/console/api/dashboard', { cookie: analystCookie });
    assert(dash.status === 200 && dash.data.code === 0, '状态台可读', dash.status);
    const mtx = (dash.data.data.queue || {}).matrix || {};
    assert(!!(mtx.werun && mtx.gps), '矩阵含两个来源', Object.keys(mtx));
    assert(
      mtx.werun && ['unlabeled', 'cheat', 'minor', 'device', 'normal'].every((k) => typeof mtx.werun[k] === 'number'),
      '矩阵每个来源都有 未标注 + 四类 的计数',
      mtx.werun
    );
    const upg = dash.data.data.upgrade || {};
    assert(upg.perClass && upg.perClass.device !== undefined, '升级统计含 device 单列', upg.perClass);
    assert(upg.total === (upg.perClass.cheat || 0) + (upg.perClass.minor || 0) + (upg.perClass.normal || 0), 'total 不含 device（device 不进训练集）', upg);

    // ==================== 8) 模型配置 ====================
    console.log('\n[8] 模型配置');
    // ⚠️ 设计（本脚本自己踩出来的教训）：goal_config 是**全局单例**，真去写它就存在
    //   「测试中途被杀 → 生产留脏值」的风险（第一次运行确实发生过：备份变量取不到，
    //   把 custom 的 0.8/0.82 留在了线上库，后来手工清掉）。
    //   所以本节的策略是：
    //     · 「改了会变成什么」这类**变更语义** → 纯函数在内存对象上断言，完全不写库；
    //     · live 端点只验「鉴权 + 真拒绝 + 空 body 拒绝」，全是读操作或被拒的写。
    //   acBackup 仍做整份快照，作为「万一写脏了」的兜底恢复（理论上不该再被触发）。
    const GoalConfig = require(path.join(serverDir, 'src', 'models', 'goal-config'));
    const cfgDoc = await GoalConfig.getSingleton();
    acBackup = JSON.parse(JSON.stringify(cfgDoc.anticheat || {}));

    const st = await req('GET', '/console/api/model-status', { cookie: analystCookie });
    assert(st.status === 200 && st.data.data.effective, '研判员可读 model-status', st.status);
    const putByAnalyst = await req('PUT', '/console/api/model-config', { cookie: analystCookie, body: { enabled: false } });
    assert(putByAnalyst.status === 403, '研判员改配置 → 403（无 manage）', putByAnalyst.status);
    const stAfterDeny = await GoalConfig.getSingleton();
    assert(
      (stAfterDeny.anticheat || {}).enabled === (acBackup.enabled !== false),
      '被拒的写请求没有改动配置（403 是真拒绝，不是先写后报错）',
      (stAfterDeny.anticheat || {}).enabled
    );

    // 变更语义（非法回落 / 阈值夹紧 / autoBan≥susp+0.02 / 只改档位不动开关）
    // 全部用**纯函数在内存对象上**断言，绝不写 goal_config 单例（见下面第 8 节说明）。
    const acConfigSvc = require(path.join(serverDir, 'src', 'services', 'anticheat-config'));
    const fakeAc = () => ({
      anticheat: {
        maxStepJumpPerSync: 30000,
        minPaceSecondsPerKm: 120,
        banDays: 7,
        enabled: true,
        aiStrictness: 'balanced',
        aiSuspiciousThreshold: 0.62,
        aiAutoBanThreshold: 0.78,
      },
    });
    {
      const doc = fakeAc();
      acConfigSvc.applyAnticheatInput(doc, { aiStrictness: 'yolo' });
      assert(doc.anticheat.aiStrictness === 'balanced', '非法档位名回落 balanced（纯函数，不写库）', doc.anticheat.aiStrictness);
    }
    {
      const doc = fakeAc();
      acConfigSvc.applyAnticheatInput(doc, { aiStrictness: 'custom', aiSuspiciousThreshold: 0.8, aiAutoBanThreshold: 0.5 });
      assert(
        Number(doc.anticheat.aiAutoBanThreshold) >= Number(doc.anticheat.aiSuspiciousThreshold) + 0.02 - 1e-9,
        '自动封禁线被抬到「可疑线 + 0.02」以上（否则一到可疑就封，取消人工研判档）',
        doc.anticheat
      );
    }
    {
      const doc = fakeAc();
      acConfigSvc.applyAnticheatInput(doc, { aiSuspiciousThreshold: 5 });
      assert(Number(doc.anticheat.aiSuspiciousThreshold) <= 0.95, '可疑线上界夹紧 0.95', doc.anticheat.aiSuspiciousThreshold);
      acConfigSvc.applyAnticheatInput(doc, { aiSuspiciousThreshold: 0.01 });
      assert(Number(doc.anticheat.aiSuspiciousThreshold) >= 0.3, '可疑线下界夹紧 0.3', doc.anticheat.aiSuspiciousThreshold);
    }
    {
      // 回归：旧实现无条件写 `enabled = input.enabled !== false`，
      // 只改阈值会把「运维刻意关掉的自动封禁」悄悄打开。
      const doc = fakeAc();
      doc.anticheat.enabled = false;
      acConfigSvc.applyAnticheatInput(doc, { aiStrictness: 'strict' });
      assert(doc.anticheat.enabled === false, '只改档位不会顺带打开自动封禁开关', doc.anticheat.enabled);
    }
    {
      const r = acConfigSvc.applyAnticheatInput(fakeAc(), {});
      assert(Object.keys(r.changed).length === 0, '空输入无字段变化（live 层据此回 400）', r.changed);
    }

    // live：空 body → 400（读操作，不写库）
    const emptyPut = await req('PUT', '/console/api/model-config', { cookie: adminCookie, body: {} });
    assert(emptyPut.status === 400, '空 body → 400（不静默成功）', emptyPut.status);

    // live 幂等往返：把**当前值**原样 PUT 回去 → 走通「鉴权→钳位→save→清缓存→warm→审计日志」
    // 全链路，但净效果为 0（写回的就是它自己的现值）。比纯函数多了「真的接上了数据库与缓存」。
    const cur = (await req('GET', '/console/api/model-status', { cookie: adminCookie })).data.data;
    const round = await req('PUT', '/console/api/model-config', {
      cookie: adminCookie,
      body: {
        aiStrictness: cur.aiStrictness,
        aiSuspiciousThreshold: cur.aiSuspiciousThreshold,
        aiAutoBanThreshold: cur.aiAutoBanThreshold,
        enabled: cur.enabled,
      },
    });
    assert(round.status === 200 && round.data.data.effective, '管理员 PUT（幂等往返）→ 200 且回生效阈值', round.status);
    const afterRound = (await GoalConfig.getSingleton()).anticheat || {};
    assert(
      afterRound.aiStrictness === cur.aiStrictness,
      '幂等往返不改变档位',
      { was: cur.aiStrictness, now: afterRound.aiStrictness }
    );
    const sameNum = (a, b) => a == null || b == null ? a === b : Math.abs(Number(a) - Number(b)) < 1e-6;
    assert(
      sameNum(afterRound.aiSuspiciousThreshold, cur.aiSuspiciousThreshold) &&
        sameNum(afterRound.aiAutoBanThreshold, cur.aiAutoBanThreshold),
      '幂等往返后阈值不变（不污染生产配置）',
      { was: [cur.aiSuspiciousThreshold, cur.aiAutoBanThreshold], now: [afterRound.aiSuspiciousThreshold, afterRound.aiAutoBanThreshold] }
    );

    // ==================== 9) 限流：不能锁死学生的小程序登录 ====================
    console.log('\n[9] 控制台限流与学生隔离');
    session._reset();
    let blocked = false;
    for (let i = 0; i < 8; i += 1) {
      const r = await req('POST', '/console/api/login', { body: { account: `${TMP_TAG}_A`, password: 'nope' } });
      if (r.status === 429) { blocked = true; break; }
    }
    assert(blocked, '控制台连错多次 → 429 限流');
    const stuRow = await User.findById(student._id).lean();
    const analystRow = await User.findById(analystUser._id).lean();
    assert(
      !analystRow.lockUntil || analystRow.lockUntil <= new Date(),
      '控制台失败**不写** user.lockUntil（不会把人的小程序登录也锁死）',
      analystRow.lockUntil
    );
    void stuRow;
    session._reset();
    const afterLimit = await req('POST', '/console/api/login', { body: { account: analystUser.account, password: STRONG_PW } });
    assert(afterLimit.status === 200, '限流窗口重置后仍可正常登录', afterLimit.status);

    // ==================== 10) 退出登录吊销会话 ====================
    console.log('\n[10] 退出与会话吊销');
    const out = await req('POST', '/console/api/logout', { cookie: afterLimit.cookie });
    assert(out.status === 200, 'logout → 200');
    const afterOut = await req('GET', '/console/api/dashboard', { cookie: afterLimit.cookie });
    assert(afterOut.status === 401, 'logout 后旧 Cookie 立刻失效', afterOut.status);

    // 小程序 JWT 打不动控制台接口（两套凭证隔离）
    const jwtLike = await req('GET', '/console/api/dashboard', { cookie: 'tt_console=deadbeef' });
    assert(jwtLike.status === 401, '伪造 sid → 401');

    // ==================== 11) 旧小程序管理端接口仍守权限 ====================
    console.log('\n[11] 管理端接口权限（本次顺带补的守卫）');
    const anonAdminList = await fetch(`${BASE}/api/admin/step-anomalies`);
    assert(anonAdminList.status === 401, '未登录调管理端异常列表 → 401（旧实现无任何守卫）', anonAdminList.status);

    // service 层唯一实现：控制台与管理端调的是同一份 disposal
    const fnSrc = require('fs').readFileSync(path.join(serverDir, 'src', 'routes', 'admin', 'step-anomalies.js'), 'utf8');
    assert(/anomaly-disposal/.test(fnSrc) && !/recordFeedback/.test(fnSrc), '管理端路由复用 disposal（不再有第二份训练集写入）');
    void disposal;
  } finally {
    // ---- 恢复真实配置：逐字段回到备份值（包括把备份里没有的键删掉）----
    // acBackup 为 null 说明第 8 节还没跑到（没改过任何配置），这时**绝不能**
    // 把 anticheat 覆盖成空对象 —— 那等于清空生产配置。
    if (acBackup) {
      try {
        const GoalConfig2 = require(path.join(serverDir, 'src', 'models', 'goal-config'));
        const doc = await GoalConfig2.getSingleton();
        const keys = new Set([...Object.keys(doc.anticheat || {}), ...Object.keys(acBackup)]);
        const restored = {};
        for (const k of keys) {
          if (Object.prototype.hasOwnProperty.call(acBackup, k)) restored[k] = acBackup[k];
        }
        doc.anticheat = restored;
        await doc.save();
        const check = await GoalConfig2.getSingleton();
        const same = JSON.stringify(check.anticheat || {}) === JSON.stringify(restored);
        console.log(`\n恢复 goal_config.anticheat：${same ? '成功 ✓' : '✗ 与备份不一致'} → ${JSON.stringify(check.anticheat || {})}`);
        if (!same) failed += 1;
      } catch (e) {
        console.log('\n✗ 恢复 goal_config.anticheat 失败（需要手工检查）：' + e.message);
        failed += 1;
      }
    } else {
      console.log('\n（未改动 goal_config.anticheat，无需恢复）');
    }

    // ---- 清理：临时数据一条不留 ----
    // ⚠️ 绝不能在 finally 里引用 try 块内的 const（student 等）—— 块级作用域不可见，
    //   一旦中途抛错跳到 finally 就会 ReferenceError，反而把清理整个跳过（本项目真实踩过：
    //   临时账号因此残留在生产库里）。所以按 openid 前缀兜底删，不依赖任何 try 内变量。
    const tagRe = new RegExp(`^${TMP_TAG}`);
    await StepAnomaly.deleteMany({ openid: tagRe });
    await StepLabel.deleteMany({ openid: tagRe });
    await BanRecord.deleteMany({ openid: tagRe });
    await User.deleteMany({ openid: tagRe });
    // 再按 _id 清一遍（防止有 openid 字段没写全的记录漏网）
    if (created.users.length) await User.deleteMany({ _id: { $in: created.users } });
    if (created.anomalies.length) {
      await StepAnomaly.deleteMany({ _id: { $in: created.anomalies } });
      await StepLabel.deleteMany({ anomalyId: { $in: created.anomalies } });
    }
    session._reset();

    const left = {
      users: await User.countDocuments({ openid: new RegExp(`^${TMP_TAG}`) }),
      anomalies: await StepAnomaly.countDocuments({ openid: new RegExp(`^${TMP_TAG}`) }),
      labels: await StepLabel.countDocuments({ openid: new RegExp(`^${TMP_TAG}`) }),
    };
    console.log(`\n清理：残留用户 ${left.users} / 异常记录 ${left.anomalies} / 标注 ${left.labels}`);
    if (left.users || left.anomalies || left.labels) failed += 1;
    await mongoose.disconnect();
  }

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.stack);
  process.exit(1);
});
