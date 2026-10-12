const auth = require('../../utils/request');

const EMPTY = { _id: '', key: '', name: '', page: '', type: 'banner', maxSponsors: 5, exclusive: false, enabled: true };
const TYPES = [
  { value: 'banner', label: '轮播图' },
  { value: 'card', label: '卡片' },
  { value: 'splash', label: '启动页' },
];

Page({
  data: {
    list: [],
    loading: false,
    form: null,
    types: TYPES,
    typeIndex: 0,
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      const res = await auth.get('/api/admin/ads/slots', { limit: 100 });
      this.setData({ list: res.list });
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

  onMaxChange(e) {
    this.setData({ 'form.maxSponsors': e.detail.value });
  },

  toggleExclusive(e) {
    this.setData({ 'form.exclusive': e.detail.value });
  },

  toggleEnabled(e) {
    this.setData({ 'form.enabled': e.detail.value });
  },

  async save() {
    const { form } = this.data;
    if (!form.key || !form.name) {
      wx.showToast({ title: 'key 和名称必填', icon: 'none' });
      return;
    }
    const payload = { ...form };
    delete payload._id;
    delete payload.createdAt;
    delete payload.updatedAt;
    delete payload.__v;
    try {
      if (form._id) await auth.put(`/api/admin/ads/slots/${form._id}`, payload);
      else await auth.post('/api/admin/ads/slots', payload);
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
      title: '删除广告位',
      content: '其下素材将一并停用，确认删除？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`/api/admin/ads/slots/${id}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },
});
