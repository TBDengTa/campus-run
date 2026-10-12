const auth = require('../../utils/request');
const fmt = require('../../utils/format');

Page({
  data: {
    totals: { pv: 0, click: 0 },
    pvText: '0',
    clickText: '0',
    ctrText: '0.00%',
    byDate: [],
    startDate: '',
    endDate: '',
    maxVal: 1,
    loading: true,
  },

  onLoad() {
    const end = new Date();
    const start = new Date(Date.now() - 13 * 86400000);
    const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    this.setData({ startDate: key(start), endDate: key(end) });
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      const { totals, byDate } = await auth.get('/api/admin/ads/stats', {
        start: this.data.startDate,
        end: this.data.endDate,
      });
      const maxVal = Math.max(1, ...byDate.map((d) => d.pv));
      const pv = (totals && totals.pv) || 0;
      const click = (totals && totals.click) || 0;
      this.setData({
        loading: false,
        totals,
        pvText: fmt.formatNumber(pv),
        clickText: fmt.formatNumber(click),
        ctrText: pv > 0 ? `${((click / pv) * 100).toFixed(2)}%` : '0.00%',
        byDate: byDate.map((d) => ({
          ...d,
          label: d._id.slice(5),
          pvHeight: Math.max(4, Math.round((d.pv / maxVal) * 140)),
          clickHeight: Math.max(4, Math.round((d.click / maxVal) * 140)),
          pvText: fmt.formatNumber(d.pv),
          clickText: fmt.formatNumber(d.click),
        })),
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  onStart(e) {
    this.setData({ startDate: e.detail.value });
    this.load();
  },

  onEnd(e) {
    this.setData({ endDate: e.detail.value });
    this.load();
  },
});
