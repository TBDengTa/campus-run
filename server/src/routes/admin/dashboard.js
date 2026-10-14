const express = require('express');
const { wrap, ok } = require('../../utils/response');
const User = require('../../models/user');
const RunRecord = require('../../models/run-record');
const AdStat = require('../../models/ad-stat');
const Appeal = require('../../models/appeal');
const { todayKey, weekRange } = require('../../utils/dates');

const router = express.Router();

// 总览：广告类字段是独立权限（ad.view），无权限时不下发
router.get(
  '/overview',
  wrap(async (req, res) => {
    const today = todayKey();
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const canViewAds = req.userPermissions.includes('*') || req.userPermissions.includes('ad.view');
    const [totalUsers, newUsersToday, activeToday, stepsToday, recordsToday, adPvToday, adClickToday, pendingAppeals, bannedUsers] =
      await Promise.all([
        User.countDocuments(),
        User.countDocuments({ createdAt: { $gte: dayStart } }),
        RunRecord.distinct('openid', { date: today }),
        RunRecord.aggregate([{ $match: { date: today } }, { $group: { _id: null, sum: { $sum: '$steps' } } }]),
        RunRecord.countDocuments({ date: today }),
        AdStat.countDocuments({ date: today, type: 'pv' }),
        AdStat.countDocuments({ date: today, type: 'click' }),
        Appeal.countDocuments({ status: 'pending' }),
        User.countDocuments({ status: 'banned' }),
      ]);
    const data = {
      totalUsers,
      newUsersToday,
      activeToday: activeToday.length,
      stepsToday: stepsToday[0]?.sum || 0,
      recordsToday,
      pendingAppeals,
      bannedUsers,
    };
    if (canViewAds) {
      data.adPvToday = adPvToday;
      data.adClickToday = adClickToday;
    }
    ok(res, data);
  })
);

// 平均步数前三（本周，周一起）：个人 = 本周总步数 ÷ 有记录天数；班级 = 各班成员日均之和 ÷ 班级学生数
// 教师不参与排名（与排行榜一致）；除法结果在 Node 侧取整，避免依赖 $round（老版本 MongoDB 没有）
router.get(
  '/top3',
  wrap(async (req, res) => {
    const today = todayKey();
    const { startKey } = weekRange(today);
    const inWeek = { $gte: startKey, $lte: today };
    const notTeacher = { $ne: ['$u.role', 'teacher'] };

    const [individuals, classes] = await Promise.all([
      RunRecord.aggregate([
        { $match: { date: inWeek, steps: { $gt: 0 } } },
        { $group: { _id: '$openid', steps: { $sum: '$steps' }, days: { $sum: 1 } } },
        { $addFields: { avgSteps: { $divide: ['$steps', '$days'] } } },
        { $sort: { avgSteps: -1, steps: -1, _id: 1 } },
        { $limit: 50 },
        { $lookup: { from: 'users', localField: '_id', foreignField: 'openid', as: 'u' } },
        { $addFields: { u: { $arrayElemAt: ['$u', 0] } } },
        { $match: { u: { $ne: null }, $expr: notTeacher } },
        { $limit: 3 },
        {
          $project: {
            _id: 0,
            name: { $ifNull: ['$u.realName', { $ifNull: ['$u.nickname', '未命名'] }] },
            className: { $ifNull: ['$u.className', ''] },
            avgSteps: 1,
            days: 1,
            steps: 1,
          },
        },
      ]),
      RunRecord.aggregate([
        { $match: { date: inWeek, steps: { $gt: 0 } } },
        { $group: { _id: '$openid', steps: { $sum: '$steps' }, days: { $sum: 1 } } },
        { $addFields: { avgSteps: { $divide: ['$steps', '$days'] } } },
        { $lookup: { from: 'users', localField: '_id', foreignField: 'openid', as: 'u' } },
        { $addFields: { u: { $arrayElemAt: ['$u', 0] } } },
        { $match: { u: { $ne: null }, 'u.className': { $nin: [null, ''] }, $expr: notTeacher } },
        // 班级维度：成员日均之和 ÷ 该班学生总数（不含教师）
        {
          $group: {
            _id: '$u.className',
            activeMembers: { $sum: 1 },
            avgSum: { $sum: '$avgSteps' },
          },
        },
        {
          $lookup: {
            from: 'users',
            let: { cn: '$_id' },
            pipeline: [
              { $match: { $expr: { $and: [{ $eq: ['$className', '$$cn'] }, { $ne: ['$role', 'teacher'] }] } } },
              { $count: 'n' },
            ],
            as: 'sz',
          },
        },
        { $addFields: { total: { $ifNull: [{ $arrayElemAt: ['$sz.n', 0] }, 0] } } },
        { $addFields: { denom: { $cond: [{ $gt: ['$total', 0] }, '$total', '$activeMembers'] } } },
        { $addFields: { avgSteps: { $divide: ['$avgSum', '$denom'] } } },
        { $sort: { avgSteps: -1, activeMembers: -1, _id: 1 } },
        { $limit: 3 },
        { $project: { _id: 0, className: '$_id', members: '$denom', avgSteps: 1 } },
      ]),
    ]);

    const round = (rows) => rows.map((r) => ({ ...r, avgSteps: Math.round(r.avgSteps || 0) }));
    ok(res, { rangeText: `${startKey} ~ ${today}`, individuals: round(individuals), classes: round(classes) });
  })
);

module.exports = router;
