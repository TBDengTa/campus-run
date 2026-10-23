// 显式指定 .env 路径（server/.env），而不是依赖 process.cwd()：
//   · systemd 下 cwd 是 WorkingDirectory，正常；
//   · 手工从别的目录 `node /opt/campus-run/server/src/index.js` 启动时 cwd 不是 server/，
//     默认解析会读不到 .env → 表现为「JWT_SECRET 未配置」或连错数据库。
// path.resolve(__dirname, '../../.env') = server/.env（本文件在 server/src/config/ 下）。
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const config = {
  port: Number(process.env.PORT || 3000),
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017',
  dbName: process.env.MONGO_DB_NAME || 'campus_run',
  jwtSecret: process.env.JWT_SECRET || '',
  jwtExpireDays: Number(process.env.JWT_EXPIRE_DAYS || 30),
  wxAppId: process.env.WX_APPID || '',
  wxAppSecret: process.env.WX_APPSECRET || '',
  adminBootstrapOpenids: (process.env.ADMIN_BOOTSTRAP_OPENIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  adPageBaseUrl: process.env.AD_PAGE_BASE_URL || '',
  uploadMaxMb: Number(process.env.UPLOAD_MAX_MB || 5),
  // 本地测试登录：DEV_LOGIN=true 时接受 dev-student/dev-teacher/dev-admin 约定 code
  devLogin: process.env.DEV_LOGIN === 'true',
  // 学校后台名单推送密钥（不配置则推送接口关闭）
  rosterPushKey: process.env.ROSTER_PUSH_KEY || '',
  // 迁移脚本用
  legacyMongoUri: process.env.LEGACY_MONGO_URI || '',
  legacyDbName: process.env.LEGACY_MONGO_DB_NAME || '',
};

if (!config.jwtSecret) {
  console.warn('[config] JWT_SECRET 未配置，请在 .env 中设置，生产环境启动将拒绝。');
}

module.exports = config;
