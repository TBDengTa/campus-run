const express = require('express');
const { wrap, ok, ApiError } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const stepsSvc = require('../services/steps');
const beidouSvc = require('../services/beidou');
const rewardVideoSvc = require('../services/reward-video');
const anticheat = require('../services/anticheat');
const { todayKey } = require('../utils/dates');

/**
 * 北斗运动 2.0 用户端接口。
 *
 * 本路由**只做鉴权、取参与错误映射**，所有业务判定与写入都在 services/beidou.js（唯一实现）。
 * 中间件与 /api/reward-video 同一套口径：
 *   · 教师 → 200 + success:false（**不用 403003**：小程序把 403003 当「未登录」会跳登录页）
 *   · 限制登录 → 403001（小程序跳 pages/banned）
 *   · sync/gps 限制 → 403004（提示并可申诉）
 */
const router = express.Router();
router.use(auth);

// 限制类错误统一出口（与 routes/reward-video.js、routes/run.js 同一套映射）
function restrictedError(info) {
  const scope = (info && info.scope) || 'login';
  const reason = (info && info.reason) || (info && info.message) || '数据异常';
  const until = (info && info.until) || null;
  if (scope === 'login') {
    return new ApiError(403, 403001, `检测到数据异常，账号已被限制登录：${reason}`, {
      banned: { reason, until, banType: 'login' },
    });
  }
  const text = scope === 'sync' ? '微信同步' : 'GPS 实跑';
  return new ApiError(403, 403004, `${text}已被限制：${reason}`, {
    restriction: { scope, text, reason, until },
  });
}

// 三条写接口共用的前置闸门：教师 → 直接返回（不抛错），限制 → 抛 403
//
// 为什么教师这里 return 而不是 throw：教师账号本来就该「进不去」这个页面（前端三道拦截），
// 万一通过分享链接/开发者工具进来，给一句可读的提示比一个错误弹窗更好。
function guardWrite(req, res) {
  if (stepsSvc.isTeacher(req.user)) {
    ok(res, { success: false, message: stepsSvc.TEACHER_BLOCK_MESSAGE });
    return false;
  }
  const r = anticheat.activeRestriction(req.user, 'sync');
  if (r) throw restrictedError(r);
  return true;
}

// 活动配置 + 今日状态（页面首屏一次拿全）
router.get(
  '/today',
  wrap(async (req, res) => {
    const cfg = await beidouSvc.loadConfig();
    if (stepsSvc.isTeacher(req.user)) {
      return ok(res, { blocked: true, message: stepsSvc.TEACHER_BLOCK_MESSAGE, enabled: cfg.enabled });
    }
    const state = await beidouSvc.todayState(req.user);
    ok(res, state);
  })
);

// 中奖播报（只读）：最近有人中奖的记录，姓名已脱敏
//
// 为什么不拦教师：教师进不了活动页（前端三道拦截），但接口本身是**公开只读**的，
// 给它 403 只会在日志里制造噪音，没有安全收益。真正的护栏在 winnersFeed 里
// （脱敏 / 排除不参与排名 / 排除封禁与教师 / 单人最多 2 条）。
router.get(
  '/winners',
  wrap(async (req, res) => {
    const data = await beidouSvc.winnersFeed({
      limit: req.query.limit,
      excludeOpenid: req.user && req.user.openid,
    });
    ok(res, data);
  })
);

// 抽奖：{ drawId } → 服务端定结果，前端只播动画
router.post(
  '/draw',
  wrap(async (req, res) => {
    if (!guardWrite(req, res)) return;
    const result = await beidouSvc.drawRound(req.user, { drawId: (req.body || {}).drawId });
    if (!result.success) {
      // 业务性失败（次数不足 / 太频繁）统一 200 + success:false，
      // 让客户端能展示可读提示；只有鉴权与限制才用 4xx
      return ok(res, result);
    }
    // 抽到步数才需要刷新目标达成/徽章；没抽到就别白跑两次聚合
    let newBadges = [];
    if (result.prize && result.prize.type === 'steps') {
      const refreshed = await stepsSvc.postSyncRefresh(req.user, [todayKey()]);
      newBadges = refreshed.newBadges || [];
    }
    const earned = await rewardVideoSvc.earnedToday(req.user.openid, todayKey());
    ok(res, { ...result, earned, newBadges });
  })
);

// 看视频完成上报：{ watchId } → 加抽奖次数（**不再发步数**，这是 2.0 的核心口径变更）
router.post(
  '/video/report',
  wrap(async (req, res) => {
    if (!guardWrite(req, res)) return;
    const result = await beidouSvc.reportVideo(req.user, { watchId: (req.body || {}).watchId });
    ok(res, result);
  })
);

// 分享上报：{ shareId } → 加抽奖次数
router.post(
  '/share/report',
  wrap(async (req, res) => {
    if (!guardWrite(req, res)) return;
    const result = await beidouSvc.reportShare(req.user, { shareId: (req.body || {}).shareId });
    ok(res, result);
  })
);

// 签到：连续 7 天阶梯（第 3/7 天直发步数，受每日封顶约束）
router.post(
  '/checkin',
  wrap(async (req, res) => {
    if (!guardWrite(req, res)) return;
    const result = await beidouSvc.checkin(req.user);
    let newBadges = [];
    if (result.success && result.award && result.award.steps > 0) {
      const refreshed = await stepsSvc.postSyncRefresh(req.user, [todayKey()]);
      newBadges = refreshed.newBadges || [];
    }
    const earned = await rewardVideoSvc.earnedToday(req.user.openid, todayKey());
    ok(res, { ...result, earned, newBadges });
  })
);

module.exports = router;
