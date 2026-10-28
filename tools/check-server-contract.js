/**
 * 后端契约自检（不依赖数据库）：node tools/check-server-contract.js
 *
 * 为什么需要它：本机没有 MongoDB，业务路由无法真跑请求，但「路由引用的服务方法/字段名是否存在」
 * 这类错误完全可以在加载期抓出来 —— 这类错误一旦漏掉就是线上 500 或启动崩溃。
 * 另外并行开发后各接口的**形状**容易互相漂移（前端按 A 版字段名写、后端给 B 版），
 * 这里把关键形状固化成断言，改坏了立刻报错。
 *
 * 覆盖：
 *   1. 关键服务模块可加载 + 导出面完整（方法名拼错 = 运行期 TypeError）
 *   2. 模型静态成员与索引定义（部分唯一索引写错 = 防重复失效）
 *   3. 检查模块口径：derived 字段不被客户端伪造值覆盖、五模块推算与扣分算式
 *   4. 班级配置字段（hasMorningExercise / hasMorningRun 语义分开）
 *   5. 班级域新增写接口的字段白名单常量
 */
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server', 'src');
let failed = 0;
let checked = 0;

function ok(name, cond, detail) {
  checked += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function req(rel) {
  return require(path.join(SERVER, rel));
}

console.log('\n[1] 服务导出面');
const services = {
  'services/check-modules': [
    'DEFAULT_MODULES',
    'DEFAULT_BY_KEY',
    'FIELD_LIMIT',
    'listModules',
    'getModule',
    'seedCheckModules',
    'clearCache',
    'normalizeDetails',
    'fillDerived',
    'computeMetrics',
    'computeDeduct',
    'defaultOf',
    'round2',
  ],
  'services/band-chao': [
    'classSummary',
    'classRanking',
    'clearRankCache',
    'entryTargets',
    'aggregateScores',
    'metricText',
    'rangeOf',
    'buildRecordFilter',
  ],
  'services/union': [
    'resolveIdentity',
    'clearIdentityCache',
    'isUnionMember',
    'decorateUser',
    'canEnterModule',
    'canReview',
    'scopeFilter',
    'seedUnionDepartments',
  ],
  'services/class-profiles': ['syncClassProfiles', 'refreshDormCounts', 'batchSetFlags'],
  'services/formula': ['evaluate', 'validateFormula'],
};
const loaded = {};
for (const [rel, keys] of Object.entries(services)) {
  let mod = null;
  try {
    mod = req(rel);
  } catch (e) {
    ok(`${rel} 可加载`, false, e.message);
    continue;
  }
  loaded[rel] = mod;
  for (const k of keys) ok(`${rel}.${k}`, mod[k] !== undefined, 'missing');
}

console.log('\n[2] 模型静态成员与索引');
const CheckRecord = req('models/check-record');
ok('CheckRecord.COUNTED_STATUS', Array.isArray(CheckRecord.COUNTED_STATUS));
const uniqSlot = CheckRecord.UNIQUE_SLOT || {};
// 按「键里含 className」找索引，而不是写死索引名 —— 索引改名是迁移的一部分，
// 断言"键集合"才能在有人回退成旧版（漏 className）时仍然报警。
const ruleIdx = CheckRecord.schema
  .indexes()
  .find((i) => i[0].className === 1 && i[0].moduleKey === 1 && i[0].date === 1);
ok('部分唯一「槽位」索引存在', !!ruleIdx, JSON.stringify(CheckRecord.schema.indexes().map((i) => i[1] && i[1].name)));
ok('槽位唯一索引含 className（混宿/共管每班一条不被拒）', !!ruleIdx && ruleIdx[0].className === 1, ruleIdx ? JSON.stringify(ruleIdx[0]) : '索引缺失');
ok(
  '槽位唯一索引只约束 submitted/approved',
  !!ruleIdx && JSON.stringify(ruleIdx[1].partialFilterExpression).includes('submitted')
);
ok('索引名与模型声明一致', !uniqSlot.name || (!!ruleIdx && ruleIdx[1].name === uniqSlot.name), `${ruleIdx && ruleIdx[1].name} vs ${uniqSlot.name}`);
ok('迁移记录了待清理的旧索引名', !!uniqSlot.oldName, JSON.stringify(uniqSlot));
const dormsSvc = req('services/dorms');
for (const k of ['parseRoomLabel', 'roomLabel', 'assignStudentRoom', 'rosterWithRooms', 'roomOwners', 'migrateSlotIndex']) {
  ok(`services/dorms.${k}`, typeof dormsSvc[k] === 'function', typeof dormsSvc[k]);
}
// 楼号·门号解析：混宿录入最容易写错的正是分隔符
const parsed = dormsSvc.parseRoomLabel('1号楼·201');
ok('parseRoomLabel 拆出楼号与门号', parsed.buildingId === '1号楼' && parsed.roomNo === '201', JSON.stringify(parsed));
ok('parseRoomLabel 只填门号也能存', dormsSvc.parseRoomLabel('201').roomNo === '201');
ok('roomLabel 输出「楼·门」', dormsSvc.roomLabel({ buildingName: '1号楼', roomNo: '201' }) === '1号楼·201');

// 学生会成员唯一索引必须含 schoolId（校区维度）：
//   校区口径下分院记录的 departmentId 恒为 null，若唯一键只看 departmentId，
//   「北校区分会-生活部」与「洋河校区分会-生活部」会被当成同一个键 → E11000 → 500。
//   这里断言"键里有 schoolId"，而不是断言索引名（自动命名不稳定）。
const unionSvc = req('services/union');
ok('services/union.migrateMemberUniqueIndex（启动期索引迁移）', typeof unionSvc.migrateMemberUniqueIndex === 'function', typeof unionSvc.migrateMemberUniqueIndex);
const UnionMember = req('models/union-member');
const memberUniq = UnionMember.schema.indexes().find((i) => i[1] && i[1].unique && i[0] && i[0].userId === 1 && i[0].level === 1);
ok('union_members 有唯一索引（active 部分索引）', !!memberUniq, JSON.stringify(UnionMember.schema.indexes().map((i) => i[1] && i[1].name)));
ok(
  '成员唯一索引含 schoolId（跨校区同名部门不被拒收）',
  !!memberUniq && memberUniq[0].schoolId === 1,
  memberUniq ? JSON.stringify(memberUniq[0]) : '索引缺失'
);
ok(
  '成员唯一索引的 partialFilter 只约束 active',
  !!memberUniq && JSON.stringify(memberUniq[1].partialFilterExpression).includes('active')
);
ok('union_members.schoolId（院校/校区维度）', !!UnionMember.schema.path('schoolId'));
ok('union_members.schoolName', !!UnionMember.schema.path('schoolName'));
// 校区→院系展开：鉴权范围靠它把校区换算成 check_records 的院系维度
ok('services/union.expandCampusDepartments', typeof unionSvc.expandCampusDepartments === 'function', typeof unionSvc.expandCampusDepartments);
ok('services/union.campusDepartmentIndex', typeof unionSvc.campusDepartmentIndex === 'function', typeof unionSvc.campusDepartmentIndex);
const ClassProfile = req('models/class-profile');
ok('class_profiles.hasMorningExercise', !!ClassProfile.schema.path('hasMorningExercise'));
ok('class_profiles.hasMorningRun（本轮新增）', !!ClassProfile.schema.path('hasMorningRun'));
const CheckModule = req('models/check-module');
ok('check_modules.fields[].derived（本轮新增）', !!CheckModule.schema.path('fields.derived'));

// ===== 文件用途（files.category）消费方必须与模型 enum 闭合 =====
// 踩过的坑：check_photo 是第四轮新增的用途，但管理端「文件管理」的统计键写死了
// { avatar, ad, badge, other }、前端筛选条也漏了它 → 学生会检查照片**不计数、筛不出来**（用户报障）。
// 这里同时守住服务端与前端，避免以后再加用途时又漏一处。
const FileObject = req('models/file-object');
const fileCats = (FileObject && FileObject.CATEGORIES) || [];
ok('files.category 含 check_photo（学生会留证照片）', fileCats.includes('check_photo'), JSON.stringify(fileCats));
const adminFilesSrc = require('fs').readFileSync(path.join(SERVER, 'routes', 'admin', 'files.js'), 'utf8');
ok(
  '管理端文件统计键由 FileObject.CATEGORIES 派生（不再硬编码枚举）',
  /for \(const c of FileObject\.CATEGORIES\)/.test(adminFilesSrc)
);
ok(
  '删除文件会摘掉 check_records.photos 的引用（$pull，避免留裂图）',
  /\$pull: \{ photos: doc\.url \}/.test(adminFilesSrc)
);
const filesCatSrc = require('fs').readFileSync(
  path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'files', 'files.js'),
  'utf8'
);
const feCats = [...(filesCatSrc.match(/const CATS = \[([\s\S]*?)\];/)[1] || '').matchAll(/key: '([^']*)'/g)]
  .map((m) => m[1])
  .filter(Boolean);
const missingCats = fileCats.filter((c) => !feCats.includes(c));
ok('前端「文件管理」用途筛选与模型 enum 一一对应（不漏）', missingCats.length === 0, `缺：${missingCats.join(',')}`);

console.log('\n[3] 检查模块口径');
const cm = loaded['services/check-modules'];
if (cm) {
  const limits = cm.DEFAULT_MODULES.flatMap((m) => m.fields).filter((f) => f.type === 'students').map((f) => f.maxItems);
  ok('名单类字段上限统一为 FIELD_LIMIT', limits.length > 0 && limits.every((v) => v === cm.FIELD_LIMIT), JSON.stringify(limits));

  const derivedKeys = cm.DEFAULT_MODULES.flatMap((m) => m.fields.filter((f) => f.derived).map((f) => `${m.key}.${f.key}`));  // 第五轮口径：实到也改为 derived（选缺勤/未归名单自动推算，不让录入人填）；
  // 应到/应住仍由服务端从台账注入，缺勤/未归/得分/迟到数同样是 derived。
  ok(
    '应到/应住/实到/缺勤/未归/得分/迟到数 均标为 derived',
    [
      'morning_exercise.shouldCount',
      'morning_exercise.actualCount',
      'morning_exercise.absentCount',
      'study_evening.shouldCount',
      'study_evening.actualCount',
      'study_evening.absentCount',
      'night_dorm.shouldStay',
      'night_dorm.actualCount',
      'night_dorm.notReturnedCount',
      'hygiene.score',
      'morning_class.lateCount',
    ].every((k) => derivedKeys.includes(k)),
    JSON.stringify(derivedKeys)
  );

  // 伪造 derived 字段不应生效
  const mod = cm.DEFAULT_BY_KEY.get('morning_class');
  const d = cm.fillDerived(mod.key, cm.normalizeDetails(mod, { lateList: [{ name: 'a' }, { name: 'b' }], lateCount: 0 }));
  ok('早八迟到数 = 迟到名单人数', d.lateCount === 2, `got ${d.lateCount}`);
  ok('客户端伪造的 lateCount 被忽略', cm.normalizeDetails(mod, { lateList: [{ name: 'a' }], lateCount: 0 }).lateCount === undefined);

  // 早八「只记迟到人」的语义（用户 2026-10-19 口径）：没有记录 = 当天没人迟到，不是漏录
  ok('只有早八标记 optionalWhenMissing（没有记录 = 正常）', mod.optionalWhenMissing === true && mod.noRecordText === '无迟到', JSON.stringify({ o: mod.optionalWhenMissing, t: mod.noRecordText }));
  ok(
    '其它模块都不带该标记（未录仍是未录）',
    cm.DEFAULT_MODULES.filter((m) => m.key !== 'morning_class').every((m) => !m.optionalWhenMissing && !m.noRecordText)
  );
  const CheckModuleModel = req('models/check-module');
  ok('check_modules 有 optionalWhenMissing 字段（闭合 schema，漏了写不进去）', !!CheckModuleModel.schema.path('optionalWhenMissing'));
  ok('check_modules 有 noRecordText 字段', !!CheckModuleModel.schema.path('noRecordText'));
  // 版本迁移与幂等补齐都必须带上这两个字段：只 +1 版本号、不写字段 = 库里永远没有
  //（本轮真实踩坑：defVersion 先到 4，随后才加字段 → 早八一直按「未录」算）
  const seedSrc = require('fs').readFileSync(path.join(SERVER, 'services/check-modules.js'), 'utf8');
  const migSeg = seedSrc.slice(seedSrc.indexOf('if (curVersion < DEF_VERSION)'), seedSrc.indexOf('results.migrated += 1;'));
  const idleSeg = seedSrc.slice(seedSrc.indexOf('if (curVersion >= DEF_VERSION)'), seedSrc.indexOf('if (Object.keys(set).length)'));
  ok('版本迁移分支写入 optionalWhenMissing / noRecordText', migSeg.includes('set.optionalWhenMissing') && migSeg.includes('set.noRecordText'));
  ok(
    '幂等分支对「缺字段」也补齐（防「先升版本号、后加字段」永久丢失）',
    idleSeg.includes('exists.optionalWhenMissing === undefined') && idleSeg.includes('exists.noRecordText === undefined')
  );

  // 缺勤/未归（第五轮口径：实到不手填，选名单自动推算）
  const students = (n) => Array.from({ length: n }, (_, i) => ({ name: `s${i}` }));
  const ex = cm.DEFAULT_BY_KEY.get('morning_exercise');
  const de = cm.fillDerived(ex.key, cm.normalizeDetails(ex, { absentList: students(5) }), { shouldCount: 50 });
  ok('实到 = 应到 − 缺勤名单人数', de.actualCount === 45, `got ${de.actualCount}`);
  ok('缺勤 = 缺勤名单人数', de.absentCount === 5, `got ${de.absentCount}`);
  ok('客户端伪造的 actualCount 被丢弃（新表单不让手填）', cm.normalizeDetails(ex, { actualCount: 45 }).actualCount === undefined);
  ok('客户端伪造的 shouldCount 被丢弃（防刷分母）', cm.normalizeDetails(ex, { shouldCount: 9999 }).shouldCount === undefined);
  // 老记录：actualCount 是当年手填后落库的，读回时必须保留，不能重算成「全勤」
  const deOld = cm.fillDerived(ex.key, { actualCount: 45, absentList: [] }, { shouldCount: 50 });
  ok('老记录实到人数保留、缺勤按应到−实到回算', deOld.actualCount === 45 && deOld.absentCount === 5, JSON.stringify(deOld));
  // 拿不到台账时应退化为「缺勤名单人数」，**不能静默报 0**（否则真实缺勤被掩盖）
  const de2 = cm.fillDerived(ex.key, cm.normalizeDetails(ex, { absentList: students(2) }));
  ok('无应到时缺勤退化为名单人数（不静默报 0）', de2.absentCount === 2, `got ${de2.absentCount}`);

  const dorm = cm.DEFAULT_BY_KEY.get('night_dorm');
  const dd = cm.fillDerived(dorm.key, cm.normalizeDetails(dorm, { absentList: students(3) }), { shouldStay: 40 });
  ok('查宿：实到 = 应住 − 未归名单人数', dd.actualCount === 37, `got ${dd.actualCount}`);
  ok('未归 = 未归名单人数', dd.notReturnedCount === 3, `got ${dd.notReturnedCount}`);
  const ddOld = cm.fillDerived(dorm.key, { actualCount: 37, absentList: [] }, { shouldStay: 40 });
  ok('老查宿记录实到保留、未归按应住−实到回算', ddOld.actualCount === 37 && ddOld.notReturnedCount === 3, JSON.stringify(ddOld));

  // 卫生：评价 → 得分折算（公式引擎不支持字符串比较，故走 derived）
  const hy = cm.DEFAULT_BY_KEY.get('hygiene');
  for (const [grade, score] of [['优', 100], ['良', 80], ['差', 60]]) {
    const dh = cm.fillDerived(hy.key, cm.normalizeDetails(hy, { grade }));
    ok(`卫生 评价「${grade}」→ 得分 ${score}`, dh.score === score, `got ${dh.score}`);
  }
  ok('卫生评价不在预设内 → 得分 0（不给满分）', cm.fillDerived(hy.key, cm.normalizeDetails(hy, { grade: '乱填' })).score === 0);

  // 晚自习「网课」：后续字段清空且不校验必填（班内无学生、在宿舍观看）
  const se = cm.DEFAULT_BY_KEY.get('study_evening');
  const online = cm.fillDerived(se.key, cm.normalizeDetails(se, { grade: '网课' }), { shouldCount: 40 });
  ok(
    '网课：实到/缺勤/应到都清 0（不把 40 算成缺勤）',
    online.absentCount === 0 && online.shouldCount === 0 && online.actualCount === 0,
    JSON.stringify({ absent: online.absentCount, should: online.shouldCount, actual: online.actualCount })
  );
  let onlineOk = true;
  try {
    cm.normalizeDetails(se, { grade: '网课' });
  } catch (e) {
    onlineOk = false;
  }
  ok('网课：不因「实到人数必填」而被拦（否则永远录不进网课班）', onlineOk);
  ok('网课判定兼容数组与字符串', cm.isOnlineDormGrade(['网课']) && cm.isOnlineDormGrade('网课') && !cm.isOnlineDormGrade(['优']));

  // 五模块公式与扣分（回归基线，改口径必须同步改这里并说明原因）
  const base = {
    hygiene: { grade: '良' },
    study_evening: { grade: '优', absentList: students(15) },
    night_dorm: { absentList: students(3) },
    morning_exercise: { absentList: students(5) },
    morning_class: { lateList: students(4) },
  };
  const ctx = { shouldCount: 50, shouldStay: 40 };
  const expected = {
    hygiene: 20, // 良 → 80 分 → 缺 20 分扣 20
    study_evening: 30, // 35/50 = 70% → (1-0.7)*100 = 30
    night_dorm: 6, // 未归 3 人 × 2 分
    morning_exercise: 10, // 45/50 = 90% → (1-0.9)*100 = 10
    morning_class: 2, // 迟到 4 人 × 0.5 分
  };
  for (const m of cm.DEFAULT_MODULES) {
    const det = cm.fillDerived(m.key, cm.normalizeDetails(m, base[m.key]), ctx);
    const met = cm.computeMetrics(m, det);
    const deduct = cm.computeDeduct(m, det, met);
    ok(`${m.key} 扣分 = ${expected[m.key]}`, Math.abs(deduct - expected[m.key]) < 0.01, `got ${deduct}`);
  }

  // 分院：录入台列表页用 null 目标只做模块归属预检；真实目标仍按院系范围拦截。
  // 如果 null 也走院系判定，分院身份会被判成「目标班级没有归属院系」，录入台直接打不开。
  const branchIdentity = {
    isMember: true,
    level: 'branch',
    departmentIds: ['dept-in-scope'],
    schoolIds: ['school-in-scope'],
    schoolNames: ['北校区'],
    canEnterDeptKeys: ['study'],
    campusesMissingDepartments: [],
  };
  const moduleDef = { key: 'study_evening', name: '晚自习考勤', entryDeptKeys: ['study'] };
  ok('录入台预检（null 目标）不按院系拦截', unionSvc.canEnterModule(branchIdentity, moduleDef, null).ok);
  ok('真实目标超出分院范围仍拦截', !unionSvc.canEnterModule(branchIdentity, moduleDef, 'dept-out-of-scope').ok);

  // 复核：部门部长（本部门录入的记录）或主席团；分院部长还要在院系范围内
  const branchMinister = {
    isMember: true,
    level: 'branch',
    departmentIds: ['dept-1'],
    schoolIds: ['school-1'],
    schoolNames: ['北校区'],
    reviewLevel: '',
    roles: [{ role: 'minister', deptKey: 'life' }],
  };
  ok('部长可复核本部门录入的记录', unionSvc.canReview(branchMinister, 'dept-1', 'life'));
  ok('部长不能复核别的部门录入的记录', !unionSvc.canReview(branchMinister, 'dept-1', 'study'));
  ok('部长可复核本模块归属部门代录的记录', unionSvc.canReview(branchMinister, 'dept-1', 'presidium', ['life']));
  ok('分院部长不能复核外院系记录', !unionSvc.canReview(branchMinister, 'dept-2', 'life'));
  const schoolMinister = { ...branchMinister, level: 'school' };
  ok('校级部长可复核全校本部门记录', unionSvc.canReview(schoolMinister, 'dept-xyz', 'life'));
  ok('部长有复核入口（canReviewAny）', unionSvc.canReviewAny(branchMinister));
  ok('普通成员没有复核入口', !unionSvc.canReviewAny({ isMember: true, roles: [{ role: 'member', deptKey: 'life' }] }));
  const schoolPresidium = { isMember: true, level: 'school', reviewLevel: 'school', roles: [] };
  ok('校级主席团可复核任意记录', unionSvc.canReview(schoolPresidium, 'dept-xyz', 'any'));

  // ===== 复核 / 申诉处理权限（用户 2026-10-19 口径）=====
  // 「申诉、审核只能由主席团或负责相应部门的部长处理；院校部门仅处理院校部门的；
  //   全校主席团部门均能负责所有院校的申诉与审核。」
  {
    const hyg = cm.DEFAULT_BY_KEY.get('hygiene'); // entryDeptKeys: ['life']
    const hygKeys = hyg.entryDeptKeys || [];
    const asIdent = (records, campus = {}) =>
      unionSvc.buildIdentity(records, cm.DEFAULT_MODULES, { deptIds: campus.deptIds || [], counts: campus.counts || new Map() });
    const schoolPres = asIdent([{ level: 'school', deptKey: 'presidium', role: 'president' }]);
    const branchPresA = asIdent([{ level: 'branch', deptKey: 'presidium', role: 'president', schoolId: 'A' }], { deptIds: ['A1', 'A2'] });
    const schoolLife = asIdent([{ level: 'school', deptKey: 'life', role: 'minister' }]);
    const schoolStudy = asIdent([{ level: 'school', deptKey: 'study', role: 'minister' }]);
    const branchLifeA = asIdent([{ level: 'branch', deptKey: 'life', role: 'minister', schoolId: 'A' }], { deptIds: ['A1'] });
    const plain = asIdent([{ level: 'school', deptKey: 'life', role: 'member' }]);
    const teacher = asIdent([]);
    ok('校级主席团跨任意院校都可复核', unionSvc.canReview(schoolPres, 'A1', '', hygKeys) && unionSvc.canReview(schoolPres, 'B1', '', hygKeys));
    ok('分院主席团仅本院校可复核', unionSvc.canReview(branchPresA, 'A1', '', hygKeys) && !unionSvc.canReview(branchPresA, 'B1', '', hygKeys));
    ok('负责该模块的部长可复核', unionSvc.canReview(schoolLife, 'A1', '', hygKeys));
    ok('不负责该模块的部长不可复核', !unionSvc.canReview(schoolStudy, 'A1', '', hygKeys));
    ok('分院部长仅本院校可复核', unionSvc.canReview(branchLifeA, 'A1', '', hygKeys) && !unionSvc.canReview(branchLifeA, 'B1', '', hygKeys));
    ok('普通部员不可复核', !unionSvc.canReview(plain, 'A1', '', hygKeys));
    ok('非成员（教师）不可复核', !unionSvc.canReview(teacher, 'A1', '', hygKeys));
    // 申诉结案（PUT + settleAppeal）必须与 /appeal/review 同权限：只有评审者能结案
    // （此处单独读文件，避免依赖下面才声明的 unionRoutes）
    const unionSrcForPerm = require('fs').readFileSync(path.join(SERVER, 'routes/union.js'), 'utf8');
    const putStart = unionSrcForPerm.indexOf("router.put(\n  '/records/:id'");
    const putSrc = putStart < 0 ? '' : unionSrcForPerm.slice(putStart, unionSrcForPerm.indexOf('// 取消记录', putStart));
    ok('申诉结案要求评审者（不能自己批准自己的申诉）', /if \(body\.settleAppeal === true && !isReviewer\)/.test(putSrc));
    ok('settleAppeal 条件里再判一次 isReviewer（双重保险）', /body\.settleAppeal === true &&[\s\S]{0,160}isReviewer &&/.test(putSrc));
  }

  // 自审口径（用户 2026-10-19）：**主席团可以复核自己提交的记录，部长/副部长不行**。
  // 为什么放开主席团：主席团常亲自代录，禁止自审会让这类记录**没有人能复核**
  //（实测撞到：库里唯一有复核资格的人就是提交人本人，记录永远卡在待复核）。
  if (typeof unionSvc.canSelfReview !== 'function') {
    ok('union 服务导出 canSelfReview', false, 'missing export');
  } else {
    ok('union 服务导出 canSelfReview', true);
    ok('主席团可自审', unionSvc.canSelfReview({ isPresidium: true, members: [{ deptKey: 'presidium', role: 'president' }] }) === true);
    ok('部长不可自审', unionSvc.canSelfReview({ members: [{ deptKey: 'life', role: 'minister' }] }) === false);
    ok('副部长不可自审', unionSvc.canSelfReview({ members: [{ deptKey: 'life', role: 'vice_minister' }] }) === false);
    ok('空身份不可自审', unionSvc.canSelfReview(null) === false);
    // 详情出口与复核接口都必须按这个口径（旧实现详情页写死 `!isInspector &&`）
    const unionRouteSrc = require('fs').readFileSync(path.join(SERVER, 'routes/union.js'), 'utf8');
    ok('详情出口不再写死 !isInspector', !/canReview: !isInspector &&/.test(unionRouteSrc));
    ok('详情出口用 canSelfReview', /selfReviewOk = !isInspector \|\| unionSvc\.canSelfReview\(identity\)/.test(unionRouteSrc));
    ok('复核接口的自审拦截只对非主席团生效', /!unionSvc\.canSelfReview\(identity\)/.test(unionRouteSrc));
    ok('详情出口下发 selfReviewBlocked（页面据此说明原因）', /selfReviewBlocked:/.test(unionRouteSrc));
  }

  // 成员管理范围：校主席团全校；分院主席团本院；部长本部门
  const schoolMembers = { isMember: true, isPresidium: true, level: 'school', schoolIds: [], schoolNames: [], roles: [] };
  const branchMembers = {
    isMember: true,
    isPresidium: true,
    level: 'branch',
    schoolIds: ['school-1'],
    schoolNames: ['北校区'],
    roles: [],
  };
  const memberOf = (level, schoolId, schoolName, deptKey) => ({
    level,
    schoolId,
    schoolName,
    deptKey,
    departmentId: null,
    departmentName: '',
  });
  ok('校主席团可管理学院全部成员', unionSvc.canManageMembers(schoolMembers));
  ok('校主席团可管理分院成员', unionSvc.memberInManageScope(schoolMembers, memberOf('branch', 'school-2', '洋河校区', 'life')));
  ok('分院主席团只能管理本院成员', unionSvc.memberInManageScope(branchMembers, memberOf('branch', 'school-1', '北校区', 'life')));
  ok('分院主席团不能管理外院成员', !unionSvc.memberInManageScope(branchMembers, memberOf('branch', 'school-2', '洋河校区', 'life')));
  ok('分院主席团不能管理校级成员', !unionSvc.memberInManageScope(branchMembers, memberOf('school', '', '', 'presidium')));
  ok('部长可管理本部门成员', unionSvc.memberInManageScope(branchMinister, memberOf('branch', 'school-1', '北校区', 'life')));
  ok('部长不能管理别部门成员', !unionSvc.memberInManageScope(branchMinister, memberOf('branch', 'school-1', '北校区', 'study')));
  ok('普通成员没有成员管理入口', !unionSvc.canManageMembers({ isMember: true, roles: [{ role: 'member', deptKey: 'life' }] }));

  // 班级人数：应到 = 学籍人数、应住 = 住宿名单人数，均可实时推导
  const classCounts = req('services/class-counts');
  ok('班级人数服务导出 liveCount / liveCounts', typeof classCounts.liveCount === 'function' && typeof classCounts.liveCounts === 'function');
  ok('人数服务不暴露写入口（只读推导）', !Object.keys(classCounts).some((k) => /set|update|save/i.test(k)));
  // 班级状态：正常 / 实习 / 毕业（缺省 = 正常）
  const ClassProfileModel = req('models/class-profile');
  ok('班级状态有正常/实习/毕业三种', ClassProfileModel.STATUS_TEXT.normal === '正常' && ClassProfileModel.STATUS_TEXT.intern === '实习' && ClassProfileModel.STATUS_TEXT.graduated === '毕业');
  ok('缺省与非法状态按正常处理', ClassProfileModel.normalizeStatus(undefined) === 'normal' && ClassProfileModel.normalizeStatus('xxx') === 'normal');
  ok('只有正常班参加班超', ClassProfileModel.joinsBandChao({ status: 'normal' }) && ClassProfileModel.joinsBandChao({}) );
  ok('实习班不参加班超', !ClassProfileModel.joinsBandChao({ status: 'intern' }));
  ok('毕业班不参加班超', !ClassProfileModel.joinsBandChao({ status: 'graduated' }));

  // 批量编辑接口：状态与三个跑操标记共用同一入口
  const cpSrc = require('fs').readFileSync(path.join(SERVER, 'routes/admin/class-profile.js'), 'utf8');
  ok('批量编辑支持三个跑操标记', /FLAG_FIELDS\s*=\s*\[[^\]]*hasMorningExercise[^\]]*hasMorningClass[^\]]*hasMorningRun/.test(cpSrc));
  ok('批量接口同时接受 status 与 field', /const status = str\(body\.status/.test(cpSrc) && /const field = str\(body\.field/.test(cpSrc));
  ok('批量接口拒绝非法标记字段', /批量标记只支持早操 \/ 早八 \/ 参跑三项/.test(cpSrc));
  ok('批量接口支持按年级整批改', /body\.grade/.test(cpSrc));
  ok('台账列表按年级倒序（近年优先）', /近年优先/.test(cpSrc) && /gb\.localeCompare\(ga\)/.test(cpSrc));
  ok('异常年级不霸占近年优先头部', /validGrade/.test(cpSrc));

  // 学年 ↔ 届次：2026学年 = 第24届（锚点），往前每学年减 1
  const term2026 = unionSvc.termOf(2026);
  const term2025 = unionSvc.termOf(2025);
  const term2024 = unionSvc.termOf(2024);
  ok('2026学年 = 第24届', term2026.session === 24 && term2026.sessionName === '第24届');
  ok('2025学年 = 第23届', term2025.session === 23 && term2025.sessionName === '第23届');
  ok('2024学年 = 第22届', term2024.session === 22 && term2024.sessionName === '第22届');
  ok('学年标签同时含学年与届次', term2026.termLabel === '2026学年 · 第24届', term2026.termLabel);
  const termsNow = unionSvc.academicTerms();
  ok('当前学年返回届次口径', termsNow.currentLabel === `${termsNow.currentStart}学年 · 第${termsNow.currentSession}届`);
  ok('可选学年逐级对应届次（连续递减 1）', termsNow.list.every((t, i, arr) => i === 0 || arr[i - 1].session - t.session === 1));

  // 人数只读：源码里不应出现任何对 users / dorm_assignments 的写操作
  const countsSrc = require('fs').readFileSync(path.join(SERVER, 'services/class-counts.js'), 'utf8');
  ok(
    '人数服务只做聚合查询，不写任何集合',
    !/\.(updateOne|updateMany|bulkWrite|insertOne|insertMany|deleteOne|deleteMany|save)\s*\(/.test(countsSrc)
  );
}

console.log('\n[4] 班级域写接口白名单');
const classRoutes = require('fs').readFileSync(path.join(SERVER, 'routes/class.js'), 'utf8');
ok('班级域有 GET /profile', /router\.get\(\s*'\s*\/profile'/.test(classRoutes) || classRoutes.includes("'/profile'"));
ok('班级域有 PUT /profile', classRoutes.includes("router.put(") && classRoutes.includes("'/profile'"));
ok('班级配置可改字段为白名单', classRoutes.includes('PROFILE_FIELDS'));
ok('班级域写接口仅班主任（isHomeroom 判定）', classRoutes.includes('只有班主任可以修改班级配置'));
ok('班级配置改动后清排名缓存', classRoutes.includes('clearRankCache'));
// 只匹配真实调用/引用（去掉注释行再判断）——文件头与实现里都会**提到** requirePermission，
// 直接 includes 会把说明文字当成违规（第一版就误报了）
const classRoutesNoComment = classRoutes
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');
ok(
  '班级域未使用 requirePermission（保持成员资格校验模型）',
  !classRoutesNoComment.includes('requirePermission(') && !classRoutesNoComment.includes("middlewares/admin")
);

// ===== 楼名 / 宿舍：参考数据「读」与「维护」必须分成两条路径（用户 2026-10-22）=====
// 报障：「班主任可以给本班学生设置宿舍，为什么教师权限组无法获取楼名」。
// 根因：楼名只有 GET /api/admin/config/buildings 一条读路径，挂在 building.view 下（宿管维护权限）。
// 守住三条，别再合回去：
{
  const dormSvc = require('fs').readFileSync(path.join(SERVER, 'services/student-dorm.js'), 'utf8');
  ok('楼名清单由 service 统一取（configuredBuildings）', /function configuredBuildings/.test(dormSvc));
  ok('宿舍面板自带楼名（配置 ∪ 历史）', /configuredDormBuildings|cfgBuildings/.test(dormSvc) && /buildings/.test(dormSvc));
  ok('班级域有只读楼名接口', classRoutes.includes("'/buildings'"));
  ok('班级域的楼名接口不挂 requirePermission', classRoutesNoComment.includes("'/buildings'"));
  // 前端不允许再为了填表去读「管理端配置接口」（只有楼名管理页与 config/* 子页可以）
  const miniRoot = path.join(__dirname, '..', 'miniprogram');
  const offenders = [];
  (function walk(dir) {
    for (const e of require('fs').readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'miniprogram_npm' || e.name === 'node_modules') continue;
        walk(p);
      } else if (e.name.endsWith('.js')) {
        const rel = path.relative(miniRoot, p).replace(/\\/g, '/');
        // 允许：楼名管理页本身、config/* 配置子页、nav-groups(只是 URL 字符串)、注释
        if (rel.startsWith('packageAdmin/config/')) continue;
        if (rel === 'utils/nav-groups.js') continue;
        const src = require('fs').readFileSync(p, 'utf8')
          .split('\n')
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
          .join('\n');
        if (/\/api\/admin\/config\/buildings/.test(src)) offenders.push(rel);
      }
    }
  })(miniRoot);
  ok(
    '业务页不为「填表选楼」读管理端配置接口（应走 /api/class/buildings 或随宿舍面板下发）',
    offenders.length === 0,
    offenders.join(', ')
  );
  // 班级域的宿舍写接口必须复用 service，不能自己写一套（人数回填 / 换房留痕容易漏）
  ok('班级域宿舍写接口复用 studentDorm', /studentDorm\.assignDorm\(/.test(classRoutes) && /studentDorm\.checkoutDorm\(/.test(classRoutes));
  ok(
    '管理端宿舍写接口复用同一份 service',
    /studentDorm\.assignDorm\(/.test(require('fs').readFileSync(path.join(SERVER, 'routes/admin/users.js'), 'utf8'))
  );
}

// ===== 班主任 / 班委 对「本班检查记录」的可见性与申诉权（用户 2026-10-19 口径）=====
// 报障：「班主任与班委都可以查看本班，并且提出复议」。
// 旧实现在记录详情/列表开头无条件 assertMember → 非学生会成员（班主任、班委）
// 还没走到 sameClass / isHomeroom 的放行就被「你还不是学生会成员」拦掉，那两行永远执行不到。
{
  const unionRouteSrc = require('fs').readFileSync(path.join(SERVER, 'routes/union.js'), 'utf8');
  const seg = (from, to) => {
    const a = unionRouteSrc.indexOf(from);
    return a < 0 ? '' : unionRouteSrc.slice(a, unionRouteSrc.indexOf(to, a));
  };
  const detailSeg = seg("router.get(\n  '/records/:id'", '// 班级检查全景');
  const listSeg = seg("router.get(\n  '/records',", '// 记录详情');
  ok('记录详情不再无条件 assertMember（班主任/班委可看本班）', !!detailSeg && !/assertMember\(identity\)/.test(detailSeg));
  ok(
    // 用户 2026-10-21 新增学生会总管放行（总管不是成员也没有班级，原来四条放行全不匹配 → 「无法查看」）
    '详情放行条件含 本班学生/班委 + 班主任 + 检查人 + 学生会总管',
    /if \(!inScope && !sameClass && !isHomeroom && !isInspector && !isStewardViewer\)/.test(detailSeg)
  );
  ok('总管可查看记录（列表全校 / 详情放行）', /await isRecordSteward\(req, identity\)/.test(detailSeg || '') || /isRecordSteward/.test(require('fs').readFileSync(path.join(SERVER, 'routes/union.js'), 'utf8')));
  ok('非成员不会因 level 被误判为在范围内', /!!identity\.isMember &&/.test(detailSeg));
  ok('记录列表不再无条件 assertMember', !!listSeg && !/assertMember\(identity\)/.test(listSeg));
  ok('非成员的列表范围按 className $in 收敛', /className: \{ \$in: classes \}/.test(listSeg));
  // 申诉接口曾引用未声明的 identity → 申诉已存库却抛 ReferenceError
  const appealSeg = seg("'/records/:id/appeal',", "'/records/:id/appeal/review'");
  const appealCode = appealSeg
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  ok('申诉接口不再裸引用未声明的 identity', /identity: null/.test(appealCode));
  ok('申诉人仍限定为本班班委/班主任', /只能由本班班委或班主任对本班记录发起申诉/.test(appealCode));
}

console.log('\n[5] 管理端与登录出口');
const authRoutes = require('fs').readFileSync(path.join(SERVER, 'routes/auth.js'), 'utf8');
ok('/api/auth/me 下发 isUnionMember', authRoutes.includes('decorateUser'));
ok('/me 仍走 toSafeJSON（不下发凭据哈希）', authRoutes.includes('toSafeJSON'));
const permModel = require('fs').readFileSync(path.join(SERVER, 'models/permission.js'), 'utf8');
ok('权限目录含 union.view', permModel.includes("'union.view'"));
ok('权限目录含 union.manage', permModel.includes("'union.manage'"));

// ===== 内置权限组可编辑（用户 2026-10-20 修订，旧规则是「只读、每次启动覆盖」）=====
{
  const pgModelSrc = require('fs').readFileSync(path.join(SERVER, 'models/permission-group.js'), 'utf8');
  const pgRouteSrc = require('fs').readFileSync(path.join(SERVER, 'routes/admin/permission-groups.js'), 'utf8');
  const rbacSrc = require('fs').readFileSync(path.join(SERVER, 'services/rbac.js'), 'utf8');
  ok('权限组模型有 customized 字段', !!pgModelSrc.includes('customized: { type: Boolean'));
  // 关键：放开编辑必须配套改播种，否则改动在下次重启被静默抹掉（假生效，比不能改更糟）
  ok('播种跳过已改过的内置组', /exists\.customized\) continue/.test(rbacSrc));
  ok('播种仍会先查现有组（不是无脑 $set）', /PermissionGroup\.findOne\(\{ key: g\.key \}\)/.test(rbacSrc));
  // 只查 PUT 的旧拒绝文案（不能按 builtIn 前缀匹配 —— DELETE 里那句「内置权限组不可删除」是合法守卫）
  ok('PUT 不再按 builtIn 拒绝编辑', !/内置权限组由系统播种维护，不能修改/.test(pgRouteSrc));
  ok('superadmin 恒只读（唯一持 * ，改坏等于锁死自己）', /doc\.key === 'superadmin'\) throw new ApiError/.test(pgRouteSrc));
  ok('保存内置组时打 customized 标记', /if \(doc\.builtIn\) doc\.customized = true/.test(pgRouteSrc));
  ok('内置组仍不可删除', /if \(doc\.builtIn\) throw new ApiError\(400, 400, '内置权限组不可删除'\)/.test(pgRouteSrc));
  // 前端同步：编辑按钮不再按 builtIn 隐藏，但 superadmin 仍锁
  const groupsWxml = require('fs').readFileSync(
    path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'permissions', 'groups.wxml'),
    'utf8'
  );
  ok('前端编辑按钮只锁 superadmin', /wx:if="\{\{item\.key !== 'superadmin'\}\}"[^>]*bind:tap="openEdit"/.test(groupsWxml));
  ok('前端展示「已自定义」标记（否则管理员会误以为是系统默认）', /已自定义/.test(groupsWxml));
  ok('删除按钮仍对内置组隐藏', /wx:if="\{\{!item\.builtIn\}\}"[^>]*bind:tap="remove"/.test(groupsWxml));
}
// 学生会总管（用户 2026-10-20 要求）：一个权限覆盖学生会全部事务，且**不要求本人是成员**
ok('权限目录含 union.steward（学生会总管）', permModel.includes("'union.steward'"));
const PermModel = require(path.join(SERVER, 'models/permission'));
ok('union.steward 蕴含 union.view + union.manage', JSON.stringify(PermModel.PERM_IMPLIES['union.steward']) === JSON.stringify(['union.view', 'union.manage']));
ok('蕴含展开只升不降', PermModel.expandImplies(['union.view']).join(',') === 'union.view');
ok('蕴含展开对 steward 生效', ['union.view', 'union.manage'].every((p) => PermModel.expandImplies(['union.steward']).includes(p)));
const userSrc = require('fs').readFileSync(path.join(SERVER, 'models/user.js'), 'utf8');
ok('有效权限在唯一出口做蕴含展开（三条链路自动一致）', userSrc.includes('Permission.expandImplies'));
const unionStewardSrc = require('fs').readFileSync(path.join(SERVER, 'routes/union.js'), 'utf8');
ok('用户端成员管理允许总管（非成员）', /const steward = await assertMemberManager\(req, identity\)/.test(unionStewardSrc));
ok('总管放行范围＝全校', /return isStewardScope \|\| unionSvc\.memberInManageScope/.test(unionStewardSrc));
ok('成员管理拒绝文案含总管', /只有主席团、部门部长或学生会总管可以调整成员/.test(unionStewardSrc));

// ===== 用户管理：班级状态 / 身份 / 批量操作（用户 2026-10-20）=====
{
  const adminUsers = require('fs').readFileSync(path.join(SERVER, 'routes/admin/users.js'), 'utf8');
  // 列表行必须带班级状态与学生会身份（否则管理员看不出这个班是实习/毕业）
  ok('列表附带班级状态与学生会身份', /attachClassAndUnion\(list\)/.test(adminUsers));
  ok('班级状态与宿舍/目标并发批量补（无 N+1）', /Promise\.all\(\[attachGoals\(list\), attachDorms\(list\), attachClassAndUnion\(list\)\]\)/.test(adminUsers));
  // 学生会关联必须双路：成员记录未绑微信时 openid 是空串，只按 openid 查会漏人
  ok('学生会身份按 openid 或 userId 双路关联', /\$or: \[\{ openid: \{ \$in: openids \} \}, \{ userId: \{ \$in: userIds \} \}\]/.test(adminUsers));
  // 班级状态筛选：'normal' 必须含老数据缺字段的情况，否则 44 个班在「正常」里凭空消失
  ok('班级状态筛选含老数据缺字段（normal 用 $nin）', /status: \{ \$nin: \['intern', 'graduated'\] \}/.test(adminUsers));
  ok('班级状态非法值直接 400', /班级状态只能为 normal\/intern\/graduated/.test(adminUsers));
  ok('身份筛选支持 officer/homeroom/union', /identity只能为|身份只能为 officer\/homeroom\/union/.test(adminUsers));
  // 批量：每个动作沿用单条接口的权限，不能给批量另设万能权限
  ok('批量动作各自声明权限', /const BATCH_ACTIONS = \{[\s\S]{0,600}perm: 'user\.manage'[\s\S]{0,600}perm: 'permission\.manage'/.test(adminUsers));
  ok('批量按动作校验权限（不是整体一个权限）', /if \(!perms\.includes\('\*'\) && !perms\.includes\(spec\.perm\)\)/.test(adminUsers));
  ok('批量有单次上限', /ids\.length > BATCH_MAX/.test(adminUsers));
  ok('批量逐条处理、单条失败不中断整批', /const done = \[\];[\s\S]{0,400}const failed = \[\];/.test(adminUsers));
  ok('批量结果如实回报成功/失败/未找到', /ok\(res, \{ action, label: spec\.label, done, failed, missing/.test(adminUsers));
  // 单条 / 批量 / 班级域（班主任管本班学生）三方必须共用同一实现
  // （否则会出现「单条会恢复 initialHashes、批量不会」「管理端吊销设备令牌、班级域不吊销」的分裂）。
  // 实现自 2026-10-22 起收敛在 services/user-account-admin.js，路由只做鉴权与取参。
  const accountAdminSvc = require('fs').readFileSync(path.join(SERVER, 'services/user-account-admin.js'), 'utf8');
  ok('删除级联只有一份实现', (accountAdminSvc.match(/RunRecord\.deleteMany/g) || []).length === 1);
  ok('重置密码只有一份实现', (accountAdminSvc.match(/user\.mustChangePassword = true/g) || []).length === 1);
  ok('路由不再自己实现删除级联', !/async function deleteUserCascade/.test(adminUsers) && !/RunRecord\.deleteMany/.test(adminUsers));
  ok('批量复用 deleteUserCascade', /await accountAdmin\.deleteUserCascade\(user\)/.test(adminUsers));
  ok('批量复用 resetUserPassword', /await accountAdmin\.resetUserPassword\(user\)/.test(adminUsers));
  // 班级域（班主任）也必须复用同一份实现，而不是另写一套
  const classRouteSrc = require('fs').readFileSync(path.join(SERVER, 'routes/class.js'), 'utf8');
  ok(
    '班级域复用同一份密码变更实现',
    /accountAdmin\.changeUserPassword\(/.test(classRouteSrc) || /accountAdmin\.resetUserPassword\(/.test(classRouteSrc)
  );
  ok('班级域复用同一份删除实现', /accountAdmin\.deleteUserCascade\(/.test(classRouteSrc));
  ok('班级域复用同一份限制实现', /accountAdmin\.banUser\(/.test(classRouteSrc) && /accountAdmin\.unbanUser\(/.test(classRouteSrc));
  ok('班级域复用同一份徽章发放实现', /manualBadges\.grantBadgeToUser\(/.test(classRouteSrc));
  // /filters 的计数必须与列表 total 同口径（下拉写 9、点进去 395 会被当成筛选坏了）
  ok('filters 下发班级状态与身份计数', /classStatuses:/.test(adminUsers) && /identities:/.test(adminUsers));
}

console.log('\n[6] 检查记录留痕（复核人 / 复核时间 / history 出口）');
const unionRoutes = require('fs').readFileSync(path.join(SERVER, 'routes/union.js'), 'utf8');
ok('复核写入 reviewedByName / reviewedAt', /record\.reviewedByName = /.test(unionRoutes) && /record\.reviewedAt = new Date\(\)/.test(unionRoutes));
// history 必须能在详情页读到：presentRecord 里要有 base.history，且只在 withDetails 分支
const presentSrc = unionRoutes.slice(unionRoutes.indexOf('function presentRecord'), unionRoutes.indexOf('function fingerprint'));
ok('presentRecord 下发 history（详情页留痕可读）', /base\.history = \(r\.history \|\| \[\]\)\.map/.test(presentSrc));
ok(
  'history 只在 withDetails 分支（列表出口不带留痕，保持分页轻量）',
  presentSrc.indexOf('base.history') > presentSrc.indexOf('if (withDetails)')
);
ok('复核 / 取消 / 申诉改判都会 push history', (unionRoutes.match(/record\.history = \[/g) || []).length >= 3);

// 申诉成立必须**真的改判记录**（用户 2026-10-19：「申诉成功后应该更改记录啊」）：
// 但**不能**用「扣分清零 / 记满分」来代替改判 —— 用户明确否掉：
// 「不对啊记录作废不就是没有了吗，也不应该直接是满分。」
// 正确模型：申诉成立 → 更正记录内容（PUT + settleAppeal）按新数据重算；或作废退出统计。
{
  const a = unionRoutes.indexOf("'/records/:id/appeal/review'");
  const appealSeg = a < 0 ? '' : unionRoutes.slice(a, unionRoutes.indexOf('module.exports = router;', a));
  const p = unionRoutes.indexOf("router.put(\n  '/records/:id'");
  const putSeg = p < 0 ? '' : unionRoutes.slice(p, unionRoutes.indexOf('// 取消记录', p));
  ok('申诉处理有「作废」分支（void）', /if \(voidIt\) \{/.test(appealSeg));
  ok('没有「扣分清零」路径（不用清零代替改判）', !/record\.deduct = 0;/.test(unionRoutes));
  ok('没有「记满分」路径', !/record\.score = full/.test(unionRoutes));
  ok('既不改数据也不作废 → 400 拒绝', /申诉成立需要更正记录内容（或选择作废），不能只改状态/.test(appealSeg));
  ok('PUT 支持 settleAppeal（更正并结案）', /body\.settleAppeal === true/.test(putSeg));
  ok('结案后直接落「已复核」', /record\.status = settleAppeal \? 'approved' : 'submitted';/.test(putSeg));
  ok('留痕记扣分 / 得分的 from→to', /changes\.deduct = \{ from: prevDeduct/.test(putSeg) && /changes\.score = \{ from: prevScore/.test(putSeg));
  ok('留痕记申诉状态与处理意见', /changes\['appeal\.status'\]/.test(putSeg) && /changes\['appeal\.result'\]/.test(putSeg));
}
// 模板串插值被损坏成「??{」会把源码片段显示给用户（申诉改判那次就踩过）
const brokenTemplate = unionRoutes.split('\n').filter((l) => l.includes('??{') && !/^\s*(\/\/|\*)/.test(l));
ok('没有「??{」损坏的模板串（"${" 被写坏会显示源码片段）', brokenTemplate.length === 0, brokenTemplate.join(' | '));

// ===== 同名账号登录消歧（用户 2026-10-20「学生与教师账号重名」）=====
{
  const authRoutes = require('fs').readFileSync(path.join(SERVER, 'routes/auth.js'), 'utf8');
  const loginPage = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'auth-login', 'auth-login.js'), 'utf8');
  const bindSeg = (authRoutes.match(/router\.post\(\s*'\/bind'[\s\S]*?\n\);/) || [''])[0];
  ok('/bind 接收 studentId 收窄候选', /studentId/.test(bindSeg) && /all\.filter\(\(u\) => String\(u\.studentId/.test(bindSeg));
  ok('歧义时要求补学号（400902）而非盲选', /NEED_STUDENT_ID = 400902/.test(authRoutes) && /matched\.length > 1\)/.test(bindSeg));
  // 关键回归：旧实现 matched[0] 会静默登进别人的身份
  ok('绝不 matched[0] 盲选（先判 matched.length>1）', !/const user = matched\[0\];[\s\S]{0,80}matched\.length > 1/.test(bindSeg));
  // 关键回归：旧实现给所有同名候选 +1，学生会把同名教师一起锁掉
  ok('失败计数只在非歧义时进行', /if \(!ambiguous\) \{[\s\S]*?u\.failedLogins = \(u\.failedLogins \|\| 0\) \+ 1/.test(bindSeg));
  // 关键回归：旧实现先查 lockUntil 就 429，学生被锁会连累同名教师登录不了
  ok('锁定判断在密码匹配之后（不连累同名）', /const unlocked = candidates\.filter[\s\S]*?const matched = unlocked\.filter/.test(bindSeg));
  // 前端串号防线：微信已绑定别的账号时，姓名对不上必须显式问，绝不静默 afterLogin。
  // 2026-10-22 起从 showModal 改成 showActionSheet：需要**三个**选择
  // （用输入的账号登 / 继续进入已绑账号 / 返回），showModal 只有两个按钮，
  // 于是「同一微信从教师 A 切到教师 B」是死胡同（用户截图）。
  ok('登录页有串号防线（姓名不符时显式询问）', /typed !== boundName/.test(loginPage) && /wx\.showActionSheet/.test(loginPage));
  ok('登录页可以「用输入的账号登录」（教师可换绑）', /loginAsTyped/.test(loginPage) && /auth\.bindAccount\(/.test(loginPage));
  ok('取消时回滚登录态（防停留登录页却已登录）', /auth\.clearAuth\(\)/.test(loginPage));
  ok('登录页支持补学号（400902 分支）', /e\.code === 400902/.test(loginPage) && /needStudentId/.test(loginPage));
}

// ===== 批量转移：目标值必须存在于组织架构（用户 2026-10-21「组织架构只能有有权限的更改」）=====
{
  const batchSrc = require('fs').readFileSync(path.join(SERVER, 'routes/admin/users.js'), 'utf8');
  const transferSeg = (batchSrc.match(/\} else if \(action === 'transfer'\) \{[\s\S]*?\n        \} else if/) || [''])[0];
  ok('转移不再无条件 String(x).trim() 落库', !/user\.schoolName = String\(school\)\.trim\(\)/.test(transferSeg), '仍可写入任意字符串');
  ok('转移走组织架构解析', /resolveTransferTarget\(orgSchools/.test(transferSeg));
  ok('批量前建一次组织索引', /orgSchools = await buildOrgIndex\(\)/.test(batchSrc));
  ok('新院校整批先校验一次（不让 500 人各失败一次）', /assertTransferSchool\(orgSchools, req\.body\.school\)/.test(batchSrc));
  // 关键：users 有 1535 人填了 schoolId/departmentId，只改名字会让 id 指向旧校区节点
  ok('转移同步回填 schoolId', /patch\.schoolId !== undefined\) user\.schoolId = patch\.schoolId/.test(transferSeg));
  ok('转移同步回填 departmentId', /patch\.departmentId !== undefined\) user\.departmentId = patch\.departmentId/.test(transferSeg));
  const resolver = (batchSrc.match(/function resolveTransferTarget\([\s\S]*?\n\}/) || [''])[0];
  ok('系部按「该生所属院校」判定（两校区同名系部不放行跨校区）', /scope\.departments\.get\(deptName\)/.test(resolver));
  ok('解析器接收原院校与原系部', /function resolveTransferTarget\(schools, body, currentSchoolName, currentDeptName\)/.test(batchSrc));
  ok('只转院校时重新解析 departmentId', /else if \(school && currentDeptName\)/.test(resolver));
  // 新校区无同名系部 → 清空而不是留一个指向别校的错 id，且必须把副作用报出来
  ok('无同名系部时清空 id（不留跨校错配）', /patch\.departmentId = null/.test(resolver));
  ok('清空系部要写进 transferNote 回报', /transferNote/.test(resolver) && /patch\.transferNote/.test(transferSeg));
  ok('年级校验 4 位年份', /!\/\^\\d\{4\}\$\/\.test\(g\)/.test(transferSeg));
}

// ===== 筛选选项的实时人数（用户 2026-10-21「括号中的人数要根据筛选实时计算才对」）=====
{
  const uSrc = require('fs').readFileSync(path.join(SERVER, 'routes/admin/users.js'), 'utf8');
  const listSeg = (uSrc.match(/router\.get\(\s*'\/',[\s\S]*?\n\);/) || [''])[0];
  ok('列表条件构造抽成共用函数', /async function buildUserMatch\(q, omit\)/.test(uSrc));
  ok('列表路由改用共用条件构造', /await buildUserMatch\(req\.query, null\)/.test(listSeg));
  ok('列表里不再重复写 keyword/identity 条件', !/cond\.\$or = \[\{ nickname: re \}/.test(listSeg), '列表内仍自带一份条件构造');
  // 计数随列表返回，且只在第一页要（翻页不重复算）
  ok('两条返回分支都带 facets', (listSeg.match(/facets: await facetsP/g) || []).length === 2, String((listSeg.match(/facets: await facetsP/g) || []).length));
  ok('withFacets 才计算（翻页不重算）', /String\(req\.query\.withFacets\) === '1' \? userFacets/.test(listSeg));
  // 每个维度排除自身，否则选了系部后其它系部全变 0、没法切走
  const facetsFn = (uSrc.match(/async function userFacets\(q\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('六个维度各自排除自身', ['school', 'department', 'specialty', 'grade', 'classStatus', 'identity'].every((d) => facetsFn.includes(`buildUserMatch(q, '${d}')`)), facetsFn.slice(0, 80));
  // 年级与身份都复用列表的同一表达式/条件构造函数（口径不一致 = 数字与结果对不上）
  ok('年级条件抽成共用表达式', /function gradeCondition\(g\)/.test(uSrc) && /and\.push\(gradeCondition\(/.test(uSrc));
  ok('年级计数用同一 gradeCondition', /gradeFacet[\s\S]*?gradeCondition\(g\)/.test(uSrc));
  ok('身份计数复用 identityCondition', /identityFacet[\s\S]*?identityCondition\('officer'\)/.test(uSrc));
  // 选了日/周目标时刻意不算（另写管道必漂移，且要扫 run_records）
  ok('达标筛选下整体不计数', /if \(pick\(q\.dailyAchieved\) \|\| pick\(q\.weeklyAchieved\)\) return null/.test(facetsFn));
}

// ===== 学生会部门去内置 + 职责可自助配置（用户 2026-10-21「这几个内置应该不需要内置」）=====
{
  const deptModel = require('fs').readFileSync(path.join(SERVER, 'models/union-department.js'), 'utf8');
  const unionSvcSrc = require('fs').readFileSync(path.join(SERVER, 'services/union.js'), 'utf8');
  const cmSrc2 = require('fs').readFileSync(path.join(SERVER, 'services/check-modules.js'), 'utf8');
  const auSrc = require('fs').readFileSync(path.join(SERVER, 'routes/admin/union.js'), 'utf8');
  const seedSeg = (unionSvcSrc.match(/async function seedUnionDepartments\(\) \{[\s\S]*?\n\}/) || [''])[0];

  // 只有主席团还是内置（它的 key 被 20 处代码当语义常量用于复核权限判定）
  const defaults = (deptModel.match(/DEFAULT_DEPARTMENTS = \[([\s\S]*?)\n\];/) || ['', ''])[1];
  const builtinKeys = [...defaults.matchAll(/key: '(\w+)'[^\n]*builtIn: true/g)].map((m) => m[1]);
  ok('仅主席团保持内置', builtinKeys.length === 1 && builtinKeys[0] === 'presidium', JSON.stringify(builtinKeys));
  ok('三个检查部门默认 builtIn=false', /key: 'life'[^\n]*builtIn: false/.test(defaults) && /key: 'study'[^\n]*builtIn: false/.test(defaults) && /key: 'discipline'[^\n]*builtIn: false/.test(defaults));
  // 播种：普通部门只在缺失时创建，存在即不动（否则改名/停用会被重启抹掉 = 假生效）
  ok('播种只为主席团回写默认值', /if \(def\.key !== PRESIDIUM_KEY\)/.test(seedSeg) && /\$set: \{ builtIn: true, scope: def\.scope, name: def\.name \}/.test(seedSeg));
  ok('播种不再回写 dutyModules', !/dutyModules: def\.dutyModules/.test(seedSeg), '仍在覆盖职责绑定');
  ok('存量 builtIn 一次性归位', /if \(exists\.builtIn\) \{[\s\S]*?\$set: \{ builtIn: false \}/.test(seedSeg));
  // 最关键：模块的鉴权真源不能被播种强制重置，否则学校配的部门重启即失效
  ok('entryDeptKeys 只在缺失时补，不强制回写', !/JSON\.stringify\(exists\.entryDeptKeys[\s\S]{0,80}!== JSON\.stringify\(def\.entryDeptKeys\)/.test(cmSrc2), '播种仍会抹掉学校的部门配置');
  ok('entryDeptKeys 缺失才补默认', /if \(!Array\.isArray\(exists\.entryDeptKeys\) \|\| !exists\.entryDeptKeys\.length\) \{[\s\S]{0,80}set\.entryDeptKeys = def\.entryDeptKeys/.test(cmSrc2));
  // 职责按真源反推（不再读那份会撒谎的手写镜像），且给中文模块名
  ok('部门列表按 entryDeptKeys 反推职责', /dutyByDept[\s\S]{0,120}entryDeptKeys/.test(auSrc) && /dutyNames: \(dutyByDept\.get\(d\.key\)/.test(auSrc));
  ok('不再读 union_departments.dutyModules', !/dutyModules: d\.dutyModules \|\| \[\]/.test(auSrc), '仍在读废弃字段');
  ok('主席团标记 noEntryByDesign（避免显示成配置缺失）', /noEntryByDesign: d\.key === unionSvc\.PRESIDIUM_KEY/.test(auSrc));
  ok('PUT 不再接收 dutyModules 写入', !/doc\.dutyModules = body\.dutyModules/.test(auSrc), '还在写没人用的第二份绑定');
  // 主席团仍锁；删除部门不得留下悬空绑定
  ok('主席团名称/范围仍锁定', /主席团的名称与归属范围固定/.test(auSrc));
  ok('主席团不可删除', /主席团不可删除/.test(auSrc));
  ok('删除前检查模块引用（防 entryDeptKeys 悬空）', /CheckModule\.find\(\{ entryDeptKeys: doc\.key \}\)/.test(auSrc));
  // 前端显示中文职责名 + 区分「按设计不参与录入」与「未配置」
  const cfgJs = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'union', 'config', 'config.js'), 'utf8');
  ok('前端用 dutyNames（中文）', /dutyText:[\s\S]{0,200}dutyNames/.test(cfgJs) && !/dutyModules \|\| \[\]\)\.join/.test(cfgJs));
  ok('前端区分不参与录入与未配置', /noEntryByDesign/.test(cfgJs) && /未配置/.test(cfgJs));
}

// ===== 部门按校区独立（用户 2026-10-21「所有部门都是一个、只是在不同校区显示，需要互不干扰」）=====
{
  const deptModel2 = require('fs').readFileSync(path.join(SERVER, 'models/union-department.js'), 'utf8');
  const auSrc2 = require('fs').readFileSync(path.join(SERVER, 'routes/admin/union.js'), 'utf8');
  const fitFn = (auSrc2.match(/function assertDeptFitsCampus\([\s\S]*?\n\}/) || [''])[0];

  ok('部门模型有 schoolId（归属校区）', /schoolId: \{ type: mongoose\.Schema\.Types\.ObjectId, ref: 'Organization'/.test(deptModel2));
  ok('POST 建部门接收并校验 schoolId', /const schoolId = str\(body\.schoolId, 32\)/.test(auSrc2) && /部门只能挂到组织架构的「院校」层/.test(auSrc2));
  ok('挂到校区时 scope 强制收敛 branch（防自相矛盾数据）', /scope: schoolDoc \? 'branch'/.test(auSrc2));
  ok('GET 返回 schoolId + schoolName（前端按校区分组）', /schoolId: d\.schoolId \? String\(d\.schoolId\) : ''/.test(auSrc2) && /schoolName: d\.schoolId \? schoolNameById/.test(auSrc2));

  // 归属校验：这是「互不干扰」的权威闸门，必须在服务端
  ok('有校区归属校验函数', fitFn.length > 0);
  ok('主席团豁免（全局概念，分会主席团也挂 presidium）', /dept\.key === unionSvc\.PRESIDIUM_KEY\) return/.test(fitFn));
  ok('分会成员只能用本校区的部门', /String\(dept\.schoolId\) !== want/.test(fitFn) && /不属于所选校区/.test(fitFn));
  ok('校级成员不能用分会专属部门', /level === 'school'\)[\s\S]{0,80}分会/.test(fitFn));
  // 用户 2026-10-21「全校仅有主席团没有其他部门了」：校级层只允许主席团，其余必须选具体校区
  ok('无 schoolId 的非主席团部门不能作为校级部门', /level === 'school'\) \{[\s\S]{0,120}不是学生会主席团，请选择具体院校/.test(fitFn));
  // 三个写入口都要拦：新建 / 批量 / 修改
  ok('新建成员时校验', /assertDeptFitsCampus\(dept, level, schoolId\)/.test(auSrc2));
  ok('批量加人时校验', (auSrc2.match(/assertDeptFitsCampus\(dept, level, schoolId\)/g) || []).length >= 2);
  // 修改成员：必须两者都改完再校验，否则用的是旧校区
  ok('改成员时在校区与部门都改完之后校验', /if \(deptTouched \|\| body\.schoolId !== undefined\) \{[\s\S]{0,160}assertDeptFitsCampus\(finalDept, doc\.level, doc\.schoolId\)/.test(auSrc2), '校验时点错，会用旧校区');
  // 改部门归属 + 有成员时禁止（避免成员校区归属静默错乱）
  ok('有在任成员时禁止改部门归属校区', /还有 \$\{usedBy\} 名在任成员，改归属校区/.test(auSrc2));
  // 删除：被模块引用时先要求改配置（防 entryDeptKeys 悬空 → 该模块没人能录）
  ok('删部门前检查模块引用', /CheckModule\.find\(\{ entryDeptKeys: doc\.key \}\)/.test(auSrc2));

  // 前端：配置页与成员页共用同一份归属判定（两页各写必然漂移）
  const deptUtil = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'utils', 'union-dept.js'), 'utf8');
  ok('抽出共享判定 utils/union-dept', /function deptFitsCampus/.test(deptUtil));
  const cfgPage = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'union', 'config', 'config.js'), 'utf8');
  const memPage = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'union', 'members', 'members.js'), 'utf8');
  ok('配置页用共享判定', /require\('\.\.\/\.\.\/\.\.\/utils\/union-dept'\)/.test(cfgPage) && /deptFitsCampus\(dept, root\.isAll/.test(cfgPage));
  ok('成员页用共享判定', /require\('\.\.\/\.\.\/\.\.\/utils\/union-dept'\)/.test(memPage) && /deptFitsCampus\(d, campusOfMember\)/.test(memPage));
  ok('成员页换校区时重算部门选项', /onAddCampus[\s\S]{0,400}buildAddDeptOptions/.test(memPage));
  ok('可选部门从原始全量重算（不被已过滤列表污染）', /this\._deptAll \|\| \[\]\)\.filter\(\(d\) => deptFitsCampus/.test(memPage));
  // 录入部门在抽屉内按层级分组勾选（不套第二层弹窗）
  ok('模块录入部门按层级分组', /moduleDeptGroups/.test(cfgPage) && !/buildModuleCascader/.test(cfgPage));
}


// ===== 班主任班级 TAB 能力（用户 2026-10-24「示例教师1 没有本班操作权限/班级TAB没配置」）=====
{
  const clsRoute = require('fs').readFileSync(path.join(SERVER, 'routes/class.js'), 'utf8');
  const usersRoute = require('fs').readFileSync(path.join(SERVER, 'routes/admin/users.js'), 'utf8');
  const rolesSvc = require('fs').readFileSync(path.join(SERVER, 'services/class-roles.js'), 'utf8');
  const detailJs = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'user-detail', 'user-detail.js'), 'utf8');
  const detailWxml = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'user-detail', 'user-detail.wxml'), 'utf8');

  // 单一实现：班委/班主任校验只在 services/class-roles.js 一份，两个入口都调它
  ok('class-roles 单一实现（学生校验）', /只有学生账号可以设为班委/.test(rolesSvc));
  ok('管理端 class-roles 复用 service', /classRoles\.setClassOfficer\(user, isClassOfficer\)/.test(usersRoute) && /classRoles\.setHomeroomClasses\(user, homeroomClasses\)/.test(usersRoute));
  ok('管理端不再内联班委校验', !/user\.isClassOfficer = !!isClassOfficer/.test(usersRoute));
  // 班级域班主任写入口 + 能力表
  ok('班级域班委开关写入口', /'\/student\/:userId\/officer'/.test(clsRoute) && /classRoles\.setClassOfficer\(target/.test(clsRoute));
  ok('班委能力进 homeroomCapabilities', /classOfficer: true/.test(clsRoute));
  ok('班委能力进 overview 能力表（仅班主任）', /classOfficer: isHomeroom/.test(clsRoute));
  // 前端：管理端读路径合并班级域能力表（根因修复）
  ok('管理端路径补拉 /manage 合并能力', /detail\.canManageStudent\) \{[\s\S]{0,600}\/manage\?className=/.test(detailJs));
  // （断言用字符串包含而不是正则：正则字面量里出现 `mergeCaps(` 的括号会被解析器吃掉）
  ok('caps 合并权限项与班级域能力', detailJs.includes('caps: mergeCaps(') && detailJs.includes('homeroomCaps'));
  ok('CAP_KEYS 含 classOfficer', /'classOfficer'/.test(detailJs));
  // 班级 TAB：班主任（caps.classOfficer）也渲染班委块；班主任班级仍只归管理员
  ok('班级TAB门控含 caps.classOfficer', /canManageClass \|\| caps\.classOfficer/.test(detailWxml));
  // 班委在用户详情页排宿舍（用户 2026-10-24：入口画得出来、一点却弹「只有班主任或管理员」）
  const detailSrc = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'user-detail', 'user-detail.js'), 'utf8');
  ok('宿舍守卫只认 caps.dorm', !/canDorm = this\.data\.canManageUser \|\| this\.data\.canManageStudent/.test(detailSrc) && (detailSrc.match(/if \(!this\.data\.caps\.dorm\)/g) || []).length >= 2);
  ok('宿舍面板数据源含 overview（班委）', /\(manage && manage\.dorm\) \|\| \(overview && overview\.dorm\)/.test(detailSrc));
  ok('班级域不重算 wechatBound', /this\.data\.classOnly\s*\?\s*this\.data\.dormWechatBound/.test(detailSrc));
  ok('「仅查看」标签按能力判断', !/classOnly && !canManageStudent/.test(require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'user-detail', 'user-detail.wxml'), 'utf8')));
  // 督促未达标对班委开放（用户 2026-10-24「班委需要能查看校园跑未达标的学生」）
  ok('capabilities.nudge 班委也放行', /nudge: !!role/.test(clsRoute));
  ok('canNudge 全部端点含班委', (clsRoute.match(/canNudge: scope\.isHomeroom \|\| scope\.isOfficer/g) || []).length >= 4 && !/canNudge: scope\.isHomeroom,/.test(clsRoute));
  ok('前端 canNudge 读 capabilities', /mine\.capabilities \? !!mine\.capabilities\.nudge/.test(require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'class', 'class.js'), 'utf8')));
  ok('班主任班级入口仍只归管理员', /ud-pick-row" wx:if="\{\{canManageClass\}\}" bind:tap="openClassSheet"/.test(detailWxml));
}

// ===== 学生会录入抽屉：拍照返回不得关掉抽屉（用户 2026-10-24「上传到 100% 时弹窗被关掉」）=====
{
  const entryJs = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageUnion', 'entry', 'entry.js'), 'utf8');
  const onShowBlock = (entryJs.match(/onShow\(\) \{[\s\S]{0,600}?\n  \},/) || [''])[0];
  ok('录入抽屉 onShow 不重置', /if \(this\.data\.showForm\) return;/.test(onShowBlock));
  ok('onShow 仍会刷新列表（关抽屉时）', /this\.load\(\);/.test(onShowBlock));
  // 关闭入口三层守卫：上传中拒绝、提交中拒绝、有草稿二次确认
  ok('上传中禁止关闭抽屉', /closeForm\(\)[\s\S]{0,700}照片上传中，传完再关闭/.test(entryJs));
  ok('提交中禁止关闭抽屉', /closeForm\(\)[\s\S]{0,900}正在提交，请稍候/.test(entryJs));
  ok('有未提交内容需二次确认', /hasDraft\(\)/.test(entryJs) && /放弃这次录入？/.test(entryJs));
  ok('程序化关闭走 doCloseForm', (entryJs.match(/doCloseForm\(\)/g) || []).length >= 4);
  ok('提交成功后直接关（不弹确认）', /this\.doCloseForm\(\);\s*\n\s*await this\.loadTargets\(\);/.test(entryJs));
}

// ===== 相册照片仍失败：检查照片也必须压缩 + 上限过小（用户 2026-10-26 第五轮）=====
{
  const entrySrc4 = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageUnion', 'entry', 'entry.js'), 'utf8');
  const routeUpSrc2 = require('fs').readFileSync(path.join(SERVER, 'routes/upload.js'), 'utf8');
  // 不写死带真实域名的文件名（AGENTS.md：被 git 跟踪的文件不许出现真实域名）。
  // 直接扫描 deploy/nginx/ 下的 *.conf —— 该目录不入库，测试只在开发者本机跑到。
  const nginxSrc = (() => {
    const dir = path.join(__dirname, '..', 'deploy', 'nginx');
    try {
      const f = require('fs').readdirSync(dir).find((n) => n.endsWith('.conf'));
      return f ? require('fs').readFileSync(path.join(dir, f), 'utf8') : '';
    } catch (e) {
      return '';
    }
  })();
  const envEx = require('fs').readFileSync(path.join(__dirname, '..', 'server', '.env.example'), 'utf8');

  // 根因：相册原图 6~12MB，而检查照片上限 5MB —— 拍照经微信压缩能过，相册不能
  ok('检查照片上传前压缩', /compressForUpload\(src\)/.test(entrySrc4) && /compressForUpload\(item\.path\)/.test(entrySrc4));
  ok('压缩用 wx.compressImage', /wx\.compressImage\(/.test(entrySrc4));
  ok('压缩后传给上传接口', /uploadCheckPhoto\(src,/.test(entrySrc4));
  ok('压缩失败退回原图/继续用当前文件', /fail: \(\) => resolve\(''\)/.test(entrySrc4));
  ok('检查照片上限 20MB（可配，照片要大要清晰）', /CHECK_PHOTO_MAX_MB = Number\(process\.env\.CHECK_PHOTO_MAX_MB \|\| 20\)/.test(routeUpSrc2));
  ok('.env.example 有 CHECK_PHOTO_MAX_MB（20）', /CHECK_PHOTO_MAX_MB=20/.test(envEx));
  // nginx 必须放得下（否则 Nginx 先回 413，Node 根本收不到）
  ok('nginx client_max_body_size 足够', (() => { const m = nginxSrc.match(/client_max_body_size\s+(\d+)m/); return !!m && Number(m[1]) >= 10; })());
// ===== 主席团可加任意部门 + 主席团不可加入 + 可选职务（用户 2026-10-28）=====
{
  const uSrc = require('fs').readFileSync(path.join(SERVER, 'routes/union.js'), 'utf8');
  const sjJs = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'union', 'scan-join', 'scan-join.js'), 'utf8');
  const sjWxml = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'union', 'scan-join', 'scan-join.wxml'), 'utf8');

  // ① 主席团可加载全部业务部门（旧实现读 /mine 的 roles，只能加自己部门）
  ok('扫码页改走 join-options 接口', /\/api\/union\/manage\/join-options/.test(sjJs));
  ok('join-options 路由存在', /'\/manage\/join-options'/.test(uSrc));
  ok('主席团标记 presidium 下发给前端', /presidium:\s*isPresidium/.test(uSrc));
  ok('主席团可加载全部业务部门', /const visible = isPresidium \? joinable/.test(uSrc));

  // ② 主席团不可作为可加入部门
  ok('主席团从可选部门中排除', /joinable = all\.filter\(\(d\) => d\.key !== unionSvc\.PRESIDIUM_KEY\)/.test(uSrc));
  ok('服务端拒绝加入主席团', /主席团不是可加入的部门/.test(uSrc));

  // ③ 职务：部员 / 副部长 / 部长，且不能高于自己
  ok('职务白名单三种', /\['member', 'vice_minister', 'minister'\]\.includes\(role\)/.test(uSrc));
  ok('写入 role 而非固定 member', /^\s+role,\s*$/m.test(uSrc) && !/role: 'member',\s*\n\s*status: 'active'/.test(uSrc));
  ok('不能授予高于自己的职务', /不能授予高于你自己的职务/.test(uSrc));
  ok('roleRank / maxRoleRank 存在', /function roleRank/.test(uSrc) && /function maxRoleRank/.test(uSrc));

  // ④ 部门可用性按 scope 判（旧规则「校级只允许主席团」与 11 个校级部门冲突）
  ok('部门可用性按 scope 判定', /const scope = String\(dept\.scope \|\| 'both'\)/.test(uSrc));
  // 去掉注释再判断（注释里故意记了旧报错文案，说明历史）
  ok('不再用「校级只允许主席团」的旧判据', !/不是学生会主席团，请选择具体院校/.test(require('fs').readFileSync(path.join(SERVER, 'routes/union.js'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));

  // ⑤ 前端职务选择 UI
  ok('前端有职务选择', /roleOptions/.test(sjJs) && /onRolePick/.test(sjJs));
  ok('WXML 渲染职务选项', /sj-role-opt/.test(sjWxml) && /roleOptions/.test(sjWxml));
  ok('提交时带上 role', /role: role \|\| 'member'/.test(sjJs));
}

// ===== 学生会控制台要有「扫码加人」入口（用户 2026-10-27）=====
{
  const unionRouteSrc = require('fs').readFileSync(path.join(SERVER, 'routes/union.js'), 'utf8');
  const unionJs = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'union', 'union.js'), 'utf8');
  const unionWxml = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'union', 'union.wxml'), 'utf8');

  // 服务端：/dashboard 必须下发 canScanJoin
  // ⚠️ 用「取 /dashboard 路由片段再断言」，而不是全文搜 —— /mine 里也有同形的 ok(res,{...})，
  //   第一次就把字段加到了 /mine 上（全文搜能过、实际不生效），排查了一轮。
  const dashSeg = (() => {
    const a = unionRouteSrc.indexOf("'/dashboard'");
    if (a < 0) return '';
    const b = unionRouteSrc.indexOf('ok(res, {', a);
    return b < 0 ? '' : unionRouteSrc.slice(b, b + 2000);
  })();
  ok('/dashboard 下发 canScanJoin', /canScanJoin:\s*unionSvc\.canManageMembers/.test(dashSeg));
  ok('canScanJoin 与 canManageMembers 同口径', /canScanJoin:\s*unionSvc\.canManageMembers\(identity\)/.test(dashSeg));
  // 反向断言：/mine 里不该有这个字段（说明没改错位置）
  const mineSeg = (() => {
    const a = unionRouteSrc.indexOf("'/mine'");
    if (a < 0) return '';
    const b = unionRouteSrc.indexOf('ok(res, {', a);
    return b < 0 ? '' : unionRouteSrc.slice(b, b + 1200);
  })();
  ok('/mine 里没有误加 canScanJoin', !/canScanJoin/.test(mineSeg));

  // 前端：快捷入口 + 跳转 + 权限门
  ok('学生会页有扫码加人入口', /wx:if="\{\{canUnionScanJoin\}\}"[\s\S]{0,120}goScanJoin/.test(unionWxml));
  ok('入口文案为「扫码加人」', /扫码加人/.test(unionWxml));
  ok('canUnionScanJoin 来自 dashboard.canScanJoin', /canUnionScanJoin:\s*!!data\.canScanJoin/.test(unionJs));
  ok('goScanJoin 指向扫码页', /goScanJoin\(\)[\s\S]{0,160}packageAdmin\/union\/scan-join/.test(unionJs));
}

// ===== GPS 记录必须换算步数与卡路里（用户 2026-10-27「没有步数的换算」）=====
{
  const stepsSrc4 = require('fs').readFileSync(path.join(SERVER, 'services/steps.js'), 'utf8');
  const runRoute = require('fs').readFileSync(path.join(SERVER, 'routes/run.js'), 'utf8');
  const wxSrc = require('fs').readFileSync(path.join(SERVER, 'services/wechat.js'), 'utf8');

  // 根因：GPS 写入固定 steps:0，而小程序提交 GPS 时不传步数 → 详情页永远 0 步
  ok('GPS 记录按距离换算步数', /stepsFromDist = Math\.round\(distMeters \/ 0\.7\)/.test(stepsSrc4));
  ok('GPS 不再固定写 steps: 0', !/steps: 0,\s*\n\s*distance: Math\.round\(distance/.test(stepsSrc4));
  ok('卡路里按步数折算', /Math\.round\(finalSteps \* 0\.04\)/.test(stepsSrc4));
  // 换算口径必须与微信同步一致（否则同一段路程两种算法，数据不可比）
  ok('与 estimateFromSteps 同口径（0.7 米/步、0.04 千卡/步）', /steps \* 0\.7/.test(wxSrc) && /steps \* 0\.04/.test(wxSrc));
  // 客户端若传了真实步数/卡路里，优先用它（手环计数优于估算）
  ok('客户端步数优先', /clientSteps > 0 \? clientSteps : stepsFromDist/.test(stepsSrc4));
  ok('客户端卡路里优先', /Number\(calories\) > 0 \? Math\.round\(Number\(calories\)\)/.test(stepsSrc4));
  // 路由要把 steps 透传给服务层
  ok('路由透传 steps', /const \{ date, distance, durationSeconds, calories, steps,/.test(runRoute) && /calories,\s*\n\s*steps,/.test(runRoute));
  // 回填脚本存在（历史数据修复）
  ok('提供 GPS 步数回填脚本', require('fs').existsSync(path.join(__dirname, 'backfill-gps-steps.js')));
}

// ===== nginx upstream 端口必须跟随实际 PORT（用户 2026-10-27 整站 502）=====
{
  const shSrc3 = require('fs').readFileSync(path.join(__dirname, '..', 'deploy', 'install.sh'), 'utf8');
  ok('nginx upstream 端口跟随 .env PORT', /fix_nginx_upstream_port\(\) \{/.test(shSrc3));
  // 必须在 resolve_port 之后调用（$PORT 才是真实值）
  const iResolve = shSrc3.indexOf('PORT="$(resolve_port)"');
  const iFix = shSrc3.indexOf('fix_nginx_upstream_port "$PORT"');
  ok('在 resolve_port 之后同步 upstream', iResolve > 0 && iFix > iResolve, `resolve=${iResolve} fix=${iFix}`);
  // 用正则匹配任意端口，而不是只认 3010（只认 3010 就又写死了）
  ok('upstream 端口按正则替换（不写死）', /127\\\.0\\\.0\\\.1:\[0-9\]\+/.test(shSrc3));
  ok('端口已正确时跳过修改', /nginx upstream 端口已正确/.test(shSrc3));
  // install.sh 的 if/fi 必须配对（历史上漏 fi 会让脚本直接报语法错）
  ok('install.sh if/fi 配对', (() => { let d = 0; for (const line of shSrc3.split('\n')) { const t = line.trim(); if (/^if\s/.test(t)) d++; else if (/^fi$|^fi;/.test(t)) d--; } return d === 0; })());
}

// ===== 列表空但徽章有数（用户 2026-10-27）=====
{
  const anoJs3 = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'config', 'anomalies', 'anomalies.js'), 'utf8');
  const anoRoute3 = require('fs').readFileSync(path.join(SERVER, 'routes/admin/step-anomalies.js'), 'utf8');
  const model3 = require('fs').readFileSync(path.join(SERVER, 'services/anticheat-model.js'), 'utf8');

  // 根因：wx.request 把 { keyword: undefined } 序列化成字面量 keyword=undefined，
  // 服务端当真关键字去匹配「姓名含 undefined」→ total=0、列表空，而 counts 仍是真实数量。
  // 去掉注释再判断（注释里本身就有 `{ keyword: undefined }` 字样，直接正则匹配会误报）
  const anoJs3NoComment = anoJs3.replace(/\/\/.*$/gm, '');
  ok('请求参数不得含 undefined 字面量', !/keyword:\s*this\.data\.keyword \|\| undefined/.test(anoJs3NoComment));
  ok('只在有关键字时才带 keyword', /const kw = String\(this\.data\.keyword \|\| ''\)\.trim\(\)/.test(anoJs3NoComment) && /if \(kw\) query\.keyword = kw/.test(anoJs3NoComment));
  ok('服务端兜底忽略 undefined/null 字面量', /isNoise/.test(anoRoute3) && /undefined\|null\|NaN/.test(anoRoute3));
  // 正则转义（关键字含 . * 等不能让 RegExp 抛错）
  ok('关键字正则已转义', anoRoute3.indexOf('replace(/[.*+?^${}()|[\\]\\\\]/g') >= 0 || /\\.\*\\+\\?/.test(anoRoute3) || anoRoute3.includes('.replace(/[.*+?'));

  // 理由语义去重（同一件事不该出现两三次）
  ok('理由语义去重', /function dedupeReasons/.test(model3) && /REASON_KINDS/.test(model3));
  ok('evaluate 使用语义去重', /dedupeReasons\(\[\.\.\.hardScore\.reasons/.test(model3));
  ok('合并理由也走去重', /dedupeReasons\(\[\.\.\.\(rule\.reasons/.test(require('fs').readFileSync(path.join(SERVER, 'services/steps.js'), 'utf8')));
}

// ===== 标注积累与升级提示（用户 2026-10-27）=====
{
  const model2 = require('fs').readFileSync(path.join(SERVER, 'services/anticheat-model.js'), 'utf8');
  const labelModel = require('fs').readFileSync(path.join(SERVER, 'models/step-label.js'), 'utf8');
  const anoRoute2 = require('fs').readFileSync(path.join(SERVER, 'routes/admin/step-anomalies.js'), 'utf8');
  const anomalModel2 = require('fs').readFileSync(path.join(SERVER, 'models/step-anomaly.js'), 'utf8');

  // 标注必须持久化（上一版只在内存，重启丢失 + 多进程不一致）
  ok('标注持久化到 step_labels', /step_labels/.test(labelModel));
  ok('标注记录来源与特征快照', /source: \{ type: String, enum: \['werun', 'gps'\]/.test(labelModel) && /features:/.test(labelModel));
  ok('一条异常最多一条标注（偏导唯一索引）', /partialFilterExpression/.test(labelModel) && !/sparse: true/.test(labelModel));
  ok('标注从库里加载（不只内存）', /async function loadFeedback/.test(model2) && /StepLabel\.find/.test(model2));
  ok('封禁/排除写入持久标注', /recordFeedback\([\s\S]{0,400}anomalyId: rec\._id/.test(anoRoute2));

  // 升级提示：自动判断标注是否攒够
  ok('升级就绪度自动评估', /async function checkUpgradeReadiness/.test(model2));
  ok('升级阈值：总数/每类/每来源', /minTotal: 200/.test(model2) && /minPerClass: 40/.test(model2) && /minPerSource: 80/.test(model2));
  ok('缺什么要明说（还差 N 条）', /还差 \$\{/.test(model2));
  ok('升级状态接口存在', /\/upgrade-status/.test(anoRoute2));
  ok('标注变化后清进度缓存', /invalidateUpgradeCache/.test(model2) && /invalidateUpgradeCache\(\)/.test(anoRoute2));

  // 前端展示升级进度
  const anoJs2 = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'config', 'anomalies', 'anomalies.js'), 'utf8');
  const anoWxml2 = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'config', 'anomalies', 'anomalies.wxml'), 'utf8');
  ok('前端加载升级进度', /loadUpgrade\(\)/.test(anoJs2) && /upgrade-status/.test(anoJs2));
  ok('前端展示升级进度条与提示', /sa-upgrade/.test(anoWxml2) && /upgrade.progress/.test(anoWxml2));
  ok('异常记录模型带特征快照', /features: \{ type: mongoose\.Schema\.Types\.Mixed/.test(anomalModel2));
}

// ===== 反作弊学习引擎（用户 2026-10-27：融入大数据/推理模型，自己学模式，按来源分开）=====
{
  const model = require('fs').readFileSync(path.join(SERVER, 'services/anticheat-model.js'), 'utf8');
  const stepsSrc3 = require('fs').readFileSync(path.join(SERVER, 'services/steps.js'), 'utf8');
  const anomalModel = require('fs').readFileSync(path.join(SERVER, 'models/step-anomaly.js'), 'utf8');
  const anoRoute = require('fs').readFileSync(path.join(SERVER, 'routes/admin/step-anomalies.js'), 'utf8');

  // ① 真正的学习部件（不是硬编码阈值）
  ok('Isolation Forest 无监督模型', /function buildIsolationForest/.test(model) && /function scoreForest/.test(model));
  ok('按来源分开训练（两套特征）', /WERUN_ORDER/.test(model) && /GPS_ORDER/.test(model));
  ok('微信特征：步数/整数化/模式/增速/基线', /function werunFeatures/.test(model) && /零|roundness/.test(model) && /pattern/.test(model));
  ok('GPS 特征：配速/轨迹/平滑度', /function gpsFeatures/.test(model) && /paceSecPerKm/.test(model) && /jitter/.test(model));
  ok('与本人基线比（稳健 z-score）', /medianSteps/.test(model) && /madSteps/.test(model));
  ok('物理约束层补模型盲区', /function physicalScore/.test(model) && /快于人类极限/.test(model));

  // ② 在线学习：人工反馈校准阈值
  ok('人工反馈驱动阈值自校准', /function recordFeedback/.test(model) && /function recalibrateThreshold/.test(model));
  ok('封禁/排除都喂反馈', /recordFeedback\(\s*true/.test(anoRoute) && /recordFeedback\(\s*false/.test(anoRoute));

  // ③ 训练性能红线（实测 30 秒超时 → 必须库侧聚合）
  ok('GPS 训练在库侧聚合（不拉轨迹点）', /\$project:[\s\S]{0,400}pointCount: \{ \$size/.test(model));
  ok('模型状态接口不阻塞（不等待训练）', /peekModel/.test(model) && /warming: true/.test(anoRoute));

  // ④ 按来源接入两条真实链路
  ok('微信同步接入模型判定', /acModel\.evaluate\(\s*'werun'/.test(stepsSrc3));
  ok('GPS 接入独立模型判定', /acModel\.evaluate\(\s*'gps'/.test(stepsSrc3));
  ok('模型判定在规则拦截之前（不丢线索）', (() => {
    const i1 = stepsSrc3.indexOf("acModel.evaluate('gps'");
    const i2 = stepsSrc3.indexOf('anticheat.checkPace(user, distance, durationSeconds)');
    return i1 > 0 && i2 > i1;
  })());
  ok('异常记录带 source 与 modelScore', /source: \{ type: String, enum: \['werun', 'gps'\]/.test(anomalModel) && /modelScore/.test(anomalModel));
}

// ===== 反作弊完善：可疑步数识别 + 手动封禁列表（用户 2026-10-27）=====
{
  const anoSrc = require('fs').readFileSync(path.join(SERVER, 'services/step-anomaly.js'), 'utf8');
  const modelSrc = require('fs').readFileSync(path.join(SERVER, 'models/step-anomaly.js'), 'utf8');
  const routeSrc = require('fs').readFileSync(path.join(SERVER, 'routes/admin/step-anomalies.js'), 'utf8');
  const idxSrc = require('fs').readFileSync(path.join(SERVER, 'routes/admin/index.js'), 'utf8');
  const stepsSrc2 = require('fs').readFileSync(path.join(SERVER, 'services/steps.js'), 'utf8');

  // 特征识别：整数步数 / 66666 这类重复数字 / 增速 / 单日上限
  ok('识别重复数字（66666 类）', /\/\(\)\)\)\/\^\^\^/.test(anoSrc) || /checkPatternNumber/.test(anoSrc));
  ok('重复数字判为自动封禁级', /重复数字/.test(anoSrc) && /AUTO_BAN_SCORE = 60/.test(anoSrc));
  ok('识别整数步数（整万/整千）', /整数步数/.test(anoSrc) && /整千步数/.test(anoSrc));
  ok('识别增速超人类极限', /步数增速/.test(anoSrc));
  ok('识别单日步数超限', /单日步数/.test(anoSrc));

  // 分级：自动封禁 vs 待研判（用户要求「没到自动封禁的记录可查看并手动封禁」）
  ok('分 autoBan / suspicious 两级', /level === 'autoBan'/.test(anoSrc) && /SUSPICIOUS_SCORE/.test(anoSrc));
  ok('异常记录模型独立于 ban_records', /step_anomalies/.test(modelSrc));
  ok('异常记录状态 open/banned/dismissed', /enum: \['open', 'banned', 'dismissed'\]/.test(modelSrc));

  // 接口：列表 + 手动封禁 + 标记正常
  ok('管理端有异常记录列表', /router\.get\(/.test(routeSrc) && /StepAnomaly\.find/.test(routeSrc));
  ok('手动封禁走 anticheat 唯一实现', /anticheat\.manualBan/.test(routeSrc));
  ok('可标记为正常', /dismissed/.test(routeSrc) && /\/:id\/dismiss/.test(routeSrc));
  ok('路由已挂载', /step-anomalies/.test(idxSrc));

  // 接入同步链路：可疑但未达线只记录、达线才封
  ok('同步时做可疑研判', /recordStepAnomaly\(user/.test(stepsSrc2));
  ok('研判失败不阻塞同步', /研判失败绝不能阻塞正常同步/.test(stepsSrc2));

  // 前端页面
  const anoJs = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'config', 'anomalies', 'anomalies.js'), 'utf8');
  ok('前端列表页存在且受 user.manage 守卫', /applyManage\(this, 'user\.manage'\)/.test(anoJs));
  ok('前端可手动封禁与标记正常', /submitBan/.test(anoJs) && /dismiss/.test(anoJs));
}

// ===== 微信运动自动同步 + 步数不得误封（用户 2026-10-26）=====
{
  const homeSrc = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'home', 'home.js'), 'utf8');
  const acSrc = require('fs').readFileSync(path.join(SERVER, 'services/anticheat.js'), 'utf8');
  const stepsSrc = require('fs').readFileSync(path.join(SERVER, 'services/steps.js'), 'utf8');
  const cfgModel = require('fs').readFileSync(path.join(SERVER, 'models/goal-config.js'), 'utf8');

  // ① 进页面自动同步（静默、带护栏）
  ok('进首页自动同步微信运动', /onShow\(\)[\s\S]{0,700}this\.autoSyncWerun\(\)/.test(homeSrc));
  ok('自动同步不弹成功提示（静默）', /autoSyncWerun\(\)[\s\S]{0,1600}?catch \(e\) \{\s*\n\s*\/\/ 静默/.test(homeSrc));
  ok('同一页面只自动同步一次', /this\._autoSynced/.test(homeSrc));
  ok('自动同步有最小间隔护栏', /AUTO_SYNC_MIN_GAP/.test(homeSrc));
  ok('教师账号不自动同步（不参与运动数据）', /user\.role === 'teacher'\) return/.test(homeSrc));

  // ② 步数不得被误封：按同步节奏判，不按绝对增量
  ok('暴增检测带 lastSyncAt 上下文', /checkStepJump\(user, date, previousSteps, newSteps, ctx = \{\}\)/.test(acSrc));
  ok('攒久了才同步 → 不判违规', /const stale = lastSyncAt > 0 \?/.test(acSrc) && /if \(stale\) return \{ violation: false \}/.test(acSrc));
  ok('日累计物理上限 50000', /MAX_REASONABLE_DAILY_STEPS = 50000/.test(acSrc));
  ok('同步时长上下文由 steps 传入', /checkStepJump\(user, dateKey, recordedTotal, cumulativeSteps \|\| 0, \{/.test(stepsSrc));
  ok('默认暴增阈值提到 30000', /maxStepJumpPerSync: \{ type: Number, default: 30000 \}/.test(cfgModel));
}

// ===== 检查照片要清晰：自适应压缩（用户 2026-10-26 第六轮「可以大一点 清晰一点」）=====
{
  const entrySrc5 = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageUnion', 'entry', 'entry.js'), 'utf8');
  const nginxSrc2 = (() => {
    const dir = path.join(__dirname, '..', 'deploy', 'nginx');
    try {
      const f = require('fs').readdirSync(dir).find((n) => n.endsWith('.conf'));
      return f ? require('fs').readFileSync(path.join(dir, f), 'utf8') : '';
    } catch (e) {
      return '';
    }
  })();
  const routeUpSrc3 = require('fs').readFileSync(path.join(SERVER, 'routes/upload.js'), 'utf8');

  ok('自适应压缩：小图原样传', /const PHOTO_SAFE_BYTES = 8 \* 1024 \* 1024/.test(entrySrc5) && /s\.len|size <= PHOTO_SAFE_BYTES\) return src/.test(entrySrc5.replace(/if \(size > 0 && size/g, 'if (size')));
  ok('自适应压缩：先读原图大小', /getFileInfo\(/.test(entrySrc5) && /getFileSize\(src\)/.test(entrySrc5));
  ok('逐级降质量 85→70→55', /\[85, 70, 55\]/.test(entrySrc5));
  ok('越清晰越好：长边 2560（不是 1280）', /const PHOTO_MAX_EDGE = 2560/.test(entrySrc5));
  ok('够小就停止继续压', /if \(s > 0 && s <= PHOTO_SAFE_BYTES\) return current/.test(entrySrc5));
  ok('检查照片上限 20MB', /CHECK_PHOTO_MAX_MB \|\| 20/.test(routeUpSrc3));
  ok('nginx 体积上限 > 20MB', (() => { const m = nginxSrc2.match(/client_max_body_size\s+(\d+)m/); return !!m && Number(m[1]) > 20; })());
}

  ok('超限时给可操作提示', /照片太大（压缩后仍超限）/.test(entrySrc4));
}

// ===== 图库上传失败：mimetype 不可靠 + 头像 2MB 太小（用户 2026-10-26 第四轮）=====
{
  const upSrc3 = require('fs').readFileSync(path.join(SERVER, 'utils/uploader.js'), 'utf8');
  const routeUpSrc = require('fs').readFileSync(path.join(SERVER, 'routes/upload.js'), 'utf8');
  const profSrc = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'profile', 'profile.js'), 'utf8');
  const entrySrc3 = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageUnion', 'entry', 'entry.js'), 'utf8');

  // 根因①：图库原图的 mimetype 常是 application/octet-stream（iPhone HEIC），不能只看 MIME
  ok('上传按扩展名白名单放行', /const IMAGE_EXTS = \[/.test(upSrc3) && /IMAGE_EXTS\.includes\(ext\)\) return cb\(null, true\)/.test(upSrc3));
  ok('HEIC / HEIF 在认可列表', /\.heic/.test(upSrc3) && /\.heif/.test(upSrc3));
  ok('无扩展名 + octet-stream 也放行', /genericMime && !ext\) return cb\(null, true\)/.test(upSrc3));
  ok('落盘扩展名按 MIME 反推（不再一律 .png）', /MIME_TO_EXT\[mime\]/.test(upSrc3) && /\|\| '\.jpg'/.test(upSrc3));

  // 根因②：头像 2MB 太小，手机原图 3~8MB 直接被拒
  ok('头像上限放宽到 5MB', /const AVATAR_MAX_MB = 5;/.test(routeUpSrc));
  ok('头像上传前先压缩', /wx\.compressImage/.test(profSrc));
  ok('头像失败时显示服务端原因', /err\.message \|\| '头像上传失败'/.test(profSrc));

  // 选图失败不再静默（以前 cancel 与真失败都吞掉）
  ok('选择图片失败会提示（区分取消）', /选择图片失败，请重试/.test(entrySrc3) && /\/cancel\/i/.test(entrySrc3));
}

// ===== 上传失败排查 + 密码变更界面重做（用户 2026-10-26 第三轮）=====
{
  const shSrc2 = require('fs').readFileSync(path.join(__dirname, '..', 'deploy', 'install.sh'), 'utf8');
  const upSrc2 = require('fs').readFileSync(path.join(SERVER, 'utils/uploader.js'), 'utf8');
  const detJs2 = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'user-detail', 'user-detail.js'), 'utf8');
  const detWxml2 = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'user-detail', 'user-detail.wxml'), 'utf8');
  const entryJs2 = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageUnion', 'entry', 'entry.js'), 'utf8');

  // 上传照片打不开的头号原因：nginx /uploads/ 别名指向别的目录（部署目录不是 /opt/campus-run）
  ok('install.sh 自动修正 nginx uploads 别名', /fix_nginx_uploads_alias\(\)/.test(shSrc2) && /alias \$\{target\};/.test(shSrc2.replace(/\$APP_DIR\/server\/uploads\//g,'${target}')));
  ok('install.sh 保证 uploads 对 nginx 可读', shSrc2.indexOf('chmod 755 "$APP_DIR/server/uploads"') >= 0);
  ok('安装脚本 if/fi 配对', (() => { let d=0; for (const line of shSrc2.split('\n')) { const t=line.trim(); if (/^if\s/.test(t)) d++; else if (/^fi$|^fi;/.test(t)) d--; } return d===0; })());
  ok('上传 URL 可用 PUBLIC_BASE_URL 覆盖', /config\.publicBaseUrl \|\| config\.adPageBaseUrl/.test(upSrc2));

  // 上传失败必须能看出原因（不再只有一句「上传失败」）
  ok('上传失败区分 403002 / 401 并带 code', /403002/.test(entryJs2) && /code \$\{code\}/.test(entryJs2));

  // 密码变更选择层：不用原生 ActionSheet（样式不可控、长文案折行）
  // 精确到 changePassword 方法体：文件里别处（解除限制）仍在用 ActionSheet，那是正常的
  ok('密码变更不用 showActionSheet', (() => { const body = (detJs2.match(/changePassword\(\) \{[\s\S]*?\n  \},/) || [''])[0]; return body.length > 0 && !/showActionSheet/.test(body); })());
  ok('密码变更用自有 t-popup 选择层', /pwdMenuVisible/.test(detJs2) && /ud-pwd-opt/.test(detWxml2));
  ok('选择层两个动作齐全', /data-act="initial"/.test(detWxml2) && /data-act="set"/.test(detWxml2));
  ok('选择层受 caps.resetPassword 守卫', /wx:if="\{\{caps\.resetPassword\}\}" visible="\{\{pwdMenuVisible\}\}"/.test(detWxml2));
}

// ===== 检查录入三处修复（用户 2026-10-26 第二轮）=====
{
  const bcSrc2 = require('fs').readFileSync(path.join(SERVER, 'services/band-chao.js'), 'utf8');
  const upSrc = require('fs').readFileSync(path.join(SERVER, 'utils/uploader.js'), 'utf8');
  const cfgSrc = require('fs').readFileSync(path.join(SERVER, 'config/index.js'), 'utf8');
  const entrySrc2 = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageUnion', 'entry', 'entry.js'), 'utf8');
  const shSrc = require('fs').readFileSync(path.join(__dirname, '..', 'deploy', 'install.sh'), 'utf8');

  // ③ 查宿「应住人数」：字段名必须与 routes/union.js::shouldCountCtx 读的名字一致
  ok('查宿应住人数用实时聚合', /DormAssignment\.aggregate\(\[[\s\S]{0,300}status: \{ \$in: \['checked_in', 'guest'\] \}/.test(bcSrc2));
  ok('宿舍对象下发 residentCount（与 shouldCountCtx 同名）', /residents: residentCount,[\s\S]{0,400}residentCount,/.test(bcSrc2));
  ok('shouldCountCtx 读 residentCount', /Number\(target\.residentCount\)/.test(require('fs').readFileSync(path.join(SERVER, 'routes/union.js'), 'utf8')));

  // ② 早操不需要楼栋筛选：只有场所类（教室/宿舍）才生成楼栋选项
  ok('楼栋筛选仅限教室/宿舍', /BUILDING_TYPES = \['classroom', 'dorm'\]/.test(entrySrc2));
  ok('楼栋选项按 typeKey 过滤', /BUILDING_TYPES\.indexOf\(t\.typeKey\) < 0\) continue/.test(entrySrc2));

  // ① 上传照片 URL 必须是可配置的公网 https 地址
  ok('上传 URL 优先用 PUBLIC_BASE_URL', /config\.publicBaseUrl \|\| config\.adPageBaseUrl/.test(upSrc));
  ok('config 暴露 publicBaseUrl', /publicBaseUrl:/.test(cfgSrc));
  ok('install.sh 自动写入 PUBLIC_BASE_URL', /PUBLIC_BASE_URL=https:\/\/\$\{DETECTED_HOST\}/.test(shSrc));
  ok('install.sh 不引用不存在的 DOMAIN 变量', !/[^_]DOMAIN[^S_]/.test(shSrc.replace(/DETECTED_DOMAIN/g, '')));
}

// ===== 检查录入：对象类型 / 教学楼筛选（用户 2026-10-26 第 4、5 点）=====
{
  const cmSrc = require('fs').readFileSync(path.join(SERVER, 'services/check-modules.js'), 'utf8');
  const bcSrc = require('fs').readFileSync(path.join(SERVER, 'services/band-chao.js'), 'utf8');
  const dormsSrc = require('fs').readFileSync(path.join(SERVER, 'services/dorms.js'), 'utf8');
  const entrySrc = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageUnion', 'entry', 'entry.js'), 'utf8');
  const entryWxml = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageUnion', 'entry', 'entry.wxml'), 'utf8');

  ok('卫生检查支持三类受检对象', /targetTypes: \['classroom', 'dorm_room', 'area'\]/.test(cmSrc));
  // ⑤ 晚自习：以教室为受检对象（不再是 class），并靠 DEF_VERSION 迁移存量库
  // 用「取该模块定义片段再判 targetTypes」而不是跨注释的正则跨度（注释字数一变就断）
  const evBlock = (cmSrc.match(/key: 'study_evening'[\s\S]*?sort: \d+,/) || [''])[0];
  ok('晚自习以教室为受检对象', /targetTypes: \['classroom'\]/.test(evBlock), evBlock ? '片段已取到' : '片段为空');
  ok('DEF_VERSION 升到 5（存量库要迁移）', /const DEF_VERSION = 5;/.test(cmSrc));
  ok('迁移会覆盖 targetTypes', /set\.targetTypes = def\.targetTypes;/.test(cmSrc));
  // 教室 / 教学楼由班级台账下发，供前端「优先显示教室」与「按教学楼筛选」
  ok('班级对象下发 classroom / building', /const classroom = String\(p\.classroom/.test(bcSrc) && /building = classroom \? classroom\.split/.test(bcSrc));
  ok('宿舍对象也下发 building', /targetType: 'dorm_room'[\s\S]{0,300}building: r\.buildingName/.test(bcSrc));

  // 前端：类型 / 楼栋两栏筛选 + 教室优先显示
  ok('前端有类型与楼栋筛选选项生成', /buildTypeOptions/.test(entrySrc) && /buildBuildingOptions/.test(entrySrc));
  ok('类型筛选参与 applyFilter', /if \(typeFilter\) scoped = scoped\.filter/.test(entrySrc) && /if \(buildingFilter\) scoped = scoped\.filter/.test(entrySrc));
  ok('切类型会重置楼栋筛选', /onTypeChange[\s\S]{0,200}buildingFilter: ''/.test(entrySrc));
  ok('列表优先显示教室', /item\.displayName \|\| item\.targetName/.test(entryWxml));
  ok('筛选栏渲染对象/楼栋 picker', /onTypeChange/.test(entryWxml) && /onBuildingChange/.test(entryWxml));

  // ③ 宿舍脏数据：对象不得被当成宿舍号（[object Object] 的成因）
  ok('宿舍号拒绝对象与 [object', /if \(input && typeof input === 'object'\)/.test(dormsSrc) && /\/\\\[object\/i\.test\(raw\)/.test(dormsSrc));
}

// ===== 密码变更（用户 2026-10-26：「重置密码」改称「密码变更」，两个动作）=====
{
  const acctSrc = require('fs').readFileSync(path.join(SERVER, 'services/user-account-admin.js'), 'utf8');
  const adminUsersSrc = require('fs').readFileSync(path.join(SERVER, 'routes/admin/users.js'), 'utf8');
  const classSrc2 = require('fs').readFileSync(path.join(SERVER, 'routes/class.js'), 'utf8');

  ok('密码变更：教师初始密码固定 123456', /TEACHER_INITIAL_PASSWORD = '123456'/.test(acctSrc));
  ok('教师恢复初始密码写三个哈希字段（可重复恢复）', /role === 'teacher'\)[\s\S]{0,400}resetHashes = \[h\]/.test(acctSrc));
  ok('设置密码不强制改密（用户第 1 点）', /async function setUserPassword[\s\S]{0,900}mustChangePassword = false/.test(acctSrc));
  ok('设置密码清空旧初始哈希（旧密码失效）', /async function setUserPassword[\s\S]{0,900}initialHashes = \[\]/.test(acctSrc));
  ok('设置密码复用全局强度校验（用户第 4 点）', /async function setUserPassword[\s\S]{0,400}pwd\.validateNewPassword/.test(acctSrc));
  ok('无初始密码数据时明确报错（不再静默生成随机串）', /无法恢复为初始密码/.test(acctSrc) && !/randomBytes/.test(acctSrc));
  ok('两个路由共用 changeUserPassword', /accountAdmin\.changeUserPassword\(user,/.test(adminUsersSrc) && /accountAdmin\.changeUserPassword\(target,/.test(classSrc2));
  ok('不传 mode 回落 initial（老前端兼容）', (acctSrc.match(/opts\.mode \|\| 'initial'/g) || []).length >= 1 && /mode: body\.mode \|\| 'initial'/.test(adminUsersSrc));
  ok('批量入口只做恢复初始密码', /action === 'reset-password'[\s\S]{0,200}resetUserPassword/.test(adminUsersSrc));

  // 前端
  const detJs = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'user-detail', 'user-detail.js'), 'utf8');
  const detWxml = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'user-detail', 'user-detail.wxml'), 'utf8');
  ok('前端改称「密码变更」且有两个动作', /changePassword\(\)/.test(detJs) && /恢复初始密码/.test(detJs) && /设置新密码/.test(detJs));
  ok('按钮文案已改为「密码变更」', /密码变更/.test(detWxml) && !/重置密码<\/text>/.test(detWxml));
  ok('密码弹层受 caps 守卫', /wx:if="\{\{caps\.resetPassword\}\}" visible="\{\{pwdSheetVisible\}\}"/.test(detWxml));
  ok('前端提交带 mode:set', /mode: 'set', password/.test(detJs));
}

// ===== 首页学生会卡片 / 导航栏：身份字段缺失时自愈（用户 2026-10-25）=====
{
  const blockJs = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'components', 'banchao-block', 'banchao-block.js'), 'utf8');
  const tabJs = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'custom-tab-bar', 'index.js'), 'utf8');
  // isUnionMember 是 /api/auth/me 现算下发的；旧缓存里没有该字段 → 卡片/导航项被误判为「非成员」且无提示
  ok('卡片在身份字段缺失时自愈', /resolveUnionUser/.test(blockJs) && /typeof me\.isUnionMember === 'boolean'/.test(blockJs));
  ok('卡片自愈会调 refreshUser', /resolveUnionUser[\s\S]{0,600}refreshUser\(\)/.test(blockJs));
  ok('学生会模式必须用自愈后的 me', /mode === 'union'\) \{\s*\n\s*const me = await this\.resolveUnionUser\(\)/.test(blockJs));
  ok('导航栏在身份字段缺失时自愈', /_unionProbe/.test(tabJs) && /typeof user\.isUnionMember !== 'boolean'/.test(tabJs));
}

// ===== 示例账户（用户 2026-10-24）=====
{
  const demoModel = require('fs').readFileSync(path.join(SERVER, 'models/user.js'), 'utf8');
  const demoSvc = require('fs').readFileSync(path.join(SERVER, 'services/demo-accounts.js'), 'utf8');
  const demoRoute = require('fs').readFileSync(path.join(SERVER, 'routes/admin/demo.js'), 'utf8');
  const authSrc = require('fs').readFileSync(path.join(SERVER, 'routes/auth.js'), 'utf8');
  const countsSrc = require('fs').readFileSync(path.join(SERVER, 'services/class-counts.js'), 'utf8');
  const rankSrc = require('fs').readFileSync(path.join(SERVER, 'routes/ranking.js'), 'utf8');

  ok('用户模型有 isDemo 标记', /isDemo: \{ type: Boolean, default: false, index: true \}/.test(demoModel));
  ok('用户模型有跳过改密标记', /passwordChangeSkipped: \{ type: Boolean, default: false \}/.test(demoModel));
  ok('示例账号统一密码 123456', /DEMO_PASSWORD = '123456'/.test(demoSvc));
  ok('示例账号塞进真实班级（不新建班级）', /resolveDemoClass[\s\S]{0,400}ClassProfile\.findOne/.test(demoSvc) && /不存在，请换一个已存在的班级/.test(demoSvc));
  ok('默认班级缺失时自动兜底（换环境也能用）', /兜底/.test(demoSvc) && /className: \/\^24\//.test(demoSvc));
  ok('示例学生2 是主席团主席', /deptKey: 'presidium', role: 'president'/.test(demoSvc));
  // 层级必须是校学生会（用户 2026-10-25：详情页同时出现「北校区学生会」与「校学生会」两条职务）
  ok('示例学生2 层级为校学生会（非院级分会）', /union: \{ level: 'school', deptKey: 'presidium', role: 'president' \}/.test(demoSvc));
  // seed 前必须先清旧的在任记录：否则换层级会变成「再加一条」而不是「改成一条」
  ok('seed 先清旧在任记录再建（避免多条并存）', /UnionMember\.deleteMany\(\{ userId: user\._id, status: 'active' \}\)/.test(demoSvc));
  // 身份识别必须 openid + userId 双路（用户 2026-10-25 实测：绑微信后仍「未加入学生会」）
  const unionSvcSrc = require('fs').readFileSync(path.join(SERVER, 'services/union.js'), 'utf8');
  ok('身份解析按 userId 兜底', /async function findActiveMembers/.test(unionSvcSrc) && /or\.push\(\{ userId: user\._id \}\)/.test(unionSvcSrc));
  ok('身份解析不再只按 openid', !/memberModel\.find\(\{ openid, status: 'active' \}\)/.test(unionSvcSrc));
  ok('isUnionMember 走双路', /async function isUnionMember[\s\S]{0,260}findActiveMembers\(user\)/.test(unionSvcSrc));
  ok('decorateUser 不再要求已绑微信', !/if \(!user \|\| !user\.openid\) return payload;/.test(unionSvcSrc));
  // 候选人「已是成员」标记按 userId（openid 快照为空会漏标 → 重复添加 → 两条职务并存）
  // 注：这里自己读一次源码，不能复用后面块的 auSrc3（TDZ：let 在下方块内才声明）
  const adminUnionSrc = require('fs').readFileSync(path.join(SERVER, 'routes/admin/union.js'), 'utf8');
  ok('候选人标记按 userId 查成员', /UnionMember\.find\(\{ userId: \{ \$in: userIds \}, status: 'active' \}\)/.test(adminUnionSrc));
  ok('候选人不再按 openid 标记', !/existBy\.get\(u\.openid\)/.test(adminUnionSrc));
  // 换绑 / 解绑必须清身份缓存（用户 2026-10-25 端到端实测：换绑后读到上一个账号的学生会身份）
  ok('换绑必须清身份缓存', /unionSvc\.clearIdentityCache\(openid\)/.test(authSrc));
  ok('解绑必须清身份缓存', /clearIdentityCache\(openid\)/.test(require('fs').readFileSync(path.join(SERVER, 'services/user-account-admin.js'), 'utf8')));
  ok('示例权限组按 spec 下发（教师1=teacher 组，学生=无）', /permissionGroups: spec\.groups \|\| \[\]/.test(demoSvc) && /groups: \['teacher'\]/.test(demoSvc));
  ok('示例账号不签发设备令牌', /deviceToken: user\.isDemo \? undefined/.test(authSrc));
  ok('/bind 里示例账号豁免学生绑定限制', /isDemoAccount/.test(authSrc) && /!isTeacherAccount && !isDemoAccount/.test(authSrc));
  ok('退出登录自动解绑接口', /'\/demo-release'/.test(authSrc) && /只有示例账号会自动解绑微信/.test(authSrc));
  ok('跳过改密只给示例账号', /'\/password\/skip'/.test(authSrc) && /只有示例账号可以跳过修改密码/.test(authSrc));
  ok('登录/me 下发 isDemo 与跳过标记', /isDemo: !!user\.isDemo/.test(authSrc) && /passwordChangeSkipped: !!user\.passwordChangeSkipped/.test(authSrc));
  ok('示例账号不计入应到人数', /isDemo: \{ \$ne: true \}/.test(countsSrc));
  ok('示例账号不进排行榜（个人榜）', /'u\.isDemo': \{ \$ne: true \}/.test(rankSrc));
  ok('示例账号不进排行榜（班级榜）', /isDemo: \{ \$ne: true \}/.test(rankSrc));
  ok('管理端示例路由挂载', /router\.use\('\/demo'/.test(require('fs').readFileSync(path.join(SERVER, 'routes/admin/index.js'), 'utf8')));
  ok('示例路由写操作需 config.manage', /requirePermission\('config\.manage'\)/.test(demoRoute));

  // 前端
  const reqSrc = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'utils', 'request.js'), 'utf8');
  // 断言「demo-release 的调用出现在 clearAuth() 之前」—— 用两段独立匹配，避免把换行写进正则字面量
  // （历史踩坑：插入脚本时 \n 被还原成真实换行，正则直接断行 → SyntaxError: missing /）
  const iRelease = reqSrc.indexOf('/api/auth/demo-release');
  const iClear = reqSrc.indexOf('clearAuth();\n  markLoggedOut();');
  ok('退出登录前先调 demo-release', iRelease > 0 && iClear > 0 && iRelease < iClear);
  const pwdPage = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'password', 'change.js'), 'utf8');
  // 服务端必须直接返回合并好的 rows（前端不再自行按数组顺序拼状态）
  const demoRouteSrc = require('fs').readFileSync(path.join(SERVER, 'routes/admin/demo.js'), 'utf8');
  ok('服务端合并 rows 返回（按 key，不用下标）', /const byKey = new Map\(list\.map/.test(demoRouteSrc) && /rows,/.test(demoRouteSrc));
  ok('前端优先使用服务端 rows', /Array\.isArray\(res\.rows\)/.test(require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'config', 'demo', 'demo.js'), 'utf8')));
  ok('示例接口自报版本与库名（远程定位版本/库不一致）', /apiVersion: API_VERSION/.test(demoRouteSrc) && /db: demo\.dbInfo\(\)/.test(demoRouteSrc));
  ok('未命中时接口吐诊断（查了什么/库里有什么）', /matchedBy: 'none'/.test(demoSvc) && /similar:/.test(demoSvc));
  // 防复发（用户 2026-10-24「创建后依旧显示未创建」）：
  // 模板里用 list[index] 跨数组取状态，依赖两个数组顺序严格一致 —— 顺序一变就静默错位。
  // 这里直接禁掉这种写法：示例账户页必须用 JS 合并好的 rows。
  const demoWxml = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'config', 'demo', 'demo.wxml'), 'utf8');
  // 只在**插值表达式**里查跨数组下标（注释里解释隐患不算违规）
  const demoExprs = [...demoWxml.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((x) => x[1]).join('\n');
  ok('示例账户页禁止跨数组下标（list[index]）', !/list\[index\]/.test(demoExprs) && /wx:for="\{\{rows\}\}"/.test(demoWxml));
  ok('改密页只有示例账号显示跳过', /wx:if="\{\{first && isDemo && !loading\}\}"/.test(require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'password', 'change.wxml'), 'utf8')) && /isDemo/.test(pwdPage));
}

// ===== 部门 ↔ 职务匹配（用户 2026-10-21「主席团中怎么能有部长这类的职务呢」）=====
{
  const auSrc3 = require('fs').readFileSync(path.join(SERVER, 'routes/admin/union.js'), 'utf8');
  const roleFn = (auSrc3.match(/function assertRoleFitsDept\(role, deptKey\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('部门/职务匹配校验函数存在', roleFn.length > 0);

  // 抽出来真跑一遍：双向规则都要生效
  if (roleFn) {
    class ContractApiError extends Error {
      constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
      }
    }
    // eslint-disable-next-line no-new-func
    const guard = new Function(
      'unionSvc',
      'PRESIDIUM_ROLES',
      'ApiError',
      `${roleFn}; return assertRoleFitsDept;`
    )({ PRESIDIUM_KEY: 'presidium' }, ['president', 'vice_president'], ContractApiError);

    const mustPass = [
      ['president', 'presidium'],
      ['vice_president', 'presidium'],
      ['minister', 'life'],
      ['vice_minister', 'study'],
      ['member', 'discipline'],
    ];
    const mustFail = [
      ['minister', 'presidium'],
      ['vice_minister', 'presidium'],
      ['member', 'presidium'],
      ['president', 'life'],
      ['vice_president', 'discipline'],
      ['', 'presidium'],
    ];
    ok(
      '主席团只允许主席/副主席',
      mustPass.every(([r, d]) => {
        try {
          guard(r, d);
          return true;
        } catch (e) {
          return false;
        }
      })
    );
    ok(
      '主席团出现部长类职务必须拒绝',
      mustFail
        .filter(([, d]) => d === 'presidium')
        .every(([r, d]) => {
          try {
            guard(r, d);
            return false;
          } catch (e) {
            return true;
          }
        })
    );
    ok(
      '主席/副主席挂到业务部门必须拒绝',
      mustFail
        .filter(([r]) => ['president', 'vice_president'].includes(r))
        .every(([r, d]) => {
          try {
            guard(r, d);
            return false;
          } catch (e) {
            return true;
          }
        })
    );
  }

  // 三个写入口（新建 / 批量 / 修改）都要挂这个校验
  ok('新建成员时校验部门职务匹配', /assertRoleFitsDept\(role, dept\.key\)/.test(auSrc3));
  ok('批量加人时校验部门职务匹配', /assertRoleFitsDept\(role, dept\.key\)/.test(auSrc3) && (auSrc3.match(/assertRoleFitsDept\(role, dept\.key\)/g) || []).length >= 2);
  ok('改成员时校验最终组合', /assertRoleFitsDept\(doc\.role, doc\.deptKey\)/.test(auSrc3));
  ok('Excel 导入逐行报错而非整批失败', /部门与职务不匹配/.test(auSrc3));

  // 前端联动：主席团只给主席/副主席，业务部门只给部长类
  const memPage2 = require('fs').readFileSync(
    path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'union', 'members', 'members.js'),
    'utf8'
  );
  ok('前端按部门切换职务选项集合', /PRESIDIUM_ROLE_SET/.test(memPage2) && /DEPT_ROLE_SET/.test(memPage2));
  ok('改职务时按成员所在部门联动', /const options = isPresidium \? PRESIDIUM_ROLE_SET : DEPT_ROLE_SET/.test(memPage2));
  ok('添加抽屉随部门联动职务', /syncRoleOptionsForDept\(dept\.key \|\| ''\)/.test(memPage2));
  ok('选主席/副主席时部门锁主席团', /PRESIDIUM_ROLES\.includes\(role\)\) \{[\s\S]{0,220}addDeptIndex: presidiumIdx/.test(memPage2));
  ok('提交前前端也拦矛盾组合', /主席团成员只能是主席或副主席/.test(memPage2) && /必须归入主席团/.test(memPage2));

  // 存量数据自查脚本（位于 server/scripts/，不在 server/src 下）
  const fixScript = path.join(SERVER, '..', 'scripts', 'fix-union-role-dept.js');
  ok('提供存量矛盾数据自查脚本', require('fs').existsSync(fixScript));
}

// ===== 检查模块的录入部门必须可改且可见（用户 2026-10-21「我依旧无法改变部门啊」）=====
{
  const cfgJs2 = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'union', 'config', 'config.js'), 'utf8');
  const cfgWxml2 = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'union', 'config', 'config.wxml'), 'utf8');
  const auSrc3 = require('fs').readFileSync(path.join(SERVER, 'routes/admin/union.js'), 'utf8');

  // ① 后端：PUT /modules 必须接受 entryDeptKeys，且校验部门存在
  ok('PUT /modules 接受 entryDeptKeys', /if \(body\.entryDeptKeys !== undefined\)/.test(auSrc3));
  ok('写入前校验部门存在', /部门不存在：\$\{missing\.join/.test(auSrc3));
  // ② 播种不得覆盖学校配置（否则「改了重启就没了」，上一轮已修，这里锁住）
  const cmSrc3 = require('fs').readFileSync(path.join(SERVER, 'services/check-modules.js'), 'utf8');
  ok('播种不强制回写 entryDeptKeys', !/JSON\.stringify\(exists\.entryDeptKeys[\s\S]{0,80}!== JSON\.stringify\(def\.entryDeptKeys\)/.test(cmSrc3));

  // ③ 前端：选中态必须**预计算**。WXML 表达式不支持方法调用（TDesign 官方 WXML 0 处用 indexOf），
  //    写成 entryDeptKeys.indexOf(item.key) 恒为 false → chips 永远全灰，用户以为点不动
  // 剥掉 WXML 注释再判：注释里会**引用**这个错误写法作为反面教材，
  // 直接 includes 会把说明文字当成违规（本仓库 check-nav-groups 已踩过同样坑）
  const cfgWxmlNoComment = cfgWxml2.replace(/<!--[\s\S]*?-->/g, '');
  ok('WXML 不再调用 indexOf 判断选中', !/entryDeptKeys\.indexOf\(/.test(cfgWxmlNoComment), 'chips 会永远全灰（模板不能调方法）');
  // 用户 2026-10-21「你别叠加弹窗选择了，你就在原本弹窗中使用多级显示 我勾选吧」：
  // 去掉第二层 cascader 弹窗，抽屉内按层级分组直接勾选
  ok('抽屉内直接按层级列出部门（无第二层弹窗）', /wx:for="\{\{moduleDeptGroups\}\}"/.test(cfgWxmlNoComment) && /bind:tap="toggleModuleDept"/.test(cfgWxmlNoComment));
  ok('不再使用 t-cascader（已移除注册与组件）', !/"t-cascader"/.test(require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'union', 'config', 'config.json'), 'utf8')) && !/<t-cascader/.test(cfgWxmlNoComment));
  ok('分组叫「校学生会」而非含糊的「全校 / 通用」', /name: '校学生会'/.test(cfgJs2) && !/name: '全校 \/ 通用'/.test(cfgJs2));
  ok('院校层级叫「<校区>学生会」', /name: `\$\{c\.name\}学生会`/.test(cfgJs2));
  // 主席团只在校学生会组出现：校区组过滤里必须显式排除它，否则会在每个校区各列一遍
  ok('主席团只在校学生会组出现（不重复列三遍）', /const schoolItems = list\.filter\(\(d\) => deptFitsCampus\(d, ''\)\)/.test(cfgJs2)
    && (cfgJs2.match(/!isPresidium\(d\) &&/g) || []).length >= 2, '校区组未排除主席团');
  // ⚠️ 共用部门（未指定校区）只能出现在一个组里：entryDeptKeys 只存一个 key，
  //   同一 key 渲染两处会让「勾了北校区那个，洋河那个也亮」（用户会以为勾了两个）
  ok('共用部门单独成组、不在每个校区重复', /rootKey: '__shared__'/.test(cfgJs2) && /各院校共用（未指定校区）/.test(cfgJs2));
  ok('校区组只列明确归属该校区的部门', /!isPresidium\(d\) && d\.schoolId && String\(d\.schoolId\) === String\(c\.rootKey\)/.test(cfgJs2));
  // 用户 2026-10-21「生活部」显示成单个「e」：胶囊必须禁止折行 + 不许被压窄
  const cfgWxss = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'union', 'config', 'config.wxss'), 'utf8');
  const chipBlock = (cfgWxss.match(/\.uc-chip \{[\s\S]*?\n\}/) || [''])[0];
  ok('部门胶囊禁止折行（否则圆角裁掉只剩一个字）', /white-space: nowrap/.test(chipBlock), '「生活部」会显示成「e」');
  ok('部门胶囊不被 flex 压窄', /flex: 0 0 auto/.test(chipBlock));
  ok('部门胶囊用 inline-flex 横向布局', /display: inline-flex/.test(chipBlock));
  // 空校区**必须仍然出现**（旧实现 if(items.length) 把空校区整组藏掉 → 「无法选择院校」）
  ok('空校区也输出分组（不能藏掉）', /for \(const c of this\._campusList \|\| \[\]\) \{[\s\S]{0,400}groups\.push/.test(cfgJs2) && /empty: items\.length === 0/.test(cfgJs2));
  // 归属只有「校学生会」+「具体校区」两类（用户要求去掉「所有院校通用」中间态）
  ok('归属下拉收录校学生会与各校区', /校学生会（仅校级）/.test(cfgJs2) && /_campusList \|\| \[\]\)\.map\(\(c\) => \(\{ id: c\.rootKey, scope: 'branch'/.test(cfgJs2));
  ok('不再提供「所有院校通用」中间态', !/scope: 'both', name: '所有院校/.test(cfgJs2));

  // ===== 主席团全局唯一（用户 2026-10-21「图1你这个主席团是一样的代码，需要你不一样」）=====
  const deptUtil2 = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'utils', 'union-dept.js'), 'utf8');
  ok('主席团按 key 识别为全局实体', /const isPresidium = \(dept\) =>/.test(deptUtil2) && /dept\.key/.test(deptUtil2));
  // 主席团：部门树只在「全校」层出现一次（不重复）；但作为可选职务，任何校区都能选
  //（分会主席团 = level=branch + deptKey=presidium，见 utils/union-dept.js 注释）
  ok('主席团在部门树只在全校层出现', /if \(isPresidium\(dept\)\) return opts\.forDeptTree \? isSchoolLevel : true/.test(deptUtil2));
  ok('配置页部门树传 forDeptTree', /forDeptTree: true/.test(cfgJs2));
  ok('成员/模块选择器不传该项（分会主席可选）', /deptFitsCampus\(d, campusOfMember\)/.test(require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'union', 'members', 'members.js'), 'utf8')));
  ok('归属文案说明主席团全局唯一', /全校（全局唯一）/.test(cfgJs2));

  // 校级只保留主席团（用户 2026-10-21「全校仅有主席团没有其他部门了」）
  ok('前端：校级层不再列出非主席团部门', /返回 !isSchoolLevel；（不可删）|return !isSchoolLevel;/.test(deptUtil2) && /if \(isPresidium\(dept\)\) return opts\.forDeptTree \? isSchoolLevel : true/.test(deptUtil2));

  // ===== 部门标识自动生成（用户 2026-10-21「图2部门标识自动生成」）=====
  const genFn = (auSrc3.match(/async function generateDeptKey\([\s\S]*?\n\}/) || [''])[0];
  ok('服务端自动生成部门标识', genFn.length > 0 && /async function generateDeptKey/.test(auSrc3));
  ok('不再要求前端传 key', /const key = await generateDeptKey\(name, body\.key\)/.test(auSrc3));
  // ⚠️ 关键质量点：只用**开头**英文段，不能把中文清空后取残余字母（会把「体育部A」变 "a"）
  ok('中文名不产生无意义残余 key', /\^\[a-z\]\[a-z0-9_-\]\*/.test(genFn) && !/replace\(\/\[\^a-z0-9_-\]/.test(genFn), '会把中文名变成 a/b/c');
  ok('冲突自动加序号而非报错', /for \(let i = 2; i < 200/.test(genFn) && !/该部门标识已存在/.test(auSrc3));
  ok('仍兼容显式传 key', /if \(KEY_RE\.test\(given\)\) \{/.test(genFn));
  // 前端表单不再有标识输入框
  ok('前端 WXML 不再有标识输入框', !/部门标识（小写字母/.test(cfgWxmlNoComment) && !/deptForm\.key/.test(cfgWxmlNoComment));
  ok('前端提交不再传 key', !/auth\.post\('\/api\/admin\/union\/departments', \{ \.\.\.f, key/.test(cfgJs2));
  // 不指定校区默认归校级（旧默认 both 会让部门在每个校区都出现）
  ok('新建部门默认归属校级而非 both', /body\.scope === 'branch' \? 'branch' : 'school'/.test(auSrc3));
  // 「适用范围」已彻底移除（用户明确要求），归属由「归属」下拉单独表达
  ok('适用范围 tabs 已移除', !/uc-level-tab/.test(cfgWxmlNoComment) && !/onDeptScope/.test(cfgJs2));
  ok('归属下拉三项表达完整归属', /校学生会（仅校级）/.test(cfgJs2) && /所有院校（各院校通用）/.test(cfgJs2));
  ok('JS 提供 refreshModuleGroups 预计算', /refreshModuleGroups\(entryKeys\)/.test(cfgJs2));
  ok('打开抽屉即预计算选中态', /refreshModuleGroups\(module\.entryDeptKeys \|\| \[\]\)/.test(cfgJs2));
  ok('点击切换后同步刷新选中态', /toggleModuleDept[\s\S]{0,400}refreshModuleGroups\(list\)/.test(cfgJs2));
  ok('保存时提交 entryDeptKeys', /entryDeptKeys: f\.entryDeptKeys/.test(cfgJs2));
  // 官方组件的写法可作为佐证：它从不直接在 WXML 调数组方法
  const tdWxml = require('fs').readdirSync(path.join(__dirname, '..', 'miniprogram', 'miniprogram_npm', 'tdesign-miniprogram'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const p = path.join(__dirname, '..', 'miniprogram', 'miniprogram_npm', 'tdesign-miniprogram', d.name, `${d.name}.wxml`);
      return require('fs').existsSync(p) ? [require('fs').readFileSync(p, 'utf8')] : [];
    });
  ok('TDesign 官方 WXML 也不用 indexOf（佐证模板限制）', !tdWxml.some((s) => s.includes('indexOf(')));
}

// ===== 学生会总管可查看/留证（用户 2026-10-21 第2、3条）=====
{
  const unionRt = require('fs').readFileSync(path.join(SERVER, 'routes/union.js'), 'utf8');
  const upRt = require('fs').readFileSync(path.join(SERVER, 'routes/upload.js'), 'utf8');
  ok('总管查看记录有专门判定', /async function isRecordSteward/.test(unionRt));
  ok('总管列表可见全校', /else if \(await isRecordSteward\(req, identity\)\) \{[\s\S]{0,120}scope = \{\}/.test(unionRt));
  ok('总管详情放行', /!isStewardViewer\) throw new ApiError\(403, 403002, NO_ACCESS\)/.test(unionRt));
  ok('总管具复核权（union.steward 语义含复核）', /\|\|\s*isStewardViewer;/.test(unionRt));
  // 第3条：总管不是成员也要能上传留证照片，否则逐张上传第一张就 403（表现像只能传一张）
  ok('上传允许总管（非成员）', /perms\.includes\('union\.steward'\)/.test(upRt) && /req\.unionSteward = true/.test(upRt));
  ok('上传仍未放宽普通非成员', /你还不是学生会成员，不能上传检查照片/.test(upRt));
  ok('总管不因上传而获得录入权（identity 保持空）', /req\.unionIdentity = identity \|\| null/.test(upRt));
}

// ===== 晚自习开关 + 楼名清单（用户 2026-10-21 第1、2条）=====
{
  const cpModel = require('fs').readFileSync(path.join(SERVER, 'models/class-profile.js'), 'utf8');
  const bcSrc = require('fs').readFileSync(path.join(SERVER, 'services/band-chao.js'), 'utf8');
  const cpRt = require('fs').readFileSync(path.join(SERVER, 'routes/admin/class-profile.js'), 'utf8');
  const uRt = require('fs').readFileSync(path.join(SERVER, 'routes/union.js'), 'utf8');

  // ① 晚自习：模型 → 录入对象排除 → 标注 → 写入白名单 → 录入拦截，缺一环就不算生效
  ok('班级模型有晚自习开关', /hasNightStudy: \{ type: Boolean, default: true \}/.test(cpModel));
  ok('晚自习考勤排除无晚自习的班（录入对象）', /moduleDef\.key === 'study_evening'\) profileFilter\.hasNightStudy = \{ \$ne: false \}/.test(bcSrc));
  ok('班级全景标注「本班无晚自习」', /mod\.key === 'study_evening'[\s\S]{0,80}本班无晚自习/.test(bcSrc));
  ok('写入白名单含 hasNightStudy', /setBool\('hasNightStudy', '是否有晚自习'\)/.test(cpRt));
  ok('批量标记白名单含 hasNightStudy', /FLAG_FIELDS = \['hasMorningExercise', 'hasMorningClass', 'hasNightStudy', 'hasMorningRun'\]/.test(cpRt));
  ok('筛选参数 noNightStudy 生效', /noNightStudy === '1'\) filter\.hasNightStudy = false/.test(cpRt));
  ok('录入时拦截「本班无晚自习」', /moduleDef\.key === 'study_evening' && target\.hasNightStudy === false/.test(uRt));
  ok('班级详情返回 hasNightStudy', /hasNightStudy: profile \? profile\.hasNightStudy !== false : true/.test(cpRt));

  // ② 楼名清单：两份分开、有清洗、有只读接口给填表端
  const gcModel = require('fs').readFileSync(path.join(SERVER, 'models/goal-config.js'), 'utf8');
  const cfgRt = require('fs').readFileSync(path.join(SERVER, 'routes/admin/config.js'), 'utf8');
  ok('配置模型有教学楼/宿舍楼两份清单', /buildings: \{[\s\S]{0,160}teaching: \{ type: \[String\]/.test(gcModel) && /dorm: \{ type: \[String\]/.test(gcModel));
  ok('楼名保存有清洗（去空白/去重/限长）', /function normalizeBuildings/.test(cfgRt) && /seen\.has\(name\)/.test(cfgRt));
  ok('楼名截断到 20 字、上限 60 个', /slice\(0, 20\)/.test(cfgRt) && /out\.length >= 60/.test(cfgRt));
  // 楼名权限独立成项（用户 2026-10-22「楼名管理需要权限项」）：
  // 读 building.view / building.manage / config.view（能管理就必须能查看，否则保存成功但列表 403）；
  // 写 building.manage / config.manage，且只持 building.manage 时不能顺手改计分/反作弊。
  ok('提供只读楼名接口（填表用）', /router\.get\(\s*'\/buildings'/.test(cfgRt) && /requirePermission\('building\.view', 'building\.manage', 'config\.view'\)/.test(cfgRt));
  const permModel = require('fs').readFileSync(path.join(SERVER, 'models/permission.js'), 'utf8');
  ok('权限目录有 building.view / building.manage', /'building\.view'/.test(permModel) && /'building\.manage'/.test(permModel));
  ok('只有 building.manage 的账号不能改计分/反作弊', /wantsOthers && !canConfig/.test(cfgRt));
  // ⚠️ /config 前缀上不能再挂 config.view：那会把 GET /buildings 一并挡掉，
  //    子路由里写再细的权限也无效（本轮踩过：改完子路由仍然 403）。
  const adminIdx = require('fs').readFileSync(path.join(SERVER, 'routes/admin/index.js'), 'utf8');
  ok('/config 前缀不预挂 config.view（否则楼名接口被挡）', /router\.use\('\/config', require\('\.\/config'\)\)/.test(adminIdx));
  ok('GET 整份配置仍要求 config.view', /requirePermission\('config\.view'\),\s*\n\s*wrap\(async \(req, res\) => \{\s*\n\s*const doc = await GoalConfig\.getSingleton/.test(cfgRt));

  // 前端：管理端有楼名页 + 教室/宿舍都先选楼
  const bdPage = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'config', 'buildings.js'), 'utf8');
  ok('楼名管理页存在且两份分栏', /addTeaching/.test(bdPage) && /addDorm/.test(bdPage));
  ok('保存时两份清单一起提交（避免清空另一份）', /teaching: field === 'teaching' \? list : this\.data\.teaching/.test(bdPage));
  const cmPage = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'class-manage', 'class-manage.js'), 'utf8');
  // 教室：楼名只能选、只有门号能填，且**一个完整对话框一次填完**
  //（用户 2026-10-22「尽量使用 Dialog 对话框完整的，现在你选择教学楼竟然还有弹窗让输入门号，
  //   直接让用户一次输入完」）—— 不再用 action sheet + 二次 wx.showModal
  const roomDlg = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'components', 'room-dialog', 'room-dialog.js'), 'utf8');
  const roomDlgWxml = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'components', 'room-dialog', 'room-dialog.wxml'), 'utf8');
  ok('教室改用完整对话框（不再是两步弹窗）', /roomTarget/.test(cmPage) && /onRoomConfirm/.test(cmPage) && !/roomPick\.composeRoom/.test(cmPage));
  ok('对话框内同时有楼号点选与门号输入', /bind:tap="tapBuilding"/.test(roomDlgWxml) && /bindinput="onRoomInput"/.test(roomDlgWxml));
  // 楼号区域只有胶囊、没有 input：取「楼号 label」到「门号 label」之间那段来判
  const bldSeg = (roomDlgWxml.match(/楼号[\s\S]*?门号/) || [''])[0] + (roomDlgWxml.match(/教学楼[\s\S]*?门号/) || [''])[0];
  ok('楼号只能从清单点选（无手打入口）', /rd-chip/.test(roomDlgWxml) && bldSeg.length > 0 && !/<input/.test(bldSeg), '楼号区域出现了输入框');
  ok('门号是唯一手输项且只收数字', /replace\([^)]*\\D[^)]*\)/.test(roomDlg));
  ok('床号固定 1~8 且可选', /bedOptions: \[1, 2, 3, 4, 5, 6, 7, 8\]/.test(roomDlg) && /showBed/.test(roomDlg));
  ok('未选楼号 / 未填门号时拒绝保存', /请先选择楼号/.test(roomDlg) && /请填写门号/.test(roomDlg));
  // 「我的班级」页的教室也不再内联输入（那等于允许手打楼名）
  const classWxml = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'class', 'class.wxml'), 'utf8');
  ok('我的班级页教室也不再内联手输', /cls-room-pick/.test(classWxml) && /bind:tap="openClassroom"/.test(classWxml));
  ok('两个页面都注册了 room-dialog', /room-dialog/.test(require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'class-manage', 'class-manage.json'), 'utf8')) && /room-dialog/.test(require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'class', 'class.json'), 'utf8')));
  // 宿舍抽屉：楼号只能点选 + 床位号固定 1~8
  const dormSheet = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'components', 'dorm-sheet', 'dorm-sheet.js'), 'utf8');
  ok('宿舍楼号只能点选（无可手打入口）', /tapBuilding/.test(dormSheet) && /bedOptions: \[1, 2, 3, 4, 5, 6, 7, 8\]/.test(dormSheet));
  ok('宿舍门号输入过滤非数字', /replace\(\/\\D\/g, ''\)/.test(dormSheet));
  ok('未选楼号 / 未填门号时拒绝保存', /请先选择楼号/.test(dormSheet) && /请填写门号/.test(dormSheet));
  // 系统设置里不再有「系统配置」中转页（用户 2026-10-21 第3条）
  const navSrc = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'utils', 'nav-groups.js'), 'utf8');
  ok('系统设置不再有「系统配置」入口', !/label: '系统配置'/.test(navSrc));
  ok('系统设置有楼名管理入口', /label: '楼名管理'/.test(navSrc));
}

// ===== 批量管理成员 + 院校部门联动筛选（用户 2026-10-21 第2条）=====
{
  const auSrc4 = require('fs').readFileSync(path.join(SERVER, 'routes/admin/union.js'), 'utf8');
  const memPage2 = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'union', 'members', 'members.js'), 'utf8');
  const memWxml2 = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'union', 'members', 'members.wxml'), 'utf8');

  // ① 批量接口：三种动作、逐条校验、部分失败不整体回滚
  ok('提供批量管理接口', /router\.post\(\s*'\/members\/bulk-update'/.test(auSrc4));
  ok('支持改职务/调部门/离任三种动作', /\['role', 'dept', 'leave'\]\.includes\(action\)/.test(auSrc4));
  ok('批量调部门逐条按成员校区校验归属', /assertDeptFitsCampus\(deptDoc, doc\.level, doc\.schoolId\)/.test(auSrc4));
  ok('批量改职务走职务-部门一致性校验', /assertRoleFitsDept\(nextRole, doc\.deptKey\)/.test(auSrc4));
  ok('批量离任是软删除（保留历史）', /action === 'leave'[\s\S]{0,200}doc\.status = 'left'/.test(auSrc4));
  ok('部分失败逐条报告（不整体回滚）', /result\.failed\.push\(\{ id, name: doc\.realName \|\| '', reason:/.test(auSrc4));
  ok('批量后逐人清身份缓存', /for \(const openid of touchedOpenids\) unionSvc\.clearIdentityCache\(openid\)/.test(auSrc4));

  // ② 院校筛选（口径变更过两次，当前是用户 2026-10-22 最终要求「我还是要全部成员」）：
  //   「全部成员」= 不限层级（campus=''）；「校学生会」= 只筛 level='school'；其余 = 具体校区。
  ok('院校筛选恢复「全部成员」且为第一项', /\[\{ id: '', name: '全部成员' \}, \{ id: 'school', name: '校学生会' \}\]/.test(memPage2));
  ok('默认选中全部成员', /campusOptions: \[\{ id: '', name: '全部成员' \}/.test(memPage2) && /campus: '',/.test(memPage2));
  ok('清除筛选回到全部成员', /campusIndex: 0, campus: '', deptFilterIndex: 0/.test(memPage2));
  // ⚠️ 「全部成员」下部门筛选必须列出**全部部门**：
  //    若把 campus='' 直接传给 deptFitsCampus，那里的 '' 表示「校级层」→ 只剩校级部门，
  //    各校区分会的部门全筛不出来（恢复「全部成员」后会立刻暴露的坑）。
  ok('全部成员下列出全部部门（不只剩校级）', /const fits = campusId \? all\.filter\(\(d\) => deptFitsCampus\(d, campusId\)\) : all;/.test(memPage2));

  // ③ 院校→部门联动
  ok('切换院校时重算部门筛选', /onCampusChange[\s\S]{0,700}buildDeptFilterOptions\(campus\)/.test(memPage2));
  ok('部门筛选按当前院校过滤', /buildDeptFilterOptions\(campusId\)[\s\S]{0,260}deptFitsCampus\(d, campusId\)/.test(memPage2));
  ok('切换院校后清空已选部门（避免与院校条件矛盾）', /onCampusChange[\s\S]{0,500}deptKeyFilter: ''/.test(memPage2));

  // ④ 批量 UI：勾选态必须预计算（WXML 不能调 indexOf —— 本仓库已踩两次）
  // 剥掉 WXML 注释再判：注释里引用了这个错误写法作为反面教材，直接匹配会误报。
  const memWxmlNoComment = memWxml2.replace(/<!--[\s\S]*?-->/g, '');
  ok('WXML 勾选态读预计算的 item.checked', /item\.checked/.test(memWxmlNoComment) && !/checkedIds\.indexOf/.test(memWxmlNoComment));
  ok('JS 提供 markChecked 预计算', /markChecked\(list, checkedIds\)/.test(memPage2));
  ok('批量操作栏三个动作齐全', /bind:tap="batchSetRole"/.test(memWxml2) && /bind:tap="batchSetDept"/.test(memWxml2) && /bind:tap="batchLeave"/.test(memWxml2));
}

// ===== WXSS 的 @import 必须指向真实文件（真实事故：删页面漏查样式引用 → 编译失败 → 点哪都跳不动）=====
{
  const fs = require('fs');
  const pathMod = require('path');
  const root = pathMod.join(__dirname, '..', 'miniprogram');
  const bad = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = pathMod.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'miniprogram_npm') walk(p);
        continue;
      }
      if (!e.name.endsWith('.wxss')) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/@import\s+["']([^"']+)["']/g)) {
        const spec = m[1];
        const target = spec.startsWith('/') ? pathMod.join(root, spec.slice(1)) : pathMod.resolve(pathMod.dirname(p), spec);
        if (!fs.existsSync(target)) bad.push(`${pathMod.relative(root, p)} -> ${spec}`);
      }
    }
  })(root);
  ok('所有 WXSS @import 都能解析（否则整个分包编译失败）', bad.length === 0, bad.join('; '));
}

// ===== JS require 相对路径必须真实存在（真实事故：写错层级 → 页面 JS 抛错 → 整页点击全失效）=====
{
  const fs = require('fs');
  const pathMod = require('path');
  const root = pathMod.join(__dirname, '..', 'miniprogram');
  const dangling = [];
  const exists = (b) => fs.existsSync(b) || fs.existsSync(b + '.js') || fs.existsSync(pathMod.join(b, 'index.js'));
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = pathMod.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'miniprogram_npm' && e.name !== 'node_modules') walk(p);
        continue;
      }
      if (!e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/require\(\s*["'](\.[^"']+)["']\s*\)/g)) {
        if (!exists(pathMod.resolve(pathMod.dirname(p), m[1]))) {
          dangling.push(`${pathMod.relative(root, p)} -> ${m[1]}`);
        }
      }
    }
  })(root);
  ok('JS 的 require 相对路径都真实存在', dangling.length === 0, dangling.join('; '));
}

// ===== 组件用了 .tt-* 公共类就必须开 styleIsolation: apply-shared =====
// 真实事故（2026-10-22）：room-dialog 漏配该项 → .tt-sheet* 骨架样式全部失效
// → 弹层内容塌成一列、关闭按钮跑中间、保存按钮拉满底部一整行。
{
  const fs = require('fs');
  const pathMod = require('path');
  const compDir = pathMod.join(__dirname, '..', 'miniprogram', 'components');
  const offenders = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = pathMod.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.name.endsWith('.wxml')) continue;
      const base = p.replace(/\.wxml$/, '');
      let j = {};
      try {
        j = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
      } catch (err) {
        continue;
      }
      if (j.component !== true) continue;
      const iso = String(j.styleIsolation || 'isolated');
      if (iso === 'apply-shared' || iso === 'shared') continue;
      // 组件自身 wxml / wxss 是否用到 .tt- 公共类
      const wxml = fs.readFileSync(p, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      let uses = /class="[^"]*\btt-[a-z]/.test(wxml);
      if (!uses && fs.existsSync(`${base}.wxss`)) {
        uses = /\.tt-[a-z]/.test(fs.readFileSync(`${base}.wxss`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''));
      }
      if (uses) offenders.push(pathMod.relative(pathMod.join(__dirname, '..', 'miniprogram'), p));
    }
  })(compDir);
  ok(
    '用到 .tt-* 公共类的组件都声明了 styleIsolation',
    offenders.length === 0,
    `${offenders.join('; ')}（公共骨架样式不生效，布局会塌）`
  );
}

// ===== 扫码加人（用户 2026-10-22）=====
{
  const urt = require('fs').readFileSync(path.join(SERVER, 'routes/union.js'), 'utf8');
  const invModel = require('fs').readFileSync(path.join(SERVER, 'models/union-invite.js'), 'utf8');
  const udJs = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'user-detail', 'user-detail.js'), 'utf8');
  const sjJs = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'union', 'scan-join', 'scan-join.js'), 'utf8');

  // 凭证模型：一次性 + 有期限 + 绑学生
  ok('凭证绑学生且一次性', /userId: \{ type: mongoose\.Schema\.Types\.ObjectId/.test(invModel) && /usedAt: \{ type: Date, default: null \}/.test(invModel));
  ok('凭证有过期时间与 TTL 索引', /expiresAt: \{ type: Date, required: true/.test(invModel) && /expireAfterSeconds: 0/.test(invModel));
  ok('凭证有效期 10 分钟', /TTL_MS = 10 \* 60 \* 1000/.test(invModel));

  // 三个接口
  ok('提供取凭证接口', /router\.get\(\s*'\/invite\/mine'/.test(urt));
  ok('提供预览接口', /router\.get\(\s*'\/invite\/:token'/.test(urt));
  ok('提供确认加入接口', /router\.post\(\s*'\/invite\/:token\/accept'/.test(urt));
  // 安全：替别人生成必须校权 —— 口径是「超管 或 能管成员 或 总管」。
  // 干部通常只有学生会身份、没有 union.manage，但扫码加人正需要他们替学生取码；
  // 超管持 '*' 却不是学生会成员，canManageMembers 返回 false，必须单独判。
  ok('替他人生成凭证需超管/能管成员/总管', /perms\.includes\('\*'\)[\s\S]{0,260}canManageMembers\(identity\)/.test(urt)
    && /只能生成自己的二维码/.test(urt));
  // 安全：加入动作走成员管理同一套闸门
  ok('加入动作复用 assertMemberManager', /accept'[\s\S]{0,600}await assertMemberManager\(req, identity\)/.test(urt));
  ok('加入时按干部身份校验部门校区', /assertDeptFitsCampus\(dept, level, schoolId\)/.test(urt));
  ok('凭证用掉即标记 usedAt', /doc\.usedAt = new Date\(\)/.test(urt));
  // 真正生成二维码图（用户 2026-10-22「二维码呢」）：后端用 qrcode 出 PNG dataURL，
  // 前端直接 <image src> 显示；生成失败要能回退到凭证串，不能整块空着。
  const pkg = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'server', 'package.json'), 'utf8'));
  ok('依赖里声明了 qrcode', !!pkg.dependencies.qrcode, String(pkg.dependencies.qrcode));
  ok('接口返回二维码图（dataURL）', /QRCode\.toDataURL\(qrText/.test(urt) && /qrImage,/.test(urt));
  ok('二维码内容就是 qrText（可被扫码识别）', /const qrText = `ttkp:\/\/union-invite\/\$\{doc\.token\}`/.test(urt));
  ok('生成失败仍返回 token（前端可回退）', /catch \(e\) \{\s*qrImage = '';\s*\}/.test(urt));
  const pfWxml2 = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'profile', 'profile.wxml'), 'utf8');
  ok('我的页显示二维码图并保留文本回退', /qr\.qrImage/.test(pfWxml2) && /<image[^>]*pf-qr-img/.test(pfWxml2));
  // 用户 2026-10-22「底下的请让主席团/部长用这个不使用，因为以后也可能用到这个码」
  ok('不再显示「请让主席团/部长用扫码加人」的固定文案', !/请让主席团 \/ 部长用「扫码加人」扫这张码/.test(pfWxml2));

  // 前端：所有用户都有码 + 干部「先选部门再扫」
  ok('学生主页有二维码入口', /openInviteQr/.test(udJs) && /\/api\/union\/invite\/mine\?userId=/.test(udJs));
  // 「我的」页顶部卡片可开自己的码（所有用户含教师，用户 2026-10-22）
  const pfJs = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'profile', 'profile.js'), 'utf8');
  const pfWxml = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'profile', 'profile.wxml'), 'utf8');
  ok('我的页顶部卡片有「我的码」按钮', /openMyQr/.test(pfJs) && /hero-qr-btn/.test(pfWxml));
  ok('我的码对所有用户开放（含教师）', /\/api\/union\/invite\/mine/.test(pfJs) && !/isTeacher[\s\S]{0,80}qrVisible/.test(pfWxml));
  // 干部扫码页：**先选部门**再扫，扫到即加入（用户 2026-10-22）
  ok('扫码页先选部门再扫', /deptReady/.test(sjJs) && /请先选择要加入的部门/.test(sjJs) && /disabled="\{\{!deptReady\}\}"/.test(require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'union', 'scan-join', 'scan-join.wxml'), 'utf8')));
  // 2026-10-28：accept 多了一个 role 参数（扫码时可直接指定 部员/副部长/部长）
  ok('扫到即加入（部门与职务随扫码请求提交）', /wx\.scanCode/.test(sjJs) && /accept\(token, dept, role\)/.test(sjJs) && /deptKey: dept\.key/.test(sjJs) && /role: role \|\| 'member'/.test(sjJs));
  ok('加错可当场撤回（走用户端 remove 接口）', /\/manage\/members\/\$\{r\.memberId\}\/remove/.test(sjJs));
  // ⚠️ scan-join 在三级目录，require 必须是 ../../../
  ok('扫码页 require 路径层级正确', /require\('\.\.\/\.\.\/\.\.\/utils\/request'\)/.test(sjJs));
}

// ===== tabBar 页的浮层不能低于 tabBar =====
// 真实事故（2026-10-22）：「我的」页二维码弹层 z-index:40，被自定义 tabBar(999) 整个盖住。
{
  const fs = require('fs');
  const pathMod = require('path');
  const root = pathMod.join(__dirname, '..', 'miniprogram');
  const app = JSON.parse(fs.readFileSync(pathMod.join(root, 'app.json'), 'utf8'));
  const tabPages = ((app.tabBar && app.tabBar.list) || []).map((t) => String(t.pagePath || '')).filter(Boolean);
  const offenders = [];
  for (const pagePath of tabPages) {
    const wxss = pathMod.join(root, `${pagePath}.wxss`);
    if (!fs.existsSync(wxss)) continue;
    const src = fs.readFileSync(wxss, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/([.#][\w-]+)\s*\{([^}]*)\}/g)) {
      const [, sel, body] = m;
      if (!/position:\s*fixed/.test(body)) continue;
      if (!/bottom:\s*0/.test(body)) continue;
      const z = body.match(/z-index:\s*(\d+)/);
      if (!z) continue;
      const v = Number(z[1]);
      if (v < 10 || v > 999) continue;
      offenders.push(`${pagePath} ${sel} z=${v}`);
    }
  }
  ok('tabBar 页的贴底浮层高于 tabBar(999)', offenders.length === 0, offenders.join('; '));
}

// ===== 登录刷新缓存 + 只读用户不显示写操作（用户 2026-10-22 第 1、2 条）=====
{
  const reqJs = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'utils', 'request.js'), 'utf8');
  // 第 1 条：三条登录路径（静默 / 绑定 / 一键）都必须刷新缓存
  ok('登录后刷新缓存', /function refreshCachesAfterLogin/.test(reqJs) && /permissionEpoch/.test(reqJs));
  ok('三条登录路径都调刷新', (reqJs.match(/refreshCachesAfterLogin\(data\.userInfo\)/g) || []).length >= 3, String((reqJs.match(/refreshCachesAfterLogin\(/g) || []).length));
  ok('清掉账号相关全局缓存', /g\.userInfo = userInfo \|\| null/.test(reqJs) && /g\.today !== undefined/.test(reqJs));
  ok('页面栈里已加载页面重算权限', /typeof p\.refreshPermission === 'function'/.test(reqJs));

  // 第 2 条：管理端页面必须提供 refreshPermission 并在 onShow 里调用
  const pages = [
    'packageAdmin/class-manage/class-manage.js',
    'packageAdmin/config/buildings.js',
    'packageAdmin/union/members/members.js',
    'packageAdmin/users/users.js',
    'packageAdmin/content/badges.js',
  ];
  for (const p of pages) {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', p), 'utf8');
    const short = p.split('/').slice(-1)[0];
    ok(`${short} 有 refreshPermission 且 onShow 调用`, /refreshPermission\(\)\s*\{/.test(src) && /onShow\(\)[\s\S]{0,200}refreshPermission\(\)/.test(src));
  }
  // config 三个子页由 section.js 注入 canManage
  const secJs = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'config', 'section.js'), 'utf8');
  ok('配置子页按 config.manage 区分只读/可写', /canManage: perms\.includes\('\*'\) \|\| perms\.includes\('config\.manage'\)/.test(secJs));
  for (const f of ['points', 'anticheat', 'reward-video']) {
    const wxml = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'config', `${f}.wxml`), 'utf8');
    ok(`${f} 保存栏只给可写用户`, /cfg-save-bar[^>]*wx:if="\{\{canManage\}\}"/.test(wxml));
  }
}

console.log(`\n契约自检：${checked} 项，失败 ${failed}`);
process.exit(failed ? 1 : 0);
