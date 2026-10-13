// 本地登录历史：登录成功后记录账号，登录页可一键登录
// 说明：不存密码，只存服务端签发的 deviceToken（30 天有效、可撤销、用后轮换）
const KEY = 'tt_login_history';
const MAX = 5;

function list() {
  try {
    const arr = wx.getStorageSync(KEY);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function save(list_) {
  try {
    wx.setStorageSync(KEY, list_.slice(0, MAX));
  } catch (e) {
    // 忽略存储异常
  }
}

function keyOf(entry) {
  return `${entry.account || ''}|${entry.studentId || ''}`;
}

// 记录/更新一条历史登录（登录成功后调用）
function push(userInfo, deviceToken) {
  if (!userInfo || !deviceToken) return list();
  const entry = {
    account: userInfo.account || userInfo.realName || '',
    name: userInfo.realName || userInfo.account || userInfo.nickname || '未实名',
    studentId: userInfo.studentId || '',
    className: userInfo.className || '',
    departmentName: userInfo.departmentName || '',
    role: userInfo.role || 'student',
    deviceToken,
    lastAt: Date.now(),
  };
  const rest = list().filter((e) => keyOf(e) !== keyOf(entry));
  const next = [entry, ...rest].slice(0, MAX);
  save(next);
  return next;
}

// 更新某条记录的令牌（一键登录后服务端会轮换令牌）
function refreshToken(account, studentId, deviceToken) {
  const next = list().map((e) =>
    e.account === account && (e.studentId || '') === (studentId || '')
      ? { ...e, deviceToken, lastAt: Date.now() }
      : e
  );
  save(next);
  return next;
}

// 删除一条记录（同时由调用方撤销服务端令牌）
function remove(account, studentId) {
  const next = list().filter((e) => !(e.account === account && (e.studentId || '') === (studentId || '')));
  save(next);
  return next;
}

function find(account, studentId) {
  return list().find((e) => e.account === account && (e.studentId || '') === (studentId || '')) || null;
}

function clear() {
  try {
    wx.removeStorageSync(KEY);
  } catch (e) {
    // 忽略
  }
}

module.exports = { list, push, refreshToken, remove, find, clear, MAX };
