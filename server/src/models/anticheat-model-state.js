const mongoose = require('mongoose');

/**
 * 唐跑AI数据模型的**阶段状态**（每个来源一份：微信同步 / GPS 实跑）。
 *
 * ===== 为什么需要一份「模型状态」文档 =====
 * 有监督模型不是训完就完事的东西，它有生命周期：先影子跑（只辅助）、
 * 验证过才主判、表现掉了要退回去。这条生命周期必须**持久化**，否则：
 *   ① 进程重启 → 退回无监督，等于「升级」是内存幻觉；
 *   ② 多进程部署 → A 进程升了、B 进程没升，同一批数据在两个进程判出不同结果；
 *   ③ 没有历史 → 出了事（误封一波）无法回答「什么时候升的、凭什么升的、谁批的」。
 *
 * ===== 阶段（stage）=====
 *   0  unsupervised 无监督（Isolation Forest 独立判定，历史行为，默认）
 *   1  assist       有监督**影子/辅助**：分数参与判定但**封顶在自动封禁线以下**，
 *                   只能把记录推进待研判队列，绝不单独封号（同「涨幅速度」的护栏思路）。
 *                   这个阶段的作用是**积累影子证据**：标注时记下当时的有监督概率，
 *                   后面用它来判断「这个模型到底准不准」。
 *   2  primary      有监督**主判**：风险分可越过自动封禁线（仍需过自动处置总开关）。
 *                   只有在影子阶段攒够证据、且精度达标后才允许进入。
 *
 * `mode` 决定自动评估能不能动它：
 *   auto   默认，自升级/自降级都由评估周期决定；
 *   manual 管理员手动锁定过（例如刚 rollback 或临时压制），自动评估**只写建议不改阶段**。
 *
 * 并发：`stateVersion` 是 CAS 版本号。多进程同时评估时，
 * 抢输的那个进程 `findOneAndUpdate` 返回 null → 放弃本次写入（不重试、不覆盖），
 * 避免两个进程互相覆盖出「一半新一半旧」的模型。
 */
const modelStateSchema = new mongoose.Schema(
  {
    // 来源分流：两个模型各训各的，状态也必须分开（拿微信的标注去训 GPS 是错的）
    source: { type: String, enum: ['werun', 'gps'], required: true, unique: true },

    stage: { type: Number, default: 0, min: 0, max: 2 },
    stageKey: { type: String, enum: ['unsupervised', 'assist', 'primary'], default: 'unsupervised' },
    mode: { type: String, enum: ['auto', 'manual'], default: 'auto' },
    // CAS 版本号：每次写入 +1，抢输的进程据此放弃（见文件头「并发」）
    stateVersion: { type: Number, default: 0 },

    // ===== 有监督模型本体（纯 JS 逻辑回归，见 services/anticheat-supervised.js）=====
    // features 是**训练时选定的特征清单**：训练与推理必须用同一份，
    // 否则模型向量的维度顺序会静默错位（不报错，只是判得不准）。
    model: {
      type: new mongoose.Schema(
        {
          features: { type: [String], default: [] },
          bias: { type: Number, default: 0 },
          weights: { type: [Number], default: [] },
          means: { type: [Number], default: [] },
          stds: { type: [Number], default: [] },
          // 操作点：概率 → 风险分的分段锚点（训练时在验证集上挑的，见 anticheat-supervised）
          operating: {
            pSuspicious: { type: Number, default: 0.5 },
            pAutoBan: { type: Number, default: 0.8 },
          },
          epochs: { type: Number, default: 0 },
        },
        { _id: false }
      ),
      default: null,
    },

    // 训练与验证指标（把「凭什么升级」写成可复核的数字，而不是一句"模型变好了"）
    metrics: { type: mongoose.Schema.Types.Mixed, default: null },
    // 特征覆盖情况：解释「为什么某个维度没进模型」（标注跨版本累积，老标注缺新特征）
    coverage: { type: mongoose.Schema.Types.Mixed, default: [] },

    sampleCount: { type: Number, default: 0 },
    trainedAt: { type: Date, default: null },
    // 进入当前阶段的时刻：主判阶段要求有「驻留时长」，防止刚升就立刻再升一级
    stagedAt: { type: Date, default: null },
    lastEvaluatedAt: { type: Date, default: null },
    lastReason: { type: String, default: '' },
    // 最近一次评估「离下一阶段还差什么」（管理端直接展示，不需要前端再算）
    lastMissing: { type: [String], default: [] },

    // ===== 升级/降级历史（审计：什么时候、凭什么、谁批的）=====
    history: {
      type: [
        new mongoose.Schema(
          {
            at: { type: Date, default: Date.now },
            from: { type: Number, default: 0 },
            to: { type: Number, default: 0 },
            reason: { type: String, default: '' },
            operator: { type: String, default: 'system' },
            metrics: { type: mongoose.Schema.Types.Mixed, default: null },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { timestamps: true }
);

// 历史只保留最近 50 条（升级是低频事件，但错误循环可能刷屏）
modelStateSchema.pre('save', function trimHistory(next) {
  if (Array.isArray(this.history) && this.history.length > 50) {
    this.history = this.history.slice(-50);
  }
  next();
});

module.exports = mongoose.model('AnticheatModelState', modelStateSchema, 'anticheat_model_states');
module.exports.STAGE_KEYS = ['unsupervised', 'assist', 'primary'];
module.exports.STAGE_TEXT = { unsupervised: '无监督', assist: '影子辅助', primary: '有监督主判' };
