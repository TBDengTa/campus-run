const auth = require('../../utils/request');
const fmt = require('../../utils/format');

Page({
  data: {
    record: null,
    hasRoute: false,
    polyline: [],
    markers: [],
  },

  onLoad(options) {
    this.load(options.id);
  },

  async load(id) {
    try {
      await getApp().ensureLogin();
      const record = await auth.get(`/api/run/detail/${id}`);
      const startTimeText = this.formatClock(record.startTime);
      const endTimeText = this.formatClock(record.endTime);
      this.setData({
        record: {
          ...record,
          distanceText: fmt.formatDistance(record.distance),
          durationText: fmt.formatDuration(record.durationSeconds),
          sourceText: record.source === 'gps' ? 'GPS 实跑' : '微信运动',
          stepsText: fmt.formatNumber(record.steps || 0),
          caloriesText: fmt.formatNumber(record.calories || 0),
          paceText: record.pace || '',
          dateWeekText: this.formatDateWeek(record.date),
          startTimeText,
          endTimeText,
          timeRangeText: startTimeText && endTimeText ? `${startTimeText} - ${endTimeText}` : '',
        },
      });
      if (record.source === 'gps' && record.routePoints && record.routePoints.length > 1) {
        const pts = record.routePoints;
        this.setData({
          hasRoute: true,
          latitude: pts[0].latitude,
          longitude: pts[0].longitude,
          polyline: [{ points: pts, color: '#ff6b00', width: 6, arrowLine: true }],
          markers: [
            { id: 1, latitude: pts[0].latitude, longitude: pts[0].longitude, iconPath: '', width: 0, height: 0, callout: { content: '起点', display: 'ALWAYS', borderRadius: 8, padding: 4 } },
            {
              id: 2,
              latitude: pts[pts.length - 1].latitude,
              longitude: pts[pts.length - 1].longitude,
              callout: { content: '终点', display: 'ALWAYS', borderRadius: 8, padding: 4 },
            },
          ],
        });
      }
    } catch (e) {
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  // 展示用：YYYY-MM-DD → 06月12日 周三
  formatDateWeek(dateKey) {
    if (!dateKey) return '';
    const [y, m, d] = String(dateKey).split('-').map(Number);
    if (!y || !m || !d) return String(dateKey);
    const week = ['日', '一', '二', '三', '四', '五', '六'][new Date(y, m - 1, d).getDay()];
    return `${String(m).padStart(2, '0')}月${String(d).padStart(2, '0')}日 周${week}`;
  },

  // 展示用：Date → HH:mm
  formatClock(time) {
    if (!time) return '';
    const d = new Date(time);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  },

  goRun() {
    wx.switchTab({ url: '/pages/run/index' });
  },
});
