require('dotenv').config();

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
  // 迁移脚本用
  legacyMongoUri: process.env.LEGACY_MONGO_URI || '',
  legacyDbName: process.env.LEGACY_MONGO_DB_NAME || '',
};

if (!config.jwtSecret) {
  console.warn('[config] JWT_SECRET 未配置，请在 .env 中设置，生产环境启动将拒绝。');
}

module.exports = config;
