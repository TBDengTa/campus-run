const mongoose = require('mongoose');

/**
 * 封禁/解封流水。
 *
 * ===== 为什么要区分「人封 / AI封 / 机封」（用户 2026-10-30）=====
 *   「用户管理列表中的封禁用户要有分类 如人封、机封、AI封的分类」
 *
 * 旧实现只有一个 `operator` 字段（'system' 或管理员 openid）：
 *   · 管理员手动 → operator = openid（能区分）
 *   · **系统触发 → 全部是 'system'** —— 但系统触发其实有两类完全不同的来源：
 *       - 确定性规则（单次暴增超阈值 / 配速低于阈值 / 重复数字）
 *       - AI 模型（Isolation Forest 综合判定）
 *   两类混在同一个 'system' 里，管理员看流水时无法判断「这个人到底是规则抓的还是模型抓的」，
 *   而这恰恰是评估「AI 准不准」与「规则是不是误封」的关键信息。
 *
 * 所以新增 `source` 字段（**与 operator 正交**：operator 记「谁执行」，source 记「依据什么」）：
 *   · manual 人封 —— 管理员/班主任手动处置（operator = 该管理员 openid）
 *   · ai     AI封 —— AI 模型判定（operator 通常是 'system'）
 *   · rule   机封 —— 确定性规则命中（operator 通常是 'system'）
 *   · appeal 申诉复核 —— 申诉通过后系统自动解封（仅 action=unban 有意义）
 *
 * ⚠️ 为什么不复用 operator：operator 是「执行主体」用于追责（谁按的按钮），
 *    source 是「判定依据」用于统计（规则 vs 模型各封了多少、误封率如何）。
 *    混用一个字段就再也拆不开了（历史数据里 'system' 已经不可还原）。
 */
const banRecordSchema = new mongoose.Schema(
  {
    // 迁移后统一为 User 的 ObjectId；用 Mixed 兼容历史字符串 id
    userId: { type: mongoose.Schema.Types.Mixed, required: true, index: true },
    openid: { type: String, index: true },
    action: { type: String, enum: ['ban', 'unban'], required: true },
    banType: { type: String, default: 'manual' }, // 限制类型：login / sync / gps / manual
    reason: { type: String, default: '' },
    durationDays: { type: Number, default: 0 },
    bannedUntil: { type: Date },
    operator: { type: String, default: 'system' }, // 执行主体：'system' 或管理员 openid
    // 判定依据（用户 2026-10-30「封禁要有分类」）：manual 人封 / ai AI封 / rule 机封
    // 历史数据没有这个字段 → 读取时按 operator 推断（见 statics.normalizeSource）
    source: { type: String, enum: ['manual', 'ai', 'rule', 'appeal', ''], default: '', index: true },
  },
  { timestamps: true }
);

// 按来源统计（用户管理列表的封禁分类筛选与计数都要用）
banRecordSchema.index({ source: 1, createdAt: -1 });
banRecordSchema.index({ action: 1, createdAt: -1 });

// 来源文案 —— **唯一定义处**，前端一律用接口下发的 sourceText，不许再各自映射一份。
//
// 为什么刻意用短词（两三个字）：它出现在列表行内的 chip 与详情页徽标上，
// 而 chip 有宽度预算（users 页 layoutChips 超预算会折叠成 +N），
// 「历史（未分类）」这种长度会把同排的其它标签全挤掉。
// 筛选下拉里的长说明由 /filters 的 label 单独给（那里空间充足）。
banRecordSchema.statics.SOURCE_TEXT = {
  manual: '人封',
  ai: 'AI封',
  rule: '机封',
  appeal: '申诉',
  // 历史数据（source 为空且 operator 也不是 openid）
  legacy: '早期',
};

/**
 * 归一化来源：新记录直接用 source；**历史记录**（source 为空）按 operator 推断。
 *
 * 为什么保留这个推断：上线前已经有一批封禁流水，若不标注，
 * 用户列表会显示一堆「未分类」，管理员反而更困惑。
 * 推断规则（保守、可解释）：
 *   · operator 不是 'system' → 一定是人操作的（manual）
 *   · operator === 'system' → 无法还原规则/AI，标 legacy 并在前端提示「早期记录」，
 *     **不猜**（猜错会让「AI 误封率」这类统计失真）
 */
banRecordSchema.statics.normalizeSource = function normalizeSource(rec) {
  const s = rec && rec.source;
  if (s && banRecordSchema.statics.SOURCE_TEXT[s]) return s;
  const op = String((rec && rec.operator) || '');
  if (op && op !== 'system') return 'manual';
  return 'legacy';
};

module.exports = mongoose.model('BanRecord', banRecordSchema, 'ban_records');
module.exports.SOURCE_TEXT = banRecordSchema.statics.SOURCE_TEXT;
module.exports.normalizeSource = banRecordSchema.statics.normalizeSource;
