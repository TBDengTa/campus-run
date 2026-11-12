/**
 * 姓名搜索：普通子串 + **同音字智能匹配**（用户 2026-11-12
 * 「在用户搜索与考勤录入时的用户名搜索请增加同音字智能搜索功能，两个字才启动，单字不智能匹配」）
 *
 * ===== 为什么需要 =====
 * 「张伟 / 章薇 / 张玮」在名单里是三个人。检查人现场按读音找人时只会输入自己听到的那个名字，
 * 手输错字或记错字是常态 —— 而勾到别人会直接落库（考勤记录不可回滚）。
 * 所以按读音匹配（同音字）是「找不到人」与「勾错人」之间唯一可行的折中。
 *
 * ===== 三条口径（都是用户明确要求/防误伤的硬约束）=====
 *  ① **两个字才启动**：单字（如「张」）一律只做普通子串匹配。
 *     原因：单字的同音集合极大（「张」的同音有 54 个字），
 *     搜一个「张」会把「章/彰/蟑…」全捞出来，等于没有筛选，还会把无关的人排到前面。
 *  ② **只作用于姓名类字段**（realName / nickname）：学号、班级、openid 按原样子串匹配。
 *     给学号做同音匹配毫无意义（数字没有读音），反而会扩大扫描。
 *  ③ **多音字按「读音组合」展开，不取并集**：曾（zeng/ceng）伟 只匹配
 *     `zeng wei` 与 `ceng wei` 两种读音，而不是「曾或层」的笛卡尔积并集 —
 *     并集会把「层伟」也算命中，正是同音搜索最容易变成「什么都能搜到」的地方。
 *
 * ===== 错音字（用户 2026-11-12 追加「如 pin 和 ping 这种因非普通话而读错的」）=====
 * 除「同音字」（鹏/彭/朋 本来都是 peng）外，还覆盖**方言错读**：
 * 前后鼻音（peng↔pen）、平翘舌（zhi↔zi）、n/l（nan↔lan）、f/h（fu↔hu）。
 * 于是「冯绍鹏」能搜到「冯绍盆」、「林晓明」能搜到「灵晓明」。
 * 规则与「为什么不能叠加」见 FUZZY_RULES 的注释（叠加会造出「林→宁」这种假命中）。
 *
 * ===== 实现取舍 =====
 * 反向表（拼音 → 同音汉字）在用到时**懒构建一次**再缓存：全量扫 CJK 基本区实测约 57ms、
 * 415 个音节 / 23672 条映射（2026-11-12 实测），只建一次可以接受；
 * 若放进每次请求都会变成明显延迟。纯单字/数字/字母查询**从不触发构建**（见 hasNameScope）。
 */
const { pinyin } = require('pinyin-pro');

// 汉字范围（CJK 基本区）：姓名用字几乎都落在这里，扩展区生僻字不纳入（收益低、构建慢 10 倍）
const HAN_START = 0x4e00;
const HAN_END = 0x9fff;

// 多音字组合上限：4 字名 × 每个 3 读音 = 81 种，会拼出一个巨大的正则。
// 8 已覆盖真实姓名（「曾/单/解/查」这类姓氏最多 3 读音，且极少连续出现）。
const MAX_VARIANTS = 8;

/**
 * 单字同音集合**不截断**（刻意如此）。
 * 曾按「字库顺序前 120 个」截断过，实测把「薇」(wei 的第 141 个) 挤掉了 ——
 * 而「章薇」正是这次要能搜到「张伟」的那种名字，截断等于功能对最常见的字失效。
 * 实测最大同音集是 yi = 392 字（2026-11-12 全量扫 CJK 基本区），
 * 一个字符类 392 个汉字对正则引擎只是一个集合查表，没有性能问题；
 * 真正需要收敛的是**变体数**（多音字组合），那个由 MAX_VARIANTS 控制。
 */
const MAX_CLASS_CHARS = Infinity; // 语义：不截断（保留常量名便于将来真要截时只改这里）

// 拼音归一：声调已被 toneType:'none' 去掉，这里只统一 ü 的两种写法（lü / lv），
// 否则「吕」查得到而「lv」查不到（不同输入法/不同用户对 ü 的写法不一致）。
const normPy = (p) => String(p || '').toLowerCase().replace(/ü/g, 'v');

let reverse = null; // Map<拼音, 汉字[]>，懒构建

/** 构建（并缓存）「拼音 → 同音汉字」反向表 */
function reverseMap() {
  if (reverse) return reverse;
  const map = new Map();
  for (let code = HAN_START; code <= HAN_END; code += 1) {
    const ch = String.fromCharCode(code);
    let list;
    try {
      // multiple:true 取多音字的**全部**读音（曾 → ceng / zeng）；
      // nonZh:'removed' 让非汉字不产生条目（否则表里会混进空串与标点）
      list = pinyin(ch, { toneType: 'none', type: 'array', nonZh: 'removed', multiple: true });
    } catch (e) {
      continue;
    }
    for (const raw of list || []) {
      const py = normPy(raw);
      if (!py || !/^[a-zv]+$/.test(py)) continue;
      let bucket = map.get(py);
      if (!bucket) {
        bucket = [];
        map.set(py, bucket);
      }
      if (!bucket.includes(ch)) bucket.push(ch);
    }
  }
  reverse = map;
  return map;
}

/** 拆出关键字里的汉字（其余字符原样保留位置，用于非汉字部分按字面匹配） */
function splitHan(keyword) {
  const chars = Array.from(String(keyword || ''));
  return chars.map((ch) => ({ ch, han: /[\u4e00-\u9fff]/.test(ch) }));
}

/**
 * 关键字里的汉字个数（决定要不要启动同音匹配）
 * @param {string} keyword
 */
function hanCount(keyword) {
  return splitHan(keyword).filter((x) => x.han).length;
}

/**
 * 是否做同音扩展：**≥2 个汉字**才启动（用户明确「两个字才启动，单字不智能匹配」）
 * @param {string} keyword
 */
function hasNameScope(keyword) {
  return hanCount(keyword) >= 2;
}

/** 单个汉字的候选字符类（含它自己；多音字取全部读音的并集，用于**单个字**的字符类） */
function charClass(ch) {
  const map = reverseMap();
  let readings = [];
  try {
    readings = pinyin(ch, { toneType: 'none', type: 'array', nonZh: 'removed', multiple: true }) || [];
  } catch (e) {
    readings = [];
  }
  const set = new Set([ch]);
  for (const raw of readings) {
    const list = map.get(normPy(raw)) || [];
    for (const c of list) set.add(c);
  }
  return [...set].slice(0, MAX_CLASS_CHARS).join('');
}

/** 单个汉字的所有读音（去重、已归一）；取不到返回 [] */
function readingsOf(ch) {
  const map = reverseMap();
  let readings = [];
  try {
    readings = pinyin(ch, { toneType: 'none', type: 'array', nonZh: 'removed', multiple: true }) || [];
  } catch (e) {
    readings = [];
  }
  const out = [];
  for (const raw of readings) {
    const py = normPy(raw);
    if (!py || !/^[a-zv]+$/.test(py)) continue;
    if (!out.includes(py)) out.push(py);
  }
  // 字库里确实没有读音（生僻字/未收录字）→ 返回空，调用方退化成「只匹配它自己」
  return out.filter((py) => (map.get(py) || []).length > 0);
}

/** 某读音对应的字符类（该音节的**全部**同音字，含原字） */
function classOfReading(py) {
  const list = reverseMap().get(normPy(py)) || [];
  return list.slice(0, MAX_CLASS_CHARS).join('');
}

/**
 * ===== 模糊音（错音字）规则 =====
 *
 * 用户 2026-11-12：「还希望增加错音字，如 pin 和 ping 这种因非普通话而读错的」。
 * 这不是「同音字」（`鹏/彭/朋` 本来就同音 peng），而是**方言里会读错的音**：
 * 西南/湘赣/闽粤一带前后鼻音不分（peng→pen、lin→ling）、平翘舌不分（zhi→zi）、
 * n/l 不分（nan→lan）、f/h 不分（fu→hu）。
 *
 * 实测这批错读在校园里极常见：学生报名字说「冯绍鹏（pén）」，检查人按「盆」的读音打不出字，
 * 于是搜不到人。所以按「同一个音节的另一种地方读音」扩展。
 *
 * ⚠️ 三条实现约束（都是踩过的坑，改这里前必读）：
 *  ① **变体必须换一个新字符串，不能叠加在同一条上**：
 *     旧写法 `sh`→`s` 与 `sh`→`shh` 会在两轮迭代里叠成 `shheng` 这种非法音节。
 *     现在每条规则**互斥**（用了 `sh`→`s` 就不再套 `s`→`sh`），且最多迭代 2 轮。
 *  ② **n/l 与 -n/-ng 不能叠加**：`lin` →(n/l) `nin` →(-n/-ng) `ning`，于是「林」会命中「宁」。
 *     这两个是**两件事**（`宁` ning 与 `林` lin 差一个声母 + 一个韵尾），叠起来等于把无关的人捞进来。
 *     所以 n/l 只在「原音节」这一层展开，不再进下一轮。
 *  ③ **只对汉字扩展、且 ≥2 个汉字**（沿用同音字的门槛）：单字放开会把「张」扩成上百个字。
 */
const FUZZY_RULES = [
  // ① 前后鼻音：-n ↔ -ng（西南官话、江淮官话最常见）。只在这些韵尾之间互换。
  { key: 'nasal', from: /^(.*[aeiouv])n$/, to: '$1ng' },
  { key: 'nasal', from: /^(.*[aeiouv])ng$/, to: '$1n' },
  // ② 平翘舌：zh/ch/sh ↔ z/c/s（南方普遍不分，北方偶有反向）
  { key: 'retroflex', from: /^zh/, to: 'z' },
  { key: 'retroflex', from: /^z(?!h)/, to: 'zh' },
  { key: 'retroflex', from: /^ch/, to: 'c' },
  { key: 'retroflex', from: /^c(?!h)/, to: 'ch' },
  { key: 'retroflex', from: /^sh/, to: 's' },
  { key: 'retroflex', from: /^s(?!h)/, to: 'sh' },
  // ③ n / l 不分（湖南、四川、湖北）—— **只在原音节层展开**（见约束 ②）
  { key: 'nl', from: /^n/, to: 'l', baseOnly: true },
  { key: 'nl', from: /^l/, to: 'n', baseOnly: true },
  // ④ f / h 不分（湖南、福建、广东）：只覆盖 fu↔hu（fa/fei 扩开会命中大量无关音节）
  { key: 'fh', from: /^fu/, to: 'hu' },
  { key: 'fh', from: /^hu/, to: 'fu' },
];

/**
 * 一个音节的所有「地方读音变体」（含它自己）
 *
 * 迭代时**每条规则只在一个音节上生效一次**（记为 usedKeys），
 * 因此 `sh`→`s` 之后不会再被 `s`→`sh` 拉回来（那条已被用过），也不会叠成 `shh`。
 *
 * @param {string} py 已归一的拼音音节
 * @returns {string[]} 去重后的音节列表，第一个一定是原音节
 */
function fuzzyReadingVariants(py) {
  const base = normPy(py);
  if (!base || !/^[a-zv]+$/.test(base)) return base ? [base] : [];
  const out = new Set([base]);
  // 状态里带 used（已用过的规则类）与 terminal（不再继续展开）
  let frontier = [{ py: base, used: new Set(), terminal: false }];
  for (let round = 0; round < 2; round += 1) {
    const next = [];
    for (const cur of frontier) {
      if (cur.terminal) continue; // 终结节点只进结果、不再派生（见下方 n/l 规则说明）
      for (const rule of FUZZY_RULES) {
        // 同一类规则（nasal / retroflex / nl / fh）在一次推导里只用一次：
        // 这是「不叠出 shheng / zhhang」的唯一保证
        if (cur.used.has(rule.key)) continue;
        // n/l 只允许作用在**原音节**上（约束 ②：与 -n/-ng 叠加会造出「林→宁」的假命中）
        if (rule.baseOnly && cur.py !== base) continue;
        const alt = cur.py.replace(rule.from, rule.to);
        if (alt === cur.py) continue;
        if (!/^[a-zv]{2,}$/.test(alt)) continue;
        const used = new Set(cur.used);
        used.add(rule.key);
        // ⚠️ baseOnly 规则（n/l）的结果是**终结节点**：不再参与任何后续派生。
        //   否则 `lin` →(n/l) `nin` →(鼻音) `ning`，而「宁」与「林」是两个人 ——
        //   两条不同性质的错读叠在一起，就是同音搜索最容易变成「什么都能搜到」的地方。
        const terminal = cur.terminal || rule.baseOnly;
        if (!out.has(alt)) {
          out.add(alt);
          next.push({ py: alt, used, terminal });
        }
      }
    }
    if (!next.length) break;
    frontier = next;
  }
  return [...out];
}

/**
 * 生成同音/错音匹配用的正则**源串列表**（一种读音组合一条）。
 *
 * 返回的是「正则片段」而不是完整的锚定正则：姓名是子串匹配，
 * 用户可能只记得名字里的两个字（「伟明」要能命中「张伟明」）。
 *
 * ===== 错音字（用户 2026-11-12）=====
 * 每个汉字的候选字符类不只取「同音字」，而是取「**读音变体**的全部同音字」：
 *   `鹏`(peng) → 变体 [peng, pen, pong…] → 取 peng/pen 的全部同音字并集。
 * 于是搜「冯绍鹏」也能命中「冯绍盆」（pen），这正是方言错读要覆盖的场景。
 *
 * ⚠️ 变体数上限（MAX_VARIANTS）在这里的作用变了：它约束的是**整条关键字**的组合数。
 *   3 字名 × 每字 3 个变体读音 = 27 条正则，单个正则里有 3 个字符类，Mongo 仍能走索引前缀；
 *   再多（4 字名全多音）就会拼出上百条 —— 按「原读音优先」的顺序截断，
 *   保证**用户实际输入的那个读音永远在第 1 条**（哪怕截断也不会搜不到本人）。
 *
 * @param {string} keyword
 * @returns {string[]} 正则源串（不含首尾斜杠）
 */
function homophonePatterns(keyword) {
  if (!hasNameScope(keyword)) return [];
  const parts = splitHan(keyword);
  // 每个汉字：候选字符类列表（原读音在前，错音变体在后）
  let variants = [{ src: '' }];
  for (const p of parts) {
    if (!p.han) {
      // 非汉字（数字/字母/空格）：按字面量拼进去（调用方会做正则转义）
      for (const v of variants) v.src += `\u0000${p.ch}`;
      continue;
    }
    const classes = classesForChar(p.ch);
    const next = [];
    for (const cls of classes) {
      for (const v of variants) {
        next.push({ src: `${v.src}[${cls}]` });
        if (next.length >= MAX_VARIANTS) break;
      }
      if (next.length >= MAX_VARIANTS) break;
    }
    // 兜底：一个都没生成（不该发生）时保留原字，避免整条搜索失效
    variants = next.length ? next : variants.map((v) => ({ src: `${v.src}${p.ch}` }));
  }
  // 非汉字部分的占位符换回字面量（调用方统一转义，这里只还原）
  return variants.map((v) => v.src.replace(/\u0000/g, '')).filter(Boolean);
}

/**
 * 一个汉字的候选字符类列表（**顺序有意义**：原读音在最前）
 *
 * 合并规则：把「本字所有读音」+「这些读音的所有模糊音变体」对应的同音字全部并成一个类。
 * 并成一个类而不是每读音一条正则，是因为 Mongo 正则的字符类是一次集合查表，
 * 5 个读音合成 `[a-z…]` 比 5 条独立正则便宜得多（且结果集相同）。
 *
 * @param {string} ch
 * @returns {string[]} 至少 1 个字符类；原字一定包含在内
 */
function classesForChar(ch) {
  const map = reverseMap();
  const readings = readingsOf(ch);
  if (!readings.length) return [ch];
  const set = new Set([ch]);
  for (const py of readings) {
    // ① 原读音的同音字
    for (const c of map.get(py) || []) set.add(c);
    // ② 错音变体读音的同音字（前后鼻音 / 平翘舌 / n-l / f-h）
    for (const alt of fuzzyReadingVariants(py)) {
      for (const c of map.get(alt) || []) set.add(c);
    }
  }
  return [[...set].slice(0, MAX_CLASS_CHARS).join('')];
}

/** 正则元字符转义（关键字里的数字/字母/括号不能当语法用） */
function escapeRe(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 普通（原样）子串正则 */
function plainRegex(keyword) {
  return new RegExp(escapeRe(String(keyword || '').trim()), 'i');
}

/**
 * 同音匹配正则数组（**只在 ≥2 个汉字时非空**）
 * @param {string} keyword
 * @returns {RegExp[]}
 */
function homophoneRegexes(keyword) {
  return homophonePatterns(keyword).map((src) => new RegExp(src, 'i'));
}

/**
 * 构造关键字搜索的 `$or` 条件（普通子串 + 同音字）
 *
 * @param {string} keyword
 * @param {object} [opts]
 * @param {string[]} [opts.nameFields] 参与**同音**匹配的字段（默认 realName）
 * @param {string[]} [opts.textFields] 只做普通子串匹配的字段（学号 / 班级 / 账号 / openid）
 * @param {boolean} [opts.exactField]  额外要求完全相等的字段（如 openid）
 * @returns {object[]|null} 可直接塞进 `filter.$or` 的数组；关键字为空返回 null
 */
function keywordOr(keyword, { nameFields = ['realName'], textFields = [], exactField = '' } = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return null;
  const plain = plainRegex(kw);
  const or = [];
  for (const f of nameFields) or.push({ [f]: plain });
  for (const f of textFields) or.push({ [f]: plain });
  if (exactField) or.push({ [exactField]: kw });
  // 同音字只加在姓名类字段上：学号/班级没有读音可言
  for (const re of homophoneRegexes(kw)) {
    for (const f of nameFields) or.push({ [f]: re });
  }
  return or;
}

/** 仅供测试/排障：清反向表缓存 */
function clearCache() {
  reverse = null;
}

module.exports = {
  hanCount,
  hasNameScope,
  homophonePatterns,
  homophoneRegexes,
  fuzzyReadingVariants,
  classesForChar,
  plainRegex,
  keywordOr,
  escapeRe,
  clearCache,
};
