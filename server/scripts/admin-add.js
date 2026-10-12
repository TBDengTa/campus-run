/**
 * 将指定 openid 设为管理员
 * 用法：node scripts/admin-add.js <openid> [--remove]
 */
const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const config = require('../src/config');

async function main() {
  const openid = process.argv[2];
  const remove = process.argv.includes('--remove');
  if (!openid) {
    console.error('用法: node scripts/admin-add.js <openid> [--remove]');
    process.exit(1);
  }
  const [base, query] = config.mongoUri.split('?');
  const uri = `${base.replace(/\/$/, '')}/${config.dbName}${query ? `?${query}` : ''}`;
  await mongoose.connect(uri);
  const User = require('../src/models/user');
  const user = await User.findOne({ openid });
  if (!user) {
    console.error(`未找到 openid=${openid} 的用户（该用户需先在小程序中登录过一次）`);
    process.exit(1);
  }
  user.role = remove ? 'user' : 'admin';
  await user.save();
  console.log(`已${remove ? '撤销' : '授予'}管理员: ${user.nickname || user.realName || openid} (role=${user.role})`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('执行失败:', e.message);
  process.exit(1);
});
