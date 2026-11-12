const express = require('express');
const fs = require('fs');
const path = require('path');
const morgan = require('morgan');
const config = require('./config');
const { notFound, errorHandler } = require('./middlewares/error');

function createApp() {
  const app = express();
  // 反向代理（Nginx / Caddy）后面：不开这一项 req.protocol 恒为 http，
  // 上传文件与广告落地页的绝对 URL 就会拼成 http://，在 https 站点上变成混合内容。
  // 只信任一层代理（1 = 最近一跳），避免客户端伪造 X-Forwarded-For。
  app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
  app.use(express.json({ limit: '2mb' }));
  if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

  // 请求计数 + 计时：给根路径状态页展示「API 运行状态 / 累计请求 / 本次耗时」用。
  // 用 bigint 纳秒计时，避免毫秒精度在快接口上全是 0。
  let served = 0;
  const bootAt = Date.now() - Math.floor(process.uptime() * 1000);
  // 构建号 = 部署包的文件时间（install.sh 同步代码时 mtime 会保留打包时刻）。
  // 用途（用户 2026-10-24「示例账户页一直显示未创建」）：排查「线上跑的到底是哪个版本」
  // 时，不用登服务器 —— 浏览器开 / 或 curl /health 就能看到构建时间，
  // 与部署动作对一下就知道新包有没有真正生效。
  let buildTag = '';
  try {
    buildTag = fs.statSync(path.join(__dirname, 'index.js')).mtime.toISOString();
  } catch (e) {
    /* 读不到不影响启动 */
  }
  // 应用版本号：唯一来源是 server/package.json（用户 2026-10-27「现在版本是 2.0.4 了」）。
  // 状态页标题与 /health 都从这里取，避免「部署包叫 2.0.0、页面写 2.0」这类不一致。
  let appVersion = '';
  try {
    appVersion = require('../package.json').version || '';
  } catch (e) {
    appVersion = '';
  }
  app.use((req, res, next) => {
    served += 1;
    req.__t0 = process.hrtime.bigint();
    next();
  });

  // 健康检查（部署探活 / 反代 upstream 检测用）：机器读的，保持纯 JSON
  // build=代码构建时间（见上方 buildTag），排查「线上跑的是哪个版本」时一条 curl 就能确认
  // version=应用版本号（来自 package.json），与状态页标题保持同源
  // no-store：探活必须打到源站才有意义 —— 若被边缘（EO/CDN）缓存了 200，
  // 源站挂了探活还在「报活」，等于没探（2026-11-09 EO 流量排查时一并补上）。
  app.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ts: Date.now(), build: buildTag, version: appVersion });
  });

  // 控制台页面与 API 要读这两份运行指标（见 routes/console.js 的 /public-status 与 dashboard）。
  // 用 app.set 传而不是把它们搬进全局：served / bootAt 是本函数的闭包变量，
  // 保持「谁产生谁持有」，静态目录与路由只读快照。
  app.set('consoleVersion', appVersion);
  app.set('consoleBuild', buildTag);
  app.set('consoleOps', () => ({
    served,
    bootAt,
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  }));

  /**
   * 根路径 = Web 控制台（用户 2026-10-29：「就直接 / 路径为登录页面，
   * 进入后是状态台与 AI 训练台的 B 端页面」）。
   *
   * 旧版这里是一段内联 HTML 的「后端状态页」。现在换成控制台后，
   * 运维原来靠它确认的那几件事（进程活着没 / 数据库连上没 / 部署的是哪个构建）
   * 由控制台登录页的 /console/api/public-status 继续提供 —— 只给运行指标，
   * **不再公开**待研判数量与 AI 判定阈值（根路径对公网开放，
   * 「刷到多少分会被封」告诉任何人等于教人绕过硬禁）。
   *
   * 页面骨架是静态文件（不含任何业务数据），数据一律登录后走 /console/api/*。
   * 未登录者拿到的 HTML 里没有任何数字，因此不需要鉴权。
   */
  app.get(['/', '/console', '/console/'], (req, res, next) => {
    // 控制台的响应头。页面本身不含业务数据，但它是「会带着会话凭证运行的页面」，
    // 所以安全头必须齐全：
    //   CSP：script-src 'self'（不放行内联脚本 → XSS 想执行代码必须先把文件落到服务器）；
    //        CSS 也是 'self'（因此 HTML 里禁止内联 style=""，已改为 class 工具类）。
    //   X-Frame-Options：DENY —— 防止把登录页框进钓鱼页面做点击劫持。
    //   no-store：登录页不缓存，避免共享电脑上留驻。
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; ');
    res.set('Content-Security-Policy', csp);
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('Cache-Control', 'no-store');
    // 资源引用注入 `?v=<该资源自己的 mtime>`：
    // 早前是死引用 /console/app.js，而服务器给它发 max-age=3天，
    // 于是「后端已修、前端文件已换」时浏览器还在跑旧版本 ——
    // 用户看到的报错与实际代码不同步，排查会被彻底带偏（2026-10-30 真实踩过）。
    //
    // ⚠️ 版本必须取**资源文件自己**的 mtime，不能取 buildTag（用户 2026-11-02「缓存问题没有修复」）：
    //   buildTag = server/src/index.js 的 mtime，而控制台代码在 public/console/app.js。
    //   只改 app.js 时 index.js 的 mtime 纹丝不动（实测线上 index.js 是 11 天前），
    //   于是 ?v= 永远不变 —— 缓存刷新的整套设计形同虚设。
    //   现在 css / js 各自取自己的 mtime：改了哪个就只让哪个失效，另一个继续复用缓存。
    // 读文件（而不是 sendFile）只为做这一次字符串替换；文件极小（<30KB），无需缓存。
    const assetVersion = (file) => {
      try {
        return encodeURIComponent(fs.statSync(path.join(__dirname, '../public/console', file)).mtime.toISOString());
      } catch (e) {
        // 读不到（文件缺失/权限）回落到构建号/版本号，至少 URL 稳定，不影响页面可用
        return encodeURIComponent(String(buildTag || appVersion || '1'));
      }
    };
    fs.readFile(path.join(__dirname, '../public/console/index.html'), 'utf8', (err, html) => {
      if (err) return next(err);
      const out = html
        .replace('/console/app.css"', `/console/app.css?v=${assetVersion('app.css')}"`)
        .replace('/console/app.js"', `/console/app.js?v=${assetVersion('app.js')}"`);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(out);
    });
  });

  // 控制台静态资源（CSS / JS 外链，配合 CSP 不放行内联脚本，见 routes/console.js）。
  //
  // ⚠️ 缓存策略曾害过一次「改了但没生效」（用户 2026-10-30：控制台登录报
  // 「没有任何反作弊查看权限」，后端与前端都已修好并推送，浏览器却还在跑旧 app.js）。
  // 线上实测响应头是 max-age=259200（3 天），改一版控制台要等三天才被看到。
  // 现在两层都拆掉：
  //   ① 页面里的资源引用带 `?v=<buildTag>`（见下面 /console、/ 的 sendFile 前的替换），
  //      代码一换 URL 就变，浏览器必然重新拉；
  //   ② 静态资源本身仍留 1 小时缓存（同一次会话内复用），但配 etag/last-modified，
  //      内容没变就是 304，变了立刻命中。
  // 于是「改了没生效」不再需要靠清缓存解释。
  app.use(
    '/console',
    express.static(path.join(__dirname, '../public/console'), {
      maxAge: '1h',
      index: false, // 目录索引关掉：/console/ 由上面的显式路由发页面
      etag: true,
      lastModified: true,
      setHeaders(res2) {
        res2.set('X-Content-Type-Options', 'nosniff');
      },
    })
  );

  // 控制台 API（账号密码登录 + HttpOnly Cookie 会话，与小程序 JWT 完全隔离）
  app.use('/console/api', require('./routes/console'));

  // 广告落地页直出
  // Cache-Control: public, max-age=60 —— 之前完全没声明缓存策略，「是否被 EO/CDN 缓存」
  // 全听边缘默认规则（2026-11-09 EO 流量排查发现）。落地页内容管理端随时可改，
  // 给 1 分钟短缓存：改完最多 1 分钟全网生效，同时高频打开的落地页不必每次回源。
  // 曝光统计走 POST /api/ads/:id/pv（在 /api/* 的 no-store 域内），不受这里影响。
  app.get('/p/:slug', async (req, res, next) => {
    try {
      const AdPage = require('./models/ad-page');
      const page = await AdPage.findOne({ slug: req.params.slug, enabled: true }).lean();
      if (!page) return res.status(404).send('页面不存在');
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=60');
      res.send(page.htmlContent || '<!doctype html><p>空页面</p>');
    } catch (e) {
      next(e);
    }
  });

  // 上传文件静态服务
  //
  // `immutable`（用户 2026-11-09 EO 流量排查补的）：边缘/浏览器在有效期内
  // **不必回源校验**，省掉大量 304 回源流量。
  //
  // ⚠️ 为什么这里加 immutable 是安全的（这点必须核实过，写错会让人以为「改了头像
  // 看不到新的」）：文件名是 `Date.now()-<随机6位><ext>`（utils/uploader.js::filename），
  // **每次上传都是新文件名 → 新 URL**，同一个 URL 的内容在事实上永不改变。
  // （注：AGENTS.md 里写的是「文件名是内容 SHA」——与实际实现不符，实际是时间戳+随机。
  //  两种策略在 immutable 上等价：只要「同 URL 内容不变」成立，immutable 就成立。）
  // 删除旧头像时只删磁盘文件，旧 URL 404 —— 不会出现「缓存里还是旧图」的错觉。
  app.use(
    '/uploads',
    express.static(path.join(__dirname, '../uploads'), {
      maxAge: '7d',
      immutable: true,
      setHeaders(res) {
        // 显式写全，避免不同 Express 版本对 immutable 的序列化差异
        res.set('Cache-Control', 'public, max-age=604800, immutable');
        res.set('X-Content-Type-Options', 'nosniff');
      },
    })
  );

  // 小程序 API 一律不缓存（2026-11-09 EO 流量排查补的防护，改之前先读这段）：
  // 之前 /api/* 20 组路由**没有任何 Cache-Control**，而 console 域早就有了 no-store ——
  // 也就是说「会不会被 EO/CDN 边缘缓存」完全听天由命：EO 若按默认/扩展名规则缓存了
  // GET 响应，学生拿到的是边缘的旧榜单/旧公告（脏数据），源站还被白扣回源流量。
  // API 全是带 Authorization 的动态数据，绝无可缓存的理由，统一 no-store 最稳。
  // 注意：必须挂在下面所有 app.use('/api/...') **之前**（Express 按注册顺序执行）。
  // EO 控制台侧也要确认缓存模式是「遵循源站」，强制缓存会无视源站头（见 docs/edgeone-traffic.md）。
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/roster', require('./routes/roster'));
  app.use('/api/run', require('./routes/run'));
  app.use('/api/ranking', require('./routes/ranking'));
  app.use('/api/points', require('./routes/points'));
  app.use('/api/goal', require('./routes/goal'));
  app.use('/api/reward-video', require('./routes/reward-video'));
  // 北斗运动 2.0（签到 + 转盘抽步数 + 看视频/分享得次数）：见 docs/beidou-lottery-plan.md
  app.use('/api/beidou', require('./routes/beidou'));
  app.use('/api/water', require('./routes/water'));
  app.use('/api/badges', require('./routes/badge'));
  app.use('/api/appeals', require('./routes/appeal'));
  app.use('/api/ads', require('./routes/ad'));
  app.use('/api/org', require('./routes/org'));
  // 班级域：班主任 / 班委的只读数据面（成员资格校验，不用 requirePermission）
  app.use('/api/class', require('./routes/class'));
  // 学生会域：检查录入 / 复核 / 申诉（学生会成员资格 + 模块归属 + 院系范围三重校验）
  app.use('/api/union', require('./routes/union'));
  app.use('/api/content', require('./routes/content'));
  app.use('/api/upload', require('./routes/upload'));
  app.use('/api/admin', require('./routes/admin'));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
