const express = require('express');
const { wrap, ok, ApiError } = require('../../utils/response');
const PermissionGroup = require('../../models/permission-group');
const Permission = require('../../models/permission');
const User = require('../../models/user');

const router = express.Router();

// 权限组标识：小写字母开头，允许数字/._-（用于 user.permissionGroups 存储）
const KEY_RE = /^[a-z][a-z0-9_.-]{1,31}$/;

// 校验权限 key 都存在于权限目录（'*' 只允许内置超级管理员组）
async function assertPermsExist(list) {
  const catalog = await Permission.find().distinct('key');
  const invalid = (list || []).filter((k) => catalog.indexOf(k) < 0);
  if (invalid.length) throw new ApiError(400, 400, `权限不存在: ${invalid.join(', ')}`);
}

function normalizePerms(input) {
  if (!Array.isArray(input)) throw new ApiError(400, 400, 'permissions 需为数组');
  const list = [...new Set(input.map(String))];
  if (list.includes('*')) throw new ApiError(400, 400, '自定义权限组不能包含通配 *，请只勾选具体权限');
  return list;
}

// 权限组列表（含使用人数，便于判断能否删除）
router.get(
  '/',
  wrap(async (req, res) => {
    const [groups, counts] = await Promise.all([
      PermissionGroup.find().sort({ builtIn: -1, key: 1 }).lean(),
      User.aggregate([{ $unwind: '$permissionGroups' }, { $group: { _id: '$permissionGroups', n: { $sum: 1 } } }]),
    ]);
    const countMap = new Map(counts.map((c) => [String(c._id), c.n]));
    ok(res, { list: groups.map((g) => ({ ...g, userCount: countMap.get(g.key) || 0 })) });
  })
);

// 新建权限组
router.post(
  '/',
  wrap(async (req, res) => {
    const key = String(req.body?.key || '').trim().toLowerCase();
    const name = String(req.body?.name || '').trim();
    const description = String(req.body?.description || '').trim();
    const permissions = normalizePerms(req.body?.permissions || []);
    if (!KEY_RE.test(key)) throw new ApiError(400, 400, '标识只能用小写字母/数字/._-，字母开头，2~32 位');
    if (!name) throw new ApiError(400, 400, '请填写权限组名称');
    if (await PermissionGroup.findOne({ key })) throw new ApiError(400, 400, '该标识已存在');
    await assertPermsExist(permissions);
    const doc = await PermissionGroup.create({ key, name, description, permissions, builtIn: false });
    ok(res, doc);
  })
);

// 更新权限组（内置组由启动播种维护，只读）
router.put(
  '/:id',
  wrap(async (req, res) => {
    const doc = await PermissionGroup.findById(req.params.id);
    if (!doc) throw new ApiError(404, 404, '权限组不存在');
    if (doc.builtIn) throw new ApiError(400, 400, '内置权限组由系统播种维护，不能修改');
    const { name, description, permissions } = req.body || {};
    if (name !== undefined) {
      const n = String(name).trim();
      if (!n) throw new ApiError(400, 400, '名称不能为空');
      doc.name = n;
    }
    if (description !== undefined) doc.description = String(description).trim();
    if (permissions !== undefined) {
      const list = normalizePerms(permissions);
      await assertPermsExist(list);
      doc.permissions = list;
    }
    await doc.save();
    ok(res, doc);
  })
);

// 删除权限组（内置组不可删；仍被账号使用的组不可删）
router.delete(
  '/:id',
  wrap(async (req, res) => {
    const doc = await PermissionGroup.findById(req.params.id);
    if (!doc) throw new ApiError(404, 404, '权限组不存在');
    if (doc.builtIn) throw new ApiError(400, 400, '内置权限组不可删除');
    const used = await User.countDocuments({ permissionGroups: doc.key });
    if (used) throw new ApiError(400, 400, `还有 ${used} 个账号在使用该权限组，请先在账号权限里移除`);
    await doc.deleteOne();
    ok(res, { success: true, deleted: doc.key });
  })
);

module.exports = router;
