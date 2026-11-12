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
  ok('多音字「曾」展开成 2 种读音组合', pats.length === 2, pats.length);
  const res = pats.map((p) => new RegExp(p));
  const hitZeng = res.some((r) => r.test('曾伟'));
  const hitCeng = res.some((r) => r.test('层伟'));
  ok('两种读音都能命中本人（曾伟 / 层伟）', hitZeng && hitCeng);
  // 「层为」是 ceng+wei 的**合法**同音（层·伟），必须命中 —— 这不是串味，是功能本身
  ok('「层为」也算同音命中（ceng + wei）', res.some((r) => r.test('层为')));
  // 真正要防的是「读音并集」：若把第一个字的读音集与第二个字的读音集混成笛卡尔积，
  // 就会出现「这一个字的 A 读音 + 那一个字的 B 读音」的假命中。
  // 判据：组合数必须等于**各字读音数的乘积**（曾 2 × 伟 1 = 2），而不是 2×1 之外的膨胀。
  const expect = 2 * 1;
  ok('组合数 = 各字读音数之积（不是并集膨胀）', pats.length === expect, { got: pats.length, expect });
  // 第二个字不是伟/为/韦…的同音时不得命中
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
}

console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}（${checked} 项）`);
process.exit(failed ? 1 : 0);
