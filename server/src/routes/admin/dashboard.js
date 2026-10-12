const express = require('express');
const { wrap, ok } = require('../../utils/response');
const User = require('../../models/user');
const RunRecord = require('../../models/run-record');
const AdStat = require('../../models/ad-stat');
const Appeal = require('../../models/appeal');
const { todayKey, addDays } = require('../../utils/dates');

const router = express.Router();

// 总览
router.get(
  '/overview',
  wrap(async (req, res) => {
    const today = todayKey();
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const [totalUsers, newUsersToday, activeToday, stepsToday, adPvToday, adClickToday, pendingAppeals, bannedUsers] =
      await Promise.all([
        User.countDocuments(),
        User.countDocuments({ createdAt: { $gte: dayStart } }),
        RunRecord.distinct('openid', { date: today }),
        RunRecord.aggregate([{ $match: { date: today } }, { $group: { _id: null, sum: { $sum: '$steps' } } }]),
        AdStat.countDocuments({ date: today, type: 'pv' }),
        AdStat.countDocuments({ date: today, type: 'click' }),
        Appeal.countDocuments({ status: 'pending' }),
        User.countDocuments({ status: 'banned' }),
      ]);
    ok(res, {
      totalUsers,
      newUsersToday,
      activeToday: activeToday.length,
      stepsToday: stepsToday[0]?.sum || 0,
      adPvToday,
      adClickToday,
      pendingAppeals,
      bannedUsers,
    });
  })
);

// 近 N 天趋势
router.get(
  '/trend',
  wrap(async (req, res) => {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    const today = todayKey();
    const start = addDays(today, -(days - 1));

    const [runAgg, adAgg, userAgg] = await Promise.all([
      RunRecord.aggregate([
        { $match: { date: { $gte: start, $lte: today } } },
        {
          $group: {
            _id: '$date',
            activeUsers: { $addToSet: '$openid' },
            steps: { $sum: '$steps' },
            distance: { $sum: '$distance' },
          },
        },
        { $project: { date: '$_id', activeUsers: { $size: '$activeUsers' }, steps: 1, distance: 1 } },
      ]),
      AdStat.aggregate([
        { $match: { date: { $gte: start, $lte: today } } },
        {
          $group: {
            _id: { date: '$date', type: '$type' },
            count: { $sum: 1 },
          },
        },
        {
          $group: {
            _id: '$_id.date',
            pv: { $sum: { $cond: [{ $eq: ['$_id.type', 'pv'] }, '$count', 0] } },
            click: { $sum: { $cond: [{ $eq: ['$_id.type', 'click'] }, '$count', 0] } },
          },
        },
        { $project: { date: '$_id', pv: 1, click: 1 } },
      ]),
      User.aggregate([
        { $match: { createdAt: { $gte: new Date(`${start}T00:00:00`) } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
          },
        },
        { $project: { date: '$_id', count: 1 } },
      ]),
    ]);

    const map = new Map();
    for (let i = 0; i < days; i++) {
      const d = addDays(today, -i);
      map.set(d, { date: d, activeUsers: 0, steps: 0, distance: 0, adPv: 0, adClick: 0, newUsers: 0 });
    }
    for (const r of runAgg) {
      const row = map.get(r.date);
      if (row) Object.assign(row, { activeUsers: r.activeUsers, steps: r.steps, distance: r.distance });
    }
    for (const r of adAgg) {
      const row = map.get(r.date);
      if (row) Object.assign(row, { adPv: r.pv, adClick: r.click });
    }
    for (const r of userAgg) {
      const row = map.get(r.date);
      if (row) row.newUsers = r.count;
    }
    ok(res, Array.from(map.values()).sort((a, b) => (a.date < b.date ? -1 : 1)));
  })
);

module.exports = router;
