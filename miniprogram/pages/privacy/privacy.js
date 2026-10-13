const auth = require('../../utils/request');

const ITEMS = [
  {
    key: 'hideName',
    label: '隐藏我的姓名',
    desc: '排行榜中我的姓名将显示为「张**」形式的掩码',
  },
  {
    key: 'hideClass',
    label: '隐藏我的班级',
    desc: '排行榜中不再展示我的班级信息',
  },
  {
    key: 'hidePlan',
    label: '隐藏我的目标计划',
    desc: '排行榜中不再展示我使用的目标计划',
  },
  {
    key: 'exitRanking',
    label: '不参与排名',
    desc: '开启后我将从所有榜单中移除，无法查看自己的名次',
  },
];

Page({
  data: {
    items: ITEMS,
    privacy: { hideClass: false, hideName: false, hidePlan: false, exitRanking: false },
    saving: false,
  },

  onShow() {
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const me = await auth.get('/api/auth/me');
      this.setData({ privacy: me.privacy || this.data.privacy });
    } catch (e) {
      if (e.code === 403003) return;
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async toggle(e) {
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    if (this.data.saving) return;
    this.setData({ [`privacy.${key}`]: value, saving: true });
    try {
      await auth.put('/api/auth/privacy', { [key]: value });
      // 不参与排名时给出明确提示
      if (key === 'exitRanking' && value) {
        wx.showToast({ title: '已退出排名，榜单中不再显示你', icon: 'none', duration: 2500 });
      }
    } catch (err) {
      // 失败回滚
      this.setData({ [`privacy.${key}`]: !value });
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },
});
