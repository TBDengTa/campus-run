/**
 * Web 控制台（/console）会话服务。
 *
 * ===== 为什么必须与小程序 JWT 完全隔离 =====
 * 小程序登录态 = 微信 openid 换来的 JWT（`middlewares/auth.js`），身份根是「哪个微信」。
 * 控制台是**账号 + 密码**登录的浏览器页面，身份根是「谁知道密码」。
 * 两套信任模型不能共用凭证：
 *   · 让浏览器带小程序 JWT → 任何 XSS 偷到的令牌能直接调小程序 API（改步数、发徽章），爆炸半径大得多；
 *   · 让小程序带控制台 Cookie → 小程序没有浏览器 Cookie 语义，且会把管理身份下发到学生设备上。
 * 所以控制台用自己的**不透明随机 sid**（HttpOnly Cookie），只认 `/console/api/*` 这一组接口。
 *
 * ===== 会话存内存（用户 2026-10-29 选定） =====
 * 重启需重新登录。刻意的取舍：
 *   · 实现简单、可**立即吊销**（管理员离职/手机丢了，重启即全部失效，不留数据库残留）；
 *   · 控制台是低频人工操作，重启踢下线完全可接受；
 *   · 反过来若落库，就得考虑「删掉的账号会话还在」、索引清理、多进程一致性 —— 收益不值。
 * ⚠️ 多进程部署（pm2 cluster / 多个 systemd 实例）会让会话只在其中一个进程可见，
 *    表现为「登录后刷新偶发 401」。本项目部署为单进程 + Nginx 反代（见 install.sh 约定），
 *    若将来扩成多进程，这里必须换成共享存储（Redis / Mongo），并把 SESSION_STORE 提出来。
 *
 * ===== 暴力破解防护（不能复用 user.failedLogins） =====
 * 小程序的失败计数写在**用户文档**上（auth.js：MAX_FAILED 后设 lockUntil）。
 * 控制台绝不能写同一份 —— 否则有人在浏览器里狂试张三的密码，
 * 后果是张三**在小程序上也登不进去**，攻击者用管理端的入口把学生锁在门外，
 * 这是拒绝服务的放大器。所以控制台限流单独记在内存里（按账号 + 按 IP 两个维度）。
 */
const crypto = require('crypto');

// sid 熵：32 字节随机（hex 64 位）。不可猜测是 HttpOnly Cookie 之外唯一的防线。
const SID_BYTES = 32;
// 空闲过期：8 小时（一个工作日）。控制台不做「永久会话」。
const IDLE_MS = 8 * 60 * 60 * 1000;
// 绝对上限：12 小时，即使一直操作也要重新登录（防着没人用的浏览器长挂）
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
// Cookie 名
const COOKIE_NAME = 'tt_console';

// ===== 限流参数 =====
const FAIL_WINDOW_MS = 15 * 60 * 1000; // 统计窗口
const FAIL_MAX_PER_ACCOUNT = 5; // 同一账号 15 分钟内最多失败 5 次
const FAIL_MAX_PER_IP = 20; // 同一 IP 最多 20 次（防拿一个密码撞全员）
const LOCK_MS = 15 * 60 * 1000; // 超阈值锁 15 分钟

/** sid -> { userId, account, role, perms, createdAt, lastSeen, expiresAt } */
const sessions = new Map();
/** key -> { count, firstAt, lockUntil } */
const throttle = new Map();

function newSid() {
  return crypto.randomBytes(SID_BYTES).toString('hex');
}

// 常数时间比较：避免通过响应时间逐字节猜 sid。
// 随机 256 位下这条路其实走不通，但多花几行没有理由不做（低成本、纵深防御）。
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---- 会话 ----
function create(user, perms) {
  // 会话回收：每次新建时顺手扫一遍过期项（低频场景，不需要定时器常驻）
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (s.lastSeen < now - IDLE_MS || s.createdAt < now - MAX_AGE_MS) sessions.delete(sid);
  }

  const sid = newSid();
  sessions.set(sid, {
    sid,
    userId: String(user._id),
    account: user.account || user.realName || '',
    role: user.role || '',
    // 有效权限快照（登录当下展开）。⚠️ 不每次回库查权限的取舍：
    //   控制台是低频人工操作，且「改权限」本来就该让本人重新登录才生效 ——
    //   这样撤销权限不会被旧会话继续白用 8 小时。
    perms: Array.isArray(perms) ? perms : [],
    createdAt: now,
    lastSeen: now,
  });
  return sid;
}

function get(sid) {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  const now = Date.now();
  if (s.lastSeen < now - IDLE_MS || s.createdAt < now - MAX_AGE_MS) {
    sessions.delete(sid);
    return null;
  }
  s.lastSeen = now; // 滑动过期
  return s;
}

function destroy(sid) {
  if (sid) sessions.delete(sid);
}

/** 吊销某个用户的全部会话（改权限 / 封禁该管理员时用） */
function destroyForUser(userId) {
  const id = String(userId);
  let n = 0;
  for (const [sid, s] of sessions) {
    if (s.userId === id) {
      sessions.delete(sid);
      n += 1;
    }
  }
  return n;
}

// ---- 限流 ----
function throttleState(key) {
  const now = Date.now();
  const cur = throttle.get(key);
  if (!cur || now - cur.firstAt > FAIL_WINDOW_MS) {
    const fresh = { count: 0, firstAt: now, lockUntil: 0 };
    throttle.set(key, fresh);
    return fresh;
  }
  return cur;
}

/** 还有多少次尝试机会 / 是否已锁 */
function checkThrottle(accountKey, ipKey) {
  const now = Date.now();
  for (const k of [accountKey, ipKey]) {
    const st = throttleState(k);
    if (st.lockUntil > now) {
      const mins = Math.ceil((st.lockUntil - now) / 60000);
      return { blocked: true, retryMinutes: mins };
    }
  }
  return { blocked: false };
}

function recordFailure(accountKey, ipKey) {
  const now = Date.now();
  const a = throttleState(accountKey);
  a.count += 1;
  if (a.count >= FAIL_MAX_PER_ACCOUNT) a.lockUntil = now + LOCK_MS;
  const i = throttleState(ipKey);
  i.count += 1;
  if (i.count >= FAIL_MAX_PER_IP) i.lockUntil = now + LOCK_MS;
}

function clearFailure(accountKey, ipKey) {
  throttle.delete(accountKey);
  throttle.delete(ipKey);
}

// ---- Cookie 解析（不引入 cookie-parser 依赖：一个 Set-Cookie / 一行解析就够） ----
function readCookie(header, name) {
  if (!header) return '';
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

/**
 * 下发会话 Cookie。
 * · HttpOnly     ：JS 读不到（XSS 偷不走 sid，只能借浏览器当前页发请求，攻击面小一个量级）
 * · SameSite=Strict：跨站请求一律不带 Cookie，等价于 CSRF 防线（控制台只有同源页面会调）
 * · Secure       ：仅 https。本地 http 开发时必须关，否则浏览器根本不发 Cookie（会误判成「登录没生效」）
 * · Max-Age      ：与会话的 12 小时绝对上限对齐（浏览器侧也到期）
 */
function cookieFor(sid, { secure }) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(sid)}`,
    'Path=/console',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + Math.floor(MAX_AGE_MS / 1000),
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function clearCookie({ secure }) {
  const attrs = [`${COOKIE_NAME}=`, 'Path=/console', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

module.exports = {
  COOKIE_NAME,
  IDLE_MS,
  MAX_AGE_MS,
  create,
  get,
  destroy,
  destroyForUser,
  safeEqual,
  checkThrottle,
  recordFailure,
  clearFailure,
  readCookie,
  cookieFor,
  clearCookie,
  // 供测试/排障：当前在线会话数（不含任何 sid 与用户标识）
  onlineCount: () => sessions.size,
  // 供测试：清掉全部会话与限流状态
  _reset: () => {
    sessions.clear();
    throttle.clear();
  },
};
