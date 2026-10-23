/**
 * 班级台账（class_profiles）同步与维护
 *
 * 为什么需要这张表：早操 / 早八「本班到底有没有」是领导明确点出的差异（有的班级无早操），
 * 出勤率的分母与录入台的对象列表都要用它；班级的院校 / 系部 / 年级 / 人数也需要一个稳定的落点，
 * 否则每做一个分院维度看板都要 $lookup users。
 *
 * 同步规则（**只补不覆盖**）：
 *   - className 为新出现的班级 → 建档；
 *   - 已存在的班级 → 只刷新「从学籍能算出来的派生字段」（人数、院校、系部、年级、班主任姓名），
 *     **不动** hasMorningExercise / hasMorningClass / dormCount / remark —— 这些是老师手工维护的，
 *     被一次同步覆盖掉就等于把「本班无早操」的标记洗掉了（历史踩坑点，务必保持只补不覆盖）。
 */
const User = require('../models/user');
const ClassProfile = require('../models/class-profile');

// 归属名归一化：去首尾空白（与 routes/admin/class-profile.js 的 str() 同口径）。
// 台账里的院校 / 系部名会被**原样当成筛选值**下发，带脏空白就会「选了却筛不出任何班」。
const normName = (v) => (v === undefined || v === null ? '' : String(v).trim());

// 计数累加（name → n）
function bump(map, key, n) {
  map.set(key, (map.get(key) || 0) + n);
}

// 多数票裁决：同一班出现多个院校 / 系部名时，取**出现次数最多**的那个；
// 次数并列时取字典序靠前的那个 —— **幂等**是硬要求：同一份学籍数据每次同步的结果必须一致，
// 否则每点一次「从学籍同步」台账归属就翻一次（旧实现的 $first 正是这个隐患：
// 分组里谁排第一由存储顺序 / 索引形态决定，跨校区同名班只留下随机的一个，另一个校区从下拉里消失）。
function pickMajority(buckets) {
  let best = '';
  let bestCount = 0;
  for (const [name, count] of buckets) {
    if (!name) continue; // 空名不参与裁决（不能把「有归属」的班裁决成空）
    // 次数多者胜；并列取字典序更小者（遍历顺序无关，因此同输入必得同结果）
    if (count > bestCount || (count === bestCount && name < best)) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

// 学籍聚合：每个班级的人数 / 院校 / 院系(系部) / 年级 / 班主任
// 返回 { rows, homeroomBy, conflicts }：
//   · rows 每项 = { _id: className, studentCount, schoolId, schoolName, departmentId, departmentName, specialty, grade }
//   · conflicts = 归属有歧义的班（同一 className 出现多个院校名 / 系部名），**不静默**
async function aggregateRoster() {
  // ① 按「班级 + 院校名 + 系部名」分组：人数在组内求和；
  //    各归属名在本班内出现的次数留给下面的多数票裁决（一个班跨两个校区时两组都会被保留，
  //    旧实现按 className 直接 $first，等于随机丢掉一边）。
  const groups = await User.aggregate([
    { $match: { role: { $ne: 'teacher' }, className: { $nin: [null, ''] } } },
    {
      $group: {
        _id: { className: '$className', schoolName: '$schoolName', departmentName: '$departmentName' },
        studentCount: { $sum: 1 },
        schoolId: { $first: '$schoolId' },
        departmentId: { $first: '$departmentId' },
        specialty: { $first: '$specialty' },
        grade: { $first: '$grade' },
      },
    },
    // 排序只为让组内 $first（specialty / grade / id）对同一份数据每次得到同一个值
    { $sort: { '_id.className': 1, '_id.schoolName': 1, '_id.departmentName': 1 } },
  ]);

  const byClass = new Map();
  for (const g of groups) {
    const className = String(g._id.className);
    let acc = byClass.get(className);
    if (!acc) {
      acc = {
        className,
        studentCount: 0,
        schoolNames: new Map(), // 院校名 → 该班学生数（用于多数票）
        schoolIds: new Map(), // 院校名 → (schoolId → 该班学生数)
        departmentNames: new Map(),
        departmentIds: new Map(),
        specialties: new Map(),
        grades: new Map(),
      };
      byClass.set(className, acc);
    }
    const n = g.studentCount || 0;
    acc.studentCount += n;
    const sName = normName(g._id.schoolName);
    const dName = normName(g._id.departmentName);
    if (sName) {
      bump(acc.schoolNames, sName, n);
      // id 只与该名字配对使用：名字为空的行不贡献 id，避免把「有 id 无名字」的归属塞进某个有名院校
      if (g.schoolId) bump(acc.schoolIds, `${sName}\u0000${g.schoolId}`, n);
    }
    if (dName) {
      bump(acc.departmentNames, dName, n);
      if (g.departmentId) bump(acc.departmentIds, `${dName}\u0000${g.departmentId}`, n);
    }
    bump(acc.specialties, normName(g.specialty), n);
    bump(acc.grades, normName(g.grade), n);
  }

  // ② 每个班按多数票定归属；冲突班单独收集（className → 多个归属名），返回给调用方透出
  const rows = [];
  const conflicts = [];
  for (const className of [...byClass.keys()].sort()) {
    const acc = byClass.get(className);
    const schoolName = pickMajority(acc.schoolNames);
    const departmentName = pickMajority(acc.departmentNames);
    // id 与「选中的名字」配对：该校名下 id 也走多数票（同名校名下多个 id 时同样不能随机）
    const pickIdOf = (nested, name) => {
      if (!name) return '';
      let best = '';
      let bestCount = 0;
      for (const [pair, n] of nested) {
        const sep = pair.indexOf('\u0000');
        if (pair.slice(0, sep) !== name) continue;
        const id = pair.slice(sep + 1);
        if (n > bestCount || (n === bestCount && id < best)) {
          best = id;
          bestCount = n;
        }
      }
      return best;
    };
    rows.push({
      _id: className,
      studentCount: acc.studentCount,
      schoolId: pickIdOf(acc.schoolIds, schoolName),
      schoolName,
      departmentId: pickIdOf(acc.departmentIds, departmentName),
      departmentName,
      specialty: pickMajority(acc.specialties),
      grade: pickMajority(acc.grades),
    });
    // 冲突：同一班出现 ≥2 个**不同**归属名（多数票只是拿到能用的值，歧义本身要让人看见）
    if (acc.schoolNames.size > 1) {
      conflicts.push({
        className,
        field: 'school',
        values: [...acc.schoolNames.keys()].sort(),
        counts: Object.fromEntries([...acc.schoolNames.entries()].sort()),
        chosen: schoolName,
      });
    }
    if (acc.departmentNames.size > 1) {
      conflicts.push({
        className,
        field: 'department',
        values: [...acc.departmentNames.keys()].sort(),
        counts: Object.fromEntries([...acc.departmentNames.entries()].sort()),
        chosen: departmentName,
      });
    }
  }
  const teachers = await User.find({ role: 'teacher', homeroomClasses: { $exists: true, $ne: [] } })
    .select('realName nickname account homeroomClasses')
    .lean();
  const homeroomBy = new Map();
  for (const t of teachers) {
    const name = t.realName || t.nickname || t.account || '';
    if (!name) continue;
    for (const cn of t.homeroomClasses || []) {
      const list = homeroomBy.get(cn) || [];
      if (!list.includes(name)) list.push(name);
      homeroomBy.set(cn, list);
    }
  }
  return { rows, homeroomBy, conflicts };
}

// 从学籍同步（补新班 + 刷新派生字段）
async function syncClassProfiles({ className } = {}) {
  const { rows, homeroomBy, conflicts } = await aggregateRoster();
  const wanted = className ? rows.filter((r) => r._id === className) : rows;
  const existing = await ClassProfile.find(className ? { className } : {})
    .select('className hasMorningExercise hasMorningClass')
    .lean();
  const existsSet = new Set(existing.map((e) => e.className));

  const ops = [];
  let created = 0;
  let updated = 0;
  for (const r of wanted) {
    const isNew = !existsSet.has(r._id);
    if (isNew) created += 1;
    else updated += 1;
    const set = {
      studentCount: r.studentCount || 0,
      specialty: r.specialty || '',
      homeroomNames: homeroomBy.get(r._id) || [],
      syncedAt: new Date(),
    };
    // 院校 / 系部 / 年级：学籍有值才写（避免把手工修正过的值抹成空）
    // 院校与系部同口径：都是 organizations 上的层级（school → department），
    // 归属跟随名单导入 / 组织架构，不开放管理端手改。
    if (r.schoolId) set.schoolId = r.schoolId;
    if (r.schoolName) set.schoolName = r.schoolName;
    if (r.departmentId) set.departmentId = r.departmentId;
    if (r.departmentName) set.departmentName = r.departmentName;
    if (r.grade) set.grade = r.grade;
    ops.push({
      updateOne: {
        filter: { className: r._id },
        update: {
          $set: set,
          // 新班级的默认值：默认「有早操 / 有早八」，由老师按实际情况关掉
          ...(isNew ? { $setOnInsert: { hasMorningExercise: true, hasMorningClass: true } } : {}),
        },
        upsert: true,
      },
    });
  }
  if (ops.length) await ClassProfile.bulkWrite(ops, { ordered: false });
  // 归属有歧义的班（同名班跨校区 / 跨系部）一并返回：管理员必须能看见「这些班的归属不是唯一的」，
  // 否则多数票裁决结果看起来就像「系统随机改了我的台账」
  return {
    created,
    updated,
    total: wanted.length,
    conflicts: className ? conflicts.filter((c) => c.className === className) : conflicts,
  };
}

// 宿舍住宿人数回填（dorm_assignments 变化后刷新 class_profiles.dormCount 展示值）
async function refreshDormCounts(className) {
  const DormAssignment = require('../models/dorm-assignment');
  const match = { status: { $in: ['checked_in', 'guest'] }, className: { $nin: [null, ''] } };
  if (className) match.className = className;
  const rows = await DormAssignment.aggregate([
    { $match: match },
    { $group: { _id: '$className', n: { $sum: 1 } } },
  ]);
  const ops = rows.map((r) => ({
    updateOne: { filter: { className: r._id }, update: { $set: { dormCount: r.n } } },
  }));
  if (ops.length) await ClassProfile.bulkWrite(ops, { ordered: false });
  return rows.length;
}

// 批量标记早操 / 早八 / 晚自习（按年级或院系批量设置，再对个别班级单独覆盖）
async function batchSetFlags({ scope = {}, field, value }) {
  if (!['hasMorningExercise', 'hasMorningClass', 'hasNightStudy'].includes(field)) throw new Error('字段不合法');
  const filter = {};
  if (scope.grade) filter.grade = String(scope.grade);
  if (scope.departmentId) filter.departmentId = scope.departmentId;
  if (scope.classNames && scope.classNames.length) filter.className = { $in: scope.classNames };
  const res = await ClassProfile.updateMany(filter, { $set: { [field]: !!value } });
  return { matched: res.matchedCount, modified: res.modifiedCount };
}

module.exports = { syncClassProfiles, refreshDormCounts, batchSetFlags, aggregateRoster };
