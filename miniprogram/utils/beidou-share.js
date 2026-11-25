const auth = require('./request');

/**
 * 北斗运动 3.0 分享归因（客户端唯一实现）。
 *
 * 微信没有「分享成功」回调：onShareAppMessage 在面板弹出时就触发，用户点取消也算。
 * 所以「分享后必须有其他用户点击才算」只能这么做：
 *   ① 分享卡路径带一个随机令牌（/pages/splash/splash?bdshare=xxx）；
 *   ② 接收方冷/热启动时把令牌存到本地 pending（未登录也能存）；
 *   ③ 登录后由 app/home 调 POST /api/beidou/share/click，
 *      服务端确认「另一个已登录用户点开」后才给分享者发铜版。
 *
 * 五条硬约束：
 *   · 未登录/未绑定不发请求（没有 openid，服务端无法判重）；
 *   · 失败一律静默，绝不能阻塞启动/首页；
 *   · 只保留最近一个令牌（同时点开多个分享卡时以最后一次为准）；
 *   · 7 天过期；任何 HTTP 响应后清除，避免每次 onShow 重复请求；
 *   · 只有服务端返回 rewarded=true 才提示「已为好友助力」。
 */

const STORAGE_KEY = 'tt_beidou_share_ref';
const MAX_AGE_MS = 7 * 86400000;
let inflight = null;

function storage() {
  try {
    if (typeof wx === 'undefined' || !wx.getStorageSync) return null;
    return wx;
  } catch (e) {
    return null;
  }
}

function tokenOf(options) {
  if (!options || typeof options !== 'object') return '';
  const raw = options.bdshare || (options.query && options.query.bdshare) || '';
  const token = String(raw || '').trim();
  return /^[a-f0-9]{16,64}$/i.test(token) ? token.toLowerCase() : '';
}

function capture(options) {
  const token = tokenOf(options);
  if (!token) return '';
  const w = storage();
  if (!w) return token;
  try {
    w.setStorageSync(STORAGE_KEY, { token, at: Date.now() });
  } catch (e) {
    /* storage 不可用则本次无法归因，不影响业务 */
  }
  return token;
}

function pending() {
  const w = storage();
  if (!w) return null;
  try {
    const data = w.getStorageSync(STORAGE_KEY);
    if (!data || !data.token) return null;
    if (!data.at || Date.now() - Number(data.at) > MAX_AGE_MS) {
      w.removeStorageSync(STORAGE_KEY);
      return null;
    }
    return data;
  } catch (e) {
    return null;
  }
}

function clear() {
  const w = storage();
  if (!w) return;
  try {
    w.removeStorageSync(STORAGE_KEY);
  } catch (e) {
    /* ignore */
  }
}

/**
 * 把本地 pending 令牌上报给服务端。
 * @returns {Promise<{rewarded?:boolean, duplicated?:boolean, success?:boolean, message?:string}|null>}
 */
async function flush() {
  if (inflight) return inflight;
  if (!auth.isBound || !auth.isBound()) return null;
  const data = pending();
  if (!data) return null;
  inflight = (async () => {
    try {
      const res = await auth.post('/api/beidou/share/click', { token: data.token });
      // 任何 HTTP 响应（成功/重复/过期/自己点/上限）都清除：重试也不会变成成功
      clear();
      return res || null;
    } catch (e) {
      // 网络异常/服务不可用：保留 pending，下次启动/回首页再试
      console.warn('[beidou-share] 助力上报失败（保留待下次重试）', e && e.message);
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

module.exports = {
  STORAGE_KEY,
  capture,
  pending,
  clear,
  flush,
  _tokenOf: tokenOf,
};
