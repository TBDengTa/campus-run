/**
 * 班级人数实时统计（唯一口径）
 *
 * 为什么单独一个服务：应到人数 = 本班在册学生数、应住人数 = 本班实际在住学生数，
 * 这两项**都是从学籍 / 住宿名单推导出来的**，不该由任何人手工填写 ——
 * 手填的数会在学生转班、退学、换宿舍后立刻失真，还会被下一次同步覆盖（用户明确要求「自动识别」）。
 *
 * 因此所有出口（班级配置、班级管理台账、录入台、班超汇总、学生会录入）统一走这里，
 * 不再读 class_profiles.studentCount / dormCount 的历史快照值。
 *
 * 口径：
 *   · 学生数：users.className 命中且 role != teacher（教师账号不占班级人数，与排行榜一致）；
 *   · 住宿数：dorm_assignments.className 命中且 status 为 checked_in / guest（借住也算在住）。
 */
const User = require('../models/user');
const DormAssignment = require('../models/dorm-assignment');

const DORM_STATUS = ['checked_in', 'guest'];

function normalizeNames(classNames) {
  const list = Array.isArray(classNames) ? classNames : [classNames];
  return [...new Set(list.map((n) => String(n || '').trim()).filter(Boolean))];
}

/**
 * 批量取多个班的人数（一次聚合，避免逐个班查库）
 * @returns {Promise<Map<string, { studentCount: number, dormCount: number }>>}
 */
async function liveCounts(classNames) {
  const names = normalizeNames(classNames);
  const out = new Map();
  if (!names.length) return out;
  for (const n of names) out.set(n, { studentCount: 0, dormCount: 0 });

  const [students, dorms] = await Promise.all([
    User.aggregate([
      { $match: { className: { $in: names }, role: { $ne: 'teacher' } } },
      { $group: { _id: '$className', n: { $sum: 1 } } },
    ]),
    DormAssignment.aggregate([
      { $match: { className: { $in: names }, status: { $in: DORM_STATUS } } },
      { $group: { _id: '$className', n: { $sum: 1 } } },
    ]),
  ]);

  for (const r of students || []) {
    const key = String(r && r._id ? r._id : '');
    if (!out.has(key)) continue;
    out.set(key, { ...out.get(key), studentCount: Number(r.n) || 0 });
  }
  for (const r of dorms || []) {
    const key = String(r && r._id ? r._id : '');
    if (!out.has(key)) continue;
    out.set(key, { ...out.get(key), dormCount: Number(r.n) || 0 });
  }
  return out;
}

// 单个班：内部复用批量实现，调用方不必区分两种形态
async function liveCount(className) {
  const map = await liveCounts([className]);
  const name = String(className || '').trim();
  return map.get(name) || { studentCount: 0, dormCount: 0 };
}

module.exports = { liveCounts, liveCount, DORM_STATUS };
