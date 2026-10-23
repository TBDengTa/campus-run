const mongoose = require('mongoose');

// 检查模块注册表（班超的核心配置表）
//   领导要的五大检查全部落在这里：卫生 / 晚自习 / 查宿 / 早操 / 早八。
//   新增一类检查 = 加一条配置（+ 在 services/check-modules.js 里加字段定义），**不需要改表结构**。
//   字段定义（fields）存 Mongo，因为它同时驱动「小程序录入表单渲染」和「服务端 normalize 校验」，
//   不能只放代码里，否则运营改不了；但 normalize 有代码兜底（services/check-modules.js）。
const fieldSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    label: { type: String, default: '' },
    // number 数值 / int 整数 / text 文本 / textarea 多行 / select 单选 / students 学生多选名单
    // items 卫生类扣分项（[{key,label,score,max}]）/ bool 开关
    // photo 检查记录现场照片（URL 数组，≤9 张）—— 第四轮引入
    // ⚠️ 这是**闭合 enum**：新字段类型必须同步加在这里，否则 check_modules.save() 直接校验失败
    //    （services/check-modules.js 里加了 type:'photo' 却没改这里 → 播种/保存即炸）。
    type: { type: String, enum: ['number', 'int', 'text', 'textarea', 'select', 'students', 'items', 'bool', 'photo'], required: true },
    unit: { type: String, default: '' },
    min: { type: Number, default: null },
    max: { type: Number, default: null },
    maxItems: { type: Number, default: null },
    required: { type: Boolean, default: false },
    default: { type: mongoose.Schema.Types.Mixed, default: null },
    options: { type: [String], default: [] }, // select 选项
    placeholder: { type: String, default: '' },
    hint: { type: String, default: '' },
    // 派生指标公式：从 details 计算（如 rate = (actualClassroom + onlineDorm) / (should - leave)）
    //   metric 引用 metrics.key；divisor=true 表示该字段是分母（人数类，供班级总评聚合用）
    formula: { type: String, default: '' },
    divisor: { type: Boolean, default: false },
    // derived=true：**服务端推算的只读字段**（缺勤 / 未归），不进录入表单、忽略客户端传值
    // （口径见 services/check-modules.js 文件头；标记缺失时前端会把它当成可填字段渲染）
    derived: { type: Boolean, default: false },
  },
  { _id: false }
);

const checkModuleSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    shortName: { type: String, default: '' },
    ownerDeptKey: { type: String, default: '' }, // 展示用（实际负责人）
    ownerDeptName: { type: String, default: '' }, // 如「生活部」
    entryDeptKeys: { type: [String], default: [] }, // **鉴权用**：允许录入的部门 key

    targetTypes: { type: [String], default: [] }, // classroom / dorm_room / area / class
    periods: { type: [String], default: [] }, // 可选时段 key
    fields: { type: [fieldSchema], default: [] },
    // 派生指标（前端直出、排名聚合都用它）
    metrics: {
      type: [
        {
          _id: false,
          key: String,
          name: String,
          unit: { type: String, default: '' },
          decimals: { type: Number, default: 0 },
          formula: { type: String, default: '' },
          divisor: { type: Boolean, default: false },
        },
      ],
      default: [],
    },
    // 计分：mode=percent 百分制扣分（缺 1 分扣 1×weight）/ rate 出勤率扣分 / deduct 直接记扣分
    scoring: {
      mode: { type: String, enum: ['percent', 'rate', 'deduct'], default: 'percent' },
      fullScore: { type: Number, default: 100 },
      weight: { type: Number, default: 1 },
      cap: { type: Number, default: 0 }, // 0 = 不封顶（单模块最多扣多少分）
    },
    enabled: { type: Boolean, default: true },
    builtIn: { type: Boolean, default: false },
    sort: { type: Number, default: 0 },
    remark: { type: String, default: '' },
    // ===== 「没有记录 = 正常」的模块语义（当前只有早八）=====
    // optionalWhenMissing=true：该模块当天**没有记录不算「漏录」**，而是「当天没人迟到 / 一切正常」。
    //   影响两件事：① 不计入「应录 / 未录」统计；② 各页面按 noRecordText 显示（「无迟到」）而非「未录」。
    //   早八是唯一一个「只记异常人」的模块（字段只有迟到名单，没有应到/实到）：
    //   没人迟到是常态，把它当漏录会让首页出现永远还不完的待办（用户 2026-10-19 口径）。
    // ⚠️ 录入台**仍会列出**这些班级，方便有迟到时进去补录 —— 这个标记只影响「统计与文案」，
    //   不是「取消入口」；所以它刻意**不叫 optional/disabled**，避免被理解成关掉模块。
    optionalWhenMissing: { type: Boolean, default: false },
    // 未录时的展示文案（如「无迟到」）；为空则退回前端默认的「未录」
    noRecordText: { type: String, default: '' },
    // 内置模块的**定义版本**：由 services/check-modules.js::DEF_VERSION 写入。
    // 用途：内置 module 的结构（fields / targetTypes / metrics / scoring）只在**版本变新时**强制覆盖一次，
    //   —— 因为播种原本是"只在首次创建时写一次"，那样**存量库永远用不上新表单**（改代码等于没改）；
    //   又不能每次启动都全量覆盖（会抹掉运营改过的名称 / 选项 / 权重）。
    //   所以用版本号做「一次性的结构迁移」：版本不同 → 覆盖一次并落版本；版本相同 → 什么都不做（幂等）。
    defVersion: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'check_modules' }
);

// 默认播种：由 services/check-modules.js::seedCheckModules() 按 DEFAULT_MODULES 幂等写入，
// 内置模块不可删除、key 不可改；名称 / 负责部门 / 字段选项 / 计分权重可由管理端修改。
checkModuleSchema.statics.DEFAULT_KEYS = [
  'hygiene',
  'study_evening',
  'night_dorm',
  'morning_exercise',
  'morning_class',
];

module.exports = mongoose.model('CheckModule', checkModuleSchema, 'check_modules');
