/**
 * 清理重复的徽章定义（幂等，可重复执行）
 *
 * 背景：
 *   现网徽章定义是 1.0 迁移过来的旧 hex key（badges.key = '6a27...'）+ 图片 URL，正在被
 *   905 行 user_badges 引用；而 DEFAULT_BADGES 是 2.0 的语义 key（first_run / steps_100k …），
 *   早期启动期播种按 key 逐条补建，把 10 条语义 key 的僵尸定义塞进了库里（多数无图标，
 *   且 user_badges 一行都不引用）。两套定义同时 enabled=true，徽章页会出现双份、图标缺失。
 *
 * 规则（产品已确认，方案 A）：
 *   ① 只清理 DEFAULT_BADGES 里的语义 key 定义（一眼可辨的「默认定义残留」）；
 *   ② 任何被 user_badges 引用的 key 一律不删（先查引用，再删）——宁可留下脏数据也不孤儿化用户记录；
 *   ③ 幂等：重复执行第二次应为 0 删除。
 *
 * 用法（在 server/ 目录）：
 *   node scripts/dedupe-badge-definitions.js --dry-run   # 试运行，只统计不写入
 *   node scripts/dedupe-badge-definitions.js             # 正式执行
 *
 * 注意：只做「删除重复定义」，不碰 user_badges 的任何一个字段。
 */

const { MongoClient } = require('mongodb');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { DEFAULT_BADGES } = require('../src/services/badges');

const DRY_RUN = process.argv.includes('--dry-run');
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB_NAME || 'campus_run';

const log = (...a) => console.log(...a);

// 旧 hex key 形如 '6a27890b1b18e02a79517e5b'；语义 key 是英文小写下划线，两者不会撞
const HEX_KEY_RE = /^[0-9a-f]{24}$/i;

async function main() {
  const t0 = Date.now();
  log(`\n===== 徽章定义去重${DRY_RUN ? '（试运行，不写入）' : ''} =====`);
  log(`库: ${DB_NAME}\n`);

  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db(DB_NAME);
  const badgeCol = db.collection('badges');
  const ubCol = db.collection('user_badges');

  // ---------- 执行前基线 ----------
  const beforeBadges = await badgeCol.countDocuments();
  const beforeUb = await ubCol.countDocuments();
  const badgeIndexes = (await badgeCol.indexes()).map((i) => i.name);
  const ubIndexes = (await ubCol.indexes()).map((i) => i.name);
  log('—— 执行前 ——');
  log(`  badges            = ${beforeBadges}`);
  log(`  user_badges       = ${beforeUb}`);
  log(`  badges 索引       = ${badgeIndexes.join(', ')}`);
  log(`  user_badges 索引  = ${ubIndexes.join(', ')}`);

  // ---------- 引用集合（一次查全，905 行量级） ----------
  const referencedKeys = new Set((await ubCol.distinct('badgeKey')).filter(Boolean));
  log(`  user_badges 引用的不同 key = ${referencedKeys.size}`);

  // ---------- 候选：DEFAULT_BADGES 语义 key 的定义 ----------
  const defaultKeys = DEFAULT_BADGES.map((d) => d.key);
  const candidates = await badgeCol
    .find({ key: { $in: defaultKeys } })
    .project({ key: 1, name: 1, icon: 1, enabled: 1, mode: 1, tierGroup: 1, tierLevel: 1 })
    .toArray();

  // 守卫：被引用的 / 非语义 key 形态的（保守：hex key 或不在 DEFAULT_BADGES 的一律不删）
  const toDelete = [];
  const skipped = [];
  for (const doc of candidates) {
    const key = String(doc.key || '');
    const isSemanticDefault = !HEX_KEY_RE.test(key) && defaultKeys.includes(key);
    if (!isSemanticDefault) {
      skipped.push({ key, name: doc.name, reason: '非默认语义 key 形态' });
      continue;
    }
    if (referencedKeys.has(key)) {
      skipped.push({ key, name: doc.name, reason: '被 user_badges 引用，守卫跳过' });
      continue;
    }
    toDelete.push(doc);
  }

  log('\n—— 候选明细 ——');
  for (const d of toDelete) {
    log(
      `  [删除] key=${d.key}  name=${d.name || '(空)'}  icon=${d.icon ? '有' : '无'}  enabled=${d.enabled !== false}`
    );
  }
  for (const s of skipped) {
    log(`  [跳过] key=${s.key}  name=${s.name || '(空)'}  原因=${s.reason}`);
  }

  // ---------- 执行 ----------
  let deleted = 0;
  const deleteKeys = toDelete.map((d) => d.key);
  if (!deleteKeys.length) {
    log('\n没有可删除的重复定义（幂等：库已干净）');
  } else if (DRY_RUN) {
    log(`\n[试运行] 将删除 ${deleteKeys.length} 条重复定义：${deleteKeys.join(', ')}`);
  } else {
    const r = await badgeCol.deleteMany({ key: { $in: deleteKeys } });
    deleted = r.deletedCount || 0;
    log(`\n已删除 ${deleted} 条重复定义：${deleteKeys.join(', ')}`);
  }

  // ---------- 执行后 ----------
  const afterBadges = await badgeCol.countDocuments();
  const afterUb = await ubCol.countDocuments();
  const afterBadgeIndexes = (await badgeCol.indexes()).map((i) => i.name);
  const afterUbIndexes = (await ubCol.indexes()).map((i) => i.name);
  // 残留检查：还有没有「被 user_badges 引用但库里已无定义」的孤儿（本次不应产生）
  const remainingKeys = new Set((await badgeCol.distinct('key')).filter(Boolean));
  const orphans = [...referencedKeys].filter((k) => !remainingKeys.has(k));

  log('\n—— 执行后 ——');
  log(`  badges            = ${afterBadges}  (执行前 ${beforeBadges}，删除 ${beforeBadges - afterBadges})`);
  log(`  user_badges       = ${afterUb}  (执行前 ${beforeUb}，${afterUb === beforeUb ? '未变化 ✅' : '发生了变化 ⚠️'})`);
  log(`  badges 索引       = ${afterBadgeIndexes.join(', ')}  ${afterBadgeIndexes.join() === badgeIndexes.join() ? '(未变化 ✅)' : '(已变化)'}`);
  log(`  user_badges 索引  = ${afterUbIndexes.join(', ')}  ${afterUbIndexes.join() === ubIndexes.join() ? '(未变化 ✅)' : '(已变化)'}`);
  log(`  孤儿引用（有记录无定义）= ${orphans.length}${orphans.length ? ' → ' + orphans.join(', ') : ' ✅'}`);
  log(`\n统计：删除 ${DRY_RUN ? 0 : deleted} 条，跳过 ${skipped.length} 条，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s${DRY_RUN ? '（试运行未写入）' : ''}`);

  await client.close();
  return { deleted: DRY_RUN ? 0 : deleted, wouldDelete: deleteKeys.length, skipped: skipped.length, orphans: orphans.length };
}

main().catch((e) => {
  console.error('\n去重失败:', e.message);
  process.exit(1);
});
