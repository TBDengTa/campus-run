const mongoose = require('mongoose');

/**
 * 反作弊**人工标注**（用户 2026-10-27：「标注积累到阈值后自动提示升级」）。
 *
 * ===== 为什么必须单独落库，而不是留在内存 =====
 * 上一版把反馈放在内存数组 `FEEDBACK.samples` 里，这有两个致命问题：
 *   ① 服务重启就全丢 —— 而升级有监督模型恰恰需要**长期积累**的标注；
 *   ② 多进程部署时各进程各存一份，阈值会漂移成不同值（同一批数据判出不同结果）。
 * 标注是这个系统里**唯一的人工监督信号**，必须持久、可审计、可导出（将来训练模型要用）。
 *
 * ===== 与 step_anomalies 的关系 =====
 * step_anomalies 记的是「一条待研判的线索」，本表记的是「管理员对某条线索的判定」。
 * 一条线索只会产生 0 或 1 条标注（open 时没有标注），所以用 anomalyId 唯一索引防重。
 * 但**也允许没有 anomalyId 的标注**（将来管理员可能直接对某个用户标注，不经过线索表）。
 */
const stepLabelSchema = new mongoose.Schema(
  {
    // 关联的异常记录（可空：支持不经过线索表的人工标注）
    anomalyId: { type: mongoose.Schema.Types.ObjectId, ref: 'StepAnomaly', default: null },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    openid: { type: String, default: '' },

    // 来源分流：微信同步 / GPS 两套模型各自积累标注
    source: { type: String, enum: ['werun', 'gps'], default: 'werun', index: true },

    // 人工判定结果（**唯一监督信号**）
    isCheat: { type: Boolean, required: true, index: true },

    // 判定当时的模型分与规则分：训练有监督模型时作为特征输入
    modelScore: { type: Number, default: null },
    ruleScore: { type: Number, default: 0 },

    // 训练用的特征快照：**必须存**，否则将来模型改结构、或者原始记录被删，
    // 这批标注就再也无法用来训练（这是做 ML 数据集最常踩的坑）。
    features: { type: mongoose.Schema.Types.Mixed, default: null },

    operator: { type: String, default: '' }, // 哪个管理员标的
    note: { type: String, default: '' },
  },
  { timestamps: true }
);

// 一条异常记录最多一条标注（重复标注会污染训练集）。
// ⚠️ 用 **partialFilterExpression** 而不是 sparse：
//   sparse 只跳过「字段不存在」，而我们这里默认值是 null —— null 会被索引，
//   于是第二条「不关联具体异常记录」的标注就会撞 E11000（实测踩到）。
//   偏导索引只在 anomalyId 真的存在时才约束，无关联标注可以有多条。
stepLabelSchema.index(
  { anomalyId: 1 },
  { unique: true, partialFilterExpression: { anomalyId: { $type: 'objectId' } } }
);
// 统计/导出：按来源 + 时间
stepLabelSchema.index({ source: 1, createdAt: -1 });

module.exports = mongoose.model('StepLabel', stepLabelSchema, 'step_labels');
