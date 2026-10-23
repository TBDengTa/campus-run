const auth = require('../../utils/request');
// 写权限（ad.manage）：只有 ad.view 的账号看不到新增/编辑/删除/保存
const adminPerm = require('../../utils/admin-perm');

const EMPTY = { _id: '', key: '', name: '', page: '', type: 'banner', maxSponsors: 5, exclusive: false, enabled: true, builtIn: false };
const TYPES = [
  { value: 'banner', label: '轮播图' },
  { value: 'card', label: '卡片' },
  { value: 'splash', label: '启动页' },
];

Page({
  data: {
    list: [],
    builtInCount: 0,
    loading: true,
    saving: false,
    canManage: false,
    formVisible: false,
    form: EMPTY,
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
      await adminPerm.applyManage(this, 'ad.manage');
      const res = await auth.get('/api/admin/ads/slots', { limit: 100 });
      const list = res.list || [];
      this.setData({ list, builtInCount: list.filter((s) => s.builtIn).length });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  openCreate() {
    this.setData({ formVisible: true, saving: false, form: { ...EMPTY }, typeIndex: 0 });
  },

  openEdit(e) {
    const item = this.data.list.find((x) => x._id === e.currentTarget.dataset.id);
    if (!item) return;
    this.setData({
      formVisible: true,
      saving: false,
      form: { ...EMPTY, ...item },
      typeIndex: Math.max(0, TYPES.findIndex((t) => t.value === item.type)),
    });
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
    const key = String(form.key || '').trim();
    const name = String(form.name || '').trim();
    if (!key || !name) {
      wx.showToast({ title: 'key 和名称必填', icon: 'none' });
      return;
    }
    const payload = {
      key,
      name,
      type: form.type,
      page: String(form.page || '').trim(),
      maxSponsors: Number(form.maxSponsors) || 1,
      exclusive: !!form.exclusive,
      enabled: !!form.enabled,
    };
    // 内置位 key 不可改：编辑时不提交 key，避免无谓的校验失败
    if (form._id && form.builtIn) delete payload.key;
    this.setData({ saving: true });
    try {
      if (form._id) await auth.put(`/api/admin/ads/slots/${form._id}`, payload);
      else await auth.post('/api/admin/ads/slots', payload);
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
