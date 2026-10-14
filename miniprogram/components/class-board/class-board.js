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
const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// 班级管理页与日/周明细页都在 app.json 的 packageAdmin 分包里登记（跳转写全路径）

Component({
  properties: {
    title: { type: String, value: '我的班级' },
    className: { type: String, value: '' }, // 留空 = 用身份里的班级（班主任取第一个班）
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
    className: '',
    weekStart: '',
    overview: null,
    classRank: null,
    rankText: '',
    top: [],
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
        const className = this.data.className || (mine.classes || [])[0] || mine.officerClass || '';
        if (!className) {
          this.setData({ show: false, loading: false });
          this.triggerEvent('ready', { role: null });
          return;
        }
        // 先取数据再显示：避免加载过程中闪出一张半空的卡片
        const payload = await this.build(className);
        this.setData({
          ...payload,
          show: true,
          loading: false,
          role: mine.role,
          canNudge: mine.role === 'homeroom' && !mine.readonly,
          className,
        });
        this.triggerEvent('ready', { role: mine.role, className, overview: payload.overview });
      } catch (e) {
        // 无班级身份 / 接口不可用：整块不渲染，不打扰页面（首页无需额外容错）
        this.setData({ show: false, loading: false });
        this.triggerEvent('ready', { role: null, error: e.message || '' });
      }
    },

    // 拉概况 + 榜单并算好展示字段（概况与榜单都只用 /api/class/*）
    async build(className) {
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
        weekStart: ov.weekStart || '',
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

    reload() {
      const cn = this.data.className;
      if (!cn) return this.load();
      this.setData({ loading: true });
      return this.build(cn)
        .then((payload) => this.setData({ ...payload, loading: false }))
        .catch(() => this.setData({ loading: false }));
    },

    // 「班级管理 ›」：先抛事件（父页面想做埋点/拦截都可以），再跳页面
    goManage() {
      const className = this.data.className;
      this.triggerEvent('manage', { className, role: this.data.role });
      wx.navigateTo({ url: `/packageAdmin/class/class?className=${encodeURIComponent(className)}` });
    },

    // 点本班前三名 → 该生的本周明细（班级视角，只读）
    openStudent(e) {
      const { id, name } = e.currentTarget.dataset;
      if (!id) return;
      this.triggerEvent('student', { userId: id, name });
      wx.navigateTo({
        url:
          `/packageAdmin/user-detail/period-detail/period-detail?id=${id}&type=week&date=${this.data.weekStart}` +
          `&scope=class&name=${encodeURIComponent(name || '')}&className=${encodeURIComponent(this.data.className)}`,
      });
    },
  },
});
