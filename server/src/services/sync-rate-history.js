/**
 * 微信同步「历史增速」重建（用户 2026-11-03「如果是同步增速 50.0 步/秒这种，
 * 我还要看历史增速的判断」）—— 唯一实现，Web 控制台与小程序管理端共用。
 *
 * ===== 为什么从 run_records 重建，而不是另存同步日志 =====
 * 判定用的 elapsedMs 本来就是「本次同步时刻 − 当天上一条 werun 记录的 createdAt」
 * （steps.js::syncWerunDay），而 run_records 里每条 werun 记录存的就是**增量 steps +
 * createdAt**。所以按 openid+date 取当日全部 werun 记录逐条重算
 * `增速 = steps ÷ (createdAt_i − createdAt_{i-1})`，得到的正是判定当时的口径，
 * 与线上完全同源 —— 不新造日志表，也不可能漂移。
 *
 * ===== 口径限制（要向研判员说明，避免误读） =====
 *   · 1 小时内多次同步会**合并**进同一条记录（SYNC_WINDOW_MS），createdAt 是窗口起点，
 *     中间那些同步的精确时刻不可恢复 —— 但判定用的也是同一个窗口，所以历史表与
 *     「当时为什么判」仍然一致；
 *   · 零增量的同步、被限制拦截的同步本就不落库，历史表天然不含它们；
 *   · 间隔 < MIN_WINDOW_SEC（180s）的行标 short=true：分母不可信，判定也不看它
 *     （微信步数本身有分钟级聚合延迟，见 check-sync-rate.js 钉死的四条不变量）。
 */
const StepAnomaly = require('../models/step-anomaly');
const RunRecord = require('../models/run-record');
const { addDays } = require('../utils/dates');
const { MIN_WINDOW_SEC } = require('./step-anomaly');
const { ApiError } = require('../utils/response');

// 展示上限：一天最多二十几次同步，30 行足够覆盖，防极端刷屏
const MAX_ROWS = 30;
// 「高增速」摘要线：与硬规则最低门槛一致（checkStepRate 的 15 步/秒档）
const FAST_PER_SEC = 15;

/**
 * 重建某条微信同步异常的「当日逐次同步 + 增速」。
 *
 * @param {string} anomalyId step_anomalies 的 _id
 * @returns {Promise<{date:string, rows:Array<{at:Date, steps:number, intervalSec:number|null, perSec:number|null, short:boolean}>, summary:{syncs:number, fastSyncs:number}}>}
 */
async function syncRateHistory(anomalyId) {
  const rec = await StepAnomaly.findById(anomalyId).lean();
  if (!rec) throw new ApiError(404, 404, '异常记录不存在');
  if (rec.source !== 'werun') throw new ApiError(400, 400, '该记录不是微信同步线索（历史增速只对微信同步有意义）');
  if (!rec.openid) throw new ApiError(400, 400, '该记录缺少 openid，无法回查同步历史');

  const rows = await RunRecord.find({ openid: rec.openid, date: rec.date, source: 'werun' })
    .sort({ createdAt: 1 })
    .select('steps createdAt')
    .lean();

  // 跨天参照：首条的间隔 = 首条 createdAt − 前一天最后一条的 createdAt（与判定的 lastSyncAt 同源）
  const prevKey = addDays(rec.date, -1);
  const prevDay = await RunRecord.findOne({ openid: rec.openid, date: prevKey, source: 'werun' })
    .sort({ createdAt: -1 })
    .select('createdAt')
    .lean();
  let prev = prevDay ? new Date(prevDay.createdAt) : null;

  const out = [];
  let fastSyncs = 0;
  for (const r of rows) {
    const steps = Math.max(0, Number(r.steps) || 0);
    const at = new Date(r.createdAt);
    let intervalSec = null;
    let perSec = null;
    let short = false;
    if (prev) {
      intervalSec = Math.round((at.getTime() - prev.getTime()) / 1000);
      if (intervalSec < MIN_WINDOW_SEC) {
        // 窗口过短：分母不可信，判定不看它，展示也不给增速数字
        short = true;
      } else if (intervalSec > 0) {
        perSec = Number((steps / intervalSec).toFixed(2));
        if (perSec >= FAST_PER_SEC) fastSyncs += 1;
      }
    }
    out.push({ at, steps, intervalSec, perSec, short });
    prev = at;
  }

  return {
    date: rec.date,
    rows: out.slice(-MAX_ROWS),
    summary: { syncs: out.length, fastSyncs },
  };
}

module.exports = { syncRateHistory, FAST_PER_SEC, MIN_WINDOW_SEC };
