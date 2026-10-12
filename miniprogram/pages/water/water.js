const auth = require('../../utils/request');

const QUICK_AMOUNTS = [
  { amount: 100, label: '小口', icon: '🥛' },
  { amount: 250, label: '一杯', icon: '🥤' },
  { amount: 500, label: '一瓶', icon: '🍶' },
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
    const percent = Math.min(100, Math.round((today.total / (today.target || 1)) * 100));
    const logs = [...today.logs].reverse().map((l) => ({
      ...l,
      timeText: new Date(l.time).toTimeString().slice(0, 5),
    }));
    this.setData({ today, percent, logs });
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
