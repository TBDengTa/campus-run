const auth = require('../../utils/request');
// 写权限（ad.manage）：只有 ad.view 的账号看不到新增/编辑/删除/保存
const adminPerm = require('../../utils/admin-perm');

const EMPTY = { _id: '', name: '', contact: '', phone: '', email: '', logo: '', active: true };

Page({
  data: {
    list: [],
    loading: false,
    canManage: false,
    form: null, // null=关闭
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      await adminPerm.applyManage(this, 'ad.manage');
      const res = await auth.get('/api/admin/ads/sponsors', { limit: 100 });
      this.setData({ list: res.list });
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
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  toggleActive(e) {
    this.setData({ 'form.active': e.detail.value });
  },

  async chooseLogo() {
    const res = await wx.chooseMedia({ count: 1, mediaType: ['image'] }).catch(() => null);
    if (!res) return;
    wx.showLoading({ title: '上传中…' });
    try {
      const { url } = await auth.uploadFile(res.tempFiles[0].tempFilePath, { formData: { category: 'ad' } });
      this.setData({ 'form.logo': url });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  async save() {
    const { form } = this.data;
    if (!form.name) {
      wx.showToast({ title: '请填写名称', icon: 'none' });
      return;
    }
    const payload = { ...form };
    delete payload._id;
    delete payload.createdAt;
    delete payload.updatedAt;
    delete payload.__v;
    try {
      if (form._id) {
        await auth.put(`/api/admin/ads/sponsors/${form._id}`, payload);
      } else {
        await auth.post('/api/admin/ads/sponsors', payload);
      }
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ form: null });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async remove(e) {
    const { id } = e.currentTarget.dataset;
    const that = this;
    wx.showModal({
      title: '删除赞助商',
      content: '确认删除？历史广告素材将保留但失去关联',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`/api/admin/ads/sponsors/${id}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },
});
