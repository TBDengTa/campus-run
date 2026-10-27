const mongoose = require('mongoose');

/**
 * 步数异常记录（用户 2026-10-27 需求：「对于有异常但是没到自动封禁的记录进行查看可以进行手动封禁」）。
 *
 * 为什么单独建一张表，而不是塞进 ban_records：
 *   ban_records 记的是**已经发生处置**的流水（ban / unban），
 *   而这里记的是**待研判的线索** —— 大部分记录永远不会被处置（管理员看过后认为正常），
 *   两者生命周期不同，混在一张表里会让「封禁历史」被大量噪音污染。
 *
 * 生命周期：
 *   同步时被 step-anomaly 判定为 suspicious / autoBan → 写入一条 status='open'
 *   管理员在「异常记录」里查看 → 手动封禁（status='banned'）或标记正常（status='dismissed'）
 *   自动封禁的也记一条，status='banned' + autoBanned=true，便于事后复核
 */
const stepAnomalySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    openid: { type: String, default: '', index: true },
    // 冗余姓名/班级：管理员列表要直接看人，避免每次 join users（也防用户改名后对不上）
    realName: { type: String, default: '' },
    className: { type: String, default: '' },
    studentId: { type: String, default: '' },

    date: { type: String, default: '', index: true }, // 被判定那天的 YYYY-MM-DD（北京时区）
    // 来源分流（用户 2026-10-27「针对不同的跑步类型如微信同步、GPS 分开来」）：
    //   werun 微信同步 / gps GPS 实跑。两种行为特征完全不同，判定模型也是两套。
    source: { type: String, enum: ['werun', 'gps'], default: 'werun', index: true },
    cumulativeSteps: { type: Number, default: 0 }, // 当日累计步数（判定依据；GPS 记录留 0）
    deltaSteps: { type: Number, default: 0 }, // 本次新增
    score: { type: Number, default: 0 }, // 可疑度分数（0~100，规则分与模型分取大）
    reasons: { type: [String], default: [] }, // 命中的特征，如「重复数字 66666」
    // 学习模型的判断（0~1，Isolation Forest 异常分）：留档便于事后复核
    // 「这条是规则判的还是模型判的」—— 可解释性对反作弊系统是硬要求。
    modelScore: { type: Number, default: null },
    modelLevel: { type: String, default: '' },
    // 判定时的特征快照（Mixed）：管理员处置这条记录后，
    // 它连同特征一起进入 step_labels 作为训练样本。
    // **必须在这里存一份**：原始 run_records 可能被清理，而训练集不能因此残缺。
    features: { type: mongoose.Schema.Types.Mixed, default: null },

    // open 待研判 / banned 已封禁 / dismissed 已排除（管理员认为正常）
    status: { type: String, enum: ['open', 'banned', 'dismissed'], default: 'open', index: true },
    autoBanned: { type: Boolean, default: false }, // 是否由系统自动封禁（区别于手动）
    handledBy: { type: String, default: '' }, // 处置的管理员 openid
    handledAt: { type: Date },
    handleNote: { type: String, default: '' }, // 管理员备注
  },
  { timestamps: true }
);

// 列表查询：按状态 + 时间倒序（管理端默认视图）
stepAnomalySchema.index({ status: 1, createdAt: -1 });
// 同一人同一天只保留一条待研判记录：反复同步刷屏没意义，
// 由写入方做 upsert（更新分数与原因），不重复插入。
stepAnomalySchema.index({ userId: 1, date: 1, status: 1 });

module.exports = mongoose.model('StepAnomaly', stepAnomalySchema, 'step_anomalies');
