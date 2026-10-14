const auth = require('../../utils/request');
const fmt = require('../../utils/format');

const EMPTY = {
  _id: '',
  slotKey: '',
  sponsorId: '',
  title: '',
  imageUrl: '',
  linkType: 'web',
  linkUrl: '',
  pageId: '',
  startDate: '',
  endDate: '',
  weight: 1,
  enabled: true,
};

Page({
  data: {
    list: [],
    slots: [],
    sponsors: [],
    pages: [],
    loading: false,
    form: null,
    slotIndex: 0,
    sponsorIndex: 0,
    linkTypes: [
      { value: 'web', label: '外链' },
      { value: 'page', label: '落地页' },
      { value: 'none', label: '无跳转' },
    ],
    linkTypeIndex: 0,
    pageIdIndex: 0,
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      const [contents, slots, sponsors, pages] = await Promise.all([
        auth.get('/api/admin/ads/contents', { limit: 100 }),
        auth.get('/api/admin/ads/slots', { limit: 100 }),
        auth.get('/api/admin/ads/sponsors', { limit: 100 }),
        auth.get('/api/admin/ads/pages', { limit: 100 }),
      ]);
      const slotMap = new Map(slots.list.map((s) => [s.key, s.name]));
      const sponsorMap = new Map(sponsors.list.map((s) => [String(s._id), s.name]));
      const pageMap = new Map(pages.list.map((p) => [String(p._id), p.name]));
      this.setData({
        list: contents.list.map((c) => ({
          ...c,
          slotName: slotMap.get(c.slotKey) || c.slotKey,
          sponsorName: c.sponsorId ? sponsorMap.get(String(c.sponsorId)) || '-' : '-',
          pageName: c.pageId ? pageMap.get(String(c.pageId)) || '-' : '',
          pvText: fmt.formatNumber(c.totalPv || 0),
          clickText: fmt.formatNumber(c.totalClick || 0),
        })),
        slots: slots.list,
        sponsors: sponsors.list,
        pages: pages.list,
      });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  openCreate() {
    this.setData({
      form: { ...EMPTY },
      slotIndex: 0,
      sponsorIndex: 0,
      linkTypeIndex: 0,
      pageIdIndex: 0,
    });
  },

  openEdit(e) {
    const item = this.data.list.find((x) => x._id === e.currentTarget.dataset.id);
    this.setData({
      form: { ...item },
      slotIndex: Math.max(0, this.data.slots.findIndex((s) => s.key === item.slotKey)),
      sponsorIndex: Math.max(0, this.data.sponsors.findIndex((s) => String(s._id) === String(item.sponsorId))),
      linkTypeIndex: Math.max(0, this.data.linkTypes.findIndex((t) => t.value === item.linkType)),
      pageIdIndex: Math.max(0, this.data.pages.findIndex((p) => String(p._id) === String(item.pageId))),
    });
  },

  closeForm() {
    this.setData({ form: null });
  },

  onField(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value });
  },

  onSlot(e) {
    const i = Number(e.detail.value);
    this.setData({ slotIndex: i, 'form.slotKey': this.data.slots[i].key });
  },

  onSponsor(e) {
    const i = Number(e.detail.value);
    this.setData({ sponsorIndex: i, 'form.sponsorId': this.data.sponsors[i]._id });
  },

  onLinkType(e) {
    const i = Number(e.detail.value);
    this.setData({ linkTypeIndex: i, 'form.linkType': this.data.linkTypes[i].value });
  },

  onPage(e) {
    const i = Number(e.detail.value);
    if (!this.data.pages[i]) return;
    this.setData({ pageIdIndex: i, 'form.pageId': this.data.pages[i]._id });
  },

  async chooseImage() {
    const res = await wx.chooseMedia({ count: 1, mediaType: ['image'] }).catch(() => null);
    if (!res) return;
    wx.showLoading({ title: '上传中…' });
    try {
      const { url } = await auth.uploadFile(res.tempFiles[0].tempFilePath, { formData: { category: 'ad' } });
      this.setData({ 'form.imageUrl': url });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  async save() {
    const { form } = this.data;
    if (!form.slotKey || !form.imageUrl) {
      wx.showToast({ title: '广告位和图片必填', icon: 'none' });
      return;
    }
    const payload = { ...form };
    delete payload._id;
    delete payload.createdAt;
    delete payload.updatedAt;
    delete payload.__v;
    delete payload.slotName;
    delete payload.sponsorName;
    delete payload.pageName;
    delete payload.pvText;
    delete payload.clickText;
    if (!payload.sponsorId) payload.sponsorId = null;
    if (payload.linkType !== 'page') payload.pageId = null;
    if (!payload.pageId) payload.pageId = null;
    try {
      if (form._id) await auth.put(`/api/admin/ads/contents/${form._id}`, payload);
      else await auth.post('/api/admin/ads/contents', payload);
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
      title: '删除素材',
      content: '确认删除该广告素材？统计明细将保留',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`/api/admin/ads/contents/${id}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },

  goStats() {
    wx.navigateTo({ url: '/packageAdmin/ads/stats' });
  },
});
