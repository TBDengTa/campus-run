const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// 默认激励视频广告位 ID（官方广告位；管理端「北斗运动」配置了 adUnitId 时以配置为准）
// 广告位 ID 属于客户端公开标识，不是密钥；服务端地址/密钥/AppSecret 一律不进仓库。
const DEFAULT_AD_UNIT_ID = 'adunit-a80731a737d255c9';

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

  onShow() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    this._unloaded = false;
    this.load();
  },

  onUnload() {
    // 全局单例不销毁（下次进入复用，避免重建实例 / 重复注册回调）；
    // 只作废「本次观看」的等待者：离开页面后即便广告关闭也不再上报
    closeWaiter = null;
    this._unloaded = true;
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
      await getApp().ensureLogin();
      const data = await auth.get('/api/reward-video/today');
      const { per, earned } = this.pickResult(data);
      // 广告位来自服务端配置（缺省用默认广告位）；提前创建单例让广告先开始加载
      ensureVideoAd(data.adUnitId);
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
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async watch() {
    if (this._busy) return; // 防连点：一次只处理一次观看
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
