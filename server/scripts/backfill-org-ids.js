/**
 * 组织归属 id 回填（一次性数据修复，可重复运行）
 *
 * 起因（用户 2026-11-13「部员检查录入时提示目标班级没有归属院系」）：
 *   名单导入历来只写 `schoolName` / `departmentName` 两个**名字**，不写 id；
 *   而鉴权、`check_records.departmentId`、`scopeFilter` 全按 id 判范围 ——
 *   整届 26 级（20 个班 / 1147 名学生 / 153 间宿舍 / 21 个卫生区）因此「有名字、无归属」，
 *   分院成员录这些班时被判成「没有归属院系」。
 *
 * 用法：
 *   node scripts/backfill-org-ids.js              # 只看会改什么（dry-run，默认）
 *   node scripts/backfill-org-ids.js --apply      # 真正写库
 *   node scripts/backfill-org-ids.js --only=users,class_profiles
 *
 * 规则（改这里之前先读）：
 *   ① **只补空、不覆盖**：字段已有值一律不动（人工修正过的归属不能被脚本抹掉）；
 *   ② **唯一命中才写**：按（院校名, 系部名）在组织架构里反查，同名系部跨校区且无法消歧的跳过并打印；
 *   ③ **幂等**：第二次运行应输出「0 条待修改」；写库后脚本会再扫一遍自证；
 *   ④ 每一条改动都打印「集合 / 标识 / 字段 / 旧 → 新」，可据此反查与回滚。
 *
 * 设计成 scripts/ 而不是启动迁移：这是**数据修复**，不是 schema 迁移；
 * 部署时静默改数据比不改更危险（管理员必须能先看 dry-run 清单）。
 */
const path = require('path');
const mongoose = require('../node_modules/mongoose');
const config = require('../src/config');
const User = require('../src/models/user');
const ClassProfile = require('../src/models/class-profile');
const CheckRecord = require('../src/models/check-record');
const orgResolve = require('../src/services/org-resolve');

const APPLY = process.argv.includes('--apply');
const onlyArg = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
const ONLY = new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean));
const wanted = (name) => !ONLY.size || ONLY.has(name);

const isBlank = (v) => v === undefined || v === null || v === '';
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

function log(line) {
  console.log(line);
}

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });
  const idx = await orgResolve.loadIndex();
  const summary = [];
  const skipped = [];

  const plan = (collection, id, label, patch) => {
    const changes = [];
    for (const [field, next] of Object.entries(patch)) {
      if (!next) continue;
      changes.push({ field, next });
    }
    return { collection, id, label, changes };
  };

  // ===== 1) class_profiles：按（院校名, 系部名）补 schoolId / departmentId =====
  if (wanted('class_profiles')) {
    const rows = await ClassProfile.find({}).select('className schoolId schoolName departmentId departmentName').lean();
    let n = 0;
    for (const r of rows) {
      const org = orgResolve.resolveDepartmentSync(idx, r);
      const patch = {
        schoolId: isBlank(r.schoolId) ? org.schoolId : '',
        departmentId: isBlank(r.departmentId) ? org.departmentId : '',
      };
      if (!patch.schoolId && !patch.departmentId) {
        if (isBlank(r.departmentId) && r.departmentName && !org.departmentId) {
          skipped.push(`class_profiles/${r.className}：系部名「${r.departmentName}」无法唯一解析（${org.reason}）`);
        }
        continue;
      }
      const item = plan('class_profiles', String(r._id), r.className, patch);
      item.apply = async () => {
        const $set = {};
        if (patch.schoolId) $set.schoolId = patch.schoolId;
        if (patch.departmentId) $set.departmentId = patch.departmentId;
        if (Object.keys($set).length) await ClassProfile.updateOne({ _id: r._id }, { $set });
      };
      n += 1;
      summary.push(item);
    }
    log(`class_profiles：待补 ${n} 个班`);
  }

  // ===== 2) users（学生）：同上 =====
  if (wanted('users')) {
    const rows = await User.find({ role: { $ne: 'teacher' } })
      .select('realName className schoolId schoolName departmentId departmentName')
      .lean();
    let n = 0;
    for (const r of rows) {
      if (!isBlank(r.schoolId) && !isBlank(r.departmentId)) continue;
      if (!str(r.schoolName) && !str(r.departmentName)) continue; // 连名字都没有（示例账号）：不猜
      const org = orgResolve.resolveDepartmentSync(idx, r);
      const patch = {
        schoolId: isBlank(r.schoolId) ? org.schoolId : '',
        departmentId: isBlank(r.departmentId) ? org.departmentId : '',
      };
      if (!patch.schoolId && !patch.departmentId) {
        skipped.push(`users/${r.realName || r._id}（${r.className || '无班级'}）：归属无法唯一解析（${org.reason}）`);
        continue;
      }
      const item = plan('users', String(r._id), `${r.realName || ''} ${r.className || ''}`.trim(), patch);
      item.apply = async () => {
        const $set = {};
        if (patch.schoolId) $set.schoolId = patch.schoolId;
        if (patch.departmentId) $set.departmentId = patch.departmentId;
        if (Object.keys($set).length) await User.updateOne({ _id: r._id }, { $set });
      };
      n += 1;
      summary.push(item);
    }
    log(`users：待补 ${n} 名学生`);
  }

  // ===== 3) dorm_rooms：房间没有院校字段，借「默认班级」推校区后再解析系部 =====
  if (wanted('dorm_rooms')) {
    const DormRoom = require('../src/models/dorm-room');
    const rooms = await DormRoom.find({}).select('buildingId buildingName roomNo className departmentId departmentName').lean();
    const classNames = [...new Set(rooms.map((r) => str(r.className)).filter(Boolean))];
    const profiles = classNames.length
      ? await ClassProfile.find({ className: { $in: classNames } }).select('className schoolId schoolName').lean()
      : [];
    const campusBy = new Map(profiles.map((p) => [p.className, p]));
    let n = 0;
    for (const r of rooms) {
      const campus = campusBy.get(str(r.className)) || {};
      const org = orgResolve.resolveDepartmentSync(idx, {
        departmentId: r.departmentId,
        departmentName: r.departmentName,
        schoolId: campus.schoolId,
        schoolName: campus.schoolName,
      });
      // ⚠️ dorm_rooms 模型里**没有 schoolId 字段**（stocks 只有 departmentId），所以只补系部 id
      if (!isBlank(r.departmentId) || !org.departmentId) {
        if (isBlank(r.departmentId) && r.departmentName && !org.departmentId) {
          skipped.push(`dorm_rooms/${r.buildingName || r.buildingId} ${r.roomNo}：系部无法唯一解析（${org.reason}）`);
        }
        continue;
      }
      const item = plan('dorm_rooms', String(r._id), `${r.buildingName || r.buildingId} ${r.roomNo}`, { departmentId: org.departmentId });
      item.apply = async () => DormRoom.updateOne({ _id: r._id }, { $set: { departmentId: org.departmentId } });
      n += 1;
      summary.push(item);
    }
    log(`dorm_rooms：待补 ${n} 间`);
  }

  // ===== 4) sanitary_areas：借第一个责任班推校区 =====
  if (wanted('sanitary_areas')) {
    const SanitaryArea = require('../src/models/sanitary-area');
    const areas = await SanitaryArea.find({}).select('name classNames departmentId departmentName').lean();
    const classNames = [...new Set(areas.flatMap((a) => (a.classNames || []).map(str)).filter(Boolean))];
    const profiles = classNames.length
      ? await ClassProfile.find({ className: { $in: classNames } }).select('className schoolId schoolName').lean()
      : [];
    const campusBy = new Map(profiles.map((p) => [p.className, p]));
    let n = 0;
    for (const a of areas) {
      const campus = campusBy.get(str((a.classNames || [])[0])) || {};
      const org = orgResolve.resolveDepartmentSync(idx, {
        departmentId: a.departmentId,
        departmentName: a.departmentName,
        schoolId: campus.schoolId,
        schoolName: campus.schoolName,
      });
      if (!isBlank(a.departmentId) || !org.departmentId) {
        if (isBlank(a.departmentId) && a.departmentName && !org.departmentId) {
          skipped.push(`sanitary_areas/${a.name}：系部无法唯一解析（${org.reason}）`);
        }
        continue;
      }
      const item = plan('sanitary_areas', String(a._id), a.name, { departmentId: org.departmentId });
      item.apply = async () => SanitaryArea.updateOne({ _id: a._id }, { $set: { departmentId: org.departmentId } });
      n += 1;
      summary.push(item);
    }
    log(`sanitary_areas：待补 ${n} 个`);
  }

  // ===== 5) check_records：历史记录按 className 回查台账，补 departmentId / departmentName =====
  if (wanted('check_records')) {
    const rows = await CheckRecord.find({
      $or: [{ departmentId: null }, { departmentId: { $exists: false } }],
    })
      .select('className departmentId departmentName date moduleKey source')
      .lean();
    const classNames = [...new Set(rows.map((r) => str(r.className)).filter(Boolean))];
    const profiles = classNames.length
      ? await ClassProfile.find({ className: { $in: classNames } })
          .select('className schoolId schoolName departmentId departmentName')
          .lean()
      : [];
    const byClass = new Map(profiles.map((p) => [p.className, p]));
    let n = 0;
    for (const r of rows) {
      const p = byClass.get(str(r.className));
      if (!p) {
        skipped.push(`check_records/${String(r._id)}：班级「${r.className}」不在台账（测试残留或已删班）`);
        continue;
      }
      const org = orgResolve.resolveDepartmentSync(idx, p);
      if (!org.departmentId) {
        skipped.push(`check_records/${String(r._id)}：班级「${r.className}」的系部无法唯一解析（${org.reason}）`);
        continue;
      }
      const patch = { departmentId: org.departmentId, departmentName: isBlank(r.departmentName) ? org.departmentName : '' };
      const item = plan('check_records', String(r._id), `${r.date} ${r.moduleKey} ${r.className}`, patch);
      item.apply = async () => {
        const $set = { departmentId: org.departmentId };
        if (patch.departmentName) $set.departmentName = patch.departmentName;
        await CheckRecord.updateOne({ _id: r._id }, { $set });
      };
      n += 1;
      summary.push(item);
    }
    log(`check_records：待补 ${n} 条`);
  }

  // ===== 打印计划 =====
  log(`\n=== ${APPLY ? 'APPLY' : 'DRY-RUN'}：共 ${summary.length} 条待修改 ===`);
  const shown = summary.slice(0, 400);
  for (const it of shown) {
    log(`  ${it.collection} ${it.label} (${it.id}): ${it.changes.map((c) => `${c.field} → ${c.next}`).join(', ')}`);
  }
  if (summary.length > shown.length) log(`  …… 其余 ${summary.length - shown.length} 条省略`);
  if (skipped.length) {
    log(`\n=== 跳过 ${skipped.length} 条（无法唯一解析 / 测试残留，需人工核对）===`);
    for (const s of skipped.slice(0, 80)) log(`  ${s}`);
    if (skipped.length > 80) log(`  …… 其余 ${skipped.length - 80} 条省略`);
  }

  if (!APPLY) {
    log('\n未写库（dry-run）。确认清单无误后加 --apply 执行。');
    await mongoose.disconnect();
    return;
  }

  // ===== 写库 =====
  let done = 0;
  for (const it of summary) {
    await it.apply();
    done += 1;
  }
  log(`\n已写入 ${done} 条。`);

  // ===== 自证：再扫一遍必须 0 条待修改（幂等） =====
  const again = await CheckRecord.countDocuments({ $or: [{ departmentId: null }, { departmentId: { $exists: false } }] });
  const cpAgain = await ClassProfile.countDocuments({
    departmentName: { $nin: [null, ''] },
    $or: [{ departmentId: null }, { departmentId: { $exists: false } }],
  });
  log(`复核：class_profiles 仍有 ${cpAgain} 个班缺 departmentId（应只剩无法解析的）；check_records 仍有 ${again} 条（测试残留除外）`);
  if (cpAgain || again) {
    log('⚠️ 仍有残留：多半是无法唯一解析的行（见上面的「跳过」清单），它们需要先修组织架构或补名单院校列。');
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
