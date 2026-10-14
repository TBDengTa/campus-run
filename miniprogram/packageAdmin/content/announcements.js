const auth = require('../../utils/request');

const EMPTY = { _id: '', title: '', content: '', type: 'notice', priority: 0, enabled: true };

Page({
  data: {
    list: [],
    loading: false,
    form: null,
    formVisible: false,
    saving: false,
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
    this.setData({ form: { ...EMPTY }, formVisible: true });
  },

  openEdit(e) {
    const item = this.data.list.find((x) => x._id === e.currentTarget.dataset.id);
    this.setData({ form: { ...item }, formVisible: true });
  },

  onFormVisible(e) {
    this.setData({ formVisible: !!(e.detail && e.detail.visible) });
  },

  closeForm() {
    this.setData({ formVisible: false });
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
    if (this.data.saving) return;
    const { form } = this.data;
    if (!form.title) {
      wx.showToast({ title: '标题必填', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    const payload = { ...form };
    ['_id', 'createdAt', 'updatedAt', '__v', 'dateText'].forEach((k) => delete payload[k]);
    try {
      if (form._id) await auth.put(`/api/admin/content/announcements/${form._id}`, payload);
      else await auth.post('/api/admin/content/announcements', payload);
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ formVisible: false });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ saving: false });
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
