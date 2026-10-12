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
        this.setData({
          record: {
            ...record,
            distanceText: fmt.formatDistance(record.distance),
            durationText: fmt.formatDuration(record.durationSeconds),
            sourceText: record.source === 'gps' ? 'GPS 实跑' : '微信运动',
          },
        });
      if (record.source === 'gps' && record.routePoints && record.routePoints.length > 1) {
        const pts = record.routePoints;
        this.setData({
          hasRoute: true,
          latitude: pts[0].latitude,
          longitude: pts[0].longitude,
          polyline: [{ points: pts, color: '#0052d9', width: 6, arrowLine: true }],
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
});
