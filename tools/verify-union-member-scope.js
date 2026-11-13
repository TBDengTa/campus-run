/**
 * 端到端验证：学生会成员管理范围 + 干部直接添加成员（用户 2026-11-12）
 *
 * 用户口径：
 *   「学生会正副主席应该可以管理或增加本院校相应部门成员，正副部长可以管理或增加本部门的成员，
 *     全校的正副主席可以管理全校的院系和部门」
 *
 * 这个脚本真连库、真挂 routes/union.js（auth 按 header 打桩成指定 actor），
 * 用**临时用户 / 临时部门 / 临时成员**跑完整链路，跑完删干净并核对残留为 0。
 *
 * 覆盖：
 *   ① 分院主席团：join-options 只给本院（不出现外校区）
 *   ② 分院主席团：候选人只搜到本院学生（不外泄外校区的学生名单）
 *   ③ 分院主席团：可加本院任意部门；加外校区 → 403
 *   ④ 分院部长：可加本部门本院成员；加别部门 / 外校区 → 403
 *   ⑤ 校主席团：可加校级 + 任意校区任意部门
 *   ⑥ 副主席：不能授予主席（不能凭空造平级）；可授予副主席
 *   ⑦ 教师账号 → 逐条失败并给原因（不是整批 500）
 *   ⑧ 非成员 → 403
 *   ⑨ 清理核对：临时用户 / 成员 / 部门 / 组织全部删除
 *
 * 用法：node tools/verify-union-member-scope.js
 */
const path = require('path');
const serverDir = path.join(__dirname, '..', 'server');
const config = require(path.join(serverDir, 'src', 'config'));
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));
const express = require(path.join(serverDir, 'node_modules', 'express'));

const User = require(path.join(serverDir, 'src', 'models', 'user'));
const Organization = require(path.join(serverDir, 'src', 'models', 'organization'));
const UnionMember = require(path.join(serverDir, 'src', 'models', 'union-member'));
const UnionDepartment = require(path.join(serverDir, 'src', 'models', 'union-department'));
const unionSvc = require(path.join(serverDir, 'src', 'services', 'union'));

let failed = 0;
function assert(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ← ' + JSON.stringify(extra)}`);
  if (!cond) failed += 1;
}

const TS = Date.now();
const TAG = `ums_${TS}`;
const uniq = (s) => `${s}_${TS}`;

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });

  const createdUsers = [];
  const createdMembers = [];
  const createdDepts = [];
  const createdOrgs = [];

  // ---- 0) 起真实路由（auth 打桩）----
  const authMw = require(path.join(serverDir, 'src', 'middlewares', 'auth'));
  const actors = new Map();
  authMw.auth = (req, res, next) => {
    const who = req.headers['x-actor'] || '';
    if (who === 'anon') return res.status(401).json({ code: 401, message: '未登录' });
    const doc = actors.get(who);
    if (!doc) return res.status(401).json({ code: 401, message: 'unknown actor' });
    req.user = doc;
    next();
  };
  const unionRouter = require(path.join(serverDir, 'src', 'routes', 'union'));
  const app = express();
  app.use(express.json());
  app.use('/api/union', unionRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code || 500, message: err.message }));
  const port = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s.address().port));
  });
  const BASE = `http://127.0.0.1:${port}`;
  const call = async (who, method, url, body) => {
    const res = await fetch(`${BASE}${url}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-actor': who },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  try {
    // ---- 1) 两个校区 + 各自一个院系（候选人范围靠 departmentId 展开）----
    const schools = await Organization.find({ type: 'school' }).sort({ name: 1 }).limit(2).lean();
    if (schools.length < 2) {
      console.log('！库里不足 2 个院校（organizations.type=school），无法验证跨校区越权，跳过');
      process.exit(0);
    }
    const s1 = schools[0];
    const s2 = schools[1];
    const mkOrg = async (name, type, parentId) => {
      const doc = await Organization.create({ name, type, parentId: parentId || null });
      createdOrgs.push(doc._id);
      return doc;
    };
    const d1 = await mkOrg(uniq('验证系'), 'department', s1._id);
    const d2 = await mkOrg(uniq('验证系'), 'department', s2._id);

    // ---- 2) 临时业务部门（两校区共用）----
    const lifeKey = uniq('vlife');
    const studyKey = uniq('vstudy');
    await UnionDepartment.create({ key: lifeKey, name: '验证生活部', scope: 'both', enabled: true });
    await UnionDepartment.create({ key: studyKey, name: '验证学习部', scope: 'both', enabled: true });
    createdDepts.push(lifeKey, studyKey);

    // ---- 3) 临时身份 ----
    const mkUser = async (suffix, extra = {}) => {
      const doc = await User.create({
        openid: `${TAG}_${suffix}`,
        account: `${TAG}_${suffix}`,
        realName: `验证-${suffix}`,
        role: 'student',
        className: `${TAG}_C`,
        ...extra,
      });
      createdUsers.push(doc._id);
      return doc;
    };
    const branchPres = await mkUser('branch_pres');
    const branchVice = await mkUser('branch_vice');
    const branchMinister = await mkUser('branch_min');
    const schoolPres = await mkUser('school_pres');
    const stuS1 = await mkUser('stu_s1', { departmentId: d1._id, schoolName: s1.name });
    const stuS1b = await mkUser('stu_s1b', { departmentId: d1._id, schoolName: s1.name });
    const stuS2 = await mkUser('stu_s2', { departmentId: d2._id, schoolName: s2.name });
    const stuS2b = await mkUser('stu_s2b', { departmentId: d2._id, schoolName: s2.name });
    const teacher = await mkUser('teacher', { role: 'teacher' });
    const outsider = await mkUser('outsider');

    const mkMember = async (user, role, deptKey, level, schoolId, schoolName) => {
      const doc = await UnionMember.create({
        userId: user._id,
        openid: user.openid,
        realName: user.realName,
        studentId: user.studentId || '',
        className: user.className || '',
        level,
        schoolId: schoolId || null,
        schoolName: schoolName || '',
        deptKey,
        deptName: deptKey,
        role,
        status: 'active',
      });
      createdMembers.push(doc._id);
      unionSvc.clearIdentityCache(user.openid);
      return doc;
    };
    await mkMember(branchPres, 'president', 'presidium', 'branch', s1._id, s1.name);
    await mkMember(branchVice, 'vice_president', 'presidium', 'branch', s1._id, s1.name);
    await mkMember(branchMinister, 'minister', lifeKey, 'branch', s1._id, s1.name);
    await mkMember(schoolPres, 'president', 'presidium', 'school', null, '');

    actors.set('branchPres', branchPres);
    actors.set('branchVice', branchVice);
    actors.set('branchMinister', branchMinister);
    actors.set('schoolPres', schoolPres);
    actors.set('outsider', outsider);

    // ---- 4) 分院主席团：join-options 只给本院 ----
    console.log('\n[1] 分院主席团 join-options 范围');
    const opts = await call('branchPres', 'GET', '/api/union/manage/join-options?manage=1');
    assert(opts.status === 200, 'join-options 可访问', opts);
    const depts = (opts.data && opts.data.data && opts.data.data.departments) || [];
    const campuses = (opts.data && opts.data.data && opts.data.data.campuses) || [];
    assert(campuses.length === 1 && String(campuses[0].id) === String(s1._id), '只下发本院校区', campuses);
    assert(!depts.some((d) => d.level === 'school'), '分院干部没有「校学生会」层选项', depts.map((d) => d.level));
    assert(depts.some((d) => d.key === 'presidium' && d.level === 'branch'), '可选本院主席团', depts.map((d) => d.key));
    assert(depts.some((d) => d.key === lifeKey && d.level === 'branch' && String(d.schoolId) === String(s1._id)), '可选本院生活部', depts);

    // 成员列表的「部门筛选」也必须收敛：不能列出外校区部门（能选到却永远 0 条）
    const list = await call('branchPres', 'GET', '/api/union/manage/members');
    assert(list.status === 200, '成员列表可访问', list);
    const listDepts = (list.data && list.data.data && list.data.data.departments) || [];
    assert(
      listDepts.every((d) => !d.schoolId || String(d.schoolId) === String(s1._id)),
      '部门筛选只含本院（不列外校区）',
      listDepts
    );
    assert(list.data.data.canTransfer === true, '分院主席团可调部门', list.data.data.canTransfer);

    // ---- 5) 分院主席团：候选人只搜到本院学生 ----
    console.log('\n[2] 分院主席团候选人范围');
    const cand = await call('branchPres', 'GET', `/api/union/manage/members/candidates?keyword=${encodeURIComponent('验证-stu')}&limit=50`);
    assert(cand.status === 200, '候选人接口可访问', cand);
    const candIds = ((cand.data && cand.data.data && cand.data.data.list) || []).map((x) => x.userId);
    assert(candIds.includes(String(stuS1._id)), '能搜到本院学生', candIds);
    assert(!candIds.includes(String(stuS2._id)), '搜不到外校区学生', candIds);

    // ---- 6) 分院主席团：加本院任意部门 OK；跨校区 403 ----
    console.log('\n[3] 分院主席团新增成员');
    const addOk = await call('branchPres', 'POST', '/api/union/manage/members', {
      level: 'branch',
      schoolId: String(s1._id),
      deptKey: lifeKey,
      role: 'member',
      userIds: [String(stuS1._id)],
    });
    assert(addOk.status === 200 && addOk.data.data.created === 1, '可加本院生活部成员', addOk);
    const addCross = await call('branchPres', 'POST', '/api/union/manage/members', {
      level: 'branch',
      schoolId: String(s2._id),
      deptKey: lifeKey,
      role: 'member',
      userIds: [String(stuS2._id)],
    });
    assert(addCross.status === 403, '不能加外校区成员', addCross);
    const addSchool = await call('branchPres', 'POST', '/api/union/manage/members', {
      level: 'school',
      deptKey: lifeKey,
      role: 'member',
      userIds: [String(stuS1b._id)],
    });
    assert(addSchool.status === 403, '不能加校级成员', addSchool);

    // ---- 7) 分院部长：本部门 OK；别部门 / 外校区 403 ----
    console.log('\n[4] 分院部长新增成员');
    const addMinOk = await call('branchMinister', 'POST', '/api/union/manage/members', {
      level: 'branch',
      schoolId: String(s1._id),
      deptKey: lifeKey,
      role: 'member',
      userIds: [String(stuS1b._id)],
    });
    assert(addMinOk.status === 200 && addMinOk.data.data.created === 1, '可加本部门本院成员', addMinOk);
    const addMinOtherDept = await call('branchMinister', 'POST', '/api/union/manage/members', {
      level: 'branch',
      schoolId: String(s1._id),
      deptKey: studyKey,
      role: 'member',
      userIds: [String(stuS2b._id)],
    });
    assert(addMinOtherDept.status === 403, '不能加别部门成员', addMinOtherDept);
    const addMinCross = await call('branchMinister', 'POST', '/api/union/manage/members', {
      level: 'branch',
      schoolId: String(s2._id),
      deptKey: lifeKey,
      role: 'member',
      userIds: [String(stuS2._id)],
    });
    assert(addMinCross.status === 403, '不能加外校区成员', addMinCross);

    const minList = await call('branchMinister', 'GET', '/api/union/manage/members');
    const minDepts = (minList.data && minList.data.data && minList.data.data.departments) || [];
    assert(
      minList.status === 200 && minDepts.every((d) => d.key === lifeKey),
      '部长列表的部门筛选项只含本部门',
      minDepts
    );
    assert(minList.data.data.canTransfer === false, '部长不可调部门（不显示假入口）', minList.data.data.canTransfer);

    // ---- 8) 校主席团：校级 + 任意校区 ----
    console.log('\n[5] 校主席团新增成员');
    const addSchoolLevel = await call('schoolPres', 'POST', '/api/union/manage/members', {
      level: 'school',
      deptKey: lifeKey,
      role: 'member',
      userIds: [String(stuS1b._id)],
    });
    assert(addSchoolLevel.status === 200 && addSchoolLevel.data.data.created === 1, '可加校级成员', addSchoolLevel);
    const addAnyCampus = await call('schoolPres', 'POST', '/api/union/manage/members', {
      level: 'branch',
      schoolId: String(s2._id),
      deptKey: studyKey,
      role: 'minister',
      userIds: [String(stuS2._id)],
    });
    assert(addAnyCampus.status === 200 && addAnyCampus.data.data.created === 1, '可加任意校区任意部门', addAnyCampus);

    // ---- 9) 副主席授予上限 ----
    console.log('\n[6] 副主席授予上限');
    const viceGrantPresident = await call('branchVice', 'POST', '/api/union/manage/members', {
      level: 'branch',
      schoolId: String(s1._id),
      deptKey: 'presidium',
      role: 'president',
      userIds: [String(stuS1b._id)],
    });
    assert(viceGrantPresident.status === 403, '副主席不能授予主席', viceGrantPresident);
    const viceGrantVice = await call('branchVice', 'POST', '/api/union/manage/members', {
      level: 'branch',
      schoolId: String(s1._id),
      deptKey: 'presidium',
      role: 'vice_president',
      userIds: [String(stuS1b._id)],
    });
    assert(viceGrantVice.status === 200 && viceGrantVice.data.data.created === 1, '副主席可授予副主席', viceGrantVice);

    // ---- 10) 教师 / 非成员 ----
    console.log('\n[7] 边界');
    const addTeacher = await call('schoolPres', 'POST', '/api/union/manage/members', {
      level: 'school',
      deptKey: lifeKey,
      role: 'member',
      userIds: [String(teacher._id)],
    });
    assert(addTeacher.status === 200 && addTeacher.data.data && addTeacher.data.data.failed && addTeacher.data.data.failed.length === 1, '教师账号逐条失败并给原因', addTeacher);
    const addOutsider = await call('outsider', 'POST', '/api/union/manage/members', {
      level: 'school',
      deptKey: lifeKey,
      role: 'member',
      userIds: [String(stuS1._id)],
    });
    assert(addOutsider.status === 403, '非学生会成员不能加人', addOutsider);
  } catch (e) {
    failed += 1;
    console.error('运行失败：', e);
  } finally {
    // ---- 11) 清理（先删成员，再删用户 / 部门 / 组织）----
    await UnionMember.deleteMany({ userId: { $in: createdUsers } });
    await UnionMember.deleteMany({ _id: { $in: createdMembers } });
    await User.deleteMany({ _id: { $in: createdUsers } });
    await UnionDepartment.deleteMany({ key: { $in: createdDepts } });
    await Organization.deleteMany({ _id: { $in: createdOrgs } });
    unionSvc.clearIdentityCache();

    const leftMembers = await UnionMember.countDocuments({ userId: { $in: createdUsers } });
    const leftUsers = await User.countDocuments({ _id: { $in: createdUsers } });
    const leftDepts = await UnionDepartment.countDocuments({ key: { $in: createdDepts } });
    const leftOrgs = await Organization.countDocuments({ _id: { $in: createdOrgs } });
    assert(
      leftMembers + leftUsers + leftDepts + leftOrgs === 0,
      '清理核对：临时数据残留为 0',
      { leftMembers, leftUsers, leftDepts, leftOrgs }
    );

    await mongoose.disconnect();
    console.log(`\n成员管理范围端到端：${failed} 项失败`);
    process.exit(failed ? 1 : 0);
  }
})();
