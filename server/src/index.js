const mongoose = require('mongoose');
const config = require('./config');
const { createApp } = require('./app');

// ===== 启动期错误的可操作提示 =====
// 生产上最常见的两类失败，统一翻译成「该怎么改」，而不是把驱动的原始报错直接抛给人看：
//   ① Command listIndexes requires authentication —— MONGO_URI 没带账号密码（或 authSource 不对）。
//      MongoDB 开启了认证时，连接本身会成功（握手不需要权限），但一建索引就 401，
//      报错信息完全看不出「是连接串缺凭据」这件事，历史上排查成本很高。
//   ② 连接超时 / 拒绝 —— MONGO_URI 主机端口不对、mongod 没起、或云库白名单没放行。
function explainStartupError(err) {
  const msg = String((err && err.message) || err || '');
  if (/requires authentication|not authorized|Authentication failed/i.test(msg)) {
    return [
      '数据库鉴权失败：MONGO_URI 里没有带账号密码，或 authSource 不对。',
      '  当前 MongoDB 启用了认证（--auth），必须在连接串里写凭据，形如：',
      '    MONGO_URI=mongodb://<用户名>:<密码>@127.0.0.1:27017/?authSource=admin',
      '  注意：',
      '    · 密码含 @ : / ? # 等字符时必须 URL 编码（如 @ → %40）；',
      '    · 账号要建在 admin 库并授予目标库权限，authSource 一般写 admin；',
      '    · 若数据库就在本机且暂时不想配认证，可编辑 /etc/mongod.conf 注释掉 security.authorization 后重启 mongod。',
    ].join('\n');
  }
  if (/ECONNREFUSED|Server selection timed out|connect ETIMEDOUT|ENOTFOUND/i.test(msg)) {
    return [
      '连不上数据库：检查 MONGO_URI 的主机/端口是否正确、mongod 是否已启动。',
      '    · 本机：systemctl status mongod，连接串一般是 mongodb://127.0.0.1:27017',
      '    · 云数据库：确认实例白名单已放行本机公网/内网 IP',
    ].join('\n');
  }
  return msg;
}

async function main() {
  if (!config.jwtSecret) {
    console.error('[启动失败] 请先复制 .env.example 为 .env 并配置 JWT_SECRET');
    process.exit(1);
  }
  // URI 可能带 ?authSource=... 查询参数，库名须插在参数之前
  const [base, query] = config.mongoUri.split('?');
  const uri = `${base.replace(/\/$/, '')}/${config.dbName}${query ? `?${query}` : ''}`;
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 8000,
    });
  } catch (e) {
    // 连接阶段失败（主机不通 / 认证不过）：给出可操作提示后退出，别让 systemd 无限重启刷日志
    console.error(`[启动失败] ${explainStartupError(e)}`);
    process.exit(1);
  }
  console.log(`[mongo] 已连接 ${config.dbName}`);

  // 启动期建索引 / 播种：这些操作**需要写权限**，认证缺失时正是在这里暴露
  // （连接不报错，一 listIndexes 就 "requires authentication"）。统一包一层翻译。
  try {
    await bootstrap();
  } catch (e) {
    console.error(`[启动失败] ${explainStartupError(e)}`);
    process.exit(1);
  }
  await listen();
}

// 播种权限目录/内置权限组，并迁移旧版 admin/user 角色（幂等）
async function bootstrap() {
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

  // 播种班超与学生会地基（幂等）：
  //   ① 学生会内置部门（主席团 / 生活部 / 学习部 / 纪检部）
  //   ② 检查模块注册表（卫生 / 晚自习 / 查宿 / 早操 / 早八）—— key 与录入鉴权口径以代码为准
  const { seedUnionDepartments } = require('./services/union');
  await seedUnionDepartments();
  const { seedCheckModules } = require('./services/check-modules');
  await seedCheckModules();
  // ③ 宿舍 / 混宿归属的索引迁移（幂等，只动索引不动数据）：
  //    「唯一槽位」索引必须含 className —— 混宿房间与共管卫生区一次检查要按归属班级各存一条，
  //    旧索引会把第二个班那条直接拒掉。Mongoose 不会替换已存在的索引，所以这里显式建新、删旧。
  try {
    const { migrateSlotIndex } = require('./services/dorms');
    await migrateSlotIndex();
  } catch (e) {
    console.warn('[dorms] 槽位索引迁移失败（不影响启动，但混宿记录可能仍被旧索引拒收）:', e.message);
  }
  // ③b 学生会成员「唯一索引」迁移（同类陷阱）：
  //     成员唯一键原先不含 schoolId，而校区口径下分院记录的 departmentId 恒为 null →
  //     「北校区分会-生活部」与「洋河校区分会-生活部」在旧键下撞成同一个键，第二条被拒收导致 500。
  //     必须显式删旧索引，否则 Mongoose 只会新建新索引、把旧的留着继续拦。
  try {
    const { migrateMemberUniqueIndex } = require('./services/union');
    await migrateMemberUniqueIndex();
  } catch (e) {
    console.warn('[union] 成员唯一索引迁移失败（不影响启动，但第二个校区的同名部门成员可能仍被拒收）:', e.message);
  }
  // ④ 班级台账（class_profiles）：**仅在整表为空时**首次生成，之后由管理端「从学籍同步」按钮触发，
  //    避免每次启动都全表扫描 users（参考 AGENTS.md 关于启动期迁移必须只在首次生效的约定）
  const ClassProfile = require('./models/class-profile');
  if ((await ClassProfile.estimatedDocumentCount()) === 0) {
    const { syncClassProfiles } = require('./services/class-profiles');
    const seeded = await syncClassProfiles({});
    console.log(`[class_profiles] 首次生成 ${seeded.created} 个班级台账`);
  }
}

// 启动 HTTP 服务 + 注册优雅退出
async function listen() {
  const app = createApp();
  // 监听地址：生产环境默认只监听 127.0.0.1（由 Nginx 反代对外），
  // 想直接对公网暴露再设 HOST=0.0.0.0。
  const host = process.env.HOST || '0.0.0.0';
  const server = app.listen(config.port, host, () => {
    console.log(`[server] 校园跑 2.0 后端已启动: http://${host}:${config.port}`);
  });

  // 优雅退出：systemd stop / 手动 kill 时先停止接收新连接，再关 Mongo 连接，
  // 避免请求处理到一半被强杀导致 502 或半写状态。
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[server] 收到 ${signal}，正在优雅退出…`);
    server.close(() => {
      mongoose.connection.close(false).finally(() => {
        console.log('[server] 已退出');
        process.exit(0);
      });
    });
    // 兜底：10 秒内没关完就强退（systemd 默认 90s 会先 SIGKILL，这里更早收尾）
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[启动失败]', err.message);
  process.exit(1);
});
