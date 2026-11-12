/**
 * 姓名同音字搜索 —— 真连库端到端验证：node tools/verify-name-search.js
 *
 * 用户 2026-11-12：「在用户搜索与考勤录入时的用户名搜索请增加同音字智能搜索功能，
 * 两个字才启动，单字不智能匹配」
 *
 * 为什么静态检查器（check-name-search.js）不够：那个只验「口径与接线」，
 * 而这里要回答的是**真实库里到底搜不搜得到** —— 全角/生僻字、存量姓名没有 pinyin 覆盖、
 * 正则字符类写错（少个括号就变成永不命中）都不会让静态检查变红。
 *
 * 四条断言：
 *   ① 每个人都能被自己的名字搜到（同音扩展**不能破坏**原样子串 —— 这是最容易写错的地方）；
 *   ② 用一个同音错字（如「章伟」搜「张伟」）能搜到本人；
 *   ③ 单字不扩同音：命中的每一条姓名都必须**真的包含**这个字（而不是同音字）；
 *   ④ 不相关的人不会被误命中（拿几个明确不同音的名字做反例）。
 *
 * 本脚本**只读**，不造任何数据（所以没有清理步骤）。
 */
const path = require('path');

const serverDir = path.join(__dirname, '..', 'server');
require(path.join(serverDir, 'node_modules', 'dotenv')).config({ path: path.join(serverDir, '.env') });
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));
const { pinyin } = require(path.join(serverDir, 'node_modules', 'pinyin-pro'));
const config = require(path.join(serverDir, 'src', 'config'));
const User = require(path.join(serverDir, 'src', 'models', 'user'));
const ns = require(path.join(serverDir, 'src', 'services', 'name-search'));

let failed = 0;
function assert(cond, name, detail) {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ← ${JSON.stringify(detail)}`}`);
  if (!cond) failed += 1;
}

// 拼音归一（与 services/name-search.js 同口径）：ü → v，去声调
const pyOf = (s) => pinyin(s, { toneType: 'none' }).replace(/ü/g, 'v');

// 常见同音替换字池：命中率比全字库扫描高，且都是真实姓名用字
const CANDIDATES = ('张章彰樟璋伟玮薇伪位韦明名鸣铭眀宇雨语羽玉王汪望文闻问雯'
  + '李礼里理力丽利立陈晨辰臣尘杨洋阳扬王汪娜那哪纳旭许徐绪续坤昆琨鹏朋'
  + '鑫新心欣超朝潮博波伯泊泽择则运宇航航杭方芳房书舒淑淑俊骏峻').split('');

(async () => {
  const [base, query] = config.mongoUri.split('?');
  const uri = `${base.replace(/\/$/, '')}/${config.dbName}${query ? `?${query}` : ''}`;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log(`\n[db] ${config.dbName}`);

  // 只取有姓名、两个字以上的学生（单字姓名无从验证「两个字才启动」）
  const rows = await User.find({ role: { $ne: 'teacher' }, realName: { $ne: '' } })
    .select('realName studentId')
    .limit(400)
    .lean();
  const named = rows.map((r) => r.realName).filter((n) => ns.hanCount(n) >= 2);
  assert(named.length > 0, `库里有 ${named.length} 个两字以上的姓名可验证`, { total: rows.length });
  console.log(`（抽样姓名：${named.slice(0, 6).join('、')}）`);

  const search = async (keyword) =>
    User.find({ role: { $ne: 'teacher' }, $or: ns.keywordOr(keyword, { nameFields: ['realName'] }) })
      .select('realName')
      .limit(50)
      .lean();

  // ---- ① 原名一定能搜到自己（同音扩展不得破坏原样子串）----
  {
    const problems = [];
    for (const name of named.slice(0, 15)) {
      const found = (await search(name)).map((f) => f.realName);
      if (!found.includes(name)) problems.push({ name, found: found.slice(0, 3) });
    }
    assert(problems.length === 0, '每个名字都能搜到自己（普通子串没被同音扩展挤掉）', problems);
  }

  // ---- ② 同音错字能搜到本人（功能本体）----
  {
    const problems = [];
    let tested = 0;
    for (const name of named.slice(0, 40)) {
      // 造一个错字：把某个字换成同音但不同的字
      const chars = Array.from(name);
      let typo = '';
      for (let i = 0; i < chars.length; i += 1) {
        const py = pyOf(chars[i]);
        const alt = CANDIDATES.find((c) => c !== chars[i] && pyOf(c) === py);
        if (alt) {
          typo = chars.slice(0, i).join('') + alt + chars.slice(i + 1).join('');
          break;
        }
      }
      if (!typo) continue; // 这个名字的每个字都找不到同音替换字，跳过
      tested += 1;
      const found = (await search(typo)).map((f) => f.realName);
      if (!found.includes(name)) problems.push({ name, typo, found: found.slice(0, 3) });
    }
    assert(tested >= 3, `造出了 ${tested} 个同音错字用来验证`, tested);
    assert(problems.length === 0, `同音错字能搜到本人（${tested} 例）`, problems);
  }

  // ---- ③ 单字不扩同音 ----
  {
    const one = '张';
    const found = (await search(one)).map((f) => f.realName);
    assert(found.length > 0, `单字「${one}」仍能按原样子串搜到（${found.length} 条）`, found.length);
    // 关键：结果里每一条都必须**真的包含**这个字。若单字也扩同音，
    // 「章薇」这类不含「张」的名字就会混进来 —— 这正是用户要求不要的行为。
    const leaked = found.filter((n) => !String(n).includes(one));
    assert(leaked.length === 0, '单字搜索结果里没有同音字（不含「张」的名字不该出现）', leaked.slice(0, 5));
  }

  // ---- ④ 反例：不同音的名字不该被搜出来 ----
  {
    const cases = [
      { kw: '章伟', not: '王强' },
      { kw: '陈宇航', not: '李小明' },
    ];
    const problems = [];
    for (const c of cases) {
      const found = (await search(c.kw)).map((f) => f.realName);
      if (found.includes(c.not)) problems.push({ kw: c.kw, shouldNotHit: c.not });
    }
    assert(problems.length === 0, '完全不同音的名字不会被误命中', problems);
  }

  // ---- ⑤ 错音字（方言误读）：用真实姓名验证「错读也能找到人」----
  // 用户 2026-11-12：「增加错音字 如 pin 和 ping 这种因非普通话而读错的」
  // 做法：拿真实姓名，把其中一个字换成「读音错一个特征」的字（前后鼻音/平翘舌/n-l），
  // 再搜，必须仍能命中本人。这是**功能本体**（同音字那一轮已经覆盖了严格同音）。
  {
    const FLIP = [
      // [原韵尾/声母, 替换后的写法]：用来把正确读音改成一个「方言化」的写法
      [/n$/, 'ng'], [/ng$/, 'n'],
      [/^zh/, 'z'], [/^z$|^z(?!h)/, 'zh'],
      [/^ch/, 'c'], [/^sh/, 's'],
    ];
    const problems = [];
    let tested = 0;
    for (const name of named.slice(0, 60)) {
      const chars = Array.from(name);
      let typo = '';
      for (let i = 0; i < chars.length; i += 1) {
        const py = pyOf(chars[i]);
        // 找一个「读音与它只差一个方言特征」的字（同音集合里没有，但模糊变体里有）
        const fuzzySet = new Set(ns.fuzzyReadingVariants(py).slice(1));
        if (!fuzzySet.size) continue;
        const alt = CANDIDATES.find((c) => c !== chars[i] && fuzzySet.has(pyOf(c)) && pyOf(c) !== py);
        if (alt) {
          typo = chars.slice(0, i).join('') + alt + chars.slice(i + 1).join('');
          break;
        }
      }
      if (!typo) continue;
      tested += 1;
      const found = (await search(typo)).map((f) => f.realName);
      if (!found.includes(name)) problems.push({ name, typo, found: found.slice(0, 3) });
    }
    assert(tested >= 3, `造出了 ${tested} 个「方言错读」写法用来验证`, tested);
    assert(problems.length === 0, `方言错读能搜到本人（${tested} 例，前后鼻音/平翘舌/n-l）`, problems);
  }

  // ---- ⑥ 错音扩展不能把无关的人带出来（放宽的代价必须量化）----
  //
  // 这是本轮最容易犯错的地方：错音规则一放宽，就变成「搜谁都能搜到」。
  // 判据：拿一个真实姓名去搜，返回人数不应比原样子串多出一个数量级。
  {
    const subjects = named.slice(0, 5);
    const problems = [];
    for (const name of subjects) {
      const plainCount = await User.countDocuments({ role: { $ne: 'teacher' }, realName: new RegExp(name) });
      const fuzzyCount = (await search(name)).length;
      // 允许一定放大（错音就是要放宽），但同一批人里不该翻倍到离谱
      if (fuzzyCount > Math.max(plainCount + 8, plainCount * 4)) {
        problems.push({ name, plainCount, fuzzyCount });
      }
    }
    assert(problems.length === 0, '错音扩展的放大倍数可控（不出现「搜谁都能搜到」）', problems);
  }

  // ---- 性能：反向表只建一次，热路径必须很快 ----
  {
    ns.clearCache();
    const t0 = Date.now();
    ns.homophonePatterns('张伟');
    const cold = Date.now() - t0;
    const t1 = Date.now();
    for (let i = 0; i < 100; i += 1) ns.homophonePatterns('张伟');
    const warm = (Date.now() - t1) / 100;
    assert(cold < 2000, `反向表冷构建 ${cold}ms（一次性的，可接受）`, cold);
    assert(warm < 5, `热路径 ${warm.toFixed(2)}ms/次（每次搜索都要算）`, warm);
  }

  await mongoose.disconnect();
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('ERR', e.stack);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
