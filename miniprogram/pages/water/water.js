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
    history: [],
  },

  onShow() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const [today, history] = await Promise.all([
        auth.get('/api/water/today'),
        auth.get('/api/water/history', { limit: 14 }).catch(() => ({ list: [] })),
      ]);
      this.apply(today);
      this.setData({
        history: (history.list || []).map((d) => ({
          ...d,
          dateText: `${Number(d.date.slice(5, 7))}月${Number(d.date.slice(8, 10))}日`,
          totalText: fmt.formatNumber(d.total),
          targetText: fmt.formatNumber(d.target),
        })),
      });
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
      this.load(); // 同步历史列表
      wx.vibrateShort({ type: 'light' });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
});
