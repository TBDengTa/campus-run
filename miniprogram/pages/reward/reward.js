const auth = require('../../utils/request');
const fmt = require('../../utils/format');
const sfx = require('../../utils/sfx');
const shareRef = require('../../utils/beidou-share');

/**
 * ===== 北斗运动 3.0：铜版经济 + 转盘 + 九宫格连线 + 好友点击归因 =====
 *
 * 玩法口径见 docs/beidou-economy-plan.md。
 *
 * 五条不能破的约定：
 *   ① 结果（转盘 index / 九宫格 board+lines / prize / 概率 / 保底）**只由服务端定**；
 *      前端只做卷轴展示、只按 index 停位，绝不自己随机、不自己算连线、不自己算概率。
 *      卷轴滚动期间的装饰帧是把管理端配置的 symbols 候选按固定顺序循环铺成的纯视觉图案带：
 *      不含随机、不参与判奖、不影响任何结果字段；每列停位偏移由服务端 board 唯一决定
 *      （末端 3 帧 = board 该列 3 格），中奖高亮只来自服务端 lines[].cells；
 *   ② 分享按钮只把预生成的 `share.path` 交给 onShareAppMessage；
 *      真正发铜版发生在好友点开并上报后（utils/beidou-share.js）；
 *   ③ 任务（看视频/签到）只发铜版，不再发抽奖次数/步数；
 *   ④ 音效/震动永远不影响扣币与发奖（sfx 内部全 try/catch）；
 *   ⑤ 卷轴/转盘动画中禁用再次操作；onHide/onUnload 清 timer，回来不会卡在「开奖中」。
 */

const DEFAULT_AD_UNIT_ID = 'adunit-a80731a737d255c9';

const TEACHER_BLOCK_TITLE = '教师账号不参与运动记录';
const TEACHER_BLOCK_SUB = '北斗运动仅对学生开放，教师账号不能领取铜版或步数奖励。';
const TEACHER_TOAST = '教师账号不参与运动记录';

const SPIN_ROUNDS = 5;
const SECTOR_COUNT = 8;
const DEG_PER_SECTOR = 360 / SECTOR_COUNT;
const FEED_INTERVAL_MS = 3000;
const FX_MS = { normal: 2600, rare: 3200, rarest: 4200 };
// 九宫格卷轴：三列同时起滚、逐列减速停（时长差形成 stagger）；几何全 rpx，与静态格同一套换算
const REEL_STOP_MS = [1200, 1900, 2600];
const REEL_START_DELAY_MS = 60;
const REEL_STOP_BUFFER_MS = 80;
const REEL_FRAME_RPX = 160;
const REEL_DECOR_BASE = 16;
const REEL_DECOR_STEP = 8;

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
    console.warn('[beidou] 激励视频加载失败（本次不计奖励）', err);
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

// ===== 插屏（沿用）=====
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

// ===== 转盘扇区 =====

function buildSectorViews(sectors, prizes, coinName) {
  const byKey = new Map((prizes || []).map((p) => [p.key, p]));
  return (sectors || []).map((key, i) => {
    const p = byKey.get(key) || { key, label: key, type: 'none', amount: 0 };
    const midDeg = i * DEG_PER_SECTOR + DEG_PER_SECTOR / 2;
    return {
      key: `${key}-${i}`,
      prizeKey: key,
      label: p.label || key,
      labelText: labelTextOf(p, coinName),
      type: p.type,
      amount: p.amount || 0,
      startDeg: i * DEG_PER_SECTOR,
      midDeg,
      textDeg: midDeg > 180 && midDeg < 360 ? 90 : -90,
      centerDeg: midDeg,
      clip: clipOf(i),
      tint: p.type === 'steps' ? 'steps' : p.type === 'coin' ? 'coin' : p.type === 'draw' ? 'draw' : 'none',
    };
  });
}

function labelTextOf(p, coinName) {
  if (p.type === 'steps') return `${p.amount || 0}步`;
  if (p.type === 'coin') return `${p.amount || 0}${coinName || '铜版'}`;
  if (p.type === 'draw') return '再来一次';
  return '谢谢';
}

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

function buildCenterState({ enabled, remaining, spinning, cost, coinName }) {
  if (spinning) return { main: '抽奖中', sub: '' };
  if (enabled === false) return { main: '未开启', sub: '' };
  if ((Number(remaining) || 0) > 0) return { main: '抽奖', sub: `${cost || 0} ${coinName || '铜版'}/次` };
  return { main: '赚铜版', sub: '去做任务' };
}

function buildOddsText(prizes, coinName) {
  if (!prizes || !prizes.length) return '';
  return prizes
    .map((p) => {
      const label = p.label || (p.type === 'coin' ? `${p.amount} ${coinName}` : p.type === 'steps' ? `${p.amount} 步` : '');
      return `${label} ${p.percent}%`;
    })
    .join(' · ');
}

function buildGridOddsText(symbols, coinName) {
  if (!symbols || !symbols.length) return '';
  return symbols
    .filter((s) => s.type !== 'none')
    .map((s) => {
      const unit = s.type === 'coin' ? (coinName || '铜版') : '步';
      return `${s.label || s.key} 单线+${s.amount}${unit} · 出现率${s.percent || 0}%`;
    })
    .join(' · ');
}

function buildCheckinCells(checkin, coinName) {
  let cells;
  if (checkin && Array.isArray(checkin.cells) && checkin.cells.length) {
    // 签到固定 7 天一轮；服务端旧数据/脏数据超过 7 格也不允许把签到条撑成 21 格
    cells = checkin.cells.slice(0, 7);
  } else {
    const ms = ((checkin && checkin.milestones) || []).slice(0, 7);
    const streak = (checkin && checkin.streak) || 0;
    const done = !!(checkin && checkin.done);
    const todayIdx = checkin && checkin.todayIndex;
    cells = ms.map((m, i) => {
      const dayNo = i + 1;
      const signed = dayNo <= streak;
      const isToday = !done && todayIdx === i;
      const coin = m.coin || 0;
      return {
        dayNo,
        signed,
        isToday,
        coin,
        draw: 0,
        steps: 0,
        label: `第${dayNo}天`,
        rewardText: coin > 0 ? `+${coin} ${coinName || '铜版'}` : '—',
        rewardCoinText: coin > 0 ? `+${coin}` : '',
        big: false,
      };
    });
  }
  // 第 7 天大奖格放大展示（服务端 cells 可能缺 dayNo，按序号兜底）
  return cells.map((c, i) => ({ ...c, isBig: (c.dayNo || i + 1) === 7 || !!c.big }));
}

function buildEarnedLine(e) {
  const x = e || {};
  const parts = [];
  if (x.steps) parts.push(`${fmt.formatNumber(x.steps)} 步`);
  if (x.distance) parts.push(fmt.formatDistance(x.distance));
  if (x.calories) parts.push(`${fmt.formatNumber(x.calories)} 千卡`);
  if (x.durationSeconds) parts.push(fmt.formatDuration(x.durationSeconds));
  return parts.length ? parts.join(' · ') : '今天还没有运动记录';
}

function emptyGridCells() {
  return Array.from({ length: 9 }, (_, i) => ({
    index: i,
    empty: true,
    revealed: false,
    win: false,
    symbolKey: '',
    icon: '?',
    iconUrl: '',
    label: '',
    type: 'none',
    amount: 0,
  }));
}

// 装卷轴图案带：装饰帧按 symbols 配置顺序确定性循环（零随机、纯视觉），
// 末端 3 帧严格 = 服务端 board 该列 3 格（board 行主序，列 c 取 c/c+3/c+6），停位由 board 唯一决定。
function buildReels(board, symbols) {
  const source = Array.isArray(symbols) && symbols.length ? symbols : board;
  const pool = source.map((s) => ({
    symbolKey: s.symbolKey || s.key || '',
    icon: s.icon || '?',
    iconUrl: s.iconUrl || '',
    label: s.label || '',
    type: s.type || 'none',
  }));
  const reels = [];
  for (let c = 0; c < 3; c += 1) {
    const decor = REEL_DECOR_BASE + REEL_DECOR_STEP * c;
    const frames = [];
    for (let i = 0; i < decor; i += 1) {
      const s = pool[(i + c) % pool.length];
      frames.push({ k: i, symbolKey: s.symbolKey, icon: s.icon, iconUrl: s.iconUrl, label: s.label, type: s.type, boardIndex: -1 });
    }
    for (let r = 0; r < 3; r += 1) {
      const cell = board[c + r * 3] || {};
      frames.push({
        k: decor + r,
        symbolKey: cell.symbolKey || '',
        icon: cell.icon || '?',
        iconUrl: cell.iconUrl || '',
        label: cell.label || '',
        type: cell.type || 'none',
        boardIndex: c + r * 3,
      });
    }
    reels.push({ col: c, frames, offsetRpx: 0, durationMs: REEL_STOP_MS[c], stopped: false });
  }
  return reels;
}

function myMaskedName(user) {
  const name = (user && (user.realName || user.nickname)) || '';
  const s = String(name).trim();
  if (!s) return '我';
  if (s.length === 1) return s + '*';
  return s.slice(0, 1) + '**';
}

Page({
  data: {
    loading: true,
    blocked: false,
    enabled: true,
    sfxEnabled: true,
    sfxMuted: false,
    mode: 'wheel', // wheel | grid

    // 铜版
    coinName: '铜版',
    coin: {
      name: '铜版',
      iconUrl: '',
      balance: 0,
      earnedToday: 0,
      spentToday: 0,
      gameEarnedToday: 0,
      dailyGameCap: 0,
      gameCapLeft: -1,
      gameCapReached: false,
    },
    coinLine: '',
    coinCapPercent: 0,

    // 播报
    feed: [],
    feedIndex: 0,
    feedEmptyText: '今天还没人抽中，来抢第一个',

    // 转盘
    sectors: [],
    rimLights: Array.from({ length: 16 }, (_, i) => ({ k: i, deg: i * 22.5 })),
    marqueeLights: Array.from({ length: 24 }, (_, i) => ({ k: i })),
    leverPulled: false,
    rotateDeg: 0,
    spinning: false,
    activeIndex: -1,
    lastPrize: null,
    centerMain: '抽奖',
    centerSub: '',
    wheel: {
      enabled: true,
      cost: 0,
      remaining: 0,
      unlimited: false,
      total: 0,
      used: 0,
      maxPerDay: 0,
      canPlay: false,
      pity: { after: 0, losses: 0, remaining: 0, ready: false, text: '' },
    },
    recent: [],

    // 九宫格
    grid: {
      enabled: false,
      cost: 0,
      canPlay: false,
      playsToday: 0,
      maxPerDay: 0,
      symbols: [],
      outcomes: [],
      pity: { after: 0, losses: 0, remaining: 0, ready: false, text: '' },
      cells: emptyGridCells(),
      lines: [],
      revealing: false,
      revealCount: 0,
      reels: [],
      phase: 'idle',
      resultText: '点「开一局」看连线结果',
      lastResult: null,
    },
    gridOddsText: '',

    // 任务
    video: { enabled: false, coinPerWatch: 0, count: 0, remaining: 0, dailyLimit: 0, adUnitId: '' },
    share: {
      enabled: false,
      coinPerClick: 0,
      dailyLimit: 0,
      rewardedToday: 0,
      clicksToday: 0,
      remaining: -1,
      token: '',
      path: '',
      ready: false,
    },

    // 签到
    checkin: { enabled: false, done: false, streak: 0, cells: [], todayRewardText: '' },

    // 封顶
    cap: { cap: 0, used: 0, left: 0, capped: false },
    capText: '',

    // 已入账
    earned: { steps: 0, distance: 0, calories: 0, durationSeconds: 0 },
    earnedLine: '',

    // 规则
    oddsText: '',
    rarityText: '',
    showRules: false,
    adUnitId: '',

    // 中奖弹层
    fx: '',
    fxRarity: '',
    confetti: [],
    coinRain: [],
    fxRays: [],
    fxSparks: [],
    fxShake: '',
    fxAmountText: '',
    fxAmountUnit: '',
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

  onLoad(options) {
    // 兼容直接打开 /pages/reward/reward?bdshare=xxx 的场景（正常分享路径是 splash）
    shareRef.capture(options);
    if (!getApp().requireLogin()) return;
    if (cachedRole() === 'teacher') this.blockTeacher();
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    if (this._guardRedirecting) return;
    adPage = this;
    this._unloaded = false;
    this.setData({ sfxMuted: sfx.userMuted() });
    this.detectReducedMotion();
    if (cachedRole() === 'teacher') {
      this.blockTeacher();
      return;
    }
    this.load();
  },

  // 系统「减弱动效」探针：读隐藏节点的 computedStyle（reduce 块把 transition-duration 归 0s）
  detectReducedMotion() {
    try {
      wx.createSelectorQuery()
        .select('.bd-reel-probe')
        .fields({ computedStyle: ['transitionDuration'] }, (res) => {
          const d = (res && res.transitionDuration) || '';
          this._reducedMotion = d === '0s' || d === '0ms';
        })
        .exec();
    } catch (e) {
      this._reducedMotion = false;
    }
  },

  onHide() {
    this.stopFeed();
    this.clearGridTimer(true);
    this.clearLever();
  },

  onUnload() {
    closeWaiter = null;
    if (adPage === this) adPage = null;
    this._unloaded = true;
    this.stopFeed();
    this.clearFxTimers();
    this.clearGridTimer(true);
    this.clearLever();
  },

  clearLever() {
    if (this._leverTimer) {
      clearTimeout(this._leverTimer);
      this._leverTimer = null;
    }
    if (this.data.leverPulled) this.setData({ leverPulled: false });
  },

  // 拉杆 = 开一局同入口：tap 同步栈内调 playGrid 保住 sfx.prewarm 手势；
  // 双入口竞态由 playGrid 首行 _gridBusy/revealing 守卫兜底
  onLeverTap() {
    if (this._gridBusy || this.data.grid.revealing) return;
    const canPull = this.data.enabled && this.data.grid.enabled && this.data.grid.canPlay
      && this.data.coin.balance >= this.data.grid.cost;
    if (canPull) {
      this.setData({ leverPulled: true });
      // 两拍：下压 160ms + 停留 100ms 后松手回弹（transition 0.16s）
      this._leverTimer = setTimeout(() => {
        if (!this._unloaded) this.setData({ leverPulled: false });
      }, 260);
    }
    this.playGrid();
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
    return {
      title: '一起用北斗运动攒铜版',
      path: this.data.share.path || '/pages/splash/splash',
    };
  },

  // 分享面板由 open-type="share" 打开；这里只处理「令牌还没准备好」的情况
  onShareTap() {
    if (!this.data.share.enabled) {
      wx.showToast({ title: '分享暂未开放', icon: 'none' });
      return;
    }
    if (!this.data.share.ready) {
      wx.showToast({ title: '分享准备中，稍后再试', icon: 'none' });
    }
  },

  // ===== 数据加载 =====
  async load() {
    try {
      const me = (await getApp().ensureLogin()) || (getApp().globalData && getApp().globalData.userInfo) || {};
      if ((me.role || '') === 'teacher') {
        this.blockTeacher();
        return;
      }
      const [data, feedData] = await Promise.all([
        auth.get('/api/beidou/today'),
        auth.get('/api/beidou/winners?limit=20').catch(() => null),
      ]);
      if (data && data.blocked) {
        this.blockTeacher();
        return;
      }
      ensureVideoAd((data && data.video && data.video.adUnitId) || '');
      ensureInterstitialAd();
      this.applyState(data || {});
      this.applyFeed(feedData);
      showEntryInterstitial(this);
      this.startFeed();
    } catch (e) {
      if (e.code === 403003) return;
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  applyState(data) {
    const e = data.earned || {};
    const checkin = data.checkin || {};
    const cap = data.cap || {};
    const coin = data.coin || {};
    const wheel = data.draw || {};
    const grid = data.grid || {};
    const video = data.video || {};
    const share = data.share || {};
    const coinName = coin.name || data.coinName || '铜版';
    const cells = buildCheckinCells(checkin, coinName);
    const todayCell = cells.find((c) => c.isToday) || cells[Math.min(checkin.streak || 0, cells.length - 1)];
    const prizes = wheel.prizes || [];
    const sectorList = wheel.sectors || [];
    const capText =
      cap.cap > 0 && cap.capped
        ? `今日步数奖励已达上限（${cap.cap} 步），明天再来`
        : cap.cap > 0
          ? `今日步数奖励还剩 ${cap.left} 步额度`
          : '';
    const remaining = wheel.remaining || 0;
    const enabled = data.enabled !== false;
    const center = buildCenterState({
      enabled,
      remaining,
      spinning: false,
      cost: wheel.cost,
      coinName,
    });
    const gridPity = grid.pity || {};
    const wheelPity = wheel.pity || {};
    const shareReady = !!(share.enabled !== false && share.token && share.path);

    // load 刷新不得与在途卷轴动画竞态：先清 timer（不动盘面），再整体落状态
    this.clearGridTimer(false);
    this.setData({
      loading: false,
      enabled,
      sfxEnabled: data.sfxEnabled !== false,
      coinName,
      coin: {
        name: coinName,
        iconUrl: coin.iconUrl || '',
        balance: coin.balance || 0,
        earnedToday: coin.earnedToday || 0,
        spentToday: coin.spentToday || 0,
        gameEarnedToday: coin.gameEarnedToday || 0,
        dailyGameCap: coin.dailyGameCap || 0,
        gameCapLeft: coin.gameCapLeft == null ? -1 : coin.gameCapLeft,
        gameCapReached: !!coin.gameCapReached,
      },
      coinLine: buildCoinLine({ ...coin, name: coinName }),
      coinCapPercent: buildCoinCapPercent(coin),
      sectors: buildSectorViews(sectorList, prizes, coinName),
      wheel: {
        enabled: wheel.enabled !== false,
        cost: wheel.cost || 0,
        remaining,
        unlimited: !!wheel.unlimited,
        total: wheel.total || 0,
        used: wheel.used || 0,
        maxPerDay: wheel.maxPerDay || 0,
        canPlay: enabled && wheel.enabled !== false && remaining > 0,
        pity: {
          after: wheelPity.after || 0,
          losses: wheelPity.losses || 0,
          remaining: wheelPity.remaining == null ? 0 : wheelPity.remaining,
          ready: !!wheelPity.ready,
          text: wheelPity.text || '',
        },
      },
      // 转盘被关掉时默认切到九宫格（否则用户一进来看到的是不可玩页面）
      mode: wheel.enabled === false && grid.enabled !== false ? 'grid' : this.data.mode,
      centerMain: center.main,
      centerSub: center.sub,
      recent: Array.isArray(data.recent) ? data.recent : [],
      grid: {
        enabled: grid.enabled !== false,
        cost: grid.cost || 0,
        canPlay: !!grid.canPlay,
        playsToday: grid.playsToday || 0,
        maxPerDay: grid.maxPerDay || 0,
        symbols: grid.symbols || [],
        outcomes: grid.outcomes || [],
        pity: {
          after: gridPity.after || 0,
          losses: gridPity.losses || 0,
          remaining: gridPity.remaining == null ? 0 : gridPity.remaining,
          ready: !!gridPity.ready,
          text: gridPity.text || '',
        },
        cells: this.data.grid.cells && this.data.grid.cells.some((c) => !c.empty) ? this.data.grid.cells : emptyGridCells(),
        lines: this.data.grid.lines || [],
        revealing: false,
        revealCount: 0,
        reels: [],
        phase: 'idle',
        resultText: this.data.grid.resultText || '点「开一局」看连线结果',
        lastResult: this.data.grid.lastResult || null,
      },
      gridOddsText: buildGridOddsText(grid.symbols || [], coinName),
      video: {
        enabled: video.enabled !== false,
        coinPerWatch: video.coinPerWatch || 0,
        count: video.count || 0,
        remaining: video.remaining == null ? 0 : video.remaining,
        dailyLimit: video.dailyLimit || 0,
        adUnitId: video.adUnitId || '',
      },
      share: {
        enabled: share.enabled !== false,
        coinPerClick: share.coinPerClick || 0,
        dailyLimit: share.dailyLimit || 0,
        rewardedToday: share.rewardedToday || 0,
        clicksToday: share.clicksToday || 0,
        remaining: share.remaining == null ? -1 : share.remaining,
        token: share.token || '',
        path: share.path || '',
        ready: shareReady,
      },
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
      oddsText: buildOddsText(prizes, coinName),
      rarityText: data.rarityText || '',
      adUnitId: video.adUnitId || '',
    });
  },

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
    if (len < 2) return;
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

  // 响应里的余额/次数/保底同步到 data（转盘与九宫格共用）
  applyCounters(res) {
    if (!res) return;
    const patch = {};
    if (res.coin) {
      const coin = res.coin;
      patch.coin = {
        name: coin.name || this.data.coinName,
        iconUrl: coin.iconUrl || this.data.coin.iconUrl || '',
        balance: coin.balance || 0,
        earnedToday: coin.earnedToday || 0,
        spentToday: coin.spentToday || 0,
        gameEarnedToday: coin.gameEarnedToday || 0,
        dailyGameCap: coin.dailyGameCap || 0,
        gameCapLeft: coin.gameCapLeft == null ? -1 : coin.gameCapLeft,
        gameCapReached: !!coin.gameCapReached,
      };
      patch.coinName = coin.name || this.data.coinName;
      patch.coinLine = buildCoinLine({ ...coin, name: coin.name || this.data.coinName });
      patch.coinCapPercent = buildCoinCapPercent(coin);
    } else if (res.balance !== undefined) {
      patch['coin.balance'] = res.balance;
    }
    if (res.remaining !== undefined) {
      patch['wheel.remaining'] = res.remaining;
      patch['wheel.unlimited'] = !!res.unlimited;
      patch['wheel.total'] = res.total || 0;
      patch['wheel.used'] = res.used || 0;
      patch['wheel.maxPerDay'] = res.maxPerDay || 0;
      patch['wheel.canPlay'] = this.data.enabled && this.data.wheel.enabled && this.data.wheel.cost > 0 && res.remaining > 0;
    }
    // 九宫格可玩性跟着余额/局数走
    const balance = patch.coin ? patch.coin.balance : (res.balance !== undefined ? res.balance : this.data.coin.balance);
    patch['grid.canPlay'] = this.data.enabled && this.data.grid.enabled
      && balance >= this.data.grid.cost
      && (!this.data.grid.maxPerDay || (this.data.grid.playsToday || 0) < this.data.grid.maxPerDay);
    if (Object.keys(patch).length) this.setData(patch);
    if (patch['wheel.remaining'] !== undefined || patch.coin) {
      const center = buildCenterState({
        enabled: this.data.enabled,
        remaining: patch['wheel.remaining'] !== undefined ? patch['wheel.remaining'] : this.data.wheel.remaining,
        spinning: !!this.data.spinning,
        cost: this.data.wheel.cost,
        coinName: this.data.coinName,
      });
      this.setData({ centerMain: center.main, centerSub: center.sub });
    }
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

  switchMode(e) {
    const mode = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.mode) || 'wheel';
    if (mode === 'grid' && !this.data.grid.enabled) return;
    if (mode === 'wheel' && !this.data.wheel.enabled) return;
    if (this.data.spinning || this.data.grid.revealing) return;
    this.setData({ mode, leverPulled: false });
  },

  // ===== 转盘抽奖 =====
  async draw() {
    if (this._busy || this.data.spinning) return;
    if (this.data.blocked) return;
    if (!this.data.enabled) {
      wx.showToast({ title: '活动暂未开启', icon: 'none' });
      return;
    }
    if (!this.data.wheel.enabled) {
      wx.showToast({ title: '转盘暂未开放', icon: 'none' });
      return;
    }
    if (this.data.coin.balance < this.data.wheel.cost) {
      wx.showToast({ title: `${this.data.coinName}不足，去做任务赚铜版吧`, icon: 'none' });
      this.scrollToTasks();
      return;
    }
    if (this.data.wheel.remaining <= 0) {
      wx.showToast({ title: '今日转盘次数已用完，明天再来', icon: 'none' });
      return;
    }
    if (this.data.sfxEnabled) {
      sfx.prewarm && sfx.prewarm();
      sfx.play('spin');
    }

    this._busy = true;
    const spinCenter = buildCenterState({
      enabled: true,
      remaining: this.data.wheel.remaining,
      spinning: true,
      cost: this.data.wheel.cost,
      coinName: this.data.coinName,
    });
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
      const center = buildCenterState({
        enabled: this.data.enabled,
        remaining: this.data.wheel.remaining,
        spinning: false,
        cost: this.data.wheel.cost,
        coinName: this.data.coinName,
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

  applyDrawResult(result) {
    const p = result.prize || {};
    const rarity = result.rarity || 'normal';
    const prizeText =
      p.type === 'coin'
        ? `抽到 ${p.label || p.amount + ' ' + this.data.coinName}`
        : p.type === 'steps'
          ? `抽到 ${p.label || p.amount + ' 步'}`
          : p.type === 'draw'
            ? '本局免费，铜版已返还'
            : result.capped
              ? '谢谢参与（今日步数奖励已达上限）'
              : result.coinCapped
                ? '谢谢参与（今日游戏铜版奖励已达上限）'
                : '谢谢参与';
    const icon = p.type === 'none' ? 'info-circle' : p.type === 'draw' ? 'refresh' : 'check-circle';
    const color = p.type === 'none' ? 'var(--tt-text-3)' : 'var(--tt-brand)';

    this.setData({
      lastPrize: {
        key: p.key || '',
        type: p.type || 'none',
        amount: p.amount || 0,
        label: p.label || '',
        game: 'wheel',
        capped: !!result.capped,
        coinCapped: !!result.coinCapped,
        pity: !!result.pity,
        text: prizeText,
        icon,
        color,
      },
    });
    this.applyCounters(result);
    if (result.earned) this.setData({ earned: result.earned, earnedLine: buildEarnedLine(result.earned) });
    this.updatePity('wheel', p.type === 'none');
    this.playFx(p.type === 'none' ? 'none' : rarity, p, result.capped);
    if (p.type !== 'none') this.prependSelfToFeed(p, { game: 'wheel', capped: result.capped, pity: result.pity });
    this.loadRecent();
  },

  // 本地先更新保底进度；loadRecent 再以服务端为准校正
  updatePity(game, isNone) {
    const key = game === 'wheel' ? 'wheel' : 'grid';
    const pity = this.data[key].pity || {};
    const after = pity.after || 0;
    if (!after) return;
    const losses = isNone ? (pity.losses || 0) + 1 : 0;
    this.setData({
      [`${key}.pity.losses`]: losses,
      [`${key}.pity.remaining`]: Math.max(0, after - losses),
      [`${key}.pity.ready`]: losses >= after,
      [`${key}.pity.text`]: losses >= after ? '保底已就绪：下一局必中' : `再抽 ${Math.max(0, after - losses)} 次必中保底`,
    });
  },

  playFx(rarity, prize, capped) {
    const kind = rarity === 'none' ? 'none' : rarity === 'rarest' ? 'rarest' : rarity === 'rare' ? 'rare' : 'normal';
    this.clearFxTimers();
    const audio = this.data.sfxEnabled !== false;
    // 系统减弱动效：粒子连 DOM 都不生成，静态出卡（CSS reduce 块双保险）
    const lite = !!this._reducedMotion;

    if (kind === 'none') {
      if (audio) sfx.play('none');
      sfx.vibrate('none');
      this.setData({ fx: 'normal', fxRarity: 'normal', confetti: [], coinRain: [], fxRays: [], fxSparks: [], fxShake: '', fxAmountText: '', fxAmountUnit: '' });
      this._fxTimer = setTimeout(() => {
        if (!this._unloaded) this.setData({ fx: '', confetti: [], coinRain: [], fxRays: [], fxSparks: [], fxShake: '', fxAmountText: '', fxAmountUnit: '' });
      }, FX_MS.normal);
      return;
    }

    // 全档炸裂（用户 2026-11-25）：normal/rare/rarest 都有粒子爆发，逐档递进；none 克制。
    // 震屏只挂 .bd-fx 自身（fixed 祖先加 transform 会改 containing block 使弹层错位）。
    const fxShake = lite ? '' : kind === 'rarest' ? 'lg' : kind === 'rare' ? 'md' : 'sm';
    // 彩带：两段式爆发（中心炸开再飘落），8 色 × 3 形状 × 8 方向，确定性编排零随机
    const confetti =
      !lite
        ? Array.from({ length: kind === 'rarest' ? 20 : kind === 'rare' ? 14 : 10 }, (_, i) => ({
            k: i,
            dir: i % 8,
            tone: (i % 8) + 1,
            shape: i % 3,
            delay: (i % 5) * (kind === 'rarest' ? 70 : kind === 'rare' ? 80 : 90),
            dur: (kind === 'rarest' ? 1500 : kind === 'rare' ? 1200 : 1000) + (i % 4) * (kind === 'rarest' ? 180 : kind === 'rare' ? 160 : 150),
          }))
        : [];
    // 金币雨：rarest delay 对齐音效金币尾音（≈740ms 起）；normal/rare 收束在各自 FX_MS 内
    const coinRain =
      !lite
        ? Array.from({ length: kind === 'rarest' ? 14 : kind === 'rare' ? 8 : 5 }, (_, i) => ({
            k: i,
            left: kind === 'rarest' ? 4 + i * 7 : 8 + i * Math.floor(84 / ((kind === 'rare' ? 8 : 5) - 1)),
            delay: kind === 'rarest' ? 500 + (i % 7) * 140 : kind === 'rare' ? 400 + (i % 5) * 120 : 350 + (i % 4) * 110,
            dur: kind === 'rarest' ? 1700 + (i % 4) * 260 : kind === 'rare' ? 1400 + (i % 3) * 200 : 1200 + (i % 3) * 180,
            size: 44 + (i % 3) * 14,
          }))
        : [];
    const fxRays = kind === 'rarest' && !lite ? Array.from({ length: 16 }, (_, i) => ({ k: i, deg: i * 22.5 })) : [];
    // 星光 ✦/✧：确定性环布（非随机），金/白/青三色轮换
    const fxSparks =
      !lite
        ? Array.from({ length: kind === 'rarest' ? 8 : kind === 'rare' ? 6 : 4 }, (_, i) => {
            const a = ((i * 45 + 22.5) * Math.PI) / 180;
            return {
              k: i,
              x: +(50 + 40 * Math.cos(a)).toFixed(1),
              y: +(46 + 32 * Math.sin(a)).toFixed(1),
              delay: (i % 4) * 180,
              dur: 900 + (i % 3) * 220,
              tone: (i % 3) + 1,
              ch: i % 2 ? '✧' : '✦',
            };
          })
        : [];
    const p = prize || {};
    let fxAmountText = '';
    let fxAmountUnit = '';
    if (!capped) {
      if (p.type === 'coin' && p.amount > 0) {
        fxAmountText = `+${p.amount}`;
        fxAmountUnit = this.data.coinName;
      } else if (p.type === 'steps' && p.amount > 0) {
        fxAmountText = `+${p.amount}`;
        fxAmountUnit = '步';
      } else if (p.type === 'draw') {
        fxAmountText = '返还';
      }
    }
    this.setData({ fx: kind, fxRarity: kind, confetti, coinRain, fxRays, fxSparks, fxShake, fxAmountText, fxAmountUnit });
    if (audio) sfx.play(kind);
    sfx.vibrate(kind);
    this._fxTimer = setTimeout(() => {
      if (!this._unloaded) this.setData({ fx: '', confetti: [], coinRain: [], fxRays: [], fxSparks: [], fxShake: '', fxAmountText: '', fxAmountUnit: '' });
    }, FX_MS[kind] || FX_MS.normal);
  },

  clearFxTimers() {
    if (this._fxTimer) {
      clearTimeout(this._fxTimer);
      this._fxTimer = null;
    }
  },

  restoreCenter() {
    const center = buildCenterState({
      enabled: this.data.enabled,
      remaining: this.data.wheel.remaining,
      spinning: false,
      cost: this.data.wheel.cost,
      coinName: this.data.coinName,
    });
    this.setData({ spinning: false, centerMain: center.main, centerSub: center.sub });
  },

  closeFx() {
    this.clearFxTimers();
    if (!this._unloaded) this.setData({ fx: '', confetti: [], coinRain: [], fxRays: [], fxSparks: [], fxShake: '', fxAmountText: '', fxAmountUnit: '' });
  },

  prependSelfToFeed(prize, extra = {}) {
    const me = getApp().globalData && getApp().globalData.userInfo;
    const nameMasked = myMaskedName(me);
    const game = extra.game || 'wheel';
    const label = prize.label
      || (prize.type === 'coin' ? `${prize.amount} ${this.data.coinName}` : prize.type === 'steps' ? `${prize.amount} 步` : '');
    const item = {
      nameMasked,
      prizeKey: prize.key,
      prizeLabel: label,
      prizeType: prize.type,
      game,
      amount: prize.amount || 0,
      rarity: extra.rarity || 'normal',
      atText: '刚刚',
      isMine: true,
      capped: !!extra.capped,
      pity: !!extra.pity,
      linesText: extra.linesText || '',
    };
    const list = [item].concat(this.data.feed || []).slice(0, 20);
    this.setData({ feed: list, feedIndex: 0 });
    this.startFeed();
  },

  async loadRecent() {
    try {
      const data = await auth.get('/api/beidou/today');
      if (!data) return;
      const patch = {};
      if (data.recent) patch.recent = data.recent;
      if (data.earned) {
        patch.earned = data.earned;
        patch.earnedLine = buildEarnedLine(data.earned);
      }
      if (data.coin) {
        patch.coin = {
          name: data.coin.name || this.data.coinName,
          iconUrl: data.coin.iconUrl || this.data.coin.iconUrl || '',
          balance: data.coin.balance || 0,
          earnedToday: data.coin.earnedToday || 0,
          spentToday: data.coin.spentToday || 0,
          gameEarnedToday: data.coin.gameEarnedToday || 0,
          dailyGameCap: data.coin.dailyGameCap || 0,
          gameCapLeft: data.coin.gameCapLeft == null ? -1 : data.coin.gameCapLeft,
          gameCapReached: !!data.coin.gameCapReached,
        };
        patch.coinLine = buildCoinLine({ ...data.coin, name: data.coin.name || this.data.coinName });
        patch.coinCapPercent = buildCoinCapPercent(data.coin);
      }
      if (data.draw) {
        patch['wheel.remaining'] = data.draw.remaining || 0;
        patch['wheel.canPlay'] = this.data.enabled && (data.draw.remaining || 0) > 0;
        if (data.draw.pity) patch['wheel.pity'] = data.draw.pity;
      }
      if (data.grid) {
        patch['grid.canPlay'] = !!data.grid.canPlay;
        patch['grid.playsToday'] = data.grid.playsToday || 0;
        if (data.grid.pity) patch['grid.pity'] = data.grid.pity;
      }
      if (data.cap) {
        const cap = data.cap;
        patch.cap = { cap: cap.cap || 0, used: cap.used || 0, left: cap.left || 0, capped: !!cap.capped };
        patch.capText =
          cap.cap > 0 && cap.capped
            ? `今日步数奖励已达上限（${cap.cap} 步），明天再来`
            : cap.cap > 0
              ? `今日步数奖励还剩 ${cap.left} 步额度`
              : '';
      }
      if (data.video) patch.video = data.video;
      if (data.share) patch.share = { ...data.share, ready: !!(data.share.token && data.share.path) };
      if (data.checkin) {
        const coinName = (data.coin && data.coin.name) || this.data.coinName;
        const cells = buildCheckinCells(data.checkin, coinName);
        const todayCell = cells.find((c) => c.isToday) || cells[Math.min((data.checkin.streak || 0), cells.length - 1)];
        patch.checkin = {
          enabled: data.checkin.enabled !== false,
          done: !!data.checkin.done,
          streak: data.checkin.streak || 0,
          cells,
          todayRewardText: todayCell ? todayCell.rewardText : '',
        };
      }
      if (Object.keys(patch).length) this.setData(patch);
    } catch (e) {
      /* 拉不到不影响主流程 */
    }
  },

  // ===== 九宫格 =====
  async playGrid() {
    if (this._gridBusy || this.data.grid.revealing) return;
    if (this.data.blocked) return;
    if (!this.data.enabled || !this.data.grid.enabled) {
      wx.showToast({ title: '九宫格暂未开放', icon: 'none' });
      return;
    }
    if (this.data.coin.balance < this.data.grid.cost) {
      wx.showToast({ title: `${this.data.coinName}不足，去做任务赚铜版吧`, icon: 'none' });
      this.scrollToTasks();
      return;
    }
    if (!this.data.grid.canPlay) {
      wx.showToast({ title: '今日九宫格次数已用完', icon: 'none' });
      return;
    }
    if (this.data.sfxEnabled) {
      sfx.prewarm && sfx.prewarm();
      sfx.play('spin');
    }

    this._gridBusy = true;
    this.setData({
      'grid.revealing': true,
      'grid.cells': emptyGridCells(),
      'grid.lines': [],
      'grid.revealCount': 0,
      'grid.reels': [],
      'grid.phase': 'spinning',
      'grid.resultText': '开奖中…',
      lastPrize: null,
      fx: '',
    });
    try {
      const result = await auth.post('/api/beidou/grid/play', { playId: makeNonce('gr') });
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.message) || '开奖失败', icon: 'none' });
        this.setData({ 'grid.revealing': false, 'grid.reels': [], 'grid.phase': 'idle', 'grid.resultText': '点「开一局」看连线结果' });
        this.load();
        return;
      }
      this.applyGridResult(result);
    } catch (e) {
      this.setData({ 'grid.revealing': false, 'grid.reels': [], 'grid.phase': 'idle', 'grid.resultText': '点「开一局」看连线结果' });
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
      this._gridBusy = false;
    }
  },

  applyGridResult(result) {
    const board = (result.board || []).map((cell, index) => ({
      index,
      empty: false,
      revealed: false,
      win: false,
      symbolKey: cell.symbolKey || '',
      icon: cell.icon || '?',
      iconUrl: cell.iconUrl || '',
      label: cell.label || '',
      type: cell.type || 'none',
      amount: cell.amount || 0,
    }));
    const lines = result.lines || [];
    const winSet = new Set();
    for (const line of lines) for (const i of line.cells || []) winSet.add(i);
    const prize = result.prize || {};
    const resultText = buildGridResultText(result, this.data.coinName);

    this.clearGridTimer(false);
    this._gridPending = { winSet, result, resultText };
    this._gridStopDone = [false, false, false];
    const reels = this._reducedMotion ? [] : buildReels(board, this.data.grid.symbols);

    this.setData({
      'grid.cells': board,
      'grid.lines': lines,
      'grid.revealCount': 0,
      'grid.revealing': true,
      'grid.reels': reels,
      'grid.phase': 'spinning',
      'grid.resultText': '开奖中…',
      'grid.lastResult': result,
      lastPrize: {
        key: prize.key || '',
        type: prize.type || 'none',
        amount: prize.amount || 0,
        label: prize.label || '',
        game: 'grid',
        lines: prize.lines || lines.length,
        capped: !!result.capped,
        coinCapped: !!result.coinCapped,
        pity: !!result.pity,
        text: resultText,
        icon: prize.type === 'none' ? 'info-circle' : 'check-circle',
        color: prize.type === 'none' ? 'var(--tt-text-3)' : 'var(--tt-brand)',
      },
    });

    // 减弱动效：跳过卷轴，直接终态（按钮立即恢复）
    if (this._reducedMotion) {
      const patch = {};
      board.forEach((c, i) => { patch[`grid.cells[${i}].revealed`] = true; });
      this.setData(patch);
      this.finishGridReveal(winSet, result, resultText);
      return;
    }

    // 两拍启动：strip 是新挂载节点，挂载时就带目标 transform 不会发生过渡。
    // 第一拍装带（offset 0），60ms 后第二拍滚到目标偏移；停轴完成由兜底 timer 权威驱动
    // （transitionend 只是提前量，vm 桩/部分 iOS WebView 不触发它）。
    const startTimer = setTimeout(() => {
      if (this._unloaded) return;
      const patch = {};
      for (let c = 0; c < reels.length; c += 1) {
        patch[`grid.reels[${c}].offsetRpx`] = (reels[c].frames.length - 3) * REEL_FRAME_RPX;
        this._gridTimers.push(setTimeout(() => this.stopColumn(c), REEL_STOP_MS[c] + REEL_STOP_BUFFER_MS));
      }
      this.setData(patch);
    }, REEL_START_DELAY_MS);
    this._gridTimers.push(startTimer);
  },

  // 某列停轴 = 该列 3 格 revealed；三列齐停才按服务端 lines 置 win（finishGridReveal）
  stopColumn(col) {
    if (this._unloaded) return;
    if (!this._gridStopDone || this._gridStopDone[col]) return;
    if (!this.data.grid.revealing || !this.data.grid.reels.length) return;
    this._gridStopDone[col] = true;
    const patch = {
      [`grid.reels[${col}].stopped`]: true,
      'grid.phase': 'settling',
      'grid.revealCount': (this.data.grid.revealCount || 0) + 1,
    };
    for (let r = 0; r < 3; r += 1) patch[`grid.cells[${col + r * 3}].revealed`] = true;
    this.setData(patch);
    if (this.data.sfxEnabled) sfx.play('spin');
    if (this._gridStopDone.every(Boolean)) {
      const p = this._gridPending || {};
      this.finishGridReveal(p.winSet || new Set(), p.result || this.data.grid.lastResult || {}, p.resultText || '');
    }
  },

  onReelTransitionEnd(e) {
    if (!e || !e.detail || e.detail.propertyName !== 'transform') return;
    const col = Number(e.currentTarget && e.currentTarget.dataset.col);
    if (Number.isFinite(col)) this.stopColumn(col);
  },

  // 卷轴装饰帧图标加载失败：清掉该帧 iconUrl 回退 emoji；带 boardIndex 的同步清静态格（不再重试坏图）
  onReelIconError(e) {
    const col = Number(e.currentTarget.dataset.col);
    const fidx = Number(e.currentTarget.dataset.fidx);
    if (!Number.isFinite(col) || !Number.isFinite(fidx)) return;
    const reel = this.data.grid.reels[col];
    const frame = reel && reel.frames[fidx];
    if (!frame || !frame.iconUrl) return;
    const patch = { [`grid.reels[${col}].frames[${fidx}].iconUrl`]: '' };
    if (frame.boardIndex >= 0) patch[`grid.cells[${frame.boardIndex}].iconUrl`] = '';
    this.setData(patch);
  },

  // 上传图标加载失败：清掉该格 iconUrl，回退 emoji（不影响发奖）
  onCellIconError(e) {
    const index = Number(e.currentTarget.dataset.index);
    if (!Number.isFinite(index)) return;
    this.setData({ [`grid.cells[${index}].iconUrl`]: '' });
  },

  onCoinIconError() {
    // 金币雨 14 张图共用此 handler：首张失败清掉 iconUrl 后，其余直接跳过（幂等）
    if (!this.data.coin.iconUrl) return;
    this.setData({ 'coin.iconUrl': '' });
  },

  finishGridReveal(winSet, result, resultText) {
    this.clearGridTimer(false);
    const patch = {
      'grid.revealing': false,
      'grid.reels': [],
      'grid.phase': 'done',
      'grid.resultText': resultText,
    };
    for (const i of winSet) patch[`grid.cells[${i}].win`] = true;
    this.setData(patch);
    this.applyCounters(result);
    if (result.earned) this.setData({ earned: result.earned, earnedLine: buildEarnedLine(result.earned) });
    const prize = result.prize || {};
    this.updatePity('grid', prize.type === 'none');
    this.playFx(prize.type === 'none' ? 'none' : result.rarity || 'normal', prize, result.capped);
    if (prize.type !== 'none') {
      this.prependSelfToFeed(prize, {
        game: 'grid',
        capped: result.capped,
        pity: result.pity,
        linesText: (result.lines || []).map((l) => l.label).join(' + '),
      });
    }
    this.loadRecent();
  },

  // 页面隐藏时直接展示最终盘面（不残留「开奖中」与半滚动画）
  clearGridTimer(revealAll) {
    (this._gridTimers || []).forEach((t) => clearTimeout(t));
    this._gridTimers = [];
    this._gridStopDone = [false, false, false];
    this._gridPending = null;
    if (!revealAll || !this.data.grid.revealing) return;
    const last = this.data.grid.lastResult;
    const patch = {
      'grid.revealing': false,
      'grid.reels': [],
      'grid.phase': 'done',
      'grid.resultText': last
        ? buildGridResultText(last, this.data.coinName)
        : '点「开一局」看连线结果',
    };
    if (last && Array.isArray(last.lines)) {
      for (const line of last.lines) for (const i of line.cells || []) patch[`grid.cells[${i}].win`] = true;
    }
    (this.data.grid.cells || []).forEach((c, i) => {
      if (!c.revealed) patch[`grid.cells[${i}].revealed`] = true;
    });
    this.setData(patch);
  },

  // ===== 看视频 =====
  async watch() {
    if (this._watching) return;
    if (this.data.blocked) return;
    if (!this.data.enabled || !this.data.video.enabled) {
      wx.showToast({ title: '看视频暂未开放', icon: 'none' });
      return;
    }
    const v = this.data.video || {};
    if (!v.coinPerWatch) {
      wx.showToast({ title: '看视频暂不发放奖励', icon: 'none' });
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
        console.warn('[beidou] 广告展示失败（本次不计奖励）', err);
        wx.showToast({ title: '广告暂时无法播放，稍后再试', icon: 'none' });
        return;
      }
      const ended = await waiter;
      if (!ended) return;
      const result = await auth.post('/api/beidou/video/report', { watchId: makeNonce('vd') });
      if (result && result.success) {
        wx.showToast({ title: `+${result.gainedCoin || 0} ${this.data.coinName}`, icon: 'success' });
        this.load();
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
    if (!this.data.enabled || !this.data.checkin.enabled) {
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
        const coin = (result.award && result.award.coin) || result.gainedCoin || 0;
        wx.showToast({ title: coin ? `签到成功 +${coin} ${this.data.coinName}` : '签到成功', icon: 'none' });
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
      sfx.reset && sfx.reset();
      sfx.prewarm && sfx.prewarm();
      if (this.data.sfxEnabled !== false) sfx.play('normal');
    }
    wx.showToast({ title: next ? '已关闭音效' : '已开启音效', icon: 'none' });
  },

  tapCenter() {
    if (this.data.spinning) return;
    if (this.data.enabled === false) {
      wx.showToast({ title: '活动暂未开启', icon: 'none' });
      return;
    }
    if (!this.data.wheel.enabled) {
      wx.showToast({ title: '转盘暂未开放', icon: 'none' });
      return;
    }
    if (this.data.coin.balance < this.data.wheel.cost || this.data.wheel.remaining <= 0) {
      this.scrollToTasks();
      return;
    }
    this.draw();
  },

  toggleRules() {
    this.setData({ showRules: !this.data.showRules });
  },

  noop() {},

  scrollToTasks() {
    if (wx.pageScrollTo) wx.pageScrollTo({ selector: '#tasks', duration: 240 });
  },

  scrollToRules() {
    if (!this.data.showRules) this.setData({ showRules: true });
    if (wx.pageScrollTo) wx.pageScrollTo({ selector: '#rules', duration: 240 });
  },
});

// ===== 纯函数（页面外用，便于运行时自检直接调用）=====

function buildCoinLine(coin) {
  const c = coin || {};
  const name = c.name || '铜版';
  const parts = [`余额 ${c.balance || 0} ${name}`];
  if (c.earnedToday) parts.push(`今日已得 ${c.earnedToday}`);
  if (c.spentToday) parts.push(`已花 ${c.spentToday}`);
  return parts.join(' · ');
}

// 钱包产出进度条（纯展示；封顶判定仍由服务端 gameCapReached 决定）
function buildCoinCapPercent(coin) {
  const c = coin || {};
  const cap = c.dailyGameCap || 0;
  if (cap <= 0) return 0;
  return Math.min(100, Math.round(((c.gameEarnedToday || 0) / cap) * 100));
}

function buildGridResultText(result, coinName) {
  const prize = (result && result.prize) || {};
  const lines = (result && result.lines) || [];
  if (result && result.rewardText) return result.rewardText;
  if (prize.type === 'none') {
    if (lines.length) return '连线达成，但今日奖励已达上限';
    return '没有连线，再试一局';
  }
  const rewards = (result && result.rewards) || [];
  if (rewards.length) {
    return rewards
      .map((r) => {
        const unit = r.type === 'coin' ? (coinName || '铜版') : '步';
        return `${r.label} ${r.lines} 线 · +${r.amount} ${unit}`;
      })
      .join('；');
  }
  const label = prize.label || '';
  if (prize.type === 'coin') return `${label} · +${prize.amount || 0} ${coinName || '铜版'}`;
  if (prize.type === 'steps') return `${label} · +${prize.amount || 0} 步`;
  return label || '中奖';
}
