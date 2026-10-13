// 用户管理新功能冒烟：filters / 筛选 / 创建 / 编辑 / 双模式导入 / 详情运动 / 删除
const BASE = 'http://localhost:3010';

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const b = await res.json();
  return { status: res.status, data: b.data, message: b.message, code: b.code };
}

const assert = (cond, label) => console.log(`${cond ? '✓' : '✗✗✗'} ${label}`);

(async () => {
  const admin = (await api('POST', '/api/auth/login', { code: 'dev-admin' })).data;
  const t = admin.token;

  // 1. filters
  const f = await api('GET', '/api/admin/users/filters', null, t);
  assert(f.status === 200 && Array.isArray(f.data.schools), `filters ✓ schools=${f.data.schools.length} grades=${JSON.stringify(f.data.grades)} 日目标=${JSON.stringify(f.data.dailyGoals)}`);

  // 2. 院校筛选
  const schoolName = f.data.schools[0];
  const l = await api('GET', `/api/admin/users?school=${encodeURIComponent(schoolName)}&limit=3`, null, t);
  assert(l.status === 200, `院校筛选 ✓ total=${l.data.total}`);

  // 3. 创建学生账户（含学籍）
  const uniq = String(Date.now()).slice(-6); // 6 位数字，拼出 8 位学号
  const stu = await api('POST', '/api/admin/users/account', {
    role: 'student', account: `冒烟学生${uniq}`, gender: 1, birthdate: '2005-06-15',
    school: schoolName, department: f.data.departments[0] || '机电系', specialty: '大数据技术', className: `23级冒烟1班`, studentId: `2023${uniq}`,
  }, t);
  assert(stu.status === 200 && stu.data.initialPassword, `创建学生账户 ✓ 密码=${stu.data.initialPassword}`);
  const newId = stu.data._id;

  // 4. 编辑账户
  const ed = await api('PUT', `/api/admin/users/${newId}/profile`, { specialty: '人工智能', gender: 2 }, t);
  assert(ed.status === 200 && ed.data.specialty === '人工智能', '编辑账户 ✓');

  // 5. 详情运动信息
  const det = await api('GET', `/api/admin/users/${newId}`, null, t);
  assert(det.status === 200 && det.data.sport, `详情运动信息 ✓ recentRuns=${det.data.sport.recentRuns.length}`);

  // 6. 更新模式导入（不存在的学号必须失败、存在的仅更新）
  const existSid = '2023090001';
  const impU = await api('POST', '/api/admin/users/import', {
    mode: 'update',
    rows: [
      { studentId: existSid, gender: '女', birthdate: '2005-06-20' },
      { studentId: `2023${uniq}9999`, gender: '男', birthdate: '2000-01-01' },
    ],
  }, t);
  assert(impU.status === 200 && impU.data.mode === 'update' && impU.data.updated === 1 && impU.data.created === 0 && impU.data.failed.length === 1,
    `更新模式导入 ✓ updated=${impU.data.updated} created=${impU.data.created} 拒绝不存在=${impU.data.failed[0]?.reason || ''}`);

  // 7. 创建模式导入（新用户 + 已存在用户附加更新）
  const impC = await api('POST', '/api/admin/users/import', {
    mode: 'create',
    rows: [
      { name: `冒烟新生${uniq}`, studentId: `2023${uniq}8888`, school: schoolName, department: '机电系', className: `23级冒烟2班`, gender: '男', birthdate: '2005-08-08' },
      { studentId: existSid, gender: '男', birthdate: '2005-06-20' },
    ],
  }, t);
  assert(impC.status === 200 && impC.data.created === 1 && impC.data.updated === 1, `创建模式导入 ✓ created=${impC.data.created} updated=${impC.data.updated}`);

  // 8. 日目标筛选
  const dg = await api('GET', '/api/admin/users?dailyGoal=' + (f.data.dailyGoals[0] || 5000) + '&limit=3', null, t);
  assert(dg.status === 200, `日目标筛选 ✓ total=${dg.data.total}`);

  // 9. 删除
  const del = await api('DELETE', `/api/admin/users/${newId}`, null, t);
  assert(del.status === 200, '删除用户 ✓');
  const gone = await api('GET', `/api/admin/users/${newId}`, null, t);
  assert(gone.status === 404, '删除后详情 404 ✓');

  // 清理冒烟残留
  await api('DELETE', `/api/admin/users?__none=1`, null, t).catch(() => {});
  console.log('\n✓ 用户管理新功能冒烟完成');
})().catch((e) => {
  console.error('测试失败:', e.message);
  process.exit(1);
});
