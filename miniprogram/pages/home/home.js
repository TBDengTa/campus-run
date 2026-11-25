const auth = require('../../utils/request');
const fmt = require('../../utils/format');
const shareRef = require('../../utils/beidou-share');
const dashboard = require('../../utils/dashboard');

// 进首页自动同步微信运动的最小间隔（毫秒）：
// 自动同步是「进页面就做」的动作，来回切 tab 很容易把接口打爆，
// 所以 5 分钟内不重复自动同步（手动点「同步微信运动」不受限）。
const AUTO_SYNC_MIN_GAP = 5 * 60 * 1000;

// 首页完整刷新的最小间隔（毫秒）（2026-11-09 用户确认「30 秒节流」）：
// onShow 在**每次**进首页都触发 —— 冷启动、切 tab 来回、从别的页面返回，
// 一次全量刷新 = 6 个 GET + 1 个 POST(badges/check) + 班级卡/班超块跟着各拉一遍。
// 学生一天切几十次 tab，这就是接入层（EO/CDN）请求量的最大单一来源。
// 30 秒内重复进入只同步 tabBar 选中态，数据沿用刚刷过的 —— 用户无感，请求量大降。
// 节流只挂在 onShow 入口：下拉刷新（显式意图）与步数同步成功后的 refresh() 不受限；
// 时间戳在 refresh() 的成功路径末尾才记 —— 失败不占坑，网络抖动后切回来立刻能重试。
const HOME_REFRESH_MIN_GAP = 30 * 1000;

// ===== 可选插画素材：把图片放到下列路径即可自动启用（未放置时回退到矢量图标）=====
//   4 个小组件插画：miniprogram/assets/home/entry-water.png / entry-plan.png / entry-badge.png / entry-body.png（建议 240×240）
//   入口小图保持 PNG：这类扁平小图 PNG 已经比 WebP 更小（WebP 无损/有损反而大 3%~40%），换格式没有收益
const ENTRY_IMAGES = {
  water: 'assets/home/entry-water.png',
  plan: 'assets/home/entry-plan.png',
  badge: 'assets/home/entry-badge.png',
  body: 'assets/home/entry-body.png',
};

// 判断代码包内文件是否存在（不存在则用矢量图标兜底）
function assetExists(p) {
  try {
    wx.getFileSystemManager().accessSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

function resolveAssets() {
  const entries = {};
  for (const key of Object.keys(ENTRY_IMAGES)) {
    entries[key] = assetExists(ENTRY_IMAGES[key]) ? `/${ENTRY_IMAGES[key]}` : '';
  }
  return { entries };
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

/**
 * 封禁公告条的文案（用户 2026-11-02「如果用户被封禁应该在首页中的公告栏中显示，
 * 并闪烁红色警告状态，点击可以进入详细并申诉等」）
 *
 * 三条约束（都踩过坑，改之前先读）：
 *   ① **整句在 JS 里拼**，WXML 不写三元拼接 —— 字段为空时会留下「到期：；」这种断句
 *      （与 docs/ui-design.md 里班级状态那条是同一个规矩）。
 *   ② 封禁类型 / 来源文案**全部来自服务端**（`/api/appeals/restrictions` 的 text / sourceText）：
 *      前端自己映射「人封 / AI封 / 机封」必然与服务端漂移（见 AGENTS.md 封禁来源分类）。
 *      拿不到服务端数据时（接口失败）**不猜分类**，只给通用文案。
 *   ③ 已提交待审核的申诉要显式说明：「已提交申诉，等待处理」，否则用户会反复点进申诉页
 *      再被「已有待审核的申诉」拒一次（真实体验问题）。
 *
 * @param {Object} user  /api/auth/me 的用户
 * @param {Array}  restrictions 生效中的限制（/api/appeals/restrictions）
 * @param {boolean} appealPending 是否已有待处理申诉
 */
function buildBanNotice(user, restrictions, appealPending) {
  const u = user || {};
  const login = (restrictions || []).find((r) => r.scope === 'login');
  const until = u.bannedUntil || (login && login.until) || null;
  const reason = String((login && login.reason) || u.banReason || '').trim();
  // 来源分类：服务端 sourceText 优先（唯一文案源），没有就不显示这一截
  const sourceText = String((login && login.sourceText) || '').trim();
  const head = ['账号已被限制登录', sourceText ? `（${sourceText}）` : ''].join('');
  const untilText = until ? `${fmt.formatDateTime(until)} 解除` : '无固定期限（永久）';
  const parts = [untilText];
  if (reason) parts.push(reason.length > 30 ? `${reason.slice(0, 30)}…` : reason);
  if (appealPending) parts.push('申诉已提交，等待处理');
  return {
    banTitle: head,
    banSub: parts.join(' · '),
    banActionText: appealPending ? '查看进度' : '去申诉',
  };
}

// 三端响应式（compact/regular/wide，根节点挂 screen-* 类，见 behaviors/screen.js）
const screenBehavior = require('../../behaviors/screen');

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
  behaviors: [screenBehavior],

  data: {
    loading: true,
    dateText: '',
    greetText: '你好',
    // iOS 大标题问候头：整句 JS 拼好（问候语 + 姓名），WXML 零运算
    greetTitle: '你好',
    // 小组件插画素材（自动探测）
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
    pointsToday: '',
    pointsWeek: '',
    pointsTotal: '',
    pointsEnabled: false,
    banned: false,
    // 封禁公告条（用户 2026-11-02）：文案与按钮文案全部在 JS 预计算，见 buildBanNotice
    banTitle: '',
    banSub: '',
    banActionText: '去申诉',
    syncing: false,
    // ===== 角色权限 =====
    role: 'student',
    roleText: '学生',
    isTeacher: false,
    isManager: false,
    // 「身份与待办」单卡（首页唯一的身份面）：行模型全 JS 预计算，见 loadTodoRows。
    // 操作入口一律收进工作台，这里只给计数行 + 行内直跳（多班班主任行 → 工作台选班）。
    todoRows: [],
    showTodoCard: false,
    // 管理 dashboard（数据概况 + 平均步数排行）：管理员首页也要看（用户 2026-11-23 复核），
    // 与工作台同一份取数实现 utils/dashboard.js；守卫 dashboard.view。
    canDashboard: false,
    overview: null,
    top3: null,
    loadingOverview: false,
    // 获得徽章弹窗（自定义组件，替代 wx.showModal —— 纯文字看不到徽章长什么样）
    badgeAward: { visible: false, badges: [] },
  },

  onLoad() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    const d = fmt.parseDateKey(fmt.todayKey());
    const { entries } = resolveAssets();
    const greet = greetByHour();
    this.setData({
      dateText: `${d.m}月${d.d}日 ${d.week}`,
      greetText: greet,
      greetTitle: greet,
      entryImages: entries,
    });
  },

  onShow() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    this.syncTabBar();
    // 分享卡归因：必须在 30 秒节流 return 之前触发（否则刚登录进首页恰好命中节流时不会上报）
    this.flushShareRef();
    // 30 秒节流（HOME_REFRESH_MIN_GAP 处有完整说明）：刚全量刷过就不重复拉，
    // tabBar 选中态已在上面同步，登录态变化由 refreshUser 的 401 自愈兜底。
    const now = Date.now();
    if (this._lastFullRefreshAt && now - this._lastFullRefreshAt < HOME_REFRESH_MIN_GAP) return;
    this.refresh();
    // 进页面自动同步微信运动（用户 2026-10-26「微信运动学生账户要进入页面自动同步」）。
    // 放在 refresh() 之后、且不 await：同步依赖 openid 会话，失败绝不能影响首页渲染。
    this.autoSyncWerun();
  },

  // 分享卡归因的客户端唯一入口：未登录/无 pending 时内部直接返回，不阻塞首页。
  flushShareRef() {
    shareRef
      .flush()
      .then((res) => {
        if (res && res.rewarded) {
          wx.showToast({ title: '已为好友助力', icon: 'none' });
        }
      })
      .catch(() => {});
  },

  /**
   * 进页面自动同步微信运动步数（静默，不弹 loading / 不弹成功提示）。
   *
   * 为什么必须静默：这是**每次进首页都会跑**的动作，如果像手动同步那样弹
   * 「同步成功」toast，用户每切一次 tab 就被打扰一次。
   *
   * 三重护栏（都不可省）：
   *   ① 同一次页面存活期内**只自动试一次**（_autoSynced）：切 tab 回来不重复请求；
   *   ② 距上次同步不足 AUTO_SYNC_MIN_GAP 就跳过：避免来回切页面把接口打爆；
   *   ③ 教师账号不参与运动数据（AGENTS.md 铁律），直接不请求。
   * 失败一律静默：微信运动没授权、会话过期、网络抖动都很常见，
   * 用户想确认结果可以点「同步微信运动」手动同步（那里有明确提示）。
   */
  async autoSyncWerun() {
    try {
      if (this._autoSynced) return;
      const user = getApp().globalData.userInfo || {};
      if (!user._id || user.role === 'teacher') return; // 教师不参与运动数据
      // 频率护栏：两次自动同步至少间隔 5 分钟（手动同步不受此限制）
      const now = Date.now();
      if (this._lastAutoSyncAt && now - this._lastAutoSyncAt < AUTO_SYNC_MIN_GAP) return;
      this._autoSynced = true;
      this._lastAutoSyncAt = now;

      await getApp().ensureLogin();
      let result;
      try {
        result = await this.postSyncWerun();
      } catch (e) {
        // 会话缺失/过期：重登拿新 sessionKey 后重试一次（与手动同步同一套自愈）
        if (e.code !== 400002 && e.code !== 400001) throw e;
        await auth.login();
        result = await this.postSyncWerun();
      }
      // 同步到新数据 → 刷新首页（步数卡 / 今日目标会变）
      if (result && !result.skipped) await this.refresh();
    } catch (e) {
      // 静默：未授权微信运动 / 网络失败都不该在进页面时报错
    }
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
      // 封禁公告条的细节（到期时间 / 原因 / 人封机封 AI封 的分类 / 申诉进度）：
      // 只有封禁态才拉这两个接口 —— 未封禁用户根本用不到，白拉两次会拖慢首页首屏。
      // 两个接口都在服务端「被封禁仍可访问」白名单里（middlewares/auth.js::BANNED_ALLOW），
      // 但**各自 .catch(() => null)**：封禁页的数据绝不能拖垮整个首页渲染。
      let banNotice = buildBanNotice(user, [], false);
      if (banned) {
        const [resRes, appealRes] = await Promise.allSettled([
          auth.get('/api/appeals/restrictions'),
          auth.get('/api/appeals/mine', { limit: 20 }),
        ]);
        const restrictions = resRes.status === 'fulfilled' && resRes.value ? resRes.value.restrictions || [] : [];
        const appeals = appealRes.status === 'fulfilled' && appealRes.value ? appealRes.value.list || [] : [];
        const appealPending = appeals.some((a) => a && a.status === 'pending');
        banNotice = buildBanNotice(user, restrictions, appealPending);
      }
      const isManager = !!user.isManager;
      const isTeacher = user.role === 'teacher';
      const canDashboard = dashboard.canViewDashboard(user);
      // iOS 大标题问候头：整句在这里拼好（WXML 不拼三元，字段为空不会留下断句）
      const rawName = user.realName || user.nickname || user.account || '';
      const greet = greetByHour();
      this.setData({
        isManager,
        canDashboard,
        role: user.role || 'student',
        roleText: isTeacher ? '教师' : '学生',
        isTeacher,
        greetText: greet,
        greetTitle: rawName ? `${greet}，${rawName}` : greet,
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
        banTitle: banNotice.banTitle,
        banSub: banNotice.banSub,
        banActionText: banNotice.banActionText,
        noticeText: noticeTitle,
        noticeMarquee: marquee.marquee,
        noticeDuration: marquee.duration,
      });
      adList.forEach((ad) => {
        auth.post(`/api/ads/${ad._id}/pv`).catch(() => {});
      });
      // 按广告图真实比例算高度（保证整张图完整显示）
      this.measureAdHeight(adList);
      // 身份与待办单卡：按身份并发拉计数（不 await，任何一路失败只少一行）
      this.loadTodoRows(user);
      // 管理员首页的数据概况 / 排行（不 await，失败只少一张卡）
      if (canDashboard) {
        this.loadOverview();
        this.loadTop3();
      }
      // 徽章按需检测（学生端；教师端不展示徽章，直接跳过）
      if (!isTeacher) this.checkBadges();
      // 全量刷新完成时间戳：onShow 的 30 秒节流看的就是它（见 HOME_REFRESH_MIN_GAP）。
      // 记在成功路径末尾而不是开头 —— 失败（catch 了 toast / reLaunch）不占坑，
      // 下拉刷新与步数同步触发的 refresh() 也会走到这里，同样刷新节流基准，符合直觉。
      this._lastFullRefreshAt = Date.now();
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

  // ===== 徽章按需检测（客户端触发，驱动首页弹窗）=====
  // 为什么不做服务端全量补发：1500+ 用户逐人聚合会把数据库打爆；改为用户登录后由客户端提交
  // 一次「检测我是否达成」，服务端只评估当前登录用户并幂等补发。
  // 幂等 + 会话内去重双保险：接口第二次返回空 newBadges；本会话弹过一次就不再弹。
  async checkBadges() {
    const app = getApp();
    // 同一会话内的并发去重：refresh() 的多个调用方（onShow / 下拉刷新）可能同时触发
    const inflight = app.globalData.badgeCheck;
    if (inflight) return inflight;
    const task = this.runBadgeCheck();
    app.globalData.badgeCheck = task;
    try {
      await task;
    } finally {
      app.globalData.badgeCheck = null;
    }
  },

  async runBadgeCheck() {
    try {
      const res = await auth.post('/api/badges/check');
      const newBadges = (res && res.newBadges) || [];
      if (!newBadges.length) return;
      // 会话内只弹一次（接口幂等已保证第二次为空，这层是防重复调用的兜底）
      const app = getApp();
      if (app.globalData.badgePopupShown) return;
      app.globalData.badgePopupShown = true;
      this.showBadgeAward(newBadges);
    } catch (e) {
      // 失败静默：不阻塞首页其它数据（教师账号也会走到这里，接口直接返回空）
    }
  },

  // 新徽章弹窗：自定义底部弹窗（能看见徽章图片），多枚时纵向列表
  showBadgeAward(newBadges) {
    this.setData({ badgeAward: { visible: true, badges: newBadges || [] } });
  },

  closeBadgeAward() {
    this.setData({ badgeAward: { visible: false, badges: [] } });
  },

  goBadgesFromAward() {
    this.closeBadgeAward();
    wx.navigateTo({ url: '/pages/badges/badges' });
  },

  // 管理 dashboard：取数与格式化唯一实现在 utils/dashboard.js（工作台同一份）
  async loadOverview() {
    this.setData({ loadingOverview: true });
    const overview = await dashboard.fetchOverview();
    this.setData({ overview, loadingOverview: false });
  },

  async loadTop3() {
    this.setData({ top3: await dashboard.fetchTop3() });
  },

  // 身份自愈（原 banchao-block.resolveUnionUser，组件删除后搬到这里）：
  // 旧版本登录缓存 / 刚登录的占位对象可能缺 isUnionMember（undefined），
  // 直接判会把成员误判成非成员且**不报错**。typeof 非 boolean 时主动 refreshUser 一次。
  async resolveUnionUser() {
    const me = getApp().globalData.userInfo || {};
    if (typeof me.isUnionMember === 'boolean') return me;
    try {
      const fresh = await getApp().refreshUser();
      if (fresh) return fresh;
    } catch (e) {
      /* 取不到就按非成员处理 */
    }
    return me;
  },

  // 「身份与待办」单卡：首页唯一的身份面（用户 2026-11-23 首页重设计）。
  // 操作入口全部在工作台，这里只给计数行 + 行内直跳；三路并发各自 catch，失败只少一行。
  // 管理待办行按 **dashboard.view** 精确判定（isManager 只表示有任意权限，调 dashboard 接口会 403）。
  async loadTodoRows(user) {
    const me = await this.resolveUnionUser();
    const perms = me.effectivePermissions || [];
    const canDashboard = perms.includes('*') || perms.includes('dashboard.view');
    const [unionRes, mineRes, overviewRes] = await Promise.all([
      me.isUnionMember ? auth.get('/api/union/dashboard').catch(() => null) : Promise.resolve(null),
      auth.get('/api/class/mine').catch(() => null),
      canDashboard ? auth.get('/api/admin/dashboard/overview').catch(() => null) : Promise.resolve(null),
    ]);
    const rows = [];
    if (unionRes) {
      let entered = 0;
      let expected = 0;
      for (const m of unionRes.modules || []) {
        // 早八这类「无记录=无迟到」的模块不计待办（与学生会页同口径）
        if (m.optionalWhenMissing) continue;
        entered += m.entered || 0;
        expected += m.expected || 0;
      }
      rows.push({
        key: 'union',
        icon: 'app',
        title: '学生会',
        sub: me.unionText || '检查录入与复核',
        valueText: expected ? `今日 ${entered}/${expected}` : '今日无待录',
        url: '/pages/union/union',
        tab: false,
      });
      if (unionRes.canReview && (unionRes.pendingReview || 0) > 0) {
        rows.push({
          key: 'review',
          icon: 'assignment-checked',
          title: '待复核',
          sub: '学生会检查记录',
          valueText: `${unionRes.pendingReview} 条`,
          url: '/packageUnion/review/review',
          tab: false,
        });
      }
    }
    const classes = (mineRes && mineRes.classes) || [];
    if (mineRes && mineRes.role && classes.length) {
      // 班主任 / 班委要看两类数据：班超（检查评比）与校园跑（达标），各一行。
      // 班超走 /api/union/class/:className（与班级页同口径），校园跑走 /api/class/overview。
      const [overs, bcs] = await Promise.all([
        Promise.all(classes.map((c) => auth.get('/api/class/overview', { className: c }).catch(() => null))),
        Promise.all(
          classes.map((c) => auth.get(`/api/union/class/${encodeURIComponent(c)}`, { range: 'day' }).catch(() => null))
        ),
      ]);
      let students = 0;
      let achieved = 0;
      let weekRateSum = 0;
      let weekRateN = 0;
      for (const o of overs) {
        if (!o) continue;
        students += o.studentCount || 0;
        achieved += o.achievedToday || 0;
        if (typeof o.weeklyRate === 'number') {
          weekRateSum += o.weeklyRate;
          weekRateN += 1;
        }
      }
      const scores = bcs.filter((b) => b && typeof b.score === 'number').map((b) => b.score);
      const single = classes.length === 1;
      const roleText = mineRes.role === 'homeroom' ? '班主任' : '班委';
      const classUrl = (tab) =>
        single
          ? `/packageAdmin/class/class?tab=${tab}&className=${encodeURIComponent(classes[0])}`
          : '/pages/hub/hub';
      const rank = single && bcs[0] && bcs[0].ranking ? bcs[0].ranking : null;
      const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
      const min = scores.length ? Math.min(...scores) : null;
      // 班超行：单班给分数 + 全校名次；多班给均分 + 最低分（标明口径，不假装是单班分数）
      rows.push({
        key: 'banchao',
        icon: 'chart-bar',
        title: single ? classes[0] : `${classes.length} 个班 · ${roleText}`,
        sub: single
          ? rank && rank.rank
            ? `全校第 ${rank.rank} / ${rank.total}`
            : '今日班超'
          : scores.length
            ? `最低 ${fmt.scoreText(min)}`
            : '今日暂无检查',
        valueText: scores.length ? (single ? fmt.scoreText(scores[0]) : `均 ${fmt.scoreText(avg)}`) : '—',
        url: classUrl('attendance'),
        tab: !single,
      });
      // 校园跑行：今日达标人数（多班求和，率按和值算）+ 周达标率
      rows.push({
        key: 'run',
        icon: 'play-circle',
        title: single ? classes[0] : `${classes.length} 个班 · ${roleText}`,
        sub: weekRateN
          ? single
            ? `周达标率 ${Math.round(weekRateSum)}%`
            : `周达标率均 ${Math.round(weekRateSum / weekRateN)}%`
          : '暂无跑步数据',
        valueText: students ? `达标 ${achieved}/${students}` : '暂无学生',
        url: classUrl('run'),
        tab: !single,
      });
    }
    if (overviewRes) {
      const n = overviewRes.pendingAppeals || 0;
      rows.push({
        key: 'appeal',
        icon: 'error-circle',
        title: '申诉审核',
        sub: '管理待办',
        valueText: n ? `${n} 条待处理` : '暂无待处理',
        url: '/packageAdmin/appeals/appeals',
        tab: false,
      });
    }
    this.setData({ todoRows: rows, showTodoCard: rows.length > 0 });
  },

  goTodoRow(e) {
    const row = this.data.todoRows.find((r) => r.key === e.currentTarget.dataset.key);
    if (!row) return;
    if (row.tab) wx.switchTab({ url: row.url });
    else wx.navigateTo({ url: row.url });
  },

  goWorkbench() {
    wx.switchTab({ url: '/pages/hub/hub' });
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
