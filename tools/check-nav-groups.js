// 可重复运行：用打桩运行时实跑 home.js / hub.js 的管理入口构建逻辑，核对分类与角色矩阵
// 运行：node tools/check-nav-groups.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const navGroups = require(path.join(ROOT, 'utils/nav-groups'));
// 记录跳转目标（wx.navigateTo / switchTab），供「点条目 → 进页面」断言使用
const navLog = [];

function loadPage(rel, user, classMine) {
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
              return { totalUsers: 1500, activeToday: 800, stepsToday: 9000000, recordsToday: 900 };
            }
            if (url.includes('/api/admin/dashboard/top3')) return { individuals: [], classes: [] };
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
          parseDateKey: () => ({ m: 3, d: 8, week: '周日' }),
        };
      }
      if (p.includes('utils/nav-groups')) return navGroups;
      // behaviors/*.js 的加载需要 `Behavior` 全局（它只存在于小程序运行时里）：
      // 临时挂到 node global 上真实 require，拿到 Behavior 定义，之后再清理。
      // 这样页面里 behaviors: [x] 拿到的是真定义，测试才能调到 Behavior 的方法
      // （例：nav-sheet 的 onNavCellTap —— 「点分类开浮层」这条交互靠它）。
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
  },
  {
    // **纯学生会成员**（有 union 身份、但没有任何 union.* 管理权限）：
    // 用户要求「学生会学生中不需要显示快捷操作」—— 首页快捷操作里不该出现「学生会」分类，
    // 但**管理中枢必须保留**（学生处/团委持 union.* 权限时的唯一入口）。
    // 这个角色就是用来守住"首页刻意少一组、中枢保持原样"这条区分规则的。
    name: '学生会成员(无管理权限)',
    user: { _id: 'u1', realName: '孙部员', role: 'student', effectivePermissions: [], isManager: false, homeroomClasses: [], isClassOfficer: false, isUnionMember: true, className: '23级大数据技术' },
    mine: { role: null, classes: [] },
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
    // ---- 首页 ----
    const home = loadPage('pages/home/home.js', r.user, r.mine);
    await home.refresh();
    const hg = home.data.mgrGroups;
    check('首页 mgrGroups 是数组', Array.isArray(hg), typeof hg);
    check('首页 showHomeEntries 与分组数一致', home.data.showHomeEntries === hg.length > 0, `${home.data.showHomeEntries} vs ${hg.length}`);
    console.log(`  首页快捷操作：${hg.length} 组 / ${hg.reduce((a, g) => a + g.items.length, 0)} 入口`);
    hg.forEach((g) => console.log(`    ${g.title}：${g.items.map((i) => i.label).join('、')}`));
    // 权限不够的入口必须**彻底不出现**（用户 2026-10-22「没有权限就不应该显示」）
    if (r.hideEntries && r.hideEntries.length) {
      const labels = hg.flatMap((g) => g.items.map((i) => i.label));
      for (const h of r.hideEntries) {
        check(`不显示「${h}」（没有对应权限）`, !labels.includes(h), labels.join('、'));
      }
    }
    // 每个条目必须带 bg/color（模板直接用）
    const missingTint = hg.flatMap((g) => g.items.filter((i) => !i.bg || !i.color)).map((i) => i.label);
    check('每个入口都带图标底色', missingTint.length === 0, missingTint.join(','));

    // ---- 新交互：分类按钮 → 条目浮层 → 点条目进页面 ----
    // 规则（用户明确要求）：分类下**实际可见**条目 >1 → 弹浮层；只剩 1 条 → 直接进该页
    if (hg.length) {
      const g0 = hg[0];
      check('分类按钮不直接带页面 url（点分类只开浮层）', !g0.url, `group ${g0.key} 不该有 url 字段`);
      check('Behavior 的 onNavCellTap 已合并进页面', typeof home.onNavCellTap === 'function', typeof home.onNavCellTap);

      // 找一个「实际可见 >1 条」的分类 → 应弹浮层
      const multi = hg.find((g) => g.items.length > 1);
      if (multi) {
        home.closeNavSheet();
        home.onNavCellTap({ currentTarget: { dataset: { key: multi.key } } });
        const sheet = home.data.navSheet;
        check('多条分类：点分类后浮层被打开', home.data.navSheetVisible === true && !!sheet, JSON.stringify({ v: home.data.navSheetVisible, s: !!sheet }));
        check('多条分类：浮层标题 = 分类名', sheet && sheet.title === multi.title, sheet && sheet.title);
        check(
          '多条分类：浮层条目与该分类的条目一一对应且都有 url',
          sheet && sheet.items.length === multi.items.length && sheet.items.every((it) => !!it.url),
          sheet ? sheet.items.map((it) => `${it.label}:${it.url || '无url'}`).join(',') : 'null'
        );
        // 点条目应触发跳转到该条目的 url
        const first = sheet.items[0];
        navLog.length = 0;
        home.onNavEntryTap({ currentTarget: { dataset: { url: first.url, key: first.key } } });
        check(
          '多条分类：点条目 → 跳转到该条目的 url 且浮层关闭',
          navLog.length === 1 && navLog[0] === first.url && home.data.navSheetVisible === false,
          JSON.stringify({ navLog, visible: home.data.navSheetVisible })
        );
      }

      // 找一个「实际可见 1 条」的分类 → 应**直接跳页**、不弹浮层
      const single = hg.find((g) => g.items.length === 1);
      if (single) {
        home.closeNavSheet();
        navLog.length = 0;
        home.onNavCellTap({ currentTarget: { dataset: { key: single.key } } });
        check(
          `单条分类「${single.title}」：点分类直接进页面且不弹浮层`,
          navLog.length === 1 && navLog[0] === single.items[0].url && home.data.navSheetVisible === false,
          JSON.stringify({ navLog, visible: home.data.navSheetVisible })
        );
      }
    }

    // ---- 管理中枢（**平铺**：分类 + 按钮，点按钮直接进页面）----
    const hub = loadPage('pages/hub/hub.js', r.user, r.mine);
    await hub.load();
    const gg = hub.data.groups;
    check('管理中枢 groups 是数组', Array.isArray(gg), typeof gg);
    const hubTitles = gg.map((g) => g.title).join('|');
    const homeTitles = hg.map((g) => g.title).join('|');
    // 同一数据源，但**首页刻意排除「学生会」分类**（用户要求：纯学生会成员已有独立学生会卡片 +
    // 底部「学生会」tab，不必再在首页列一排管理导航）。所以这里比较的是
    // 「中枢 = 首页 + 被排除的分类」，而不是简单相等 —— 旧断言写的是完全相等，
    // 会把这条产品要求误判成 bug。
    const homeOnlyExcluded = gg.map((g) => g.title).filter((t) => !hg.some((x) => x.title === t));
    check(
      '首页快捷操作 = 中枢分类去掉被排除的组（同一数据源）',
      hubTitles.startsWith(homeTitles) || homeOnlyExcluded.length <= 1,
      `hub=[${hubTitles}] home=[${homeTitles}] 差值=[${homeOnlyExcluded.join('|')}]`
    );
    // 「学生会」分类：首页对**纯成员**隐藏、对持 union.* 权限的管理员保留；中枢**永远保留**
    const hubHasUnion = gg.some((g) => g.key === 'union');
    const homeHasUnion = hg.some((g) => g.key === 'union');
    const hasUnionPerm = (r.user.effectivePermissions || []).some((p) => p.indexOf('union.') === 0);
    check('管理中枢始终保留「学生会」分类（管理员入口不能丢）', !r.user.isUnionMember || hubHasUnion, `isMember=${r.user.isUnionMember} hubHasUnion=${hubHasUnion}`);
    if (r.user.isUnionMember && !hasUnionPerm) {
      check('纯学生会成员：首页快捷操作**不显示**「学生会」分类', !homeHasUnion, `homeHasUnion=${homeHasUnion}`);
    }
    if (hasUnionPerm) {
      check('持 union.* 权限者：首页仍显示「学生会」分类', homeHasUnion, `homeHasUnion=${homeHasUnion}`);
    }
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
    check('关于我们版本号 = 2.0.0', aboutVer === '2.0.0', `about.js: ${aboutVer}`);
    check('README 版本号与关于我们一致', readme.includes(`v${aboutVer}`), `README 未见 v${aboutVer}`);
    check('server/package.json 版本一致', serverPkg.version === aboutVer, `package.json: ${serverPkg.version}`);
    // 紧凑排版：不允许再出现大 hero 或 2×2 图标卡（回退到旧版会撑满首屏）
    check(
      '关于我们为紧凑排版（无 hero、无 2×2 大图标卡）',
      !/tt-hero/.test(aboutWxml) && !/about-feature\b/.test(aboutWxml),
      '仍在用 hero / 大图标卡'
    );
  }

  console.log(`\n角色矩阵校验：失败 ${failed}`);
  process.exit(failed ? 1 : 0);
})();
