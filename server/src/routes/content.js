const express = require('express');
const { wrap, ok } = require('../utils/response');
const Announcement = require('../models/announcement');
const Changelog = require('../models/changelog');
const Holiday = require('../models/holiday');

const router = express.Router();

router.get(
  '/announcements',
  wrap(async (req, res) => {
    const now = new Date();
    const list = await Announcement.find({ enabled: true })
      .sort({ priority: -1, createdAt: -1 })
      .limit(20)
      .select('-__v')
      .lean();
    const filtered = list.filter(
      (a) => (!a.startAt || a.startAt <= now) && (!a.endAt || a.endAt >= now)
    );
    ok(res, filtered);
  })
);

router.get(
  '/changelogs',
  wrap(async (req, res) => {
    const list = await Changelog.find().sort({ version: -1 }).limit(50).select('-__v').lean();
    ok(res, list);
  })
);

router.get(
  '/holidays',
  wrap(async (req, res) => {
    const year = Number(req.query.year) || new Date().getFullYear();
    const list = await Holiday.find({ year }).sort({ date: 1 }).select('-__v').lean();
    ok(res, list);
  })
);

module.exports = router;
