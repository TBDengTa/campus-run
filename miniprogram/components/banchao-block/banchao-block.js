// 首页「班超块 / 学生会块」（一个组件，两种模式；**自己判断身份**，无身份时整块不渲染）
//
// 为什么做成组件：首页只需两行标签，不用为两个块各写一遍 loading / 显隐 / 跳转逻辑；
// 且班超块**只给班委 / 班主任**（普通学生不渲染）—— 判断放在组件里，首页不会出现空卡片。
//
// 身份口径（与 custom-tab-bar 一致）：
//   班超：user.homeroomClasses 非空（班主任）或 user.isClassOfficer（班委）
//   学生会：user.isUnionMember（/api/auth/me 由 services/union.js::decorateUser 下发）
//
// 用法：
//   <banchao-block mode="union" refresh-at="{{bcRefreshAt}}" />
//   <banchao-block mode="banchao" refresh-at="{{bcRefreshAt}}" />
//
// ===== 多班：班超块卡片可左右滑动切换班级（产品要求：与「我的班级」卡同一交互）=====
//   与 components/class-board 同一套做法（同一套踩坑结论，改动时请两处一起看）：
//   · 每个班用 /api/union/class/:className 各拉一份，**一次全拉好**；滑动只切显示、不再发请求，
//     不会出现「卡片滑过去了、数字还是上一个班」；
//   · 用原生 <swiper>（手势跟手 + 回弹吸附）；高度 = 首屏量一次面板真实高度后按需替换，
//     测量失败用兜底常量（FALLBACK_HEIGHT_RPX）；
//   · 头部（班级名 / 「今日班超」/ 第 n/N 个班）与圆点指示器在 swiper 之外，是固定不滑的。
const auth = require('../../utils/request');

Page({});

// 多班滑动时卡片主体的高度兜底（rpx）：量到真实高度前先用它，量到后按需替换。
// 按紧凑版 CSS 实测（1rpx = 1 CSS px @375 宽）：头部 31 + 得分行 8+46 + 模块行 10 + 模块格 2 行值 ≈ 318。
const FALLBACK_HEIGHT_RPX = 320;
// 第一次量到异常值（0 / 不合理）时，延迟这么久再量一次；仍失败就保持兜底常量
const MEASURE_RETRY_MS = 120;

Component({
  properties: {
    mode: { type: String, value: 'banchao' }, // banchao | union
    refreshAt: {
      type: Number,
      value: 0,
      observer() {
        if (this.data.show) this.load();
      },
    },
  },

  data: {
    show: false,
    loading: true,
    // ===== 班超模式 =====
    className: '', // 当前可见班的班名（头部镜像）
    classes: [],
    // 绑在 <swiper current> 上，**只由「点圆点」等显式操作推进**（见 swipeIndex 的说明）
    classIndex: 0,
    // 当前可见的班（0 基）：手势滑动只更新它，不写回 classIndex
    // —— 在 bindchange 里把 classIndex 写回同一序号，会让 swiper 收到一次「跳回原页」的指令而
    //    中断手势（真机上表现为滑不过去），class-board 已经踩过这个坑。
    swipeIndex: 0,
    multi: false,
    cards: [],
    scoreText: '—',
    rankText: '',
    modules: [],
    rangeLabel: '今日',
    // 卡片主体高度（rpx）：<swiper> 必须拿到确定高度才会渲染，卡片本身不滚动
    cardHeight: FALLBACK_HEIGHT_RPX,
    measureRetry: 0,
    // ===== 学生会模式 =====
    roleText: '',
    deptName: '',
    entryModules: [],
    enteredTotal: 0,
    expectedTotal: 0,
    pendingReview: 0,
    // 进度条百分比（应录 > 0 时才有意义；模板里 expectedTotal 为 0 时不渲染进度条）
    progressPercent: 0,
    // 是否有复核权限（主席团）：无权限者不显示「待复核」徽标与底部文字链
    canReview: false,
  },

  lifetimes: {
    attached() {
      this.load();
    },
  },

  methods: {
    currentUser() {
      const app = getApp();
      return (app && app.globalData && app.globalData.userInfo) || auth.getUser() || null;
    },

    /**
     * 学生会模式专用：**确保拿到带身份字段的 me**。
     *
     * 用户 2026-10-25 报障「示例学生2 在首页看不到学生会卡片、导航栏也没有学生会」。
     * 根因：`isUnionMember` 是 /api/auth/me 由 services/union.js::decorateUser 现算的，
     * 而 currentUser() 取的是 globalData.userInfo / 本地缓存 —— 它可能是
     *   ① 上一个版本登录时写入的旧对象（那时还没有 decorateUser 补的字段）；
     *   ② 刚登录、身份还没确认过时的占位对象。
     * 这两种情况下 me.isUnionMember 是 undefined → 卡片判为「不是学生会成员」→ 整块不渲染，
     * 而且因为判断不报错，用户完全看不出原因（服务端 /api/auth/me 明明是 true）。
     *
     * 判据用 `typeof === 'boolean'`：字段**存在且是布尔值**才算可信。
     * 缺失时主动 refreshUser()（= /api/auth/me）一次并把结果写回 globalData，
     * 这样卡片、tabBar 都会跟着恢复，不必等用户重进小程序。
     */
    async resolveUnionUser() {
      const me = this.currentUser() || {};
      if (typeof me.isUnionMember === 'boolean') return me;
      try {
        const fresh = await getApp().refreshUser();
        if (fresh) return fresh;
      } catch (e) {
        /* 取不到就用拿到的（可能是 null），下面按非成员处理 */
      }
      return me;
    },

    async load() {
      try {
        await getApp().ensureLogin();
        if (this.data.mode === 'union') {
          const me = await this.resolveUnionUser();
          return await this.loadUnion(me || {});
        }
        const me = this.currentUser() || {};
        return await this.loadBanChao(me);
      } catch (e) {
        this.setData({ show: false, loading: false });
      }
    },

    // ===== 班超块：仅班主任 / 班委 =====
    async loadBanChao(me) {
      const classes = this.classList(me);
      if (!classes.length) {
        // 普通学生：整块不渲染（产品要求：首页班超不给普通学生看）
        this.setData({ show: false, loading: false });
        return;
      }
      // 一次把每个班的数据都拉好（单班就是一次请求，与多班同一份代码路径）
      const cards = await Promise.all(classes.map((cn) => this.buildBanChaoCard(cn)));
      // 刷新后停回**用户当前正在看的那个班**：classIndex 在刷新时必须跟 swipeIndex 一起写，
      // 否则「滑到第 2 个班 → 首页 onShow 触发刷新」时 classIndex 被重置成 0，
      // <swiper current> 会把视图拽回第 1 个班，而头部镜像还停在第 2 个班（数字与卡片对不上）。
      const want = Math.min(this.data.swipeIndex, cards.length - 1);
      const classIndex = want >= 0 ? want : 0;
      this.setData(
        {
          show: true,
          loading: false,
          classes,
          cards,
          classIndex,
          swipeIndex: classIndex,
          multi: classes.length > 1,
          ...this.viewOf(cards, classIndex),
        },
        () => this.measureOnce()
      );
    },

    // 拉某个班的概况并算好展示字段（只用 /api/union/class/:className，与其他页面同一口径）
    async buildBanChaoCard(className) {
      const data = await auth.get(`/api/union/class/${encodeURIComponent(className)}`, { range: 'day' });
      // 多数模块展示指标（出勤率 / 未归人数），少数（卫生）展示得分：统一在服务端算好，这里不再判断
      const modules = (data.modules || []).slice(0, 5).map((m) => ({
        key: m.key,
        name: m.shortName || m.name,
        // 未录文案：早八这类「只记异常人」的模块显示「无迟到」（服务端下发 noRecordText），
        // 不能一律显示「未录」——那会让老师以为纪检部漏录了。
        valueText: m.skipped ? '无' : !m.entered ? m.noRecordText || '未录' : m.metricText || (m.score === null ? '—' : `${m.score}`),
        state: m.skipped ? 'skip' : !m.entered ? 'missing' : m.deduct > 0 ? 'warn' : 'done',
      }));
      const rank = data.ranking || {};
      return {
        className,
        scoreText: data.score === null || data.score === undefined ? '—' : String(data.score),
        rangeLabel: data.rangeLabel || '今日',
        rankText: rank.rank ? `全校第 ${rank.rank} / ${rank.total}` : '',
        modules,
      };
    },

    // 某一班（cards[index]）在头部要展示的字段
    viewOf(cards, index) {
      const card = cards[index] || cards[0];
      if (!card) return {};
      return {
        className: card.className,
        scoreText: card.scoreText,
        rankText: card.rankText,
        rangeLabel: card.rangeLabel,
        modules: card.modules,
      };
    },

    classList(me) {
      const homeroom = (me.homeroomClasses || []).filter(Boolean);
      if (homeroom.length) return homeroom;
      if (me.isClassOfficer && me.className) return [me.className];
      return [];
    },

    // ===== 滑动切换班级：只更新镜像与指示器，不回写 classIndex（见 data.swipeIndex 的说明）=====
    onSwipeChange(e) {
      const index = Number(e.detail.current) || 0;
      this.setData({ swipeIndex: index, ...this.viewOf(this.data.cards, index) });
    },

    // 滑动动画结束：做最终同步（中途被打断时兜底）
    onSwipeSettled(e) {
      const index = Number(e.detail.current) || 0;
      if (index === this.data.swipeIndex) return;
      this.setData({ swipeIndex: index, ...this.viewOf(this.data.cards, index) });
    },

    // 点圆点直接跳某个班（显式操作才推进 swiper 的 current）
    goClass(e) {
      const index = Number(e.currentTarget.dataset.index);
      if (!(index >= 0) || index === this.data.swipeIndex) return;
      const cards = this.data.cards || [];
      if (!cards[index]) return;
      this.setData({ classIndex: index, swipeIndex: index, ...this.viewOf(cards, index) });
    },

    // ===== 卡片主体高度（量一次真实面板高度；量不到就用兜底常量，不猜、不阻塞渲染）=====
    pxToRpx(px) {
      let winWidth = 375;
      try {
        const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {};
        winWidth = info.windowWidth || 375;
      } catch (e) {
        // 取不到窗口信息就按 375 估（rpx 定义就是 750 / 屏宽，375 是最常见的逻辑宽）
      }
      return (Number(px) || 0) * (750 / winWidth);
    },

    measureOnce() {
      if (!this.data.show || !(this.data.cards || []).length) return;
      const self = this;
      const done = (rects) => {
        // 每个班的指标文案长短不同（「出勤率 98.5%」会比「未录」多一行），所以**取最高的一张**，
        // 否则滑到内容更高的那个班时会被裁掉。只量第一个 `.bc-panel` 就会漏掉这种情况。
        const list = (Array.isArray(rects) ? rects : [rects]).filter((r) => r && r.height > 0);
        if (!list.length) return self.retryMeasure();
        const h = Math.round(self.pxToRpx(Math.max(...list.map((r) => r.height))));
        // 异常值（0 / 大得离谱）丢弃；与当前值相差 3rpx 内不动，避免每次刷新都轻微跳动
        if (!h || h > 1200) return self.retryMeasure();
        if (Math.abs(h - self.data.cardHeight) < 3) return;
        self.setData({ cardHeight: h });
      };
      this.createSelectorQuery().selectAll('.bc-panel').boundingClientRect(done).exec();
    },

    retryMeasure() {
      if (this.data.measureRetry >= 1) return;
      this.setData({ measureRetry: this.data.measureRetry + 1 });
      setTimeout(() => this.measureOnce(), MEASURE_RETRY_MS);
    },

    // ===== 学生会块：仅学生会成员 =====
    async loadUnion(me) {
      if (!me.isUnionMember) {
        this.setData({ show: false, loading: false });
        return;
      }
      const data = await auth.get('/api/union/dashboard');
      const first = (data.roles || [])[0] || {};
      const modules = data.modules || [];
      // 只统计「我能录入」的模块，且**全部列出**（旧版 slice(0,3) 会漏掉第 4 个以后的录入入口，
      // 而汇总数又按全量算 → 概览的应录数与列出的模块对不上；首页块是录入入口，不能藏模块）
      const entryAll = modules.filter((m) => m.canEnter);
      // 汇总口径：**排除「没有记录 = 正常」的模块**（早八）—— 用户要求它不计入「应录 / 未录」，
      // 否则概览永远写「0/45」、进度条永远不满（因为没人迟到就不会有记录）。
      const countable = entryAll.filter((m) => !m.optionalWhenMissing);
      const enteredTotal = countable.reduce((a, m) => a + (m.entered || 0), 0);
      const expectedTotal = countable.reduce((a, m) => a + (m.expected || 0), 0);
      this.setData({
        show: true,
        loading: false,
        roleText: [first.levelText, first.deptName, first.roleText].filter(Boolean).join(' · ') || '学生会成员',
        deptName: first.deptName || '',
        // 主操作行：带上「是否已完成」，录完的模块行尾显示「已录完」。
        // 每行进度用 **rawExpected**（早八的真实班级数）：它是录入入口，需要知道有多少个班；
        // 而顶部汇总用 expected（早八已归零），两者刻意不同 —— 前者是「入口规模」，后者是「待办口径」。
        entryModules: entryAll.map((m) => ({
          key: m.key,
          name: m.shortName || m.name,
          text: (m.rawExpected || m.expected) ? `${m.entered}/${m.rawExpected || m.expected}` : `${m.entered} 条`,
          // 「已录完」只对**必须录**的模块成立：早八没有记录＝无迟到，不能显示成「还没录完」
          done: m.optionalWhenMissing ? true : !!m.expected && (m.entered || 0) >= m.expected,
          optionalWhenMissing: !!m.optionalWhenMissing,
        })),
        enteredTotal,
        expectedTotal,
        progressPercent: expectedTotal ? Math.min(100, Math.round((enteredTotal / expectedTotal) * 100)) : 0,
        pendingReview: data.pendingReview || 0,
        // 复核权限由服务端下发（主席团才有）：无权限者不渲染底部「待复核」文字链
        canReview: !!data.canReview,
      });
    },

    // 点卡片进「班超联赛」页（原班超详细页已删除并并入该页的「班超」tab）：
    // **带上当前可见的班**（多班滑动切换后点进来就是那一个班）
    goBanChao() {
      const className = this.data.className || '';
      wx.navigateTo({ url: `/packageAdmin/class/class?tab=attendance&className=${encodeURIComponent(className)}` });
    },

    goUnion() {
      wx.navigateTo({ url: '/pages/union/union' });
    },

    goEntry(e) {
      const key = e.currentTarget.dataset.key || '';
      wx.navigateTo({ url: `/packageUnion/entry/entry?moduleKey=${key}` });
    },

    goRecords() {
      wx.navigateTo({ url: '/packageUnion/records/records?mine=1' });
    },

    goReview() {
      wx.navigateTo({ url: '/packageUnion/records/records?status=submitted' });
    },
  },
});
