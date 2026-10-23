/**
 * 极小的公式求值器（只允许「变量名 + 数字 + 四则运算 + 括号」）
 *
 * 用途：check_modules.metrics[].formula —— 出勤率、在宿率这类派生指标的计算式存在配置里，
 * 因此**不能** eval / new Function（配置能被管理端改，等于给了执行任意代码的口子）。
 * 这里用递归下降解析，作用域只认白名单变量，未知变量一律 0。
 *
 * 支持的语法： a + b - c * d / e、(a + b) / (c - d)、小数、括号嵌套、一元负号。
 * 不支持：函数调用、幂、字符串、比较、三元 —— 用不到，也不安全。
 */

function normalizeFormula(formula) {
  return String(formula || '').trim();
}

// 词法：标识符（含下划线）| 数字 | 运算符 | 括号
function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      const n = Number(src.slice(i, j));
      if (!Number.isFinite(n)) throw new Error(`公式里的数字不合法：${src.slice(i, j)}`);
      tokens.push({ t: 'num', v: n });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ t: 'var', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/()'.includes(ch)) {
      tokens.push({ t: ch });
      i += 1;
      continue;
    }
    throw new Error(`公式里有不支持的字符：${ch}`);
  }
  return tokens;
}

// 递归下降：expr → term (('+'|'-') term)* ；term → unary (('*'|'/') unary)* ；unary → '-'? primary
function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function primary() {
    const tk = next();
    if (!tk) throw new Error('公式不完整');
    if (tk.t === 'num') return { t: 'num', v: tk.v };
    if (tk.t === 'var') return { t: 'var', v: tk.v };
    if (tk.t === '(') {
      const inner = expr();
      const close = next();
      if (!close || close.t !== ')') throw new Error('公式括号不匹配');
      return inner;
    }
    throw new Error('公式语法错误');
  }

  function unary() {
    const tk = peek();
    if (tk && tk.t === '-') {
      next();
      return { t: 'neg', a: unary() };
    }
    return primary();
  }

  function term() {
    let left = unary();
    for (;;) {
      const tk = peek();
      if (tk && (tk.t === '*' || tk.t === '/')) {
        next();
        left = { t: tk.t, a: left, b: unary() };
        continue;
      }
      return left;
    }
  }

  function expr() {
    let left = term();
    for (;;) {
      const tk = peek();
      if (tk && (tk.t === '+' || tk.t === '-')) {
        next();
        left = { t: tk.t, a: left, b: term() };
        continue;
      }
      return left;
    }
  }

  const ast = expr();
  if (pos !== tokens.length) throw new Error('公式有多余内容');
  return ast;
}

function evalNode(node, scope) {
  switch (node.t) {
    case 'num':
      return node.v;
    case 'var': {
      const v = Number(scope[node.v]);
      return Number.isFinite(v) ? v : 0;
    }
    case 'neg':
      return -evalNode(node.a, scope);
    case '+':
      return evalNode(node.a, scope) + evalNode(node.b, scope);
    case '-':
      return evalNode(node.a, scope) - evalNode(node.b, scope);
    case '*':
      return evalNode(node.a, scope) * evalNode(node.b, scope);
    case '/': {
      const den = evalNode(node.b, scope);
      if (!den) return 0; // 分母为 0 → 0（而不是 Infinity/NaN 污染排名）
      return evalNode(node.a, scope) / den;
    }
    default:
      return 0;
  }
}

// AST 缓存：公式字符串在配置里固定，重复求值不必反复解析
const astCache = new Map();
const MAX_CACHE = 500;

/**
 * 求值：evaluate('(a + b) / (c - d)', {a:1,b:2,c:5,d:1}) → 0.75
 * 公式非法时**返回 0 并告警**，绝不抛错中断业务（配置写错不该让接口 500）。
 */
function evaluate(formula, scope = {}) {
  const src = normalizeFormula(formula);
  if (!src) return 0;
  try {
    let ast = astCache.get(src);
    if (!ast) {
      ast = parse(tokenize(src));
      if (astCache.size > MAX_CACHE) astCache.clear();
      astCache.set(src, ast);
    }
    const v = evalNode(ast, scope);
    return Number.isFinite(v) ? v : 0;
  } catch (e) {
    console.warn('[formula] 公式求值失败，按 0 处理:', src, e.message);
    return 0;
  }
}

// 校验（管理端保存配置时用）：返回 null 表示合法，否则返回错误信息
function validateFormula(formula) {
  const src = normalizeFormula(formula);
  if (!src) return null;
  try {
    parse(tokenize(src));
    return null;
  } catch (e) {
    return e.message;
  }
}

module.exports = { normalizeFormula, evaluate, validateFormula };
