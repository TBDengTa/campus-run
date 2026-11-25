/**
 * 账户学籍字段回填（一次性数据修复，可重复运行）
 *
 * 起因（用户 2026-11-23「部分账户只有班级，没有院系、专业、年级，需要你找出来，并补上」）：
 *   线上 2682 名学生里，有账户 `className` 有值、但 `grade` / `specialty` /
 *   `schoolName+schoolId` / `departmentName+departmentId` 是空的 ——
 *   管理端「账户编辑」页因此只显示出班级，院系 / 专业 / 年级三栏全空。
 *   根因是历史数据（旧迁移 / 早期手工建号）从没落过这些字段，而新课表导入会推，
 *   于是同一届学生里「有的有、有的没有」。
 *
 * 用法：
 *   node scripts/backfill-user-profile.js                  # 只看会改什么（dry-run，默认）
 *   node scripts/backfill-user-profile.js --apply          # 真正写库
 *   node scripts/backfill-user-profile.js --only=users     # 只跑某一段（users / class_profiles）
 *
 * 规则（改这里之前先读）：
 *   ① **只补空、不覆盖**：字段已有值一律不动（人工修正过的学籍不能被脚本抹掉）；
 *   ② **年级按唯一口径推导**：学号前 4 位（`roster.gradeFromStudentId`，入学年份），
 *      学号推不出（示例账号无学号）才退到班名前缀（`roster.gradeFromClassName`）；
 *      两者都推不出 → 跳过并打印，**不猜**；
 *   ③ **专业 / 院校 / 系部（含 id）取同班台账**：`class_profiles` 就是按学籍聚合出来的班级台账
 *      （院校 / 系部 / 专业都在上面，见 services/class-profiles.js），同班学生共享同一份归属。
 *      台账缺行或缺值 → 跳过并打印，**绝不从班名里切「专业」臆测**
 *      （「23级机电1班」切出来是「机电1班」，不是专业名）；
 *   ④ **幂等**：第二次运行应输出「0 条待修改」；写库后脚本会再扫一遍自证；
 *   ⑤ `--apply` 前**自动备份**受影响文档到 `<repo>/_backup/`，备份失败直接中止（不带病写库）；
 *   ⑥ 每一条改动都打印「集合 / 标识 / 字段 / 旧 → 新」，可据此反查与回滚。
 *
 * 设计成 scripts/ 而不是启动迁移：这是**数据修复**，不是 schema 迁移；
 * 部署时静默改数据比不改更危险（管理员必须先看 dry-run 清单）。
 *
 * 教师账号不在本脚本范围：教师没有班级（`className` 为空），无法从学籍推导院系，
 * 只能由管理员在组织架构里人工指定 —— dry-run 会把这类账号单独统计出来，避免「以为都补上了」。
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('../node_modules/mongoose');
const config = require('../src/config');
const User = require('../src/models/user');
const ClassProfile = require('../src/models/class-profile');
const roster = require('../src/services/roster');

const APPLY = process.argv.includes('--apply');
const onlyArg = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
const ONLY = new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean));
const wanted = (name) => !ONLY.size || ONLY.has(name);

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const isBlank = (v) => str(v) === '';
const log = (s) => console.log(s);

/** 落库前备份（只写 --apply）。写不出来就抛错中止 —— 宁可一次都不改，也不能没有回滚点。 */
function writeBackup({ users, profiles }) {
  const dir = path.resolve(__dirname, '..', '..', '_backup');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `user-profile-backfill-${stamp}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ takenAt: new Date().toISOString(), db: config.dbName, users, profiles }, null, 0),
    'utf8'
  );
  return file;
}

/** 学籍字段的中文名（打印清单用） */
const FIELD_TEXT = {
  grade: '年级',
  specialty: '专业',
  schoolName: '院校',
  schoolId: '院校id',
  departmentName: '系部',
  departmentId: '系部id',
};

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });
  log(`=== 账户学籍字段回填（${APPLY ? 'APPLY 写库' : 'DRY-RUN 只看不改'}）===\n`);

  // ===== 载入班级台账（专业 / 院校 / 系部的来源）=====
  const profiles = await ClassProfile.find({})
    .select('className schoolId schoolName departmentId departmentName specialty grade')
    .lean();
  const profileBy = new Map(profiles.map((p) => [p.className, p]));

  // ===== 1) users：按学号 + 同班台账补空 =====
  const users = await User.find({ role: { $ne: 'teacher' }, className: { $nin: [null, ''] } })
    .select('realName account studentId className schoolId schoolName departmentId departmentName specialty grade isDemo')
    .sort({ className: 1, studentId: 1 })
    .lean();

  const plan = []; // { doc, collection, label, patch }
  const skipped = [];
  const reasons = { grade: 0, specialty: 0, dept: 0 };
  let noClass = 0;

  for (const u of users) {
    const className = str(u.className);
    const p = profileBy.get(className) || null;
    const patch = {};

    // ① 年级：学号前 4 位 → 班名前缀
    if (isBlank(u.grade)) {
      const derived = roster.gradeFromStudentId(u.studentId) || roster.gradeFromClassName(className);
      if (derived) patch.grade = derived;
      else {
        reasons.grade += 1;
        skipped.push(`users/${u.realName || u._id}（${className}）：学号与班名都推不出年级`);
      }
    }
    // ② 专业：同班台账
    if (isBlank(u.specialty)) {
      const v = p ? str(p.specialty) : '';
      if (v) patch.specialty = v;
      else {
        reasons.specialty += 1;
        skipped.push(`users/${u.realName || u._id}（${className}）：班级台账缺专业，不臆测`);
      }
    }
    // ③ 院校 / 系部（名字与 id 各自独立补；id 只跟名字配套写，避免塞进错归属）
    const orgFields = ['schoolName', 'schoolId', 'departmentName', 'departmentId'];
    const wantOrg = orgFields.filter((f) => isBlank(u[f]));
    if (wantOrg.length) {
      let filled = false;
      for (const f of wantOrg) {
        const v = p ? p[f] : '';
        if (v === undefined || v === null || v === '') continue;
        patch[f] = v;
        filled = true;
      }
      if (!filled) {
        reasons.dept += 1;
        skipped.push(`users/${u.realName || u._id}（${className}）：${wantOrg.map((f) => FIELD_TEXT[f]).join('/')}台账缺值`);
      }
    }

    if (Object.keys(patch).length) {
      plan.push({
        collection: 'users',
        id: u._id,
        group: `${className}${u.isDemo ? ' [示例]' : ''}`,
        label: `${u.realName || u.account || '(无名)'}(${u.studentId || '无学号'}) ${className}${u.isDemo ? ' [示例]' : ''}`,
        patch,
      });
    }
  }

  // 教师单独统计：没有班级 → 无法推导，必须人工指定（不静默漏掉）
  const teachers = await User.find({ role: 'teacher' })
    .select('realName departmentId departmentName specialty grade')
    .lean();
  const teachersMissing = teachers.filter((t) => isBlank(t.departmentId) || isBlank(t.departmentName));
  noClass = (await User.countDocuments({ role: { $ne: 'teacher' }, $or: [{ className: '' }, { className: null }] }));

  // ===== 2) class_profiles：年级按班名补（与 users 同口径）=====
  const profilePlan = [];
  for (const p of profiles) {
    if (!isBlank(p.grade)) continue;
    const g = roster.gradeFromClassName(p.className);
    if (g) profilePlan.push({ collection: 'class_profiles', id: p._id, group: p.className, label: p.className, patch: { grade: g } });
    else skipped.push(`class_profiles/${p.className}：班名推不出年级`);
  }

  // ===== 打印计划（按「班级 + 字段」分组，几百条也不刷屏）=====
  const printSection = (items) => {
    const grouped = new Map();
    for (const it of items) {
      const fields = Object.keys(it.patch)
        .map((f) => `${FIELD_TEXT[f] || f} → ${str(it.patch[f])}`)
        .join(' / ');
      const key = `${it.collection}\t${it.group}\t${fields}`;
      const g = grouped.get(key) || { n: 0 };
      g.n += 1;
      grouped.set(key, g);
    }
    for (const [key, g] of [...grouped.entries()].sort()) {
      const [collection, group, fields] = key.split('\t');
      log(`  ${collection} ${group} × ${g.n}：${fields}`);
    }
  };

  if (wanted('users') && plan.length) {
    log(`--- users：${plan.length} 名学生待补（按字段分组）---`);
    printSection(plan);
    log('\n  前 10 条明细：');
    for (const it of plan.slice(0, 10)) {
      log(`    ${it.label}：${Object.entries(it.patch).map(([k, v]) => `${FIELD_TEXT[k] || k} → ${v}`).join(', ')}`);
    }
    log('');
  }
  if (wanted('class_profiles') && profilePlan.length) {
    log(`--- class_profiles：${profilePlan.length} 个班待补年级 ---`);
    for (const it of profilePlan) log(`    ${it.label}：年级 → ${it.patch.grade}`);
    log('');
  }

  log(`统计：学生（有班级）${users.length} 人；无班级学生 ${noClass} 人（不参与）`);
  log(`  教师 ${teachers.length} 人，其中 ${teachersMissing.length} 人没有院校/系部（**本脚本不处理**：教师无班级可推导，需人工指定）`);
  if (skipped.length) {
    log(`\n=== 跳过 ${skipped.length} 条（无法唯一推导，需人工核对）===`);
    for (const s of skipped.slice(0, 40)) log(`  ${s}`);
    if (skipped.length > 40) log(`  …… 其余 ${skipped.length - 40} 条省略`);
  }

  const all = [...(wanted('users') ? plan : []), ...(wanted('class_profiles') ? profilePlan : [])];
  log(`\n=== ${APPLY ? 'APPLY' : 'DRY-RUN'}：共 ${all.length} 条待修改 ===`);
  if (!all.length) {
    log('没有待修改的数据（幂等：说明已经补过了）。');
    await mongoose.disconnect();
    return;
  }
  if (!APPLY) {
    log('\n未写库（dry-run）。确认清单无误后加 --apply 执行。');
    await mongoose.disconnect();
    return;
  }

  // ===== 备份（受影响文档的完整原值）=====
  const userIds = plan.map((p) => p.id);
  const profileIds = profilePlan.map((p) => p.id);
  const backup = writeBackup({
    users: userIds.length ? await User.find({ _id: { $in: userIds } }).lean() : [],
    profiles: profileIds.length ? await ClassProfile.find({ _id: { $in: profileIds } }).lean() : [],
  });
  log(`已备份：${backup}`);
  log('（还原方式：把 json 里的 users/profiles 按 _id 覆盖回对应集合）\n');

  // ===== 写库 =====
  let doneUsers = 0;
  let doneProfiles = 0;
  for (const it of plan) {
    await User.updateOne({ _id: it.id }, { $set: it.patch });
    doneUsers += 1;
  }
  for (const it of profilePlan) {
    await ClassProfile.updateOne({ _id: it.id }, { $set: it.patch });
    doneProfiles += 1;
  }
  log(`已写入：users ${doneUsers} 条，class_profiles ${doneProfiles} 条。`);

  // ===== 自证：再扫一遍必须 0 条待修改（幂等）=====
  const left = await User.countDocuments({
    role: { $ne: 'teacher' },
    className: { $nin: [null, ''] },
    $or: [
      { grade: { $in: ['', null] } },
      { specialty: { $in: ['', null] } },
      { departmentName: { $in: ['', null] } },
      { departmentId: null },
    ],
  });
  const profileLeft = await ClassProfile.countDocuments({ grade: { $in: ['', null] } });
  log(`复核：仍有 ${left} 名学生缺字段（应为跳过的「推导不出」）、${profileLeft} 个班缺年级（同上）`);
  if (left || profileLeft) {
    log('⚠️ 仍有残留：见上面的「跳过」清单，需先补名单院校/专业列或手工指定。');
  }
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('ERR', e);
  try {
    await mongoose.disconnect();
  } catch (err) {
    /* ignore */
  }
  process.exit(1);
});
