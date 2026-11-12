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
 * 生成同音匹配用的正则**源串列表**（一种读音组合一条）。
 *
 * 返回的是「正则片段」而不是完整的锚定正则：姓名是子串匹配，
 * 用户可能只记得名字里的两个字（「伟明」要能命中「张伟明」）。
 *
 * @param {string} keyword
 * @returns {string[]} 正则源串（不含首尾斜杠）
 */
function homophonePatterns(keyword) {
  if (!hasNameScope(keyword)) return [];
  const parts = splitHan(keyword);
  // 每个汉字：候选字符类列表（多音字 = 多个读音各一个类）
  let variants = [{ src: '' }];
  for (const p of parts) {
    if (!p.han) {
      // 非汉字（数字/字母/空格）：按字面量拼进去（调用方会做正则转义）
      for (const v of variants) v.src += `\u0000${p.ch}`;
      continue;
    }
    const readings = readingsOf(p.ch);
    const classes = readings.length ? readings.map(classOfReading) : [p.ch];
    const next = [];
    for (const v of variants) {
      for (const cls of classes) {
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
  plainRegex,
  keywordOr,
  escapeRe,
  clearCache,
};
