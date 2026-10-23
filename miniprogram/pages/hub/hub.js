const auth = require('../../utils/request');

// 管理中枢：把管理端全部入口按「分类」列出来（教师端导航「管理」指向本页，不再直接跳用户管理）
// 每项按权限过滤：perms 为 '*'（超级管理员）或含该项 perm 才显示
//
// 命名口径（用户明确要求，全仓库统一；2026-10-19 用户澄清后以此为准）：
//   · 「我的班级」= 班主任 / 班委管**自己名下的班**的**入口名**，指向 /packageAdmin/class/class；
//     该页**页面标题**叫「班超联赛」（因为它承载班超评比内容，原班超详细页已并入其「班超」tab）；
//     「入口叫我的班级、页面标题叫班超联赛」是用户明确的分工，别再统一成同一个词。
//   · 「班级管理」= 管理员管**全校所有班级**的台账，指向 /packageAdmin/class-manage/class-manage；
//     这两个词以前是混用的（教师页也叫班级管理），现在按用户要求分开，别再混回去。
//   · 「班超」= 班级检查评比域的产品名，「班超排名」保持这个叫法；
//     ⚠️ 原独立页 /pages/banchao/banchao（班超详细页）已删除并并入上述页的「班超」tab；
//   · 「学生会配置」「学生会成员」= 学生会域的两个管理入口名。
//
// 分类的显示条件（与「按权限过滤」是两层，互不替代）：
//   only 字段：'class' = 需要班级身份（班主任 / 班委）；'union' = 班级身份或学生会身份；
//              'unionMember' = 仅学生会成员 / 学生会管理权限（面向学生会域接口的项）。
//   为什么用「身份」而不是权限：班级域（/api/class/*）与学生会域（/api/union/*）走的是成员资格校验，
//   不是 requirePermission（见 AGENTS.md），班主任 / 班委 / 学生会成员本来就没有管理权限。
// 分类与显隐判定统一在 utils/nav-groups.js（管理中枢与首页「快捷操作」共用同一份数据，
// 用户要求两处分类一致 —— 只有单一数据源才能真正不漂移）
const { visibleGroups, navCtx } = require('../../utils/nav-groups');

const CLASS_FOLD_LIMIT = 3; // 「我的班级」chips 折叠时展示的班数（多于 3 个班默认折叠）

// 交互差异（用户明确要求，别改）：
//   管理中枢 = **分类 + 按钮平铺**，点按钮直接进页面；
//   首页「快捷操作」= 宫格按钮只显示分类名，点分类弹浮层列条目（见 pages/home + behaviors/nav-sheet）。
Page({
  data: {
    loading: true,
    groups: [],
    name: '',
    roleText: '',
    classText: '',
    hasAny: false,
    // ===== 我的班级（班主任多班：折叠展示 + 进入前先选班）=====
    classes: [],
    classRole: '', // homeroom | officer
    classExpanded: false,
    classFold: false, // 班级数 > 1 → 需要折叠/选择
    visibleClasses: [],
    classPickVisible: false,
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    // 本页是 tabBar 页（教师端「管理」），要主动点亮底部导航
    this.syncTabBar();
    this.load();
  },

  syncTabBar() {
    if (typeof this.getTabBar !== 'function') return;
    const bar = this.getTabBar();
    if (bar && typeof bar.setActive === 'function') bar.setActive('/pages/hub/hub');
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const me = await getApp().refreshUser();
      const perms = (me && me.effectivePermissions) || [];
      const isSuper = perms.includes('*');
      // 班主任 / 班委：无管理权限也能进班级管理
      let classRole = null;
      let classes = [];
      try {
        const mine = await auth.get('/api/class/mine');
        classRole = mine && mine.role ? mine.role : null;
        classes = ((mine && (mine.classes || mine.homeroomClasses)) || []).filter(Boolean);
      } catch (e) {
        classRole = null; // 接口未就绪/无班级身份：不显示班级分组
        classes = [];
      }

      // 身份上下文：分类与显隐判定统一走 utils/nav-groups.js（与首页「快捷操作」**同一份数据**，
      // 用户要求「管理中枢也一并跟这样重新分类显示」—— 只有单一数据源才能保证两处永不漂移）。
      // navCtx() 统一派生 isSuper/isAdmin/isClassRole/isUnionMember/canUnionScanJoin，
      // 两处不再各写一份（新增身份维度时只改一个地方）。classRole 用 /api/class/mine 的结论覆盖：
      // 它是服务端确认过的「班主任 / 班委」，比本地 homeroomClasses 更准。
      const ctx = navCtx(me, { isClassRole: !!classRole });
      const groups = visibleGroups(ctx).map((g) => {
        // 「班级管理」分类右侧只放**极短**的身份标签，且**只对教师 / 班委身份**显示：
        // 这个分类现在同时含「我的班级」(教师) 与「班级管理」(管理员台账)，
        // 对没有班级身份的纯管理员显示「未分配班级」是误导（他本来就是来看全校台账的）。
        const desc =
          g.key === 'class' && classRole ? (classRole === 'homeroom' ? '班主任' : '班委 · 仅查看') : '';
        // 分类按钮上的条目数（放在分类标题右侧的说明位）
        const countText = `${g.items.length} 项`;
        return {
          key: g.key,
          title: g.title,
          desc,
          countText,
          tint: g.tint,
          // 平铺按钮：每条都要 icon / bg / color（visibleGroups 已摊好分类色）
          items: g.items.map((it) => ({ ...it, bg: it.bg || g.tint.bg, color: it.color || g.tint.color })),
        };
      });

      this.setData({
        loading: false,
        groups,
        hasAny: groups.length > 0,
        name: (me && (me.realName || me.nickname)) || '',
        roleText: me && me.role === 'teacher' ? '教师' : '学生',
        classText: (me && me.className) || '',
        classes,
        classRole: classRole || '',
        classFold: classes.length > 1,
        visibleClasses: classes.length > 1 ? classes.slice(0, CLASS_FOLD_LIMIT) : classes,
        classExpanded: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  // 分类下的按钮：点按钮**直接进页面**（管理中枢是平铺交互，不弹浮层 —— 用户明确要求）。
  // 唯一例外：「我的班级」对多班班主任要先选班，所以走 openClassEntry。
  // 注意：这里必须按**条目 key** 特判，而条目 key 由 utils/nav-groups.js 定义（当前是 'classMy'）。
  // 曾经踩过两次的坑：① 把 key 从 class 改成 classManage 却仍判 'class'；② 拆分「我的班级 / 班级管理」时
  // 把 classManage 这个 key 让给了管理员的班级管理页 —— 两次都会让多班班主任点进去**静默走第一个班、不弹选班抽屉**
  // （很难发现）。改 nav-groups 的条目 key 时务必同步这里；check-nav-groups.js 有对应断言守着。
  go(e) {
    const { url, key } = e.currentTarget.dataset;
    if (key === 'classMy') {
      this.openClassEntry();
      return;
    }
    if (url) wx.navigateTo({ url });
  },

  // 「班级管理」主入口：1 个班直接进；多个班先弹班级选择抽屉（必选其一）
  openClassEntry() {
    const classes = this.data.classes || [];
    if (!classes.length) {
      // 没有班级身份却看得到本项（超级管理员 / 只有学生会权限的管理员）：
      // 仍然进页面，由班超联赛页自己给出「你不是班主任/班委」的空态，避免点了没反应
      wx.navigateTo({ url: '/packageAdmin/class/class' });
      return;
    }
    if (classes.length === 1) {
      this.navClass(classes[0]);
      return;
    }
    this.setData({ classPickVisible: true, classExpanded: true, visibleClasses: classes });
  },

  onClassPickVisible(e) {
    if (!(e.detail && e.detail.visible)) this.setData({ classPickVisible: false });
  },

  closeClassPick() {
    this.setData({ classPickVisible: false });
  },

  // 抽屉里选定班级
  pickClass(e) {
    this.navClass(e.currentTarget.dataset.class);
  },

  // 班级 chips：展开/收起（班级过多时默认折叠）
  toggleClasses() {
    const expanded = !this.data.classExpanded;
    const all = this.data.classes || [];
    this.setData({
      classExpanded: expanded,
      visibleClasses: expanded ? all : all.slice(0, CLASS_FOLD_LIMIT),
    });
  },

  // chips 直接进某个班
  openClass(e) {
    this.navClass(e.currentTarget.dataset.class);
  },

  // 注：原来的「分组折叠 toggleGroup」已随新交互删除 —— 分类按钮不再平铺条目，
  // 条目都在浮层里（浮层自带滚动区），不再需要「展开全部/收起」。
  // 保留这条注释是为了避免后人看到 wxml 里没有折叠条却找不到原因。

  navClass(className) {
    if (!className) return;
    this.setData({ classPickVisible: false });
    // 带 className 时多班班主任不会跳错班；tab 由页面按身份自动选（入口 = 学生名单）
    wx.navigateTo({ url: `/packageAdmin/class/class?className=${encodeURIComponent(className)}` });
  },
});
