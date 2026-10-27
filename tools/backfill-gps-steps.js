/**
 * 回填 GPS 记录的步数与卡路里（用户 2026-10-27「你看这个没有步数的换算啊」）。
 *
 * 背景：GPS 记录原来固定写 `steps: 0`，而小程序提交 GPS 时不计步，
 * 于是详情页永远显示「0 步 / 0 千卡」。修复后新记录会按距离反算，
 * 但**已有记录**仍是 0 —— 用本脚本一次性回填。
 *
 * 换算口径（与 services/wechat.js::estimateFromSteps 完全一致，避免两套算法）：
 *   steps    = round(distance / 0.7)       // 约 0.7 米/步
 *   calories = round(steps * 0.04)         // 千卡
 *
 * 安全策略：
 *   · 只处理 source='gps' 且 **steps 为 0/缺失** 且 distance > 0 的记录；
 *   · 已有非零步数的记录一律不动（可能是手环真实计数，估算值不该覆盖）；
 *   · 默认 --dry-run，要加 --apply 才真正写库。
 *
 * 用法：
 *   node tools/backfill-gps-steps.js           # 预览
 *   node tools/backfill-gps-steps.js --apply   # 执行
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'server', 'node_modules', 'dotenv')).config({
  path: path.join(ROOT, 'server', '.env'),
});
const mongoose = require(path.join(ROOT, 'server', 'node_modules', 'mongoose'));
const RunRecord = require(path.join(ROOT, 'server', 'src', 'models', 'run-record'));

const APPLY = process.argv.includes('--apply');
const STRIDE_METERS = 0.7; // 与 estimateFromSteps 同口径
const KCAL_PER_STEP = 0.04;

function estimate(distanceMeters) {
  const steps = Math.round(Math.max(0, Number(distanceMeters) || 0) / STRIDE_METERS);
  return { steps, calories: Math.round(steps * KCAL_PER_STEP) };
}

async function main() {
  const [base, query] = (process.env.MONGO_URI || '').split('?');
  await mongoose.connect(`${base.replace(/\/$/, '')}/${process.env.MONGO_DB_NAME}${query ? `?${query}` : ''}`);

  const filter = {
    source: 'gps',
    distance: { $gt: 0 },
    $or: [{ steps: 0 }, { steps: { $exists: false } }, { steps: null }],
  };

  const total = await RunRecord.countDocuments(filter);
  console.log(`[回填] 待处理 ${total} 条（steps=0 且 distance>0）`);
  if (!total) {
    console.log('[回填] 无需处理');
    await mongoose.disconnect();
    return;
  }

  // 分批处理，避免一次性把几万条文档读进内存
  const BATCH = 500;
  let done = 0;
  let scanned = 0;
  const samples = [];

  for (let skip = 0; ; skip += 0) {
    // 每次都从头取：处理过的记录会脱离 filter，天然收敛
    const rows = await RunRecord.find(filter).limit(BATCH).select('_id distance steps calories').lean();
    if (!rows.length) break;
    scanned += rows.length;

    const ops = [];
    for (const r of rows) {
      const est = estimate(r.distance);
      if (est.steps <= 0) continue;
      if (samples.length < 5) {
        samples.push({ dist: r.distance, from: r.steps, to: est.steps, cal: est.calories });
      }
      ops.push({
        updateOne: {
          filter: { _id: r._id },
          // 同时补卡路里：0 步必然对应 0 千卡，一并修正
          update: { $set: { steps: est.steps, calories: est.calories } },
        },
      });
    }

    if (ops.length) {
      if (APPLY) {
        await RunRecord.bulkWrite(ops, { ordered: false });
      }
      done += ops.length;
    }

    // 预览模式：处理完这一批就停（避免无限循环）
    if (!APPLY) break;
    // 防御：万一有记录 est.steps<=0 不满足更新条件，会一直留在 filter 里 → 加个上限
    if (scanned > 200000) {
      console.log('[回填] 超过扫描上限，停止');
      break;
    }
  }

  console.log('\n[样本] distance → steps → calories');
  for (const s of samples) {
    console.log(`  ${s.dist}m  ${s.from || 0} → ${s.to} 步，${s.cal} 千卡`);
  }

  if (APPLY) {
    const left = await RunRecord.countDocuments(filter);
    console.log(`\n[完成] 已更新 ${done} 条；剩余待处理 ${left} 条`);
    if (left) console.log('[提示] 仍有剩余通常是 distance 极小（折算 0 步），属正常');
  } else {
    console.log(`\n[预览] 将更新 ${done} 条。确认无误后加 --apply 执行：`);
    console.log('  node tools/backfill-gps-steps.js --apply');
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('[回填失败]', e.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
