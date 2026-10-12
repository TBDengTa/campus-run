const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// ===== 可选插画素材：把 PNG 放到下列路径即可自动启用（未放置时回退到 CSS 插画）=====
//   顶部人物场景图：miniprogram/assets/home/hero.png（建议 750×420 以上，底部留草地）
//   4 个入口插画：miniprogram/assets/home/entry-water.png / entry-plan.png / entry-badge.png / entry-body.png（建议 120×120）
const HERO_IMAGE = 'assets/home/hero.png';
const ENTRY_IMAGES = {
  water: 'assets/home/entry-water.png',
  plan: 'assets/home/entry-plan.png',
  badge: 'assets/home/entry-badge.png',
  body: 'assets/home/entry-body.png',
};

// 判断代码包内文件是否存在（不存在则用 CSS 插画兜底）
function assetExists(p) {
  try {
    wx.getFileSystemManager().accessSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

function resolveAssets() {
  const hero = assetExists(HERO_IMAGE) ? `/${HERO_IMAGE}` : '';
  const entries = {};
  for (const key of Object.keys(ENTRY_IMAGES)) {
    entries[key] = assetExists(ENTRY_IMAGES[key]) ? `/${ENTRY_IMAGES[key]}` : '';
  }
  return { hero, entries };
}

// 按时间给出问候语
function greetByHour(d = new Date()) {
  const h = d.getHours();
  if (h < 6) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

// 公告跑马灯文案：把当前生效的多条公告正文依次拼接（无正文时用标题），一次滚完所有公告
function buildNoticeText(list) {
  const parts = [];
  for (const a of list.slice(0, 5)) {
    const raw = String(a.content || a.title || '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!raw) continue;
    parts.push(raw.length > 60 ? `${raw.slice(0, 60)}…` : raw);
  }
  return parts.join('　·　');
}

// 文字够长才滚动，时长随字数递增（速度约 70rpx/s 的观感）
function marqueeFor(text) {
  const len = (text || '').length;
  if (len <= 14) return { marquee: false, duration: 12 };
  return { marquee: true, duration: Math.min(60, Math.max(10, Math.round(len * 0.35))) };
}

const WEEK_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function addDaysToKey(key, days) {
  const d = new Date(`${key}T00:00:00`);
  d.setDate(d.getDate() + days);
  return fmt.todayKey(d);
}

// 本周一（周一为一周开始）
function mondayKey(key) {
  const d = new Date(`${key}T00:00:00`);
  const diff = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - diff);
  return fmt.todayKey(d);
}

// 米 → 公里文本（整数不带小数）
function toKmText(meters, fixed = 2) {
  const km = (Number(meters) || 0) / 1000;
  if (fixed === 0 || Number.isInteger(km)) return String(km);
  return km.toFixed(fixed);
}

Page({
  data: {
    loading: true,
    dateText: '',
    greetText: '你好',
    // 插画素材（自动探测）
    heroImage: '',
    entryImages: { water: '', plan: '', badge: '', body: '' },
    // 今日数据
    steps: 0,
    stepsText: '0',
    kmText: '0.00',
    goalSteps: 5000,
    goalStepsText: '5,000',
    remainSteps: '5,000',
    percent: 0,
    expectedPercent: 0,
    distance: '0 m',
    calories: 0,
    durationText: '00:00',
    goalAchieved: false,
    goalName: '',
    hasRecord: false,
    // 本周
    weekDays: [],
    weekly: null,
    ads: [],
    announcements: [],
    // 公告跑马灯
    noticeText: '',
    noticeMarquee: false,
    noticeDuration: 12,
    banned: false,
    isAdmin: false,
    syncing: false,
    // ===== 角色权限 =====
    role: 'student',
    roleText: '学生',
    isTeacher: false,
    isManager: false,
    perms: [],
    mgrEntries: [],
    overview: null,
  },

  onLoad() {
    console.log('[compile-marker] home.js v3 已加载', new Date().toISOString());
    const d = fmt.parseDateKey(fmt.todayKey());
    const { hero, entries } = resolveAssets();
    this.setData({
      dateText: `${d.m}月${d.d}日 ${d.week}`,
      greetText: greetByHour(),
      heroImage: hero,
      entryImages: entries,
    });
  },

  onShow() {
    this.syncTabBar();
    this.refresh();
  },

  // 自定义 tabBar 选中态（教师端导航项与学生不同）
  syncTabBar() {
    if (typeof this.getTabBar !== 'function') return;
    const bar = this.getTabBar();
    if (bar && typeof bar.setActive === 'function') bar.setActive('/pages/home/home');
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    try {
      await getApp().ensureLogin();
      const [today, week, ads, announcements, me] = await Promise.allSettled([
        auth.get('/api/run/today'),
        auth.get('/api/run/week').catch(() => ({ records: [] })),
        auth.get('/api/ads/slot/home_banner').catch(() => []),
        auth.get('/api/content/announcements').catch(() => []),
        getApp().refreshUser().catch(() => null),
      ]);
      const user = getApp().globalData.userInfo || {};
      // 游客态（未绑定账号）→ 登录页；首次登录强制改密
      if (!user._id) {
        wx.reLaunch({ url: '/pages/auth-login/auth-login' });
        return;
      }
      if (user.mustChangePassword) {
        wx.reLaunch({ url: '/pages/password/change?first=1' });
        return;
      }
      let banned = false;
      if (user.status === 'banned' && user.bannedUntil && new Date(user.bannedUntil) > new Date()) {
        banned = true;
      }
      const isManager = !!user.isManager;
      const perms = user.effectivePermissions || [];
      // 按权限过滤的管理入口（WXML 无法调用方法，这里预计算）
      const allEntries = [
        { key: 'dashboard', perm: 'dashboard.view', icon: 'dashboard', label: '数据看板', url: '/packageAdmin/dashboard/dashboard', bg: 'var(--td-brand-color-1)', color: 'var(--td-brand-color)' },
        { key: 'users', perm: 'user.view', icon: 'user-add', label: '用户管理', url: '/packageAdmin/users/users', bg: 'var(--td-success-color-1)', color: 'var(--td-success-color-5)' },
        { key: 'appeals', perm: 'appeal.view', icon: 'assignment', label: '申诉审核', url: '/packageAdmin/appeals/appeals', bg: 'var(--td-warning-color-1)', color: 'var(--td-warning-color-5)' },
        { key: 'ads', perm: 'ad.view', icon: 'chart-bar', label: '广告管理', url: '/packageAdmin/ads/contents', bg: 'var(--td-error-color-1)', color: 'var(--td-error-color-6)' },
        { key: 'content', perm: 'content.view', icon: 'book', label: '内容管理', url: '/packageAdmin/content/announcements', bg: 'var(--td-gray-color-2)', color: 'var(--td-gray-color-8)' },
        { key: 'config', perm: 'config.view', icon: 'setting', label: '系统配置', url: '/packageAdmin/config/config', bg: 'var(--td-brand-color-light)', color: 'var(--td-brand-color)' },
      ];
      const mgrEntries = allEntries.filter((e) => perms.includes('*') || perms.includes(e.perm));
      const isTeacher = user.role === 'teacher';
      this.setData({
        isManager,
        perms,
        mgrEntries,
        role: user.role || 'student',
        roleText: isTeacher ? '教师' : '学生',
        isTeacher,
        isAdmin: isManager,
      });
      // 登录信息到手后刷新自定义 tabBar（教师端导航项不同）
      this.syncTabBar();
      const todayData = today.status === 'fulfilled' ? today.value : null;
      this.applyToday(todayData);
      this.applyWeek(week.status === 'fulfilled' ? week.value : null, todayData);
      // 广告曝光 PV 上报
      const adList = today.status === 'fulfilled' && ads.status === 'fulfilled' ? ads.value : [];
      const annList = announcements.status === 'fulfilled' && Array.isArray(announcements.value) ? announcements.value : [];
      const noticeTitle = buildNoticeText(annList);
      const marquee = marqueeFor(noticeTitle);
      this.setData({
        ads: adList,
        announcements: annList,
        banned,
        noticeText: noticeTitle,
        noticeMarquee: marquee.marquee,
        noticeDuration: marquee.duration,
      });
      adList.forEach((ad) => {
        auth.post(`/api/ads/${ad._id}/pv`).catch(() => {});
      });
      // 管理视角：拉取看板概览（无 dashboard.view 权限时静默忽略）
      if (isManager) {
        this.loadOverview();
      }
    } catch (e) {
      if (e.code === 403001) {
        wx.navigateTo({ url: '/pages/banned/banned' });
        return;
      }
      if (e.code === 403003) {
        // 未绑定账号，request 层已统一跳登录页
        return;
      }
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadOverview() {
    try {
      const overview = await auth.get('/api/admin/dashboard/overview');
      this.setData({
        overview: { ...overview, stepsTodayText: fmt.formatNumber(overview.stepsToday) },
      });
    } catch (e) {
      // 无 dashboard.view 权限，忽略
    }
  },

  applyToday(data) {
    if (!data) return;
    getApp().globalData.today = data;
    const record = data.record;
    const steps = record?.steps || 0;
    const goal = data.goal || { daily: { steps: 0 }, weekly: {} };
    const goalSteps = goal.daily?.steps || 0;
    const remain = Math.max(0, goalSteps - steps);
    this.setData({
      steps,
      stepsText: fmt.formatNumber(steps),
      kmText: toKmText(record?.distance || 0),
      goalSteps,
      goalStepsText: fmt.formatNumber(goalSteps),
      remainSteps: fmt.formatNumber(remain),
      percent: Math.min(100, Math.round((steps / (goalSteps || 1)) * 100)),
      expectedPercent: data.expectedPercent,
      distance: fmt.formatDistance(record?.distance || 0),
      calories: record?.calories || 0,
      durationText: fmt.formatDuration(record?.durationSeconds || 0),
      goalAchieved: !!record?.goalAchieved,
      goalName: goal.planName || '默认目标',
      hasRecord: !!record,
    });
  },

  // 本周 7 天步数 + 本周目标进度
  applyWeek(week, todayData) {
    const records = (week && week.records) || [];
    const today = fmt.todayKey();
    const monday = mondayKey(today);

    const stepsMap = new Map();
    const distanceMap = new Map();
    for (const r of records) {
      stepsMap.set(r.date, (stepsMap.get(r.date) || 0) + (r.steps || 0));
      distanceMap.set(r.date, (distanceMap.get(r.date) || 0) + (r.distance || 0));
    }

    const goalSteps = todayData?.goal?.daily?.steps || 0;
    const days = [];
    let weekSteps = 0;
    let weekDistance = 0;

    for (let i = 0; i < 7; i++) {
      const key = addDaysToKey(monday, i);
      const isFuture = key > today;
      const steps = stepsMap.get(key) || 0;
      const hasData = !isFuture && steps > 0;
      days.push({
        key,
        label: WEEK_LABELS[i],
        stepsText: hasData ? fmt.formatNumber(steps) : '—',
        hasData,
        achieved: hasData && goalSteps > 0 && steps >= goalSteps,
        isToday: key === today,
      });
      if (!isFuture) {
        weekSteps += steps;
        weekDistance += distanceMap.get(key) || 0;
      }
    }

    const weekly = todayData?.goal?.weekly || {};
    const targetSteps = weekly.steps || 0;
    const targetDistance = weekly.distance || 0; // 米
    const targetKmText = toKmText(targetDistance, targetDistance % 1000 === 0 ? 0 : 1);

    this.setData({
      weekDays: days,
      weekly: {
        stepsTargetText: fmt.formatNumber(targetSteps),
        distanceTargetText: `${targetKmText} km`,
        weekStepsText: fmt.formatNumber(weekSteps),
        weekDistanceText: `${toKmText(weekDistance)} km`,
        bars: [
          {
            key: 'steps',
            label: '步数',
            percent: targetSteps ? Math.min(100, Math.round((weekSteps / targetSteps) * 100)) : 0,
            valueText: `${fmt.formatNumber(weekSteps)}/${fmt.formatNumber(targetSteps)}`,
          },
          {
            key: 'distance',
            label: '里程',
            percent: targetDistance ? Math.min(100, Math.round((weekDistance / targetDistance) * 100)) : 0,
            valueText: `${toKmText(weekDistance)}/${targetKmText} km`,
          },
        ],
      },
    });
  },

  // 同步微信运动
  async syncWerun() {
    if (this.data.syncing) return;
    this.setData({ syncing: true });
    wx.showLoading({ title: '同步中…', mask: true });
    try {
      const runData = await new Promise((resolve, reject) => {
        wx.getWeRunData({
          success: resolve,
          fail: (e) => reject(new Error(e.errMsg || '获取微信运动数据失败')),
        });
      });
      const result = await auth.post('/api/run/sync-werun', {
        encryptedData: runData.encryptedData,
        iv: runData.iv,
      });
      wx.hideLoading();
      const earned = (result.newBadges || []).length;
      wx.showToast({
        title: `同步成功${earned ? `，获得${earned}枚新徽章` : ''}`,
        icon: 'success',
      });
      await this.refresh();
    } catch (e) {
      wx.hideLoading();
      if (e.code === 403001) {
        wx.navigateTo({ url: '/pages/banned/banned' });
        return;
      }
      if (e.code === 403003) {
        wx.showToast({ title: e.message || '教师账号不参与运动记录', icon: 'none' });
        return;
      }
      // 授权拒绝 → 引导开启
      if (/auth|deny|denied/i.test(e.cause?.errMsg || e.message || '')) {
        wx.showModal({
          title: '需要微信运动授权',
          content: '请在设置中开启「微信运动」授权后重试',
          confirmText: '去设置',
          success: (r) => {
            if (r.confirm) wx.openSetting();
          },
        });
        return;
      }
      wx.showToast({ title: e.message || '同步失败', icon: 'none' });
    } finally {
      this.setData({ syncing: false });
    }
  },

  goRun() {
    wx.switchTab({ url: '/pages/run/index' });
  },

  goWater() {
    wx.navigateTo({ url: '/pages/water/water' });
  },

  goBadges() {
    wx.navigateTo({ url: '/pages/badges/badges' });
  },

  // 目标计划 / 身体数据同页，用锚点区分
  goPlan() {
    wx.navigateTo({ url: '/pages/body-data/body-data?focus=plan' });
  },

  goBodyData() {
    wx.navigateTo({ url: '/pages/body-data/body-data?focus=body' });
  },

  goAnnouncements() {
    wx.navigateTo({ url: '/pages/announcements/announcements' });
  },

  goBanned() {
    wx.navigateTo({ url: '/pages/banned/banned' });
  },

  goAdmin() {
    wx.navigateTo({ url: '/packageAdmin/dashboard/dashboard' });
  },

  // 管理面板入口跳转（url 由权限过滤后的列表带出）
  goAdminPage(e) {
    if (e.currentTarget.dataset.url) {
      wx.navigateTo({ url: e.currentTarget.dataset.url });
    }
  },

  // 广告点击
  async onAdTap(e) {
    const ad = this.data.ads[e.currentTarget.dataset.index];
    if (!ad) return;
    try {
      const res = await auth.post(`/api/ads/${ad._id}/click`);
      if (res.linkType === 'web' && res.linkUrl) {
        wx.navigateTo({ url: `/pages/webview/webview?url=${encodeURIComponent(res.linkUrl)}` });
      } else if (res.linkType === 'page' && res.pageSlug) {
        const { env } = require('../../utils/request');
        wx.navigateTo({
          url: `/pages/webview/webview?url=${encodeURIComponent(`${env.AD_PAGE_BASE_URL || env.BASE_URL}/p/${res.pageSlug}`)}`,
        });
      }
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' });
    }
  },
});
