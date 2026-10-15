// 本班数据概况卡（首页/任意页可放）：班级概况 + 本班前三名 + 全校班级名次 + 班级管理入口
//
// 用法（父页面）：
//   1) 页面 json 里注册： "class-board": "/components/class-board/class-board"
//   2) wxml 直接放一行： <class-board title="我的班级" bind:ready="onClassBoardReady" />
//   3) 该组件**自己判断身份**：不是班主任/班委时整块不渲染（不会出现空卡片），
//      所以学生端首页可以无条件放一个，不用先查接口。
//   4) 想主动刷新（如首页 onShow）：this.setData({ classRefreshAt: Date.now() })
//      或在页面里 this.selectComponent('#classBoard').reload()
//
// 数据全部来自 /api/class/*（成员资格校验，班主任/班委均可读；班委只读）。
//
// ===== 多班：滑动卡片切换班级（产品需求）=====
//   班主任可被分配多个班级（user.homeroomClasses）。单班时就是原来那张静态卡片（不做无意义的 swiper）；
//   多班时卡片可左右滑动切换，**切到哪一班就显示哪一班的数据**：
//   · 每个班都用 /api/class/overview + /api/class/ranking（带 className）单独拉一份，一次全拉好，
//     滑动是纯 CSS/手势切换、不再发请求（也不会出现「卡片换了但数字还是上一个班」）；
//   · 班级切换用原生 <swiper>（手势跟手 + 回弹吸附），高度 = 首屏量到并冻结的 cardHeight
//     （切换班级不测量、不变高矮），卡片本身不滚动（页面滚动条在 swiper 上照常滑动）；
//   · 头部（班级名 / 身份胶囊 / 全校名次 / 「第 n/N 个班」）在 swiper 之外，是固定不滑的，
//     所以数字指示器不会跟着卡片滑走。
const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// 班级管理页与日/周明细页都在 app.json 的 packageAdmin 分包里登记（跳转写全路径）

// ===== 卡片高度（产品口径：固定高度 + 只量一次就冻结）=====
// 高度不是「按 wxss 估一个常量」（上一版估成 686rpx，明显高于真实内容 → 卡片下方留白），而是：
//   ① 首屏数据 setData 回调 + wx.nextTick 之后，用 createSelectorQuery 量一次**当前可见的 .cb-card**
//      的真实高度，换算成 rpx 后作为**所有班级共用**的 cardHeight；
//   ② 之后切换班级**不再测量、不再变化**（高度恒定：切到哪班都是同一个高度）；
//   ③ 量到之前先用下面的兜底常量（避免「先大后小」跳动），量到后一次性替换。
// 兜底常量 FALLBACK_HEIGHT_RPX：产品口径「卡片 ≈ 200px ≈ 400rpx」。按紧凑版 class-board.wxss
// 逐段核算（rpx，行高按 ≈1.15）：12 (padding-top) + 32 (班名 28×1.15) + 59 (概况 6+4+值 37+标签 8+28)
//   + 40 (达标 4 + 行 24 + 条 6+4) + 73 (前三名 8+8+头 23+排 4+30) + 64 (入口 8+40+16) + 10 (padding-bottom)
//   ≈ 290rpx（内容本身能压到 ~300rpx），取 400rpx：正好是产品要的 200px，卡片里也留了呼吸感。
// 真机若量出来 > 400rpx（长班级名/长姓名换行等），以量到的值为准（不裁内容）。
const FALLBACK_HEIGHT_RPX = 400;

// 第一次量到异常值（0 / 明显超出屏幕）时，延迟这么久再量一次；仍失败就用兜底常量
const MEASURE_RETRY_MS = 120;

Component({
  properties: {
    title: { type: String, value: '我的班级' },
    className: { type: String, value: '' }, // 留空 = 用身份里的班级（多班时的默认选中项）
    showManage: { type: Boolean, value: true },
    // 父页面把它改成新值即重新拉取（首页 onShow 想刷新时最方便）
    refreshAt: {
      type: Number,
      value: 0,
      observer() {
        if (this.data.show) this.reload();
      },
    },
  },

  data: {
    show: false, // 有班级身份才渲染
    loading: true,
    role: '', // homeroom | officer
    canNudge: false,
    // 班级列表与选中项
    classes: [],
    currentIndex: 0,
    indicatorText: '',
    multi: false,
    // 当前可见的班（0 基）：头部镜像、指示器与圆点都跟着它走。
    // **不要用 currentIndex 做这件事** —— 它绑在 <swiper current>（单向）上，
    // 每次手势滑动都把它写回同一序号等于让 swiper 跳回原页，真机上会滑不过去。
    swipeIndex: 0,
    // 当前选中班级（头部固定展示）
    className: '',
    weekStart: '',
    overview: null,
    classRank: null,
    rankText: '',
    // 头部固定展示「当前选中班」的数据镜像（className/overview/classRank/rankText/canNudge）
    // 为什么不让头部直接读 currentIndex + cards[index]：currentIndex 绑到了 <swiper current>（单向），
    // 手势滑动时若在 bindchange 里把它写回同一序号，会让 swiper 收到一次「跳回原页」的指令而中断手势
    //（真机上表现为滑不过去）；所以头部摆动的是这个镜像对象 —— 模板里 swiper 的 current 只由
    //「点圆点」等显式操作推进，手势滑动只更新镜像与指示器。
    currentCard: null,
    // 卡片高度（rpx）：首屏量到真实卡高之前 = 兜底常量，量到后一次性替换并冻结；
    // 多班时它是 <swiper> 的内联高度，单班时由 WXSS 的 --cb-card-h / min-height 生效（同一个值）。
    cardHeight: FALLBACK_HEIGHT_RPX,
    // 是否已经量到并冻结高度（冻结后切换班级/刷新都不再改高度）
    heightLocked: false,
    // 量高度的重试计数（第一次量到异常值 -> 延迟再量一次）
    measureRetry: 0,
  },

  lifetimes: {
    attached() {
      this.load();
    },
  },

  methods: {
    async load() {
      try {
        await getApp().ensureLogin();
        const mine = await auth.get('/api/class/mine');
        if (!mine || !mine.role) {
          this.setData({ show: false, loading: false });
          this.triggerEvent('ready', { role: null });
          return;
        }
        // 可切换的班级列表：
        // · 班主任可多个班 → mine.classes 就是全部（homeroom ∪ 班委本班，去重后的顺序）
        // · 班委只有一个班（服务端只放行本人班级）
        let classes = (mine.classes || []).filter(Boolean);
        if (!classes.length) classes = (mine.homeroomClasses || []).filter(Boolean);
        if (!classes.length && mine.officerClass) classes = [mine.officerClass];
        // 属性 className 显式指定时优先停在该班
        const wanted = this.data.className;
        let currentIndex = wanted ? classes.indexOf(wanted) : -1;
        if (currentIndex < 0) currentIndex = 0;
        const className = classes[currentIndex] || '';
        if (!className) {
          this.setData({ show: false, loading: false });
          this.triggerEvent('ready', { role: null });
          return;
        }
        // 一次把每个班的数据都拉好（多班才有额外请求；单班与改造前完全一致）
        const cards = await Promise.all(classes.map((cn) => this.buildCard(cn)));
        // 「督促」权限按班判定：班主任可被分配多个班，滑动到的那一班才决定按钮文案
        const homeroomClasses = (mine.homeroomClasses || []).filter(Boolean);
        cards.forEach((c) => {
          c.canNudge = homeroomClasses.includes(c.className);
        });
        const payload = this.viewOf(cards, currentIndex);
        this.setData(
          {
            currentCard: payload,
            cards,
            classes,
            currentIndex,
            swipeIndex: currentIndex,
            multi: classes.length > 1,
            show: true,
            loading: false,
            role: mine.role,
          },
          () => {
            this.updateIndicator();
            // 首屏渲染完成后（再等一个 nextTick，保证 swiper-item 内的卡片几何已就绪）量一次并冻结
            const measure = () => this.measureOnce();
            if (typeof wx.nextTick === 'function') wx.nextTick(measure);
            else setTimeout(measure, 0);
          }
        );
        this.triggerEvent('ready', { role: mine.role, className, overview: payload.overview });
      } catch (e) {
        // 无班级身份 / 接口不可用：整块不渲染，不打扰页面（首页无需额外容错）
        this.setData({ show: false, loading: false });
        this.triggerEvent('ready', { role: null, error: e.message || '' });
      }
    },

    // 拉某个班的概况 + 榜单并算好展示字段（概况与榜单都只用 /api/class/*）
    async buildCard(className) {
      const [ov, rank] = await Promise.all([
        auth.get('/api/class/overview', { className }),
        auth.get('/api/class/ranking', { className }),
      ]);
      const classRank = ov.classRank || null;
      const top = ((rank && rank.students) || []).slice(0, 3).map((s) => ({
        ...s,
        stepsText: fmt.formatNumber(s.weekSteps),
      }));
      return {
        className,
        weekStart: ov.weekStart || '',
        canNudge: ov.canNudge !== false, // 由 load() 按 mine.homeroomClasses 覆盖成按班判定
        overview: {
          ...ov,
          stepsTodayText: fmt.formatNumber(ov.stepsToday),
          rateText: `${ov.achievedToday}/${ov.studentCount}`,
        },
        classRank,
        rankText: !classRank ? '' : classRank.rank ? `第 ${classRank.rank} / ${classRank.total} 名` : '本周暂无记录',
        top,
      };
    },

    // 由「一张卡的数据 + 序号」拼出组件头部要展示的字段（滑到哪班就取哪班的数字）
    viewOf(cards, index) {
      const card = cards[index] || cards[0];
      if (!card) return {};
      return {
        className: card.className,
        weekStart: card.weekStart,
        overview: card.overview,
        classRank: card.classRank,
        rankText: card.rankText,
        canNudge: card.canNudge,
      };
    },

    // 头部显示第 index 个班（不改 currentIndex，见 data.swipeIndex 的说明）
    mirrorCard(index) {
      const card = (this.data.cards || [])[index];
      if (!card) return;
      this.setData({ swipeIndex: index, currentCard: this.viewOf(this.data.cards, index) });
      this.updateIndicator(index);
    },

    // 指示器文案：多班才显示（单班不显示任何滑动控件）
    updateIndicator(index) {
      const total = (this.data.classes || []).length;
      const i = typeof index === 'number' ? index : this.data.swipeIndex;
      const indicatorText = total > 1 ? `${i + 1}/${total}` : '';
      if (indicatorText !== this.data.indicatorText) this.setData({ indicatorText });
    },
    // ===== 只量一次就冻结的高度测量 =====
    // 在首屏 setData 回调 + wx.nextTick 之后量**当前可见的 .cb-card** 的真实高度：
    //   · 量到合理值（> 0 且不超过屏幕高度）→ 取整成 rpx 作为所有班级共用的 cardHeight，然后**冻结**；
    //   · 量到异常值（0 / 空数组 / 明显超出屏幕）→ 丢弃本次结果，保留兜底常量，延迟 120ms 再量一次；
    //     重试仍失败就保持兜底常量（不猜、不阻塞渲染）。
    // 注意 `.cb-card` 全屏只有两张：swiper 之外的「单班卡」与 swiper 内每个面板里的卡。
    // 多班时先取**可见**的那张（swiper-item 内的 `.cb-card`，需要 `>>>` 穿透组件），
    // 取不到再退回第一个 `.cb-card`（即单班卡 / 第 1 张）—— 两者高度一致，不影响结论。
    measureOnce() {
      if (this.data.heightLocked) return;
      const self = this;
      this.createSelectorQuery()
        .selectAll('.cb-swiper-item >>> .cb-card')
        .boundingClientRect(function (rects) {
          if (rects && rects.length) {
            self.applyMeasured(rects);
            return;
          }
          self.createSelectorQuery()
            .selectAll('.cb-card')
            .boundingClientRect(function (all) {
              self.applyMeasured(all);
            })
            .exec();
        })
        .exec();
    },

    applyMeasured(rects) {
      const list = (rects || []).filter((r) => r && r.height > 0);
      // px → rpx：rpx 的定义就是 750 / 屏宽（750 是设计稿基准宽，与机型无关）
      const px2rpx = 750 / 375;
      const h = list.length ? Math.round(Math.max(...list.map((r) => r.height)) * px2rpx) : 0;
      // 异常值判断：0 或明显超出屏幕（> 屏高 rpx）都丢弃
      if (!h || (wx.getWindowInfo && h > wx.getWindowInfo().windowHeight * px2rpx)) {
        if (this.data.measureRetry < 1) {
          this.setData({ measureRetry: this.data.measureRetry + 1 });
          setTimeout(() => this.measureOnce(), MEASURE_RETRY_MS);
        }
        return;
      }
      // 量到就冻结：所有班级共用这个高度（= 卡片真实内容高度），之后不再测量、不再变化
      this.setData({ cardHeight: h, heightLocked: true });
    },

    // 滑动切换班级：只更新镜像 / 指示器 / swipeIndex，不回写 currentIndex（见 data.swipeIndex 说明）
    // **不碰高度**：固定高度不随班级变化（产品要求：切换时高度完全不变）
    onSwipeChange(e) {
      const index = Number(e.detail.current) || 0;
      this.setData({ swipeIndex: index, currentCard: this.viewOf(this.data.cards, index) }, () => this.updateIndicator(index));
      this.triggerEvent('classchange', { className: this.data.classes[index] || '', index });
    },

    // 滑动动画结束：高度仍然是固定值，这里只做指示器与镜像的最终同步
    onSwipeSettled(e) {
      const index = Number(e.detail.current) || 0;
      if (index !== this.data.swipeIndex) {
        this.setData({ swipeIndex: index, currentCard: this.viewOf(this.data.cards, index) }, () => this.updateIndicator(index));
      }
    },

    // 点圆点直接跳某个班（显式操作，推进 swiper 的 current）
    goClass(e) {
      const index = Number(e.currentTarget.dataset.index);
      if (!(index >= 0) || index === this.data.swipeIndex) return;
      this.setData(
        {
          currentIndex: index,
          swipeIndex: index,
          currentCard: this.viewOf(this.data.cards, index),
        },
        () => this.updateIndicator(index)
      );
      this.triggerEvent('classchange', { className: this.data.classes[index] || '', index });
    },

    async reload() {
      const classes = this.data.classes || [];
      if (!classes.length) return this.load();
      this.setData({ loading: true });
      try {
        const cards = await Promise.all(classes.map((cn) => this.buildCard(cn)));
        const index = Math.min(this.data.swipeIndex, cards.length - 1);
        this.setData(
          {
            cards,
            currentIndex: index,
            swipeIndex: index,
            currentCard: this.viewOf(cards, index),
            loading: false,
          },
          () => {
            this.updateIndicator();
            // 高度已冻结则不再测量（切换班级/刷新都不改变高度）；只有首屏没量到成功时才补量
            const measure = () => this.measureOnce();
            if (typeof wx.nextTick === 'function') wx.nextTick(measure);
            else setTimeout(measure, 0);
          }
        );
      } catch (e) {
        this.setData({ loading: false });
      }
    },

    // 「班级管理 ›」：先抛事件（父页面想做埋点/拦截都可以），再跳页面
    // 带上**当前选中的班级**（多班滑动切换后点进来就是那一个班）
    goManage() {
      const className = (this.data.currentCard && this.data.currentCard.className) || this.data.className;
      this.triggerEvent('manage', { className, role: this.data.role });
      wx.navigateTo({ url: `/packageAdmin/class/class?className=${encodeURIComponent(className)}` });
    },

    // 点本班前三名 → 该生的本周明细（班级视角，只读）
    openStudent(e) {
      const { id, name } = e.currentTarget.dataset;
      if (!id) return;
      const card = this.data.currentCard || {};
      this.triggerEvent('student', { userId: id, name });
      wx.navigateTo({
        url:
          `/packageAdmin/user-detail/period-detail/period-detail?id=${id}&type=week&date=${card.weekStart || this.data.weekStart}` +
          `&scope=class&name=${encodeURIComponent(name || '')}&className=${encodeURIComponent(card.className || this.data.className)}`,
      });
    },
  },
});
