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

  // 播种内置广告位（幂等）：首页轮播 / 开屏 / 记录页卡片 / 排行榜卡片
  const { seedAdSlots } = require('./services/ads');
  await seedAdSlots();

  // 徽章地基（幂等）：库里已有任何徽章定义时播种整体跳过（只服务全新部署），
  // 并把旧数据里「有 tierGroup 但没有 mode」的定义回填为 mode='tier'；均不覆盖运营已改字段
  const { seedBadges, backfillBadgeModes } = require('./services/badges');
  await backfillBadgeModes();
  await seedBadges();

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
