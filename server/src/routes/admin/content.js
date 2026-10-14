const express = require('express');
const { wrap, ok, ApiError } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
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
  ['badges', Badge],
];

// ===== 组织架构（三级树：学校→院系→专业）=====
// 类型与父级由服务端推导，前端只提交 name/sort/parentId，杜绝「挂在院系下的学校」类脏数据
const ORG_ROOT_TYPE = 'school';
const ORG_CHILD_TYPE = { school: 'department', department: 'specialty' };

router.get(
  '/organizations',
  wrap(async (req, res) => {
    ok(res, await Organization.find().sort({ type: 1, sort: 1, createdAt: 1 }).lean());
  })
);

router.post(
  '/organizations',
  requirePermission('content.manage'),
  wrap(async (req, res) => {
    const { name, parentId, sort } = req.body || {};
    const trimName = typeof name === 'string' ? name.trim() : '';
    if (!trimName) throw new ApiError(400, 400, '名称必填');
    let type = ORG_ROOT_TYPE;
    let parent = null;
    if (parentId) {
      parent = await Organization.findById(parentId);
      if (!parent) throw new ApiError(404, 404, '上级节点不存在');
      type = ORG_CHILD_TYPE[parent.type];
      if (!type) throw new ApiError(400, 400, '专业下不允许再添加子级');
    }
    const doc = await Organization.create({
      name: trimName,
      type,
      parentId: parent ? parent._id : null,
      parentName: parent ? parent.name : '',
      sort: Number(sort) || 0,
    });
    ok(res, doc);
  })
);

router.put(
  '/organizations/:id',
  requirePermission('content.manage'),
  wrap(async (req, res) => {
    const doc = await Organization.findById(req.params.id);
    if (!doc) throw new ApiError(404, 404, '节点不存在');
    const { name, sort } = req.body || {};
    if (typeof name === 'string' && name.trim()) {
      doc.name = name.trim();
      // 同步直接子节点的冗余父名字段
      await Organization.updateMany({ parentId: doc._id }, { $set: { parentName: doc.name } });
    }
    if (sort != null) doc.sort = Number(sort) || 0;
    await doc.save();
    ok(res, doc);
  })
);

router.delete(
  '/organizations/:id',
  requirePermission('content.manage'),
  wrap(async (req, res) => {
    const doc = await Organization.findById(req.params.id);
    if (!doc) throw new ApiError(404, 404, '节点不存在');
    // 递归收集全部子孙节点一次删除（只删一层会让孙级变成孤儿数据）
    const ids = [doc._id];
    let frontier = [doc._id];
    while (frontier.length) {
      const children = await Organization.find({ parentId: { $in: frontier } }).select('_id').lean();
      frontier = children.map((c) => c._id);
      ids.push(...frontier);
    }
    await Organization.deleteMany({ _id: { $in: ids } });
    ok(res, { deleted: ids.length });
  })
);

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
    requirePermission('content.manage'),
    wrap(async (req, res) => {
      ok(res, await Model.create(req.body));
    })
  );

  router.put(
    `/${name}/:id`,
    requirePermission('content.manage'),
    wrap(async (req, res) => {
      const doc = await Model.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true, runValidators: true });
      if (!doc) throw new ApiError(404, 404, '不存在');
      ok(res, doc);
    })
  );

  router.delete(
    `/${name}/:id`,
    requirePermission('content.manage'),
    wrap(async (req, res) => {
      const doc = await Model.findByIdAndDelete(req.params.id);
      if (!doc) throw new ApiError(404, 404, '不存在');
      ok(res, { success: true });
    })
  );
}

module.exports = router;
