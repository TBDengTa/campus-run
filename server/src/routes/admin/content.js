const express = require('express');
const { wrap, ok, ApiError } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const Announcement = require('../../models/announcement');
const Changelog = require('../../models/changelog');
const Holiday = require('../../models/holiday');
const Organization = require('../../models/organization');
const Badge = require('../../models/badge');
const UserBadge = require('../../models/user-badge');
const FileObject = require('../../models/file-object');

const router = express.Router();

const CRUD = [
  ['announcements', Announcement],
  ['changelogs', Changelog],
  ['holidays', Holiday],
  ['badges', Badge],
];

// ===== 徽章「按组创建」（等级徽章整组一次写入）=====
// 数据形态**不变**：仍然是一枚徽章一条 badges 定义，等级组 = 同一 tierGroup 下 tierLevel 递增的多条定义，
// 只是管理端从「逐条建级别」改为「一次定义整组」，由本接口把整组写进去（前端不再循环调单条接口）。
// 保留单条接口 PUT/POST/DELETE /badges/:id 不动（向后兼容）；本组路由必须注册在 CRUD 循环
// 之前，否则 PUT/DELETE /badges/group 会被 /badges/:id 抢先匹配（:id='group'）。
const BADGE_TYPES = [
  'total_steps',
  'total_distance',
  'total_days',
  'goal_days',
  'single_steps',
  'single_distance',
  'streak_days',
  'points',
  'rank',
];
const TIER_MIN_LEVELS = 2;
const TIER_MAX_LEVELS = 8;
const MAX_SORT = 100000;

function badgeTypeLabelOf(type) {
  const map = {
    total_steps: '累计步数',
    total_distance: '累计距离',
    total_days: '累计打卡天数',
    goal_days: '达标天数',
    single_steps: '单日步数',
    single_distance: '单次距离',
    streak_days: '连续打卡天数',
    points: '跑分达标',
    rank: '跑分排名前 N',
  };
  return map[type] || type;
}

// 级别名去重用的归一化（忽略空白差异）
const nameKeyOf = (s) => String(s || '').replace(/\s+/g, '');

// 组名 → key 前缀：非 ASCII 字符丢弃，只留 [a-z0-9-_]，保证徽章 key 是 ASCII（与 1.0 迁移的 hex key 同规格）
function slugOf(text) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return s || 'tier';
}

// 组内新增级别自动生成 key；与「库内已存在」及「本次已分配」都不冲突
function makeKeyFactory(taken) {
  return (slugBase) => {
    for (let i = 1; i < 1000; i += 1) {
      const candidate = `${slugBase}_lv${i}`;
      if (!taken.has(candidate)) {
        taken.add(candidate);
        return candidate;
      }
    }
    // 兜底（正常到不了）：随机后缀
    let candidate;
    do {
      candidate = `${slugBase}_${Math.random().toString(36).slice(2, 8)}`;
    } while (taken.has(candidate));
    taken.add(candidate);
    return candidate;
  };
}

// 请求体 → 整组载荷（含可读校验；违规一律 400 并说明原因）
function parseTierPayload(raw) {
  const body = raw || {};
  const tierGroup = String(body.tierGroup || '').trim();
  if (!tierGroup) throw new ApiError(400, 400, '等级徽章必须填写组名（tierGroup）');
  const type = String(body.type || '').trim();
  if (!BADGE_TYPES.includes(type)) {
    throw new ApiError(400, 400, `条件类型不合法：${type || '(空)'}，取值见条件类型下拉的 9 项`);
  }
  const rawLevels = Array.isArray(body.levels) ? body.levels : [];
  if (rawLevels.length < TIER_MIN_LEVELS) {
    throw new ApiError(400, 400, `等级徽章至少 ${TIER_MIN_LEVELS} 级（当前 ${rawLevels.length} 级）`);
  }
  if (rawLevels.length > TIER_MAX_LEVELS) {
    throw new ApiError(400, 400, `等级徽章最多 ${TIER_MAX_LEVELS} 级（当前 ${rawLevels.length} 级）`);
  }
  const levels = rawLevels.map((lv, i) => {
    const row = lv || {};
    const name = String(row.name || '').trim();
    if (!name) throw new ApiError(400, 400, `第 ${i + 1} 级缺少等级名`);
    const target = Number(row.target);
    if (!Number.isFinite(target) || target <= 0) {
      throw new ApiError(400, 400, `第 ${i + 1} 级「${name}」的目标值必须是大于 0 的数字`);
    }
    const key = row.key == null ? '' : String(row.key).trim();
    return {
      key,
      name,
      target,
      icon: row.icon == null ? '' : String(row.icon),
      tierColor: row.tierColor == null ? '' : String(row.tierColor),
    };
  });
  // 阈值严格递增（行序即 tierLevel 序；前端也按阈值升序排）
  for (let i = 1; i < levels.length; i += 1) {
    if (!(levels[i].target > levels[i - 1].target)) {
      throw new ApiError(
        400,
        400,
        `目标值必须随等级严格递增（Lv${i} 目标 ${levels[i - 1].target}，Lv${i + 1} 目标 ${levels[i].target}）`
      );
    }
  }
  // 级别名不重复
  const seenName = new Set();
  for (const lv of levels) {
    const nk = nameKeyOf(lv.name);
    if (seenName.has(nk)) throw new ApiError(400, 400, `组内级别名重复：${lv.name}`);
    seenName.add(nk);
  }
  // 显式传入的 key 不能重复；未传的留空由写入方生成
  const seenKey = new Set();
  for (const lv of levels) {
    if (!lv.key) continue;
    if (seenKey.has(lv.key)) throw new ApiError(400, 400, `组内徽章 key 重复：${lv.key}`);
    seenKey.add(lv.key);
  }
  return {
    tierGroup,
    type,
    description: String(body.description == null ? '' : body.description),
    enabled: body.enabled !== false,
    sort: body.sort == null ? null : Number(body.sort) || 0,
    levels,
  };
}

// 组内已被用户获得的 badgeKey 集合（删除级别 / 整组删除的守卫依据）
async function earnedKeysOf(keys) {
  if (!keys.length) return new Set();
  const rows = await UserBadge.find({ badgeKey: { $in: keys } }).select('badgeKey').lean();
  return new Set(rows.map((r) => r.badgeKey));
}

// 组级读模型：给管理端列表/表单用（含条件类型中文名与级别摘要）
function tierGroupModelOf(tierGroup, rows) {
  const levels = [...rows].sort((a, b) => (Number(a.tierLevel) || 0) - (Number(b.tierLevel) || 0));
  const first = levels[0] || {};
  const type = first.type || '';
  return {
    tierGroup,
    type,
    typeLabel: badgeTypeLabelOf(type),
    description: first.description || '',
    sort: Number(first.sort) || 0,
    enabled: levels.length > 0 && levels.every((l) => l.enabled !== false),
    levelCount: levels.length,
    levels: levels.map((l) => ({
      _id: String(l._id),
      key: l.key,
      name: l.name,
      target: Number(l.target) || 0,
      icon: l.icon || '',
      tierColor: l.tierColor || '',
      type: l.type,
      tierLevel: Number(l.tierLevel) || 0,
      sort: Number(l.sort) || 0,
      enabled: l.enabled !== false,
    })),
  };
}

async function loadGroupDocs(tierGroup) {
  return Badge.find({ tierGroup }).sort({ tierLevel: 1, sort: 1 }).lean();
}

// 一次写入整组：按 tierGroup + tierLevel 匹配 upsert（新增缺失级 / 更新已有级），返回整组读模型
//   校验：type 全组一致、tierLevel 连续且唯一、target 严格递增、级别名不重复（parseTierPayload 已做）
//   守卫：被删掉的级别若已有用户获得 → 409 拒绝，绝不静默删除用户已获得的徽章
async function writeTierGroup({ tierGroup, payload, isCreate }) {
  const existing = await loadGroupDocs(tierGroup);
  if (isCreate && existing.length) {
    throw new ApiError(409, 409, `等级组「${tierGroup}」已存在，请改用编辑或换一个组名`);
  }
  if (!isCreate && !existing.length) throw new ApiError(404, 404, `等级组「${tierGroup}」不存在`);

  const existingByKey = new Map(existing.map((row) => [row.key, row]));
  const slugBase = slugOf(tierGroup);
  const taken = new Set(await Badge.distinct('key'));
  const makeKey = makeKeyFactory(taken);

  // 组内其它定义（含所有级别）的 type 必须一致：payload.type 为唯一真相
  if (existing.some((row) => row.type !== payload.type)) {
    const misc = existing.find((row) => row.type !== payload.type);
    throw new ApiError(
      400,
      400,
      `组内条件类型必须一致：「${tierGroup}」现有级别用的是「${badgeTypeLabelOf(misc.type)}」，不能改成「${badgeTypeLabelOf(payload.type)}」`
    );
  }

  // 行序即 tierLevel（1 起，连续）。map 内不能引用正在构建的 levels（TDZ），已认领的 key 用 claimed 跟踪
  const claimed = new Set();
  const levels = payload.levels.map((lv, i) => {
    const tierLevel = i + 1;
    // 优先按前端回传的 key 匹配已有级别（key 是历史记录的锚点，改级别名/阈值都不能换 key）；
    // 没传 key 或该 key 不属于本组时，按位置认领本组剩下的一条（保证老定义不会被误删重建）
    let key = lv.key;
    if (key) {
      const owner = existingByKey.get(key);
      if (owner && owner.tierGroup !== tierGroup) {
        throw new ApiError(409, 409, `徽章 key「${key}」已被其它徽章占用，请换一个`);
      }
    }
    if (!key) {
      const pool = existing.filter((row) => !claimed.has(row.key));
      const free = pool.find((row) => (Number(row.tierLevel) || 0) === tierLevel) || pool[0];
      key = free ? free.key : makeKey(slugBase);
    }
    claimed.add(key);
    const already = existingByKey.get(key);
    if (already && already.type !== payload.type) {
      throw new ApiError(400, 400, `徽章「${already.name}」（key=${key}）的条件类型与组内其它级别不一致`);
    }
    return { tierLevel, key, name: lv.name, target: lv.target, icon: lv.icon, tierColor: lv.tierColor };
  });

  const keptKeys = new Set(levels.map((l) => l.key));
  const removed = existing.filter((row) => !keptKeys.has(row.key));
  const earned = await earnedKeysOf([...keptKeys, ...removed.map((r) => r.key)]);
  if (removed.length) {
    const blocked = removed.filter((row) => earned.has(row.key));
    if (blocked.length) {
      const names = blocked.map((row) => `Lv${row.tierLevel}「${row.name}」`).join('、');
      const n = await UserBadge.countDocuments({ badgeKey: { $in: blocked.map((r) => r.key) } });
      throw new ApiError(
        409,
        409,
        `不能删除已有用户获得的级别：${names}（共 ${n} 条获得记录）。请先停用该级别，或先处理这些获得记录`
      );
    }
  }

  // 基准 sort：显式给了就用；否则沿用组内最小 sort；新建时排到列表末尾
  let baseSort;
  if (payload.sort != null) baseSort = payload.sort;
  else if (existing.length) baseSort = Math.min(...existing.map((row) => Number(row.sort) || 0));
  else baseSort = Math.min((await Badge.countDocuments({})) + 1, MAX_SORT);

  const ops = [];
  let created = 0;
  for (const lv of levels) {
    const doc = {
      key: lv.key,
      name: lv.name,
      description: payload.description,
      icon: lv.icon,
      type: payload.type,
      target: lv.target,
      mode: 'tier',
      tierGroup,
      tierLevel: lv.tierLevel,
      tierColor: lv.tierColor,
      sort: baseSort + (lv.tierLevel - 1),
      enabled: payload.enabled,
    };
    const current = existingByKey.get(lv.key);
    if (current) {
      // 已有级别：整组字段一起覆盖（含 tierLevel —— 级别重排以本接口的载荷为准）
      ops.push({ updateOne: { filter: { _id: current._id }, update: { $set: doc } } });
    } else {
      // 新增级别用 create 而不是 bulkWrite upsert：模型 pre('validate') 的形态校验必须生效
      await Badge.create(doc);
      created += 1;
    }
  }
  if (ops.length) await Badge.bulkWrite(ops, { ordered: true });

  // 被移出整组的级别（无任何用户获得，前面已守卫）在这里删除
  if (removed.length) await Badge.deleteMany({ _id: { $in: removed.map((row) => row._id) } });

  const rows = await loadGroupDocs(tierGroup);
  // 审计口径：created / updated / removed 三数互不重叠（updated = 组内本次保留的已有级别数）
  return {
    group: tierGroupModelOf(tierGroup, rows),
    created,
    updated: existing.length - removed.length,
    removed: removed.length,
    levelCount: rows.length,
  };
}

router.get(
  '/badges/groups',
  wrap(async (req, res) => {
    const rows = await Badge.find({ tierGroup: { $nin: [null, ''] } }).sort({ tierLevel: 1, sort: 1 }).lean();
    const byGroup = new Map();
    for (const row of rows) {
      const g = String(row.tierGroup || '').trim();
      if (!g) continue;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(row);
    }
    const groups = [...byGroup.entries()].map(([g, list]) => tierGroupModelOf(g, list));
    groups.sort((a, b) => a.sort - b.sort || a.tierGroup.localeCompare(b.tierGroup));
    ok(res, groups);
  })
);

router.post(
  '/badges/group',
  requirePermission('content.manage'),
  wrap(async (req, res) => {
    const payload = parseTierPayload(req.body);
    ok(res, await writeTierGroup({ tierGroup: payload.tierGroup, payload, isCreate: true }));
  })
);

// 组名不可改（user_badges.badgeKey 与页面分组都锚在 key/tierGroup 上）：URL 与 body 必须一致
router.put(
  '/badges/group/:tierGroup',
  requirePermission('content.manage'),
  wrap(async (req, res) => {
    const tierGroup = String(req.params.tierGroup || '').trim();
    if (!tierGroup) throw new ApiError(400, 400, '缺少组名（tierGroup）');
    const payload = parseTierPayload(req.body);
    if (payload.tierGroup !== tierGroup) {
      throw new ApiError(400, 400, `组名不可修改（URL 为「${tierGroup}」，请求体为「${payload.tierGroup}」）`);
    }
    ok(res, await writeTierGroup({ tierGroup, payload, isCreate: false }));
  })
);

router.delete(
  '/badges/group/:tierGroup',
  requirePermission('content.manage'),
  wrap(async (req, res) => {
    const tierGroup = String(req.params.tierGroup || '').trim();
    const rows = await loadGroupDocs(tierGroup);
    if (!rows.length) throw new ApiError(404, 404, `等级组「${tierGroup}」不存在`);
    // 守卫：任何一级已有用户获得就整组拒绝（用户已获得的徽章不允许被静默删除）
    const earned = await earnedKeysOf(rows.map((row) => row.key));
    if (earned.size) {
      const blocked = rows.filter((row) => earned.has(row.key));
      const n = await UserBadge.countDocuments({ badgeKey: { $in: blocked.map((r) => r.key) } });
      throw new ApiError(
        409,
        409,
        `等级组「${tierGroup}」已有用户获得（${blocked
          .map((row) => `Lv${row.tierLevel}「${row.name}」`)
          .join('、')}，共 ${n} 条记录），不能整组删除；可改为停用`
      );
    }
    await Badge.deleteMany({ _id: { $in: rows.map((row) => row._id) } });
    ok(res, { success: true, tierGroup, deleted: rows.length });
  })
);

// ===== 徽章图标：从文件管理（用途 = badge）里挑最近上传的一批 =====
// 只读、只返回徽章表单需要的字段（不含 uploader 等归属信息）。挂载级已是 content.view，
// 因此「只用徽章管理」的管理员也能选图，无需把 file.view 扩大给他；删除仍归文件管理（file.manage）。
const BADGE_ICON_LIMIT = 120;

router.get(
  '/badge-icons',
  wrap(async (req, res) => {
    const rows = await FileObject.find({ category: 'badge' })
      .sort({ createdAt: -1 })
      .limit(BADGE_ICON_LIMIT)
      .select('url originalName size createdAt')
      .lean();
    ok(
      res,
      rows.map((r) => ({
        id: String(r._id),
        url: r.url,
        name: r.originalName || '',
        size: Number(r.size) || 0,
        createdAt: r.createdAt,
      }))
    );
  })
);

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
