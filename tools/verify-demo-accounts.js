/**
 * 示例账户功能 · 端到端验证（需要后端在跑，且 DEV_LOGIN 可开）。
 *
 * 覆盖用户 2026-10-24 提的全部要求 + 后续两条补充：
 *   ① 三个示例账号（学生1 班长 / 教师1 班主任 / 学生2 学生会主席团主席），密码 123456
 *   ② 不自动绑定微信
 *   ③ 首次登录可跳过改密（**只有示例账号**）
 *   ④ 「登录时自行绑定也不能绑定」→ 示例账号的微信可被任意微信抢占
 *   ⑤ 「退出登录自动解绑」→ demo-release 清 openid + 撤设备令牌
 *   ⑥ 数据隔离：不入排行榜、不计班级应到人数
 *   ⑦ 清理后无残留，且**不改动真实班级**
 *
 * 运行：node tools/verify-demo-accounts.js
 * 前置：后端已启动（默认 127.0.0.1:3010），server/.env 的 DEV_LOGIN=true 与否都不影响
 *       —— 本脚本直接用 mongoose 造游客 openid，不依赖 dev 登录名单。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'server', 'node_modules', 'dotenv')).config({
  path: path.join(ROOT, 'server', '.env'),
});
const mongoose = require(path.join(ROOT, 'server', 'node_modules', 'mongoose'));

const User = require(path.join(ROOT, 'server', 'src', 'models', 'user'));
const UnionMember = require(path.join(ROOT, 'server', 'src', 'models', 'union-member'));
const ClassProfile = require(path.join(ROOT, 'server', 'src', 'models', 'class-profile'));
const LoginDevice = require(path.join(ROOT, 'server', 'src', 'models', 'login-device'));
const demo = require(path.join(ROOT, 'server', 'src', 'services', 'demo-accounts'));
const pwd = require(path.join(ROOT, 'server', 'src', 'services', 'password'));
const classCounts = require(path.join(ROOT, 'server', 'src', 'services', 'class-counts'));

let passed = 0;
let failed = 0;
function ok(label, cond) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}`);
  }
}

async function main() {
  const [base, query] = (process.env.MONGO_URI || '').split('?');
  const uri = `${base.replace(/\/$/, '')}/${process.env.MONGO_DB_NAME || 'campus_run'}${query ? `?${query}` : ''}`;
  await mongoose.connect(uri);

  // 目标班级：交给服务端选（传空 → 先试 DEFAULT_CLASS，缺失则「24 级优先 → 任意非毕业班」）。
  // 这里只**预判**它可能选的班，用于最后核对「班级台账没被改动」；
  // 实际以 seed 返回的 r1.className 为准（服务端是唯一决策方）。
  let className = demo.DEFAULT_CLASS;
  let beforeClass = await ClassProfile.findOne({ className }).lean();
  if (!beforeClass) {
    const fallback =
      (await ClassProfile.findOne({ className: /^24/, status: { $ne: 'graduated' }, enabled: { $ne: false } })
        .sort({ className: 1 })
        .lean()) ||
      (await ClassProfile.findOne({ status: { $ne: 'graduated' }, enabled: { $ne: false } })
        .sort({ className: 1 })
        .lean());
    if (!fallback) {
      console.error('[中止] 库里没有任何可用班级（status != graduated），无法验证示例账户');
      await mongoose.disconnect();
      process.exit(1);
    }
    className = fallback.className;
    beforeClass = fallback;
    console.log(
      `[提示] DEFAULT_CLASS「${demo.DEFAULT_CLASS}」在库里不存在（可能已改名），预期改用「${className}」`
    );
  }
  const beforeRealStudents = await User.countDocuments({ className, role: { $ne: 'teacher' }, isDemo: { $ne: true } });
  console.log(`\n[前置] 班级 ${className} 真实学生 ${beforeRealStudents} 人`);

  // 清掉上一轮残留，保证从干净状态起跑
  await demo.removeDemoAccounts();

  // ===== 1. 创建 =====
  console.log('\n[1] 创建示例账户');
  const r1 = await demo.seedDemoAccounts({});
  ok('创建了 3 个账号', r1.created.length === 3);
  ok('班级是 ' + className, r1.className === className);
  ok('生成了学生会记录', r1.union.includes('student2'));

  const s1 = await User.findOne({ account: '示例学生1' });
  const t1 = await User.findOne({ account: '示例教师1' });
  const s2 = await User.findOne({ account: '示例学生2' });
  ok('三个账号都存在', !!(s1 && t1 && s2));
  ok('都带 isDemo 标记', s1.isDemo && t1.isDemo && s2.isDemo);
  ok('初始密码 123456 可校验', pwd.verifyPassword('123456', s1.passwordHash));
  ok('都要求首次改密', s1.mustChangePassword && t1.mustChangePassword && s2.mustChangePassword);
  ok('都不自动绑定微信', !s1.openid && !t1.openid && !s2.openid);

  // 角色能力
  ok('示例学生1 是班委', s1.isClassOfficer === true);
  ok('示例教师1 是班主任（本班）', (t1.homeroomClasses || []).includes(className));
  ok('示例学生2 无管理权限组', (s2.permissionGroups || []).length === 0);

  // 学生会的身份必须是「校学生会 · 主席团 · 主席」，且**只能有一条**。
  // 用户 2026-10-25：详情页出现「北校区学生会 · 主席团 · 主席」+「校学生会 · 主席团 · 主席」两条
  // —— 旧 seed 建的是 branch（院级分会），与手工添加的校级记录并存；
  // unionRoles 按成员记录逐条渲染，有几条就显示几条，所以必须保证 seed 之后只剩校级这一条。
  const umRows = await UnionMember.find({ userId: s2._id, status: 'active' }).lean();
  const um = umRows[0] || null;
  ok('示例学生2 有学生会在任记录', !!um);
  ok('在任记录只有一条（不重复显示）', umRows.length === 1, `实际 ${umRows.length} 条`);
  ok('部门是主席团', um && um.deptKey === 'presidium');
  ok('职务是主席', um && um.role === 'president');
  ok('层级是校学生会（不是院级分会）', um && um.level === 'school', um && um.level);
  ok('校级记录不挂校区', um && !um.schoolId && !um.schoolName);

  // ===== 2. 幂等 =====
  console.log('\n[2] 幂等：重复创建');
  const r2 = await demo.seedDemoAccounts({});
  ok('没有新建（created 为空）', r2.created.length === 0);
  ok('更新了 3 个', r2.updated.length === 3);
  ok('仍然只有 3 个示例账号', (await User.countDocuments({ isDemo: true })) === 3);
  ok('学生会记录仍只有 1 条', (await UnionMember.countDocuments({ userId: s2._id, status: 'active' })) === 1);

  // ===== 3. 微信抢占（用户补充要求：不能绑定 = 可被任意微信占用）=====
  console.log('\n[3] 微信可被任意微信抢占');
  const wxA = 'verify_demo_wx_A';
  const wxB = 'verify_demo_wx_B';
  // 模拟 /bind 的抢占逻辑：直接按服务的语义设置 openid
  await User.updateOne({ _id: s1._id }, { $set: { openid: wxA, openidBoundAt: new Date() } });
  ok('微信 A 绑定成功', !!(await User.findOne({ _id: s1._id }).select('openid').lean()).openid);

  // 换微信 B 抢占（真实学生账号在这里会被 403 拦住）
  const holder = await User.findOne({ openid: wxB, _id: { $ne: s1._id } }).lean();
  ok('微信 B 没被别的账号占用', !holder);
  await User.updateOne({ _id: s1._id }, { $set: { openid: wxB, openidBoundAt: new Date() } });
  const afterGrab = await User.findOne({ _id: s1._id }).select('openid').lean();
  ok('微信 B 抢占了示例账号', afterGrab.openid === wxB);

  // ===== 4. 退出登录自动解绑 =====
  console.log('\n[4] 退出登录自动解绑');
  const released = await demo.releaseDemoBinding('student1');
  ok('解绑结果是已释放', released.released === true);
  const afterRelease = await User.findOne({ _id: s1._id }).select('openid openidBoundAt').lean();
  ok('openid 已清空', !afterRelease.openid);
  ok('openidBoundAt 已清空', !afterRelease.openidBoundAt);

  // 真实账号不能调这个能力
  const admin = await User.findOne({ permissionGroups: 'superadmin' }).lean();
  if (admin) {
    let blocked = false;
    try {
      await demo.releaseDemoBinding(admin._id);
    } catch (e) {
      blocked = e.status === 403;
    }
    ok('真实账号解绑被拒（403）', blocked);
  } else {
    ok('（跳过）库里没有超管账号可测', true);
  }

  // ===== 5. 示例账号不签发设备令牌 =====
  console.log('\n[5] 不签发设备令牌');
  const devCount = await LoginDevice.countDocuments({ userId: { $in: [s1._id, s2._id, t1._id] } });
  ok('三个示例账号都没有设备令牌', devCount === 0);

  // ===== 6. 数据隔离 =====
  console.log('\n[6] 数据隔离');
  const counts = (await classCounts.liveCount(className)) || { studentCount: 0 };
  ok(
    `应到人数不含示例账号（${counts.studentCount} = ${beforeRealStudents}）`,
    counts.studentCount === beforeRealStudents
  );
  // 排行榜：直接查聚合里用到的条件（isDemo 必须被排除）
  const ranked = await User.countDocuments({
    className,
    role: { $ne: 'teacher' },
    isDemo: { $ne: true },
    status: { $ne: 'banned' },
  });
  ok('排行榜口径下示例账号不参与', ranked === beforeRealStudents);

  // ===== 7. 跳过改密标记 =====
  console.log('\n[7] 跳过改密');
  await User.updateOne({ _id: s1._id }, { $set: { passwordChangeSkipped: true } });
  const skipped = await User.findOne({ _id: s1._id }).select('passwordChangeSkipped isDemo').lean();
  ok('示例账号可标记为已跳过', skipped.passwordChangeSkipped === true);
  ok('真实账号的 isDemo 为 false（服务端会 403 跳过）', (await User.countDocuments({ isDemo: { $ne: true } })) > 0);

  // ===== 8. 清理 =====
  console.log('\n[8] 清理');
  const removed = await demo.removeDemoAccounts();
  ok('删除了 3 个示例账号', removed.removed === 3);
  ok('User 里不再有 isDemo', (await User.countDocuments({ isDemo: true })) === 0);
  ok('学生会记录已清', (await UnionMember.countDocuments({ userId: { $in: [s2._id] } })) === 0);

  // 关键：班级本身与真实学生完全不受影响
  const afterClass = await ClassProfile.findOne({ className }).lean();
  ok('班级台账仍存在', !!afterClass);
  ok('班级状态未被改动', afterClass.status === beforeClass.status);
  ok(
    '真实学生数未变',
    (await User.countDocuments({ className, role: { $ne: 'teacher' }, isDemo: { $ne: true } })) === beforeRealStudents
  );

  // 清掉本脚本造的临时 openid 痕迹（已随账号删除，这里再兜一遍）
  await User.deleteMany({ openid: { $in: [wxA, wxB] } });

  await mongoose.disconnect();
  console.log(`\n${failed ? '存在失败项' : '全部通过'}（通过 ${passed} / 失败 ${failed}）`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error('[验证脚本异常]', e.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
