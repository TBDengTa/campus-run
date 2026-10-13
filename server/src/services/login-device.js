const crypto = require('crypto');
const LoginDevice = require('../models/login-device');

// 有效期与单用户上限（超出按最久未用淘汰）
const TTL_DAYS = 30;
const MAX_PER_USER = 5;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function deviceLabel(req) {
  const ua = (req && req.headers && req.headers['user-agent']) || '';
  return String(ua).slice(0, 120);
}

/**
 * 签发设备令牌（登录 / 绑定成功后调用）
 * 返回明文 token（仅此一次），客户端存本地用于「一键登录」
 */
async function issue(user, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  await LoginDevice.create({
    userId: user._id,
    account: user.account || user.realName || '',
    studentId: user.studentId || '',
    tokenHash: hashToken(token),
    label: deviceLabel(req),
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + TTL_DAYS * 86400000),
    revoked: false,
  });

  // 超出上限：淘汰最久未使用的（保留最新的 MAX_PER_USER 条）
  const stale = await LoginDevice.find({ userId: user._id, revoked: false })
    .sort({ lastUsedAt: -1 })
    .skip(MAX_PER_USER)
    .select('_id');
  if (stale.length) {
    await LoginDevice.deleteMany({ _id: { $in: stale.map((d) => d._id) } });
  }
  return token;
}

/**
 * 校验设备令牌：返回设备记录（未过期未撤销），否则 null
 */
async function verify(token) {
  const raw = String(token || '');
  if (raw.length < 32) return null;
  const doc = await LoginDevice.findOne({ tokenHash: hashToken(raw), revoked: false });
  if (!doc) return null;
  if (doc.expiresAt && doc.expiresAt <= new Date()) return null;
  doc.lastUsedAt = new Date();
  await doc.save();
  return doc;
}

// 撤销单个令牌（退出历史登录 / 用户删除记录）
async function revoke(token) {
  const raw = String(token || '');
  if (raw.length < 32) return false;
  const r = await LoginDevice.updateOne({ tokenHash: hashToken(raw) }, { $set: { revoked: true } });
  return r.modifiedCount > 0;
}

// 撤销该用户全部设备令牌（管理端"踢下线"/改密后可调用）
async function revokeAllForUser(userId) {
  const r = await LoginDevice.updateMany({ userId, revoked: false }, { $set: { revoked: true } });
  return r.modifiedCount;
}

module.exports = { issue, verify, revoke, revokeAllForUser, hashToken, TTL_DAYS, MAX_PER_USER };
