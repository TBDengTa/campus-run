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

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || '';
}

function setAuth(token, userInfo) {
  wx.setStorageSync(TOKEN_KEY, token);
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
}

let loginPromise = null;

// 静默登录：wx.login → code → 后端换 token
// 本地测试模式（env.DEV_LOGIN）直接用约定角色 code，无需微信 AppSecret
function login() {
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
      setAuth(data.token, data.userInfo);
      getApp().globalData.userInfo = data.userInfo;
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

// 业务请求：401 时自动重登一次再试
async function request(options) {
  try {
    return await rawRequest(options);
  } catch (e) {
    if (e.code === 401 && !options._noAuthRetry) {
      await login();
      return rawRequest({ ...options, _noAuthRetry: true });
    }
    throw e;
  }
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
};
