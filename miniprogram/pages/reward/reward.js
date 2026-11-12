const auth = require('../../utils/request');
const fmt = require('../../utils/format');

/**
 * ===== 北斗运动 2.0：签到 + 转盘抽步数 + 看视频得次数 + 分享得次数 =====
 *
 * 方案与口径见 docs/beidou-lottery-plan.md。三条不能破的约定：
 *   ① 抽奖结果**只由服务端定**：服务端下发 index，前端只负责把第 index 个扇区转到指针下；
 *      扇区顺序也来自服务端（sectors），前端**绝不自己排**（否则停位与结果对不上）；
 *   ② 看视频/分享只加抽奖次数，**不再直发步数**（旧上报接口已降级）；
 *   ③ 教师账号进不来（三道拦截沿用一版，见下方注释）。
 */

// 默认激励视频广告位 ID（服务端 beidou.video.adUnitId 留空时用这个）
const DEFAULT_AD_UNIT_ID = 'adunit-a80731a737d255c9';

// ===== 教师拦截（本页入口只对学生开放）=====
// 北斗运动写的是 run_records，教师账号不参与运动记录，所以教师「进不去」本页：
//   · 入口：pages/profile 的「累计数据」连点 5 次 → 教师直接 toast，不 navigateTo
//   · 本页：onLoad（用本地缓存的角色，首帧就拦）+ onShow（接口确认后再拦一次）
//   · 拦截后 blocked=true → WXML 整块不渲染（不闪内容、无按钮、无广告节点）
const TEACHER_BLOCK_TITLE = '教师账号不参与运动记录';
const TEACHER_BLOCK_SUB = '北斗运动仅对学生开放，教师账号不能领取步数奖励。';
const TEACHER_TOAST = '教师账号不参与运动记录';

// 转盘动画：圈数与每格度数（8 格 = 45°）
const SPIN_ROUNDS = 5;
const SECTOR_COUNT = 8;
const DEG_PER_SECTOR = 360 / SECTOR_COUNT;

function cachedRole() {
  try {
    const u = auth.getUser();
    return (u && u.role) || '';
  } catch (e) {
    return '';
  }
}

// ===== 激励视频实例：模块级全局单例（沿用一版实现，回调只注册一次）=====
let videoAd = null;
let videoAdUnitId = '';
let videoAdReady = false;
let closeWaiter = null;

function ensureVideoAd(adUnitId) {
  const id = adUnitId || DEFAULT_AD_UNIT_ID;
  if (videoAd && videoAdUnitId === id) return videoAd;
  if (videoAd && videoAd.destroy) videoAd.destroy(); // 只有广告位变了才重建
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
    // 只有「完整看完」才计次；提前关闭或回调不带 isEnded 一律不计
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

// ===== 插屏广告（沿用一版：进页面首屏加载完展示 1 次，会话最多 3 次）=====
const INTERSTITIAL_AD_UNIT_ID = 'adunit-773c53ab76db1155';
const INTERSTITIAL_SESSION_MAX = 3;
let interstitialAd = null;
let interstitialShowCount = 0;
let adPage = null;

function emitAdEvent(name, payload) {
  try {
    if (adPage && typeof adPage[name] === 'function') adPage[name](payload);
  } catch (e) {
    /* 记日志失败也不能影响业务 */
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
      console.warn('[beidou] 插屏广告显示失败（已静默，不影响页面）', err);
    });
}

// 客户端生成的幂等凭据（弱网重试/连点重复提交时服务端只算一次）
function makeNonce(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// 扇区视觉：把服务端下发的 prizeKey 展开成 8 个格子的**渲染数据**。
// ⚠️ 只做渲染，不做任何排序/去重 —— sectors 的顺序就是服务端抽奖时用的顺序。
//
// 角度约定（必须与 CSS 和 spinTo() 三者一致，任一处错位就会「停在 A 却发 B」）：
//   · 扇区 i 覆盖 [i*45°, (i+1)*45°)，第 0 格从正上方（12 点）开始顺时针排；
//   · CSS 的 conic-gradient 也是从 12 点开始顺时针，所以两者天然对齐；
//   · spinTo 把「第 index 格的中心」即 (index*45 + 22.5)° 转到指针（0°）位置。
function buildSectorViews(sectors, prizes) {
  const byKey = new Map((prizes || []).map((p) => [p.key, p]));
  return (sectors || []).map((key, i) => {
    const p = byKey.get(key) || { key, label: key, type: 'none', amount: 0 };
    return {
      key: `${key}-${i}`, // wx:key 必须唯一（同一 prizeKey 可能出现在多个扇区）
      prizeKey: key,
      label: p.label || key,
      type: p.type,
      amount: p.amount || 0,
      startDeg: i * DEG_PER_SECTOR, // 扇区起始边（画分割线用）
      centerDeg: i * DEG_PER_SECTOR + DEG_PER_SECTOR / 2, // 扇区中心（放标签、也是停位目标）
    };
  });
}

// 扇区底色（与 .is-steps/.is-draw/.is-none 的浅色系保持一致，但这里需要具体色值画 conic-gradient）
const SECTOR_FILL = {
  steps: '#ffe4cc',
  draw: '#fff0c2',
  none: '#eff1f5',
};

// 生成 conic-gradient：每 45° 一段，按 sectors 顺序上色
function buildWheelBg(sectors, prizes) {
  const byKey = new Map((prizes || []).map((p) => [p.key, p]));
  const stops = [];
  (sectors || []).forEach((key, i) => {
    const p = byKey.get(key) || { type: 'none' };
    const color = SECTOR_FILL[p.type] || SECTOR_FILL.none;
    const from = i * DEG_PER_SECTOR;
    const to = (i + 1) * DEG_PER_SECTOR;
    stops.push(`${color} ${from}deg ${to}deg`);
  });
  if (!stops.length) return '#eff1f5';
  return `conic-gradient(from 0deg, ${stops.join(', ')})`;
}

// 概率公示文案：百分比由服务端算好下发，前端只拼字符串（自己算会与配置漂移）
function buildOddsText(prizes) {
  if (!prizes || !prizes.length) return '';
  return prizes.map((p) => `${p.label} ${p.percent}%`).join(' · ');
}

// 签到 7 天格子：把「已签/今天/未来」状态画出来
function buildCheckinCells(checkin) {
  const ms = (checkin && checkin.milestones) || [];
  const streak = (checkin && checkin.streak) || 0;
  const done = !!(checkin && checkin.done);
  const todayIdx = checkin && checkin.todayIndex;
  return ms.map((m, i) => {
    const dayNo = i + 1;
    // 已签 = 连续天数已经覆盖到这一天。
    //   · 今天已签：streak 已含今天 → 第 1..streak 天全部打勾
    //   · 今天未签：streak 是「昨天为止」的连续天数 → 第 1..streak 天打勾，第 streak+1 天是今天
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
    };
  });
}

Page({
  data: {
    loading: true,
    blocked: false,
    enabled: true,

    // 转盘
    sectors: [], // 8 格渲染数据（startDeg / centerDeg / type / label）
    wheelBg: '', // conic-gradient 背景（按服务端 sectors 顺序上色）
    rotateDeg: 0, // 转盘旋转角度（只影响观感）
    spinning: false,
    lastPrize: null, // 本次中奖结果（服务端下发）
    recent: [], // 最近 5 条中奖记录

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

    // 封顶（必须在抽到空奖**之前**就告诉用户）
    cap: { cap: 0, used: 0, left: 0, capped: false },
    capText: '',

    // 今日已入账四项
    earned: { steps: 0, distance: 0, calories: 0, durationSeconds: 0 },
    earnedStepsText: '0',
    earnedDistanceText: '0 m',
    earnedCaloriesText: '0',
    earnedDurationText: '00:00',

    // 规则
    oddsText: '',
    adUnitId: '',
  },

  // ===== 教师拦截（三道：入口 onStatsTap / 这里 onLoad / onShow）=====
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
    if (cachedRole() === 'teacher') {
      this.blockTeacher();
      return;
    }
    this.load();
  },

  onUnload() {
    // 全局单例不销毁（下次进入复用）；只作废「本次观看」的等待者
    closeWaiter = null;
    if (adPage === this) adPage = null;
    this._unloaded = true;
  },

  // ===== 广告事件（仅日志）=====
  adLoad() {
    console.log('[beidou] 插屏广告加载成功');
  },

  adError(err) {
    console.error('[beidou] 插屏广告加载失败', err);
  },

  adClose() {
    console.log('[beidou] 插屏广告已关闭');
  },

  // ===== 分享（点分享即计次：微信没有分享成功回调，见方案 §2 R2）=====
  onShareAppMessage() {
    // 卡片路径不带任何标识（没有归因需求），避免把内部标识传播出去
    return {
      title: '一起来攒步数 · 唐唐快跑',
      path: '/pages/splash/splash',
    };
  },

  /**
   * 「邀请同学一起跑」按钮（button open-type="share" 的 bind:tap）。
   *
   * 微信的 onShareAppMessage 在**分享面板弹出时**触发，用户点取消也会触发，
   * 所以「分享成功」在技术上不可观测。这里把它当作「点击即计次」，
   * 由服务端的最小间隔 + 可配上限兜底（见 services/beidou.js::reportShare）。
   *
   * ⚠️ 这里**不 await**：分享面板由 open-type="share" 同步弹出，上报是并发进行的，
   *    上报失败不能影响分享本身（反之亦然）。
   */
  onShareTap() {
    if (this._sharing) return;
    this._sharing = true;
    const report = auth.post('/api/beidou/share/report', { shareId: makeNonce('sh') });
    report
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
      const data = await auth.get('/api/beidou/today');
      if (data && data.blocked) {
        this.blockTeacher();
        return;
      }
      // 走到这里的只可能是学生，提前创建广告单例让广告先加载
      ensureVideoAd(data.adUnitId);
      ensureInterstitialAd();
      this.applyState(data);
      showEntryInterstitial(this);
    } catch (e) {
      if (e.code === 403003) return; // 未绑定：request.js 已跳登录页
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  // 把服务端 today 状态铺到页面 data
  applyState(data) {
    const e = data.earned || {};
    const checkin = data.checkin || {};
    const cap = data.cap || {};
    const cells = buildCheckinCells({ ...checkin, milestones: checkin.milestones });
    const todayCell = cells.find((c) => c.isToday) || cells[Math.min(checkin.streak || 0, cells.length - 1)];
    const prizes = (data.draw && data.draw.prizes) || [];
    const sectorList = (data.draw && data.draw.sectors) || [];
    const capText =
      cap.cap > 0 && cap.capped
        ? `今日步数奖励已达上限（${cap.cap} 步），明天再来`
        : cap.cap > 0
          ? `今日步数奖励还剩 ${cap.left} 步额度`
          : '';
    this.setData({
      loading: false,
      enabled: data.enabled !== false,
      sectors: buildSectorViews(sectorList, prizes),
      wheelBg: buildWheelBg(sectorList, prizes),
      remaining: (data.draw && data.draw.remaining) || 0,
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
      earnedStepsText: fmt.formatNumber(e.steps || 0),
      earnedDistanceText: fmt.formatDistance(e.distance || 0),
      earnedCaloriesText: fmt.formatNumber(e.calories || 0),
      earnedDurationText: fmt.formatDuration(e.durationSeconds || 0),
      recent: data.recent || [],
      oddsText: buildOddsText(prizes),
      adUnitId: (data.video && data.video.adUnitId) || '',
    });
  },

  // 只刷新「次数相关」字段（抽奖/看视频/分享/签到后调用，避免整页重排导致转盘闪一下）
  applyCounters(res) {
    if (!res) return;
    const patch = {};
    if (res.remaining !== undefined) patch.remaining = res.remaining;
    if (res.unlimited !== undefined) patch.unlimited = !!res.unlimited;
    if (res.maxPerDay !== undefined) patch.maxPerDay = res.maxPerDay;
    if (res.total !== undefined) patch.drawTotal = res.total;
    if (res.used !== undefined) patch.drawUsed = res.used;
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
    this._busy = true;
    this.setData({ spinning: true, lastPrize: null });
    try {
      const result = await auth.post('/api/beidou/draw', { drawId: makeNonce('dr') });
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.message) || '抽奖失败', icon: 'none' });
        this.setData({ spinning: false });
        // 次数不足/太频繁时拉一次最新状态，保证按钮态与服务端一致
        this.load();
        return;
      }
      // 服务端下发 index → 前端只负责停到那一格（结果不由前端决定）
      this.spinTo(result.index, () => {
        this.applyDrawResult(result);
      });
    } catch (e) {
      this.setData({ spinning: false });
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
   * 把第 index 格的中心转到指针位置（指针固定 0° = 正上方）。
   *
   * 目标角 = 5 整圈 + (360 - centerDeg)
   *   第 index 格的标签中心在 centerDeg（相对于盘面），盘面要转 -(centerDeg) 才能把它送到 0°，
   *   等价于转 360 - centerDeg。再叠 5 整圈保证一直朝一个方向转。
   *
   * 停位误差超过半格（22.5°）就会「停在 A 却发 B」，所以这个公式只允许与 buildSectorViews
   * 的 centerDeg 共用同一套常量（DEG_PER_SECTOR）。
   */
  spinTo(index, done) {
    const safeIndex = Math.max(0, Math.min(SECTOR_COUNT - 1, Number(index) || 0));
    const current = this.data.rotateDeg || 0;
    // 保证只往一个方向转：先把当前角抬到下一个整圈起点
    const base = Math.ceil(current / 360) * 360;
    const centerDeg = safeIndex * DEG_PER_SECTOR + DEG_PER_SECTOR / 2;
    const target = base + 360 * SPIN_ROUNDS + (360 - centerDeg);
    this.setData({ rotateDeg: target });
    // 用 transitionend 而不是 setTimeout：低端机 transition 更慢，定时会错位。
    // 但仍保留一个兜底定时器：少数机型/系统「减少动画」偏好下 transitionend 不触发。
    const finish = () => {
      if (this._spinTimer) {
        clearTimeout(this._spinTimer);
        this._spinTimer = null;
      }
      this.setData({ spinning: false });
      if (typeof done === 'function') done();
    };
    this._spinDone = finish;
    if (this._spinTimer) clearTimeout(this._spinTimer);
    this._spinTimer = setTimeout(finish, 3600);
  },

  // 转盘 CSS transition 结束
  onSpinEnd() {
    if (this._spinDone) this._spinDone();
  },

  applyDrawResult(result) {
    const p = result.prize || {};
    const prizeText =
      p.type === 'steps'
        ? `抽到 ${p.label || p.amount + ' 步'}`
        : p.type === 'draw'
          ? '再来一次！'
          : result.capped
            ? '谢谢参与（今日步数奖励已达上限）'
            : '谢谢参与';
    // 图标与颜色在 JS 里算好：WXML 只在 name 属性里放一个变量，
    // 避免检查器把模板里的字符串当图标名解析（且三元嵌套在模板里也不易读）。
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
      this.setData({
        earned: result.earned,
        earnedStepsText: fmt.formatNumber(result.earned.steps || 0),
        earnedDistanceText: fmt.formatDistance(result.earned.distance || 0),
        earnedCaloriesText: fmt.formatNumber(result.earned.calories || 0),
        earnedDurationText: fmt.formatDuration(result.earned.durationSeconds || 0),
      });
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
    if (p.type === 'steps' && !result.capped) {
      wx.showToast({ title: `+${p.amount} 步`, icon: 'success' });
    } else if (p.type === 'draw') {
      wx.showToast({ title: '再来一次！', icon: 'none' });
    }
    if (result.newBadges && result.newBadges.length) {
      // 徽章提示不打断：交给徽章页去看
      console.log('[beidou] 解锁新徽章', result.newBadges.map((b) => b.name).join('、'));
    }
    // 中奖记录刷新（服务端下发，前端不自己攒）
    this.loadRecent();
  },

  async loadRecent() {
    try {
      const data = await auth.get('/api/beidou/today');
      if (data && data.recent) this.setData({ recent: data.recent });
    } catch (e) {
      /* 中奖记录拉不到不影响主流程 */
    }
  },

  // ===== 看视频得次数 =====
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
      if (!ended) return; // 中途关闭：不计次

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
        wx.showToast({
          title: parts.length ? `签到成功 ${parts.join(' ')}` : '签到成功',
          icon: 'none',
        });
        // 签到会改变 streak / 格子状态，整体重载最省事且不会错
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

  // 快捷跳转：次数不足时的「去赚次数」引导（滚到任务区）
  scrollToTasks() {
    if (wx.pageScrollTo) wx.pageScrollTo({ selector: '#tasks', duration: 240 });
  },
});
