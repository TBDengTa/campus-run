/**
 * GPS 实跑派生指标（用户 2026-11-02「GPS 实跑需要看到更多数据如平均速度、峰值速度、距离、路线图等」）。
 *
 * ===== 为什么单独成服务 =====
 * 记录的读路径有**三条**，全部要给同一份指标：
 *   ① /api/run/detail/:id            本人（用户端）
 *   ② /api/admin/users/:id/runs/:runId  管理端看任意用户
 *   ③ /api/class/student/:uid/run/:runId 班级域（班主任/班委）
 * 上一版只挂在 ①，管理员与班主任打开同一条记录就看不到速度指标
 * （用户 2026-11-02 反馈「依旧没有」）。按仓库约定「实现必须共用同一份」，
 * 算法收敛到这里，三条路径各调一次，口径不可能漂移。
 *
 * ===== 指标口径（单位与全库一致：距离米、时长秒、速度 m/s）=====
 *   · avgSpeed        = 总距离 ÷ 总时长；时长 0 → null（不是 0，0 会被读成"停着不动"）
 *   · avgPaceSecPerKm = 1000 ÷ avgSpeed（秒/公里）
 *   · peakSpeed       = 相邻点瞬时速度的最大值，带异常过滤：
 *       - dt <= 0 或 dt > 60s：暂停/断连，分母不可信，跳过
 *       - 单步 > 500m：GPS 漂移，跳过
 *       - 瞬时 > 15 m/s（约 54 km/h，超世界纪录冲刺）：漂移，跳过
 *     不过滤的话一次漂移就能造出 100 m/s 的"峰值"，用户会以为是系统错误。
 *   · segments        按 1 公里分段（负分段分析），最多 60 段防大轨迹撑爆响应
 *   · bounds          经纬度包围盒（前端画路线图先定视窗，不用自己遍历）
 *   · pointCount / hasRoute
 *
 * ⚠️ 轨迹点字段名以 models/run-record.js::routePointSchema 为准：
 *   { latitude, longitude, timestamp }（timestamp 毫秒）。
 *   曾误写 lat/lng/ts → pointCount 恒 0、指标全空，但接口仍返回 200（静默错）。
 *   这里对两种写法都做了兼容（p.latitude ?? p.lat），新数据用 schema 名。
 */

/** 球面距离（米）。 */
function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 归一化轨迹点：schema 字段名优先，兼容旧的 lat/lng/ts 写法。 */
function normalizePoints(routePoints) {
  return (routePoints || [])
    .map((p) => {
      if (!p) return null;
      const lat = Number(p.latitude != null ? p.latitude : p.lat);
      const lng = Number(p.longitude != null ? p.longitude : p.lng);
      const t = Number(p.timestamp != null ? p.timestamp : p.ts);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(t) || t <= 0) return null;
      return { lat, lng, t };
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
}

/**
 * 给一条 GPS 记录补 metrics 字段。非 gps 原样返回。
 * @param {object} record lean() 出来的 RunRecord（含 routePoints）
 */
function withGpsMetrics(record) {
  if (!record || record.source !== 'gps') return record;

  const pts = normalizePoints(record.routePoints);
  const duration = Number(record.durationSeconds) || 0;
  const distance = Number(record.distance) || 0;

  const avgSpeed = duration > 0 ? distance / duration : null;
  const avgPaceSecPerKm = avgSpeed && avgSpeed > 0 ? 1000 / avgSpeed : null;

  let peakSpeed = null;
  for (let i = 1; i < pts.length; i += 1) {
    const dt = (pts[i].t - pts[i - 1].t) / 1000;
    if (dt <= 0 || dt > 60) continue;
    const dm = haversineMeters(pts[i - 1], pts[i]);
    if (dm <= 0 || dm > 500) continue;
    const v = dm / dt;
    if (v > 15) continue;
    if (peakSpeed == null || v > peakSpeed) peakSpeed = v;
  }

  // 1 公里分段
  const segments = [];
  if (pts.length >= 2) {
    let totalM = 0;
    for (let i = 1; i < pts.length; i += 1) totalM += haversineMeters(pts[i - 1], pts[i]);
    const segCount = Math.min(60, Math.max(1, Math.floor(totalM / 1000) + (totalM % 1000 > 200 ? 1 : 0)));
    if (totalM > 0 && segCount > 0) {
      let accM = 0;
      let segStartT = pts[0].t;
      let segStartDist = 0;
      let segIdx = 1;
      for (let i = 1; i < pts.length && segIdx <= segCount; i += 1) {
        accM += haversineMeters(pts[i - 1], pts[i]);
        if (accM - segStartDist >= 1000 || i === pts.length - 1) {
          const dt = (pts[i].t - segStartT) / 1000;
          const dm = accM - segStartDist;
          if (dt > 0 && dm > 0) {
            const v = dm / dt;
            segments.push({
              km: segIdx,
              meters: Math.round(dm),
              seconds: Math.round(dt),
              speed: Number(v.toFixed(2)),
              paceSecPerKm: v > 0 ? Math.round(1000 / v) : null,
            });
          }
          segIdx += 1;
          segStartT = pts[i].t;
          segStartDist = accM;
        }
      }
    }
  }

  let bounds = null;
  if (pts.length >= 2) {
    const lats = pts.map((p) => p.lat);
    const lngs = pts.map((p) => p.lng);
    bounds = {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLng: Math.min(...lngs),
      maxLng: Math.max(...lngs),
    };
  }

  return {
    ...record,
    metrics: {
      avgSpeed: avgSpeed == null ? null : Number(avgSpeed.toFixed(2)),
      avgPaceSecPerKm: avgPaceSecPerKm == null ? null : Math.round(avgPaceSecPerKm),
      peakSpeed: peakSpeed == null ? null : Number(peakSpeed.toFixed(2)),
      pointCount: pts.length,
      hasRoute: pts.length >= 2,
      bounds,
      segments,
    },
  };
}

/**
 * 轨迹抽稀（均匀步长）：控制在 ≤max 点，供 step_anomalies.route 快照与
 * 控制台详情接口下发用（5000 点全量下发会撑爆响应，快照也没必要存全量）。
 * 首末点永远保留（起终点是研判的重要锚点）。
 */
function downsamplePoints(pts, max = 400) {
  if (!Array.isArray(pts) || pts.length <= max) return pts || [];
  const out = [];
  const stride = (pts.length - 1) / (max - 1);
  for (let i = 0; i < max; i += 1) {
    out.push(pts[Math.round(i * stride)]);
  }
  return out;
}

module.exports = { withGpsMetrics, haversineMeters, normalizePoints, downsamplePoints };
