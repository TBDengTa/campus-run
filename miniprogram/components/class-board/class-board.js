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
//   · 班级切换用原生 <swiper>（手势跟手 + 回弹吸附），高度按「最高的一张卡」实测后写死，
//     卡片本身不滚动（页面滚动条在 swiper 上照常滑动）；
//   · 头部（班级名 / 身份胶囊 / 全校名次 / 「第 n/N 个班」）在 swiper 之外，是固定不滑的，
//     所以数字指示器不会跟着卡片滑走。
const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// 班级管理页与日/周明细页都在 app.json 的 packageAdmin 分包里登记（跳转写全路径）

// 多班 swiper 高度量不到时的兜底（rpx）：贴近真实卡片「概况 + 达标 + 前三名 3 行 + 管理入口」的高度，
// 只用于几何未就绪的极端情况。注意**不要**把它写成 .cb-swiper 的 min-height —— 那会顶掉更小的实测值、变回白区。
const CONSERVATIVE_HEIGHT_RPX = 660;

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
    // swiper 高度（rpx）：取「最高的一张卡」的实测值；0 = 还没量到，用 CSS 兜底高度
    swipeHeight: 0,
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
            // 首帧渲染完成后才量高度：此时卡片内容已渲染、swiper-item 有真实几何
            this.updateIndicator();
            this.measureHeight();
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
    // ===== swiper 高度：只取**当前可见那张卡**的实测高度 =====
    // 为什么不是「所有卡里最高的那张」：<swiper> 是固定高度容器，取最高值的话，切到较矮的
    // 那一班时容器不变、卡片下方就留出一大片白色空白（用户报的 bug）。所以：
    //   · 每次切换后按当前卡实测重设高度（切换会平滑跟随，不留白）；
    //   · 内联高度优先，WXSS 里**不能再给 .cb-swiper 写 min-height** —— min-height 会顶掉
    //     更小的实测值，效果与「取最高」一样（容器比卡片高 → 白区）；
    //   · 量不到（首帧 / 无 cards / 视图未就绪）才退回 CONSERVATIVE_HEIGHT_RPX 兜底。
    measureHeight(done) {
      if (!this.data.multi || !(this.data.cards || []).length) {
        if (this.data.swipeHeight) this.setData({ swipeHeight: 0 });
        if (typeof done === 'function') done();
        return;
      }
      const finish = () => {
        if (typeof done === 'function') done();
      };
      const apply = (rects) => {
        const list = (rects || []).filter((r) => r && r.height > 0);
        if (!list.length) {
          // 量不到（含自动化/真机几何未就绪）：用贴近真实卡片的兜底值，不用明显偏大的值
          if (!this.data.swipeHeight) this.setData({ swipeHeight: CONSERVATIVE_HEIGHT_RPX });
          finish();
          return;
        }
        // px → rpx：设备 rpx 定义就是 750 / 屏宽（750 是设计稿基准宽，与机型无关）
        const px2rpx = 750 / 375;
        // 取最高的一条：切换动画中两张卡同时可见时，容器不能低于其中较高者（否则会裁内容）；
        // 稳定态下 .cb-card 只有可见的那一张（单班卡在 swiper 之外），所以这就是「当前卡高」
        const max = list.reduce((m, r) => Math.max(m, r.height), 0);
        // +2rpx 只吸收 px→rpx 的取整差，不留可见白区
        const h = Math.round(max * px2rpx) + 2;
        if (h !== this.data.swipeHeight) this.setData({ swipeHeight: h });
        finish();
      };
      this.createSelectorQuery()
        // 优先只量可见的那一个 swiper-item（组件内选择器写 `>>>` 才能进 swiper-item 内部）
        .selectAll('.cb-swiper-item >>> .cb-card')
        .boundingClientRect((rects) => {
          if (rects && rects.length) {
            apply(rects);
            return;
          }
          // 兜底：`>>>` 在个别基础库版本下取不到跨组件节点时，退回普通选择器
          //（此时会把所有卡都量到 → 等价于「取最高」，最坏只是高度偏大、内容不会被裁）
          this.createSelectorQuery().selectAll('.cb-card').boundingClientRect(apply).exec();
        })
        .exec();
    },

    // 滑动切换班级：只更新镜像 / 指示器 / swipeIndex，不回写 currentIndex（见 data.swipeIndex 说明）
    // 切换后按新卡重设 swiper 高度（setData 回调里量，确保量到的是新卡的几何）
    onSwipeChange(e) {
      const index = Number(e.detail.current) || 0;
      this.setData({ swipeIndex: index, currentCard: this.viewOf(this.data.cards, index) }, () => {
        this.updateIndicator(index);
        this.measureHeight();
      });
      this.triggerEvent('classchange', { className: this.data.classes[index] || '', index });
    },

    // 滑动动画结束：再量一次（动画期间两张卡同时可见，这里量到的是稳定态）
    onSwipeSettled(e) {
      const index = Number(e.detail.current) || 0;
      if (index !== this.data.swipeIndex) {
        this.setData({ swipeIndex: index, currentCard: this.viewOf(this.data.cards, index) }, () => this.updateIndicator(index));
      }
      this.measureHeight();
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
        () => {
          this.updateIndicator(index);
          this.measureHeight();
        }
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
            this.measureHeight();
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
