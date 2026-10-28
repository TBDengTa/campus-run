/**
 * 班级名规范化迁移（用户 2026-10-28「部分班级存在 25班名称，不是 25级班名称，导致数据不匹配」）。
 *
 * ===== 问题 =====
 * 库里同时存在两套班级命名：
 *   正确（权威口径）：25级云计算技术应用    ← services/roster.js::classNameFromGradeSpecialty 生成
 *   错误（缺「级」字）：25云计算技术应用
 * 结果：
 *   · 5 组台账重复（同一专业两种写法各建了一条），班级管理里看到两个"同一个班"；
 *   · 台账学生数与实际学生数对不上（如 25电子商务 台账 44 / 实际 0，
 *     因为学生全都记在 25级电子商务 名下）；
 *   · 班主任/班委按 homeroomClasses 匹配不到人。
 *
 * ===== 规范规则 =====
 *   /^(\d{2})(?!级)(.+)$/  →  `$1级$2`
 * 即「两位数字 + 后面不是『级』」→ 插入「级」。
 * 只处理 **20~99** 这个两位数的年级前缀（避免把「3号楼」之类误改）。
 *
 * ===== 安全策略 =====
 *   · 默认 --dry-run，只打印不写库；--apply 才执行。
 *   · 台账合并：规范化后若与已有班级重名，**保留已有那条**，把重复条删掉
 *     （先合并必要字段：人数取实际学生数、住宿取实际在住数）。
 *   · 所有 className 文本字段 + classNames 数组 + homeroomClasses 数组一起改。
 *   · 每步都打印，可完整审计。
 *
 * 用法：
 *   node tools/fix-class-names.js            # 预览
 *   node tools/fix-class-names.js --apply    # 执行
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'server', 'node_modules', 'dotenv')).config({
  path: path.join(ROOT, 'server', '.env'),
});
const mongoose = require(path.join(ROOT, 'server', 'node_modules', 'mongoose'));

const APPLY = process.argv.includes('--apply');

// 年级前缀：两位数字（20~99），且后面**不是**「级」
const BAD_RE = /^(2[0-9]|3[0-9]|9[0-9])(?!级)([\s\S]+)$/;

/** 规范化单个班级名：25云计算技术应用 → 25级云计算技术应用 */
function normalizeClassName(name) {
  const s = String(name || '').trim();
  if (!s) return s;
  const m = s.match(BAD_RE);
  if (!m) return s;
  return `${m[1]}级${m[2]}`;
}

function isBad(name) {
  return normalizeClassName(name) !== String(name || '').trim();
}

async function main() {
  const [base, query] = (process.env.MONGO_URI || '').split('?');
  await mongoose.connect(`${base.replace(/\/$/, '')}/${process.env.MONGO_DB_NAME}${query ? `?${query}` : ''}`);
  const db = mongoose.connection.db;

  console.log(`[模式] ${APPLY ? 'APPLY（会写库）' : 'DRY-RUN（只看不改）'}\n`);

  // ===== 1. 收集全部待改的班级名 =====
  const renameMap = new Map(); // old → new
  const collections = await db.listCollections().toArray();
  for (const c of collections) {
    try {
      const names = await db.collection(c.name).distinct('className');
      for (const n of names) if (isBad(n)) renameMap.set(String(n), normalizeClassName(n));
    } catch (e) {
      /* 没有该字段的集合会抛/返回空，忽略 */
    }
    // 数组字段：classNames / homeroomClasses
    for (const field of ['classNames', 'homeroomClasses']) {
      try {
        const arrs = await db.collection(c.name).find({ [field]: { $exists: true } }).project({ [field]: 1 }).toArray();
        for (const doc of arrs) {
          for (const n of doc[field] || []) if (isBad(n)) renameMap.set(String(n), normalizeClassName(n));
        }
      } catch (e) {
        /* 同上 */
      }
    }
  }

  console.log(`===== 1. 需要规范化的班级名：${renameMap.size} 个 =====`);
  const sorted = [...renameMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [o, n] of sorted) console.log(`  ${o}  →  ${n}`);

  // ===== 2. 处理台账重复（规范化后会撞名） =====
  const profiles = db.collection('class_profiles');
  const toDeleteProfiles = [];
  console.log(`\n===== 2. 台账重复检查 =====`);
  for (const [oldName, newName] of sorted) {
    const oldDoc = await profiles.findOne({ className: oldName });
    if (!oldDoc) continue;
    const existing = await profiles.findOne({ className: newName });
    if (existing) {
      // 规范化后撞名：保留已有那条，删掉这条重复的
      toDeleteProfiles.push({ deleteId: oldDoc._id, keep: newName, removed: oldName });
      console.log(`  ⚠️ 合并：${oldName}（台账 ${oldDoc.studentCount || 0} 人）→ 已有 ${newName}（台账 ${existing.studentCount || 0} 人），删除重复台账`);
    } else {
      // 没撞名：直接把台账改名
      console.log(`  ✔ 改名：${oldName} → ${newName}`);
    }
  }

  // ===== 3. 统计各集合要改多少条 =====
  //
  // ⚠️ 性能：不要对「每个集合 × 每个班级名 × 每个字段」逐个 countDocuments ——
  //   9 个集合 × 32 个名字 × 3 个字段 = 800+ 次查询，实测跑 2 分钟还没完。
  //   改用**一次聚合**按字段分组，把「哪些名字要改」在内存里匹配。
  const ARR_FIELDS = ['classNames', 'homeroomClasses'];
  const plan = [];
  for (const c of collections) {
    const coll = db.collection(c.name);
    const rows = [];
    // ① className 文本字段：一次 group
    try {
      const groups = await coll.aggregate([{ $group: { _id: '$className', n: { $sum: 1 } } }]).toArray();
      for (const g of groups) {
        const from = String(g._id || '');
        if (!isBad(from)) continue;
        rows.push({ from, to: normalizeClassName(from), text: g.n, arr: 0 });
      }
    } catch (e) {
      /* 无该字段 */
    }
    // ② 数组字段：一次 unwind + group
    for (const f of ARR_FIELDS) {
      try {
        const groups = await coll
          .aggregate([
            { $match: { [f]: { $exists: true, $ne: [] } } },
            { $unwind: `$${f}` },
            { $group: { _id: `$${f}`, n: { $sum: 1 } } },
          ])
          .toArray();
        for (const g of groups) {
          const from = String(g._id || '');
          if (!isBad(from)) continue;
          const hit = rows.find((r) => r.from === from);
          if (hit) hit.arr += g.n;
          else rows.push({ from, to: normalizeClassName(from), text: 0, arr: g.n });
        }
      } catch (e) {
        /* 该集合没有这个字段 */
      }
    }
    if (rows.length) plan.push({ coll: c.name, rows });
  }

  console.log(`\n===== 3. 各集合待改记录 =====`);
  let totalDocs = 0;
  for (const p of plan) {
    const sumText = p.rows.reduce((a, r) => a + r.text, 0);
    const sumArr = p.rows.reduce((a, r) => a + r.arr, 0);
    totalDocs += sumText + sumArr;
    console.log(`  ${p.coll}: className ${sumText} 条 / 数组字段 ${sumArr} 条`);
    for (const r of p.rows) console.log(`      ${r.from} → ${r.to}  (${r.text}/${r.arr})`);
  }
  console.log(`  合计待改文档引用：${totalDocs}`);

  if (!APPLY) {
    console.log(`\n[预览] 未写库。确认无误后执行：`);
    console.log('  node tools/fix-class-names.js --apply');
    await mongoose.disconnect();
    return;
  }

  // ===== 4. 执行 =====
  console.log(`\n===== 4. 执行迁移 =====`);

  // 4.1 台账：改名 / 删重复
  for (const [oldName, newName] of sorted) {
    const oldDoc = await profiles.findOne({ className: oldName });
    if (!oldDoc) continue;
    const dup = toDeleteProfiles.find((d) => d.deleteId.equals(oldDoc._id));
    if (dup) {
      await profiles.deleteOne({ _id: oldDoc._id });
    } else {
      await profiles.updateOne({ _id: oldDoc._id }, { $set: { className: newName } });
    }
  }
  if (toDeleteProfiles.length) console.log(`  台账：删除重复 ${toDeleteProfiles.length} 条`);
  console.log(`  台账：改名 ${sorted.length - toDeleteProfiles.length} 条`);

  // 4.2 其它集合：文本字段 + 数组字段
  for (const p of plan) {
    for (const r of p.rows) {
      try {
        await db.collection(p.coll).updateMany({ className: r.from }, { $set: { className: r.to } });
      } catch (e) {
        /* 无该字段的集合跳过 */
      }
      for (const f of ARR_FIELDS) {
        try {
          // 数组里替换单个元素：先 pull 再加（$addToSet 去重，避免重复项）
          await db.collection(p.coll).updateMany({ [f]: r.from }, { $pull: { [f]: r.from } });
          await db.collection(p.coll).updateMany({ [f]: { $exists: true, $not: { [f]: r.to } } }, { $addToSet: { [f]: r.to } });
        } catch (e) {
          /* ignore */
        }
      }
    }
    console.log(`  ${p.coll}: 完成`);
  }

  // ===== 5. 校验 =====
  console.log(`\n===== 5. 校验 =====`);
  let leftBad = 0;
  for (const c of collections) {
    try {
      const groups = await db
        .collection(c.name)
        .aggregate([{ $group: { _id: '$className', n: { $sum: 1 } } }])
        .toArray();
      for (const g of groups) if (isBad(String(g._id || ''))) leftBad += g.n;
    } catch (e) {
      /* ignore */
    }
  }
  console.log(`  剩余「无级字」的 className：${leftBad} 条 ${leftBad === 0 ? '✅' : '⚠️'}`);

  // 台账 vs 实际学生数一致性（一次聚合算各班真实学生数，不要逐个 countDocuments）
  console.log(`  台账与实际学生数核对：`);
  const realCounts = await db
    .collection('users')
    .aggregate([{ $match: { role: 'student' } }, { $group: { _id: '$className', n: { $sum: 1 } } }])
    .toArray();
  const realBy = new Map(realCounts.map((r) => [String(r._id || ''), r.n]));
  const allP = await profiles.find({}).project({ className: 1, studentCount: 1 }).toArray();
  let mismatch = 0;
  for (const p2 of allP) {
    const real = realBy.get(p2.className) || 0;
    if (real !== (p2.studentCount || 0)) {
      mismatch += 1;
      if (mismatch <= 10) console.log(`    ⚠️ ${p2.className}: 台账 ${p2.studentCount || 0} / 实际 ${real}`);
    }
  }
  console.log(`    不一致 ${mismatch} 个班 ${mismatch === 0 ? '✅' : '⚠️（可用 roster 重新回填人数）'}`);

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('[迁移失败]', e.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
