const express = require('express');
const { wrap, ok, ApiError } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const GoalConfig = require('../../models/goal-config');
const pointsSvc = require('../../services/points');
const rewardVideoSvc = require('../../services/reward-video');
const acSvc = require('../../services/anticheat-config');

const router = express.Router();

/**
 * 楼名清单规范化（用户 2026-10-21）：
 * 去掉首尾空白、丢掉空项、按原顺序去重、单个楼名截断到 20 字、每类最多 60 个。
 * 为什么要在这里统一清洗：楼名会与门牌号拼成「楼名·门牌号」落库，
 * 带空格或重复项会直接污染存量数据（「1号教学楼」与「1号教学楼 」变成两个楼）。
 */
function normalizeBuildings(input) {
  const clean = (arr) => {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(arr) ? arr : []) {
      const name = String(raw == null ? '' : raw).trim().slice(0, 20);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= 60) break;
    }
    return out;
  };
  return { teaching: clean(input && input.teaching), dorm: clean(input && input.dorm) };
}

router.get(
  '/',
  // 整份配置（含反作弊阈值 / 跑分参数 / 北斗奖励）——必须 config.view。
  // 楼名清单另走 GET /buildings（building.view），不复用本接口：
  // 前缀上不再统一挂权限，所以这里必须显式声明，否则会变成「无权限也能读全局配置」。
  requirePermission('config.view'),
  wrap(async (req, res) => {
    const doc = await GoalConfig.getSingleton();
    const out = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    // 跑分：老配置文档缺少 extraPercent（日）/ weeklyExtraPercent（周）时，这里显式告诉管理端
    // 「旧口径等价于多少百分比」，避免档位从固定步数改成百分比后出现静默变更
    // （读取即派生，不写库；管理员在「跑分设置」保存时才落库，幂等）
    // perStep 现已**完全弃用**（日、周公式都不再读取），提示里给出日/周两个等价百分比仅供参考
    const raw = await GoalConfig.collection.findOne(
      { key: 'default' },
      {
        projection: {
          'points.perStep': 1,
          'points.extraPercent': 1,
          'points.weeklyExtraPercent': 1,
          'daily.steps': 1,
          'weekly.steps': 1,
        },
      }
    );
    const rawPoints = (raw && raw.points) || {};
    const globalDailySteps = Number(raw && raw.daily && raw.daily.steps) || 0;
    const globalWeeklySteps = Number(raw && raw.weekly && raw.weekly.steps) || 0;
    const extraPercentMissing = rawPoints.extraPercent == null;
    const weeklyExtraPercentMissing = rawPoints.weeklyExtraPercent == null;
    out.pointsLegacy =
      extraPercentMissing || weeklyExtraPercentMissing
        ? {
            extraPercentMissing,
            weeklyExtraPercentMissing,
            perStep: rawPoints.perStep != null ? rawPoints.perStep : null,
            globalDailySteps: globalDailySteps || null,
            globalWeeklySteps: globalWeeklySteps || null,
            // 与旧口径等价的百分比：日 = perStep ÷ 全局日目标，周 = perStep ÷ 全局周目标
            legacyPercent: pointsSvc.equivalentPercent(rawPoints.perStep, globalDailySteps),
            legacyWeeklyPercent: pointsSvc.equivalentPercent(rawPoints.perStep, globalWeeklySteps),
            extraPercent: pointsSvc.normalizeConfig(out.points).extraPercent,
            weeklyExtraPercent: pointsSvc.normalizeConfig(out.points).weeklyExtraPercent,
          }
        : null;
    // 北斗运动四项奖励的**生效值**：距离/卡路里/时长未单独配置（null）时按步数换算派生，
    // derived 标记告诉管理端哪几项正在走派生（页面会在输入框下给出提示，避免误解为已配置）
    out.rewardVideoEffective = rewardVideoSvc.resolvePerWatch(out.rewardVideo);
    ok(res, out);
  })
);

router.put(
  '/',
  // 楼名管理页只回传 buildings，宿管/学生处持 building.manage 就该能保存；
  // 其余字段（反作弊/跑分/北斗）仍要 config.manage，见下方的分字段守卫。
  requirePermission('config.manage', 'building.manage'),
  wrap(async (req, res) => {
    const doc = await GoalConfig.getSingleton();
    // 默认目标（daily/weekly）已移交 /api/admin/assessment/defaults
    const { anticheat, rewardVideo, points, buildings } = req.body || {};
    // 分字段守卫：只有 building.manage 的账号（如宿管老师）**只能**改楼名，
    // 不能顺手带上 points/anticheat 把计分口径也改掉。
    const perms = req.userPermissions || [];
    const canConfig = perms.includes('*') || perms.includes('config.manage');
    const wantsOthers = !!(anticheat || rewardVideo || points);
    if (wantsOthers && !canConfig) {
      throw new ApiError(403, 403002, '无权限修改计分/反作弊/北斗配置（需要 config.manage）');
    }
    if (anticheat) {
      // ===== AI 严谨度与阈值（用户 2026-10-28「可以调整 AI 封禁的严谨程度」）=====
      // 口径唯一实现：services/anticheat-config.js::applyAnticheatInput
      // （Web 控制台 PUT /console/model-config 走同一份 —— 两处各写一套钳位，
      //   就会漂移出「页面预览 0.78、实际生效 0.70」，管理员按预览理解系统行为）。
      // 包含：档位名白名单（非法回落 balanced）、自定义阈值 0.3~0.95 / 0.4~0.99 夹紧、
      // 以及「自动封禁线 ≥ 待研判线 + 0.02」（否则一到可疑就封，等于取消人工研判档）。
      acSvc.applyAnticheatInput(doc, anticheat);
    }
    if (rewardVideo) {
      doc.rewardVideo.enabled = rewardVideo.enabled !== false;
      // 四项奖励（步数/距离米/卡路里/时长秒）：只处理显式回传的键，越界一律夹紧，
      // 显式 null/空串 = 回到「按步数换算」（services/reward-video.js）
      const per = rewardVideoSvc.normalizePerWatchInput(rewardVideo);
      for (const key of Object.keys(per)) doc.rewardVideo[key] = per[key];
      // 广告位 ID（客户端公开标识，可留空 = 用用户端代码里的默认广告位）
      if (rewardVideo.adUnitId !== undefined) {
        doc.rewardVideo.adUnitId = String(rewardVideo.adUnitId || '').trim().slice(0, 64);
      }
    }
    // 跑分设置（config/points 子页只回传本组，未提供的键不动）
    if (points) {
      doc.points.enabled = points.enabled !== false;
      const num = (v, min, max) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        return Math.min(max, Math.max(min, Math.round(n)));
      };
      const dailyGoal = points.dailyGoal != null ? num(points.dailyGoal, 0, 1000) : null;
      const weeklyGoal = points.weeklyGoal != null ? num(points.weeklyGoal, 0, 5000) : null;
      // 日超出档位：个人日目标的百分比，整数 1~100（越界一律夹紧，不写非法值）
      const extraPercent = points.extraPercent != null ? num(points.extraPercent, pointsSvc.EXTRA_PERCENT_MIN, pointsSvc.EXTRA_PERCENT_MAX) : null;
      // 周超出档位：个人周目标的百分比，整数 1~100（同一套区间常量）
      const weeklyExtraPercent =
        points.weeklyExtraPercent != null
          ? num(points.weeklyExtraPercent, pointsSvc.EXTRA_PERCENT_MIN, pointsSvc.EXTRA_PERCENT_MAX)
          : null;
      // 【已完全弃用】perStep：日、周公式都不再读取；仍接受回传只为兼容老客户端表单（值原样保存，不影响分数）
      const perStep = points.perStep != null ? num(points.perStep, 1, 1000000) : null;
      const perStepScore = points.perStepScore != null ? num(points.perStepScore, 0, 1000) : null;
      const dailyExtraCap = points.dailyExtraCap != null ? num(points.dailyExtraCap, 0, 1000) : null;
      // 单周超出加分上限：0 = 不封顶（与单日上限的 0 = 超出不加分**语义不同**，管理端已标注）
      const weeklyExtraCap = points.weeklyExtraCap != null ? num(points.weeklyExtraCap, 0, 1000) : null;
      if (dailyGoal != null) doc.points.dailyGoal = dailyGoal;
      if (weeklyGoal != null) doc.points.weeklyGoal = weeklyGoal;
      if (extraPercent != null) doc.points.extraPercent = extraPercent;
      if (weeklyExtraPercent != null) doc.points.weeklyExtraPercent = weeklyExtraPercent;
      if (perStep != null) doc.points.perStep = perStep;
      if (perStepScore != null) doc.points.perStepScore = perStepScore;
      if (dailyExtraCap != null) doc.points.dailyExtraCap = dailyExtraCap;
      if (weeklyExtraCap != null) doc.points.weeklyExtraCap = weeklyExtraCap;
    }
    // 楼名白名单（用户 2026-10-21）：两份清单分别维护，整体覆盖（不按项增删，避免前后端顺序打架）
    if (buildings) {
      const normalized = normalizeBuildings(buildings);
      doc.buildings = { teaching: normalized.teaching, dorm: normalized.dorm };
    }
    await doc.save();
    // AI 严谨度改动要**立即生效**（用户 2026-10-28）：
    // anticheat-model 的阈值有 30s 进程内缓存，不清的话管理员改完还得等半分钟，
    // 容易误以为「改了没生效」。这里直接失效缓存，下次判定就按新档位。
    try {
      require('../../services/anticheat-model').clearThresholdCache();
    } catch (e) {
      /* 缓存清理是可选能力，失败不影响保存 */
    }
    const out = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    out.pointsLegacy = null; // 保存即完成迁移：不再提示旧字段换算
    out.rewardVideoEffective = rewardVideoSvc.resolvePerWatch(out.rewardVideo);
    ok(res, out);
  })
);

/**
 * 楼名清单（只读，给「填教室 / 填宿舍」的选择器用）。
 *
 * 权限用 **building.view**（用户 2026-10-22 要求独立权限项），不再用 config.view：
 * config.view 覆盖反作弊阈值、跑分参数等全局计分口径，
 * 而班委/宿管只需要「选楼名」，不该因此获得看那些配置的权力。
 * 写（PUT /）仍走 config.manage 或 building.manage（见下方守卫）。
 */
router.get(
  '/buildings',
  // 「能管理就必须能查看」：building.manage 也要放行读，否则会出现
  // 「保存成功但列表刷不出来」——宿管改完楼名，页面却 403 空着，比不能改更糟。
  requirePermission('building.view', 'building.manage', 'config.view'),
  wrap(async (req, res) => {
    const doc = await GoalConfig.getSingleton();
    const b = (doc && doc.buildings) || {};
    ok(res, {
      teaching: Array.isArray(b.teaching) ? b.teaching : [],
      dorm: Array.isArray(b.dorm) ? b.dorm : [],
    });
  })
);

module.exports = router;
