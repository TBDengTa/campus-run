const auth = require('../../utils/request');
const fmt = require('../../utils/format');
const sfx = require('../../utils/sfx');

/**
 * ===== 北斗运动 2.0：紧凑版抽奖页（签到 + 转盘 + 播报 + 动效 + 音效）=====
 *
 * 玩法口径见 docs/beidou-lottery-plan.md，UI 方案见 docs/beidou-lottery-ui-plan.md。
 *
 * 三条不能破的约定：
 *   ① 抽奖结果**只由服务端定**：服务端下发 index，前端只负责把第 index 个扇区转到指针下；
 *      扇区顺序也来自服务端（sectors），前端**绝不自己排**；
 *   ② 稀有度也由服务端算（rarest/rare/normal），前端只按它选动效档位 ——
 *      前端自己算会出现「页面说稀有、播报说普通」；
 *   ③ 音效与震动**永远不影响入账**：sfx.play / vibrate 内部全 try/catch，
 *      且音效初始化必须在用户点击的同一个 tick 里（iOS 限制，见 utils/sfx.js 头注释）。
 */

// 默认激励视频广告位 ID（服务端 beidou.video.adUnitId 留空时用这个）
const DEFAULT_AD_UNIT_ID = 'adunit-a80731a737d255c9';

// ===== 教师拦截（三道，沿用一版）=====
const TEACHER_BLOCK_TITLE = '教师账号不参与运动记录';
const TEACHER_BLOCK_SUB = '北斗运动仅对学生开放，教师账号不能领取步数奖励。';
const TEACHER_TOAST = '教师账号不参与运动记录';

// 转盘几何：8 格 × 45°
const SPIN_ROUNDS = 5;
const SECTOR_COUNT = 8;
const DEG_PER_SECTOR = 360 / SECTOR_COUNT;

// 播报轮播间隔
const FEED_INTERVAL_MS = 3000;
// 动效时长（与 WXSS 里的 animation 时长对齐，改一处要改两处）
// 中奖弹层的**停留时长**。用户 2026-11-13「特效就显示了1秒不到我什么都没看见」——
// 原来 normal 只有 420ms（还没看清就没了）。现在最普通的一档也给 2.2 秒，
// 而且任何一档都能点「收下 / 知道了」或点遮罩立刻关（不必干等）。
const FX_MS = { normal: 2200, rare: 3000, rarest: 4200 };

function cachedRole() {
  try {
    const u = auth.getUser();
    return (u && u.role) || '';
  } catch (e) {
    return '';
  }
}

// ===== 激励视频单例（沿用）=====
let videoAd = null;
let videoAdUnitId = '';
let videoAdReady = false;
let closeWaiter = null;

function ensureVideoAd(adUnitId) {
  const id = adUnitId || DEFAULT_AD_UNIT_ID;
  if (videoAd && videoAdUnitId === id) return videoAd;
  if (videoAd && videoAd.destroy) videoAd.destroy();
  videoAd = null;
  videoAdUnitId = id;
  videoAdReady = false;
  closeWaiter = null;
  if (!wx.createRewardedVideoAd) return null;
  videoAd = wx.createRewardedVideoAd({ adUnitId: id });
  videoAd.onLoad(() => {
    videoAdReady = true;
  });
  videoAd.onError((err) => {
    console.warn('[beidou] 激励视频加载失败（本次不计次）', err);
  });
  videoAd.onClose((res) => {
    const waiter = closeWaiter;
    closeWaiter = null;
    if (!waiter) return;
    waiter(!!(res && res.isEnded === true));
  });
  return videoAd;
}

function showVideoAd() {
  const first = videoAdReady
    ? videoAd.show()
    : Promise.resolve(videoAd.load()).then(() => videoAd.show());
  return first.catch(() => Promise.resolve(videoAd.load()).then(() => videoAd.show()));
}

function waitForClose() {
  return new Promise((resolve) => {
    closeWaiter = resolve;
  });
}

// ===== 插屏（沿用：进页面首屏加载后 1 次，会话最多 3 次）=====
const INTERSTITIAL_AD_UNIT_ID = 'adunit-773c53ab76db1155';
const INTERSTITIAL_SESSION_MAX = 3;
let interstitialAd = null;
let interstitialShowCount = 0;
let adPage = null;

function emitAdEvent(name, payload) {
  try {
    if (adPage && typeof adPage[name] === 'function') adPage[name](payload);
  } catch (e) {
    /* 日志失败不影响业务 */
  }
}

function ensureInterstitialAd() {
  if (interstitialAd) return interstitialAd;
  if (!wx.createInterstitialAd) return null;
  interstitialAd = wx.createInterstitialAd({ adUnitId: INTERSTITIAL_AD_UNIT_ID });
  interstitialAd.onLoad(() => emitAdEvent('adLoad'));
  interstitialAd.onError((err) => emitAdEvent('adError', err));
  interstitialAd.onClose(() => emitAdEvent('adClose'));
  return interstitialAd;
}

function showEntryInterstitial(pageData) {
  if (!pageData || pageData._entryInterstitialDone) return;
  if (interstitialShowCount >= INTERSTITIAL_SESSION_MAX) return;
  const ad = ensureInterstitialAd();
  if (!ad) return;
  pageData._entryInterstitialDone = true;
  ad.show()
    .then(() => {
      interstitialShowCount += 1;
    })
    .catch((err) => {
      console.warn('[beidou] 插屏广告显示失败（已静默）', err);
    });
}

function makeNonce(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 扇区渲染数据：把服务端 sectors 展开成带角度的 8 格。
 * ⚠️ 顺序即服务端顺序，不排序不去重（排序就会「停在 A 却发 B」）。
 *
 * 角度约定：扇区 i 覆盖 [i*45°, (i+1)*45°)，第 0 格从正上方顺时针；centerDeg 是标签与停位目标。
 */
function buildSectorViews(sectors, prizes) {
  const byKey = new Map((prizes || []).map((p) => [p.key, p]));
  return (sectors || []).map((key, i) => {
    const p = byKey.get(key) || { key, label: key, type: 'none', amount: 0 };
    const midDeg = i * DEG_PER_SECTOR + DEG_PER_SECTOR / 2;
    return {
      key: `${key}-${i}`,
      prizeKey: key,
      label: p.label || key,
      // 单行文字（「100步」「谢谢」「再来一次」）：径向排布时两行会被转成「一横一竖」，
      // 所以压成一行，整条沿半径方向读。
      labelText: labelTextOf(p),
      type: p.type,
      amount: p.amount || 0,
      startDeg: i * DEG_PER_SECTOR,
      midDeg,
      // 径向文字：标签自身的绝对旋转 = midDeg + textDeg。
      //   textDeg = -90 → 绝对角 = midDeg-90，文字沿半径**朝外**读（像轮辐）；
      //   若这个角度落在 (90°,270°) 就是倒着读，翻 180°（textDeg=90）改成朝中心读，
      //   字符仍然是正的（这就是轮盘上「左右两半文字方向相反」的由来，不是 bug）。
      // 判据用 midDeg：midDeg-90 ∈ (90,270) ⟺ midDeg ∈ (180,360)。
      // 为什么用径向而不是水平：盘面要转，水平文字停下后会被整体带歪 22.5°~90°；
      // 径向是**旋转对称**的，任何旋转角度看着都一样整齐。
      textDeg: midDeg > 180 && midDeg < 360 ? 90 : -90,
      centerDeg: midDeg,
      // clip-path 用的多边形（12% 宽度的楔形，圆心在顶部中央）
      clip: clipOf(i),
      tint: p.type === 'steps' ? 'steps' : p.type === 'draw' ? 'draw' : 'none',
    };
  });
}

// 扇区里的单行文案（径向排列，只能一行放得下）
function labelTextOf(p) {
  if (p.type === 'steps') return `${p.amount || 0}步`;
  if (p.type === 'draw') return '再来一次';
  return '谢谢';
}

/**
 * 8 等分楔形的 clip-path。
 *
 * 为什么不用 conic-gradient：安卓部分机型/低版本 WebView 不支持，
 * 转盘会渲染成**纯色**（用户看到的就是「转盘没格子」）。clip-path polygon 兼容性好得多，
 * 而且每格是独立元素，能给停位那格单独加高亮 —— 这正是「炫」需要的能力。
 *
 * ⚠️ 楔形的**顶点必须是圆心 (50%, 50%)**，弧点绕同一圆心画（半径 50%）。
 *    这里曾写成顶点 `50% 0%`（盘子**正上方**）配绕圆心的弧：8 格的尖端于是全部汇聚到
 *    12 点指针处，整盘从顶部往下散开 —— 中心白环与格子对不上、标签压在两格交界上，
 *    用户看到的就是「背景分层错位」（2026-11-13 截图）。
 *    顶点写错**不会报错、也不会白屏**，盘面照样有颜色，只有几何关系是错的，
 *    所以这里由 `clipOf` 单点产出 + 检查器钉死首点必须是 50% 50%。
 */
const ARC_STEPS = 6;
function clipOf(i) {
  const a0 = (i * DEG_PER_SECTOR - 90) * (Math.PI / 180);
  const a1 = ((i + 1) * DEG_PER_SECTOR - 90) * (Math.PI / 180);
  const pts = ['50% 50%'];
  for (let s = 0; s <= ARC_STEPS; s += 1) {
    const a = a0 + ((a1 - a0) * s) / ARC_STEPS;
    const x = 50 + Math.cos(a) * 50;
    const y = 50 + Math.sin(a) * 50;
    pts.push(`${x.toFixed(2)}% ${y.toFixed(2)}%`);
  }
  return `polygon(${pts.join(', ')})`;
}

/**
 * 中心按钮的三态文案（JS 预计算，模板不写三元拼接）。
 *
 * 「没次数」是一句**死话**：用户看到它只会退出去。改成「赚次数 / 去做任务」，
 * 点一下直接滚到任务区（见 tapCenter），把死胡同变成下一步动作。
 */
function buildCenterState({ enabled, remaining, spinning }) {
  if (spinning) return { main: '抽奖中', sub: '' };
  if (enabled === false) return { main: '未开启', sub: '' };
  if ((Number(remaining) || 0) > 0) return { main: '抽奖', sub: `剩 ${remaining} 次` };
  return { main: '赚次数', sub: '去做任务' };
}

function buildOddsText(prizes) {
  if (!prizes || !prizes.length) return '';
  return prizes.map((p) => `${p.label} ${p.percent}%`).join(' · ');
}

function buildCheckinCells(checkin) {
  const ms = (checkin && checkin.milestones) || [];
  const streak = (checkin && checkin.streak) || 0;
  const done = !!(checkin && checkin.done);
  const todayIdx = checkin && checkin.todayIndex;
  return ms.map((m, i) => {
    const dayNo = i + 1;
    const signed = dayNo <= streak;
    const isToday = !done && todayIdx === i;
    return {
      dayNo,
      signed,
      isToday,
      draw: m.draw || 0,
      steps: m.steps || 0,
      label: `第${dayNo}天`,
      rewardText: m.steps > 0 ? `+${m.draw}次 +${m.steps}步` : `+${m.draw}次`,
      // 格子里那一行「给什么」——用户 2026-11-13「签到没有显示获得奖品，只有大字」。
      // 早先格子里只有一个「大」字（表示第 3/7 天是大奖），等于什么奖励都没说。
      // 大字号放不下「+2次+200步」，所以分两行：上行次数、下行步数（没有步数就只显示次数）。
      rewardDrawText: m.draw > 0 ? `+${m.draw}次` : '',
      rewardStepsText: m.steps > 0 ? `+${m.steps}步` : '',
      // 有步数的档（第 3/7 天）用样式强调，不再写字
      big: m.steps > 0,
    };
  });
}

Page({
  data: {
    loading: true,
    blocked: false,
    enabled: true,
    sfxEnabled: true,
    sfxMuted: false,

    // 播报
    feed: [],
    feedIndex: 0,
    feedEmptyText: '今天还没人抽中，来抢第一个',

    // 转盘
    sectors: [],
    rotateDeg: 0,
    spinning: false,
    activeIndex: -1, // 高亮停位那格
    lastPrize: null,
    // 中心按钮三态文案（JS 预计算，模板不写三元）
    centerMain: '抽奖',
    centerSub: '',
    // 我的最近中奖（服务端下发 5 条）
    recent: [],

    // 动效
    fx: '', // '' | 'normal' | 'rare' | 'rarest'
    fxRarity: 'normal',
    confetti: [], // 彩带 8 片（只在 rarest 用）

    // 次数
    remaining: 0,
    unlimited: false,
    maxPerDay: 0,
    drawTotal: 0,
    drawUsed: 0,

    // 任务
    video: { drawPerWatch: 0, count: 0, remaining: 0, dailyLimit: 0 },
    share: { drawPerShare: 0, count: 0, remaining: -1, dailyLimit: 0 },

    // 签到
    checkin: { enabled: false, done: false, streak: 0, cells: [], todayRewardText: '' },

    // 封顶
    cap: { cap: 0, used: 0, left: 0, capped: false },
    capText: '',

    // 已入账
    earned: { steps: 0, distance: 0, calories: 0, durationSeconds: 0 },
    earnedLine: '', // 四宫格压成一行

    // 规则
    oddsText: '',
    rarityText: '',
    showRules: false,
    adUnitId: '',
  },

  // ===== 教师拦截（三道）=====
  blockTeacher() {
    if (this._guardRedirecting) return;
    this._guardRedirecting = true;
    this.setData({ blocked: true, loading: false });
    wx.showToast({ title: TEACHER_TOAST, icon: 'none' });
    wx.showModal({
      title: TEACHER_BLOCK_TITLE,
      content: TEACHER_BLOCK_SUB,
      showCancel: false,
      confirmText: '知道了',
      complete: () => this.leavePage(),
    });
  },

  leavePage() {
    const fallback = () => {
      if (wx.reLaunch) wx.reLaunch({ url: '/pages/home/home' });
    };
    if (!wx.navigateBack) {
      fallback();
      return;
    }
    wx.navigateBack({
      delta: 1,
      fail: () => {
        if (wx.navigateBackDelta) wx.navigateBackDelta(1, fallback);
        else fallback();
      },
    });
  },

  onLoad() {
    if (!getApp().requireLogin()) return;
    if (cachedRole() === 'teacher') this.blockTeacher();
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    if (this._guardRedirecting) return;
    adPage = this;
    this._unloaded = false;
    this.setData({ sfxMuted: sfx.userMuted() });
    if (cachedRole() === 'teacher') {
      this.blockTeacher();
      return;
    }
    this.load();
  },

  onHide() {
    this.stopFeed();
  },

  onUnload() {
    closeWaiter = null;
    if (adPage === this) adPage = null;
    this._unloaded = true;
    this.stopFeed();
    this.clearFxTimers();
  },

  // ===== 广告日志 =====
  adLoad() {
    console.log('[beidou] 插屏广告加载成功');
  },
  adError(err) {
    console.error('[beidou] 插屏广告加载失败', err);
  },
  adClose() {
    console.log('[beidou] 插屏广告已关闭');
  },

  // ===== 分享 =====
  onShareAppMessage() {
    return { title: '一起来攒步数 · 唐唐快跑', path: '/pages/splash/splash' };
  },

  onShareTap() {
    if (this._sharing) return;
    this._sharing = true;
    auth
      .post('/api/beidou/share/report', { shareId: makeNonce('sh') })
      .then((res) => {
        if (res && res.success) {
          this.applyCounters(res);
          wx.showToast({ title: `+${res.gained || 1} 次抽奖机会`, icon: 'none' });
        } else if (res && res.message) {
          wx.showToast({ title: res.message, icon: 'none' });
        }
      })
      .catch((e) => {
        if (e.code === 403004) this.showRestriction(e);
        else wx.showToast({ title: e.message, icon: 'none' });
      })
      .then(() => {
        this._sharing = false;
      });
  },

  // ===== 数据加载 =====
  async load() {
    try {
      const me = (await getApp().ensureLogin()) || (getApp().globalData && getApp().globalData.userInfo) || {};
      if ((me.role || '') === 'teacher') {
        this.blockTeacher();
        return;
      }
      // 两个 GET 并行：播报不该拖慢首屏
      const [data, feedData] = await Promise.all([
        auth.get('/api/beidou/today'),
        auth.get('/api/beidou/winners?limit=20').catch(() => null),
      ]);
      if (data && data.blocked) {
        this.blockTeacher();
        return;
      }
      ensureVideoAd(data.adUnitId);
      ensureInterstitialAd();
      this.applyState(data);
      this.applyFeed(feedData);
      showEntryInterstitial(this);
      this.startFeed();
    } catch (e) {
      if (e.code === 403003) return;
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  // 把 today 状态铺到 data
  applyState(data) {
    const e = data.earned || {};
    const checkin = data.checkin || {};
    const cap = data.cap || {};
    const cells = buildCheckinCells(checkin);
    const todayCell = cells.find((c) => c.isToday) || cells[Math.min(checkin.streak || 0, cells.length - 1)];
    const prizes = (data.draw && data.draw.prizes) || [];
    const sectorList = (data.draw && data.draw.sectors) || [];
    const capText =
      cap.cap > 0 && cap.capped
        ? `今日步数奖励已达上限（${cap.cap} 步），明天再来`
        : cap.cap > 0
          ? `今日步数奖励还剩 ${cap.left} 步额度`
          : '';
    const remaining = (data.draw && data.draw.remaining) || 0;
    const enabled = data.enabled !== false;
    const center = buildCenterState({ enabled, remaining, spinning: false });
    this.setData({
      loading: false,
      enabled,
      sfxEnabled: data.sfxEnabled !== false,
      sectors: buildSectorViews(sectorList, prizes),
      remaining,
      centerMain: center.main,
      centerSub: center.sub,
      // 我的最近中奖（服务端已拼好 prizeLabel / atText，前端只渲染）
      recent: Array.isArray(data.recent) ? data.recent : [],
      unlimited: !!(data.draw && data.draw.unlimited),
      maxPerDay: (data.draw && data.draw.maxPerDay) || 0,
      drawTotal: (data.draw && data.draw.total) || 0,
      drawUsed: (data.draw && data.draw.used) || 0,
      video: data.video || { drawPerWatch: 0, count: 0, remaining: 0, dailyLimit: 0 },
      share: data.share || { drawPerShare: 0, count: 0, remaining: -1, dailyLimit: 0 },
      checkin: {
        enabled: checkin.enabled !== false,
        done: !!checkin.done,
        streak: checkin.streak || 0,
        cells,
        todayRewardText: todayCell ? todayCell.rewardText : '',
      },
      cap: { cap: cap.cap || 0, used: cap.used || 0, left: cap.left || 0, capped: !!cap.capped },
      capText,
      earned: e,
      earnedLine: buildEarnedLine(e),
      oddsText: buildOddsText(prizes),
      rarityText: data.rarityText || '',
      adUnitId: (data.video && data.video.adUnitId) || '',
    });
  },

  // 播报数据（失败/空都走空态，不留白条）
  applyFeed(feedData) {
    const items = (feedData && feedData.items) || [];
    this.setData({
      feed: items,
      feedIndex: 0,
    });
  },

  // ===== 播报轮播 =====
  startFeed() {
    this.stopFeed();
    const len = (this.data.feed || []).length;
    if (len < 2) return; // 0/1 条不用轮播
    this._feedTimer = setInterval(() => {
      if (this._unloaded) return;
      const next = (this.data.feedIndex + 1) % len;
      this.setData({ feedIndex: next });
    }, FEED_INTERVAL_MS);
  },

  stopFeed() {
    if (this._feedTimer) {
      clearInterval(this._feedTimer);
      this._feedTimer = null;
    }
  },

  applyCounters(res) {
    if (!res) return;
    const patch = {};
    if (res.remaining !== undefined) patch.remaining = res.remaining;
    if (res.unlimited !== undefined) patch.unlimited = !!res.unlimited;
    if (res.maxPerDay !== undefined) patch.maxPerDay = res.maxPerDay;
    if (res.total !== undefined) patch.drawTotal = res.total;
    if (res.used !== undefined) patch.drawUsed = res.used;
    // 次数变了，中心按钮文案要跟着变（否则「剩 3 次」会一直停在旧值）
    if (patch.remaining !== undefined || patch.unlimited !== undefined) {
      const center = buildCenterState({
        enabled: this.data.enabled,
        remaining: patch.remaining !== undefined ? patch.remaining : this.data.remaining,
        spinning: !!this.data.spinning,
      });
      patch.centerMain = center.main;
      patch.centerSub = center.sub;
    }
    if (Object.keys(patch).length) this.setData(patch);
  },

  showRestriction(e) {
    const r = e.restriction || {};
    wx.showModal({
      title: `${r.text || '该功能'}已被限制`,
      content: `${r.reason || '数据异常'}\n解封时间：${r.until ? String(r.until).slice(0, 16).replace('T', ' ') : '永久'}`,
      confirmText: '去申诉',
      cancelText: '知道了',
      success: (res) => {
        if (res.confirm) wx.navigateTo({ url: `/pages/appeal/submit?scope=${r.scope || 'sync'}` });
      },
    });
  },

  // ===== 抽奖 =====
  async draw() {
    if (this._busy || this.data.spinning) return;
    if (this.data.blocked) return;
    if (!this.data.enabled) {
      wx.showToast({ title: '活动暂未开启', icon: 'none' });
      return;
    }
    if (this.data.remaining <= 0) {
      wx.showToast({ title: '抽奖次数不够了，去看视频或签到吧', icon: 'none' });
      return;
    }
    // ⚠️ iOS 要求音频在**用户手势同一 tick** 里初始化：这里同步预热一次，
    //    后面 applyDrawResult 里 play() 才不会因为「非手势触发」被静默拦掉。
    //    放在 try 外面也不行 —— 这里本身就在 tap handler 的同步栈里。
    //    管理端关掉音效时连预热都跳过（别为不存在的功能建上下文）。
    // 点下去立刻给一声「哒」：既是最快的反馈，也是 iOS 上把音频上下文**解锁**在手势栈里的
    // 唯一可靠时机（等 3.2 秒转盘停下来再 play，很多机型会静默不响 —— 那正是「没有音效」的成因）。
    if (this.data.sfxEnabled) {
      sfx.prewarm && sfx.prewarm();
      sfx.play('spin');
    }

    this._busy = true;
    const spinCenter = buildCenterState({ enabled: true, remaining: this.data.remaining, spinning: true });
    this.setData({
      spinning: true,
      lastPrize: null,
      activeIndex: -1,
      fx: '',
      centerMain: spinCenter.main,
      centerSub: spinCenter.sub,
    });
    try {
      const result = await auth.post('/api/beidou/draw', { drawId: makeNonce('dr') });
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.message) || '抽奖失败', icon: 'none' });
        // 失败也要把中心按钮从「抽奖中」还原，否则转盘没动、按钮却永远停在抽奖中
        this.restoreCenter();
        this.load();
        return;
      }
      this.spinTo(result.index, () => {
        this.applyDrawResult(result);
      });
    } catch (e) {
      this.restoreCenter();
      if (e.code === 403001) {
        wx.navigateTo({ url: '/pages/banned/banned' });
        return;
      }
      if (e.code === 403004) {
        this.showRestriction(e);
        return;
      }
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this._busy = false;
    }
  },

  /**
   * 把第 index 格的**中线**转到正上方的指针下（0° = 正上方，顺时针）。
   *
   * 指针固定在 12 点、盘面旋转 —— 这是用户对「转盘」的默认预期（指针歪着停在某个角度
   * 会让人以为坏了）。文字因此必须用**径向**排布：径向是旋转对称的，盘面停在任何角度都整齐；
   * 水平文字会被整体带歪 22.5°~90°。
   * 目标角 = base + 5 整圈 + (360 − centerDeg)，centerDeg = i*45 + 22.5。
   * 停位误差超过半格（22.5°）就会「停在 A 却发 B」，所以只允许与 buildSectorViews 共用常量。
   */
  spinTo(index, done) {
    const safeIndex = Math.max(0, Math.min(SECTOR_COUNT - 1, Number(index) || 0));
    const current = this.data.rotateDeg || 0;
    const base = Math.ceil(current / 360) * 360;
    const centerDeg = safeIndex * DEG_PER_SECTOR + DEG_PER_SECTOR / 2;
    const target = base + 360 * SPIN_ROUNDS + (360 - centerDeg);
    this.setData({ rotateDeg: target });
    const finish = () => {
      if (this._spinTimer) {
        clearTimeout(this._spinTimer);
        this._spinTimer = null;
      }
      // 停稳后中心按钮恢复可点态（次数在 applyDrawResult → applyCounters 里更新）
      const center = buildCenterState({
        enabled: this.data.enabled,
        remaining: this.data.remaining,
        spinning: false,
      });
      this.setData({
        spinning: false,
        activeIndex: safeIndex,
        centerMain: center.main,
        centerSub: center.sub,
      });
      if (typeof done === 'function') done();
    };
    this._spinDone = finish;
    if (this._spinTimer) clearTimeout(this._spinTimer);
    this._spinTimer = setTimeout(finish, 3600);
  },

  onSpinEnd() {
    if (this._spinDone) this._spinDone();
  },

  // 抽奖结果落盘 + 按稀有度播三档动效/音效
  applyDrawResult(result) {
    const p = result.prize || {};
    const rarity = result.rarity || 'normal';
    const prizeText =
      p.type === 'steps'
        ? `抽到 ${p.label || p.amount + ' 步'}`
        : p.type === 'draw'
          ? '再来一次！'
          : result.capped
            ? '谢谢参与（今日步数奖励已达上限）'
            : '谢谢参与';
    const icon = p.type === 'steps' ? 'check-circle' : p.type === 'draw' ? 'refresh' : 'info-circle';
    const color = p.type === 'none' ? 'var(--tt-text-3)' : 'var(--tt-brand)';

    this.setData({
      lastPrize: {
        key: p.key || '',
        type: p.type || 'none',
        amount: p.amount || 0,
        label: p.label || '',
        capped: !!result.capped,
        text: prizeText,
        icon,
        color,
      },
    });
    this.applyCounters(result);
    if (result.earned) {
      this.setData({ earned: result.earned, earnedLine: buildEarnedLine(result.earned) });
    }
    if (result.cap) {
      const cap = result.cap;
      this.setData({
        cap: { cap: cap.cap || 0, used: cap.used || 0, left: cap.left || 0, capped: !!cap.capped },
        capText:
          cap.cap > 0 && (cap.capped || result.capped)
            ? `今日步数奖励已达上限（${cap.cap} 步），明天再来`
            : cap.cap > 0
              ? `今日步数奖励还剩 ${cap.left} 步额度`
              : '',
      });
    }

    this.playFx(p.type === 'none' ? 'none' : rarity, p, result.capped);

    // 自己中奖：播报条把自己那条置顶高亮一次（Q3=A）
    if (p.type !== 'none') {
      this.prependSelfToFeed(p, result.capped);
    }
    this.loadRecent();
  },

  /**
   * 三档动效 + 对应音效/震动。
   *
   * 档位完全按服务端 rarity 走（不自己算），三档强度递进：
   *   normal  弹卡 + 轻震
   *   rare    + 光晕扩散 + 中震 + 音效
   *   rarest  + 金边闪光 + 彩带 + 双震 + 专属音效
   */
  playFx(rarity, prize, capped) {
    const kind = rarity === 'none' ? 'none' : rarity === 'rarest' ? 'rarest' : rarity === 'rare' ? 'rare' : 'normal';
    this.clearFxTimers();

    // 管理端总开关（goal_config.beidou.sfxEnabled）必须真的拦住播放 ——
    // 早先它只进了 data、从没被读过，管理员关掉等于没关（开关是假的）。
    const audio = this.data.sfxEnabled !== false;

    if (kind === 'none') {
      // 空奖：轻反馈，别做成「惩罚」
      if (audio) sfx.play('none');
      sfx.vibrate('none');
      this.setData({ fx: 'normal', fxRarity: 'normal' });
      this._fxTimer = setTimeout(() => {
        if (!this._unloaded) this.setData({ fx: '' });
      }, FX_MS.normal);
      return;
    }

    const confetti =
      kind === 'rarest'
        ? Array.from({ length: 10 }, (_, i) => ({
            k: i,
            left: 6 + i * 9,
            delay: (i % 5) * 60,
            dur: 1100 + (i % 3) * 220,
            rot: (i * 37) % 360,
          }))
        : [];
    this.setData({ fx: kind, fxRarity: kind, confetti });
    if (audio) sfx.play(kind);
    sfx.vibrate(kind);
    this._fxTimer = setTimeout(() => {
      if (!this._unloaded) this.setData({ fx: '', confetti: [] });
    }, FX_MS[kind] || FX_MS.normal);
  },

  clearFxTimers() {
    if (this._fxTimer) {
      clearTimeout(this._fxTimer);
      this._fxTimer = null;
    }
  },

  /**
   * 把中心按钮还原成「不转」的状态（失败/异常路径专用）。
   *
   * 早先这些路径只写 `spinning: false`，而中心文案是独立的 data ——
   * 于是接口一失败，转盘没动、按钮却永远停在「抽奖中」，用户只能杀进程重进。
   */
  restoreCenter() {
    const center = buildCenterState({
      enabled: this.data.enabled,
      remaining: this.data.remaining,
      spinning: false,
    });
    this.setData({ spinning: false, centerMain: center.main, centerSub: center.sub });
  },

  // 手动收起中奖弹层（自动收起的计时器也要一起清，否则会再闪一下）
  closeFx() {
    this.clearFxTimers();
    if (!this._unloaded) this.setData({ fx: '', confetti: [] });
  },

  // 自己中奖时把播报置顶（本地插入，不重新请求）
  prependSelfToFeed(prize, capped) {
    const me = getApp().globalData && getApp().globalData.userInfo;
    const nameMasked = myMaskedName(me);
    const item = {
      nameMasked,
      prizeKey: prize.key,
      prizeLabel: prize.label || (prize.type === 'steps' ? `${prize.amount} 步` : '再来一次'),
      prizeType: prize.type,
      amount: prize.amount || 0,
      rarity: 'normal',
      atText: '刚刚',
      isMine: true,
      capped: !!capped,
    };
    const list = [item].concat(this.data.feed || []).slice(0, 20);
    this.setData({ feed: list, feedIndex: 0 });
    this.startFeed();
  },

  async loadRecent() {
    try {
      const data = await auth.get('/api/beidou/today');
      if (data && data.recent) this.setData({ recent: data.recent });
      if (data && data.earned) this.setData({ earnedLine: buildEarnedLine(data.earned) });
    } catch (e) {
      /* 拉不到不影响主流程 */
    }
  },

  // ===== 看视频 =====
  async watch() {
    if (this._watching) return;
    if (this.data.blocked) return;
    if (!this.data.enabled) {
      wx.showToast({ title: '活动暂未开启', icon: 'none' });
      return;
    }
    const v = this.data.video || {};
    if (!v.drawPerWatch) {
      wx.showToast({ title: '看视频暂不发放次数', icon: 'none' });
      return;
    }
    if (v.dailyLimit > 0 && v.count >= v.dailyLimit) {
      wx.showToast({ title: '今日看视频次数已用完，明天再来', icon: 'none' });
      return;
    }
    const ad = ensureVideoAd(this.data.adUnitId);
    if (!ad) {
      wx.showToast({ title: '广告组件暂不可用', icon: 'none' });
      return;
    }
    this._watching = true;
    try {
      const waiter = waitForClose();
      try {
        await showVideoAd();
      } catch (err) {
        closeWaiter = null;
        console.warn('[beidou] 广告展示失败（本次不计次）', err);
        wx.showToast({ title: '广告暂时无法播放，稍后再试', icon: 'none' });
        return;
      }
      const ended = await waiter;
      if (!ended) return;
      const result = await auth.post('/api/beidou/video/report', { watchId: makeNonce('vd') });
      if (result && result.success) {
        this.applyCounters(result);
        this.setData({ 'video.count': (v.count || 0) + 1 });
        wx.showToast({ title: `+${result.gained || 1} 次抽奖机会`, icon: 'success' });
      } else {
        wx.showToast({ title: (result && result.message) || '上报失败', icon: 'none' });
        this.load();
      }
    } catch (e) {
      if (e.code === 403004) {
        this.showRestriction(e);
        return;
      }
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this._watching = false;
    }
  },

  // ===== 签到 =====
  async doCheckin() {
    if (this._checking) return;
    if (this.data.blocked) return;
    if (!this.data.checkin.enabled) {
      wx.showToast({ title: '签到暂未开放', icon: 'none' });
      return;
    }
    if (this.data.checkin.done) {
      wx.showToast({ title: '今天已经签到过了', icon: 'none' });
      return;
    }
    this._checking = true;
    try {
      const result = await auth.post('/api/beidou/checkin', {});
      if (result && result.success) {
        const a = result.award || {};
        const parts = [];
        if (a.draw) parts.push(`+${a.draw} 次抽奖`);
        if (a.steps) parts.push(`+${a.steps} 步`);
        wx.showToast({ title: parts.length ? `签到成功 ${parts.join(' ')}` : '签到成功', icon: 'none' });
        this.load();
      } else {
        wx.showToast({ title: (result && result.message) || '签到失败', icon: 'none' });
      }
    } catch (e) {
      if (e.code === 403004) {
        this.showRestriction(e);
        return;
      }
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this._checking = false;
    }
  },

  // ===== 音效开关 =====
  toggleSfx() {
    const next = !sfx.userMuted();
    sfx.setUserMuted(next);
    this.setData({ sfxMuted: next });
    if (!next) {
      // 打开音效也在手势栈里：顺手解锁音频上下文并试响一声，用户立刻知道「开了」。
      // 打开音效是明确的用户意图，清掉上一轮失败留下的 disabled 标记再试一次。
      sfx.reset && sfx.reset();
      sfx.prewarm && sfx.prewarm();
      if (this.data.sfxEnabled !== false) sfx.play('normal');
    }
    wx.showToast({ title: next ? '已关闭音效' : '已开启音效', icon: 'none' });
  },

  /**
   * 点转盘中心：有次数就抽，没次数就滚到任务区。
   *
   * 早先「没次数」是个点了没反应的死按钮，用户只能退出去 ——
   * 现在它是下一步动作的入口（这也是截图里那个灰色「没次数」最需要改的地方）。
   */
  tapCenter() {
    if (this.data.spinning) return;
    if (this.data.enabled === false) {
      wx.showToast({ title: '活动暂未开启', icon: 'none' });
      return;
    }
    if ((Number(this.data.remaining) || 0) <= 0) {
      this.scrollToTasks();
      return;
    }
    this.draw();
  },

  toggleRules() {
    this.setData({ showRules: !this.data.showRules });
  },

  // 动效层的 catch:tap 落点：只为阻止穿透点击（关闭弹层由自动计时负责）
  noop() {},

  scrollToTasks() {
    if (wx.pageScrollTo) wx.pageScrollTo({ selector: '#tasks', duration: 240 });
  },
});

// ===== 纯函数（页面外用，便于运行时自检直接调用）=====

// 今日已入账压成一行文字
function buildEarnedLine(e) {
  const x = e || {};
  const parts = [];
  if (x.steps) parts.push(`${fmt.formatNumber(x.steps)} 步`);
  if (x.distance) parts.push(fmt.formatDistance(x.distance));
  if (x.calories) parts.push(`${fmt.formatNumber(x.calories)} 千卡`);
  if (x.durationSeconds) parts.push(fmt.formatDuration(x.durationSeconds));
  return parts.length ? parts.join(' · ') : '今天还没有抽到奖励';
}

// 自己的脱敏名（与 server/src/services/name-mask.js 同口径的**展示副本**）
// ⚠️ 只用于前端「自己那条播报」的显示；别人的名字一律由服务端下发脱敏串。
function myMaskedName(user) {
  const name = (user && (user.realName || user.nickname)) || '';
  const s = String(name).trim();
  if (!s) return '我';
  if (s.length === 1) return s + '*';
  return s.slice(0, 1) + '**';
}
