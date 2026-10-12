const express = require('express');
const { wrap, ok, ApiError } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const RunRecord = require('../models/run-record');
const WxSession = require('../models/wx-session');
const Holiday = require('../models/holiday');
const stepsSvc = require('../services/steps');
const goalsSvc = require('../services/goals');
const wechat = require('../services/wechat');
const { todayKey, monthRange, isValidDateKey, addDays } = require('../utils/dates');

const router = express.Router();
router.use(auth);

// 今日概览：步数记录 + 生效目标 + 进度
router.get(
  '/today',
  wrap(async (req, res) => {
    const date = todayKey();
    const [record, goal] = await Promise.all([
      RunRecord.findOne({ openid: req.user.openid, date, source: 'werun' }).lean(),
      goalsSvc.getEffectiveGoal(req.user.openid),
    ]);
    // 分时段应完成百分比
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    let expectedPercent = 0;
    for (const seg of goal.graded || []) {
      const [h, m] = (seg.time || '00:00').split(':').map(Number);
      if (nowMinutes >= h * 60 + m) expectedPercent = seg.percent;
    }
    const gpsCount = await RunRecord.countDocuments({ openid: req.user.openid, date, source: 'gps' });
    ok(res, {
      date,
      record: record || null,
      goal,
      expectedPercent,
      gpsRunCount: gpsCount,
    });
  })
);

// 月度日历：每日记录 + 节假日
router.get(
  '/calendar',
  wrap(async (req, res) => {
    const monthKey = req.query.month || todayKey().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new ApiError(400, 400, '月份格式应为 YYYY-MM');
    const { startKey, endKey } = monthRange(monthKey);
    const [records, holidays] = await Promise.all([
      RunRecord.find({ openid: req.user.openid, date: { $gte: startKey, $lte: endKey } })
        .select('date steps distance calories durationSeconds source goalAchieved')
        .lean(),
      Holiday.find({ date: { $gte: startKey, $lte: endKey } }).lean(),
    ]);
    ok(res, { month: monthKey, records, holidays });
  })
);

// 周统计（近 7 天）
router.get(
  '/week',
  wrap(async (req, res) => {
    const today = todayKey();
    const start = addDays(today, -6);
    const records = await RunRecord.find({ openid: req.user.openid, date: { $gte: start, $lte: today } })
      .select('date steps distance calories durationSeconds source goalAchieved')
      .lean();
    ok(res, { start, end: today, records });
  })
);

// 同步微信运动：encryptedData/iv 由小程序端 wx.getWeRunData 获取
router.post(
  '/sync-werun',
  wrap(async (req, res) => {
    // 教师账号不参与运动记录
    if (stepsSvc.isTeacher(req.user)) throw new ApiError(403, 403003, stepsSvc.TEACHER_BLOCK_MESSAGE);

    const { encryptedData, iv } = req.body || {};
    if (!encryptedData || !iv) throw new ApiError(400, 400, '缺少 encryptedData/iv');
    const session = await WxSession.findOne({ openid: req.user.openid });
    if (!session) throw new ApiError(400, 400002, '会话不存在，请重新登录');

    const data = wechat.decryptWeRun(session.sessionKey, encryptedData, iv);
    const list = (data.stepInfoList || []).filter((d) => d && typeof d.step === 'number');
    if (!list.length) return ok(res, { synced: 0, newBadges: [] });

    // 最近 30 天逐日 upsert；仅同步最近 7 天防止历史数据被覆盖，当日之外只增不减
    const syncedDates = [];
    let banned = null;
    for (const item of list) {
      const dateKey = tsToDateKey(item.timestamp);
      if (!dateKey) continue;
      const daysAgo = Math.round((Date.now() - item.timestamp * 1000) / 86400000);
      if (daysAgo > 7) continue;
      const prev = await RunRecord.findOne({ openid: req.user.openid, date: dateKey, source: 'werun' }).lean();
      const prevSteps = prev?.steps || 0;
      let steps = item.step;
      // 非当日：只增不减（保留激励视频等奖励步数）
      if (dateKey !== todayKey() && steps < prevSteps) steps = prevSteps;
      const result = await stepsSvc.syncWerunDay(req.user, dateKey, steps, { checkJump: dateKey === todayKey() });
      if (result.blocked) throw new ApiError(403, 403003, result.reason);
      if (result.banned) {
        banned = result.reason;
        break;
      }
      syncedDates.push(dateKey);
    }
    if (banned) {
      throw new ApiError(403, 403001, `检测到数据异常，账号已被封禁：${banned}`, { banned: true });
    }
    const { newBadges } = await stepsSvc.postSyncRefresh(req.user, syncedDates);
    ok(res, { synced: syncedDates.length, newBadges });
  })
);

function tsToDateKey(ts) {
  if (!ts) return null;
  const { toDateKey } = require('../utils/dates');
  try {
    return toDateKey(new Date(ts * 1000));
  } catch (e) {
    return null;
  }
}

// 提交 GPS 实跑
router.post(
  '/gps',
  wrap(async (req, res) => {
    // 教师账号不参与运动记录
    if (stepsSvc.isTeacher(req.user)) throw new ApiError(403, 403003, stepsSvc.TEACHER_BLOCK_MESSAGE);

    const { date, distance, durationSeconds, calories, startTime, endTime, routePoints, location } = req.body || {};
    if (!distance || distance < 10) throw new ApiError(400, 400, '距离过短');
    const result = await stepsSvc.saveGpsRun(req.user, {
      date: isValidDateKey(date) ? date : undefined,
      distance,
      durationSeconds,
      calories,
      startTime,
      endTime,
      routePoints,
      location,
    });
    if (result.blocked) {
      throw new ApiError(403, 403003, result.reason);
    }
    if (result.banned) {
      throw new ApiError(403, 403001, `检测到数据异常，账号已被封禁：${result.reason}`, { banned: true });
    }
    const { newBadges } = await stepsSvc.postSyncRefresh(req.user, [result.record.date]);
    ok(res, { record: result.record, newBadges });
  })
);

// 记录详情（含轨迹）
router.get(
  '/detail/:id',
  wrap(async (req, res) => {
    const record = await RunRecord.findOne({ _id: req.params.id, openid: req.user.openid }).lean();
    if (!record) throw new ApiError(404, 404, '记录不存在');
    ok(res, record);
  })
);

module.exports = router;
