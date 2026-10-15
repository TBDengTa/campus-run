/**
 * user_badges.level 存量回填（幂等，可重复执行）
 *
 * 背景：
 *   commit a9e0b51 给 user_badges 加了 level（获得该行时所处的等级：等级徽章 = 定义的 tierLevel，
 *   独立徽章 = 0）。但 905 行存量数据**连字段都没有** —— Mongoose 读取时用 schema 默认值补 0，
 *   所以「.lean() / 聚合管道」两条路径看到的 level 不一致（管道里 undefined），任何按 level 的
 *   统计/分组都会漏数据。
 *
 * 规则：
 *   ① 等级徽章（定义 mode==='tier'）：level := 定义的 tierLevel；
 *   ② 独立徽章（mode==='single' 或 tierGroup 为空）：level := 0；
 *   ③ 只改 level !== tierLevel 的行，其余不动；结果稳定，重复执行第二次为 0 更新；
 *   ④ 定义里找不到的 badgeKey 一律跳过并告警（不猜等级、不写脏值）。
 *
 * 刻意不放进启动流程：1500+ 用户量级下启动期迁移是性能红线（见 AGENTS.md「迁移」一节）。
 *
 * 用法（在 server/ 目录）：
 *   node scripts/backfill-badge-level.js --dry-run   # 试运行，只统计不写入
 *   node scripts/backfill-badge-level.js             # 正式执行
 */

const { MongoClient } = require('mongodb');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const DRY_RUN = process.argv.includes('--dry-run');
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB_NAME || 'campus_run';

const log = (...a) => console.log(...a);

async function main() {
  const t0 = Date.now();
  log(`\n===== user_badges.level 回填${DRY_RUN ? '（试运行，不写入）' : ''} =====`);
  log(`库: ${DB_NAME}\n`);

  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db(DB_NAME);
  const badgeCol = db.collection('badges');
  const ubCol = db.collection('user_badges');

  // ---------- 执行前基线 ----------
  const beforeBadges = await badgeCol.countDocuments();
  const beforeUb = await ubCol.countDocuments();
  const beforeNoLevel = await ubCol.countDocuments({ level: { $exists: false } });
  const badgeIndexes = (await badgeCol.indexes()).map((i) => i.name);
  const ubIndexes = (await ubCol.indexes()).map((i) => i.name);
  log('—— 执行前 ——');
  log(`  badges                        = ${beforeBadges}`);
  log(`  user_badges                   = ${beforeUb}`);
  log(`  user_badges 无 level 字段的行 = ${beforeNoLevel}`);
  log(`  badges 索引                   = ${badgeIndexes.join(', ')}`);
  log(`  user_badges 索引              = ${ubIndexes.join(', ')}`);

  // ---------- 目标 level 映射：key → level ----------
  const defs = await badgeCol.find({}).project({ key: 1, name: 1, mode: 1, tierGroup: 1, tierLevel: 1 }).toArray();
  const levelOf = new Map();
  for (const d of defs) {
    const key = String(d.key || '');
    if (!key) continue;
    const isTier = d.mode === 'tier' || (d.mode !== 'single' && String(d.tierGroup || '').trim() !== '');
    const tierLevel = Number(d.tierLevel) || 0;
    // 等级徽章必须有 tierLevel>=1（模型 pre-validate 已强制）；这里兜底：拿不到就当 0，并告警
    if (isTier && tierLevel < 1) {
      log(`  [告警] 等级徽章 key=${key} name=${d.name || ''} 的 tierLevel=${tierLevel} 非法，按 0 处理`);
    }
    levelOf.set(key, isTier ? Math.max(0, tierLevel) : 0);
  }
  const tierKeys = [...levelOf.entries()].filter(([, lv]) => lv > 0);
  const singleKeys = [...levelOf.entries()].filter(([, lv]) => lv === 0);
  log(`\n—— 定义口径 ——`);
  log(`  等级徽章（要回填 tierLevel）: ${tierKeys.map(([k, lv]) => `${k}=Lv${lv}`).join(', ') || '（无）'}`);
  log(`  独立徽章（level 固定 0）   : ${singleKeys.map(([k]) => k).join(', ') || '（无）'}`);

  // ---------- 计算待更新行 ----------
  // 用 upsert 语义不适用：只对已有行做 $set；用 updateMany(条件含 level 不等) 天然幂等
  const plans = [];
  for (const [key, lv] of levelOf.entries()) {
    const filter =
      lv > 0
        ? { badgeKey: key, level: { $ne: lv } } // 含「字段缺失」「0」「旧值」三种
        : { badgeKey: key, $or: [{ level: { $exists: false } }, { level: { $ne: 0 } }] };
    const matched = await ubCol.countDocuments(filter);
    if (matched) plans.push({ key, level: lv, matched, filter });
  }

  // 引用不到定义的残留行：只报告，不动
  const knownKeys = new Set(levelOf.keys());
  const allRefKeys = (await ubCol.distinct('badgeKey')).filter(Boolean);
  const unknownKeys = allRefKeys.filter((k) => !knownKeys.has(k));

  log('\n—— 待回填明细 ——');
  let totalMatched = 0;
  for (const p of plans) {
    totalMatched += p.matched;
    log(`  key=${p.key}  →  level=${p.level}  待更新 ${p.matched} 行`);
  }
  if (!plans.length) log('  无需更新（幂等：level 已全部对齐）');
  log(`  合计待更新 ${totalMatched} 行 / 全表 ${beforeUb} 行`);
  if (unknownKeys.length) {
    log(`  [告警] ${unknownKeys.length} 个 badgeKey 在 badges 定义里找不到，跳过不动：${unknownKeys.join(', ')}`);
  }

  // ---------- 执行 ----------
  let updated = 0;
  if (DRY_RUN) {
    updated = 0;
    log(`\n[试运行] 将更新 ${totalMatched} 行，未写入任何数据`);
  } else {
    for (const p of plans) {
      const r = await ubCol.updateMany(p.filter, { $set: { level: p.level } });
      updated += r.modifiedCount || 0;
      log(`  key=${p.key} 已更新 ${r.modifiedCount || 0} 行（匹配 ${r.matchedCount || 0}）`);
    }
    log(`\n已更新 ${updated} 行`);
  }

  // ---------- 执行后校验 ----------
  const afterUb = await ubCol.countDocuments();
  const afterNoLevel = await ubCol.countDocuments({ level: { $exists: false } });
  let afterMismatch = 0;
  for (const [key, lv] of levelOf.entries()) {
    const filter =
      lv > 0
        ? { badgeKey: key, level: { $ne: lv } }
        : { badgeKey: key, $or: [{ level: { $exists: false } }, { level: { $ne: 0 } }] };
    afterMismatch += await ubCol.countDocuments(filter);
  }
  const afterBadges = await badgeCol.countDocuments();
  const afterBadgeIndexes = (await badgeCol.indexes()).map((i) => i.name);
  const afterUbIndexes = (await ubCol.indexes()).map((i) => i.name);

  log('\n—— 执行后 ——');
  log(`  badges                        = ${afterBadges}  (执行前 ${beforeBadges}，${afterBadges === beforeBadges ? '未变化 ✅' : '已变化'})`);
  log(`  user_badges                   = ${afterUb}  (执行前 ${beforeUb}，${afterUb === beforeUb ? '未变化 ✅' : '已变化 ⚠️'})`);
  log(`  user_badges 无 level 字段的行 = ${afterNoLevel}  (执行前 ${beforeNoLevel})`);
  log(`  仍未对齐的行                  = ${afterMismatch}  ${afterMismatch === 0 ? '✅' : '⚠️'}`);
  log(`  badges 索引                   = ${afterBadgeIndexes.join(', ')}  ${afterBadgeIndexes.join() === badgeIndexes.join() ? '(未变化 ✅)' : '(已变化)'}`);
  log(`  user_badges 索引              = ${afterUbIndexes.join(', ')}  ${afterUbIndexes.join() === ubIndexes.join() ? '(未变化 ✅)' : '(已变化)'}`);
  log(`\n统计：更新 ${DRY_RUN ? 0 : updated} 行，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s${DRY_RUN ? '（试运行未写入）' : ''}`);

  await client.close();
  return { updated: DRY_RUN ? 0 : updated, wouldUpdate: totalMatched, unknownKeys: unknownKeys.length };
}

main().catch((e) => {
  console.error('\n回填失败:', e.message);
  process.exit(1);
});
