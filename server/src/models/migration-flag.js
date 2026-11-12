const mongoose = require('mongoose');

/**
 * 一次性数据迁移的完成标记（每个迁移一条文档）。
 *
 * 为什么需要它：仓库约定「启动期迁移必须幂等且只在首次生效」，而按文档内容判断
 * 「这条迁移过没有」经常不可靠 —— 例如 10 分制换算：`score=8` 既可能是百分制的 8 分、
 * 也可能是 10 分制的 8 分，靠数值区分就会**把已换算的数据再除一次 10**（不可逆的数据损坏）。
 * 所以用一条独立标记文档表示「这个 key 的迁移已经跑完」，与业务数据完全解耦。
 *
 * 用法：`if (await isDone('key')) return;` → 干活 → `await markDone('key')`。
 * 中途崩溃时标记不会写入，下次启动重跑；因此**干活本身也要带逐文档守卫**
 * （见 services/check-modules.js::migrateScoreScale 里 `scoreScale: { $ne: 10 }` 那个条件）。
 */
const migrationFlagSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    // 迁移统计（条数 / 跳过数），排障时能回答「到底改了多少条」
    info: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: 'migration_flags' }
);

migrationFlagSchema.statics.isDone = async function (key) {
  const doc = await this.findOne({ key }).lean();
  return !!doc;
};

migrationFlagSchema.statics.markDone = async function (key, info = {}) {
  await this.updateOne({ key }, { $set: { key, info } }, { upsert: true });
};

module.exports = mongoose.model('MigrationFlag', migrationFlagSchema, 'migration_flags');
