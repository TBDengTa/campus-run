/**
 * 示例账户（演示 / 培训用）—— 创建、重置、解绑、清理。
 *
 * 用户 2026-10-24 需求：
 *   「创建 示例学生1(班长权限)、示例教师1(班主任权限)、示例学生2(学生会) 密码为123456，
 *     不自动绑定微信，并且在首次登录输入新的密码增加跳过功能」
 *   「登录时自行绑定 也不能绑定 或者 退出登录自动解绑」
 *   「主席团 · 主席。只给示例账号。塞进某个24级的真实班级」
 *
 * 三条硬约束（改动前先读，否则会把演示数据变成真实的越权通道）：
 *   ① **只有 isDemo 账号享受特殊待遇**（微信可抢占 / 退出自动解绑 / 可跳过改密）。
 *      真实账号一律走原有铁律 —— 学生一账号一微信、首次登录必须改密。
 *   ② **塞进真实班级，但绝不改班级本身**：选中的班级必须已存在且是真实班级
 *      （不新建 class_profiles，不动 status，不清名单）。清理时只删示例用户，
 *      班级台账与真实学生完全不受影响。
 *   ③ **示例学生会记录必须与真实记录的字段口径一致**（level / deptKey / role / termId），
 *      否则 `services/union.js::resolveIdentity` 认不出来，示例账号就演示不了复核。
 *
 * 为什么放在 service 而不是路由里：管理端页面、启动期脚本、验证脚本都要用同一份逻辑。
 * 权限（config.manage）只在路由层校验，这里不碰 req/res。
 */
const mongoose = require('mongoose');
const User = require('../models/user');
const UnionMember = require('../models/union-member');
const Organization = require('../models/organization');
const pwd = require('./password');
const unionSvc = require('./union');
const deviceSvc = require('./login-device');

// 示例账号统一密码（用户指定）。用 initialHashes + mustChangePassword 与真实账号同一套字段，
// 这样「首次登录 → 改密」的流程对示例账号是原样可演示的（只是多了一个「跳过」出口）。
const DEMO_PASSWORD = '123456';

// 示例账号塞进的真实班级：优先 **24级软件技术** 的原因
//   · 24 级全部班级状态是 intern（实习中），本来就不进班超联赛排行 → 示例数据不污染榜单；
//   · 该班真实学生数最少（35 人），示例账号混进名单时的视觉干扰最小。
//
// ⚠️ 班名必须带「级」：项目做过「25班 → 25级班」的命名规范化
//   （见迁移脚本 + `services/roster.js::classNameFromGradeSpecialty`），
//   写成「24软件技术」在规范化后的库里**查不到**，示例账号会创建失败。
//   真实踩点：verify-demo-accounts 因这个旧名直接中止（「班级不存在」）。
// 允许在创建时用参数覆盖（不同校区/年份可以换成别的班），但**必须是一个已存在的真实班级**；
// 传空则自动挑选：先试 DEFAULT_CLASS，缺失则退而取「24 级优先 → 任意非毕业班」（见下方 resolveClass）。
const DEFAULT_CLASS = '24级软件技术';

/**
 * 三个示例账号的定义。
 * `key` 同时用作管理端路由参数（/api/admin/demo/:key/unbind）与前端展示标识。
 */
const DEMO_SPECS = [
  {
    key: 'student1',
    label: '示例学生1',
    desc: '班委（班长）—— 可查看本班数据，可改本班学生宿舍 / 卫生区 / 教室',
    realName: '示例学生1',
    role: 'student',
    isClassOfficer: true,
    union: null,
  },
  {
    key: 'teacher1',
    label: '示例教师1',
    desc: '教师权限 + 班主任 —— 可进管理端（看板 / 用户 / 申诉审核 / 内容 / 配置查看），可管本班学生，不可删号',
    realName: '示例教师1',
    role: 'teacher',
    homeroom: true,
    // 用户 2026-10-24「示例教师1 需要有教师权限」：挂内置 teacher 组
    // （dashboard.view / user.view / appeal.view / appeal.review / content.view /
    //  config.view / assessment.view —— 全是查看 + 申诉审核，不含任何 .manage 写权限，
    //  演示者能看到管理端长什么样，但改不了全校配置；班主任能力另由班级域成员资格授予）。
    groups: ['teacher'],
    union: null,
  },
  {
    key: 'student2',
    label: '示例学生2',
    desc: '学生会主席团主席 —— 可演示检查录入与复核',
    realName: '示例学生2',
    role: 'student',
    // 用户 2026-10-24 指定「主席团 · 主席」；2026-10-25 进一步明确**要校学生会，不要院级**。
    //
    // level='school' = 校学生会主席团主席（全校范围，可复核任意院校的记录）；
    // level='branch' 则是某个校区分会的主席 —— 两者是不同的身份，之前选了 branch，
    // 于是与手工添加的校级记录并存，用户详情页出现「北校区学生会 · 主席团 · 主席」和
    // 「校学生会 · 主席团 · 主席」两条（unionRoles 按成员记录逐条渲染，有几条显示几条）。
    //
    // deptKey='presidium' + role='president' 是服务端认定的「主席团主席」组合
    // （routes/admin/union.js::assertRoleFitsDept 会拦掉「主席团 + 部长」这类矛盾组合）；
    // 校级层除主席团外不允许挂业务部门，presidium 正是唯一合法选择。
    union: { level: 'school', deptKey: 'presidium', role: 'president' },
  },
];

function normalizeClassName(name) {
  return String(name || '').trim();
}

/**
 * 校验并返回示例账号要用的真实班级名。
 *
 * @param {string} [className] 传空则自动挑选
 * @returns {Promise<string>}
 *
 * 自动挑选规则（传空时）：优先 DEFAULT_CLASS；它不存在就退而取**任意一个非毕业班**
 * （24 级优先，其次按班级名排序取第一个）。
 *
 * 为什么不再硬失败（用户 2026-10-24 报「创建后依旧显示未创建」）：
 *   DEFAULT_CLASS 是开发库里的班级名，生产库/另一套环境未必有同名班
 *   → resolveDemoClass 抛 400 → 前端只弹一个 toast，列表原样显示「未创建」，
 *   用户看起来就是「点了创建但什么都没发生」。示例账户属于演示设施，
 *   不该因为某个班级名不存在就整体不可用；只要库里有**任意**一个可登录的班就能跑。
 */
async function resolveDemoClass(className) {
  const ClassProfile = require('../models/class-profile');
  const want = normalizeClassName(className);

  // ① 显式指定：必须存在且非毕业班（不做兜底，否则用户以为填的那个班生效了）
  if (want) {
    const profile = await ClassProfile.findOne({ className: want }).lean();
    if (!profile) {
      const err = new Error(`班级「${want}」不存在，请换一个已存在的班级`);
      err.status = 400;
      err.code = 400;
      throw err;
    }
    if (profile.status === 'graduated') {
      const err = new Error(`班级「${want}」是毕业班，账号无法登录，请换一个非毕业班`);
      err.status = 400;
      err.code = 400;
      throw err;
    }
    return want;
  }

  // ② 未指定：先试默认班
  const preferred = await ClassProfile.findOne({ className: DEFAULT_CLASS }).lean();
  if (preferred && preferred.status !== 'graduated') return DEFAULT_CLASS;

  // ③ 兜底：任意非毕业班（24 级优先），让功能在别的环境也能用
  const fallback =
    (await ClassProfile.findOne({ className: /^24/, status: { $ne: 'graduated' } })
      .sort({ className: 1 })
      .lean()) ||
    (await ClassProfile.findOne({ status: { $ne: 'graduated' } })
      .sort({ className: 1 })
      .lean());

  if (!fallback) {
    const err = new Error('库里没有任何可用班级，请先创建班级台账（班级管理 → 从学籍同步）');
    err.status = 400;
    err.code = 400;
    throw err;
  }
  return fallback.className;
}

/**
 * 示例学生会成员要挂的校区：取组织树里第一个院校。
 * 为什么不用「校级（school）」：`assertDeptFitsCampus` 规定校级层除主席团外不能挂业务部门，
 * 而主席团在校级也能选；但校级主席团 = 全校主席，示例数据越权面更大。
 * 挂到某个具体院校（院级主席团）既满足「主席团 · 主席」，也符合真实分院学生会的结构。
 */
async function resolveDemoSchool() {
  const school = await Organization.findOne({ type: 'school' }).sort({ createdAt: 1 }).lean();
  return school ? { id: school._id, name: school.name } : { id: null, name: '' };
}

/**
 * 创建 / 重置三个示例账号（幂等）。
 *
 * 幂等语义：已存在就把「应该由示例定义固定的字段」重置回预设值
 * （密码、权限、班级、班委标记、班主任班级、学生会记录），
 * 但**不碰 openid** —— 当前正有人用某个微信登录着示例账号时，重置不该把他踢出去。
 * （openid 只由 releaseDemoBinding / 抢占绑定两条路径改动。）
 *
 * @param {{className?:string}} [opts]
 * @returns {Promise<{className:string,created:string[],updated:string[],union:string[]}>}
 */
async function seedDemoAccounts(opts = {}) {
  const className = await resolveDemoClass(opts.className);
  const school = await resolveDemoSchool();
  const terms = unionSvc.academicTerms();
  const termId = terms.current || '';
  const termName = (terms.list.find((t) => t.termId === termId) || {}).termName || '';

  const result = { className, created: [], updated: [], union: [] };

  for (const spec of DEMO_SPECS) {
    // 账号名 = realName（登录时按 account 查找，与真实账号同一口径）
    // 查找走 findDemoUser：能命中「改过角色 / 名字带空格」的历史示例账号，避免重复建号
    let user = await User.findOne({ account: spec.realName, role: spec.role });
    if (!user) {
      const found = await findDemoUser(spec);
      if (found) user = await User.findById(found._id);
    }

    const patch = {
      account: spec.realName,
      realName: spec.realName,
      nickname: spec.realName,
      role: spec.role,
      isDemo: true,
      // 学生写班级；教师要写班级（班主任看的班）+ homeroomClasses（班级域判权依据）
      className: spec.role === 'teacher' ? className : className,
      homeroomClasses: spec.homeroom ? [className] : [],
      isClassOfficer: spec.isClassOfficer === true,
      // 权限组按 spec.groups 给（用户 2026-10-24「示例教师1 需要有教师权限」→ teacher1 挂内置 teacher 组）。
      // 刻意**不给任何 .manage 写权限**：teacher 组全是查看 + 申诉审核，
      // 演示者能看清管理端结构，但改不了全校配置 / 用户 / 内容 —— 生产环境残留也是低风险账号。
      permissionGroups: spec.groups || [],
      permissions: [],
      // 密码固定 123456，并标记「首次登录需改密」（示例账号可跳过，真实账号不可）
      passwordHash: pwd.hashPassword(DEMO_PASSWORD),
      initialHashes: [pwd.hashPassword(DEMO_PASSWORD)],
      mustChangePassword: true,
      // 重置密码要顺带解掉锁定，否则之前有人输错 5 次会把示例账号锁住，后面谁都进不来
      failedLogins: 0,
      lockUntil: null,
      status: 'active',
      banReason: '',
      // 限制项清空：示例账号不该带着上一轮演示留下的「限制同步 / 限制 GPS」
      restrictions: {},
    };

    if (!user) {
      user = await User.create({ ...patch, passwordChangeSkipped: false });
      result.created.push(spec.key);
    } else {
      // 重置时不碰 openid / passwordChangeSkipped（前者见函数注释，后者是使用者自己的选择）
      Object.assign(user, patch);
      await user.save();
      result.updated.push(spec.key);
    }

    // ===== 学生会记录（只有 student2 需要）=====
    // 先清掉这个示例账号的旧在任记录再建，保证「同一个人只有一条示例学生会身份」，
    // 换过部门/届次时也不会残留第二条（成员唯一索引按 level+schoolId+deptKey+termId 去重）。
    if (spec.union) {
      await UnionMember.deleteMany({ userId: user._id, status: 'active' });
      const dept = await require('../models/union-department').findOne({ key: spec.union.deptKey }).lean();
      await UnionMember.create({
        userId: user._id,
        openid: user.openid || '',
        realName: spec.realName,
        studentId: '',
        className,
        level: spec.union.level,
        schoolId: spec.union.level === 'branch' ? school.id : null,
        schoolName: spec.union.level === 'branch' ? school.name : '',
        departmentId: null,
        departmentName: '',
        deptKey: spec.union.deptKey,
        deptName: dept ? dept.name : '主席团',
        role: spec.union.role,
        termId,
        termName,
        remark: '示例账户（可随时清理）',
        createdBy: 'system:demo',
      });
      result.union.push(spec.key);
    } else {
      // 角色变了的示例账号（例如从学生会改成普通学生）要清掉残留成员记录
      await UnionMember.deleteMany({ userId: user._id });
    }

    // 身份缓存按 openid 存，改了成员记录必须清，否则详情页仍显示旧职务
    if (user.openid) unionSvc.clearIdentityCache(user.openid);
  }

  return result;
}

/**
 * 查找某个示例账号对应的 user 文档。**多个入口共用这一份，口径必须一致**。
 *
 * 为什么不能只按 `{ account, role }` 精确匹配（用户 2026-10-24 报「创建后示例账户页仍显示未创建」）：
 *   ① account 里可能带前后空格 / 全角空格（人工建档、旧导入都会留下）；
 *   ② 同一个示例账号在历史上可能被改成别的 role（示例学生1 曾被误设为 teacher）；
 *   ③ 更根本的是：**isDemo 才是这个账号的身份来源**，account 只是它创建时的名字。
 * 所以匹配顺序是：isDemo → account 精确 → account 去空格/`realName` 兜底，
 * 命中任何一条就算「存在」，且**不再强制 role 相等**（role 不对时 seed 会纠正回来）。
 *
 * @param {{realName:string, role:string}} spec
 * @returns {Promise<object|null>}
 */
async function findDemoUser(spec) {
  // ① 首选 isDemo 标记：这是最可靠的标识，不受改名 / 改角色影响
  const byDemo = await User.findOne({ isDemo: true, account: spec.realName }).lean();
  if (byDemo) return byDemo;

  // ② account + role 精确（与 seed 的首选口径一致）
  const exact = await User.findOne({ account: spec.realName, role: spec.role }).lean();
  if (exact) return exact;

  // ③ account 精确但 role 不同（历史被改过角色）
  const byName = await User.findOne({ account: spec.realName }).lean();
  if (byName) return byName;

  // ④ 兜底：库里 account 带空格 / realName 才是有效名
  const loose = await User.findOne({
    $or: [{ account: new RegExp(`^\\s*${escapeRe(spec.realName)}\\s*$`) }, { realName: spec.realName }],
  }).lean();
  return loose || null;
}

// 正则转义：账号名里可能有 () . * 等字符，直接塞进 RegExp 会当成元字符
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 后端当前连的是哪个库（诊断用，随 GET /api/admin/demo 下发）。
 *
 * 为什么（用户 2026-10-24「用户列表明明有示例账号，页面却说未创建」）：
 *   最可能的解释是「看账号的那个后端」和「示例账户页问的那个后端」连的根本不是同一个库
 *   （比如开发者工具连本地、手机连线上）。让接口自报数据库主机与库名，
 *   两边一比就知道。只回主机名与库名 —— 凭据（账号密码）绝不下发。
 */
function dbInfo() {
  const config = require('../config');
  let host = '';
  try {
    const u = new URL(config.mongoUri);
    host = u.hostname;
  } catch (e) {
    host = '(无法解析)';
  }
  return { host, dbName: config.dbName };
}

/**
 * 示例账号名单 + 当前绑定状态（管理端页面用）。
 *
 * 附带 diag（诊断）：exists=false 时把「查了什么、库里有什么」如实带出来。
 * 为什么（用户 2026-10-24「页面一直显示未创建」，本地逐层验证却全对）：
 *   远程排查最大的成本是猜 —— 猜版本、猜库、猜数据。让接口自己把证据吐出来，
 *   截图一发就能定位：是查询口径不对（diag.query 显示查了 A 但库里是 B），
 *   还是线上根本没部署新代码（老后端连 diag 字段都不会有）。
 * @returns {Promise<Array>}
 */
async function listDemoAccounts() {
  const out = [];
  for (const spec of DEMO_SPECS) {
    // 与 seed / release 共用同一份查找（见 findDemoUser 注释：
    // 只查 { account, role } 会在「账号被改过角色 / 名字带空格」时误报「未创建」）
    const user = await findDemoUser(spec);
    out.push({
      key: spec.key,
      label: spec.label,
      desc: spec.desc,
      exists: !!user,
      userId: user ? String(user._id) : '',
      bound: !!(user && user.openid),
      boundAt: user && user.openidBoundAt ? user.openidBoundAt : null,
      lastLoginAt: user && user.lastSyncAt ? user.lastSyncAt : null, // 复用 lastSyncAt：示例账号没有单独的登录时间字段
      passwordChangeSkipped: !!(user && user.passwordChangeSkipped),
      // 诊断：只给账号名与匹配方式这类非敏感信息（不给 openid / 连接串）
      diag: user
        ? { matchedBy: 'found', account: user.account || '', role: user.role || '', isDemo: !!user.isDemo }
        : await diagnoseMissing(spec),
    });
  }
  return out;
}

/**
 * exists=false 时收集诊断：库里到底有没有「长得像」的账号。
 * 三层探测：精确名 → 模糊名 → isDemo 全量，把每一层的结果如实返回。
 */
async function diagnoseMissing(spec) {
  const like = await User.find({ account: new RegExp(escapeRe(spec.realName.slice(0, 4))) })
    .select('account role isDemo')
    .limit(5)
    .lean();
  const demoRows = await User.find({ isDemo: true }).select('account role').limit(8).lean();
  return {
    matchedBy: 'none',
    want: { account: spec.realName, role: spec.role },
    // 库里名字相近的账号（能看到「示例学生」vs「示例学生1」这种差异）
    similar: like.map((u) => `${u.account}(${u.role}${u.isDemo ? ',demo' : ''})`),
    // 库里所有 isDemo 账号（为空 = 线上创建走的是旧版代码或别的库）
    demoAccounts: demoRows.map((u) => `${u.account}(${u.role})`),
  };
}

/**
 * 解绑示例账号的微信（清 openid + 撤销设备令牌）。
 *
 * 为什么必须撤设备令牌：`login_devices` 是按账号签发的，换了微信后原设备仍然是合法令牌；
 * 而示例账号本来就**不签发** deviceToken（见 routes/auth.js），所以这里主要是兜底清理
 * 早期数据 / 别处签发的令牌，避免「一键登录」记录指向一个已经解绑的示例账号。
 *
 * @param {'student1'|'teacher1'|'student2'|string} key 或直接传 userId
 */
async function releaseDemoBinding(key) {
  let user = null;
  if (mongoose.isValidObjectId(key)) {
    user = await User.findById(key);
  } else {
    const spec = DEMO_SPECS.find((s) => s.key === key);
    // 与 list / seed 同一份查找（findDemoUser），否则「列表显示已创建、点解绑却说不存在」
    if (spec) {
      const found = await findDemoUser(spec);
      if (found) user = await User.findById(found._id);
    }
  }
  if (!user) {
    const err = new Error('示例账号不存在');
    err.status = 404;
    err.code = 404;
    throw err;
  }
  if (!user.isDemo) {
    const err = new Error('只有示例账号可以自动解绑；真实账号的微信绑定需管理员在用户详情页处理');
    err.status = 403;
    err.code = 403;
    throw err;
  }

  const oldOpenid = user.openid || '';
  user.openid = undefined;
  user.openidBoundAt = undefined;
  await user.save();

  // 学生会成员记录上冗余了 openid（便于按 openid 查身份），解绑后要同步清空
  await UnionMember.updateMany({ userId: user._id }, { $set: { openid: '' } });
  await deviceSvc.revokeAllForUser(user._id);
  if (oldOpenid) unionSvc.clearIdentityCache(oldOpenid);

  return { key, userId: String(user._id), released: !!oldOpenid };
}

/**
 * 清理全部示例账号（账号 + 学生会记录 + 留痕）。
 * **不动班级**：班级台账与真实学生完全不受影响 —— 示例账号只是 student 文档里的三条记录。
 */
async function removeDemoAccounts() {
  const users = await User.find({ isDemo: true }).select('_id openid account realName').lean();
  const openids = users.map((u) => u.openid).filter(Boolean);
  const ids = users.map((u) => u._id);

  if (ids.length) {
    await UnionMember.deleteMany({ userId: { $in: ids } });
    // 设备令牌按用户清（示例账号本不该有，但可能来自早期版本或被旧逻辑签发）
    for (const id of ids) await deviceSvc.revokeAllForUser(id);
    await User.deleteMany({ _id: { $in: ids } });
  }
  for (const openid of openids) unionSvc.clearIdentityCache(openid);

  return { removed: ids.length, names: users.map((u) => u.realName || u.account) };
}

module.exports = {
  DEMO_PASSWORD,
  findDemoUser,
  dbInfo,
  DEFAULT_CLASS,
  DEMO_SPECS,
  resolveDemoClass,
  seedDemoAccounts,
  listDemoAccounts,
  releaseDemoBinding,
  removeDemoAccounts,
};
