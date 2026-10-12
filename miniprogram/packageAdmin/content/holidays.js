const auth = require('../../utils/request');

const EMPTY = { _id: '', date: '', name: '', type: 'festival' };

Page({
  data: {
    list: [],
    year: new Date().getFullYear(),
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
      const list = await auth.get('/api/content/holidays', { year: this.data.year });
      this.setData({
        list: list.map((h) => ({
          ...h,
          monthDay: (h.date || '').slice(5) || '--',
          yearText: (h.date || '').slice(0, 4),
        })),
      });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  changeYear(e) {
    this.setData({ year: Number(e.detail.value) });
    this.load();
  },

  openCreate() {
    this.setData({ form: { ...EMPTY, date: `${this.data.year}-01-01` } });
  },

  openEdit(e) {
    const item = this.data.list.find((x) => x._id === e.currentTarget.dataset.id);
    this.setData({ form: { ...item } });
  },

  closeForm() {
    this.setData({ form: null });
  },

  onField(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value });
  },

  onDate(e) {
    this.setData({ 'form.date': e.detail.value });
  },

  async save() {
    const { form } = this.data;
    if (!form.date || !form.name) {
      wx.showToast({ title: '日期和名称必填', icon: 'none' });
      return;
    }
    const payload = { ...form, year: parseInt(form.date.slice(0, 4), 10) };
    ['_id', 'createdAt', 'updatedAt', '__v'].forEach((k) => delete payload[k]);
    try {
      if (form._id) await auth.put(`/api/admin/content/holidays/${form._id}`, payload);
      else await auth.post('/api/admin/content/holidays', payload);
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
      title: '删除节假日',
      content: '确认删除？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`/api/admin/content/holidays/${id}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },
});
