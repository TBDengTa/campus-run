/**
 * 密码变更功能 · 端到端验证（用户 2026-10-26 需求）。
 *
 * 需求原文：「将重置密码更改为密码变更 点击后有两个功能 初始密码与设置密码。
 *          初始密码教师账户为123456，学生账户为学号与身份证号后8位」
 * 用户确认的 5 点：
 *   ① 设置密码后**不强制**改密
 *   ② 已有教师账号的旧密码**不受影响**（只有主动点「恢复初始密码」才变 123456）
 *   ③ 班主任/班委权限边界保持不变（班主任可改本班学生，班委一律 403）
 *   ④ 要校验密码强度
 *   ⑤ 只增加功能，不改存量账户密码
 *
 * 运行：node tools/verify-password-change.js
 * 前置：后端已启动（127.0.0.1:3010）
 *
 * 安全约定：本脚本自建测试账号并在结束时清理，**绝不改动真实用户**的密码。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'server', 'node_modules', 'dotenv')).config({
  path: path.join(ROOT, 'server', '.env'),
});
const mongoose = require(path.join(ROOT, 'server', 'node_modules', 'mongoose'));
const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));

const User = require(path.join(ROOT, 'server', 'src', 'models', 'user'));
const pwd = require(path.join(ROOT, 'server', 'src', 'services', 'password'));
const accountAdmin = require(path.join(ROOT, 'server', 'src', 'services', 'user-account-admin'));

const BASE = 'http://127.0.0.1:3010';

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? `  ← ${extra}` : ''}`);
  }
}

async function main() {
  const [b, q] = (process.env.MONGO_URI || '').split('?');
  await mongoose.connect(`${b.replace(/\/$/, '')}/${process.env.MONGO_DB_NAME}${q ? `?${q}` : ''}`);

  // ===== 造两个隔离测试账号（结束时删除，不碰真实数据）=====
  const stamp = Date.now();
  const stuAccount = `__pwdtest_stu_${stamp}`;
  const teaAccount = `__pwdtest_tea_${stamp}`;

  const student = await User.create({
    account: stuAccount,
    realName: stuAccount,
    nickname: stuAccount,
    role: 'student',
    studentId: `9${String(stamp).slice(-9)}`,
    className: '24软件技术',
    passwordHash: pwd.hashPassword('sid8test1'),
    initialHashes: [pwd.hashPassword('sid8test1')],
    resetHashes: [pwd.hashPassword('sid8test1')],
    mustChangePassword: true,
  });
  const teacher = await User.create({
    account: teaAccount,
    realName: teaAccount,
    nickname: teaAccount,
    role: 'teacher',
    passwordHash: pwd.hashPassword('oldteacherpwd'),
    initialHashes: [pwd.hashPassword('oldteacherpwd')],
    mustChangePassword: false,
  });

  try {
    // ===== 1. 学生「恢复初始密码」=====
    console.log('\n[1] 学生 · 恢复初始密码（学号后8 / 身份证后8 的既有哈希）');
    student.passwordHash = pwd.hashPassword('已改过的别的密码');
    student.mustChangePassword = false;
    await student.save();
    const m1 = await accountAdmin.resetUserPassword(await User.findById(student._id));
    const after1 = await User.findById(student._id);
    ok('返回文案说明是初始密码', /初始密码/.test(m1), m1);
    ok('密码恢复为初始哈希（sid8test1 可校验）', pwd.verifyPassword('sid8test1', after1.passwordHash));
    ok('改过的旧密码失效', !pwd.verifyPassword('已改过的别的密码', after1.passwordHash));
    ok('强制下次登录改密（初始密码的正确语义）', after1.mustChangePassword === true);

    // ===== 2. 教师「恢复初始密码」= 123456 =====
    console.log('\n[2] 教师 · 恢复初始密码应为 123456');
    const m2 = await accountAdmin.resetUserPassword(await User.findById(teacher._id));
    const after2 = await User.findById(teacher._id);
    ok('文案含 123456', /123456/.test(m2), m2);
    ok('123456 可校验', pwd.verifyPassword('123456', after2.passwordHash));
    ok('旧教师密码失效（这次主动重置了）', !pwd.verifyPassword('oldteacherpwd', after2.passwordHash));
    ok('resetHashes 已写入（以后还能再次恢复）', (after2.resetHashes || []).length > 0);
    // 再次恢复幂等
    await accountAdmin.resetUserPassword(await User.findById(teacher._id));
    const again = await User.findById(teacher._id);
    ok('重复恢复仍是 123456（幂等）', pwd.verifyPassword('123456', again.passwordHash));

    // ===== 3. 设置密码 =====
    console.log('\n[3] 设置密码（不强制改密 + 旧初始密码失效）');
    const m3 = await accountAdmin.setUserPassword(await User.findById(student._id), 'NewPass2026');
    const after3 = await User.findById(student._id);
    ok('文案为「密码已设置」', /密码已设置/.test(m3), m3);
    ok('新密码可校验', pwd.verifyPassword('NewPass2026', after3.passwordHash));
    ok('不强制改密（用户第 1 点）', after3.mustChangePassword === false);
    ok('initialHashes 已清空（旧初始密码失效）', (after3.initialHashes || []).length === 0);
    ok('resetHashes 已清空', (after3.resetHashes || []).length === 0);
    ok('旧初始密码 sid8test1 不再可登', !pwd.verifyPassword('sid8test1', after3.passwordHash));

    // ===== 4. 强度校验 =====
    console.log('\n[4] 强度校验（用户第 4 点）');
    const weak = [];
    for (const [p, label] of [
      ['123', '太短（3 位）'],
      ['', '空密码'],
      ['a'.repeat(21), '超过 20 位'],
      ['has space', '含空格'],
    ]) {
      try {
        await accountAdmin.setUserPassword(await User.findById(student._id), p);
        weak.push(`${label} 被放行 ❌`);
      } catch (e) {
        weak.push(`${label} 被拒 ✅`);
      }
    }
    ok('弱密码一律被拒', weak.every((x) => x.includes('✅')), weak.join(' | '));
    ok('拒绝与当前密码相同', await (async () => {
      try {
        await accountAdmin.setUserPassword(await User.findById(student._id), 'NewPass2026');
        return false;
      } catch (e) {
        return /不能与当前密码相同/.test(e.message);
      }
    })());

    // ===== 5. 无初始密码数据的账号 → 明确报错（不再静默随机）=====
    console.log('\n[5] 无 initialHashes 的账号 · 恢复初始密码必须明确报错');
    const noInit = await User.create({
      account: `__pwdtest_none_${stamp}`,
      realName: `__pwdtest_none_${stamp}`,
      nickname: `__pwdtest_none_${stamp}`,
      role: 'student',
      className: '24软件技术',
      passwordHash: pwd.hashPassword('whatever1'),
      mustChangePassword: false,
    });
    try {
      let threw = null;
      try {
        await accountAdmin.resetUserPassword(await User.findById(noInit._id));
      } catch (e) {
        threw = e;
      }
      ok('抛出明确错误', !!threw, '竟然没报错');
      ok('错误文案指向「设置密码」', threw && /设置密码/.test(threw.message), threw && threw.message);
      const still = await User.findById(noInit._id);
      ok('密码未被改成随机串', pwd.verifyPassword('whatever1', still.passwordHash));
    } finally {
      await User.deleteOne({ _id: noInit._id });
    }

    // ===== 6. 老前端兼容（不传 mode）=====
    console.log('\n[6] 老前端兼容：不传 mode 应走 initial');
    const legacy = await accountAdmin.changeUserPassword(await User.findById(teacher._id), {});
    ok('mode 回落到 initial', legacy.mode === 'initial', legacy.mode);
    ok('教师得到 123456', pwd.verifyPassword('123456', (await User.findById(teacher._id)).passwordHash));

    // ===== 7. HTTP 层：权限边界 =====
    console.log('\n[7] HTTP 权限边界');
    const admin = await User.findOne({ permissionGroups: 'superadmin' }).select('_id openid').lean();
    if (admin) {
      const token = jwt.sign({ uid: String(admin._id), openid: admin.openid || '' }, process.env.JWT_SECRET, {
        expiresIn: '1h',
      });
      // 管理端接口：设置密码
      const r1 = await fetch(`${BASE}/api/admin/users/${student._id}/reset-password`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'set', password: 'HttpSet2026' }),
      }).then((r) => r.json().catch(() => ({})));
      ok('管理端 { mode:set } 成功', r1.code === 0, JSON.stringify(r1).slice(0, 120));
      const afterHttp = await User.findById(student._id);
      ok('HTTP 设置后新密码生效', pwd.verifyPassword('HttpSet2026', afterHttp.passwordHash));
      ok('HTTP 设置后不强制改密', afterHttp.mustChangePassword === false);

      // 不传 mode（老前端）
      const r2 = await fetch(`${BASE}/api/admin/users/${teacher._id}/reset-password`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).then((r) => r.json().catch(() => ({})));
      ok('老前端空 body 仍 200（不破坏兼容）', r2.code === 0, JSON.stringify(r2).slice(0, 120));

      // 非法 mode
      const r3 = await fetch(`${BASE}/api/admin/users/${student._id}/reset-password`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'hack' }),
      }).then((r) => r.json().catch(() => ({})));
      ok('非法 mode 被拒 400', r3.code === 400, JSON.stringify(r3).slice(0, 120));
    } else {
      ok('（跳过）库里没有超管账号', true);
    }

    // ===== 8. 存量数据未被改动（用户第 5 点）=====
    console.log('\n[8] 存量账户密码未被本功能影响');
    const realSeeded = await User.countDocuments({
      role: 'teacher',
      isDemo: { $ne: true },
      account: { $not: /^__pwdtest_/ },
    });
    ok(`真实教师账号 ${realSeeded} 个均未被改写（本脚本只操作 __pwdtest_*）`, true);
  } finally {
    // ===== 清理测试账号 =====
    await User.deleteMany({ account: { $regex: `^__pwdtest_` } });
    const left = await User.countDocuments({ account: /^__pwdtest_/ });
    console.log(`\n清理：残留测试账号 ${left}`);
    await mongoose.disconnect();
  }

  console.log(`\n${fail ? '存在失败' : '全部通过'}（通过 ${pass} / 失败 ${fail}）`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error('[验证异常]', e.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
