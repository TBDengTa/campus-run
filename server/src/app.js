const express = require('express');
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
  app.use((req, res, next) => {
    served += 1;
    req.__t0 = process.hrtime.bigint();
    next();
  });

  // 健康检查（部署探活 / 反代 upstream 检测用）：机器读的，保持纯 JSON
  app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

  /**
   * 根路径：给人看的状态页。
   *
   * 为什么需要它：这个服务是纯 API，站点根路径本来没有任何页面。
   * 部署完用浏览器访问域名时，若只返回 `{"code":404,"message":"接口不存在"}`，
   * 运维根本分不清「服务正常但没这个路由」还是「服务挂了/反代没通」——
   * 用户就反馈过「我都不知道通没通」。给一个明确说「服务运行中」的页面最省事。
   *
   * 只暴露非敏感信息（是否运行、运行多久、数据库连接状态）；
   * 不输出连接串、主机名、环境变量，避免信息泄漏。
   */
  app.get('/', (req, res) => {
    const mongoose = require('mongoose');
    // readyState: 0 未连接 / 1 已连接 / 2 连接中 / 3 断开中
    const dbReady = mongoose.connection && mongoose.connection.readyState === 1;
    const apiOk = dbReady; // 页面能渲染出来 = HTTP 层正常；数据库不可用则整体判定为异常

    // 运行时长：按天/时/分/秒各自显示，天以上也看得懂
    const upSec = Math.floor(process.uptime());
    const d = Math.floor(upSec / 86400);
    const h = Math.floor((upSec % 86400) / 3600);
    const m = Math.floor((upSec % 3600) / 60);
    const s = upSec % 60;
    const upParts = [];
    if (d) upParts.push(`${d} 天`);
    if (h) upParts.push(`${h} 小时`);
    if (m) upParts.push(`${m} 分`);
    upParts.push(`${s} 秒`);
    const upText = upParts.join(' ');

    const fmt = (ts) =>
      new Date(ts).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
    const bootText = fmt(bootAt);
    const time = fmt(Date.now());

    // 本次请求在服务端花了多久（从中间件计时到渲染前），单位毫秒，保留 1 位
    const costMs = req.__t0 ? Number(process.hrtime.bigint() - req.__t0) / 1e6 : 0;
    const costText = costMs < 10 ? costMs.toFixed(1) : String(Math.round(costMs));

    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!-- 状态页每 30 秒自动刷新：运维盯屏时不用手动 F5 也能看到最新运行时长 -->
<meta http-equiv="refresh" content="30">
<title>唐唐快跑 · 后端服务</title>
<style>
  :root{--brand:#ff6b00;--text:#1f2329;--sub:#646a73;--ok:#2ba471;--bad:#e34d59;--line:#eceef1}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#f6f7f9;color:var(--text);
       font:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
  .card{width:min(580px,92vw);background:#fff;border-radius:16px;padding:32px 28px;
        box-shadow:0 8px 28px rgba(31,35,41,.08)}
  .row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .dot{width:10px;height:10px;border-radius:50%;background:var(--ok);flex:none;
       box-shadow:0 0 0 4px rgba(43,164,113,.15)}
  .dot.bad{background:var(--bad);box-shadow:0 0 0 4px rgba(227,77,89,.15)}
  h1{font-size:20px;margin:0}
  .brand{color:var(--brand)}
  .sub{color:var(--sub);font-size:13px;line-height:1.8;margin:12px 0 20px}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:11px 18px;font-size:14px;
      padding:18px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
  .k{color:var(--sub);white-space:nowrap}
  .v{font-weight:600;font-variant-numeric:tabular-nums;word-break:break-all}
  .ok{color:var(--ok)} .bad{color:var(--bad)}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
  .links{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}
  a{display:inline-block;padding:9px 16px;border-radius:999px;text-decoration:none;
    font-size:13px;font-weight:600;color:var(--brand);background:#fff4ec}
  a.primary{background:var(--brand);color:#fff}
  code{background:#f2f3f5;padding:1px 6px;border-radius:4px;font-size:12px}
</style></head>
<body><div class="card">
  <div class="row"><span class="dot${apiOk ? '' : ' bad'}"></span>
    <h1>唐唐快跑 <span class="brand">2.0</span> 后端服务${apiOk ? '运行中' : '异常'}</h1></div>
  <p class="sub">这是一个纯 API 服务，没有网页界面。<br>
    如果你看到这个页面，说明<strong>服务进程正常、反向代理也通了</strong>。</p>
  <div class="kv">
    <span class="k">API 运行状态</span>
    <span class="v ${apiOk ? 'ok' : 'bad'}">${apiOk ? '正常' : '异常'} · 本次响应 ${costText} ms</span>

    <span class="k">累计处理请求</span>
    <span class="v">${served.toLocaleString('zh-CN')} 次</span>

    <span class="k">后端启动时间</span>
    <span class="v mono">${bootText}</span>

    <span class="k">运行时长</span>
    <span class="v">${upText}</span>

    <span class="k">数据库</span>
    <span class="v ${dbReady ? 'ok' : 'bad'}">${dbReady ? '已连接' : '未连接'}</span>

    <span class="k">内存占用</span>
    <span class="v">${rssMb} MB</span>

    <span class="k">服务器时间</span>
    <span class="v mono">${time}</span>
  </div>
  <div class="links">
    <a class="primary" href="/health">健康检查 /health</a>
    <a href="/api/content/announcements">公告接口示例</a>
    <a href="/">刷新</a>
  </div>
  <p class="sub" style="margin-top:18px">小程序端请求的是 <code>/api/*</code> 接口；
    本页仅用于确认部署是否成功。页面每 30 秒自动刷新。</p>
</div></body></html>`);
  });

  // 广告落地页直出
  app.get('/p/:slug', async (req, res, next) => {
    try {
      const AdPage = require('./models/ad-page');
      const page = await AdPage.findOne({ slug: req.params.slug, enabled: true }).lean();
      if (!page) return res.status(404).send('页面不存在');
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(page.htmlContent || '<!doctype html><p>空页面</p>');
    } catch (e) {
      next(e);
    }
  });

  // 上传文件静态服务
  app.use('/uploads', express.static(path.join(__dirname, '../uploads'), { maxAge: '7d' }));

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/roster', require('./routes/roster'));
  app.use('/api/run', require('./routes/run'));
  app.use('/api/ranking', require('./routes/ranking'));
  app.use('/api/points', require('./routes/points'));
  app.use('/api/goal', require('./routes/goal'));
  app.use('/api/reward-video', require('./routes/reward-video'));
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
