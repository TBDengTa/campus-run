const express = require('express');
const path = require('path');
const morgan = require('morgan');
const config = require('./config');
const { notFound, errorHandler } = require('./middlewares/error');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

  // 健康检查
  app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

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
  app.use('/api/goal', require('./routes/goal'));
  app.use('/api/reward-video', require('./routes/reward-video'));
  app.use('/api/water', require('./routes/water'));
  app.use('/api/badges', require('./routes/badge'));
  app.use('/api/appeals', require('./routes/appeal'));
  app.use('/api/ads', require('./routes/ad'));
  app.use('/api/org', require('./routes/org'));
  app.use('/api/content', require('./routes/content'));
  app.use('/api/admin', require('./routes/admin'));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
