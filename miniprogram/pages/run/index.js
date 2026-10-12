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
    state: 'idle', // idle | running | paused
    latitude: 39.909,
    longitude: 116.397,
    scale: 16,
    polyline: [],
    markers: [],
    distanceText: '0.00 km',
    durationText: '00:00',
    paceText: "--'--\"",
    saving: false,
    locationReady: false,
  },

  onLoad() {
    this.points = [];
    this.distance = 0;
    this.seconds = 0;
    this.timer = null;
    this.lastPoint = null;
    this.initLocation();
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
          color: '#0052d9',
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
      distanceText: `${(this.distance / 1000).toFixed(2)} km`,
      durationText: fmt.formatDuration(this.seconds),
      paceText,
    });
  },

  start() {
    if (!this.data.locationReady) {
      this.initLocation();
      return;
    }
    this.setData({ state: 'running' });
    this.startLocationUpdate();
    this.startTimer();
  },

  pause() {
    this.setData({ state: 'paused' });
    this.stopTimer();
  },

  resume() {
    this.setData({ state: 'running' });
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
    this.setData({ state: 'finished' });
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
        content: `${this.data.distanceText} · ${this.data.durationText}${badges.length ? `，获得「${badges.map((b) => b.name).join('」「')}」徽章！` : ''}`,
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
      wx.showModal({ title: '保存失败', content: e.message, showCancel: false });
      this.setData({ state: 'paused' });
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
    this.setData({ state: 'idle', polyline: [], markers: [] });
    this.updateStats();
  },
});
