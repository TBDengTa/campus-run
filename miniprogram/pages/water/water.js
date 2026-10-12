const auth = require('../../utils/request');
const fmt = require('../../utils/format');

const QUICK_AMOUNTS = [
  { amount: 100, label: '小口', tIcon: 'sip', amountText: fmt.formatNumber(100) },
  { amount: 250, label: '一杯', tIcon: 'drink', amountText: fmt.formatNumber(250) },
  { amount: 500, label: '一瓶', tIcon: 'liquor', amountText: fmt.formatNumber(500) },
];

Page({
  data: {
    today: null,
    percent: 0,
    quickAmounts: QUICK_AMOUNTS,
    customAmount: 200,
    logs: [],
  },

  onShow() {
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const today = await auth.get('/api/water/today');
      this.apply(today);
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  apply(today) {
    // 容错：接口异常返回时不让页面崩溃
    if (!today || typeof today.total !== 'number' || !Array.isArray(today.logs)) {
      if (today && today.error) wx.showToast({ title: today.error, icon: 'none' });
      return;
    }
    const percent = Math.min(100, Math.round((today.total / (today.target || 1)) * 100));
    const logs = [...today.logs].reverse().map((l) => ({
      ...l,
      timeText: new Date(l.time).toTimeString().slice(0, 5),
    }));
    this.setData({
      today: {
        ...today,
        totalText: fmt.formatNumber(today.total),
        targetText: fmt.formatNumber(today.target),
        remainingText: fmt.formatNumber(Math.max(0, (today.target || 0) - (today.total || 0))),
      },
      percent,
      logs,
    });
  },

  async add(e) {
    const amount = Number(e.currentTarget.dataset.amount);
    await this.doAdd(amount);
  },

  async addCustom() {
    await this.doAdd(this.data.customAmount);
  },

  onCustomInput(e) {
    this.setData({ customAmount: Number(e.detail.value) || 0 });
  },

  async doAdd(amount) {
    if (!amount || amount <= 0) return;
    try {
      const today = await auth.post('/api/water/record', { amount });
      this.apply(today);
      wx.vibrateShort({ type: 'light' });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async setTarget() {
    const that = this;
    wx.showModal({
      title: '设置每日饮水目标 (ml)',
      editable: true,
      placeholderText: String(this.data.today.target || 2000),
      success: async (res) => {
        if (res.confirm && res.content) {
          try {
            const today = await auth.put('/api/water/target', { target: Number(res.content) });
            that.apply(today);
          } catch (e) {
            wx.showToast({ title: e.message, icon: 'none' });
          }
        }
      },
    });
  },
});
