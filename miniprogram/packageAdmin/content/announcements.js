const auth = require('../../utils/request');

const EMPTY = { _id: '', title: '', content: '', type: 'notice', priority: 0, enabled: true };

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
      const list = await auth.get('/api/admin/content/announcements');
      this.setData({
        list: list.map((a) => ({ ...a, dateText: (a.createdAt || '').slice(0, 10) })),
      });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  openCreate() {
    this.setData({ form: { ...EMPTY } });
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

  toggleEnabled(e) {
    this.setData({ 'form.enabled': e.detail.value });
  },

  async save() {
    const { form } = this.data;
    if (!form.title) {
      wx.showToast({ title: '标题必填', icon: 'none' });
      return;
    }
    const payload = { ...form };
    ['_id', 'createdAt', 'updatedAt', '__v', 'dateText'].forEach((k) => delete payload[k]);
    try {
      if (form._id) await auth.put(`/api/admin/content/announcements/${form._id}`, payload);
      else await auth.post('/api/admin/content/announcements', payload);
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
      title: '删除公告',
      content: '确认删除？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`/api/admin/content/announcements/${id}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },
});
