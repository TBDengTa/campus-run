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
    title: '我的班级',
    // only:'class' = 班主任 / 班委（无管理权限也显示）
    only: 'class',
    items: [
      { key: 'classManage', perm: '', only: 'class', icon: 'usergroup', label: '班级管理', url: '/packageAdmin/class/class' },
      { key: 'classRank', perm: '', only: 'class', icon: 'chart-bar', label: '班超排名', url: '/packageUnion/stats/stats' },
    ],
  },
  {
    key: 'union',
    title: '学生会',
    only: 'unionMember',
    items: [
      { key: 'unionMembers', perm: 'union.view', icon: 'usergroup', label: '学生会成员', url: '/packageAdmin/union/members/members' },
      { key: 'unionConfig', perm: 'union.manage', icon: 'setting', label: '学生会配置', url: '/packageAdmin/union/config/config' },
      { key: 'unionRecords', perm: '', only: 'unionMember', icon: 'file-paste', label: '检查记录', url: '/packageUnion/records/records' },
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
      { key: 'assessmentIndex', perm: 'assessment.view', icon: 'task-checked', label: '运动考核', url: '/packageAdmin/assessment/index' },
      // 「默认目标」（全局日/周目标）与「计划目标」（计划库）是两个不同页面，都要给直接入口：
      // 只留分类中枢会让它们降级成二级入口（用户口头点名的「默认计划」就是指默认目标这一页）。
      // 「跑分设置」「反作弊」在页面上属于系统配置，但产品口径把它们归在考核里（用户明确要求）。
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
      // 以下三项是用户 8 类之外的既有内容管理页面，同样只在管理中枢有入口 ——
      // 折进本分类以保持可达（不需要可整块删掉，前后无耦合）
      { key: 'contentIndex', perm: 'content.view', icon: 'layers', label: '内容中枢', url: '/packageAdmin/content/index' },
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
      { key: 'config', perm: 'config.view', icon: 'setting', label: '系统配置', url: '/packageAdmin/config/config' },
      { key: 'files', perm: 'file.view', icon: 'folder-open', label: '文件管理', url: '/packageAdmin/files/files' },
      // 「北斗运动」= 激励视频赚步数：用户端页面 /pages/reward/reward 与它的规则配置页
      // /packageAdmin/config/reward-video 是**同一件事的两面**（用户明确说「激励视频规则就是北斗运动」），
      // 所以**只保留一个条目**（曾经拆成两条，用户否掉了）。
      // url 由 visibleGroups 按权限择一：有 config.view 的管理员进规则配置页（那是「管理」该来的地方），
      // 否则进用户端页面 —— 这样不会出现「点了必然 403」的入口。
      {
        key: 'reward',
        perm: '',
        only: 'admin',
        icon: 'play-circle',
        label: '北斗运动',
        url: '/packageAdmin/config/reward-video',
        fallbackUrl: '/pages/reward/reward',
      },
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
  if (item.only === 'unionMember' && !c.isUnionMember && !isAdmin && !perms.some((p) => p.indexOf('union.') === 0)) {
    return false;
  }
  if (!item.perm) return true;
  return isSuper || perms.includes(item.perm);
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
    out.push({ key: g.key, title: g.title, items, tint });
  }
  return out;
}

// 首页「快捷操作」卡是否渲染：有任何可见入口就渲染（与 isManager 解耦 ——
// 班主任 / 班委没有管理权限，但「我的班级」组必须能看到）
function hasAnyEntry(ctx) {
  return visibleGroups(ctx).length > 0;
}

module.exports = { NAV_GROUPS, GROUP_TINT, entryVisible, visibleGroups, hasAnyEntry };
