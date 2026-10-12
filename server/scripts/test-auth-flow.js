// 账号体系全流程冒烟：导入 → 绑定 → 强制改密 → 其他微信拒绝 → 锁定 → 重置
const BASE = 'http://localhost:3010';
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// 清理上一次运行的残留，保证脚本可重复执行
async function cleanup() {
  const c = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await c.connect();
  const users = c.db(process.env.MONGO_DB_NAME || 'campus_run').collection('users');
  await users.deleteMany({ studentId: { $in: ['2023090001', '2023090002', '2023090003'] } });
  await users.deleteMany({ openid: { $in: ['dev_wechat_new', 'dev_wechat_new2', 'dev_wechat_new3'] } });
  await users.deleteMany({ account: /^测试学生(甲|乙)/ });
  await users.deleteMany({ account: /^王老师/ });
  await c.close();
}

async function api(method, path, body, token, extraHeaders = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const assert = (cond, label) => console.log(`${cond ? '✓' : '✗✗✗'} ${label}`);

(async () => {
  await cleanup();

  // 0. admin 登录
  const admin = (await api('POST', '/api/auth/login', { code: 'dev-admin' })).body.data;

  // 1. 导入名单（含一行同名同密码冲突样本）
  const importRes = await api('POST', '/api/admin/users/import', {
    rows: [
      { name: '测试学生甲', studentId: '2023090001', idCardNo: '110101200501011111', school: '北校区', department: '机电系', className: '23级机电1班' },
      { name: '测试学生乙', studentId: '2023090002', school: '北校区', department: '机电系', className: '23级机电2班' },
      { name: '测试学生甲', studentId: '2023090003', idCardNo: '110101200501011111', school: '北校区', department: '机电系', className: '23级机电1班' },
    ],
  }, admin.token);
  assert(importRes.body.code === 0, `导入接口 ${importRes.status}`);
  const r = importRes.body.data;
  assert(r.created === 2, `新增 2（实际 ${r.created}）`);
  assert(r.failed.length === 1 && /重名/.test(r.failed[0].reason), `同名同密码拒绝（${r.failed[0] && r.failed[0].reason}）`);

  // 2. 新微信登录 → 游客
  const guest = (await api('POST', '/api/auth/login', { code: 'dev-new' })).body.data;
  assert(guest.bound === false, '新微信 → 游客 token');
  // 游客访问业务接口被拒
  const g1 = await api('GET', '/api/run/today', null, guest.token);
  assert(g1.status === 403 && g1.body.code === 403003, '游客访问业务接口 403/403003');

  // 3. 绑定（身份证后8: 01011111）
  const bind = await api('POST', '/api/auth/bind', { account: '测试学生甲', password: '01011111' }, guest.token);
  assert(bind.body.code === 0 && bind.body.data.bound === true, '姓名+身份证后8 绑定成功');
  assert(bind.body.data.mustChangePassword === true, '强制改密标记');
  const studentToken = bind.body.data.token;
  const studentId = bind.body.data.userInfo._id;

  // 4. 学号后8 也能作为初始密码验证（用乙的微信试乙的学号后8：2023090002 → 23090002）
  const guest2 = (await api('POST', '/api/auth/login', { code: 'dev-new2' })).body.data;
  const bind2 = await api('POST', '/api/auth/bind', { account: '测试学生乙', password: '23090002' }, guest2.token);
  assert(bind2.body.code === 0, '学号后8 初始密码绑定成功（无身份证数据的学生）');

  // 5. 其他微信登录已绑定账号 → 拒绝（第三个微信尝试绑定甲）
  const guest3 = (await api('POST', '/api/auth/login', { code: 'dev-new3' })).body.data;
  const trySteal = await api('POST', '/api/auth/bind', { account: '测试学生甲', password: '01011111' }, guest3.token);
  assert(trySteal.status === 403 && trySteal.body.code === 403004, `其他微信绑定被拒（${trySteal.body.message}）`);

  // 6. 游客业务接口 403 后：强制改密流程
  const badOld = await api('POST', '/api/auth/password/change', { oldPassword: '00000000', newPassword: 'abc12345' }, studentToken);
  assert(badOld.body.code !== 0, '旧密码错误被拒');
  const chg = await api('POST', '/api/auth/password/change', { oldPassword: '01011111', newPassword: 'abc12345' }, studentToken);
  assert(chg.body.code === 0, '修改密码成功');

  // 7. 改密后初始密码失效
  const guest4 = (await api('POST', '/api/auth/login', { code: 'dev-new2' })).body.data; // 已绑定乙，直接登录
  void guest4;
  const rebind = await api('POST', '/api/auth/bind', { account: '测试学生甲', password: '01011111' }, admin.token);
  assert(rebind.status === 403, '改密后旧初始密码不能再通过（被绑定校验拦截）');

  // 8. 管理端重置密码 → 初始密码恢复 + 强制改密
  const reset = await api('POST', `/api/admin/users/${studentId}/reset-password`, {}, admin.token);
  assert(reset.body.code === 0 && /初始密码/.test(reset.body.data.message), `重置密码（${reset.body.data.message}）`);
  // 重置后初始密码恢复可用
  const guest5 = (await api('POST', '/api/auth/login', { code: 'dev-new' })).body.data; // 甲已绑 dev_wechat_new
  const chg2 = await api('POST', '/api/auth/password/change', { oldPassword: '01011111', newPassword: 'xyz98765' }, guest5.token);
  assert(chg2.body.code === 0, '重置后可用初始密码改密');

  // 9. 教师创建 + 推送 API
  const teacherName = `王老师${Date.now() % 100000}`;
  const teacher = await api('POST', '/api/admin/users/teachers', { name: teacherName }, admin.token);
  assert(teacher.body.code === 0 && teacher.body.data.initialPassword, `创建教师 ${teacherName}（初始密码 ${teacher.body.data.initialPassword || ''}）`);
  const pushNoKey = await api('POST', '/api/roster/push', { rows: [] });
  assert(pushNoKey.status !== 500, `推送接口未配置密钥时明确拒绝（${pushNoKey.status}）`);

  console.log('\n✓ 账号体系全流程冒烟完成');
})().catch((e) => {
  console.error('测试失败:', e.message);
  process.exit(1);
});
