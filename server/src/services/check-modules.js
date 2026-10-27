/**
 * 班超检查模块注册表：默认配置 + 明细校验 + 指标计算 + 模块扣分折算
 *
 * 这一层是「五大检查」的唯一事实来源（single source of truth）：
 *   - 小程序录入表单：GET /api/union/modules 直接把 fields / periods / options 下发给前端渲染；
 *   - 写入校验：normalizeDetails() 按同一份 fields 白名单裁剪与类型校验（未知字段直接丢弃）；
 *   - 展示与排名：metrics / scoring 决定「出勤率怎么算、扣多少分」。
 *
 * 口径常量（**前端只做即时预览，提交与统计仍以服务端为准**，避免两端算出不同结果）：
 *   出勤率 rate = metric('metric')，分母是 divisor=true 的字段（人数类）；
 *   班级总评 = 100 − Σ(各模块 deduce)，见 services/band-chao.js。
 *
 * ===== 派生人数（fields[].derived = true）=====
 * 原则：**能从已知数推导出来的人数，一律不让用户填**（需求原话：「实到不用填，选缺勤名单自动算」）。
 *   早操 / 晚自习：缺勤 = 缺勤名单人数；实到 = 应到 − 缺勤名单人数（≥0）
 *   查宿          ：未归 = 未归名单人数；实到 = 应住 − 未归名单人数（≥0）
 *   早八          ：迟到人数 = 迟到名单人数
 *   卫生          ：得分由评价折算（优 100 / 良 80 / 差 60）
 * 实现要点：
 *   ① normalizeDetails() **丢弃**客户端传来的 derived 字段（防伪造：把缺勤填 0 冲掉真实缺勤）；
 *   ② fillDerived() 是唯一写入方；新提交按名单推算，**老记录回读时保留已落实到**，
 *      避免历史考勤被重算成「全勤」（见 fillDerived 里的 resolveActual 注释）；
 *   ③ seedCheckModules() 用 DEF_VERSION 做一次性结构迁移（当前 v3），老库重启后自动换新表单。
 */
const CheckModule = require('../models/check-module');
const { normalizeFormula, evaluate } = require('./formula');

// ===== 可用变量（公式里只能出现这些 key；其余一律视为 0）=====
// 第四轮口径精简：只保留**新表单里真实存在**的人数键 + 派生键。
// 已删掉的旧键（actualClassroom / onlineDorm / transferIn / transferOut / actualStay /
// leaveStayCount / lateReturnCount / earlyLeaveCount / leaveCount / violationCount）不再列出 ——
// 公式里引用它们也只会得到 0（evaluate 对未知变量返回 0，不会抛错，所以老配置不会炸）。
const COMMON_VARS = [
  'shouldCount',
  'actualCount',
  'absentCount',
  'lateCount',
  'shouldStay',
  'notReturnedCount',
  'vacancyCount',
  'score',
];

// 名单类字段（students）单条记录最多几人：服务端校验与前端选人上限共用这一个常量，
// 避免「前端让选 200 人、服务端只收 100」这种两端不一致。
// **必须定义在 DEFAULT_MODULES 之前**（模块定义里用到了它，const 有暂时性死区 —— 放后面会启动即崩）
const FIELD_LIMIT = 200;

// 现场照片（type:'photo'）单条记录最多几张：与 routes/union.js 顶层 photos 的 slice(0,9) 同口径
const PHOTO_LIMIT = 9;

// ===== 五个内置模块的默认定义（管理端可改名称/部门/选项/权重，key 不可改）=====
const DEFAULT_MODULES = [
  {
    key: 'hygiene',
    name: '卫生检查',
    shortName: '卫生',
    ownerDeptKey: 'life',
    ownerDeptName: '生活部',
    entryDeptKeys: ['life'],
    // 三类受检对象：教室 / 宿舍 / 卫生区（第四轮由仅 classroom 扩为三类）
    targetTypes: ['classroom', 'dorm_room', 'area'],
    periods: [],
    fields: [
      // 评价：优 / 良 / 差（不再逐项打分 —— 用户第四轮口径）
      { key: 'grade', label: '评价', type: 'select', options: ['优', '良', '差'], required: true, hint: '优 / 良 / 差' },
      // photos 是通用字段（type:'photo'）：URL 数组，≤9 张，选填；宿舍场景受隐私裁剪（见 services/union.js::cropPhotos）
      { key: 'photos', label: '现场照片', type: 'photo', hint: '为保证学生隐私，宿舍照片仅检查人、学生会主席团、所属部门部长、教师账号可见' },
      { key: 'remark', label: '说明', type: 'textarea' },
      // derived：得分由「评价」折算（公式引擎不支持字符串比较/三元，见 services/formula.js 文件头，
      // 所以折算必须在这里做数字派生，metric / computeDeduct 只引用这个数字）
      { key: 'score', label: '得分', type: 'int', min: 0, max: 100, derived: true, hint: '系统自动折算：优 100 / 良 80 / 差 60' },
    ],
    metrics: [{ key: 'score', name: '得分', unit: '分', decimals: 1, formula: 'score' }],
    scoring: { mode: 'percent', fullScore: 100, weight: 1, cap: 0 },
    sort: 1,
  },
  {
    key: 'study_evening',
    name: '晚自习考勤',
    shortName: '晚自习',
    ownerDeptKey: 'study',
    ownerDeptName: '学习部',
    entryDeptKeys: ['study'],
    // 用户 2026-10-26 第 5 点：「晚自习检查中不应该显示班级 应该优先显示教室，并且增加筛选教学楼」。
    //   · targetTypes 从 'class' 改成 'classroom'：录入台拿到的 targetType 变 classroom，
    //     关联合成器据此把标题从「班级」换成「教室 / 教学楼·门号」，并按教学楼筛选；
    //   · 检查对象本身仍是「班级」（晚自习按班考勤），只是**展示以教室为主**。
    targetTypes: ['classroom'],
    periods: ['evening_study'],
    fields: [
      // 评价含「网课」：网课班内无学生、在宿舍观看，**不需要填报后续内容**
      // （见 normalizeDetails / fillDerived 里的 onlineDorm 分支：后续字段被清空且不校验必填）
      { key: 'grade', label: '评价', type: 'select', options: ['优', '良', '差', '网课'], required: true, hint: '网课：班内无学生、在宿舍观看，无需填写缺勤与名单' },
      // 用户第五轮口径：实到人数不用手填 —— 选完缺勤名单后由「应到 − 缺勤名单人数」自动推算。
      // 因此 actualCount 改为 derived（不进录入表单、忽略客户端传值），见 fillDerived。
      { key: 'absentList', label: '缺勤名单', type: 'students', maxItems: FIELD_LIMIT, hint: '搜索并选择缺勤学生；实到人数自动计算' },
      { key: 'reason', label: '缺勤原因', type: 'textarea' },
      { key: 'photos', label: '现场照片', type: 'photo', hint: '为保证学生隐私，宿舍照片仅检查人、学生会主席团、所属部门部长、教师账号可见' },
      // derived：应到人数由班级台账自动带入（已知数不让录入人再数一遍），
      // 但它是**出勤率的分母**，所以必须保留 —— 只是不让人填、也不在表单里渲染成输入框
      { key: 'shouldCount', label: '应到人数', type: 'int', min: 0, derived: true, divisor: true, hint: '系统自动带入：班级台账人数' },
      // derived：实到 = 应到 − 缺勤名单人数（选完名单即时推算；老记录仍按已落实到回读）
      { key: 'actualCount', label: '实到人数', type: 'int', min: 0, derived: true, hint: '系统自动计算：应到 − 缺勤名单人数' },
      // derived：缺勤人数 = 缺勤名单人数
      { key: 'absentCount', label: '缺勤人数', type: 'int', min: 0, derived: true, hint: '系统自动计算：缺勤名单人数' },
    ],
    metrics: [{ key: 'rate', name: '出勤率', unit: '%', decimals: 1, formula: 'actualCount / shouldCount' }],
    scoring: { mode: 'rate', fullScore: 100, weight: 1, cap: 0 },
    sort: 2,
  },
  {
    key: 'night_dorm',
    name: '晚上查宿',
    shortName: '查宿',
    ownerDeptKey: 'discipline',
    ownerDeptName: '纪检部',
    entryDeptKeys: ['discipline'],
    // 第四轮：受检对象由班级改为**宿舍房间**（混宿归属仍按在住学生分摊，见 routes/union.js::resolveTarget）
    targetTypes: ['dorm_room'],
    periods: ['night'],
    fields: [
      // 用户第五轮口径：同考勤 —— 实到不手填，选完「未归名单」后由「应住 − 未归名单人数」自动推算。
      { key: 'absentList', label: '未归名单', type: 'students', maxItems: FIELD_LIMIT, hint: '搜索并选择未归学生；实到人数自动计算（混宿房间可能含别班学生）' },
      { key: 'reason', label: '未归原因', type: 'textarea' },
      { key: 'photos', label: '现场照片', type: 'photo', hint: '为保证学生隐私，宿舍照片仅检查人、学生会主席团、所属部门部长、教师账号可见' },
      // derived：应住人数由班级台账/宿舍名单带入（出勤率分母）
      { key: 'shouldStay', label: '应住人数', type: 'int', min: 0, derived: true, divisor: true, hint: '系统自动带入：本房间在住人数' },
      // derived：实到 = 应住 − 未归名单人数（老记录仍按已落实到回读）
      { key: 'actualCount', label: '实到人数', type: 'int', min: 0, derived: true, hint: '系统自动计算：应住 − 未归名单人数' },
      // derived：未归人数 = 未归名单人数
      { key: 'notReturnedCount', label: '未归人数', type: 'int', min: 0, derived: true, hint: '系统自动计算：未归名单人数' },
    ],
    metrics: [
      { key: 'vacancyCount', name: '未归', unit: '人', decimals: 0, formula: 'notReturnedCount' },
      { key: 'rate', name: '在宿率', unit: '%', decimals: 1, formula: 'actualCount / shouldStay' },
    ],
    scoring: { mode: 'deduct', fullScore: 100, weight: 1, cap: 0 },
    sort: 3,
  },
  {
    key: 'morning_exercise',
    name: '早操出勤',
    shortName: '早操',
    ownerDeptKey: 'discipline',
    ownerDeptName: '纪检部',
    entryDeptKeys: ['discipline'],
    targetTypes: ['class'],
    periods: ['morning'],
    fields: [
      // 用户第五轮口径：实到人数不用手填 —— 选完缺勤名单后由「应到 − 缺勤名单人数」自动推算。
      { key: 'absentList', label: '缺勤名单', type: 'students', maxItems: FIELD_LIMIT, hint: '搜索并选择缺勤学生；实到人数自动计算' },
      { key: 'reason', label: '缺勤原因', type: 'textarea' },
      { key: 'photos', label: '现场照片', type: 'photo' },
      // derived：应到人数由班级台账带入（出勤率分母，已知数不让录入人再数一遍）
      { key: 'shouldCount', label: '应到人数', type: 'int', min: 0, derived: true, divisor: true, hint: '系统自动带入：班级台账人数' },
      // derived：实到 = 应到 − 缺勤名单人数（老记录仍按已落实到回读）
      { key: 'actualCount', label: '实到人数', type: 'int', min: 0, derived: true, hint: '系统自动计算：应到 − 缺勤名单人数' },
      // derived：缺勤人数 = 缺勤名单人数
      { key: 'absentCount', label: '缺勤人数', type: 'int', min: 0, derived: true, hint: '系统自动计算：缺勤名单人数' },
    ],
    metrics: [{ key: 'rate', name: '出勤率', unit: '%', decimals: 1, formula: 'actualCount / shouldCount' }],
    scoring: { mode: 'rate', fullScore: 100, weight: 1, cap: 0 },
    sort: 4,
  },
  {
    key: 'morning_class',
    name: '早八出勤',
    shortName: '早八',
    ownerDeptKey: 'discipline',
    ownerDeptName: '纪检部',
    entryDeptKeys: ['discipline'],
    targetTypes: ['class'],
    periods: ['morning_class'],
    fields: [
      // 早八：无法同步课表 → **只记迟到人**（用户第四轮口径），不记应到/实到/缺勤
      { key: 'lateList', label: '迟到名单', type: 'students', maxItems: FIELD_LIMIT, hint: '在校内名单里搜索选择（可按班级/姓名/学号筛选）' },
      { key: 'photos', label: '现场照片', type: 'photo' },
      // derived：迟到人数 = 迟到名单人数（名单是数组，公式引擎只认数字，所以必须派生出数字字段）
      { key: 'lateCount', label: '迟到人数', type: 'int', min: 0, derived: true, hint: '系统自动计算：迟到名单人数' },
    ],
    // 无出勤率（没有应到/实到）：以迟到人数扣分
    metrics: [{ key: 'lateCount', name: '迟到', unit: '人', decimals: 0, formula: 'lateCount' }],
    scoring: { mode: 'deduct', fullScore: 100, weight: 1, cap: 0 },
    // 「只记迟到人」的特殊语义（用户 2026-10-19 口径）：
    //   没有记录 = 当天**没人迟到**（常态），不是「漏录」。
    //   所以要 ① 不计入「应录 / 未录」统计（首页的「应录 N 条」与待办的「未录 N 项」都不含早八）、
    //   ② 各页面把「未录」显示成「无迟到」而不是灰色的「未录」（后者会让老师以为纪检部漏录了）。
    // 注意：录入台**仍然列出**早八班级，方便纪检部在有迟到时进去补录（不是取消入口）。
    optionalWhenMissing: true,
    noRecordText: '无迟到',
    sort: 5,
  },
];

const DEFAULT_BY_KEY = new Map(DEFAULT_MODULES.map((m) => [m.key, m]));

// 派生字段清单：模块 key → Set(不可填的字段 key)
// 为什么在定义之外再单独存一份：① 管理端保存字段定义时要把 derived 强制回填（否则运营点一次保存
// 就把标记弄丢、前端又把缺勤渲染成输入框）；② 启动期播种迁移按它给老库补标记。
// **必须定义在 DEFAULT_MODULES 之后**（依赖上面的字段定义；const 有暂时性死区，放前面会启动即崩）
const DERIVED_KEYS = new Map(
  DEFAULT_MODULES.map((m) => [m.key, new Set((m.fields || []).filter((f) => f.derived).map((f) => f.key))])
);

// 某模块的派生字段集合（内置模块才有；自定义模块返回空集合）
function derivedKeysOf(moduleKey) {
  return DERIVED_KEYS.get(String(moduleKey || '')) || new Set();
}

// 公式里允许出现的变量 = 公共变量 + 所有模块字段 key（含 items/score 等）
function buildVars(moduleDef, details = {}) {
  const vars = {};
  for (const k of COMMON_VARS) vars[k] = 0;
  for (const f of moduleDef.fields || []) vars[f.key] = 0;
  for (const [k, v] of Object.entries(details || {})) {
    if (typeof v === 'number' && Number.isFinite(v)) vars[k] = v;
  }
  return vars;
}

// ===== 明细校验：按 fields 白名单裁剪 + 类型转换 + 范围校验 =====
class DetailError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.code = 400;
  }
}

function coerceNumber(raw, field) {
  if (raw === '' || raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new DetailError(`${field.label || field.key} 必须是数字`);
  if (field.type === 'int' && !Number.isInteger(n)) throw new DetailError(`${field.label || field.key} 必须是整数`);
  if (field.min !== null && field.min !== undefined && n < field.min) {
    throw new DetailError(`${field.label || field.key} 不能小于 ${field.min}`);
  }
  if (field.max !== null && field.max !== undefined && n > field.max) {
    throw new DetailError(`${field.label || field.key} 不能大于 ${field.max}`);
  }
  return n;
}

/**
 * 校验并归一化模块明细（只保留 fields 里定义的**可填**字段）
 * @param {Object} moduleDef check_modules 文档（lean）
 * @param {Object} raw 客户端提交的 details
 * @returns {Object} 归一化后的 details
 */
// 「评价」是否为网课：select 字段在 details 里存成**数组**（normalizeDetails 的 select 分支），
// 但老记录 / 手写调用可能是字符串 —— 两种都要认，否则「网课」判定会漏（历史上就踩过：
// 前端按数组读、后端按字符串比，导致网课班仍被要求填实到人数）。
function isOnlineDormGrade(rawGrade) {
  const arr = Array.isArray(rawGrade) ? rawGrade : rawGrade === undefined || rawGrade === null || rawGrade === '' ? [] : [rawGrade];
  return arr.map((x) => String(x)).includes('网课');
}

function normalizeDetails(moduleDef, raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  // 晚自习「网课」：班内无学生、在宿舍观看，**不填后续内容** ——
  // 必须在这里跳过这几个字段的必填校验，否则后端会因为「实到人数必填」把网课班卡死
  // （前端已经隐藏了这些输入框，用户根本没法填）。与 fillDerived 的清空逻辑同口径。
  const onlineDormSkip =
    moduleDef.key === 'study_evening' && isOnlineDormGrade(src.grade) ? new Set(ONLINE_DORM_CLEARED) : null;
  for (const f of moduleDef.fields || []) {
    // 派生字段（derived）不进「可填集合」：客户端传什么都直接丢弃，
    // 一律由 fillDerived() 按公式推算 —— 否则前端把 absentCount 填 0 就能把缺勤洗掉
    if (f.derived) continue;
    // 网课下这些字段不校验必填（值仍会收，但 fillDerived 随后会清空）
    if (onlineDormSkip && onlineDormSkip.has(f.key)) {
      out[f.key] = Array.isArray(src[f.key]) ? src[f.key] : typeof src[f.key] === 'number' ? src[f.key] : '';
      continue;
    }
    const v = src[f.key];
    if (f.type === 'int' || f.type === 'number') {
      const n = coerceNumber(v, f);
      if (n === null) {
        if (f.required) throw new DetailError(`请填写 ${f.label || f.key}`);
        if (f.default !== null && f.default !== undefined) out[f.key] = f.default;
        continue;
      }
      out[f.key] = n;
      continue;
    }
    if (f.type === 'text' || f.type === 'textarea') {
      const s = v === null || v === undefined ? '' : String(v).trim();
      if (!s && f.required) throw new DetailError(`请填写 ${f.label || f.key}`);
      out[f.key] = s.slice(0, 500);
      continue;
    }
    if (f.type === 'bool') {
      out[f.key] = !!v;
      continue;
    }
    if (f.type === 'select') {
      const arr = Array.isArray(v) ? v.map((x) => String(x)) : v ? [String(v)] : [];
      const allowed = f.options || [];
      // 选项可为空（运营还没维护）：此时接受自由文本，避免把功能卡死
      out[f.key] = allowed.length ? arr.filter((x) => allowed.includes(x)) : arr;
      continue;
    }
    if (f.type === 'students') {
      const arr = Array.isArray(v) ? v : [];
      const max = f.maxItems || FIELD_LIMIT;
      out[f.key] = arr.slice(0, max).map((s) => ({
        userId: s && s.userId ? String(s.userId) : '',
        name: (s && s.name ? String(s.name) : '').slice(0, 30),
        studentId: (s && s.studentId ? String(s.studentId) : '').slice(0, 30),
        roomNo: (s && s.roomNo ? String(s.roomNo) : '').slice(0, 20),
        reason: (s && s.reason ? String(s.reason) : '').slice(0, 60),
      }));
      continue;
    }
    if (f.type === 'photo') {
      // 现场照片：URL 数组，≤9 张、每张 ≤300 字符（与 routes/union.js 的顶层 photos 处理口径一致）。
      // 只收 http(s):// 的字符串，丢弃本地临时路径（wxfile:// / tmp 之类绝不能落库）
      const arr = Array.isArray(v) ? v : [];
      out[f.key] = arr
        .filter((x) => typeof x === 'string' && /^https?:\/\//i.test(x.trim()))
        .slice(0, PHOTO_LIMIT)
        .map((x) => x.trim().slice(0, 300));
      continue;
    }
    if (f.type === 'items') {
      const base = Array.isArray(f.default) ? f.default : [];
      const list = Array.isArray(v) && v.length ? v : base;
      out[f.key] = list.slice(0, 50).map((it, i) => {
        const b = base[i] || {};
        const max = Number(it && it.max !== undefined ? it.max : b.max) || 0;
        let score = Number(it && it.score !== undefined ? it.score : b.score) || 0;
        if (score < 0) score = 0;
        if (max > 0 && score > max) score = max;
        return {
          key: String((it && it.key) || b.key || `item${i + 1}`),
          label: String((it && it.label) || b.label || `项目${i + 1}`).slice(0, 30),
          score,
          max,
        };
      });
      continue;
    }
  }
  return out;
}

// ===== 派生指标计算 =====
/**
 * 计算模块派生指标：rates（比例，0~1 截断到 [0,1.5]）与 values（业务单位）
 */
function computeMetrics(moduleDef, details) {
  const vars = buildVars(moduleDef, details);
  const ratios = {};
  const values = {};
  for (const m of moduleDef.metrics || []) {
    const raw = evaluate(m.formula, vars);
    const safe = Number.isFinite(raw) ? raw : 0;
    if ((m.unit || '') === '%') ratios[m.key] = Math.max(0, Math.min(1.5, safe));
    else values[m.key] = safe;
  }
  return { ratios, values };
}

// ===== 模块扣分折算 =====
/**
 * 单条记录的扣分（用于班级总评求和）
 *   percent：扣分 = (满分 − 得分)/满分 × 100 × 权重（即缺 1 分扣 1 分）
 *   rate   ：扣分 = (1 − 出勤率) × 满分 × 权重（出勤率 >1 记 0 分，不倒加分）
 *   deduct ：直接按记录里的人数类扣分项累计
 * 封顶 cap：单模块每日累计扣分上限（0 = 不封顶）
 */
function computeDeduct(moduleDef, details, metrics) {
  const sc = moduleDef.scoring || {};
  const weight = Number(sc.weight);
  const w = Number.isFinite(weight) && weight > 0 ? weight : 1;
  const full = Number(sc.fullScore) || 100;
  const mode = sc.mode || 'percent';

  if (mode === 'percent') {
    const score = Number(details.score);
    const s = Number.isFinite(score) ? Math.max(0, Math.min(full, score)) : full;
    return round2(((full - s) / full) * 100 * w);
  }
  if (mode === 'rate') {
    const rate = Number(metrics && metrics.ratios && metrics.ratios.rate);
    // ⚠️ 分母缺失 = 出勤率**不适用**，不能当成「出勤率 0」：
    //    网课班没有实到可言（shouldCount 被清 0 → 公式除零 → evaluate 返回 0），
    //    若把 0 当真实出勤率，网课班会被算成 (1-0)*100 = **满分扣分**（真实踩过的 bug）。
    //    判定依据：该模块的分母字段（divisor）在 details 里是 0 / 缺失。
    //    退化方式：分母为 0 时**改用按人计扣**（缺勤/未归/迟到人数），而不是直接 0 分 ——
    //    这样「台账缺失但确实录了缺勤名单」的班仍会被扣到（不静默放过），
    //    而网课班（缺勤与名单都被清空）自然就是 0 分。
    const divisorField = (moduleDef.fields || []).find((f) => f && f.divisor);
    const divisorVal = divisorField ? Number(details && details[divisorField.key]) || 0 : null;
    if (divisorVal === 0) {
      const n = (k) => Number(details[k]) || 0;
      const byPerson = n('notReturnedCount') * 2 + n('absentCount') * 1 + n('lateCount') * 0.5;
      return round2(byPerson * w);
    }
    const r = Number.isFinite(rate) ? Math.max(0, Math.min(1, rate)) : 0;
    return round2((1 - r) * full * w);
  }
  // deduct：以「人」为单位累计（第四轮口径：只保留新表单里真实存在的键）
  //   缺勤（absentCount）1 分/人、迟到（lateCount）0.5 分/人、未归（notReturnedCount）2 分/人。
  //   旧的 violationCount / lateReturnCount / earlyLeaveCount 已随字段删除，不再参与计算
  //   （它们在新表单里没有对应输入，永久为 0）。
  const n = (k) => Number(details[k]) || 0;
  const total = n('notReturnedCount') * 2 + n('absentCount') * 1 + n('lateCount') * 0.5;
  return round2(total * w);
}

// 派生值推算（**唯一写入方**）：能从已知数推出来的值，一律由这里算，客户端传值一律不算数。
//
// 第五轮口径（用户反馈驱动）：
//   卫生（hygiene）    ：评价 优/良/差 → 得分 100/80/60（公式引擎不支持字符串比较，
//                        所以折算必须在这里落成数字派生字段，metric / computeDeduct 只引用它）
//   晚自习/早操/查宿  ：**实到人数不再手填**，选完缺勤/未归名单后自动推算：
//                        实到 = 应到（应住） − 名单人数（≥0）；缺勤/未归 = 名单人数。
//                        应到/应住仍由服务端从班级台账 / 房间在住名单注入（防伪造分母）。
//   早八              ：迟到人数 = 迟到名单人数。
//   网课              ：清空实到/缺勤/名单/原因，应到与缺勤都记 0（班内无学生，不设分母）。
//
// ⚠️ 兼容老记录：老记录的 actualCount 是用户手填后落库的，读回时**必须保留**；
//   否则历史考勤会被全部重算成「全勤」，这是比显示 0 更严重的数据事故。
//   新提交的 actualCount 在 normalizeDetails 里已作为 derived 被剔除 → 这里拿不到旧值，才按名单推算。
const GRADE_SCORE = { 优: 100, 良: 80, 差: 60 };
// 晚自习「网课」时要清空并跳过校验的字段（保持与前端 entry.js 的 hiddenKeysInOnlineDorm 同口径）
const ONLINE_DORM_CLEARED = ['actualCount', 'absentList', 'reason'];

function fillDerived(moduleKey, details, ctx = {}) {
  const d = { ...(details || {}) };
  const key = String(moduleKey || '');
  const listLen = (k) => (Array.isArray(d[k]) ? d[k].length : 0);
  // 只认「确实存过」的数值；0 也是有效值（老记录可能真的实到 0 人）
  const storedNum = (k) => {
    if (!Object.prototype.hasOwnProperty.call(d, k)) return null;
    const raw = d[k];
    if (raw === '' || raw === null || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, n) : null;
  };
  // 应到 / 应住人数：用户明确「应到人数是已知数，不让录入人再填」，所以表单里没有它，
  // 由**服务端在写入时从班级台账 / 宿舍在住名单注入**（routes/union.js 调用 fillDerived 时传 ctx）。
  // 为什么不在表单里填：① 用户要求不填；② 它是出勤率的分母，伪造它就能刷高/压低出勤率。
  const should = (k) => {
    const injected = Number(ctx[k]);
    if (Number.isFinite(injected) && injected > 0) return injected;
    const own = Number(d[k]);
    return Number.isFinite(own) && own > 0 ? own : 0;
  };
  // 实到：老记录/已落库记录优先用存值（兼容），新提交没有存值 → 应到 − 名单人数。
  const resolveActual = (shouldN) => {
    const stored = storedNum('actualCount');
    if (stored !== null) return stored;
    return shouldN > 0 ? Math.max(0, shouldN - listLen('absentList')) : 0;
  };

  if (key === 'hygiene') {
    // 评价 → 得分（评价不在预设里时给 0：宁可 0 分也不给满分，避免脏数据被当优）
    const grade = Array.isArray(d.grade) ? d.grade[0] : d.grade;
    d.score = Object.prototype.hasOwnProperty.call(GRADE_SCORE, grade) ? GRADE_SCORE[grade] : storedNum('score') || 0;
  } else if (key === 'study_evening') {
    if (isOnlineDormGrade(d.grade)) {
      // 网课：清空后续字段（不填实到/缺勤/原因），缺勤自然为 0 —— 与前端隐藏逻辑一致。
      // ⚠️ 这里**也要清掉注入的应到人数**：否则「网课 + 应到 40」会把缺勤算成 40（真实踩过的 bug）。
      for (const k of ONLINE_DORM_CLEARED) {
        if (Array.isArray(d[k])) d[k] = [];
        else if (typeof d[k] === 'number') d[k] = 0;
        else d[k] = '';
      }
      d.shouldCount = 0; // 网课不设分母：没有实到可言，出勤率按 0 处理（scoring 为 rate 时扣分封顶在满分的口径内）
      d.actualCount = 0;
      d.absentCount = 0;
    } else {
      const s = should('shouldCount');
      const actual = resolveActual(s);
      d.shouldCount = s;
      d.actualCount = actual;
      d.absentCount = s > 0 ? Math.max(0, s - actual) : (storedNum('absentCount') ?? listLen('absentList'));
    }
  } else if (key === 'morning_exercise') {
    const s = should('shouldCount');
    const actual = resolveActual(s);
    d.shouldCount = s;
    d.actualCount = actual;
    d.absentCount = s > 0 ? Math.max(0, s - actual) : (storedNum('absentCount') ?? listLen('absentList'));
  } else if (key === 'night_dorm') {
    const s = should('shouldStay');
    const actual = resolveActual(s);
    d.shouldStay = s;
    d.actualCount = actual;
    d.notReturnedCount = s > 0 ? Math.max(0, s - actual) : (storedNum('notReturnedCount') ?? listLen('absentList'));
  } else if (key === 'morning_class') {
    // 迟到人数 = 迟到名单人数（名单是数组，公式引擎只认数字）
    d.lateCount = listLen('lateList') || storedNum('lateCount') || 0;
  }
  return d;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ===== 读取 / 播种 =====

let cache = { at: 0, list: [] };
const CACHE_TTL = 30 * 1000;

async function listModules({ force = false } = {}) {
  if (!force && cache.list.length && Date.now() - cache.at < CACHE_TTL) return cache.list;
  const list = await CheckModule.find().sort({ sort: 1, key: 1 }).lean();
  cache = { at: Date.now(), list };
  return list;
}

function clearCache() {
  cache = { at: 0, list: [] };
}

async function getModule(key) {
  const list = await listModules();
  return list.find((m) => m.key === key) || null;
}

// 内置模块的**定义版本**：改动内置模块的结构（fields / targetTypes / metrics / scoring）时**手动 +1**。
// 为什么需要它：原先 seedCheckModules 对已存在的模块"只在首次创建时写一次"，
//   → 存量库永远用不上新表单（代码改了等于没改）。但又不能每次启动全量覆盖（会抹掉运营改的名称/选项/权重）。
//   用版本号做**一次性结构迁移**：库里 defVersion < 本版本 → 覆盖结构字段一次；相等 → 跳过（幂等）。
//   历史：v1 = 老口径（卫生 7 项打分 / 应到人数手填 / 查宿按班级）；v2 = 第四轮新表单 + 照片字段；
//         v3 = 第五轮：实到人数改为 derived（选缺勤/未归名单自动推算，不再手填）；
//         v4 = 第六轮：早八「没有记录 = 无迟到」语义（optionalWhenMissing + noRecordText）；
//         v5 = 2026-10-26：晚自习 targetTypes 由 ['class'] 改为 ['classroom']
//              （用户「晚自习不应该显示班级 应该优先显示教室，并增加筛选教学楼」）——
//              存量库的 targetTypes 必须靠这次迁移更新，否则代码改了线上仍是旧值。
const DEF_VERSION = 5;

// 启动期幂等播种：内置模块的 key/结构以代码为准（entryDeptKeys 每次同步，保证鉴权口径一致），
// 运营可改的部分（名称、字段选项、计分权重）**只在首次创建时写入，之后不覆盖**；
// 但**结构定义在 defVersion 变新时强制覆盖一次**（见上）。
async function seedCheckModules() {
  const results = { created: 0, updated: 0, skipped: 0, migrated: 0 };
  for (const def of DEFAULT_MODULES) {
    const exists = await CheckModule.findOne({ key: def.key }).lean();
    if (!exists) {
      await CheckModule.create({ ...def, builtIn: true, defVersion: DEF_VERSION });
      results.created += 1;
      continue;
    }
    const set = {};
    const curVersion = Number(exists.defVersion) || 0;

    // ===== 结构性迁移（版本变新才做，只做一次）=====
    if (curVersion < DEF_VERSION) {
      // fields / metrics 是**结构**：必须整体换成新定义，否则线上还是旧表单。
      set.fields = def.fields;
      set.metrics = def.metrics;
      set.scoring = def.scoring;
      set.targetTypes = def.targetTypes;
      set.periods = def.periods;
      // 名称与简称属于"结构的一部分"（用户第四轮改了名字，如「教室卫生检查」→「卫生检查」）：
      // 一并更新；运营之后想改仍可在管理端改（版本已落，不会再被覆盖）。
      set.name = def.name;
      set.shortName = def.shortName;
      set.sort = def.sort;
      set.ownerDeptKey = def.ownerDeptKey;
      set.ownerDeptName = def.ownerDeptName;
      // v4 新增的语义字段也是**结构的一部分**：不随迁移落库的话，存量库的早八会继续按「未录」算
      //（代码改了等于没改 —— 这正是 defVersion 存在的理由）。显式给 false / '' 兜底，
      // 避免老模块缺字段时被 schema 默认值悄悄变回 false 而这里是 undefined。
      set.optionalWhenMissing = !!def.optionalWhenMissing;
      set.noRecordText = def.noRecordText || '';
      set.defVersion = DEF_VERSION;
      results.migrated += 1;
    }

    // ===== 常规幂等补齐（与版本无关，缺失才补）=====
    // ⚠️ entryDeptKeys（谁能录入 = 鉴权真源）**只在缺失时补默认值，不再每次强制回写**。
    //   用户 2026-10-21「我自行配置职责模块即可」：旧实现每次启动把它重置成代码里的
    //   ['life']/['study']/['discipline']，于是学校在管理端改的部门绑定**下次重启静默失效**
    //   （与权限组、部门播种同一类"假生效"）。
    //   旁证：POST /modules/:key/reset（恢复内置默认）本来就刻意不动 entryDeptKeys
    //   （见 routes/admin/union.js 该处注释）—— 说明这个字段的归属一直是「学校配置」。
    if (!Array.isArray(exists.entryDeptKeys) || !exists.entryDeptKeys.length) {
      set.entryDeptKeys = def.entryDeptKeys;
    }
    if (!exists.builtIn) set.builtIn = true;
    if (curVersion >= DEF_VERSION) {
      // 已是当前版本：只补缺失的结构字段，不做覆盖（保留运营改动）
      if (!exists.targetTypes || !exists.targetTypes.length) set.targetTypes = def.targetTypes;
      if (def.periods && def.periods.length && (!exists.periods || !exists.periods.length)) set.periods = def.periods;
      if (!exists.metrics || !exists.metrics.length) set.metrics = def.metrics;
      if (!exists.ownerDeptKey) set.ownerDeptKey = def.ownerDeptKey;
      if (!exists.ownerDeptName) set.ownerDeptName = def.ownerDeptName;
      if (!exists.fields || !exists.fields.length) set.fields = def.fields;
      if (!exists.defVersion) set.defVersion = DEF_VERSION;
      // ⚠️ **新增结构字段时必须补这一行**（本轮真实踩坑）：
      //   只在 curVersion < DEF_VERSION 分支里写新字段是不够的 —— 如果新字段是与「版本号 +1」
      //   分两次改的（或那次迁移启动时库里已经是新版本号），迁移分支永远不会再进来，
      //   新字段就**永远落不了库**：代码改了、库里还是旧的，而 defVersion 已经是新的、看不出异常。
      //   本轮就发生了：defVersion 先到 4，随后才加 optionalWhenMissing → 早八一直按「未录」算。
      //   这里对「库里缺该字段」的情况无条件补齐（只补缺、不覆盖运营改动）。
      if (exists.optionalWhenMissing === undefined) set.optionalWhenMissing = !!def.optionalWhenMissing;
      if (exists.noRecordText === undefined) set.noRecordText = def.noRecordText || '';
    }
    if (Object.keys(set).length) {
      await CheckModule.updateOne({ key: def.key }, { $set: set });
      results.updated += 1;
    } else {
      results.skipped += 1;
    }
  }
  clearCache();
  return results;
}

// 管理端恢复默认（字段与计分）
function defaultOf(key) {
  return DEFAULT_BY_KEY.get(key) || null;
}

module.exports = {
  DEFAULT_MODULES,
  DEFAULT_BY_KEY,
  DERIVED_KEYS,
  derivedKeysOf,
  FIELD_LIMIT,
  PHOTO_LIMIT,
  DEF_VERSION,
  DetailError,
  listModules,
  getModule,
  seedCheckModules,
  clearCache,
  normalizeDetails,
  fillDerived,
  isOnlineDormGrade,
  computeMetrics,
  computeDeduct,
  defaultOf,
  round2,
};
