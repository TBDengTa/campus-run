/**
 * 管理端导航分类（管理中枢 pages/hub 与首页「快捷操作」**共用同一份数据**）
 *
 * 为什么要抽出来：这两处以前各写一套 GROUPS / allEntries，结果同名页面的权限 key、
 * 入口数量、分组名都会漂移（历史就发生过）。用户明确要求「管理中枢也跟这样重新分类显示」——
 * 只有单一数据源才能真正做到一致，所以两处都从这里取。
 *
 * 分层：
 *   NAV_GROUPS  8 个分类按钮（用户钦定的分类与顺序），每个分类下的条目按权限过滤
 *   entryVisible()  统一的显隐判定：perm（权限 key）+ only（身份：班级/学生会/成员）
 *   hasAnyEntry()   首页据此决定「快捷操作」卡是否渲染
 *
 * 注意：这里的 key 只是**入口 key**（用于 wx:key），真正的鉴权在服务端；
 * 前端 perm 过滤只是不给用户看到点了必然 403 的入口。
 */

// ===== 8 个分类（顺序即展示顺序，改这里两处同时生效）=====
const NAV_GROUPS = [
  {
    key: 'class',
    title: '班级管理',
    // 分类叫「班级管理」（班级这件事），里面**两个视角各一条**（用户明确的要求）：
    //   · 我的班级 = 班主任 / 班委管**自己名下的班**（成员资格校验，无需任何管理权限）
    //   · 班级管理 = 管理员管**全校所有班级**的台账（早操 / 早八 / 校园跑标记、人数）
    // 只配 only: 'class' 的分组默认值：教师侧两条无需管理权限就能看见。
    //
    // ⚠️ 命名口径（2026-10-19 用户澄清，别再改错）：
    //   用户原话「我只是说我的班级中的之前的班级考勤更为班超联赛」——
    //   改的只是**页面内那个 tab 的名字**（班级考勤 → 班超）与**页面标题**（我的班级 → 班超联赛）；
    //   管理中枢里的**入口条目仍叫「我的班级」**，分类标题也仍是「我的班级 / 班级管理」（按人群动态取）。
    //   所以这里 label 保持「我的班级」，不要跟着页面标题一起改。
    only: 'class',
    items: [
      // 不写死 ?tab=：由页面自己决定入口 tab（默认「学生名单」；班超类入口带 tab=attendance 直达评比）
      { key: 'classMy', perm: '', only: 'class', icon: 'usergroup', label: '我的班级', url: '/packageAdmin/class/class' },
      { key: 'classManage', perm: 'class.view', only: 'admin', icon: 'city', label: '班级管理', url: '/packageAdmin/class-manage/class-manage' },
      { key: 'classRank', perm: '', only: 'class', icon: 'chart-bar', label: '班超排名', url: '/packageUnion/stats/stats' },
    ],
  },
  {
    key: 'union',
    title: '学生会',
    only: 'unionMember',
    items: [
      // 「学生会成员」入口（用户 2026-10-28「我希望所有主席团可以进入到这个学生会成员中」）：
      //   ⚠️ 旧实现只写 perm:'union.view'，而**主席团是学生、没有任何管理权限** ——
      //      他们在管理中枢里根本看不到「学生会成员」，尽管服务端 assertMemberManager 明确放行主席团。
      //   改成 only:'unionMembersEntry'：主席团 / 部长 / 副部长 / 总管 **或** 持 union.view 的管理员，
      //   满足其一即可见（判定见 navCtx 的 canViewMembers）。
      { key: 'unionMembers', perm: '', only: 'unionMembersEntry', icon: 'usergroup', label: '学生会成员', url: '/packageAdmin/union/members/members' },
      // 扫码加人（用户 2026-10-22）：学生主页出示二维码，干部扫它直接把该学生加进部门。
      // **只给真正能管成员的人看**（用户 2026-10-22「学生会扫码加入不应该显示」）：
      // 服务端 assertMemberManager 只放行 主席团 / 部长 / 副部长 / 学生会总管，
      // 其余人点了必然 403 —— 所以这里用 only:'unionManager' 精确匹配这个口径，
      // 不再用 union.view（那是「能看名单」，不是「能加人」）。
      { key: 'unionScanJoin', perm: '', only: 'unionManager', icon: 'scan', label: '扫码加人', url: '/packageAdmin/union/scan-join/scan-join' },
      { key: 'unionConfig', perm: 'union.manage', icon: 'setting', label: '学生会配置', url: '/packageAdmin/union/config/config' },
      // 检查记录的可见范围（服务端 routes/union.js）：成员按身份范围；**非成员只有学生会总管（union.steward）
      // 能看全校**，两者都不是 → 403。所以入口也按同一口径：只有 union.view 而没有成员身份/总管权限的账号
      // （如普通教师）不再显示这一条 —— 点了必然被拒。
      { key: 'unionRecords', perm: '', only: 'unionRecords', icon: 'file-paste', label: '检查记录', url: '/packageUnion/records/records' },
      // 注：这里**不再**放「班超排名」。它只在「我的班级」分类里出现一次
      // （用户明确：学生会里不该再有一条重复的班超排名）。
      // 学生会成员（非班委）看榜单的入口 = 首页/我的页的班超相关入口，不靠管理导航。
    ],
  },
  {
    key: 'user',
    title: '用户与权限',
    items: [
      { key: 'users', perm: 'user.view', icon: 'usergroup', label: '用户管理', url: '/packageAdmin/users/users' },
      { key: 'import', perm: 'user.import', icon: 'file-add', label: '导入名单', url: '/packageAdmin/users/import' },
      { key: 'groups', perm: 'permission.manage', icon: 'secured', label: '权限组', url: '/packageAdmin/permissions/groups' },
      // 组织架构（学校/院系/专业树与班级归属）原本只在管理中枢有入口，且**不属于**用户给的 8 类。
      // 直接照抄会让这个页面变成不可达（功能还在、没人能进），所以折进「用户与权限」这一最相近的分类；
      // 用户明确只点名 3 项时，这条就是多余的，删掉即可（不影响其它入口）。
      { key: 'organizations', perm: 'content.view', icon: 'city', label: '组织架构', url: '/packageAdmin/content/organizations' },
    ],
  },
  {
    key: 'assessment',
    title: '考核与目标',
    items: [
      // 「运动考核」（assessment/index）入口已按用户 2026-10-22 要求删除：
      // 它只是一个分类中转页，里面就是「默认目标 / 计划目标」两项 —— 两者在下面已经平铺，
      // 留着等于多一层点击（与之前删掉「系统配置」中转页同一个理由）。
      { key: 'assessmentGoals', perm: 'assessment.view', icon: 'flag', label: '默认目标', url: '/packageAdmin/assessment/goals' },
      { key: 'assessmentPlans', perm: 'assessment.view', icon: 'calendar', label: '计划目标', url: '/packageAdmin/assessment/plans' },
      { key: 'points', perm: 'config.view', icon: 'chart', label: '跑分设置', url: '/packageAdmin/config/points' },
      { key: 'anticheat', perm: 'config.view', icon: 'secured', label: '反作弊', url: '/packageAdmin/config/anticheat' },
    ],
  },
  {
    key: 'appeal',
    title: '申诉审核',
    items: [
      { key: 'appeals', perm: 'appeal.view', icon: 'assignment-checked', label: '申诉审核', url: '/packageAdmin/appeals/appeals' },
    ],
  },
  {
    key: 'content',
    title: '内容与通知',
    items: [
      { key: 'announcements', perm: 'content.view', icon: 'notification', label: '公告', url: '/packageAdmin/content/announcements' },
      { key: 'holidays', perm: 'content.view', icon: 'calendar-1', label: '节假日', url: '/packageAdmin/content/holidays' },
      // 徽章 / 版本日志：内容管理的独立页面，只在管理中枢有入口。
      // 「内容中枢」入口已按用户要求删除（公告、节假日、徽章、版本日志都已经在下面平铺，中枢页反而是一层多余点击）。
      { key: 'badges', perm: 'content.view', icon: 'star', label: '徽章', url: '/packageAdmin/content/badges' },
      { key: 'changelogs', perm: 'content.view', icon: 'history', label: '版本日志', url: '/packageAdmin/content/changelogs' },
    ],
  },
  {
    key: 'ads',
    title: '广告运营',
    items: [
      { key: 'adContents', perm: 'ad.view', icon: 'play-circle', label: '广告素材管理', url: '/packageAdmin/ads/contents' },
      { key: 'adSponsors', perm: 'ad.view', icon: 'user-add', label: '赞助商', url: '/packageAdmin/ads/sponsors' },
      { key: 'adSlots', perm: 'ad.view', icon: 'app', label: '广告位', url: '/packageAdmin/ads/slots' },
      { key: 'adStats', perm: 'ad.view', icon: 'chart-bar', label: '广告统计', url: '/packageAdmin/ads/stats' },
      // 广告落地页：勘察确认它是全仓库**唯一没有入口**的孤儿页（功能完整、只能从素材表单的下拉间接感知）。
      // 用户点名的 4 项里没有它，但让它无入口等于隐藏了一个已上线的能力，故补在此处；不需要可删。
      { key: 'adPages', perm: 'ad.view', icon: 'file-paste', label: '广告落地页', url: '/packageAdmin/ads/pages' },
    ],
  },
  {
    key: 'system',
    title: '系统设置',
    // only:'admin' = 仅「有管理权限」的账号（含超管）。北斗运动是**用户端**页面
    // （激励视频赚步数，学生自己也能从「我的」页连点进入），不能出现在普通学生的管理导航里，
    // 否则「快捷操作」卡会因为它而对所有学生渲染出来。
    only: 'admin',
    items: [
      // 「系统配置」入口已按用户要求删除（用户 2026-10-21「系统设置中不应该有系统配置这一项了」）：
      // 它只是一个分类中转页，里面三项（反作弊 / 跑分设置 / 激励视频）都已经在别处平铺
      // —— 反作弊与跑分设置在「考核与目标」组，激励视频即下面的「北斗运动」。
      // 保留它等于多一层点击、且与已有入口重复。
      // 楼名管理（用户 2026-10-22）：教室/宿舍的楼名白名单，填表时先选楼再填门号。
      // 权限用独立的 building.view（与 config.* 分开：宿管要维护宿舍楼，但不该因此能改计分口径）
      { key: 'buildings', perm: 'building.view', icon: 'city', label: '楼名管理', url: '/packageAdmin/config/buildings' },
      // 示例账户（用户 2026-10-24）：创建 3 个演示账号（班委 / 班主任 / 学生会主席），
      // 密码统一 123456、不绑微信、退出自动解绑、首次改密可跳过。
      // 权限用 config.view 查看、config.manage 创建/清理（与跑分设置同一档：
      // 示例账号能登录学生会复核界面，属于「能影响演示环境的事」）。
      { key: 'demo', perm: 'config.view', icon: 'usergroup-add', label: '示例账户', url: '/packageAdmin/config/demo/demo' },
      { key: 'files', perm: 'file.view', icon: 'folder-open', label: '文件管理', url: '/packageAdmin/files/files' },
      // 「北斗运动」= 激励视频赚步数：用户端页面 /pages/reward/reward 与它的规则配置页
      // /packageAdmin/config/reward-video 是**同一件事的两面**（用户明确说「激励视频规则就是北斗运动」）。
      //
      // ⚠️ 入口必须按 **config.view** 判定（用户 2026-10-22「在管理中枢中没有权限就不应该显示北斗运动」）：
      //   旧实现是 `perm: ''` + `only:'admin'` + fallbackUrl → 只要账号**有任意一项管理权限**
      //   就会显示这个入口（教师组的 appeal.view 也算），点进去还是用户端页面 ——
      //   在管理中枢里等于给「没有激励视频配置权限」的人摆了一个假入口。
      //   用户端那个页面有自己的入口（我的页），不依赖这里。
      { key: 'reward', perm: 'config.view', only: 'admin', icon: 'play-circle', label: '北斗运动', url: '/packageAdmin/config/reward-video' },
    ],
  },
];

// 入口统一的图标底色（沿用首页既有的 td 色板，避免各页各写一套）
const GROUP_TINT = {
  class: { bg: 'var(--tt-brand-soft)', color: 'var(--tt-brand)' },
  union: { bg: 'var(--tt-brand-soft)', color: 'var(--tt-brand)' },
  user: { bg: 'var(--td-success-color-1)', color: 'var(--td-success-color-5)' },
  assessment: { bg: 'var(--td-warning-color-1)', color: 'var(--td-warning-color-5)' },
  appeal: { bg: 'var(--td-warning-color-1)', color: 'var(--td-warning-color-5)' },
  content: { bg: 'var(--td-gray-color-2)', color: 'var(--td-gray-color-8)' },
  ads: { bg: 'var(--td-error-color-1)', color: 'var(--td-error-color-6)' },
  system: { bg: 'var(--tt-brand-soft)', color: 'var(--tt-brand)' },
};

const ALL_PERMS = ['*'];

// 学生会「能管成员」的身份（与服务端 services/union.js::canManageMembers 同一口径）：
//   主席团（president / vice_president，或 deptKey === 'presidium'）、
//   部长 / 副部长（minister / vice_minister 且属于某个部门），
//   或持有 union.manage / union.steward 权限（总管 / 团委老师，可能不在成员名单里）。
// 用途：只有这些人能「扫码加人」，入口不该再露给普通部员（点了必然 403）。
const PRESIDIUM_ROLES = ['president', 'vice_president'];
const MANAGER_ROLES = ['minister', 'vice_minister'];

function canUnionScanJoin(user, perms) {
  if (!user) return false;
  const p = perms || user.effectivePermissions || [];
  if (p.includes('*') || p.includes('union.manage') || p.includes('union.steward')) return true;
  const roles = user.unionRoles || [];
  return roles.some(
    (r) =>
      r &&
      (r.deptKey === 'presidium' ||
        PRESIDIUM_ROLES.includes(r.role) ||
        (MANAGER_ROLES.includes(r.role) && !!r.deptKey))
  );
}

/**
 * 由 /api/auth/me 的 user 对象统一生成 nav 上下文（首页「快捷操作」与管理中枢共用）。
 *
 * 为什么要有这个函数：两个页面前各写一份 ctx（isSuper / isAdmin / isClassRole / isUnionMember），
 * 一旦某个新入口要多一个身份维度（例如「扫码加人」需要 union 角色），就只能各改一份 —— 迟早漂移。
 * `opts.isClassRole` 可由调用方覆盖（管理中枢用 /api/class/mine 的 role 更精确，
 * 那里能拿到「服务端确认过」的班主任 / 班委身份）。
 *
 * @param {Object} user /api/auth/me 的用户对象
 * @param {{isClassRole?: boolean}} [opts]
 */
function navCtx(user, opts = {}) {
  const perms = (user && user.effectivePermissions) || [];
  const isSuper = perms.includes('*');
  const isManager = !!(user && user.isManager) || perms.length > 0;
  const isClassRole =
    opts.isClassRole !== undefined
      ? !!opts.isClassRole
      : !!(((user && user.homeroomClasses) || []).filter(Boolean).length || (user && user.isClassOfficer));
  return {
    perms,
    isSuper,
    isManager,
    isAdmin: isManager,
    isClassRole,
    isUnionMember: !!(user && user.isUnionMember),
    canUnionScanJoin: canUnionScanJoin(user, perms),
    // 「学生会成员」入口可见性（用户 2026-10-28）：
    //   ① 学生身份的干部（主席团 / 部长 / 副部长）—— 他们没有 union.* 权限，但服务端放行；
    //   ② 持 union.view（或 union.steward / '*'）的管理员、团委老师。
    // 这两类人必须都能进，否则主席团在管理中枢里就少一个入口。
    canViewMembers: canUnionScanJoin(user, perms) || isSuper || perms.includes('union.view') || perms.includes('union.steward'),
  };
}

/**
 * 单条入口是否可见
 * @param {Object} item  NAV_GROUPS 里的条目
 * @param {Object} ctx   { isSuper, perms: [], isClassRole, isUnionMember, isAdmin }
 */
function entryVisible(item, ctx) {
  if (!item) return false;
  const c = ctx || {};
  const perms = c.perms || [];
  const isSuper = !!c.isSuper || perms.includes('*');
  const isAdmin = !!c.isAdmin || isSuper || perms.length > 0;
  // only：身份维度（与权限维度是「与」关系：既要有身份，也不能缺权限）
  if (item.only === 'admin' && !isAdmin) return false;
  if (item.only === 'class' && !c.isClassRole) return false;
  // 「能管学生会成员的人」：主席团 / 部长 / 副部长 / 总管（见 canUnionScanJoin）
  if (item.only === 'unionManager' && !c.canUnionScanJoin) return false;
  // 「学生会成员」入口：干部（无管理权限的学生）与持 union.view 的管理员都能进（见 navCtx.canViewMembers）
  if (item.only === 'unionMembersEntry' && !c.canViewMembers) return false;
  // 检查记录：学生会成员（按身份范围）或学生会总管（全校）；纯 union.view 不放行（服务端会 403）
  if (item.only === 'unionRecords' && !(c.isUnionMember || isSuper || perms.includes('union.steward'))) {
    return false;
  }
  if (item.only === 'unionMember' && !c.isUnionMember && !isAdmin && !perms.some((p) => p.indexOf('union.') === 0)) {
    return false;
  }
  if (!item.perm) return true;
  return isSuper || perms.includes(item.perm);
}

// 分类标题按人群动态取（仅「班级」这一组）：
//   · 只有教师的「我的班级」→ 标题就是「我的班级」
//   · 只有管理员的全校台账  → 标题就是「班级管理」
//   · 两者都有（既是班主任又有 class.view）→ 用「班级管理」（它是这一组的上位概念）
// 用户明确的口径（2026-10-19 澄清后）：班级管理 = 管所有班级；教师管自己名下的班那个**入口**仍叫我的班级。
// 注意：页面标题叫「班超联赛」（因为它承载班超评比内容），但**入口文案不跟着改** —— 两者是不同层面。
function groupTitle(g, items) {
  if (g.key !== 'class') return g.title;
  const hasMy = items.some((it) => it.key === 'classMy');
  const hasManage = items.some((it) => it.key === 'classManage');
  if (hasManage) return '班级管理';
  if (hasMy) return '我的班级';
  return g.title;
}

/**
 * 按上下文过滤出可见分组（空分组整组丢弃，保留 8 类的展示顺序）
 * 每条入口都会带上 bg / color（分类色）：页面模板直接用 `item.bg` 即可，
 * 不必各自再摊一遍分类色 —— 之前 hub.js 摊、home.js 没摊，两处渲染出来的图标底色就不一样。
 * @returns {Array} [{ key, title, tint, items: [{ ..., bg, color }] }]
 */
function visibleGroups(ctx) {
  const out = [];
  for (const g of NAV_GROUPS) {
    // 分组级 only 作为该组条目的**默认值**（条目自己写了 only 就以条目为准）——
    // 这样「我的班级」「学生会」「系统设置」三个身份组不用给每个条目重复写 only
    const tint = GROUP_TINT[g.key] || GROUP_TINT.system;
    const items = (g.items || [])
      .filter((it) => entryVisible({ ...it, only: it.only === undefined ? g.only : it.only }, ctx))
      .map((it) => {
        const item = { ...it, bg: it.bg || tint.bg, color: it.color || tint.color };
        // 权限择一：声明了 fallbackUrl 的条目，当前账号无 perm 时退到 fallbackUrl
        // （例：北斗运动 —— 管理员进规则配置页，没 config.view 的进用户端页面）
        if (item.fallbackUrl && item.perm && !entryVisible({ perm: item.perm }, ctx)) {
          item.url = item.fallbackUrl;
        }
        return item;
      });
    if (!items.length) continue;
    out.push({ key: g.key, title: groupTitle(g, items), items, tint });
  }
  return out;
}

// 首页「快捷操作」卡是否渲染：有任何可见入口就渲染（与 isManager 解耦 ——
// 班主任 / 班委没有管理权限，但「我的班级」组必须能看到）
function hasAnyEntry(ctx) {
  return visibleGroups(ctx).length > 0;
}

// ===== 首页「快捷操作」的额外过滤（**不影响管理中枢**）=====
// 用户明确要求：学生会**学生**不再在首页快捷操作里看到「学生会」分类 ——
// 他们已经有独立的学生会卡片（首页学生会块）与底部「学生会」tab，再列一排管理导航是重复的。
//
// ⚠️ 为什么不能直接从 NAV_GROUPS 删掉这个分组：这份数据是**管理中枢与首页共用**的同一份源
//   （见文件头注释）。删分组会连管理中枢一起消失，**持 union.view/union.manage 的管理员**（学生处、
//   团委）会失去「学生会成员 / 学生会配置」的入口 —— 那是他们唯一的入口。
//   所以只在**首页**这一侧排除，管理中枢保持原样。
//
// 判定口径：**纯学生会成员**（has 身份但没有该分类下的任何 perm）才排除；
//   持 union.* 权限的管理员照旧显示（他们要在这里进成员/配置页）。
const HOME_EXCLUDED_GROUPS = new Set(['union']);

function homeGroups(ctx) {
  const groups = visibleGroups(ctx);
  const perms = (ctx && ctx.perms) || [];
  const isSuper = !!(ctx && ctx.isSuper) || perms.includes('*');
  return groups.filter((g) => {
    if (!HOME_EXCLUDED_GROUPS.has(g.key)) return true;
    // 该分类下只要有一条是「靠权限进来的」就保留整组（管理员的入口不能丢）。
    //
    // ⚠️ 除了看 item.perm，还要看「靠 union.* 权限进来」的条目（用户 2026-10-28）：
    //   「学生会成员」改成 only:'unionMembersEntry' 后 perm 是空串，
    //   如果只判 item.perm，持 union.view 的管理员在**首页**就看不到「学生会」分类了
    //   （他们唯一的入口）。这里把这类身份条目也按「是否靠 union.* 权限」算进来。
    return g.items.some((it) => {
      if (it.perm && (isSuper || perms.includes(it.perm))) return true;
      // unionMembersEntry 的权限来源就是 union.view / union.steward（见 navCtx.canViewMembers）
      if (it.only === 'unionMembersEntry') {
        return isSuper || perms.includes('union.view') || perms.includes('union.steward');
      }
      return false;
    });
  });
}

// 首页快捷操作卡是否渲染（按上面过滤后的结果判定）：只有学生会身份、没有管理入口的账号，
// 不再因为「学生会」组而显示一整张快捷操作卡；但「我的班级」这类身份组仍会让它显示。
function hasHomeEntry(ctx) {
  return homeGroups(ctx).length > 0;
}

module.exports = {
  NAV_GROUPS,
  GROUP_TINT,
  entryVisible,
  visibleGroups,
  hasAnyEntry,
  homeGroups,
  hasHomeEntry,
  navCtx,
  canUnionScanJoin,
};
