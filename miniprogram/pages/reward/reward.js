const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// 默认激励视频广告位 ID（官方广告位；管理端「北斗运动」配置了 adUnitId 时以配置为准）
// 广告位 ID 属于客户端公开标识，不是密钥；服务端地址/密钥/AppSecret 一律不进仓库。
const DEFAULT_AD_UNIT_ID = 'adunit-a80731a737d255c9';

// ===== 教师拦截（本页入口只对学生开放）=====
// 北斗运动写的是 run_records，教师账号不参与运动记录，所以教师「进不去」本页：
//   · 入口：pages/profile 的「累计数据」连点 5 次 → 教师直接 toast，不 navigateTo
//   · 本页：onLoad（用本地缓存的角色，首帧就拦）+ onShow（接口确认后再拦一次）
//   · 拦截后 blocked=true → WXML 整块不渲染（不闪内容、无按钮、无广告节点）
//   · 教师路径下不创建激励视频 / 插屏实例、不调 show()、不发 /api/reward-video/*
const TEACHER_BLOCK_TITLE = '教师账号不参与运动记录';
const TEACHER_BLOCK_SUB = '北斗运动仅对学生开放，教师账号不能领取步数奖励。';
const TEACHER_TOAST = '教师账号不参与运动记录';

// 已知角色（本地缓存优先）：'teacher' / 'student' / ''
function cachedRole() {
  try {
    const u = auth.getUser();
    return (u && u.role) || '';
  } catch (e) {
    return '';
  }
}

// ===== 激励视频实例：模块级全局单例 =====
// 必须只创建一次、回调只注册一次 —— 每次 onLoad/onShow 重建实例或重复 onClose(() => …)
// 会让「一次观看」触发多次上报 → 多次入账。此处：
//   · 同一个 adUnitId 复用同一个实例（只有配置换广告位时才 destroy 重建）
//   · onLoad / onError / onClose 只在实例创建时注册一次
//   · onClose 只做一次广播：把 isEnded 交给「当前这一次观看」的等待者（同时只允许一个）
let videoAd = null;
let videoAdUnitId = '';
let videoAdReady = false; // onLoad 已触发
let closeWaiter = null; // 当前这次观看的等待者

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
  // 加载失败：只记日志，绝不上报入账
  videoAd.onError((err) => {
    console.warn('[reward] 激励视频加载失败（本次不入账）', err);
  });
  videoAd.onClose((res) => {
    const waiter = closeWaiter;
    closeWaiter = null;
    if (!waiter) return;
    // 只有「完整看完」才入账；提前关闭或回调不带 isEnded 一律不入账
    waiter(!!(res && res.isEnded === true));
  });
  return videoAd;
}

// 官方参考写法：已加载直接 show，未加载/失败则 load 后重试一次
function showVideoAd() {
  const first = videoAdReady
    ? videoAd.show()
    : Promise.resolve(videoAd.load()).then(() => videoAd.show());
  return first.catch(() => Promise.resolve(videoAd.load()).then(() => videoAd.show()));
}

// 等待这一次观看的结束结果（true = 完整看完）
function waitForClose() {
  return new Promise((resolve) => {
    closeWaiter = resolve;
  });
}

// ===== 插屏广告（北斗运动页）：模块级全局单例 + 回调只注册一次 =====
// 广告位 ID 属于客户端公开标识（与上方激励视频同理），不是密钥。
const INTERSTITIAL_AD_UNIT_ID = 'adunit-773c53ab76db1155';
// 展示节奏（常量集中在这里，便于以后调）：
//   · 时机 = 「进入页面、首屏数据加载完成之后」展示 1 次（页面已渲染完，不会跟首屏渲染打架）
//   · 每次进入最多 1 次：onShow 重入（从别的页返回 / 切前台）不再重复弹
//   · 本次小程序运行（会话）内最多展示 INTERSTITIAL_SESSION_MAX 次 —— 反复进出页面也不会刷屏
//     （插屏本身只能被消费一次：show() 后实例失效，下次进入会重建实例，计数器在模块级累计）
//   · show() 失败（无填充 / 开发者工具无广告 / 频次限制）catch 静默，且不占额度
const INTERSTITIAL_SESSION_MAX = 3;
let interstitialAd = null; // 全局单例：只创建一次
let interstitialShowCount = 0; // 会话内插屏已展示次数（模块级 = 反复进出页面也累计）
let adPage = null; // 当前页面实例：只用于把插屏事件转发到页面级日志出口

// 页面级日志出口（页面已卸载则跳过日志，绝不影响业务）
function emitAdEvent(name, payload) {
  try {
    if (adPage && typeof adPage[name] === 'function') adPage[name](payload);
  } catch (e) {
    /* 记日志失败也不能影响入账 */
  }
}

// 创建插屏单例：只创建一次、onLoad/onError/onClose 只注册一次（教师账号根本走不到这里）
function ensureInterstitialAd() {
  if (interstitialAd) return interstitialAd;
  if (!wx.createInterstitialAd) return null;
  interstitialAd = wx.createInterstitialAd({ adUnitId: INTERSTITIAL_AD_UNIT_ID });
  interstitialAd.onLoad(() => emitAdEvent('adLoad'));
  interstitialAd.onError((err) => emitAdEvent('adError', err));
  interstitialAd.onClose(() => emitAdEvent('adClose'));
  return interstitialAd;
}

// 进入页面时展示 1 次插屏（由 onShow 在首屏数据加载完成后调用）：
//   · 每次进入最多 1 次（pageData._entryInterstitialDone）
//   · 会话内最多 INTERSTITIAL_SESSION_MAX 次（模块级计数，跨页面重进累计）
//   · 无填充 / 失败一律 catch 静默，且失败不增加已展示计数（不占额度）
function showEntryInterstitial(pageData) {
  if (!pageData || pageData._entryInterstitialDone) return;
  if (interstitialShowCount >= INTERSTITIAL_SESSION_MAX) return;
  const ad = ensureInterstitialAd();
  if (!ad) return;
  // 先占位：同一次进入内 onShow 重入也不会再触发第二次 show()
  pageData._entryInterstitialDone = true;
  ad.show()
    .then(() => {
      interstitialShowCount += 1;
    })
    .catch((err) => {
      // 失败静默，不占额度：下次进入仍可再试
      console.warn('[reward] 插屏广告显示失败（已静默，不影响页面）', err);
    });
}

// 每次可获得 / 今日已入账 的展示文案（距离走 fmt.formatDistance、时长走 fmt.formatDuration）
function distanceText(meters) {
  return fmt.formatDistance(meters || 0);
}

function durationText(seconds) {
  return fmt.formatDuration(seconds || 0);
}

Page({
  data: {
    loading: true,
    enabled: true,
    watching: false,
    // 教师拦截：true = 本页整块不渲染（WXML 只有这一层 wx:if），
    // 首帧用本地缓存的角色判定，先拦再跳，避免教师看到奖励内容/广告节点
    blocked: false,
    adUnitId: '',
    watchCount: 0,
    stepsEarned: 0, // 保留：reward_video_records 累计步数（历史口径展示用）
    remaining: 0,
    limit: 0,
    // 每次观看可获得：四项（步数 / 距离米 / 卡路里 / 时长秒）
    perWatch: { steps: 0, distance: 0, calories: 0, durationSeconds: 0 },
    perWatchDistanceText: '0 m',
    perWatchDurationText: '00:00',
    // 今日已入账：四项（真源 = 当日 run_records 的 beidou 记录）
    earned: { steps: 0, distance: 0, calories: 0, durationSeconds: 0 },
    earnedStepsText: '0',
    earnedDistanceText: '0 m',
    earnedCaloriesText: '0',
    earnedDurationText: '00:00',
    rewarded: null, // 刚看完一次的结果（含四项）
  },

  // ===== 教师拦截（三道：入口 onStatsTap / 这里 onLoad / onShow）=====
  // 判定成功：本页不渲染任何内容、不创建广告实例、不发业务请求，提示后直接退出本页。
  // 刻意做成「主动拦截」而不是「碰巧打不开」：任何进入方式（隐藏入口 / 分享链接 /
  // navigateTo / 开发者工具直接填路径）都会被弹回。
  blockTeacher() {
    if (this._guardRedirecting) return; // 只处理一次（onLoad + onShow 都可能命中）
    this._guardRedirecting = true;
    this.setData({ blocked: true, loading: false });
    wx.showToast({ title: TEACHER_TOAST, icon: 'none' });
    // 只做说明弹窗 + 退出：教师连本页内容都没渲染（blocked=true），也没有任何广告实例
    wx.showModal({
      title: TEACHER_BLOCK_TITLE,
      content: TEACHER_BLOCK_SUB,
      showCancel: false,
      confirmText: '知道了',
      complete: () => this.leavePage(),
    });
  },

  // 退出本页：优先返回上一页；页面栈里没有上一页（如开发者工具直接打开该路径）则回首页
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
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    // 角色已知是教师 → 首帧就拦（不请求接口、不创建任何广告实例、不渲染奖励内容）
    if (cachedRole() === 'teacher') {
      this.blockTeacher();
    }
  },

  onShow() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    if (this._guardRedirecting) return; // 已在拦截退出中：不再加载、不再重复提示
    adPage = this; // 插屏事件（模块级单例注册）转发到本页 adLoad/adError/adClose 日志出口
    this._unloaded = false;
    // 教师：连业务接口都不发（教师连"页面能打开"的观感都不该有）
    if (cachedRole() === 'teacher') {
      this.blockTeacher();
      return;
    }
    this.load();
  },

  onUnload() {
    // 全局单例不销毁（下次进入复用，避免重建实例 / 重复注册回调）；
    // 只作废「本次观看」的等待者：离开页面后即便广告关闭也不再上报
    closeWaiter = null;
    if (adPage === this) adPage = null; // 页面已卸载：插屏事件不再往本页转发日志
    this._unloaded = true;
  },

  // ===== 广告事件（仅日志，无任何副作用）：插屏回调在模块级单例上只注册一次，事件转发到这里 =====
  adLoad() {
    console.log('[reward] 插屏广告加载成功');
  },

  adError(err) {
    console.error('[reward] 插屏广告加载失败', err);
  },

  adClose() {
    console.log('[reward] 插屏广告已关闭');
  },

  // 兜底：老服务端只回 stepsPerWatch/stepsEarned 时也能完整展示四项
  pickResult(data) {
    const per = data.perWatch || {
      steps: data.stepsPerWatch || 0,
      distance: data.distancePerWatch || 0,
      calories: data.caloriesPerWatch || 0,
      durationSeconds: data.durationPerWatch || 0,
    };
    const earned = data.earned || {
      steps: data.stepsEarned || 0,
      distance: 0,
      calories: 0,
      durationSeconds: 0,
    };
    return { per, earned };
  },

  async load() {
    try {
      const me =
        (await getApp().ensureLogin()) || (getApp().globalData && getApp().globalData.userInfo) || {};
      // 第二道闸门：接口 / 缓存拿到的最新角色是教师 → 立刻拦（此时还没发任何业务请求）
      if ((me.role || '') === 'teacher') {
        this.blockTeacher();
        return;
      }
      const data = await auth.get('/api/reward-video/today');
      const { per, earned } = this.pickResult(data);
      // 广告位来自服务端配置（缺省用默认广告位）；提前创建单例让广告先开始加载。
      // 走到这里的只可能是学生（教师已在上面被拦掉），所以这里创建实例是安全的。
      // 同时预建插屏单例：进入页面就要展示一次，提前创建可省掉首次 show 的等待。
      ensureVideoAd(data.adUnitId);
      ensureInterstitialAd();
      this.setData({
        loading: false,
        enabled: data.enabled,
        adUnitId: data.adUnitId || '',
        watchCount: data.watchCount,
        stepsEarned: data.stepsEarned,
        limit: data.limit,
        remaining: data.remaining != null ? data.remaining : Math.max(0, data.limit - data.watchCount),
        perWatch: per,
        perWatchDistanceText: distanceText(per.distance),
        perWatchDurationText: durationText(per.durationSeconds),
        earned,
        earnedStepsText: fmt.formatNumber(earned.steps),
        earnedDistanceText: distanceText(earned.distance),
        earnedCaloriesText: fmt.formatNumber(earned.calories),
        earnedDurationText: durationText(earned.durationSeconds),
      });
      // 插屏时机：进入页面（首屏数据加载完成之后）展示 1 次；
      // 节流（会话上限 / 每次进入仅 1 次 / 失败静默不占额度）见 showEntryInterstitial
      showEntryInterstitial(this);
    } catch (e) {
      if (e.code === 403003) return; // 未绑定：request.js 已跳登录页（如已主动退出）
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async watch() {
    if (this._busy) return; // 防连点：一次只处理一次观看
    if (this.data.blocked) return; // 教师拦截中：不创建广告、不请求、不入账
    if (!this.data.enabled) {
      wx.showToast({ title: '活动暂未开启', icon: 'none' });
      return;
    }
    if (this.data.remaining <= 0) {
      wx.showToast({ title: '今日次数已用完，明天再来吧', icon: 'none' });
      return;
    }
    const ad = ensureVideoAd(this.data.adUnitId);
    if (!ad) {
      wx.showToast({ title: '广告组件暂不可用', icon: 'none' });
      return;
    }
    this._busy = true;
    this.setData({ watching: true });
    try {
      // 展示广告 → onClose(res) 判定是否完整观看 → 完整看完才上报
      const waiter = waitForClose();
      try {
        await showVideoAd();
      } catch (err) {
        closeWaiter = null; // 广告没起来：本次不入账
        console.warn('[reward] 广告展示失败（本次不入账）', err);
        wx.showToast({ title: '广告暂时无法播放，稍后再试', icon: 'none' });
        return;
      }
      const ended = await waiter;
      if (!ended) return; // 中途关闭 / 未看完：不入账

      // 本次观看的幂等凭据：网络重试或重复提交同一个 watchId，服务端只入账一次
      const watchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const result = await auth.post('/api/reward-video/report', { watchId });
      if (result.success) {
        const { per, earned } = this.pickResult({
          perWatch: result.awarded,
          earned: result.earned,
          stepsPerWatch: result.stepsAwarded,
        });
        // 服务端返回的 earned 是重新聚合 run_records 得到的权威值（不是本地累加）
        this.setData({
          watchCount: result.watchCount,
          stepsEarned: result.stepsEarned,
          remaining: result.remaining,
          perWatch: per,
          perWatchDistanceText: distanceText(per.distance),
          perWatchDurationText: durationText(per.durationSeconds),
          earned,
          earnedStepsText: fmt.formatNumber(earned.steps),
          earnedDistanceText: distanceText(earned.distance),
          earnedCaloriesText: fmt.formatNumber(earned.calories),
          earnedDurationText: durationText(earned.durationSeconds),
          rewarded: {
            ...per,
            distanceText: distanceText(per.distance),
            durationText: durationText(per.durationSeconds),
            badges: result.newBadges || [],
          },
        });
        wx.showToast({ title: `+${per.steps} 步`, icon: 'success' });
        // 注意：插屏只在「进入页面」时展示一次（见 showEntryInterstitial），
        // 入账成功这里不再触发插屏 —— 产品要求把插屏时机前移到进页面。
      } else {
        wx.showToast({ title: result.message || '上报失败', icon: 'none' });
        this.load();
      }
    } catch (e) {
      if (e.code === 403001) {
        wx.navigateTo({ url: '/pages/banned/banned' });
        return;
      }
      // 限制微信同步类（激励奖励走同一条步数通道）时同样引导申诉
      if (e.code === 403004) {
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
        return;
      }
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this._busy = false;
      if (!this._unloaded) this.setData({ watching: false });
    }
  },
});
