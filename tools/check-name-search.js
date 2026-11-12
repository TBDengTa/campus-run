/**
 * 姓名同音字搜索契约自检（不依赖数据库）：node tools/check-name-search.js
 *
 * 用户 2026-11-12：「在用户搜索与考勤录入时的用户名搜索请增加同音字智能搜索功能，
 * 两个字才启动，单字不智能匹配」
 *
 * 这类功能**错的方向都很难被发现**：
 *   · 单字也启用同音 → 搜「张」出来 54 个同音字的人，用户以为搜索坏了（但确实"能搜到"）；
 *   · 同音扩展到学号 → 学号没有读音，只会扩大扫描；
 *   · 多音字取并集 → 「单伟」会命中「产伟/善伟」，搜什么都有人；
 *   · 只改了某一个接口 → 用户在用户管理搜得到、在考勤录入搜不到（两端不一致最难解释）。
 * 所以这里逐条钉死口径，并检查**每个搜索入口都接了同一份实现**。
 *
 * 运行：node tools/check-name-search.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'src');
let failed = 0;
let checked = 0;

function ok(name, cond, detail) {
  checked += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

console.log('\n[1] 服务口径');
const ns = require(path.join(SERVER, 'services', 'name-search'));

// ---- 单字不启用（用户明确要求）----
ok('单字不启用同音（张 → 0 条扩展）', ns.homophonePatterns('张').length === 0, ns.homophonePatterns('张').length);
ok('其实是「汉字数 < 2 一律不启用」：双字以上才启用', ns.homophonePatterns('张伟').length > 0 && ns.homophonePatterns('欧阳').length > 0);
ok('hanCount 只数汉字（字母/数字不算）', ns.hanCount('张1a') === 1 && ns.hanCount('张伟1') === 2);
ok('学号这种纯数字关键字从不触发同音', ns.homophonePatterns('20200905').length === 0);
ok('空关键字不触发同音', ns.homophonePatterns('').length === 0 && ns.homophonePatterns('   ').length === 0);
ok('hasNameScope 与 homophonePatterns 同源', ns.hasNameScope('张') === false && ns.hasNameScope('张伟') === true);

// ---- 同音命中正确 ----
{
  const re = ns.homophoneRegexes('张伟')[0];
  ok('「张伟」能命中同音的「章薇」', re.test('章薇'), re && re.source.slice(0, 20));
  ok('「张伟」能命中原名「张伟」', re.test('张伟'));
  ok('「张伟」不命中完全无关的「王强」', !re.test('王强'));
  // 子串：只记得名字里的两个字也要能搜到
  const re2 = ns.homophoneRegexes('伟明')[0];
  ok('「伟明」是子串匹配（命中「张伟明」）', re2.test('张伟明'));
}

// ---- 多音字按读音组合展开，不取并集 ----
{
  const pats = ns.homophonePatterns('曾伟');
  const res = pats.map((p) => new RegExp(p));
  const hitZeng = res.some((r) => r.test('曾伟'));
  const hitCeng = res.some((r) => r.test('层伟'));
  ok('两种读音都能命中本人（曾伟 / 层伟）', hitZeng && hitCeng);
  // 2026-11-12 错音字改造后：同一汉字的**全部读音合进一个字符类**（而不是每读音一条正则）。
  // 结果集完全相同，但正则条数从 N 降到 1 —— Mongo 的字符类是一次集合查表，比多条正则便宜。
  // 所以这里断言的不再是「变体数」，而是「一个类里同时含两读音的字」。
  ok('多音字合并进同一个字符类（正则条数不随读音数膨胀）', pats.length === 1, pats.length);
  ok('该字符类同时含「曾」(zeng) 与「层」(ceng)', /曾/.test(pats[0]) && /层/.test(pats[0]), pats[0].slice(0, 60));
  // 「层为」是 ceng+wei 的**合法**同音（层·伟），必须命中 —— 这不是串味，是功能本身
  ok('「层为」也算同音命中（ceng + wei）', res.some((r) => r.test('层为')));
  // 真正要防的是混进**无关**的字：第二个字不是 wei 的任何同音时必须不命中
  ok('只对第一个字同音、第二个字不同音 → 不命中（层强）', !res.some((r) => r.test('层强')));
  ok('完全无同音关系的名字不命中（王强）', !res.some((r) => r.test('王强')));
}

// ---- 变体数有上限（拼出巨型正则会让请求变慢且难排查）----
{
  const pats = ns.homophonePatterns('单曾解');
  ok('多音字连续出现时变体数有上限（≤8）', pats.length <= 8, pats.length);
}

// ---- $or 构造：同音只进姓名类字段 ----
{
  const or = ns.keywordOr('张伟', { nameFields: ['realName', 'nickname'], textFields: ['studentId', 'className'], exactField: 'openid' });
  ok('keywordOr 返回 $or 数组', Array.isArray(or) && or.length > 0, or && or.length);
  const fieldsOf = (list) => [...new Set(list.flatMap((x) => Object.keys(x)))].sort();
  ok(
    '同音只作用于姓名类字段，学号/班级各只有一条普通正则',
    or.filter((x) => x.studentId).length === 1 && or.filter((x) => x.className).length === 1,
    fieldsOf(or)
  );
  ok('姓名类字段有多条（普通 + 同音）', or.filter((x) => x.realName).length >= 2, or.filter((x) => x.realName).length);
  ok('exactField（openid）是等值而不是正则', or.some((x) => typeof x.openid === 'string'));
  ok('空关键字返回 null（调用方据此不拼 $or）', ns.keywordOr('   ') === null);
  // 单字时只有普通正则（每字段一条）
  const orSingle = ns.keywordOr('张', { nameFields: ['realName'], textFields: ['studentId'] });
  ok('单字：每个字段只有一条普通正则（不扩同音）', orSingle.filter((x) => x.realName).length === 1, orSingle.length);
}

// ---- 正则元字符必须转义（关键字里有 . * 不能当语法）----
{
  const re = ns.plainRegex('a.b');
  ok('plainRegex 转义元字符（a.b 不匹配 axb）', !re.test('axb') && re.test('a.b'));
  ok('escapeRe 覆盖 RegExp 特殊字符', ns.escapeRe('.*+?^${}()|[]\\') === '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\', ns.escapeRe('.*+?^${}()|[]\\'));
}

// ---- 错音字（方言误读，用户 2026-11-12 追加「如 pin 和 ping」）----
// 这一类**错的方向特别难发现**：扩展过头就变成「搜谁都能搜到」（比搜不到更糟，
// 因为用户会真的勾错人）。所以每个方向都要有正例和反例。
{
  // 变体生成
  const v = (py) => ns.fuzzyReadingVariants(py);
  ok('前后鼻音：peng → 含 pen（鹏 读成「盆」）', v('peng').includes('pen'), v('peng'));
  ok('前后鼻音：lin → 含 ling（林 读成「灵」）', v('lin').includes('ling'), v('lin'));
  ok('平翘舌：zhang → 含 zang（张 读成「脏」）', v('zhang').includes('zang'), v('zhang'));
  ok('f/h：fu → 含 hu（福 读成「胡」）', v('fu').includes('hu'), v('fu'));
  ok('n/l：nan → 含 lan（南 读成「兰」）', v('nan').includes('lan'), v('nan'));
  ok('原音节永远在第一位（截断也不会搜不到本人）', v('peng')[0] === 'peng' && v('lin')[0] === 'lin');

  // 关键反例 1：不能叠出非法音节（第一版真实踩过：sh → shh → shheng）
  const sh = v('sheng');
  ok('不产生非法音节（没有 shh / zhh 这种串）', sh.every((p) => !/h{2,}|hh/.test(p)), sh);
  ok('sheng 的合法变体含 sen（平翘舌+前后鼻音同时错）', sh.includes('sen'), sh);

  // 关键反例 2：n/l 与前后鼻音不能叠加（否则 林 → 宁，两个人被合成一个）
  ok('n/l 结果不再派生（lin 不含 ning ——「林」不能命中「宁」）', !v('lin').includes('ning'), v('lin'));
  // 刻意**不允许** nan → lang：`nang`(n/l) 与 `lang`(-n/-ng) 两条不同性质的错读叠在一起，
  // 会把「南」和「浪」这种毫无关系的名字连起来。宁可少覆盖，也不要制造假命中。
  ok('n/l 不与前后鼻音叠加（nan 不含 lang）', !v('nan').includes('lang'), v('nan'));
  ok('但两条规则各自都能单独生效（nan 有 nang 和 lan）', v('nan').includes('nang') && v('nan').includes('lan'), v('nan'));

  // 端到端：用户点名的那一幕
  const feng = ns.homophoneRegexes('冯绍鹏');
  ok('搜「冯绍鹏」→ 命中错音写法「冯绍盆」', feng.some((r) => r.test('冯绍盆')), feng.length);
  ok('搜「冯绍鹏」→ 命中同音「冯绍彭」（原名其实是彭，不是鹏）', feng.some((r) => r.test('冯绍彭')));
  ok('搜「冯绍鹏」→ 仍命中正确写法', feng.some((r) => r.test('冯绍鹏')));
  const lin = ns.homophoneRegexes('林晓明');
  ok('搜「林晓明」→ 命中「灵晓明」（pin/ping 类误读）', lin.some((r) => r.test('灵晓明')));

  // 反例：不能因为放宽而互相串
  ok('搜「冯绍鹏」不命中「王绍鹏」（姓必须对上）', !feng.some((r) => r.test('王绍鹏')));
  ok('搜「冯绍鹏」不命中「冯绍明」（名必须对上）', !feng.some((r) => r.test('冯绍明')));
  ok('搜「林晓明」不命中「宁晓明」（n/l 未与鼻音叠加）', !lin.some((r) => r.test('宁晓明')));
  ok('搜「林晓明」不命中「李四」', !lin.some((r) => r.test('李四')));
  // 单字门禁对错音同样生效（否则「张」会被扩成「脏/藏/丈…」）
  ok('单字不启动错音扩展', ns.homophonePatterns('冯').length === 0 && ns.fuzzyReadingVariants('feng').length > 1);
}

console.log('\n[2] 每个搜索入口都接同一份实现（不许各写一份正则）');
{
  // 用户搜索（管理端用户管理列表 + 分面计数共用 buildUserMatch）
  const adminUsers = read(SERVER, 'routes', 'admin', 'users.js');
  ok('用户管理：buildUserMatch 走 nameSearch.keywordOr', /nameSearch\.keywordOr\(kw/.test(adminUsers));
  ok('用户管理：姓名字段含 nickname + realName', /nameFields: \['nickname', 'realName'\]/.test(adminUsers));
  ok('用户管理：openid 仍走等值（不做同音）', /exactField: 'openid'/.test(adminUsers));
  ok('用户管理：不再自己拼 RegExp 做姓名匹配', !/\{ nickname: re \}, \{ realName: re \}/.test(adminUsers));

  // 考勤录入名单（三个分支：班内 / 宿内 / 校内）
  const unionRoute = read(SERVER, 'routes', 'union.js');
  const entrySeg = unionRoute.slice(unionRoute.indexOf("'/entry/students'"), unionRoute.indexOf("'/dashboard'"));
  ok('录入名单：三个分支共用 kwOr（一把尺子）', /const kwOr = \(fields\) =>/.test(entrySeg), entrySeg.slice(0, 60));
  ok('录入名单：班内分支也接关键字（以前完全不读 keyword）', /const classOrs = kwOr\(\['account', 'studentId'\]\)/.test(entrySeg));
  ok('录入名单：宿内分支接关键字', /const ors = kwOr\(\['studentId'\]\)/.test(entrySeg));
  ok('录入名单：校内分支接关键字', /kwOr\(\['account', 'studentId', 'className'\]\)/.test(entrySeg));
  ok('录入名单：姓名含同音（nameFields 含 realName + nickname）', /nameFields: \['realName', 'nickname'\]/.test(entrySeg));
  ok('录入名单：三个分支都回显 keyword（前端据此显示搜索态）', (entrySeg.match(/keyword,/g) || []).length >= 3, (entrySeg.match(/keyword,/g) || []).length);

  // 其它相关出口
  const adminUnion = read(SERVER, 'routes', 'admin', 'union.js');
  ok('成员列表 / 候选人 / 宿舍台账都走 nameSearch', (adminUnion.match(/nameSearch\.keywordOr\(/g) || []).length >= 3, (adminUnion.match(/nameSearch\.keywordOr\(/g) || []).length);
  const anomalies = read(SERVER, 'routes', 'admin', 'step-anomalies.js');
  ok('反作弊列表走 nameSearch', /nameSearch\.keywordOr\(kw/.test(anomalies));
  const consoleRoute = read(SERVER, 'routes', 'console.js');
  ok('Web 控制台走同一份实现（两端不会一个搜得到一个搜不到）', /nameSearch\.keywordOr\(kw/.test(consoleRoute));

  // 依赖声明
  const pkg = JSON.parse(read(ROOT, 'server', 'package.json'));
  ok('pinyin-pro 已在 server/package.json 声明', !!(pkg.dependencies && pkg.dependencies['pinyin-pro']), pkg.dependencies && pkg.dependencies['pinyin-pro']);
}

console.log('\n[3] 前端接线');
{
  const pickerJs = read(ROOT, 'miniprogram', 'components', 'person-picker', 'person-picker.js');
  const pickerWxml = read(ROOT, 'miniprogram', 'components', 'person-picker', 'person-picker.wxml');
  ok('person-picker 有同音提示文案属性', /homophoneHint: \{ type: String/.test(pickerJs));
  ok('person-picker WXML 渲染同音提示', /pp-hint-homophone/.test(pickerWxml) && /\{\{homophoneHint\}\}/.test(pickerWxml));
  ok('搜不到时文案说明「同音字也试过了」（否则用户以为功能没生效）', /同音字也试过了/.test(pickerWxml), '搜不到文案未提同音');

  // ===== 用户管理的搜索必须「最后一次输入一定生效」=====
  // 用户 2026-11-12 报「搜索冯绍鹏没有同音字的检查」—— 服务端其实是对的，
  // 真因是前端并发：t-search 每敲一个字触发一次 reload()，reload 先清空列表再 load()，
  // 而旧 load() 开头 `if (loading) return` 把后到的请求全丢了，
  // 于是搜 3 个字看到的是第 1 个字（单字，按口径不启用同音）的结果。
  // 这类 bug 静态检查抓不到语义，只能盯「结构上有没有可能丢掉最后一次请求」。
  const usersJs = read(ROOT, 'miniprogram', 'packageAdmin', 'users', 'users.js');
  ok('用户搜索有防抖（不是每个字符都发请求）', /_searchTimer/.test(usersJs) && /clearTimeout\(this\._searchTimer\)/.test(usersJs));
  ok('load() 不再用 `if (loading) return` 挡掉搜索请求',
    !/if \(loading\) return;/.test(usersJs), '旧写法会让最后一次输入被静默丢弃');
  ok('load() 用自增 seq 丢弃过期响应',
    /const seq = \(this\._seq = \(this\._seq \|\| 0\) \+ 1\)/.test(usersJs) && /if \(seq !== this\._seq\) return;/.test(usersJs));
  ok('过期响应不覆盖列表（seq 校验在 setData 之前）',
    /if \(seq !== this\._seq\) return;\s*\n\s*\/\/ 实时人数随列表一起到/.test(usersJs) || /if \(seq !== this\._seq\) return;/.test(usersJs));
  ok('only 最新那次收尾 loading（旧请求不会提前关掉 loading）',
    /if \(seq === this\._seq\) this\.setData\(\{ loading: false/.test(usersJs));
  ok('翻页仍挡并发（只在 page>1 时拦）', /if \(page > 1 && loading\) return;/.test(usersJs));
  ok('页面卸载清掉搜索定时器（不在已销毁页面上 setData）', /onUnload\(\)[\s\S]{0,140}clearTimeout\(this\._searchTimer\)/.test(usersJs));
}

console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}（${checked} 项）`);
process.exit(failed ? 1 : 0);
