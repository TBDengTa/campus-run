const auth = require('../../utils/request');
const fmt = require('../../utils/format');

const QUICK_AMOUNTS = [
  { amount: 100, label: '小口', tIcon: 'sip', amountText: fmt.formatNumber(100) },
  { amount: 250, label: '一杯', tIcon: 'drink', amountText: fmt.formatNumber(250) },
  { amount: 500, label: '一瓶', tIcon: 'liquor', amountText: fmt.formatNumber(500) },
];

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 历史记录圆环（与首页「本周 7 天」同款）：外圈 conic-gradient 表示当日完成度
function ringStyleOf(percent, achieved) {
  const pct = Math.max(0, Math.min(100, percent || 0));
  const fill = achieved ? 'var(--tt-brand)' : 'var(--wt-water-deep)';
  return `background: conic-gradient(${fill} 0 ${pct}%, var(--wt-track) ${pct}% 100%);`;
}

// 历史记录装饰：圆环样式 + 日期短标签 + 达标标记
function decorateHistory(list) {
  const today = fmt.todayKey();
  const todayMonth = Number(String(today).slice(5, 7));
  return (list || []).map((d) => {
    const parts = String(d.date || '').split('-').map(Number);
    const [y, m, day] = parts;
    const valid = parts.length === 3 && parts.every((n) => Number.isFinite(n));
    const weekday = valid ? WEEKDAYS[new Date(y, m - 1, day).getDay()] : '';
    const isToday = d.date === today;
    const percent =
      typeof d.percent === 'number' ? d.percent : Math.min(100, Math.round(((d.total || 0) / (d.target || 1)) * 100));
    const achieved = percent >= 100;
    const dayText = isToday ? '今天' : m === todayMonth ? `${day}日` : `${m}月${day}日`;
    return {
      ...d,
      percent,
      achieved,
      isToday,
      dayText,
      weekday,
      // 圆环下只放短标签：今天 / 12日（跨月显示 9月30日）
      label: dayText,
      ringStyle: ringStyleOf(percent, achieved),
      totalText: fmt.formatNumber(d.total),
      targetText: fmt.formatNumber(d.target),
    };
  });
}

Page({
  data: {
    today: null,
    percent: 0,
    waterPercent: 0, // 杯内水位高度（含视觉最小值，仅用于显示）
    quickAmounts: QUICK_AMOUNTS,
    customAmount: 200,
    logs: [],
    history: [],
    historyOk: 0, // 近 N 天达标天数
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
      const historyList = decorateHistory(history.list);
      this.setData({
        history: historyList,
        historyOk: historyList.filter((d) => d.achieved).length,
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
    // 视觉最小水位：杯内已有水时至少显示 16% 高度，否则水位太低会被水面波浪"咬"掉看不到
    const waterPercent = today.total > 0 ? Math.max(percent, 16) : 0;
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
      waterPercent,
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
