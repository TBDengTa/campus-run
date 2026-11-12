/**
 * 班超分数刻度（10 分制）的唯一出口 + 一次性历史数据换算
 *
 * 用户 2026-11-12：「并且不要满分100分制了，就10分制就行」
 *
 * ===== 为什么要有这个文件 =====
 * 刻度以前散在九处硬编码的 100（band-chao 的 BASE_SCORE、computeDeduct 的 ×100、
 * 看板的 100−扣分、admin 统计的 100−扣分、复审分档区间、卫生评价折算…）。
 * 任何一处漏改就会出现「这页 8 分、那页 80 分」——而用户正是拿页面互相核对的。
 * 现在：
 *   · 满分刻度  → check-modules.FULL_SCORE（本文件只转发，不另定义一份）
 *   · 单条记录得分 → scoreOf(deduct)
 *   · 班级/区间得分 → avgScoreOf(avgDeduct)
 *   · 展示文案   → scoreText(v)（保留两位小数，见下）
 *
 * ===== 为什么展示保留两位小数 =====
 * 10 分制下「迟到 1 人」按新单价只扣 0.05 分。若沿用百分制时代的一位小数，
 * 9.95 → 显示 10.0，录入人会觉得「提交了但没生效」（用户此前就报过这类现象）。
 * 落库存精确值、展示两位小数，两边都不丢信息。
 */
const CheckRecord = require('../models/check-record');
const MigrationFlag = require('../models/migration-flag');
const checkModules = require('./check-modules');

const FULL_SCORE = checkModules.FULL_SCORE;
// 历史刻度（迁移前的满分），只用于「这条数据是不是还没换算」的判定
const LEGACY_FULL_SCORE = 100;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** 扣分 → 本条得分（10 分制，最低 0 分：扣穿了不显示负分，见文件头说明） */
function scoreOf(deduct) {
  const d = Number(deduct);
  const v = Number.isFinite(d) ? d : 0;
  return round2(Math.max(0, FULL_SCORE - v));
}

/** 平均扣分 → 班级/区间得分（同样不出现负数） */
function avgScoreOf(avgDeduct) {
  return scoreOf(avgDeduct);
}

/** 得分 → 展示文案（两位小数；null/undefined = 「—」表示没有数据） */
function scoreText(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  return Number(v).toFixed(2);
}

/**
 * 一次性把历史 check_records 从百分制换算成 10 分制（等比 ÷10）。
 *
 * 三条必须守住的设计：
 *  ① **换算一次、绝不重复**：靠 migration_flags 的标记 + 每条文档的 `scoreScale` 字段双保险。
 *     不能靠「score > 10 才除」判定 —— score=8 既可能是百分制的 8 分、也可能是 10 分制的 8 分，
 *     猜错就是把 0.8 分变成 0.08 分的不可逆损坏。
 *  ② **该不该除，由模块的计分模式决定，不由数值大小决定**：
 *     · `percent` 模式（卫生）的 score 就是「百分制得分」→ 必须 ÷10；
 *     · `rate` / `deduct` 模式的 score 落的是 `details.score`，而这两个模块的表单里
 *       根本没有 score 字段（落的是 0 或人数），÷10 会把「3 人」变成「0.3」。
 *     所以先看模块再看值 —— 用数值阈值猜是这次最容易犯的错。
 *  ③ **deduct 无条件 ÷10**：它是百分制刻度上的扣分（rate 模式 = (1−出勤率)×100、
 *     按人 = 2/1/0.5 分每人），换算后正好等于新单价（0.2/0.1/0.05），
 *     所以**新旧记录的相对扣分关系完全保持**，排名不会因迁移而变形。
 *
 * @param {boolean} [dry] 只统计不改库（排障用）
 */
async function migrateToTenPoint({ dry = false } = {}) {
  if (!dry && (await MigrationFlag.isDone('banchao-score-scale-v10'))) {
    return { skipped: true, reason: '已迁移过' };
  }
  // 模块模式决定 score 字段是不是「百分制得分」（设计 ②）
  const modules = await checkModules.listModules({ force: true });
  const percentMode = new Set(modules.filter((m) => ((m.scoring || {}).mode || 'percent') === 'percent').map((m) => m.key));
  const rows = await CheckRecord.find({ scoreScale: { $ne: FULL_SCORE } })
    .select('moduleKey score deduct details metrics history')
    .lean();
  const stat = { scanned: rows.length, changed: 0, score: 0, deduct: 0, details: 0, metrics: 0, history: 0 };
  const ops = [];

  for (const r of rows) {
    const set = {};
    // ① 本条得分：只有 percent 模式才是「满分制得分」，才需要换算
    const s = Number(r.score);
    if (percentMode.has(r.moduleKey) && Number.isFinite(s) && s !== 0) {
      set.score = round2((s * FULL_SCORE) / LEGACY_FULL_SCORE);
      stat.score += 1;
    }
    // ② 扣分：无条件 ÷10（百分制刻度上的扣分）
    const d = Number(r.deduct);
    if (Number.isFinite(d) && d !== 0) {
      set.deduct = round2((d * FULL_SCORE) / LEGACY_FULL_SCORE);
      stat.deduct += 1;
    }
    // ③ details.score / metrics.values.score（卫生的评价折算分，同样是百分制刻度）
    if (percentMode.has(r.moduleKey)) {
      const ds = r.details && Number(r.details.score);
      if (Number.isFinite(ds) && ds !== 0) {
        set['details.score'] = round2((ds * FULL_SCORE) / LEGACY_FULL_SCORE);
        stat.details += 1;
      }
      const ms = r.metrics && r.metrics.values && Number(r.metrics.values.score);
      if (Number.isFinite(ms) && ms !== 0) {
        set['metrics.values.score'] = round2((ms * FULL_SCORE) / LEGACY_FULL_SCORE);
        stat.metrics += 1;
      }
    }
    // ④ 留痕：不改就出现「原 80 → 新 8」这种跨刻度对比（管理员会以为换算错了）
    if (Array.isArray(r.history) && r.history.length) {
      let touched = false;
      const isPercent = percentMode.has(r.moduleKey);
      const history = r.history.map((h) => {
        const ch = (h && h.changes) || {};
        const next = { ...ch };
        for (const key of ['score', 'deduct']) {
          const c = ch[key];
          if (!c || typeof c !== 'object') continue;
          const n = {};
          for (const side of ['from', 'to']) {
            const v = Number(c[side]);
            if (!Number.isFinite(v)) continue;
            // deduct 一律换算；score 只有 percent 模式才换算（与 ① 同一判定，不能在这里放宽）
            n[side] = key === 'deduct' || isPercent ? round2((v * FULL_SCORE) / LEGACY_FULL_SCORE) : v;
          }
          next[key] = n;
          touched = true;
        }
        return { ...h, changes: next };
      });
      if (touched) {
        set.history = history;
        stat.history += 1;
      }
    }

    if (Object.keys(set).length) stat.changed += 1;
    // scoreScale 无条件写：没有字段变化的记录也要打上标记，否则下次启动又被扫一遍（白扫全表）
    set.scoreScale = FULL_SCORE;
    if (!dry) ops.push({ updateOne: { filter: { _id: r._id }, update: { $set: set } } });
  }

  let written = 0;
  if (!dry && ops.length) {
    // 分批：一次 bulkWrite 上万条会超 Mongo 16MB 单批限制
    const BATCH = 500;
    for (let i = 0; i < ops.length; i += BATCH) {
      const res = await CheckRecord.bulkWrite(ops.slice(i, i + BATCH));
      written += res.modifiedCount || 0;
    }
  }
  // ⚠️ 标记**无条件写**（哪怕一条都没改）：只在有写入时才打标的话，
  // 空库 / 全 0 分的库每次启动都会重扫全表并打一行日志（违反「启动期迁移只在首次生效」）。
  if (!dry) await MigrationFlag.markDone('banchao-score-scale-v10', { ...stat, written });
  return { ...stat, written, dry: !!dry };
}

module.exports = {
  FULL_SCORE,
  LEGACY_FULL_SCORE,
  scoreOf,
  avgScoreOf,
  scoreText,
  migrateToTenPoint,
};
