/**
 * 反作弊配置的写入口径 —— **唯一实现**。
 *
 * 为什么单独成一份：管理端 `PUT /api/admin/config`（小程序里改）与 Web 控制台
 * `PUT /console/model-config`（浏览器里改）写的是**同一个对象** goal_config.anticheat。
 * 两处各写一套钳位规则，就会漂移出「页面预览 0.78、实际生效 0.70」这种最难查的问题 ——
 * 管理员按预览值理解系统行为，行为却是另一套。
 *
 * 守住三条口径（缺一不可）：
 *  ① 档位名只能 loose/balanced/strict/custom，非法值回落 balanced（不把配置写坏）；
 *  ② 自定义阈值钳位与服务端 currentThreshold 同区间（0.3~0.95 / 0.4~0.99）；
 *  ③ **自动封禁线 ≥ 待研判线 + 0.02** —— 否则一到「可疑」就直接封，
 *     等于取消人工研判这一档，误封率会立刻不可控。
 *  改完必须调用方 clearThresholdCache()（30s 进程内缓存，不清就是「改了没生效」）。
 */
const STRICTNESS_KEYS = ['loose', 'balanced', 'strict', 'custom'];

/**
 * 把外部输入合并进 doc.anticheat（原地改 doc，返回 changed 便于审计与响应）。
 * @param {object} doc GoalConfig 单例（mutable）
 * @param {object} input 前端回传的 anticheat 片段
 * @returns {{changed: object, doc: object}}
 */
function applyAnticheatInput(doc, input = {}) {
  const ac = doc.anticheat || (doc.anticheat = {});
  const changed = {};

  // enabled 是「自动封禁总开关」：**显式传了才动**。
  // 旧实现无条件写 `= anticheat.enabled !== false`，于是只改阈值（不带 enabled）
  // 会把开关从 false 悄悄打到 true —— 管理员本想调档位，结果启用了自动封禁。
  // 小程序表单总带 enabled，所以管理端行为不变；Web 控制台允许只传档位，必须条件写。
  if (input.enabled !== undefined) {
    ac.enabled = input.enabled !== false;
    changed.enabled = ac.enabled;
  }
  if (input.maxStepJumpPerSync != null) {
    ac.maxStepJumpPerSync = Number(input.maxStepJumpPerSync);
    changed.maxStepJumpPerSync = ac.maxStepJumpPerSync;
  }
  if (input.minPaceSecondsPerKm != null) {
    ac.minPaceSecondsPerKm = Number(input.minPaceSecondsPerKm);
    changed.minPaceSecondsPerKm = ac.minPaceSecondsPerKm;
  }
  if (input.banDays != null) {
    ac.banDays = Number(input.banDays);
    changed.banDays = ac.banDays;
  }

  // ===== AI 严谨度（用户 2026-10-28「可以调整 AI 封禁的严谨程度」）=====
  if (input.aiStrictness != null) {
    const mode = String(input.aiStrictness);
    ac.aiStrictness = STRICTNESS_KEYS.includes(mode) ? mode : 'balanced';
    changed.aiStrictness = ac.aiStrictness;
  }
  if (input.aiSuspiciousThreshold != null) {
    const v = Number(input.aiSuspiciousThreshold);
    if (Number.isFinite(v)) {
      ac.aiSuspiciousThreshold = Math.min(0.95, Math.max(0.3, v));
      changed.aiSuspiciousThreshold = ac.aiSuspiciousThreshold;
    }
  }
  if (input.aiAutoBanThreshold != null) {
    const v = Number(input.aiAutoBanThreshold);
    if (Number.isFinite(v)) {
      ac.aiAutoBanThreshold = Math.min(0.99, Math.max(0.4, v));
      changed.aiAutoBanThreshold = ac.aiAutoBanThreshold;
    }
  }
  // ③ 两条线的间隔约束：在**合并完**之后统一算（前端可能只传其中一个）
  const fixed = Math.max(
    Number(ac.aiAutoBanThreshold || 0.78),
    Number(ac.aiSuspiciousThreshold || 0.62) + 0.02
  );
  if (Math.abs(fixed - Number(ac.aiAutoBanThreshold || 0)) > 1e-9 || ac.aiAutoBanThreshold == null) {
    ac.aiAutoBanThreshold = fixed;
    changed.aiAutoBanThreshold = fixed;
  }

  return { changed, anticheat: ac };
}

module.exports = { applyAnticheatInput, STRICTNESS_KEYS };
