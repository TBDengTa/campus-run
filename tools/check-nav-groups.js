// 可重复运行：用打桩运行时实跑 home.js / hub.js 的管理入口构建逻辑，核对分类与角色矩阵
// 运行：node tools/check-nav-groups.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const navGroups = require(path.join(ROOT, 'utils/nav-groups'));
// 记录跳转目标（wx.navigateTo / switchTab），供「点条目 → 进页面」断言使用
const navLog = [];

function loadPage(rel, user, classMine, unionDash) {
  let page = null;
  const behaviorDefs = []; // 本次加载中收集到的 Behavior 定义
  const sandbox = {
    console,
    require(p) {
      if (p.includes('utils/request')) {
        return {
          env: {},
          // 只对真正用到的接口返回数据，其余一律 reject —— 与真环境一致。
          // （早前版本对所有未知 url 都返回 {}，导致 refresh() 里的 .catch 链路行为失真、
          //   mgrGroups 根本没被赋值，测试假绿。）
          get: async (url) => {
            if (url.includes('/api/class/mine')) return classMine;
            if (url.includes('/api/run/today')) return { record: null, goal: { daily: { steps: 0 }, weekly: {} } };
            if (url.includes('/api/run/week')) return { records: [] };
            if (url.includes('/api/ads/slot/')) return [];
            if (url.includes('/api/content/announcements')) return [];
            if (url.includes('/api/points/me')) return null;
            if (url.includes('/api/admin/dashboard/overview')) {
              return { totalUsers: 1500, activeToday: 800, stepsToday: 9000000, recordsToday: 900, pendingAppeals: 2 };
            }
            if (url.includes('/api/admin/dashboard/top3')) return { individuals: [], classes: [] };
            // 首页「身份与待办」单卡的三路数据源（2026-11-23 首页重设计）
            if (url.includes('/api/union/dashboard')) return unionDash || null;
            if (url.includes('/api/class/overview')) return { studentCount: 48, achievedToday: 20, activeToday: 30, weeklyRate: 62 };
            if (url.includes('/api/union/class/')) return { score: 8.4, ranking: { rank: 3, total: 43 }, rangeLabel: '今日' };
            if (url.includes('/api/auth/me')) return user;
            if (url.includes('/api/class/mine')) return classMine;
            throw new Error('未打桩的接口: ' + url);
          },
          post: async (url) => {
            if (url.includes('/api/badges/check')) return { newBadges: [] };
            if (url.includes('/pv')) return {};
            throw new Error('未打桩的 POST: ' + url);
          },
          getUser: () => user,
        };
      }
      if (p.includes('utils/format')) {
        return {
          todayKey: () => '2026-03-08',
          formatNumber: (n) => String(n),
          formatDistance: (n) => String(n),
          formatDuration: (n) => String(n),
          scoreText: (v) => (typeof v === 'number' ? v.toFixed(2) : '—'),
          parseDateKey: () => ({ m: 3, d: 8, week: '周日' }),
        };
      }
      if (p.includes('utils/nav-groups')) return navGroups;
      // 管理 dashboard 取数模块（管理员首页用；工作台已移除）：桩返回与真接口同形态的数据，
      // canViewDashboard 与真实实现同口径（dashboard.view / '*'）。
      if (p.includes('utils/dashboard')) {
        return {
          canViewDashboard: (u) => {
            const perms = (u && u.effectivePermissions) || [];
            return perms.includes('*') || perms.includes('dashboard.view');
          },
          fetchOverview: async () => ({
            totalUsers: 1500, activeToday: 800, stepsToday: 9000000, recordsToday: 900,
            pendingAppeals: 2, stepsTodayText: '9000000',
          }),
          fetchTop3: async () => ({ rangeText: '本周', individuals: [], classes: [] }),
        };
      }
      // 分享归因工具只在页面 onShow 里用；nav-groups 测试不关心它的网络行为，
      // 但页面 require 它是真实依赖，必须给一个无副作用的桩。
      if (p.includes('utils/beidou-share')) return { capture() {}, flush: async () => null, pending: () => null, clear() {} };
      // behaviors/*.js 的加载需要 `Behavior` 全局（它只存在于小程序运行时里）：
      // 临时挂到 node global 上真实 require，拿到 Behavior 定义，之后再清理。
      // 这样页面里 behaviors: [x] 拿到的是真定义（例：screen behavior 的 data.screenMode）。
      if (p.includes('behaviors/')) {
        // 页面里的路径是相对 miniprogram/ 的（如 '../../behaviors/nav-sheet'），
        // 而 ROOT 已经指向 miniprogram，所以剥掉前导 '../' 再拼到 ROOT 上。
        const cleaned = p.replace(/^(\.\.\/)+/, '');
        const target = path.join(ROOT, cleaned);
        const prev = global.Behavior;
        global.Behavior = (def) => def;
        try {
          // eslint-disable-next-line global-require, import/no-dynamic-require
          return require(target);
        } finally {
          if (prev === undefined) delete global.Behavior;
          else global.Behavior = prev;
        }
      }
      throw new Error('unexpected require ' + p);
    },
    getApp: () => ({
      ensureLogin: async () => user,
      requireLogin: () => true,
      refreshUser: async () => user,
      globalData: { userInfo: user },
      applyAdGate: () => false,
    }),
    wx: {
      setNavigationBarTitle() {},
      // 把页面里的错误提示打出来：否则 refresh() 抛错时测试只会看到"0 组"，查不出原因
      showToast: (o) => console.log('    [toast]', o && (o.title || o.content)),
      showModal: (o) => console.log('    [modal]', o && (o.title || o.content)),
      getFileSystemManager: () => ({ accessSync: () => { throw new Error('no file'); } }),
      getImageInfo: () => {},
      stopPullDownRefresh() {},
      reLaunch: (o) => console.log('    [reLaunch]', o && o.url),
      // 记住跳转目标，供断言用（不再只打日志）
      navigateTo: (o) => {
        navLog.push(o && o.url);
      },
      switchTab: (o) => {
        navLog.push(o && o.url);
      },
    },
    Page: (def) => {
      page = def;
    },
    Component: () => {},
    // 收集 Behavior 定义（页面里 behaviors: [...] 拿到的就是这个返回值）
    Behavior: (def) => {
      behaviorDefs.push(def);
      return { __behavior: def };
    },
    setTimeout,
    Promise,
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox);
  // 挂上 setData / 生命周期所需的最小实现
  page.data = JSON.parse(JSON.stringify(page.data || {}));
  // 模拟小程序的 Behavior 合并：data 先合并，methods 挂到页面实例上（后合并的覆盖先合并的）。
  // behaviors: [x] 里的 x 就是 require 返回的 Behavior 定义（含 data / methods）。
  const declaredBehaviors = [];
  for (const b of page.behaviors || []) if (b && (b.methods || b.data)) declaredBehaviors.push(b);
  for (const bd of [...behaviorDefs, ...declaredBehaviors]) {
    page.data = { ...(bd.data || {}), ...page.data };
    for (const [k, fn] of Object.entries(bd.methods || {})) {
      if (typeof page[k] === 'undefined') page[k] = fn;
    }
  }
  page.setData = function setData(patch) {
    for (const [k, v] of Object.entries(patch)) this.data[k] = v;
  };
  page.getTabBar = () => null;
  // Behavior 是真实 Node 模块，内部引用的是**全局 wx**（不在 vm sandbox 里），
  // 所以这里把 sandbox 的 wx 也挂到 global 上，测试才能观测到 navigateTo 的目标。
  if (!global.__navTestWx) {
    global.__navTestWx = sandbox.wx;
    global.wx = sandbox.wx;
  }
  page.__wx = sandbox.wx;
  return page;
}

const ROLES = [
  {
    name: '超级管理员',
    user: { _id: 'u1', realName: '管理员', role: 'teacher', effectivePermissions: ['*'], isManager: true, homeroomClasses: [], isClassOfficer: false, isUnionMember: false, className: '' },
    mine: { role: null, classes: [] },
  },
  {
    name: '班主任(无管理权限)',
    user: { _id: 'u1', realName: '张老师', role: 'teacher', effectivePermissions: [], isManager: false, homeroomClasses: ['23级大数据技术'], isClassOfficer: false, isUnionMember: false, className: '' },
    mine: { role: 'homeroom', classes: ['23级大数据技术'] },
  },
  {
    name: '班委(学生,无权限)',
    user: { _id: 'u1', realName: '李班委', role: 'student', effectivePermissions: [], isManager: false, homeroomClasses: [], isClassOfficer: true, isUnionMember: false, className: '23级大数据技术' },
    mine: { role: 'officer', classes: ['23级大数据技术'] },
  },
  {
    name: '学生会管理员',
    user: { _id: 'u1', realName: '王同学', role: 'student', effectivePermissions: ['union.view', 'union.manage'], isManager: true, homeroomClasses: [], isClassOfficer: false, isUnionMember: true, className: '23级大数据技术' },
    mine: { role: null, classes: [] },
    unionDash: { canReview: true, pendingReview: 3, modules: [{ entered: 2, expected: 5 }, { entered: 0, expected: 0, optionalWhenMissing: true }] },
  },
  {
    // **纯学生会成员**（有 union 身份、但没有任何 union.* 管理权限）：
    // 首页只该出现「学生会 / 待复核」待办行，不该有任何管理面板；
    // 工作台必须保留「学生会」分类（学生处/团委持 union.* 权限时的唯一入口）。
    name: '学生会成员(无管理权限)',
    user: { _id: 'u1', realName: '孙部员', role: 'student', effectivePermissions: [], isManager: false, homeroomClasses: [], isClassOfficer: false, isUnionMember: true, className: '23级大数据技术' },
    mine: { role: null, classes: [] },
    unionDash: { canReview: false, pendingReview: 0, modules: [{ entered: 1, expected: 4 }] },
  },
  {
    // **学生会总管**（用户 2026-10-20 新增）：团委老师 / 学生处干事，
    // **本人不是学生会成员**，但持 union.steward —— 服务端有效权限已自动展开出
    // union.view + union.manage，所以管理中枢与首页都应显示「学生会」分类（不需要成员身份）。
    name: '学生会总管(非成员)',
    user: { _id: 'u1', realName: '周老师', role: 'teacher', effectivePermissions: ['union.steward', 'union.view', 'union.manage', 'user.view'], isManager: true, homeroomClasses: [], isClassOfficer: false, isUnionMember: false, className: '' },
    mine: { role: null, classes: [] },
  },
  {
    name: '普通学生',
    user: { _id: 'u1', realName: '赵同学', role: 'student', effectivePermissions: [], isManager: false, homeroomClasses: [], isClassOfficer: false, isUnionMember: false, className: '23级大数据技术' },
    mine: { role: null, classes: [] },
  },
  {
    // **普通教师**（内置「教师管理组」的真实权限：7 项 *.view / appeal.review，
    // 但没有 config.view / building.view / file.view / ad.view / permission.manage / union.manage）。
    // 用户 2026-10-22 两条要求都靠这个角色守：
    //   ① 「在管理中枢中没有权限就不应该显示北斗运动」→ 北斗运动现在要 config.view；
    //   ② 「学生会扫码加入不应该显示」→ 扫码加人要主席团/部长/副部长/总管，普通教师/普通部员都没有。
    name: '教师(仅查看类权限)',
    user: {
      _id: 'u1',
      realName: '刘老师',
      role: 'teacher',
      effectivePermissions: ['appeal.view', 'appeal.review', 'content.view', 'assessment.view', 'dashboard.view', 'union.view', 'user.view'],
      isManager: true,
      homeroomClasses: [],
      isClassOfficer: false,
      isUnionMember: false,
      className: '',
    },
    mine: { role: null, classes: [] },
    hideEntries: ['北斗运动', '扫码加人', '检查记录'],
  },
];

let failed = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -> ${detail}`}`);
  if (!cond) failed += 1;
};

(async () => {
  for (const r of ROLES) {
    console.log(`\n=== ${r.name} ===`);
    // ---- 首页（2026-11-23 重设计：个人今日视图 + 单一「身份与待办」卡）----
    // 首页不再有任何管理面板 / 快捷操作浮层；身份只以计数行出现，行内直跳或进工作台。
    const home = loadPage('pages/home/home.js', r.user, r.mine, r.unionDash);
    await home.refresh();
    // refresh() 里 loadTodoRows 不 await（不阻塞首屏），测试显式等一次再断言
    await home.loadTodoRows(r.user);
    const rows = home.data.todoRows || [];
    const keys = rows.map((x) => x.key);
    check('首页不再有管理面板 / 快捷操作浮层', home.data.mgrGroups === undefined && typeof home.onNavCellTap === 'undefined', JSON.stringify({ mgr: home.data.mgrGroups, tap: typeof home.onNavCellTap }));
    check('待办卡显隐与行数一致', home.data.showTodoCard === (rows.length > 0), `${home.data.showTodoCard} vs ${rows.length}`);
    check('待办行 key 不重复（多身份叠加不堆卡）', new Set(keys).size === keys.length, keys.join(','));
    console.log(`  首页待办行：${keys.join('、') || '（无）'}`);
    // 角色矩阵：每种身份只对应自己的行，无身份 = 无卡
    const isMember = !!r.user.isUnionMember;
    check('学生会行仅成员可见', keys.includes('union') === isMember, keys.join(','));
    const wantReview = !!(isMember && r.unionDash && r.unionDash.canReview && r.unionDash.pendingReview > 0);
    check('待复核行仅在 canReview 且有.pending 时出现', keys.includes('review') === wantReview, keys.join(','));
    const hasClass = !!(r.mine && r.mine.role && (r.mine.classes || []).length);
    check('班超行仅班级身份可见', keys.includes('banchao') === hasClass, keys.join(','));
    check('校园跑行仅班级身份可见', keys.includes('run') === hasClass, keys.join(','));
    const perms = r.user.effectivePermissions || [];
    const canDash = perms.includes('*') || perms.includes('dashboard.view');
    check('申诉行仅 dashboard.view 可见（isManager 不等于有看板权限）', keys.includes('appeal') === canDash, keys.join(','));
    // 每行都要有图标 / 文案 / 跳转目标（WXML 零运算，全靠 JS 预计算）
    const badRow = rows.filter((x) => !x.icon || !x.title || !x.valueText || !x.url);
    check('待办行字段齐全（icon/title/valueText/url）', badRow.length === 0, JSON.stringify(badRow));
    const bcRow = rows.find((x) => x.key === 'banchao');
    const runRow = rows.find((x) => x.key === 'run');
    if (bcRow && runRow) {
      const single = (r.mine.classes || []).length === 1;
      check(
        single ? '单班：班超行直跳班超联赛 tab 带 className' : '多班：班超行聚合进工作台选班',
        single
          ? !bcRow.tab && bcRow.url.includes('/packageAdmin/class/class?tab=attendance&className=')
          : bcRow.tab === true && bcRow.url === '/pages/hub/hub',
        bcRow.url
      );
      check(
        single ? '单班：校园跑行直跳校园跑 tab 带 className' : '多班：校园跑行聚合进工作台选班',
        single
          ? !runRow.tab && runRow.url.includes('/packageAdmin/class/class?tab=run&className=')
          : runRow.tab === true && runRow.url === '/pages/hub/hub',
        runRow.url
      );
      check('班超行带分数（10 分制两位小数）', /\d\.\d{2}|—/.test(bcRow.valueText), bcRow.valueText);
      check('校园跑行带达标人数', runRow.valueText.includes('达标'), runRow.valueText);
    }
    // 行内直跳：点行 → 跳该行 url（tab 行用 switchTab，其余 navigateTo，都进 navLog）
    if (rows.length) {
      navLog.length = 0;
      home.goTodoRow({ currentTarget: { dataset: { key: rows[0].key } } });
      check('点待办行 → 跳该行 url', navLog.length === 1 && navLog[0] === rows[0].url, JSON.stringify(navLog));
      navLog.length = 0;
      home.goWorkbench();
      check('卡头「工作台」→ switchTab 工作台', navLog.length === 1 && navLog[0] === '/pages/hub/hub', JSON.stringify(navLog));
    }
    // 管理员首页也要有数据概况（用户 2026-11-23 复核），与工作台同一份取数实现
    check('首页 dashboard 显隐按 dashboard.view', home.data.canDashboard === canDash, `${home.data.canDashboard} vs ${canDash}`);
    if (canDash) {
      await home.loadOverview();
      await home.loadTop3();
      check('首页数据概况已加载', !!home.data.overview && home.data.overview.stepsTodayText !== undefined, JSON.stringify(home.data.overview));
    } else {
      check('无看板权限首页不拉概况', home.data.overview === null, JSON.stringify(home.data.overview));
    }

    // ---- 管理中枢（**平铺**：分类 + 按钮，点按钮直接进页面）----
    const hub = loadPage('pages/hub/hub.js', r.user, r.mine, r.unionDash);
    await hub.load();
    const gg = hub.data.groups;
    check('工作台 groups 是数组', Array.isArray(gg), typeof gg);
    // 权限不够的入口必须**彻底不出现**（用户 2026-10-22「没有权限就不应该显示」）
    if (r.hideEntries && r.hideEntries.length) {
      const labels = gg.flatMap((g) => g.items.map((i) => i.label));
      for (const h of r.hideEntries) {
        check(`工作台不显示「${h}」（没有对应权限）`, !labels.includes(h), labels.join('、'));
      }
    }
    // 每个条目必须带 bg/color（模板直接用）
    const missingTint = gg.flatMap((g) => g.items.filter((i) => !i.bg || !i.color)).map((i) => i.label);
    check('工作台每个入口都带图标底色', missingTint.length === 0, missingTint.join(','));
    // 「学生会」分类：工作台**永远保留**（持 union.* 权限的管理员的唯一入口）
    const hubHasUnion = gg.some((g) => g.key === 'union');
    check('工作台始终保留「学生会」分类（管理员入口不能丢）', !r.user.isUnionMember || hubHasUnion, `isMember=${r.user.isUnionMember} hubHasUnion=${hubHasUnion}`);
    // 数据概况已移出工作台（用户 2026-11-24「工作台去掉数据概况」，管理员首页保留）：
    // 工作台只做入口平铺，canDashboard/overview 与取数方法都不应再存在
    check(
      '工作台不再承载数据概况（字段与取数方法均已移除）',
      hub.data.canDashboard === undefined &&
        hub.data.overview === undefined &&
        typeof hub.loadOverview !== 'function' &&
        typeof hub.loadTop3 !== 'function',
      JSON.stringify({ canDashboard: hub.data.canDashboard, overview: hub.data.overview })
    );
    // 平铺交互：每个分类下的条目都要有 url + icon + bg/color，且页面用 go() 直跳
    const flatBad = gg.flatMap((g) => (g.items || []).filter((it) => !it.url || !it.icon || !it.bg || !it.color)).map((it) => it.label);
    check('管理中枢每条入口都带 url/icon/底色（可直接平铺渲染）', flatBad.length === 0, flatBad.join(','));
    check('管理中枢用平铺点击 go()（不是浮层）', typeof hub.go === 'function' && typeof hub.onNavCellTap !== 'function', `go=${typeof hub.go} onNavCellTap=${typeof hub.onNavCellTap}`);
    // 除「我的班级」（走选班）外的条目：go() 都应直接 navigateTo
    const flatEntry = gg
      .flatMap((g) => g.items)
      .find((it) => it.key !== 'classMy' && it.url);
    if (flatEntry) {
      navLog.length = 0;
      hub.go({ currentTarget: { dataset: { url: flatEntry.url, key: flatEntry.key } } });
      check('管理中枢点按钮直跳页面', navLog.length === 1 && navLog[0] === flatEntry.url, JSON.stringify(navLog));
    }
    // 教师的「我的班级」条目 key = classMy → go() 必须走选班（不能直跳，多班会静默走错班）
    // 管理员的「班级管理」条目 key = classManage → 直跳台账页
    const myEntry = gg.flatMap((g) => g.items).find((it) => it.key === 'classMy');
    if (myEntry && r.name.includes('班主任')) {
      navLog.length = 0;
      hub.go({ currentTarget: { dataset: { url: myEntry.url, key: myEntry.key } } });
      check(
        '管理中枢「我的班级」走选班（单班直接进该班，带 className）',
        // 用 [?&] 而不是 \?：URL 还有 tab=attendance（落「班超」tab），className 不再紧跟问号
        navLog.length === 1 && /[?&]className=/.test(navLog[0] || ''),
        JSON.stringify(navLog)
      );
    }
    const adminEntry = gg.flatMap((g) => g.items).find((it) => it.key === 'classManage');
    if (adminEntry) {
      check('「班级管理」条目指向全校台账页', /class-manage\/class-manage/.test(adminEntry.url), adminEntry.url);
      navLog.length = 0;
      hub.go({ currentTarget: { dataset: { url: adminEntry.url, key: adminEntry.key } } });
      check('管理中枢「班级管理」直跳台账页（不弹选班）', navLog.length === 1 && navLog[0] === adminEntry.url, JSON.stringify(navLog));
    }
    // 命名口径（2026-10-19 用户澄清）：教师侧**入口**仍叫「我的班级」（页面标题才叫「班超联赛」）；
    // 管理员侧必须叫「班级管理」。别把入口文案跟页面标题一起改。
    if (myEntry) check('教师条目文案 = 我的班级', myEntry.label === '我的班级', myEntry.label);
    if (adminEntry) check('管理员条目文案 = 班级管理', adminEntry.label === '班级管理', adminEntry.label);

    // ===== 班级状态总览（用户 2026-10-29）=====
    // 「增加班级状态页面显示所有班级的考勤、校园跑达标(日、周)，
    //   并且可以复制到文本如未达标班级等」。
    //
    // ⚠️ 判定「该轮次应不应有这条」必须只看**权限**，不能看角色名：
    //   学生会管理员名字里带「管理」，但他没有 class.view，本就不该看到 ——
    //   按名字匹配会把他误判成"应有"。
    //   ⚠️ 权限字段是 `r.user.effectivePermissions`，**不是** r.perms（角色对象上没有 perms 字段，
    //      写成 r.perms 会恒为 undefined → 超级管理员被当成"无权限"，白红一条）。
    const statusEntry = gg.flatMap((g) => g.items).find((it) => it.key === 'classStatus');
    const rolePerms = (r.user && r.user.effectivePermissions) || [];
    const hasClassView = rolePerms.some((p) => p === '*' || p === 'class.view');
    if (hasClassView) {
      check(`「班级状态」入口存在（有 class.view：${r.name}）`, !!statusEntry, r.name);
      if (statusEntry) {
        check('「班级状态」权限 = class.view（与班级管理同档）', statusEntry.perm === 'class.view', statusEntry.perm);
        check('「班级状态」指向独立页面', /class-status\/class-status/.test(statusEntry.url), statusEntry.url);
        navLog.length = 0;
        hub.go({ currentTarget: { dataset: { url: statusEntry.url, key: statusEntry.key } } });
        check('管理中枢「班级状态」直跳（不弹选班）', navLog.length === 1 && navLog[0] === statusEntry.url, JSON.stringify(navLog));
      }
    } else {
      // 无 class.view 的账号（教师 / 班委 / 学生 / 学生会管理员）不得看到全校班级状态入口：
      // 那是学生处 / 年级组长的横比视图，班级域成员用「我的班级」看本班即可。
      check(
        `「班级状态」不出现在无 class.view 的账号导航（角色：${r.name}）`,
        !statusEntry,
        statusEntry && statusEntry.key
      );
    }
  }

  // ===== 关于我们：GitHub 开源入口 + 版本一致性（用户 2026-10-23）=====
  // 「在关于我们中增加本项目已经在 github 上开源」+「版本一致都是 2.0.0」。
  // 这个入口是纯静态文案 + 复制链接，没有权限逻辑，最容易在后续改版中被顺手删掉，
  // 所以单独守住：文案、点击处理、仓库地址、版本号四处必须一致。
  {
    const aboutWxml = fs.readFileSync(path.join(ROOT, 'pages/about/about.wxml'), 'utf8');
    const aboutJs = fs.readFileSync(path.join(ROOT, 'pages/about/about.js'), 'utf8');
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    check('关于我们展示 GitHub 开源信息', /GitHub/.test(aboutWxml), '页面没有 GitHub 文案');
    check('开源条目可点击（copyRepo）', aboutWxml.includes('bind:tap="copyRepo"'), '缺少 bind:tap="copyRepo"');
    check('JS 实现 copyRepo', /copyRepo\s*\(/.test(aboutJs), 'about.js 缺 copyRepo');
    check(
      '仓库地址与 git remote 一致',
      aboutJs.includes('https://github.com/TBDengTa/campus-run'),
      'repoUrl 与 origin 不一致'
    );
    // 版本号三处一致：about.js / README 首屏 / server/package.json
    // （根目录没有 package.json，版本以 server/package.json 为唯一机器可读来源）
    const aboutVer = (aboutJs.match(/version:\s*'([\d.]+)'/) || [])[1];
    const serverPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'package.json'), 'utf8'));
    // ⚠️ 不要在这里写死版本号（以前写 '2.0.0'，每次升版这条断言就误报一次，
    //    还会诱导人去改断言而不是改真版本 —— 2026-10-27 升 2.0.4 时踩到）。
    // 正确口径：三处互相一致 + 与 package.json 同源，具体是几号由 package.json 决定。
    check(
      `关于我们版本号 = ${serverPkg.version}（以 package.json 为准）`,
      aboutVer === serverPkg.version,
      `about.js: ${aboutVer} / package.json: ${serverPkg.version}`
    );
    check('README 版本号与关于我们一致', readme.includes(`v${aboutVer}`), `README 未见 v${aboutVer}`);
    check('server/package.json 版本一致', serverPkg.version === aboutVer, `package.json: ${serverPkg.version}`);
    // 紧凑排版：不允许再出现大 hero 或 2×2 图标卡（回退到旧版会撑满首屏）
    check(
      '关于我们为紧凑排版（无 hero、无 2×2 大图标卡）',
      !/tt-hero/.test(aboutWxml) && !/about-feature\b/.test(aboutWxml),
      '仍在用 hero / 大图标卡'
    );
  }

  // ===== 玻璃 tabBar：多身份统一「工作台」（用户 2026-11-23）=====
  // 旧逻辑「动态项只放 1 个」会把多身份用户的入口挤掉（班委+学生会丢学生会、管理员+班委丢班级）。
  // 新契约：底栏动态项**只有一个「工作台」**，全部身份入口收进 hub 页；学生 ≤6 项、教师恒 3 项。
  {
    console.log('\n=== 玻璃 tabBar：统一工作台 ===');
    const tabSrc = fs.readFileSync(path.join(ROOT, 'custom-tab-bar/index.js'), 'utf8');
    let tabDef = null;
    const tabUser = { user: null };
    const tabSandbox = {
      console,
      require(p) {
        if (p.includes('utils/nav-groups')) return navGroups;
      // 管理 dashboard 取数模块（管理员首页用；工作台已移除）：桩返回与真接口同形态的数据，
      // canViewDashboard 与真实实现同口径（dashboard.view / '*'）。
      if (p.includes('utils/dashboard')) {
        return {
          canViewDashboard: (u) => {
            const perms = (u && u.effectivePermissions) || [];
            return perms.includes('*') || perms.includes('dashboard.view');
          },
          fetchOverview: async () => ({
            totalUsers: 1500, activeToday: 800, stepsToday: 9000000, recordsToday: 900,
            pendingAppeals: 2, stepsTodayText: '9000000',
          }),
          fetchTop3: async () => ({ rangeText: '本周', individuals: [], classes: [] }),
        };
      }
        if (p.includes('utils/screen')) return require(path.join(ROOT, 'utils/screen.js'));
        throw new Error('unexpected require ' + p);
      },
      getApp: () => ({ globalData: { userInfo: tabUser.user }, refreshUser: async () => tabUser.user }),
      wx: {
        getWindowInfo: () => ({ windowWidth: 390 }),
        onWindowResize: () => () => {},
        offWindowResize: () => {},
      },
      Component: (def) => { tabDef = def; },
      setTimeout,
      Promise,
    };
    vm.createContext(tabSandbox);
    vm.runInContext(tabSrc, tabSandbox);
    check('custom-tab-bar 可加载（Component 定义捕获）', !!tabDef, '未捕获到定义');

    const buildFor = (user) => {
      tabUser.user = user;
      const inst = {
        data: JSON.parse(JSON.stringify(tabDef.data)),
        setData(patch) { Object.assign(this.data, patch); },
      };
      Object.assign(inst, tabDef.methods);
      return inst.buildList();
    };
    const hubCount = (list) => list.filter((x) => x.key === 'hub').length;
    const texts = (list) => list.map((x) => x.text).join('/');

    const plainStudent = buildFor({ role: 'student' });
    check('普通学生 5 项、无工作台', plainStudent.length === 5 && hubCount(plainStudent) === 0, texts(plainStudent));

    const multiStudent = buildFor({ role: 'student', isClassOfficer: true, isUnionMember: true, effectivePermissions: ['user.view'] });
    check('管理员+班委+学生会：仍只有 1 个工作台（不再互相挤掉）', multiStudent.length === 6 && hubCount(multiStudent) === 1, texts(multiStudent));
    check('工作台插在「记录」之后（第 4 位）', multiStudent[3] && multiStudent[3].key === 'hub', texts(multiStudent));
    check('底栏不再有独立「班级/学生会/管理」tab', !multiStudent.some((x) => ['banchao', 'union', 'admin'].includes(x.key)), texts(multiStudent));

    const officerOnly = buildFor({ role: 'student', isClassOfficer: true });
    check('仅班委：也有工作台（6 项）', officerOnly.length === 6 && hubCount(officerOnly) === 1, texts(officerOnly));

    const teacherAdmin = buildFor({ role: 'teacher', effectivePermissions: ['*'] });
    check('管理教师 3 项：首页/工作台/我的', texts(teacherAdmin) === '首页/工作台/我的', texts(teacherAdmin));

    const homeroom = buildFor({ role: 'teacher', effectivePermissions: [], homeroomClasses: ['23级大数据技术'] });
    check('班主任(无权限) 3 项：首页/工作台/我的', texts(homeroom) === '首页/工作台/我的', texts(homeroom));

    const plainTeacher = buildFor({ role: 'teacher', effectivePermissions: [] });
    check('普通教师 3 项：首页/公告/我的（无工作台）', texts(plainTeacher) === '首页/公告/我的', texts(plainTeacher));

    check('学生底栏封顶 6 项（不再溢出）', multiStudent.length <= 6, String(multiStudent.length));

    // unionEntry：取消学生会 tab 后，检查录入入口必须在工作台里且仅真实成员可见
    const unionGroup = navGroups.NAV_GROUPS.find((g) => g.key === 'union');
    const entryItem = unionGroup && unionGroup.items.find((i) => i.only === 'unionEntry');
    check('NAV_GROUPS 学生会组含「检查录入」(unionEntry → /pages/union/union)', !!entryItem && entryItem.url === '/pages/union/union', JSON.stringify(entryItem));
    const memberCtx = { isSuper: false, perms: [], isAdmin: false, isClassRole: false, isUnionMember: true };
    const stewardCtx = { isSuper: false, perms: ['union.view', 'union.manage'], isAdmin: true, isClassRole: false, isUnionMember: false };
    check('unionEntry 仅真实学生会成员可见', navGroups.entryVisible(entryItem, memberCtx) === true, '成员看不到');
    check('非成员管理员（union.* 权限/总管）看不到 unionEntry（与旧 UNION_TAB 同口径）', navGroups.entryVisible(entryItem, stewardCtx) === false, '非成员被放行');
    check('工作台路径是 tab 页（switchTab 可达）', multiStudent[3].path === '/pages/hub/hub' && multiStudent[3].tab === true, JSON.stringify(multiStudent[3]));
  }

  console.log(`\n角色矩阵校验：失败 ${failed}`);
  process.exit(failed ? 1 : 0);
})();
