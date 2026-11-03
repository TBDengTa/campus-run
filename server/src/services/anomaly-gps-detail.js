/**
 * GPS 异常线索的轨迹详情（用户 2026-11-03「WEB/小程序都要看路线图」）—— 唯一实现。
 *
 * 从 routes/console.js 抽出来：小程序管理端要画同样的轨迹图（原生 map 组件），
 * 两边各写一份就会漂移出「一边看得到轨迹、另一边说没有」的分裂（仓库历史反复踩过）。
 * Web 控制台与小程管理端路由都只做鉴权与取参，数据拼装在这里只有一份。
 *
 * 数据源优先级（为什么是这个顺序）：
 *   ① runRecordId —— 正常落库的跑，全量轨迹 + 权威指标；
 *   ② route 快照（step_anomalies.route，判定时降采样存档）—— 与这条线索**精确绑定**；
 *      自动封禁的 GPS 跑不落 run_records（拦截时直接 return），这是它唯一的轨迹，
 *      所以必须排在日期匹配之前；
 *   ③ 旧记录兜底（无快照、无关联）：按 openid+日期就近匹配 run_records ——
 *      判定时刻就在提交当口，同日多条取 createdAt 最接近的那条。
 * 指标一律走 withGpsMetrics（与小程序三条读路径同一份口径，见 gps-metrics.js 文件头）。
 */
const StepAnomaly = require('../models/step-anomaly');
const RunRecord = require('../models/run-record');
const gpsMetrics = require('./gps-metrics');
const { ApiError } = require('../utils/response');

async function anomalyGpsDetail(anomalyId) {
  const rec = await StepAnomaly.findById(anomalyId).lean();
  if (!rec) throw new ApiError(404, 404, '异常记录不存在');
  if (rec.source !== 'gps') throw new ApiError(400, 400, '该记录不是 GPS 实跑线索');

  const f = rec.features || {};
  const fromRun = (doc, dataSource) => {
    const withMetrics = gpsMetrics.withGpsMetrics(doc);
    return {
      dataSource,
      points: gpsMetrics.downsamplePoints(gpsMetrics.normalizePoints(doc.routePoints || [])),
      bounds: withMetrics.metrics.bounds,
      metrics: withMetrics.metrics,
      distance: doc.distance || 0,
      durationSeconds: doc.durationSeconds || 0,
      startTime: doc.startTime || null,
      endTime: doc.endTime || null,
    };
  };

  let payload = null;
  // ① runRecordId
  if (rec.runRecordId) {
    const byId = await RunRecord.findById(rec.runRecordId).lean();
    if (byId) payload = fromRun(byId, 'run_record');
  }
  // ② 轨迹快照（拼 pseudo-record 走同一份 withGpsMetrics，指标口径与 run_records 一致）
  if (!payload && Array.isArray(rec.route) && rec.route.length >= 2) {
    const pseudo = gpsMetrics.withGpsMetrics({
      source: 'gps',
      distance: Number(f.distance) || 0,
      durationSeconds: Math.round(Number(f.duration) || 0),
      routePoints: rec.route,
    });
    payload = {
      dataSource: 'snapshot',
      points: rec.route,
      bounds: pseudo.metrics.bounds,
      metrics: pseudo.metrics,
      distance: pseudo.distance || 0,
      durationSeconds: pseudo.durationSeconds || 0,
      startTime: null,
      endTime: null,
    };
  }
  // ③ 旧记录兜底：openid+日期就近匹配
  if (!payload && rec.openid) {
    const rows = await RunRecord.find({ openid: rec.openid, date: rec.date, source: 'gps' }).lean();
    if (rows.length) {
      const at = new Date(rec.createdAt).getTime();
      let best = rows[0];
      let bestDiff = Math.abs(new Date(best.createdAt).getTime() - at);
      for (const r of rows) {
        const diff = Math.abs(new Date(r.createdAt).getTime() - at);
        if (diff < bestDiff) {
          best = r;
          bestDiff = diff;
        }
      }
      payload = fromRun(best, 'legacy_match');
    }
  }

  return {
    ...(payload || {
      dataSource: 'none',
      points: [],
      bounds: null,
      metrics: null,
      distance: Number(f.distance) || 0,
      durationSeconds: Math.round(Number(f.duration) || 0),
      startTime: null,
      endTime: null,
    }),
    // features 一并带回：旧记录列表里没有快照时，展开面板至少能显示判定用的标量
    features: rec.features || null,
  };
}

module.exports = { anomalyGpsDetail };
