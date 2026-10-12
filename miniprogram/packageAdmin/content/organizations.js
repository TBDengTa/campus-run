const auth = require('../../utils/request');

Page({
  data: {
    tree: [],
    loading: false,
    // 新增/编辑表单
    form: null,
    parentName: '（作为学校）',
    types: [
      { value: 'school', label: '学校' },
      { value: 'department', label: '院系' },
      { value: 'specialty', label: '专业' },
    ],
    typeIndex: 0,
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      const tree = await auth.get('/api/org/tree');
      this.setData({ tree });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  openCreate(e) {
    const { parentId, parentName, type } = e.currentTarget.dataset;
    const typeIndex = type ? this.data.types.findIndex((t) => t.value === type) : 0;
    this.setData({
      form: { _id: '', name: '', parentId: parentId || '', sort: 0 },
      parentName: parentName || '（作为学校）',
      typeIndex: typeIndex >= 0 ? typeIndex : 0,
    });
  },

  openEdit(e) {
    const item = e.currentTarget.dataset;
    this.setData({
      form: { _id: item.id, name: item.name, parentId: item.parentid || '', sort: Number(item.sort) || 0 },
      parentName: item.parentname || '（作为学校）',
      typeIndex: this.data.types.findIndex((t) => t.value === item.type),
    });
  },

  closeForm() {
    this.setData({ form: null });
  },

  onField(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value });
  },

  async save() {
    const { form, types, typeIndex } = this.data;
    if (!form.name) {
      wx.showToast({ title: '名称必填', icon: 'none' });
      return;
    }
    const payload = { name: form.name, type: types[typeIndex].value, parentId: form.parentId || null, sort: Number(form.sort) || 0 };
    try {
      if (form._id) await auth.put(`/api/admin/content/organizations/${form._id}`, payload);
      else await auth.post('/api/admin/content/organizations', payload);
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
      title: '删除组织节点',
      content: '其下级节点将一并删除，确认删除？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`/api/admin/content/organizations/${id}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },
});
