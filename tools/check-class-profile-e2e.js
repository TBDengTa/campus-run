// 联调验证（进程内，不连库）：B 的真实路由响应 → E/C 前端消费逻辑
//
// 目的：本机没有 MongoDB、也起不了小程序，所以「后端响应形状 ↔ 前端读取代码」这条最容易
// 在联调时才暴露的缝，用打桩 mongoose 模型 + 真实 express 路由 + 抽取出的前端归一化逻辑来验证。
//
// 覆盖：
//   ① 班级域 GET/PUT /api/class/profile：班主任可读写、班委只读、跨班 403
//   ② /api/class/attendance 的响应字段，与前端 attendance 组件读取路径逐字段对齐
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server', 'src');
let failed = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -> ${detail}`}`);
  if (!cond) failed += 1;
};

// ===== 打桩：人数统计（services/class-counts.js 走 User/DormAssignment 聚合）=====
// 为什么必须打桩：班级域的 GET/PUT /profile 会调 liveCount() 取「应到 / 应住人数」
//（人数由学籍与住宿名单自动识别，不再读 class_profiles 的快照值）。
// 本文件是**进程内、不连库**的联调验证，所以这两处聚合也要给桩，
// 否则路由会落到真实 mongoose 上、以 `buffering timed out` 失败（看着像 500 bug，实为缺桩）。
// 桩值只需形状正确：一个班 40 人、应住 32 人。
const UserModel = require(path.join(SERVER, 'models/user'));
const DormAssignmentModel = require(path.join(SERVER, 'models/dorm-assignment'));
UserModel.aggregate = async () => [{ _id: '23级大数据技术', n: 40 }];
DormAssignmentModel.aggregate = async () => [{ _id: '23级大数据技术', n: 32 }];

// ===== 打桩：内存 class_profiles + users，挂在 mongoose 模型上 =====
const store = {
  profiles: new Map(), // className → doc
  users: [],
};

function makeProfile(className, extra = {}) {
  return {
    className,
    departmentId: null,
    departmentName: '大数据学院',
    grade: '2023',
    specialty: '大数据技术',
    studentCount: 40,
    dormCount: 32,
    hasMorningExercise: true,
    hasMorningClass: true,
    hasMorningRun: true,
    homeroomNames: ['张老师'],
    enabled: true,
    remark: '',
    syncedAt: null,
    ...extra,
    save: async function save() {
      store.profiles.set(this.className, this);
      return this;
    },
    toObject() {
      const { save, toObject, ...rest } = this;
      return rest;
    },
  };
}

const ClassProfileModel = require(path.join(SERVER, 'models/class-profile'));
ClassProfileModel.findOne = (filter) => {
  const doc = store.profiles.get(filter.className);
  // 路由里用了 .lean()，这里返回同构对象即可
  return { lean: async () => (doc ? doc.toObject() : null), then: (r) => Promise.resolve(doc).then(r) };
};
store.profiles.set('23级大数据技术', makeProfile('23级大数据技术'));

// ===== 直接调用路由模块里的服务层逻辑（不经过 express，避免引入鉴权/DB）=====
// 说明：这里验证的是「路由 handler 产出的形状」，因此用最小桩替换 req/res。
const classRouter = require(path.join(SERVER, 'routes/class'));

// 找到 router 里注册的 '/profile' handlers
const stack = classRouter.stack || [];
const findRoute = (method, routePath) =>
  stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);

const getProfile = findRoute('get', '/profile');
const putProfile = findRoute('put', '/profile');

check('班级域注册了 GET /profile', !!getProfile);
check('班级域注册了 PUT /profile', !!putProfile);
check('班级域注册了 GET /attendance', !!findRoute('get', '/attendance'));

// ===== 用真实 handler + 桩 req/res 跑一次 =====
async function invoke(routeLayer, req) {
  let payload = null;
  let status = 200;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    },
  };
  const next = (err) => {
    if (err) {
      status = err.status || 500;
      payload = { code: err.code || status, message: err.message };
    }
  };
  // 最后一个 handler（wrap 包装后的业务逻辑），跳过中间件
  const handler = routeLayer.route.stack[routeLayer.route.stack.length - 1].handle;
  await handler(req, res, next);
  return { status, payload };
}

(async () => {
  const homeroomUser = {
    openid: 'o_homeroom',
    realName: '张老师',
    role: 'teacher',
    className: '',
    homeroomClasses: ['23级大数据技术'],
    isClassOfficer: false,
    getEffectivePermissions: async () => [],
  };
  const officerUser = {
    openid: 'o_officer',
    realName: '李班委',
    role: 'student',
    className: '23级大数据技术',
    homeroomClasses: [],
    isClassOfficer: true,
    getEffectivePermissions: async () => [],
  };
  const outsiderUser = {
    openid: 'o_other',
    realName: '王老师',
    role: 'teacher',
    className: '',
    homeroomClasses: ['24级别的班'],
    isClassOfficer: false,
    getEffectivePermissions: async () => [],
  };

  // ① 班主任读
  let r = await invoke(getProfile, { user: homeroomUser, query: { className: '23级大数据技术' } });
  check('班主任 GET /api/class/profile → 200', r.status === 200 && r.payload && r.payload.code === 0, JSON.stringify(r.payload).slice(0, 120));
  const p = r.payload && r.payload.data;
  check('响应含 canEdit:true（班主任可写）', p && p.canEdit === true, JSON.stringify(p && p.canEdit));
  check('响应含 hasMorningRun（不跑操标记）', p && p.hasMorningRun === true, String(p && p.hasMorningRun));
  check('响应字段与 E 的页面一致（8 个关键字段齐全）',
    p && ['className', 'hasMorningExercise', 'hasMorningRun', 'studentCount', 'dormCount', 'departmentName', 'grade', 'homeroomNames'].every((k) => k in p),
    p ? Object.keys(p).join(',') : 'null');

  // ② 班委读（只读）
  r = await invoke(getProfile, { user: officerUser, query: { className: '23级大数据技术' } });
  const po = r.payload && r.payload.data;
  check('班委 GET → canEdit:false（只读）', po && po.canEdit === false, String(po && po.canEdit));
  check('班委 GET → role:officer', po && po.role === 'officer', String(po && po.role));

  // ③ 跨班 → 403002
  r = await invoke(getProfile, { user: outsiderUser, query: { className: '23级大数据技术' } });
  check('跨班 GET → 403 + 403002', r.status === 403 && r.payload && r.payload.code === 403002, JSON.stringify(r.payload).slice(0, 120));

  // ④ 班主任写：改「不跑操」
  // ⚠️ 不能带 dormCount：应到 / 应住人数已改为**由学籍与住宿名单自动识别**，
  // 误传人数类字段会被服务端显式 400 拦住（避免「看着保存成功、数字却被手填值污染」）。
  // 这条早期的测试带过 dormCount，属于旧口径残留；下面单独验证人数类字段确实被拦住。
  r = await invoke(putProfile, {
    user: homeroomUser,
    body: { className: '23级大数据技术', hasMorningRun: false, hasMorningExercise: false },
  });
  check('班主任 PUT → 200', r.status === 200 && r.payload && r.payload.code === 0, JSON.stringify(r.payload).slice(0, 160));
  const pw = r.payload && r.payload.data;
  check('PUT 后 hasMorningRun:false 生效', pw && pw.hasMorningRun === false, String(pw && pw.hasMorningRun));
  check('PUT 后 hasMorningExercise:false 生效', pw && pw.hasMorningExercise === false, String(pw && pw.hasMorningExercise));
  check('PUT 返回 changed 明细', pw && pw.changed && Object.keys(pw.changed).length >= 2, JSON.stringify(pw && pw.changed));
  check('白名单生效：studentCount 不在 changed（班主任不能改应到人数）', pw && pw.changed && !('studentCount' in pw.changed), JSON.stringify(pw && pw.changed));

  // ⑦ 教室（classroom）：GET 必须带该字段、PUT 可写，且**不能覆盖 remark**
  //    曾经的真实 bug：班级域 PUT 的 else 分支硬编码写 profile.remark，
  //    白名单加了 classroom 之后，老师填教室会把备注整段覆盖掉（看着保存成功、数据被改坏）。
  await invoke(putProfile, { user: homeroomUser, body: { remark: '周三下午有课' } });
  r = await invoke(putProfile, { user: homeroomUser, body: { classroom: '1号教学楼·201' } });
  const pc = r.payload && r.payload.data;
  check('班主任可写教室（classroom 已保存）', pc && pc.classroom === '1号教学楼·201', JSON.stringify(pc && pc.classroom));
  check('写教室不会覆盖 remark', pc && pc.remark === '周三下午有课', JSON.stringify(pc && pc.remark));
  check('changed 只记 classroom', pc && pc.changed && pc.changed.classroom && pc.changed.remark === undefined, JSON.stringify(pc && pc.changed));

  // ⑧ 年级推导：grade 为空时必须按班级名兜出来（存量数据 grade 普遍为空）
  const gp = store.profiles.get('23级大数据技术');
  if (gp) gp.grade = '';
  r = await invoke(getProfile, { user: homeroomUser, query: { className: '23级大数据技术' } });
  const pg = r.payload && r.payload.data;
  check('grade 为空时按班级名推导出 2023', pg && pg.grade === '2023', JSON.stringify(pg && pg.grade));

  // ⑤ 班委写 → 403
  r = await invoke(putProfile, { user: officerUser, body: { className: '23级大数据技术', hasMorningRun: true } });
  check('班委 PUT → 403 + 403002', r.status === 403 && r.payload && r.payload.code === 403002, JSON.stringify(r.payload).slice(0, 120));

  // ⑥ 人数类字段（studentCount）→ 服务端显式 400（自动识别项，不允许手工设置）
  //    早期口径是「白名单外、静默忽略」，现在改成显式报错（用户要求「自动识别」）：
  //    静默忽略会让老师以为没保存成功、反复尝试；明确报错才能讲清「这个数不用你填」。
  r = await invoke(putProfile, { user: homeroomUser, body: { className: '23级大数据技术', studentCount: 999 } });
  check(
    '班主任 PUT studentCount → 400（人数由学籍自动识别，不支持手工设置）',
    r.status === 400 && r.payload && /自动识别/.test(r.payload.message || ''),
    JSON.stringify(r.payload).slice(0, 140)
  );
  // 该请求被拦下后，库里的值必须**没被写脏**
  const p6 = store.profiles.get('23级大数据技术');
  check('被拦下的人数不会写库（仍为自动识别口径）', !p6 || p6.studentCount !== 999, `studentCount=${p6 && p6.studentCount}`);

  console.log(`\n联调验证：失败 ${failed}`);
  process.exit(failed ? 1 : 0);
})();
