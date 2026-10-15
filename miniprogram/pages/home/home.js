const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// ===== 可选插画素材：把图片放到下列路径即可自动启用（未放置时回退到 CSS 插画）=====
//   顶部场景图：miniprogram/assets/home/hero.webp（宽高比约 2.87:1，例如 1500×523；
//   图内已含「唐唐快跑」标题与标语，放图后页面不再叠加文字，高度按图片比例自适应。
//   WebP 体积约为同图 PNG 的 1/8：1500×523 的 hero 用 PNG 要 321KB，WebP(q80) 只要 41KB）
//   4 个入口插画：miniprogram/assets/home/entry-water.png / entry-plan.png / entry-badge.png / entry-body.png（建议 240×240）
//   入口小图保持 PNG：这类扁平小图 PNG 已经比 WebP 更小（WebP 无损/有损反而大 3%~40%），换格式没有收益
const HERO_IMAGE_WEBP = 'assets/home/hero.webp';
// 旧的 PNG 名称只在“设备不支持 WebP 且该文件确实存在”时才会被用到；当前仓库不保留该副本（为省主包体积）
const HERO_IMAGE_PNG = 'assets/home/hero.png';
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

// 版本号比较：a > b 返回 1，a < b 返回 -1，相等返回 0
function compareVersion(a, b) {
  const va = String(a).split('.');
  const vb = String(b).split('.');
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const na = parseInt(va[i] || '0', 10) || 0;
    const nb = parseInt(vb[i] || '0', 10) || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// 当前设备能否解码 WebP：iOS < 14 与 Android < 4 的 image 组件不支持（微信官方文档 image 组件说明）
// 不支持的设备直接走 CSS 插画兜底（.sky 的渐变天空 + 云朵 + 草地 + 跑道），不走 PNG 以减少包体积
function canDecodeWebp() {
  try {
    const info = wx.getSystemInfoSync() || {};
    const platform = String(info.platform || '').toLowerCase();
    const sys = String(info.system || '').replace(/[^0-9.]/g, '');
    if (platform === 'ios') return compareVersion(sys, '14') >= 0;
    if (platform === 'android') return compareVersion(sys, '4') >= 0;
    // devtools / 其它平台（PC 微信等）：按支持处理，探测不到就交给 onHeroError 兜底
    return true;
  } catch (e) {
    return false;
  }
}

// 顶部场景图：优先 WebP，其次旧名 hero.png（若存在），都没有则返回空串（WXML 回退 CSS 插画）
function resolveHero() {
  const candidates = canDecodeWebp() ? [HERO_IMAGE_WEBP, HERO_IMAGE_PNG] : [HERO_IMAGE_PNG];
  for (const p of candidates) {
    if (assetExists(p)) return `/${p}`;
  }
  return '';
}

function resolveAssets() {
  const hero = resolveHero();
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

// 文字够长才滚动，时长随字数递增（约 125rpx/s，比原来快约 1.7 倍）
function marqueeFor(text) {
  const len = (text || '').length;
  if (len <= 14) return { marquee: false, duration: 12 };
  return { marquee: true, duration: Math.min(40, Math.max(8, Math.round(len * 0.2))) };
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
    distance: '0 m',
    calories: 0,
    durationText: '00:00',
    goalAchieved: false,
    goalName: '',
    hasRecord: false,
    loadingOverview: false,
    // 本周
    weekDays: [],
    weekly: null,
    ads: [],
    adHeight: 250, // 广告位高度（rpx），由图片真实比例算得，保证整张图完整显示
    announcements: [],
    // 公告跑马灯
    noticeText: '',
    noticeMarquee: false,
    noticeDuration: 12,
    // 跑分（学生端展示；教师/接口不可用时为空）
    points: null,
    // 「我的班级」卡的刷新触发器（onShow 时更新，组件 observer 收到即重新拉取）
    classRefreshAt: 0,
    pointsToday: '',
    pointsWeek: '',
    pointsTotal: '',
    pointsEnabled: false,
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
    top3: null, // 平均步数前三（本周日均）：个人 / 班级
    greetName: '', // 教师问候称呼（如「王老师」）
  },

  onLoad() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
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
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    this.syncTabBar();
    // 让「我的班级」卡（班主任/班委）跟着首页一起刷新
    this.setData({ classRefreshAt: Date.now() });
    this.refresh();
  },

  // 自定义 tabBar 选中态（教师端导航项与学生不同）
  syncTabBar() {
    if (typeof this.getTabBar !== 'function') return;
    const bar = this.getTabBar();
    if (bar && typeof bar.setActive === 'function') bar.setActive('/pages/home/home');
  },

  // 顶部插画解码失败（极少数不支持 WebP 的机型）：清空素材位，自动回退到 CSS 插画
  onHeroError() {
    if (this.data.heroImage) this.setData({ heroImage: '' });
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    try {
      await getApp().ensureLogin();
      const [today, week, ads, announcements, me, pointsRes] = await Promise.allSettled([
        auth.get('/api/run/today'),
        auth.get('/api/run/week').catch(() => ({ records: [] })),
        auth.get('/api/ads/slot/home_banner').catch(() => []),
        auth.get('/api/content/announcements').catch(() => []),
        getApp().refreshUser().catch(() => null),
        // 跑分（教师账号不参与，接口会返回 0；失败不影响首页）
        auth.get('/api/points/me').catch(() => null),
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
      // 永久限制（bannedUntil 为空）也算封禁态
      if (user.status === 'banned' && (!user.bannedUntil || new Date(user.bannedUntil) > new Date())) {
        banned = true;
      }
      const isManager = !!user.isManager;
      const perms = user.effectivePermissions || [];
      // 按权限过滤的管理入口（WXML 无法调用方法，这里预计算）
      const allEntries = [
        { key: 'users', perm: 'user.view', icon: 'usergroup', label: '用户管理', url: '/packageAdmin/users/users', bg: 'var(--td-success-color-1)', color: 'var(--td-success-color-5)' },
        { key: 'appeals', perm: 'appeal.view', icon: 'assignment-checked', label: '申诉审核', url: '/packageAdmin/appeals/appeals', bg: 'var(--td-warning-color-1)', color: 'var(--td-warning-color-5)' },
        { key: 'ads', perm: 'ad.view', icon: 'play-circle', label: '广告管理', url: '/packageAdmin/ads/contents', bg: 'var(--td-error-color-1)', color: 'var(--td-error-color-6)' },
        { key: 'content', perm: 'content.view', icon: 'layers', label: '内容管理', url: '/packageAdmin/content/index', bg: 'var(--td-gray-color-2)', color: 'var(--td-gray-color-8)' },
        { key: 'assessment', perm: 'assessment.view', icon: 'task-checked', label: '运动考核', url: '/packageAdmin/assessment/index', bg: 'var(--td-warning-color-1)', color: 'var(--td-warning-color-5)' },
        { key: 'files', perm: 'file.view', icon: 'folder-open', label: '文件管理', url: '/packageAdmin/files/files', bg: 'var(--td-success-color-1)', color: 'var(--td-success-color-5)' },
        { key: 'config', perm: 'config.view', icon: 'setting', label: '系统配置', url: '/packageAdmin/config/config', bg: 'var(--td-brand-color-light)', color: 'var(--td-brand-color)' },
      ];
      const mgrEntries = allEntries.filter((e) => perms.includes('*') || perms.includes(e.perm));
      // 末尾固定追加「管理中枢」（分类列出全部管理操作，含权限不足时看不到的项也会在里面解释）
      if (isManager || perms.length) {
        mgrEntries.push({
          key: 'hub',
          perm: '',
          icon: 'dashboard',
          label: '管理中枢',
          url: '/pages/hub/hub',
          bg: 'var(--tt-brand-soft)',
          color: 'var(--tt-brand)',
        });
      }
      const isTeacher = user.role === 'teacher';
      // 教师问候称呼：名字里已含「老师」就不再重复拼接
      const rawName = user.realName || user.nickname || user.account || '';
      const greetName = !rawName ? '老师' : /老师/.test(rawName) ? rawName : `${rawName}老师`;
      this.setData({
        isManager,
        perms,
        mgrEntries,
        canViewAds: perms.includes('*') || perms.includes('ad.view'),
        role: user.role || 'student',
        roleText: isTeacher ? '教师' : '学生',
        isTeacher,
        isAdmin: isManager,
        greetName,
        greetText: greetByHour(),
      });
      // 跑分（学生才展示；接口不可用时隐藏整块）
      const points = pointsRes.status === 'fulfilled' ? pointsRes.value : null;
      this.setData({
        points: points && !isTeacher ? points : null,
        pointsToday: points ? fmt.formatNumber(points.today) : '',
        pointsWeek: points ? fmt.formatNumber(points.week) : '',
        pointsTotal: points ? fmt.formatNumber(points.total) : '',
        pointsEnabled: !!(points && points.config && points.config.enabled),
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
      // 按广告图真实比例算高度（保证整张图完整显示）
      this.measureAdHeight(adList);
      // 管理视角：拉取看板概览（无 dashboard.view 权限时静默忽略）
      if (isManager) {
        this.loadOverview();
        this.loadTop3();
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

  // 广告位高度：按图片真实比例换算 rpx（可用宽 702rpx = 750 - 卡片左右各 24rpx），并限制在 120~420rpx
  async measureAdHeight(list) {
    const items = (list || []).filter((a) => a && a.imageUrl);
    if (!items.length) return;
    const infos = await Promise.all(
      items.map(
        (a) =>
          new Promise((resolve) => {
            wx.getImageInfo({ src: a.imageUrl, success: resolve, fail: () => resolve(null) });
          })
      )
    );
    let max = 0;
    for (const info of infos) {
      if (!info || !info.width || !info.height) continue;
      max = Math.max(max, Math.round((702 * info.height) / info.width));
    }
    // 探测失败（如未配置下载域名）时保持兜底高度，配合 aspectFit 仍能完整显示
    if (!max) return;
    const adHeight = Math.max(120, Math.min(420, max));
    if (adHeight !== this.data.adHeight) this.setData({ adHeight });
  },

  async loadOverview() {
    this.setData({ loadingOverview: true });
    try {
      const overview = await auth.get('/api/admin/dashboard/overview');
      this.setData({
        overview: { ...overview, stepsTodayText: fmt.formatNumber(overview.stepsToday) },
      });
    } catch (e) {
      // 无 dashboard.view 权限，忽略：面板只显示快捷按钮
    } finally {
      this.setData({ loadingOverview: false });
    }
  },

  // 平均步数前三（本周日均）：个人 / 班级
  async loadTop3() {
    try {
      const top3 = await auth.get('/api/admin/dashboard/top3');
      const withText = (rows) =>
        (rows || []).map((r) => ({ ...r, avgStepsText: fmt.formatNumber(r.avgSteps) }));
      this.setData({
        top3: {
          rangeText: top3.rangeText,
          individuals: withText(top3.individuals),
          classes: withText(top3.classes),
        },
      });
    } catch (e) {
      // 无 dashboard.view 权限或接口异常：不显示排行块
      this.setData({ top3: null });
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
      distance: fmt.formatDistance(record?.distance || 0),
      calories: record?.calories || 0,
      durationText: fmt.formatDuration(record?.durationSeconds || 0),
      goalAchieved: !!record?.goalAchieved,
      goalName: goal.planName || '默认目标',
      // 有记录 = 存在当日记录且步数或里程不为 0（同步过但没动的情况视为「今天没有运动记录」）
      hasRecord: !!record && ((record.steps || 0) > 0 || (record.distance || 0) > 0),
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
    // 环形进度条：conic-gradient 画每日完成度（不支持时退化为纯灰环 + 内部图标）
    const RING_TRACK = '#eef0f3';
    const RING_BRAND = '#ff6b00';
    const ringStyle = (pct, future) => {
      if (future) return `background: ${RING_TRACK};`;
      return `background: conic-gradient(${RING_BRAND} 0 ${pct}%, ${RING_TRACK} ${pct}% 100%);`;
    };

    for (let i = 0; i < 7; i++) {
      const key = addDaysToKey(monday, i);
      const isFuture = key > today;
      const steps = stepsMap.get(key) || 0;
      const hasData = !isFuture && steps > 0;
      const pct = !isFuture && goalSteps > 0 ? Math.min(100, Math.round((steps / goalSteps) * 100)) : 0;
      days.push({
        key,
        label: WEEK_LABELS[i],
        stepsText: hasData ? fmt.formatNumber(steps) : '—',
        hasData,
        achieved: hasData && goalSteps > 0 && steps >= goalSteps,
        isToday: key === today,
        percent: pct,
        ringStyle: ringStyle(pct, isFuture),
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
    const md = (key) => `${Number(key.slice(5, 7))}.${Number(key.slice(8, 10))}`;
    const weekRangeText = `${md(monday)} - ${md(addDaysToKey(monday, 6))}`;

    this.setData({
      weekDays: days,
      weekly: {
        weekRangeText,
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

  // 取一次微信运动数据
  getWeRunData() {
    return new Promise((resolve, reject) => {
      wx.getWeRunData({
        success: resolve,
        fail: (e) => reject(new Error(e.errMsg || '获取微信运动数据失败')),
      });
    });
  },

  // 上报一次同步
  async postSyncWerun() {
    const runData = await this.getWeRunData();
    return auth.post('/api/run/sync-werun', {
      encryptedData: runData.encryptedData,
      iv: runData.iv,
    });
  },

  // 同步微信运动
  async syncWerun() {
    if (this.data.syncing) return;
    this.setData({ syncing: true });
    wx.showLoading({ title: '同步中…', mask: true });
    try {
      await getApp().ensureLogin();
      let result;
      try {
        result = await this.postSyncWerun();
      } catch (e) {
        // 会话缺失/过期（400002/400001）：重新登录拿新的 sessionKey 后重试一次
        if (e.code !== 400002 && e.code !== 400001) throw e;
        await auth.login();
        result = await this.postSyncWerun();
      }
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
      if (e.code === 400002 || e.code === 400001) {
        wx.showModal({ title: '同步失败', content: e.message || '登录会话已过期，请重新进入小程序', showCancel: false });
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

  // 目标计划中心（AI 匹配 / 候选计划 / 一键应用）
  goPlan() {
    wx.navigateTo({ url: '/pages/goal-plan/goal-plan' });
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
