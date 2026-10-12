const crypto = require('crypto');
const config = require('../config');
const { ApiError } = require('../utils/response');

// 微信 code2session：code 换 openid + session_key
async function code2session(code) {
  if (!config.wxAppId || !config.wxAppSecret) {
    throw new ApiError(500, 500001, '服务端未配置 WX_APPID/WX_APPSECRET');
  }
  const url =
    'https://api.weixin.qq.com/sns/jscode2session' +
    `?appid=${encodeURIComponent(config.wxAppId)}` +
    `&secret=${encodeURIComponent(config.wxAppSecret)}` +
    `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.errcode) {
    throw new ApiError(401, 401002, `微信登录失败(${data.errcode})：${data.errmsg}`);
  }
  return data; // { openid, session_key, unionid? }
}

function base64Decode(str) {
  return Buffer.from(str, 'base64');
}

// 解密微信运动数据（wx.getWeRunData 的 encryptedData/iv）
function decryptWeRun(sessionKey, encryptedData, iv) {
  try {
    const key = base64Decode(sessionKey);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, base64Decode(iv));
    decipher.setAutoPadding(true);
    let decoded = decipher.update(Buffer.from(encryptedData, 'base64'), undefined, 'utf8');
    decoded += decipher.final('utf8');
    const json = JSON.parse(decoded);
    if (json.watermark && json.watermark.appid !== config.wxAppId) {
      throw new Error('watermark appid 不匹配');
    }
    return json; // { stepInfoList: [{ timestamp, step }, ...最近30天] }
  } catch (e) {
    throw new ApiError(400, 400001, '微信运动数据解密失败（sessionKey 可能已过期，请重新登录）');
  }
}

// 由步数估算距离/卡路里（微信运动仅提供步数时的粗略估算）
function estimateFromSteps(steps) {
  const distance = Math.round(steps * 0.7); // 约 0.7 米/步
  const calories = Math.round(steps * 0.04);
  const durationSeconds = Math.round(steps * 0.5); // 约 0.5 秒/步
  return { distance, calories, durationSeconds };
}

// 秒 → 配速字符串 "12'03""
function formatPace(durationSeconds, distanceMeters) {
  if (!distanceMeters || !durationSeconds) return '';
  const paceSeconds = (durationSeconds / (distanceMeters / 1000));
  if (!isFinite(paceSeconds) || paceSeconds <= 0) return '';
  const m = Math.floor(paceSeconds / 60);
  const s = Math.round(paceSeconds % 60);
  return `${m}'${String(s).padStart(2, '0')}"`;
}

module.exports = { code2session, decryptWeRun, estimateFromSteps, formatPace };
