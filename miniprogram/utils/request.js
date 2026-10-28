// 统一请求封装：自动携带 token、401 自动重登、封禁状态识别
let env;
try {
  // eslint-disable-next-line global-require
  env = require('../config/env.js');
} catch (e) {
  // eslint-disable-next-line global-require
  env = require('../config/env.example.js');
  console.warn('[env] 未找到 config/env.js，正在使用示例配置（请求将无法成功），请复制 env.example.js 为 env.js 并填写服务器地址');
}

const TOKEN_KEY = 'tt_token';
const USER_KEY = 'tt_user';
const UID_KEY = 'tt_uid'; // 设备级匿名标识，用于静默重试
const BOUND_KEY = 'tt_bound'; // '1' = 已绑定名单账号（游客 token 不算登录）
const LOGOUT_KEY = 'tt_logged_out'; // '1' = 用户主动退出，禁止静默重登

const history = require('./login-history');

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || '';
}

// 用户是否主动退出过（退出后必须手动登录，不再静默登录）
function isLoggedOut() {
  return wx.getStorageSync(LOGOUT_KEY) === '1';
}

function markLoggedOut() {
  wx.setStorageSync(LOGOUT_KEY, '1');
}

function clearLoggedOut() {
  wx.removeStorageSync(LOGOUT_KEY);
}

// 是否处于「已登录且已绑定账号」状态：游客 token（未绑定）不算
function isBound() {
  return !!getToken() && wx.getStorageSync(BOUND_KEY) === '1' && !isLoggedOut();
}

function setAuth(token, userInfo, bound = true) {
  clearLoggedOut(); // 拿到 token 即视为已登录
  wx.setStorageSync(TOKEN_KEY, token);
  if (bound) wx.setStorageSync(BOUND_KEY, '1');
  else wx.removeStorageSync(BOUND_KEY);
  if (userInfo) wx.setStorageSync(USER_KEY, userInfo);
}

function getUser() {
  return wx.getStorageSync(USER_KEY) || null;
}

function setUser(userInfo) {
  wx.setStorageSync(USER_KEY, userInfo);
}

function clearAuth() {
  wx.removeStorageSync(TOKEN_KEY);
  wx.removeStorageSync(USER_KEY);
  wx.removeStorageSync(BOUND_KEY);
}

// 退出登录：清除本机登录信息 + 打「已退出」标记（不会被 ensureLogin 静默登回）
//
// ⚠️ 必须把**所有与账号相关**的缓存一起清掉（用户 2026-10-22「登录刘恩琦后依旧是陈宇航」）：
// 以前只清 userInfo/today，剩下的 stats/unionIdentity/points 与 app 里的
// `_roleProbe`（广告闸门的角色探测缓存）、`_identityChecked`（身份确认已做过）
// 都是上一个账号的结论 —— 换号后仍然生效，表现就是「换了账号还带着上一个人的身份」。
// 只清一半比不清更危险：页面半新半旧，报出来的现象无法复现。
function logout() {
  // 示例账号（isDemo）：**退出登录时先让服务端解绑微信**（用户 2026-10-24「退出登录自动解绑」）。
  //
  // 为什么必须落到服务端：openid 存在 users 文档上，只清本地 token 的话库里那个微信仍占着
  // 这个示例账号 —— 下一个人用别的微信登录照样被「已绑定其他微信」挡住，示例账号就废了。
  //
  // 三条约束：
  //   ① 只对 isDemo 生效（服务端有守卫，真实账号调它返回 403）；非示例账号调它无害，
  //      所以这里不必先判断身份 —— 少一次同步读取，logout 路径也不依赖缓存。
  //   ② **绝不阻塞退出**：网络断了 / 服务端没起，也必须能正常退出。
  //      这里用 wx.request 的 fire-and-forget 形态（不 await），本地清理照旧同步执行。
  //   ③ 必须在 clearAuth() **之前**发：请求要靠 token 鉴权，清了 token 就调不动了。
  try {
    const t = getToken();
    if (t) {
      wx.request({
        url: `${env.BASE_URL}/api/auth/demo-release`,
        method: 'POST',
        header: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
        data: {},
        success() {},
        fail() {},
      });
    }
  } catch (e) {
    // 忽略：任何异常都不能阻止退出登录
  }
  clearAuth();
  markLoggedOut();
  try {
    const app = getApp();
    if (app && app.globalData) {
      const g = app.globalData;
      g.userInfo = null;
      if (g.today !== undefined) g.today = null;
      if (g.stats !== undefined) g.stats = null;
      if (g.unionIdentity !== undefined) g.unionIdentity = null;
      if (g.points !== undefined) g.points = null;
      // 换代：让各页面 onShow 里的 refreshPermission / permissionStale 知道要重算
      g.permissionEpoch = (Number(g.permissionEpoch) || 0) + 1;
    }
    if (app) {
      app._roleProbe = null; // 角色探测缓存（applyAdGate）必须失效，否则教师闸门仍按上一个人的角色判定
      app._identityChecked = false; // 下次登录要重新向服务端确认「我是谁」
    }
  } catch (e) {
    // App 未就绪时忽略
  }
}

let loginPromise = null;

/**
 * 登录成功后刷新缓存（用户 2026-10-22「在登录账户时一定要刷新缓存」）。
 *
 * 为什么必须有：各管理端页面在 `onLoad` 里按 `globalData.userInfo.effectivePermissions`
 * 把 `canManage` / `canManagePerms` 之类算好存进 `data`，之后再也不会重算。
 * 换账号登录（尤其从「可写」换到「只读」）时：
 *   · `globalData.userInfo` 已经换新，但页面 data 里还是上一个账号的结论；
 *   · 结果是「只读账号看到操作按钮，点了被后端 403」——正是用户报的第二个问题的成因之一。
 *
 * 做三件事：
 *   ① 清掉全局缓存里与账号相关的字段（userInfo/today/stats 等由 app 自己定义的缓存）；
 *   ② 把「缓存已换代」写进 globalData 并交给各页面的 `onShow` 重算权限
 *      （页面若实现了 refreshPermission() 会被调用）；
 *   ③ 清掉业务级缓存（如 union 身份缓存），避免旧账号的成员身份残留。
 */
function refreshCachesAfterLogin(userInfo) {
  try {
    const app = getApp();
    if (!app) return;
    const g = app.globalData || {};

    // ① 账号相关缓存全部置空（字段是 app.js 里定义的，逐个清而不是整体替换，
    //    避免抹掉 banner / 系统配置这类与账号无关的缓存）
    g.userInfo = userInfo || null;
    if (g.today !== undefined) g.today = null;
    if (g.stats !== undefined) g.stats = null;
    if (g.unionIdentity !== undefined) g.unionIdentity = null;
    if (g.points !== undefined) g.points = null;
    // ② 换代计数：页面 onShow 里比对它就知道「权限可能变了，要重算」
    g.permissionEpoch = (Number(g.permissionEpoch) || 0) + 1;
    // 本次登录已经向服务端确认过身份，启动时的静默确认不必再跑一遍
    app._identityChecked = true;

    // ③ 通知当前页面栈里的页面重算权限（如果它实现了 refreshPermission）
    const pages = (getCurrentPages && getCurrentPages()) || [];
    for (const p of pages) {
      if (p && typeof p.refreshPermission === 'function') {
        try {
          p.refreshPermission(g.permissionEpoch);
        } catch (e) {
          /* 单个页面失败不能影响登录 */
        }
      }
    }
  } catch (e) {
    /* getApp 未就绪（极早期调用）→ 忽略，下次 ensureLogin 会再刷一次 */
  }
}

/**
 * 页面侧统一入口：在 onShow 里调用，判断是否需要因「换账号 / 权限变更」重算。
 *
 * 用法（页面）：
 *   onShow() { if (!getApp().requireLogin()) return; auth.syncPermission(this, (u, perms) => {...}); }
 *
 * 返回 true 表示这次应当重算。
 */
function permissionStale(page) {
  try {
    const g = getApp().globalData || {};
    const seen = Number(page && page.__permEpoch) || 0;
    return (Number(g.permissionEpoch) || 0) !== seen;
  } catch (e) {
    return false;
  }
}

function markPermissionSynced(page) {
  try {
    const g = getApp().globalData || {};
    if (page) page.__permEpoch = Number(g.permissionEpoch) || 0;
  } catch (e) {
    /* ignore */
  }
}

// 静默登录：wx.login → code → 后端换 token
// 本地测试模式（env.DEV_LOGIN）直接用约定角色 code，无需微信 AppSecret
// 注意：用户主动退出登录后不再静默登录，必须由登录页显式调用（先 clearLoggedOut）
//
// options.silent：只确认身份、不签发设备令牌（启动时的身份确认用）。
// 为什么启动要再跑一次 login 而不是直接信本地 token：本地 token 可能属于**上一个身份**
// （解绑/换绑/换微信后 JWT 仍有效 30 天），而 `/api/auth/login` 只按**当前微信的 openid**
// 定身份 —— 它是「我是谁」的唯一权威来源，跑一次就自愈成本地缓存里的旧账号。
function login(options = {}) {
  const silent = !!options.silent;
  if (isLoggedOut()) {
    const err = new Error('已退出登录，请重新登录');
    err.code = 401;
    err.loggedOut = true;
    return Promise.reject(err);
  }
  if (loginPromise) return loginPromise;
  loginPromise = new Promise((resolve, reject) => {
    if (env.DEV_LOGIN) {
      resolve(env.DEV_ROLE || 'dev-student');
      return;
    }
    wx.login({
      success: (res) => {
        if (!res.code) {
          reject(new Error('wx.login 未返回 code'));
          return;
        }
        resolve(res.code);
      },
      fail: reject,
    });
  })
    .then((code) =>
      rawRequest({
        url: '/api/auth/login',
        method: 'POST',
        data: { code, silent },
        _noAuthRetry: true,
      })
    )
    .then((data) => {
      // 游客（未绑定名单账号）只存 token，不标记为已登录
      setAuth(data.token, data.userInfo, data.bound !== false);
      getApp().globalData.userInfo = data.userInfo || null;
      // 记录登录历史（供登录页一键登录）
      if (data.bound !== false && data.deviceToken) history.push(data.userInfo, data.deviceToken);
      // ⚠️ 登录成功必须**刷新缓存**（用户 2026-10-22「在登录账户时一定要刷新缓存」）：
      //   各页面在 onLoad 里把 canManage 之类算好存进 data，登录换了账号后那些值是旧的 ——
      //   表现就是「换成本该只读的账号还能看到操作按钮」或反过来「该有的按钮没有」。
      //   这里清掉全局缓存并通知页面重算（见 refreshCachesAfterLogin）。
      refreshCachesAfterLogin(data.userInfo);
      return data;
    })
    .finally(() => {
      loginPromise = null;
    });
  return loginPromise;
}

function rawRequest({ url, method = 'GET', data, header = {}, timeout = 15000, _noAuthRetry }) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${env.BASE_URL}${url}`,
      method,
      data,
      timeout,
      header: {
        'content-type': 'application/json',
        Authorization: getToken() ? `Bearer ${getToken()}` : '',
        ...header,
      },
      success: (res) => {
        const { statusCode } = res;
        const body = res.data || {};
        if (statusCode === 401) {
          const err = new Error(body.message || '未登录');
          err.code = 401;
          reject(err);
          return;
        }
        if (statusCode === 403 && body.code === 403001) {
          const err = new Error(body.message || '账号已被限制登录');
          err.code = 403001;
          err.banned = body.banned; // { reason, until, banType }
          reject(err);
          return;
        }
        // 单项能力受限（限制微信同步 / 限制 GPS）：不跳封禁页，由页面提示并引导申诉
        if (statusCode === 403 && body.code === 403004) {
          const err = new Error(body.message || '该功能已被限制');
          err.code = 403004;
          err.restriction = body.restriction; // { scope, text, reason, until }
          reject(err);
          return;
        }
        // 未绑定账号访问业务接口 → 统一跳登录页
        if (statusCode === 403 && body.code === 403003) {
          const err = new Error(body.message || '请先登录账号');
          err.code = 403003;
          reject(err);
          gotoLogin();
          return;
        }
        if (statusCode >= 200 && statusCode < 300 && body.code === 0) {
          resolve(body.data);
          return;
        }
        const err = new Error(body.message || `请求失败(${statusCode})`);
        err.code = body.code || statusCode;
        // 业务补充字段（如班超重复提交返回的 existingId）挂到 error 上，页面可直接用
        if (body.existingId) err.existingId = body.existingId;
        if (body.existing) err.existing = body.existing;
        reject(err);
      },
      fail: (e) => {
        const err = new Error('网络异常，请检查网络或稍后重试');
        err.cause = e;
        reject(err);
      },
    });
  });
}

let redirectingToLogin = false;
function gotoLogin() {
  if (redirectingToLogin) return;
  redirectingToLogin = true;
  // 注意：保留 token（游客 token 需在登录页完成账号绑定），仅清用户信息
  try {
    const app = getApp();
    if (app && app.globalData) app.globalData.userInfo = null;
  } catch (e) {
    // App 未就绪时忽略
  }
  wx.reLaunch({
    url: '/pages/auth-login/auth-login',
    complete: () => {
      setTimeout(() => {
        redirectingToLogin = false;
      }, 1500);
    },
  });
}

// 业务请求：401 时自动重登一次再试（已主动退出登录时不再自动重登，直接跳登录页）
async function request(options) {
  try {
    return await rawRequest(options);
  } catch (e) {
    if (e.code === 401 && !options._noAuthRetry) {
      if (isLoggedOut()) {
        gotoLogin();
        throw e;
      }
      try {
        await login();
      } catch (err) {
        gotoLogin();
        throw e;
      }
      return rawRequest({ ...options, _noAuthRetry: true });
    }
    throw e;
  }
}

// 姓名 + 密码 绑定/登录（游客态调用）
// studentId 可选：同名账号存在时服务端会返回 400902 要求补学号精确区分（见 routes/auth.js /bind）。
function bindAccount(account, password, studentId) {
  return rawRequest({
    url: '/api/auth/bind',
    method: 'POST',
    data: { account, password, studentId: studentId || '' },
    _noAuthRetry: true,
  }).then((data) => {
    setAuth(data.token, data.userInfo, true);
    getApp().globalData.userInfo = data.userInfo;
    if (data.deviceToken) history.push(data.userInfo, data.deviceToken);
    // 绑定账号 = 换登录身份，同样要刷新缓存（否则页面还拿着上一个身份的权限结论）
    refreshCachesAfterLogin(data.userInfo);
    return data;
  });
}

// 设备令牌一键登录（登录页历史登录列表）
//
// 失败时给错误对象打上 `deviceTokenInvalid`，让调用方能区分「这条记录真的没用了」与
// 「暂时失败」：只有服务端明确回 401/401001（令牌失效/被撤销）才算失效，
// 网络异常、5xx、其它 4xx 一律**保留本地历史记录**（用户 2026-10-23 报障：
// 一键登录的历史记录会莫名消失 —— 旧实现在页面上把任何失败都当成失效并删记录）。
function deviceLogin(deviceToken) {
  return rawRequest({
    url: '/api/auth/device-login',
    method: 'POST',
    data: { deviceToken },
    _noAuthRetry: true,
  })
    .then((data) => {
      clearLoggedOut(); // 主动登录动作
      setAuth(data.token, data.userInfo, true);
      getApp().globalData.userInfo = data.userInfo;
      // 服务端已轮换令牌：覆盖本地历史里的旧令牌
      if (data.deviceToken && data.userInfo) {
        history.refreshToken(data.userInfo.account || data.userInfo.realName, data.userInfo.studentId, data.deviceToken);
      }
      // 一键登录 = 换登录身份，同样要刷新缓存
      refreshCachesAfterLogin(data.userInfo);
      return data;
    })
    .catch((e) => {
      // 401001 = 该登录记录已失效（服务端 routes/auth.js::/device-login 的固定码）
      e.deviceTokenInvalid = !!(e && (e.code === 401001 || e.code === 401));
      throw e;
    });
}

// 撤销设备令牌（删除历史登录记录）
function revokeDevice(deviceToken) {
  if (!deviceToken) return Promise.resolve();
  return rawRequest({
    url: '/api/auth/device-revoke',
    method: 'POST',
    data: { deviceToken },
    _noAuthRetry: true,
  }).catch(() => null);
}

const get = (url, data) => request({ url, method: 'GET', data });
const post = (url, data) => request({ url, method: 'POST', data });
const put = (url, data) => request({ url, method: 'PUT', data });
const del = (url, data) => request({ url, method: 'DELETE', data });

// 上传文件（默认管理端接口；头像等用户端接口通过 options.url 指定）
// options.onProgress(percent)：上传进度回调（0-100）
function uploadFile(filePath, options = {}) {
  return new Promise((resolve, reject) => {
    const task = wx.uploadFile({
      url: `${env.BASE_URL}${options.url || '/api/admin/upload'}`,
      filePath,
      name: 'file',
      formData: options.formData,
      header: { Authorization: getToken() ? `Bearer ${getToken()}` : '' },
      success: (res) => {
        try {
          const body = JSON.parse(res.data);
          if (body.code === 0) resolve(body.data);
          else reject(new Error(body.message || '上传失败'));
        } catch (e) {
          reject(new Error('上传响应解析失败'));
        }
      },
      fail: () => reject(new Error('上传失败')),
    });
    if (options.onProgress && task && typeof task.onProgressUpdate === 'function') {
      task.onProgressUpdate((res) => options.onProgress(res.progress));
    }
  });
}

// 检查留证照片上传（学生会录入台专用）—— **新增方法，不改动 uploadFile / rawRequest 的任何行为**。
//
// 为什么不直接调 uploadFile（刻意独立实现，两处差异都是必须的）：
//   ① 服务器地址拼装必须留在本文件里（AGENTS.md 红线：被 git 跟踪的文件不许出现服务器地址，
//      地址只能来自 config/env.js 的 BASE_URL）；
//   ② **业务错误码要透出给页面**：uploadFile 只 reject 一个 Error(message)，页面分不清
//      「不是学生会成员（403002，重试无意义）」与「网络抖动（值得重试）」。这里把服务端返回的
//      code 挂到 error.code 上，页面的「失败重试」逻辑才能只对可重试的错误生效。
//
// 返回 { url }；options.onProgress(percent) 显示单张上传进度。
function uploadCheckPhoto(filePath, options = {}) {
  // 用户 2026-10-28「上传不成功要提示原因」：
  //   旧实现在**解析不出 JSON**时只回「上传失败，请重试」，而且 413 的文案写死「单张最多 5MB」——
  //   上限后来早就改了，那句 5MB 会误导用户去压缩一张其实完全没超限的照片。
  // 现在按**失败层次**分别给出可操作的原因：
  //   · 服务端返回 JSON → 直接用它的 message（服务端会带上真实 MB 上限）
  //   · 非 JSON + 413    → 被 Nginx/网关拦的（Node 没收到），提示检查 client_max_body_size
  //   · 非 JSON + 5xx    → 服务器暂时不可用
  //   · wx.uploadFile 失败 → 区分 超时 / 取消 / 网络
  return new Promise((resolve, reject) => {
    const task = wx.uploadFile({
      url: `${env.BASE_URL}/api/upload/check-photo`,
      filePath,
      name: 'file',
      header: { Authorization: getToken() ? `Bearer ${getToken()}` : '' },
      success: (res) => {
        const status = Number(res.statusCode) || 0;
        let body = null;
        try {
          body = JSON.parse(res.data);
        } catch (e) {
          body = null;
        }

        if (!body) {
          if (status === 413) {
            reject(
              new Error(
                '照片太大，被服务器网关拒绝（Nginx 的 client_max_body_size 需大于单张上限）。请压缩后再传，或联系管理员调整服务器上限'
              )
            );
            return;
          }
          if (status === 502 || status === 504) {
            reject(new Error(`服务器暂时不可用（${status}），请稍后重试`));
            return;
          }
          reject(new Error(`上传失败（HTTP ${status || '无响应'}），请稍后重试`));
          return;
        }

        if (body.code === 0 && body.data && body.data.url) {
          resolve(body.data);
          return;
        }
        const err = new Error(body.message || '上传失败');
        err.code = body.code || status;
        // 401 允许外层重登后重试（与 rawRequest 的 401 语义保持一致）
        if (status === 401) err.code = 401;
        reject(err);
      },
      fail: (e) => {
        const msg = String((e && e.errMsg) || '');
        if (/timeout/i.test(msg)) {
          reject(new Error('上传超时（照片较大或网络较慢），请重试或换小一点的照片'));
          return;
        }
        if (/cancel/i.test(msg)) {
          reject(new Error('已取消上传'));
          return;
        }
        reject(new Error(`上传失败：${msg || '网络异常'}，请检查网络后重试`));
      },
    });
    if (options.onProgress && task && typeof task.onProgressUpdate === 'function') {
      task.onProgressUpdate((res) => options.onProgress(res.progress));
    }
  });
}

module.exports = {
  env,
  login,
  bindAccount,
  deviceLogin,
  revokeDevice,
  request,
  get,
  post,
  put,
  del,
  uploadFile,
  uploadCheckPhoto,
  getToken,
  setAuth,
  getUser,
  setUser,
  clearAuth,
  logout,
  isLoggedOut,
  markLoggedOut,
  clearLoggedOut,
  isBound,
  // 登录后刷新缓存 / 页面权限换代（用户 2026-10-22「登录账户时一定要刷新缓存」）
  refreshCachesAfterLogin,
  permissionStale,
  markPermissionSynced,
};
