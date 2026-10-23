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

// 异步 scrypt（跑在 libuv 线程池，可并行；导入等大批量建户场景避免同步计算阻塞事件循环）
function scryptAsync(plain, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(plain), salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPasswordAsync(plain) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(plain, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// 一组初始密码的哈希集合：passwordHash 复用首个初始哈希（同用户内共用同一哈希串无安全损失），
// resetHashes 与 initialHashes 是同一组密码的同一组哈希，无需重复计算
async function hashInitialPasswordSet(initials) {
  const initialHashes = await Promise.all(initials.map((p) => hashPasswordAsync(p)));
  return { passwordHash: initialHashes[0], initialHashes, resetHashes: initialHashes };
}

module.exports = {
  hashPassword,
  verifyPassword,
  matchesAnyInitial,
  last8,
  validateNewPassword,
  hashPasswordAsync,
  hashInitialPasswordSet,
};
