const auth = require('../../utils/request');

const EMPTY = { _id: '', version: '', title: '', content: '', date: '' };

Page({
  data: {
    list: [],
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
      const list = await auth.get('/api/admin/content/changelogs');
      this.setData({ list });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  openCreate() {
    this.setData({ form: { ...EMPTY, date: new Date().toISOString().slice(0, 10) } });
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

  onContent(e) {
    this.setData({ 'form.content': e.detail.value });
  },

  onDate(e) {
    this.setData({ 'form.date': e.detail.value });
  },

  async save() {
    const { form } = this.data;
    if (!form.version) {
      wx.showToast({ title: '版本号必填', icon: 'none' });
      return;
    }
    const payload = { ...form };
    ['_id', 'createdAt', 'updatedAt', '__v'].forEach((k) => delete payload[k]);
    try {
      if (form._id) await auth.put(`/api/admin/content/changelogs/${form._id}`, payload);
      else await auth.post('/api/admin/content/changelogs', payload);
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
      title: '删除版本记录',
      content: '确认删除？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`/api/admin/content/changelogs/${id}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },
});
