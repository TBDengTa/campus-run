const RunRecord = require('../models/run-record');
const wechat = require('./wechat');

// ===== 北斗运动（激励视频）每次观看的四项奖励 =====
// 真源唯一 = goal_config.rewardVideo（管理端 packageAdmin/config/reward-video 保存的同一份）：
//   stepsPerWatch        每次奖励步数（整数 ≥0，老字段，默认 1000）
//   distancePerWatch     每次奖励距离（米，允许一位小数）
//   caloriesPerWatch     每次奖励卡路里（整数 ≥0）
//   durationPerWatch     每次奖励时长（秒，整数 ≥0）
// 后三项为 null / 未配置时，按项目**既有的唯一换算**派生：
//   services/wechat.js::estimateFromSteps —— 微信运动只给步数时用的那套
//   （0.7 米/步、0.04 千卡/步、0.5 秒/步）
// 这样「不配置」= 改造前后的口径完全一致（不会静默改数），显式配置后即以配置为准。
// 禁止在路由或页面里另写一套步数→距离/卡路里/时长公式。
const LIMITS = {
  dailyLimit: 200, // 每日观看上限
  steps: 200000, // 单次步数上限
  distance: 100000, // 单次距离上限（米）
  calories: 50000, // 单次卡路里上限
  durationSeconds: 86400, // 单次时长上限（秒）
};

// 数值夹紧：非法值返回 null（调用方按「未配置」处理），越界一律夹紧，不落非法值
function clampNum(value, max, decimals = 0) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = decimals > 0 ? Math.round(n * 10 ** decimals) / 10 ** decimals : Math.round(n);
  return Math.min(max, Math.max(0, rounded));
}

// 库里的 rewardVideo 配置 → 本次实际入账的四项（含「哪几项是按步数派生的」标记）
function resolvePerWatch(rewardVideo = {}) {
  const steps = clampNum(rewardVideo.stepsPerWatch, LIMITS.steps, 0) || 0;
  const est = wechat.estimateFromSteps(steps);
  const explicitDistance = clampNum(rewardVideo.distancePerWatch, LIMITS.distance, 1);
  const explicitCalories = clampNum(rewardVideo.caloriesPerWatch, LIMITS.calories, 0);
  const explicitDuration = clampNum(rewardVideo.durationPerWatch, LIMITS.durationSeconds, 0);
  return {
    steps,
    distance: explicitDistance === null ? est.distance : explicitDistance,
    calories: explicitCalories === null ? est.calories : explicitCalories,
    durationSeconds: explicitDuration === null ? est.durationSeconds : explicitDuration,
    // true = 该项未单独配置，正在按步数换算（管理端会据此给提示）
    derived: {
      distance: explicitDistance === null,
      calories: explicitCalories === null,
      durationSeconds: explicitDuration === null,
    },
  };
}

// 管理端保存：只处理显式回传的字段（未回传的键不动），越界夹紧
function normalizePerWatchInput(input = {}) {
  const out = {};
  if (input.dailyLimit !== undefined && input.dailyLimit !== null && input.dailyLimit !== '') {
    const v = clampNum(input.dailyLimit, LIMITS.dailyLimit, 0);
    if (v !== null) out.dailyLimit = v;
  }
  const fields = [
    ['stepsPerWatch', LIMITS.steps, 0],
    ['distancePerWatch', LIMITS.distance, 1],
    ['caloriesPerWatch', LIMITS.calories, 0],
    ['durationPerWatch', LIMITS.durationSeconds, 0],
  ];
  for (const [key, max, decimals] of fields) {
    if (input[key] === undefined) continue; // 未回传 = 不动
    // 显式清空（null / 空串）→ 回到「按步数换算」
    if (input[key] === null || input[key] === '') {
      out[key] = null;
      continue;
    }
    const v = clampNum(input[key], max, decimals);
    if (v !== null) out[key] = v;
  }
  return out;
}

// 当日「北斗」已入账的四项（真源 = run_records.source='beidou' 当日那一条累加记录）
async function earnedToday(openid, date) {
  const rows = await RunRecord.aggregate([
    { $match: { openid, date, source: 'beidou' } },
    {
      $group: {
        _id: null,
        steps: { $sum: '$steps' },
        distance: { $sum: '$distance' },
        calories: { $sum: '$calories' },
        durationSeconds: { $sum: '$durationSeconds' },
      },
    },
  ]);
  const t = rows[0] || {};
  return {
    steps: t.steps || 0,
    distance: t.distance || 0,
    calories: t.calories || 0,
    durationSeconds: t.durationSeconds || 0,
  };
}

module.exports = { LIMITS, clampNum, resolvePerWatch, normalizePerWatchInput, earnedToday };
