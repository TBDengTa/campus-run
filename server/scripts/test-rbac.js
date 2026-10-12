// RBAC 验证脚本：三种角色登录 + 权限拦截冒烟
const BASE = 'http://localhost:3010';

async function login(code) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return res.json();
}

async function call(method, path, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  return { status: res.status, code: body.code, message: body.message };
}

(async () => {
  for (const code of ['dev-admin', 'dev-teacher', 'dev-student']) {
    const r = await login(code);
    if (r.code !== 0) {
      console.log(`${code}: 登录失败 ${r.message}`);
      continue;
    }
    const u = r.data.userInfo;
    console.log(`\n${code}: role=${u.role} isManager=${u.isManager} perms=${JSON.stringify(u.effectivePermissions)} 昵称=${u.nickname}`);

    const tests = [
      ['GET', '/api/admin/dashboard/overview'],
      ['GET', '/api/admin/users?limit=1'],
      ['PUT', '/api/admin/config'],
      ['GET', '/api/admin/permissions'],
      ['GET', '/api/run/today'],
    ];
    for (const [m, p] of tests) {
      const res = await call(m, p, r.data.token);
      console.log(`  ${m} ${p} → ${res.status}/${res.code} ${res.code === 0 ? '✓' : res.message}`);
    }
  }

  // 权限修改接口：admin 给 student 授权 user.view 再收回
  const admin = await login('dev-admin');
  const student = await login('dev-student');
  const adminToken = admin.data.token;
  const studentId = student.data.userInfo._id;

  const users = await (await fetch(`${BASE}/api/admin/users?keyword=dev_student_1`, { headers: { authorization: `Bearer ${adminToken}` } })).json();
  const target = users.data.list[0];
  let res = await fetch(`${BASE}/api/admin/users/${target._id}/permissions`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ role: 'teacher', permissionGroups: ['teacher'], permissions: ['user.manage'] }),
  });
  const after = await res.json();
  console.log(`\n授权后 student → role=${after.data.role} groups=${JSON.stringify(after.data.permissionGroups)} perms=${JSON.stringify(after.data.effectivePermissions)}`);

  res = await fetch(`${BASE}/api/admin/users/${target._id}/permissions`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ role: 'student', permissionGroups: [], permissions: [] }),
  });
  const restored = await res.json();
  console.log(`收回后 → role=${restored.data.role} isManager=${restored.data.isManager}`);

  console.log('\n✓ RBAC 冒烟测试完成');
})().catch((e) => {
  console.error('测试失败:', e.message);
  process.exit(1);
});
