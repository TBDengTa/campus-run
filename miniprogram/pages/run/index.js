const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// 两点间球面距离（米）
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

Page({
  data: {
    state: 'idle', // idle | running | paused | finished
    stateText: '准备就绪',
    latitude: 39.909,
    longitude: 116.397,
    scale: 16,
    polyline: [],
    markers: [],
    distanceText: '0.00',
    durationText: '00:00',
    paceText: "--'--\"",
    saving: false,
    locationReady: false,
    isTeacher: false,
  },

  onLoad() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    this.points = [];
    this.distance = 0;
    this.seconds = 0;
    this.timer = null;
    this.lastPoint = null;
  },

  onShow() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    this.syncTabBar();
    this.bootstrap();
  },

  // 先确认角色，再决定是否进入跑步流程
  async bootstrap() {
    const isTeacher = await this.syncRole();
    // 教师账号不参与运动记录，停在此页提示
    if (isTeacher) {
      this.applyState('idle');
      return;
    }
    // tab 页常驻：回到本页时若未开始跑步，刷新一次定位与状态提示
    if (this.data.state === 'idle' || this.data.state === 'finished') {
      this.applyState('idle');
      if (!this.data.locationReady) this.initLocation();
    } else {
      this.applyState(this.data.state);
    }
  },

  // 角色（教师不参与运动记录）
  async syncRole() {
    try {
      await getApp().ensureLogin();
    } catch (e) {
      // 未配置后端时忽略，按学生处理
    }
    const user = (getApp().globalData && getApp().globalData.userInfo) || {};
    const isTeacher = user.role === 'teacher';
    if (isTeacher !== this.data.isTeacher) this.setData({ isTeacher });
    return isTeacher;
  },

  // 自定义 tabBar 选中态
  syncTabBar() {
    if (typeof this.getTabBar !== 'function') return;
    const bar = this.getTabBar();
    if (bar && typeof bar.setActive === 'function') bar.setActive('/pages/run/index');
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' });
  },

  // 统一维护状态与状态文案
  applyState(state) {
    const map = { idle: '准备就绪', running: '跑步中', paused: '已暂停', finished: '已结束' };
    this.setData({ state, stateText: map[state] || '准备就绪' });
  },


  onUnload() {
    this.stopTimer();
    this.stopLocationUpdate();
  },

  onHide() {
    if (this.data.state === 'running') {
      wx.showToast({ title: '跑步仍在进行中', icon: 'none' });
    }
  },

  initLocation() {
    wx.getLocation({
      type: 'gcj02',
      success: (res) => {
        this.setData({ latitude: res.latitude, longitude: res.longitude, locationReady: true });
      },
      fail: () => {
        wx.showModal({
          title: '需要位置权限',
          content: 'GPS 实跑需要获取您的位置信息，请在设置中开启',
          confirmText: '去设置',
          success: (r) => {
            if (r.confirm) wx.openSetting();
          },
        });
      },
    });
  },

  startLocationUpdate() {
    wx.startLocationUpdate({
      success: () => {
        wx.onLocationChange(this.onLocationChange.bind(this));
      },
      fail: (e) => {
        wx.showToast({ title: '定位启动失败：' + (e.errMsg || ''), icon: 'none' });
      },
    });
  },

  stopLocationUpdate() {
    try {
      wx.offLocationChange();
      wx.stopLocationUpdate();
    } catch (e) {
      /* 忽略 */
    }
  },

  onLocationChange(res) {
    if (this.data.state !== 'running') return;
    const { latitude, longitude } = res;
    const last = this.lastPoint;
    if (last) {
      const d = haversine(last.latitude, last.longitude, latitude, longitude);
      if (d >= 2 && d < 100) {
        // 过滤漂移
        this.distance += d;
      }
    }
    this.lastPoint = { latitude, longitude };
    this.points.push({ latitude, longitude, timestamp: Date.now() });
    if (this.points.length % 5 === 0 || this.points.length < 10) {
      this.updatePolyline();
    }
  },

  updatePolyline() {
    if (this.points.length < 2) return;
    this.setData({
      polyline: [
        {
          points: this.points,
          color: '#ff6b00',
          width: 6,
          arrowLine: true,
        },
      ],
      latitude: this.points[this.points.length - 1].latitude,
      longitude: this.points[this.points.length - 1].longitude,
    });
  },

  startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => {
      this.seconds += 1;
      this.updateStats();
    }, 1000);
  },

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  updateStats() {
    const paceSeconds = this.distance > 5 ? this.seconds / (this.distance / 1000) : 0;
    const paceText = paceSeconds
      ? `${Math.floor(paceSeconds / 60)}'${String(Math.round(paceSeconds % 60)).padStart(2, '0')}"`
      : "--'--\"";
    this.setData({
      distanceText: `${(this.distance / 1000).toFixed(2)}`,
      durationText: fmt.formatDuration(this.seconds),
      paceText,
    });
  },

  start() {
    if (this.data.isTeacher) {
      wx.showToast({ title: '教师账号不参与运动记录', icon: 'none' });
      return;
    }
    if (!this.data.locationReady) {
      this.initLocation();
      return;
    }
    this.applyState('running');
    this.startTime = Date.now();
    this.startLocationUpdate();
    this.startTimer();
  },

  pause() {
    this.applyState('paused');
    this.stopTimer();
  },

  resume() {
    this.applyState('running');
    this.startTimer();
  },

  finish() {
    if (this.distance < 10) {
      wx.showModal({
        title: '距离过短',
        content: '本次记录不足 10 米，将不会保存',
        showCancel: false,
        success: () => this.reset(),
      });
      return;
    }
    this.applyState('finished');
    this.stopTimer();
    this.stopLocationUpdate();
    this.save();
  },

  async save() {
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中…', mask: true });
    try {
      await getApp().ensureLogin();
      const result = await auth.post('/api/run/gps', {
        distance: Math.round(this.distance),
        durationSeconds: this.seconds,
        startTime: this.startTime ? new Date(this.startTime).toISOString() : undefined,
        endTime: new Date().toISOString(),
        routePoints: this.points.slice(-5000),
        location: '',
      });
      wx.hideLoading();
      if (!this.startTime) this.startTime = Date.now() - this.seconds * 1000;
      const badges = result.newBadges || [];
      wx.showModal({
        title: '已保存',
        content: `${this.data.distanceText} km · ${this.data.durationText}${badges.length ? `，获得「${badges.map((b) => b.name).join('」「')}」徽章！` : ''}`,
        confirmText: '查看记录',
        cancelText: '返回',
        success: (r) => {
          if (r.confirm) {
            wx.navigateTo({ url: `/pages/run/detail?id=${result.record._id}` });
          }
          this.reset();
        },
      });
    } catch (e) {
      wx.hideLoading();
      if (e.code === 403001) {
        wx.navigateTo({ url: '/pages/banned/banned' });
        return;
      }
      // 限制 GPS 实跑（反作弊/人工）：提示到期时间并引导按类型申诉
      if (e.code === 403004) {
        const r = e.restriction || {};
        wx.showModal({
          title: `${r.text || 'GPS 实跑'}已被限制`,
          content: `${r.reason || '数据异常'}\n解封时间：${r.until ? String(r.until).slice(0, 16).replace('T', ' ') : '永久'}`,
          confirmText: '去申诉',
          cancelText: '知道了',
          success: (res) => {
            if (res.confirm) wx.navigateTo({ url: `/pages/appeal/submit?scope=${r.scope || 'gps'}` });
          },
        });
        this.applyState('paused');
        return;
      }
      wx.showModal({ title: '保存失败', content: e.message, showCancel: false });
      this.applyState('paused');
    } finally {
      this.setData({ saving: false });
    }
  },

  reset() {
    this.points = [];
    this.distance = 0;
    this.seconds = 0;
    this.lastPoint = null;
    this.startTime = null;
    this.setData({ polyline: [], markers: [] });
    this.applyState('idle');
    this.updateStats();
    this.initLocation();
  },
});
