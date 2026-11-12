const path = require('path');
const serverDir = path.join(__dirname, 'server');
require(path.join(serverDir, 'node_modules', 'dotenv')).config({ path: path.join(serverDir, '.env') });
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));
const config = require(path.join(serverDir, 'src', 'config'));
const User = require(path.join(serverDir, 'src', 'models', 'user'));
const ns = require(path.join(serverDir, 'src', 'services', 'name-search'));
const { pinyin } = require(path.join(serverDir, 'node_modules', 'pinyin-pro'));

(async () => {
  const [base, query] = config.mongoUri.split('?');
  const uri = `${base.replace(/\/$/, '')}/${config.dbName}${query ? `?${query}` : ''}`;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });

  for (const kw of ['冯绍鹏', '冯绍', '绍鹏']) {
    const n = ns.hanCount(kw);
    console.log(`\n=== "${kw}" 汉字=${n} 启用同音=${ns.hasNameScope(kw)} 变体=${ns.homophonePatterns(kw).length}`);
    console.log('  读音:', pinyin(kw, { toneType: 'none', type: 'array' }));
    const or = ns.keywordOr(kw, { nameFields: ['nickname', 'realName'], textFields: ['studentId', 'className'], exactField: 'openid' });
    console.log('  $or 条数:', or.length);
    const found = await User.find({ $or: or }).select('realName nickname role').limit(8).lean();
    console.log('  命中:', found.map((f) => `${f.realName}(${f.role})`).join(', ') || '(无)');
    if (or.length > 2) {
      const re = or.slice(2).map((x) => x.realName).filter(Boolean);
      console.log('  同音正则数:', re.length);
      for (const n2 of ['冯绍鹏', '冯邵朋', '封绍鹏', '冯少鹏', '逢绍鹏']) {
        console.log(`    ${n2} -> ${re.some((r) => r.test(n2))}`);
      }
    }
  }

  // 库里到底有没有这个人
  const all = await User.find({ realName: /冯/ }).select('realName role nickname').limit(20).lean();
  console.log('\n库中姓名含「冯」的人:', all.map((u) => `${u.realName}(${u.role})`).join(', ') || '(无)');
  const exact = await User.find({ realName: '冯绍鹏' }).select('realName role').lean();
  console.log('精确「冯绍鹏」:', JSON.stringify(exact));

  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.stack); process.exit(1); });
