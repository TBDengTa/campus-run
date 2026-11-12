// 真实 HTTP 链路验证：启动 app，直接打 /api/admin/users?keyword=冯绍鹏
const path = require('path');
const serverDir = path.join(__dirname, 'server');
require(path.join(serverDir, 'node_modules', 'dotenv')).config({ path: path.join(serverDir, '.env') });
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));
const config = require(path.join(serverDir, 'src', 'config'));

(async () => {
  const [base, query] = config.mongoUri.split('?');
  const uri = `${base.replace(/\/$/, '')}/${config.dbName}${query ? `?${query}` : ''}`;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  const { createApp } = require(path.join(serverDir, 'src', 'app'));
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const User = require(path.join(serverDir, 'src', 'models', 'user'));

  const su = await User.findOne({ permissions: '*' }).lean();
  const jwt = require(path.join(serverDir, 'node_modules', 'jsonwebtoken'));
  const token = jwt.sign({ openid: su.openid, uid: String(su._id) }, config.jwtSecret, { expiresIn: '1h' });

  for (const kw of ['冯绍鹏', '冯绍彭', '冯绍', 'fsP']) {
    const url = `http://127.0.0.1:${port}/api/admin/users?keyword=${encodeURIComponent(kw)}&page=1&limit=10`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    const list = (j.data && j.data.list) || [];
    console.log(`\n[${kw}] status=${r.status} total=${j.data && j.data.total}`);
    console.log('  返回:', list.map((u) => u.realName).join(', ') || '(空)');
  }

  server.close();
  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.stack); process.exit(1); });
