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
//   · 班级切换用原生 <swiper>（手势跟手 + 回弹吸附），高度 = 固定常量 CARD_HEIGHT_RPX
//     （不动态测量，切换班级高度零变化），卡片本身不滚动（页面滚动条在 swiper 上照常滑动）；
//   · 头部（班级名 / 身份胶囊 / 全校名次 / 「第 n/N 个班」）在 swiper 之外，是固定不滑的，
//     所以数字指示器不会跟着卡片滑走。
const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// 班级管理页与日/周明细页都在 app.json 的 packageAdmin 分包里登记（跳转写全路径）

// ===== 卡片固定高度（产品口径）=====
// 前三名恒为 3 行（每个班都超过 3 人），所以卡片内容高度本来就是常量，不动态测量、不跟随当前卡：
//   20 (padding-top) + 42 (班名 30rpx×1.4) + 34 (名次副行 6 + 20×1.4) + 120 (三项概况)
//   + 97 (达标块) + 57 (前三名标题) + 3×60 (三行) + 88 (管理入口) + 18 (padding-bottom) = 686rpx
// 单班 / 多班共用这一个值：多班时 = <swiper> 高度（内联 style），单班时 = 卡片 min-height，
// 两种模式视觉一致，首帧就是最终高度（不会先 0 再跳），切换班级高度完全不变。
// WXSS 里通过 --cb-card-h 使用同一数值（WXSS 读不到 JS 常量，改这个值要两处同步）。
const CARD_HEIGHT_RPX = 686;

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
    // 卡片固定高度（rpx）：多班时是 <swiper> 的内联高度，单班时由 WXSS 的
    // --cb-card-h / min-height 生效（两处用同一个值）；首帧就是这个值，不会先 0 再跳。
    cardHeight: CARD_HEIGHT_RPX,
    // 安全网：仅当实测内容**超过**固定高度时才补的额外高度（只增不减）。
    // 正常情况恒为 0 → 卡片高 = swiper 高、零白区；极小概率的超高内容（超长班级名换行等）才 >0，
    // 且卡片与 swiper 一起长高（下面模板同一表达式），不会出现「容器比卡片高」的白区。
    cardExtra: 0,
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
            // 首帧渲染完成后才过安全网（正常情况恒定高度、不 setData，首帧就是最终高度）
            this.updateIndicator();
            this.checkOverflow();
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
    // ===== 安全网：仅当内容真的超过固定高度时才把高度调大（只增不减）=====
    // 高度本身**不是**动态测出来的：它就是常量 CARD_HEIGHT_RPX（前三名恒 3 行 → 内容高度是常量）。
    // 这里只兜一种极小概率的情况：班级名过长换行、名字特别长导致某一行撑高等，
    // 使某张卡的自然高度 > 常量。此时把「卡片 + swiper」一起按差值长高（模板里是同一个表达式），
    // 所以永远不会出现「容器比卡片高」的白区；正常情况 cardExtra 恒为 0、高度零变化。
    // 只在数据装载/刷新后跑一次，**切换班级不跑**（切换时高度必须逐像素一致）。
    checkOverflow() {
      if (!this.data.multi || !(this.data.cards || []).length) return;
      const self = this;
      this.createSelectorQuery()
        .selectAll('.cb-card')
        .boundingClientRect(function (rects) {
          const list = (rects || []).filter((r) => r && r.height > 0);
          if (!list.length) return; // 量不到：保持固定高度（不猜、不用兜底值）
          // px → rpx：rpx 的定义就是 750 / 屏宽（750 是设计稿基准宽，与机型无关）
          const px2rpx = 750 / 375;
          const max = list.reduce((m, r) => Math.max(m, r.height), 0);
          const need = Math.round(max * px2rpx) - CARD_HEIGHT_RPX;
          if (need > self.data.cardExtra) self.setData({ cardExtra: need });
        })
        .exec();
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
            // 数据变了才重新过一遍安全网（切换班级时不跑，高度必须恒定）
            this.checkOverflow();
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
