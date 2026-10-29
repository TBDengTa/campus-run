const mongoose = require('mongoose');

/**
 * 反作弊**人工标注**（用户 2026-10-27 建立；2026-10-29 扩展为四分类并要求按来源分开）。
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
 *
 * ===== 四分类（用户 2026-10-29：「标注要能分开」）=====
 * 旧版只有 isCheat 二元，问题是「数据异常但人没问题」（手机放桌上被微信补同步、
 * 网络重传导致 delta 异常大）会被归成 normal 喂进训练集 ——
 * 模型会学到「这种特征组合是正常的」，阈值越训越松，正是刷步工具最想要的结果。
 * 现在四类：
 *   · cheat   作弊            → 训练集正样本（权重 1）
 *   · minor   轻微违规        → 训练集正样本但**降权 0.5**（如整千步但量级合理），
 *                               处置上给警告而非封禁
 *   · device  设备/网络问题    → **完全排除出训练集**：既不是作弊也不是"正常的刷步特征"，
 *                               留在任何一侧都会污染分布
 *   · normal  正常            → 训练集负样本
 * isCheat 字段保留（= label 是 cheat/minor），老数据不迁移也不出错；
 * 新写入时两者都填，读取一律以 label 为准（isCheat 只为兼容旧查询）。
 */
const stepLabelSchema = new mongoose.Schema(
  {
    // 关联的异常记录（可空：支持不经过线索表的人工标注）
    anomalyId: { type: mongoose.Schema.Types.ObjectId, ref: 'StepAnomaly', default: null },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    openid: { type: String, default: '' },

    // 来源分流：微信同步 / GPS 两套模型各自积累标注（用户 2026-10-29 要求界面上也分开）
    source: { type: String, enum: ['werun', 'gps'], default: 'werun', index: true },

    // ===== 人工判定结果（**唯一监督信号**，四分类）=====
    label: { type: String, enum: ['cheat', 'minor', 'device', 'normal'], default: null, index: true },
    // 兼容字段：label ∈ {cheat, minor} 时为 true。新代码读 label、写两处。
    isCheat: { type: Boolean, required: true, index: true },

    // 判定当时的模型分与规则分：训练有监督模型时作为特征输入
    modelScore: { type: Number, default: null },
    ruleScore: { type: Number, default: 0 },

    // 训练用的特征快照：**必须存**，否则将来模型改结构、或者原始记录被删，
    // 这批标注就再也无法用来训练（这是做 ML 数据集最常踩的坑）。
    features: { type: mongoose.Schema.Types.Mixed, default: null },

    operator: { type: String, default: '' }, // 哪个管理员标的
    note: { type: String, default: '' },
    // 改判次数：>0 说明这条标注被纠正过（导出训练集时可用来评估标注质量）
    revision: { type: Number, default: 0 },
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
// 按类别统计（升级进度页要按 来源×类别 分别数）
stepLabelSchema.index({ source: 1, label: 1 });

// ===== 训练集口径（唯一来源，anticheat-model 与统计都从这里取）=====
// device 排除的理由见文件头；minor 降权而不是排除：它确实是作弊，只是程度轻，
// 全排除会让模型学不到「轻度修饰」这一档。
const TRAIN_WEIGHTS = { cheat: 1, minor: 0.5, normal: 1 };

module.exports = mongoose.model('StepLabel', stepLabelSchema, 'step_labels');
module.exports.LABEL_KINDS = ['cheat', 'minor', 'device', 'normal'];
module.exports.LABEL_TEXT = {
  cheat: '作弊',
  minor: '轻微违规',
  device: '设备/网络问题',
  normal: '正常',
};
module.exports.TRAIN_WEIGHTS = TRAIN_WEIGHTS;
// 进训练集（有监督升级 + 在线校准）的类别过滤条件
module.exports.TRAINABLE_LABELS = Object.keys(TRAIN_WEIGHTS);
