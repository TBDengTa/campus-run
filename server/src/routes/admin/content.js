const express = require('express');
const { wrap, ok, ApiError } = require('../../utils/response');
const Announcement = require('../../models/announcement');
const Changelog = require('../../models/changelog');
const Holiday = require('../../models/holiday');
const Organization = require('../../models/organization');
const Badge = require('../../models/badge');

const router = express.Router();

const CRUD = [
  ['announcements', Announcement],
  ['changelogs', Changelog],
  ['holidays', Holiday],
  ['organizations', Organization],
  ['badges', Badge],
];

for (const [name, Model] of CRUD) {
  router.get(
    `/${name}`,
    wrap(async (req, res) => {
      const sortMap = {
        announcements: { priority: -1, createdAt: -1 },
        changelogs: { version: -1 },
        holidays: { date: 1 },
        organizations: { type: 1, sort: 1 },
        badges: { sort: 1 },
      };
      ok(res, await Model.find().sort(sortMap[name]).lean());
    })
  );

  router.post(
    `/${name}`,
    wrap(async (req, res) => {
      ok(res, await Model.create(req.body));
    })
  );

  router.put(
    `/${name}/:id`,
    wrap(async (req, res) => {
      const doc = await Model.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true, runValidators: true });
      if (!doc) throw new ApiError(404, 404, '不存在');
      ok(res, doc);
    })
  );

  router.delete(
    `/${name}/:id`,
    wrap(async (req, res) => {
      const doc = await Model.findByIdAndDelete(req.params.id);
      if (!doc) throw new ApiError(404, 404, '不存在');
      if (name === 'organizations') {
        await Organization.deleteMany({ parentId: doc._id }); // 级联删除院系
      }
      ok(res, { success: true });
    })
  );
}

module.exports = router;
