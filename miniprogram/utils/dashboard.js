/**
 * 管理 dashboard 数据加载（唯一实现，2026-11-23）
 *
 * 数据概况 + 平均步数排行同时承载在「管理员首页」与「工作台」两处视图，
 * 取数与格式化只允许这一份（历史上首页/中枢各写一套导致口径漂移的教训）。
 * 守卫是服务端 dashboard.view；调用方按权限决定是否发起，失败返回 null 由视图隐藏对应段。
 */
const auth = require('./request');
const fmt = require('./format');

async function fetchOverview() {
  try {
    const overview = await auth.get('/api/admin/dashboard/overview');
    return { ...overview, stepsTodayText: fmt.formatNumber(overview.stepsToday) };
  } catch (e) {
    return null;
  }
}

async function fetchTop3() {
  try {
    const top3 = await auth.get('/api/admin/dashboard/top3');
    const withText = (rows) => (rows || []).map((r) => ({ ...r, avgStepsText: fmt.formatNumber(r.avgSteps) }));
    return {
      rangeText: top3.rangeText,
      individuals: withText(top3.individuals),
      classes: withText(top3.classes),
    };
  } catch (e) {
    return null;
  }
}

// 是否有看板权限：isManager 只表示有任意权限，调 dashboard 接口会 403，必须精确判定
function canViewDashboard(user) {
  const perms = (user && user.effectivePermissions) || [];
  return perms.includes('*') || perms.includes('dashboard.view');
}

module.exports = { fetchOverview, fetchTop3, canViewDashboard };