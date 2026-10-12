const auth = require('../../utils/request');

const TYPES = [
  { value: 'total_steps', label: '累计步数' },
  { value: 'total_distance', label: '累计距离(米)' },
  { value: 'total_days', label: '累计打卡天数' },
  { value: 'goal_days', label: '达标天数' },
  { value: 'single_steps', label: '单日步数' },
  { value: 'single_distance', label: '单次距离(米)' },
  { value: 'streak_days', label: '连续打卡天数' },
];

const EMPTY = { _id: '', key: '', name: '', description: '', icon: '', type: 'total_steps', target: 1, tierGroup: '', tierLevel: 0, tierColor: '', sort: 0, enabled: true };

Page({
  data: {
    list: [],
    types: TYPES,
    typeIndex: 0,
    loading: false,
    form: null,
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      const list = await auth.get('/api/admin/content/badges');
      this.setData({
        list: list.map((b) => ({
          ...b,
          typeLabel: (TYPES.find((t) => t.value === b.type) || {}).label || b.type,
        })),
      });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  openCreate() {
    this.setData({ form: { ...EMPTY }, typeIndex: 0 });
  },

  openEdit(e) {
    const item = this.data.list.find((x) => x._id === e.currentTarget.dataset.id);
    this.setData({
      form: { ...item },
      typeIndex: Math.max(0, TYPES.findIndex((t) => t.value === item.type)),
    });
  },

  closeForm() {
    this.setData({ form: null });
  },

  onField(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value });
  },

  onType(e) {
    const i = Number(e.detail.value);
    this.setData({ typeIndex: i, 'form.type': TYPES[i].value });
  },

  toggleEnabled(e) {
    this.setData({ 'form.enabled': e.detail.value });
  },

  async save() {
    const { form } = this.data;
    if (!form.key || !form.name || !form.target) {
      wx.showToast({ title: 'key/名称/目标值必填', icon: 'none' });
      return;
    }
    const payload = { ...form, target: Number(form.target), sort: Number(form.sort) || 0, tierLevel: Number(form.tierLevel) || 0 };
    ['_id', 'createdAt', 'updatedAt', '__v', 'typeLabel'].forEach((k) => delete payload[k]);
    try {
      if (form._id) await auth.put(`/api/admin/content/badges/${form._id}`, payload);
      else await auth.post('/api/admin/content/badges', payload);
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ form: null });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  remove(e) {
    const { id } = e.currentTarget.dataset;
    const that = this;
    wx.showModal({
      title: '删除徽章',
      content: '用户已获得的该徽章记录将保留，确认删除？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`/api/admin/content/badges/${id}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },
});
