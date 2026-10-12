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

// ===== 记录页：运动记录 / 每日记录 / 每周记录 =====

// 运动记录：扁平分页列表（按日期倒序）
router.get(
  '/list',
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const cond = { openid: req.user.openid };
    const [list, total] = await Promise.all([
      RunRecord.find(cond)
        .sort({ date: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('-routePoints -__v')
        .lean(),
      RunRecord.countDocuments(cond),
    ]);
    ok(res, { list, total, page, limit });
  })
);

// 每日记录：按天聚合分页
router.get(
  '/days',
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 14));
    const openid = req.user.openid;
    const [agg, countAgg] = await Promise.all([
      RunRecord.aggregate([
        { $match: { openid } },
        {
          $group: {
            _id: '$date',
            steps: { $sum: '$steps' },
            distance: { $sum: '$distance' },
            calories: { $sum: '$calories' },
            durationSeconds: { $sum: '$durationSeconds' },
            recordCount: { $sum: 1 },
            werunAchieved: { $max: { $cond: [{ $eq: ['$goalAchieved', true] }, 1, 0] } },
          },
        },
        { $sort: { _id: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
      ]),
      RunRecord.aggregate([{ $match: { openid } }, { $group: { _id: '$date' } }, { $count: 'n' }]),
    ]);
    const goal = await goalsSvc.getEffectiveGoal(openid);
    const list = agg.map((d) => ({
      date: d._id,
      steps: d.steps,
      distance: d.distance,
      calories: d.calories,
      durationSeconds: d.durationSeconds,
      recordCount: d.recordCount,
      goalAchieved: d.werunAchieved === 1 || d.steps >= (goal.daily.steps || Infinity),
      goalSteps: goal.daily.steps,
    }));
    ok(res, { list, total: countAgg[0]?.n || 0, page, limit });
  })
);

// 周起始（周一）日期键
function mondayKey(dateKeyStr) {
  const d = new Date(`${dateKeyStr}T00:00:00`);
  const day = d.getDay(); // 0=周日
  const diff = day === 0 ? 6 : day - 1;
  const { toDateKey } = require('../utils/dates');
  d.setDate(d.getDate() - diff);
  return toDateKey(d);
}

// 单日详情：当日汇总 + 记录明细 + 生效目标 + 节假日
router.get(
  '/day/:date',
  wrap(async (req, res) => {
    const date = req.params.date;
    if (!isValidDateKey(date)) throw new ApiError(400, 400, '日期格式应为 YYYY-MM-DD');
    const openid = req.user.openid;
    const [records, goal, holiday] = await Promise.all([
      RunRecord.find({ openid, date }).select('-routePoints -__v').sort({ source: 1, createdAt: 1 }).lean(),
      goalsSvc.getEffectiveGoal(openid),
      Holiday.findOne({ date }).lean(),
    ]);
    const totals = records.reduce(
      (acc, r) => {
        acc.steps += r.steps || 0;
        acc.distance += r.distance || 0;
        acc.calories += r.calories || 0;
        acc.durationSeconds += r.durationSeconds || 0;
        return acc;
      },
      { steps: 0, distance: 0, calories: 0, durationSeconds: 0 }
    );
    const werun = records.find((r) => r.source === 'werun');
    ok(res, {
      date,
      records,
      totals,
      goal,
      goalAchieved: (werun && werun.goalAchieved) || totals.steps >= (goal.daily.steps || Infinity),
      holiday: holiday || null,
    });
  })
);

// 每周记录：近 N 周聚合（周一为一周开始）
router.get(
  '/weeks',
  wrap(async (req, res) => {
    const limit = Math.min(12, Math.max(1, parseInt(req.query.limit, 10) || 6));
    const openid = req.user.openid;
    const { addDays } = require('../utils/dates');
    const thisMonday = mondayKey(todayKey());
    const start = addDays(thisMonday, -(limit - 1) * 7);
    const [records, goal] = await Promise.all([
      RunRecord.find({ openid, date: { $gte: start, $lte: todayKey() } })
        .select('date steps distance calories durationSeconds source goalAchieved')
        .lean(),
      goalsSvc.getEffectiveGoal(openid),
    ]);

    const weekMap = new Map();
    for (let i = 0; i < limit; i++) {
      const ws = addDays(thisMonday, -i * 7);
      weekMap.set(ws, {
        weekStart: ws,
        weekEnd: addDays(ws, 6),
        steps: 0,
        distance: 0,
        calories: 0,
        durationSeconds: 0,
        activeDays: 0,
        recordCount: 0,
        days: new Map(),
      });
    }
    for (const r of records) {
      const w = weekMap.get(mondayKey(r.date));
      if (!w) continue;
      w.steps += r.steps || 0;
      w.distance += r.distance || 0;
      w.calories += r.calories || 0;
      w.durationSeconds += r.durationSeconds || 0;
      w.recordCount += 1;
      if (!w.days.has(r.date)) {
        w.days.set(r.date, true);
        w.activeDays += 1;
      }
    }
    const list = [...weekMap.values()].map((w) => ({
      weekStart: w.weekStart,
      weekEnd: w.weekEnd,
      steps: w.steps,
      distance: w.distance,
      calories: w.calories,
      durationSeconds: w.durationSeconds,
      activeDays: w.activeDays,
      recordCount: w.recordCount,
      weeklyGoalSteps: goal.weekly.steps,
      goalAchieved: w.steps >= (goal.weekly.steps || Infinity),
    }));
    ok(res, { list, weeklyGoal: goal.weekly });
  })
);

// 单周详情：某周汇总 + 7 天逐日明细 + 记录明细
router.get(
  '/week-detail/:start',
  wrap(async (req, res) => {
    const start = req.params.start;
    if (!isValidDateKey(start)) throw new ApiError(400, 400, '日期格式应为 YYYY-MM-DD');
    const openid = req.user.openid;
    const { addDays } = require('../utils/dates');
    const end = addDays(start, 6);
    const [records, goal] = await Promise.all([
      RunRecord.find({ openid, date: { $gte: start, $lte: end } })
        .select('date steps distance calories durationSeconds source goalAchieved')
        .lean(),
      goalsSvc.getEffectiveGoal(openid),
    ]);

    const dayMap = new Map();
    for (let i = 0; i < 7; i++) {
      const key = addDays(start, i);
      dayMap.set(key, { date: key, steps: 0, distance: 0, calories: 0, durationSeconds: 0, recordCount: 0, werunAchieved: false });
    }
    const totals = { steps: 0, distance: 0, calories: 0, durationSeconds: 0 };
    for (const r of records) {
      const d = dayMap.get(r.date);
      if (!d) continue;
      d.steps += r.steps || 0;
      d.distance += r.distance || 0;
      d.calories += r.calories || 0;
      d.durationSeconds += r.durationSeconds || 0;
      d.recordCount += 1;
      if (r.source === 'werun') d.werunAchieved = !!r.goalAchieved;
      totals.steps += r.steps || 0;
      totals.distance += r.distance || 0;
      totals.calories += r.calories || 0;
      totals.durationSeconds += r.durationSeconds || 0;
    }
    const days = [...dayMap.values()].map((d) => ({
      ...d,
      goalAchieved: d.werunAchieved || d.steps >= (goal.daily.steps || Infinity),
    }));
    ok(res, {
      weekStart: start,
      weekEnd: end,
      totals,
      days,
      records,
      goal,
      goalAchieved: totals.steps >= (goal.weekly.steps || Infinity),
      activeDays: days.filter((d) => d.recordCount > 0).length,
    });
  })
);

module.exports = router;
