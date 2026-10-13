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
function logout() {
  clearAuth();
  markLoggedOut();
  try {
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.userInfo = null;
      if (app.globalData.today !== undefined) app.globalData.today = null;
    }
  } catch (e) {
    // App 未就绪时忽略
  }
}

let loginPromise = null;

// 静默登录：wx.login → code → 后端换 token
// 本地测试模式（env.DEV_LOGIN）直接用约定角色 code，无需微信 AppSecret
// 注意：用户主动退出登录后不再静默登录，必须由登录页显式调用（先 clearLoggedOut）
function login() {
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
        data: { code },
        _noAuthRetry: true,
      })
    )
    .then((data) => {
      // 游客（未绑定名单账号）只存 token，不标记为已登录
      setAuth(data.token, data.userInfo, data.bound !== false);
      getApp().globalData.userInfo = data.userInfo || null;
      // 记录登录历史（供登录页一键登录）
      if (data.bound !== false && data.deviceToken) history.push(data.userInfo, data.deviceToken);
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
          const err = new Error(body.message || '账号已被封禁');
          err.code = 403001;
          err.banned = body.banned;
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
function bindAccount(account, password) {
  return rawRequest({
    url: '/api/auth/bind',
    method: 'POST',
    data: { account, password },
    _noAuthRetry: true,
  }).then((data) => {
    setAuth(data.token, data.userInfo, true);
    getApp().globalData.userInfo = data.userInfo;
    if (data.deviceToken) history.push(data.userInfo, data.deviceToken);
    return data;
  });
}

// 设备令牌一键登录（登录页历史登录列表）
function deviceLogin(deviceToken) {
  return rawRequest({
    url: '/api/auth/device-login',
    method: 'POST',
    data: { deviceToken },
    _noAuthRetry: true,
  }).then((data) => {
    clearLoggedOut(); // 主动登录动作
    setAuth(data.token, data.userInfo, true);
    getApp().globalData.userInfo = data.userInfo;
    // 服务端已轮换令牌：覆盖本地历史里的旧令牌
    if (data.deviceToken && data.userInfo) {
      history.refreshToken(data.userInfo.account || data.userInfo.realName, data.userInfo.studentId, data.deviceToken);
    }
    return data;
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

// 上传文件（管理端广告图等）
function uploadFile(filePath) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${env.BASE_URL}/api/admin/upload`,
      filePath,
      name: 'file',
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
};
