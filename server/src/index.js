const mongoose = require('mongoose');
const config = require('./config');
const { createApp } = require('./app');

async function main() {
  if (!config.jwtSecret) {
    console.error('[启动失败] 请先复制 .env.example 为 .env 并配置 JWT_SECRET');
    process.exit(1);
  }
  // URI 可能带 ?authSource=... 查询参数，库名须插在参数之前
  const [base, query] = config.mongoUri.split('?');
  const uri = `${base.replace(/\/$/, '')}/${config.dbName}${query ? `?${query}` : ''}`;
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8000,
  });
  console.log(`[mongo] 已连接 ${config.dbName}`);

  // 播种权限目录/内置权限组，并迁移旧版 admin/user 角色（幂等）
  const { seedRbac } = require('./services/rbac');
  await seedRbac();

  // 启动时确保全局配置存在
  const GoalConfig = require('./models/goal-config');
  await GoalConfig.getSingleton();

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[server] 校园跑 2.0 后端已启动: http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('[启动失败]', err.message);
  process.exit(1);
});
