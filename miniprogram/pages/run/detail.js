const auth = require('../../utils/request');
const fmt = require('../../utils/format');

Page({
  data: {
    record: null,
    hasRoute: false,
    polyline: [],
    markers: [],
    isAdminView: false, // 管理端 / 班级域查看他人记录：隐藏「再跑一次」等本人操作
    readonlyView: false, // 只读视角（班级域）：页脚写明仅查看
    // GPS 派生指标（用户 2026-11-02）：服务端已算好，前端只做单位格式化
    gpsMetrics: null,
    scope: 'self', // self 本人 | admin 管理端 | class 班级域（只读）
  },

  onLoad(options) {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    // 管理端查看某个用户的记录：走管理端接口（用户端接口只允许看自己，会 404「记录不存在」）
    this.adminUid = options.admin === '1' ? options.uid || '' : '';
    // 班级域（班主任 / 班委）只看本班学生记录：走 /api/class/student/:uid/run/:runId（成员资格校验、只读）
    this.classUid = options.scope === 'class' ? options.uid || '' : '';
    this.className = options.className ? decodeURIComponent(options.className) : '';
    if (this.adminUid) this.setData({ isAdminView: true, scope: 'admin' });
    if (this.classUid) this.setData({ isAdminView: true, readonlyView: true, scope: 'class' });
    this.load(options.id);
  },

  async load(id) {
    try {
      await getApp().ensureLogin();
      let url = `/api/run/detail/${id}`;
      if (this.classUid) {
        url = `/api/class/student/${this.classUid}/run/${id}?className=${encodeURIComponent(this.className)}`;
      } else if (this.adminUid) {
        url = `/api/admin/users/${this.adminUid}/runs/${id}`;
      }
      const record = await auth.get(url);
      const startTimeText = this.formatClock(record.startTime);
      const endTimeText = this.formatClock(record.endTime);
      this.setData({
        record: {
          ...record,
          distanceText: fmt.formatDistance(record.distance),
          durationText: fmt.formatDuration(record.durationSeconds),
          ...fmt.sourceOf(record.source),
          stepsText: fmt.formatNumber(record.steps || 0),
          caloriesText: fmt.formatNumber(record.calories || 0),
          paceText: record.pace || '',
          dateWeekText: this.formatDateWeek(record.date),
          startTimeText,
          endTimeText,
          timeRangeText: startTimeText && endTimeText ? `${startTimeText} - ${endTimeText}` : '',
        },
      });
      if (record.ownerName) wx.setNavigationBarTitle({ title: `${record.ownerName} 的运动` });
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

      // ===== GPS 派生指标（用户 2026-11-02「GPS 实跑需要看到更多数据如
      //       平均速度、峰值速度、距离、路线图等」）=====
      // 服务端 /api/run/detail/:id 已算好 metrics（见 routes/run.js::withGpsMetrics），
      // 前端**只做单位格式化与展示**，绝不自己遍历 routePoints（一次跑步上万点，
      // 前端算容易写错，且速度单位/时间基准各写一份必然漂移）。
      if (record.source === 'gps') {
        const m = record.metrics || {};
        const speedText = (v) => (v == null || v <= 0 ? '' : `${(v * 3.6).toFixed(1)} km/h`);
        const paceText = (secPerKm) => {
          if (!secPerKm || secPerKm <= 0) return '';
          const mm = Math.floor(secPerKm / 60);
          const ss = Math.round(secPerKm % 60);
          return `${mm}'${String(ss).padStart(2, '0')}"`;
        };
        this.setData({
          gpsMetrics: {
            avgSpeedText: speedText(m.avgSpeed),
            avgPaceText: paceText(m.avgPaceSecPerKm),
            peakSpeedText: speedText(m.peakSpeed),
            pointCount: m.pointCount || 0,
            // 丑话前置：点数太少时说明轨迹可能不完整，别让人以为是系统丢了数据
            pointHint:
              (m.pointCount || 0) > 0 && m.pointCount < 10
                ? '轨迹点较少，可能因后台被系统暂停'
                : '',
            // 分段列表（负分段分析）：只给前 20 段，避免长距离把页面撑爆
            segments: (m.segments || []).slice(0, 20).map((s) => ({
              km: s.km,
              speedText: speedText(s.speed),
              paceText: paceText(s.paceSecPerKm),
              lengthText: `${s.meters}m`,
            })),
            hasSegments: (m.segments || []).length > 0,
          },
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
    // 管理端 / 班级域查看他人记录时不允许从这里开跑（教师/管理员本就不产生运动数据）
    if (this.data.isAdminView) {
      wx.showToast({ title: this.data.readonlyView ? '仅查看，不能代跑' : '管理端不参与运动记录', icon: 'none' });
      return;
    }
    wx.switchTab({ url: '/pages/run/index' });
  },
});
