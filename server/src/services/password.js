const crypto = require('crypto');

// scrypt 加盐哈希（Node 内置，无额外依赖）
// 格式: scrypt$<salt hex>$<hash hex>
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expect = Buffer.from(parts[2], 'hex');
    const actual = crypto.scryptSync(String(plain), salt, 32, { N: 16384, r: 8, p: 1 });
    return actual.length === expect.length && crypto.timingSafeEqual(actual, expect);
  } catch (e) {
    return false;
  }
}

// 密码是否命中任一初始密码（学号后8 / 身份证后8）
function matchesAnyInitial(plain, initialHashes) {
  if (!Array.isArray(initialHashes)) return false;
  return initialHashes.some((h) => verifyPassword(plain, h));
}

// 由学号/身份证生成初始密码：后 8 位
function last8(str) {
  const s = String(str || '').trim();
  return s.length >= 8 ? s.slice(-8) : '';
}

// 新密码校验：6-20 位， printable
function validateNewPassword(pwd) {
  const s = String(pwd || '');
  if (s.length < 6 || s.length > 20) return '新密码长度需为 6-20 位';
  if (!/^[\x21-\x7e\u4e00-\u9fa5A-Za-z0-9]+$/.test(s)) return '新密码包含非法字符';
  return null;
}

module.exports = { hashPassword, verifyPassword, matchesAnyInitial, last8, validateNewPassword };
