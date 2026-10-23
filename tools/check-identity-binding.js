/**
 * 静态检查：登录身份（JWT ←→ 微信绑定）必须强一致，换号/解绑后不能残留上一个身份。
 *
 * 真实事故（2026-10-22，用户报「我登录刘恩琦教师账号后，依旧是陈宇航的教师账号」）：
 *   · 管理员在后台「取消绑定微信」只清了 `user.openid`，**已签发的 JWT 仍然有效 30 天**；
 *   · 那台设备继续带着陈宇航的令牌请求，/api/auth/me 按 uid 查出来还是陈宇航（超级管理员界面）；
 *   · 用户在登录页重新输入「刘恩琦」也没用 —— 本地 token 换了，可页面拿到的仍是旧身份的数据。
 *   结果：账号明明解绑了，旧设备还能进后台 —— 这是越权，不只是显示问题。
 *
 * 修法（本检查守住这 4 条，缺一条就会复发）：
 *   ① 签发：signToken 必须把 openid 写进 JWT（否则服务端无从比对）；
 *   ② 校验：middlewares/auth.js 必须比对「令牌里的 openid」与「user.openid」，不一致就 401；
 *   ③ 自愈：小程序 ensureLogin 每个启动周期向服务端确认一次身份（401 会被 request() 自动重登）；
 *   ④ 清干净：logout() 必须清 unionIdentity 等账号级缓存并重置 app 上的身份缓存。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const bad = [];
const okNotes = [];

function must(cond, msg) {
  if (cond) okNotes.push(msg);
  else bad.push(msg);
}

// ① 签发时写入 openid
const authRoute = read('server/src/routes/auth.js');
must(
  /function signToken\(user\)[\s\S]{0,220}openid:\s*user\.openid/.test(authRoute),
  'server/src/routes/auth.js::signToken 必须把 openid 写进 JWT（否则无法判定绑定是否被改过）'
);

// ② 校验时比对 openid
const authMw = read('server/src/middlewares/auth.js');
must(
  /payload\.openid\s*!==\s*undefined/.test(authMw) &&
    /String\(payload\.openid\)\s*!==\s*String\(user\.openid\s*\|\|\s*''\)/.test(authMw),
  'server/src/middlewares/auth.js 必须比对令牌 openid 与 user.openid（不一致 → 401）'
);
must(
  /new ApiError\(\s*401[\s\S]{0,120}重新登录/.test(authMw),
  'server/src/middlewares/auth.js 的绑定变更判定必须返回 401（小程序靠 401 触发自动重登自愈）'
);

// ③ 启动确认身份：走 **/api/auth/me（按 token 校验）**，不要走 /api/auth/login（按微信 openid）。
//
// 历史演变（改这里之前先读，两版都有真实事故）：
//   · 2026-10-22：本地残留旧令牌 → 页面一直是上一个身份。当时的修法是「按 openid 重新认定」，
//     即启动时调 /api/auth/login，把身份强行对齐到「当前微信绑定的账号」。
//   · 2026-10-23：教师不限制换绑后，这个修法本身成了 bug —— 教师用 A 账号一键登录，
//     而当前微信绑在 B 上，启动时按 openid 重新登录就会**静默把身份切回 B**，
//     表现正是用户报的「历史登录一键登录……会出现历史记录失效」。
// 现在：旧令牌由**服务端**判死（middlewares/auth.js 比对 openid，不一致即 401），
// 401 时 request() 自动重登 —— 自愈链路不依赖启动时按 openid 覆盖；
// 启动确认只校验「这个 token 现在是谁」，谁登录的就还是谁。
const appJs = read('miniprogram/app.js');
const ensureBlock = (appJs.match(/async ensureLogin\(\)\s*\{[\s\S]*?\n  \},?\n/) || [''])[0];
must(!!ensureBlock, 'miniprogram/app.js 必须存在 ensureLogin()');
must(/_identityChecked/.test(ensureBlock), 'ensureLogin 必须每个启动周期只做一次身份确认（_identityChecked 去重）');
must(
  /refreshUser\(\)/.test(ensureBlock) && !/auth\.login\(\s*\{\s*silent/.test(ensureBlock),
  'ensureLogin 的身份确认必须走 refreshUser()（/api/auth/me 按 token 校验），不得按 openid 覆盖身份'
);
must(
  /_identityPromise/.test(ensureBlock),
  'ensureLogin 的并发调用必须共享同一个确认请求（否则会先渲染旧身份再被纠正）'
);

// ③b 一键登录失败时**不能**一律删本地历史记录（用户 2026-10-23 报障）。
//   只有服务端明确回 401001 才算「这条记录没用了」。
const loginPage = read('miniprogram/pages/auth-login/auth-login.js');
const quickBlock = (loginPage.match(/async quickLogin\(e\)\s*\{[\s\S]*?\n  \},?\n/) || [''])[0];
must(!!quickBlock, '登录页必须存在 quickLogin()');
must(
  /deviceTokenInvalid/.test(quickBlock) && /history\.remove\(/.test(quickBlock),
  '一键登录失败必须区分「令牌失效（删记录）」与「暂时失败（保留记录）」，不能一律删'
);
must(
  /if\s*\(!dead\)/.test(quickBlock),
  '一键登录在非失效类失败时（网络/5xx）必须走「保留记录」分支'
);
must(
  /deviceTokenInvalid/.test(read('miniprogram/utils/request.js')),
  'utils/request.js::deviceLogin 必须给错误打 deviceTokenInvalid 标记'
);

// ④ 退出登录清干净
const reqJs = read('miniprogram/utils/request.js');
const logoutBlock = (reqJs.match(/function logout\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
must(!!logoutBlock, 'miniprogram/utils/request.js 必须存在 logout()');
must(/unionIdentity/.test(logoutBlock), 'logout() 必须清掉 globalData.unionIdentity（学生会身份属于账号级缓存）');
must(/_roleProbe/.test(logoutBlock), 'logout() 必须重置 app._roleProbe（否则广告闸门仍按上一个人的角色判定）');
must(
  /clearAuth\(\)/.test(logoutBlock) && /markLoggedOut\(\)/.test(logoutBlock),
  'logout() 必须同时 clearAuth() 与 markLoggedOut()'
);

// ⑤ 解绑微信的接口必须撤销服务端可撤销的凭据（JWT 由 ② 兜住）
const adminUsers = read('server/src/routes/admin/users.js');
const unbindBlock = (adminUsers.match(/unbind-wechat[\s\S]{0,1400}/) || [''])[0];
must(!!unbindBlock, 'server/src/routes/admin/users.js 必须保留解绑微信接口');
if (unbindBlock) {
  must(/\$unset:\s*\{\s*openid/.test(unbindBlock), '解绑微信必须清掉 user.openid');
  must(/revokeAllForUser/.test(unbindBlock), '解绑微信必须撤销该账号的全部设备令牌（login_devices）');
  must(/WxSession\.deleteMany/.test(unbindBlock), '解绑微信必须清掉 wx_sessions');
}

// ⑥ 微信绑定规则：学生「一账号一微信」，教师可换绑（用户 2026-10-22「教师账户不限制微信绑定的登录」）
must(
  /const isTeacherAccount = user\.role === 'teacher'/.test(authRoute),
  'POST /api/auth/bind 必须区分教师与学生账号（教师允许换绑）'
);
must(
  /if \(!isTeacherAccount\) \{[\s\S]{0,90}new ApiError\(403, 403004/.test(authRoute),
  '学生换微信登录必须仍然 403 403004（这条限制不能因为教师放开而一起放开）'
);
must(
  /const openid = req\.guestOpenid \|\| \(req\.user && req\.user\.openid\)/.test(authRoute),
  'POST /api/auth/bind 必须同时支持「游客令牌」与「已登录态」两种当前微信来源（登录页换账号）'
);
must(
  /const holder = await User\.findOne\(\{ openid, _id: \{ \$ne: user\._id \} \}\)/.test(authRoute),
  '绑定/换绑前必须先查「这个微信当前绑在谁身上」（否则会抛 Mongo E11000 唯一索引错误）'
);
must(
  /if \(holder\.role !== 'teacher'\)/.test(authRoute),
  '占着这个微信的是**学生**账号时必须拒绝（学生微信不能被任何账号顶掉）'
);
must(
  /\$unset: \{ openid: 1, openidBoundAt: 1 \}/.test(authRoute),
  '教师之间换绑必须先把这个微信从原账号解绑（openid 唯一索引）'
);
// ⚠️ 反向断言：换绑时**不得**吊销原账号的全部设备令牌（用户 2026-10-23「一键登录历史记录失效」）。
// 设备令牌按账号签发、与微信无关：原账号在别的手机上的「一键登录」仍然合法，
// 一刀切吊销会让那些记录永久失效（客户端失败后还会删掉本地记录）。
{
  const holderBlock = (authRoute.match(/if \(holder\) \{[\s\S]*?\n    \}/) || [''])[0];
  must(!!holderBlock, 'server/src/routes/auth.js 必须有「这个微信已绑在谁身上」的处理块');
  // 只判**代码**：注释里会大段解释「为什么不能调 revokeAllForUser」，直接 includes 会误判
  const holderCode = holderBlock
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  must(
    !/revokeAllForUser\s*\(/.test(holderCode),
    '教师换绑时**不得**调用 revokeAllForUser（会把原账号在其它设备上的一键登录记录全部作废）'
  );
}
must(
  /user\.openidBoundAt = rebinding \? now :/.test(authRoute),
  '教师换绑后必须把 openidBoundAt 更新为新绑定时间'
);

// ⑦ 教师「我的」页不显示 隐私设置 / 我的申诉（教师不参与排名、没有申诉链路）
const profileWxml = read('miniprogram/pages/profile/profile.wxml');
{
  const privacyRow = (profileWxml.match(/<view class="tt-row menu-row"[^>]*bind:tap="goPrivacy"/) || [''])[0];
  const appealRow = (profileWxml.match(/<view class="tt-row menu-row"[^>]*data-url="\/pages\/appeal\/list"/) || [''])[0];
  must(
    /roleReady && !isTeacher/.test(privacyRow),
    '「隐私设置」行必须按 roleReady && !isTeacher 隐藏（教师不显示，且不能首帧误闪）'
  );
  must(
    /roleReady && !isTeacher/.test(appealRow),
    '「我的申诉」行必须按 roleReady && !isTeacher 隐藏（教师不显示，且不能首帧误闪）'
  );
  must(/\broleReady\b/.test(read('miniprogram/pages/profile/profile.js')), 'profile.js 必须维护 roleReady（角色确认标志）');
}

if (bad.length) {
  console.error('身份一致性检查失败：');
  for (const b of bad) console.error('  ✗ ' + b);
  process.exit(1);
}
console.log(`身份一致性检查通过（${okNotes.length} 项）`);
for (const n of okNotes) console.log('  ✓ ' + n);
