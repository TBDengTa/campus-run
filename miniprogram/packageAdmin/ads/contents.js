const auth = require('../../utils/request');
const fmt = require('../../utils/format');
// 写权限（ad.manage）：只有 ad.view 的账号看不到新增/编辑/删除/保存
const adminPerm = require('../../utils/admin-perm');

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
    loading: true,
    saving: false,
    formVisible: false,
    form: EMPTY,
    slotIndex: 0,
    sponsorIndex: 0,
    linkTypes: [
      { value: 'web', label: '外链' },
      { value: 'page', label: '落地页' },
      { value: 'none', label: '无跳转' },
    ],
    linkTypeIndex: 0,
    pageIdIndex: 0,
    // 按广告位筛选：chips = 全部 + 各广告位（服务端已支持 ?slotKey=）
    slotChips: [],
    activeSlot: '',
    canManage: false, // ad.manage / '*'：只有查看权限（ad.view）时看不到新增/编辑/删除
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      await adminPerm.applyManage(this, 'ad.manage');
      const activeSlot = this.data.activeSlot;
      const contentQuery = activeSlot ? { limit: 100, slotKey: activeSlot } : { limit: 100 };
      const [contents, slots, sponsors, pages] = await Promise.all([
        auth.get('/api/admin/ads/contents', contentQuery),
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
        slotChips: [{ key: '', name: '全部' }, ...slots.list.map((s) => ({ key: s.key, name: s.name }))],
      });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 广告位筛选（chips）
  switchSlot(e) {
    const key = e.currentTarget.dataset.key || '';
    if (key === this.data.activeSlot) return;
    this.setData({ activeSlot: key });
    this.load();
  },

  openCreate() {
    // 默认选中当前筛选的广告位，新增完就能在列表里直接看到
    const { slots, activeSlot } = this.data;
    const slotIndex = activeSlot ? Math.max(0, slots.findIndex((s) => s.key === activeSlot)) : 0;
    const slotKey = slots[slotIndex] ? slots[slotIndex].key : '';
    this.setData({
      formVisible: true,
      saving: false,
      form: { ...EMPTY, slotKey },
      slotIndex,
      sponsorIndex: 0,
      linkTypeIndex: 0,
      pageIdIndex: 0,
    });
  },

  openEdit(e) {
    const item = this.data.list.find((x) => x._id === e.currentTarget.dataset.id);
    if (!item) return;
    this.setData({
      formVisible: true,
      saving: false,
      form: { ...EMPTY, ...item },
      slotIndex: Math.max(0, this.data.slots.findIndex((s) => s.key === item.slotKey)),
      sponsorIndex: Math.max(0, this.data.sponsors.findIndex((s) => String(s._id) === String(item.sponsorId))),
      linkTypeIndex: Math.max(0, this.data.linkTypes.findIndex((t) => t.value === item.linkType)),
      pageIdIndex: Math.max(0, this.data.pages.findIndex((p) => String(p._id) === String(item.pageId))),
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

  onSlot(e) {
    const i = Number(e.detail.value);
    if (!this.data.slots[i]) return;
    this.setData({ slotIndex: i, 'form.slotKey': this.data.slots[i].key });
  },

  onSponsor(e) {
    const i = Number(e.detail.value);
    if (!this.data.sponsors[i]) return;
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
    // 白名单提交：统计字段（totalPv/totalClick）等不参与写库
    const payload = {
      slotKey: form.slotKey,
      sponsorId: form.sponsorId || null,
      title: String(form.title || '').trim(),
      imageUrl: form.imageUrl,
      linkType: form.linkType,
      linkUrl: form.linkType === 'web' ? String(form.linkUrl || '').trim() : '',
      pageId: form.linkType === 'page' ? form.pageId || null : null,
      startDate: form.startDate || '',
      endDate: form.endDate || '',
      weight: Number(form.weight) || 1,
      enabled: !!form.enabled,
    };
    this.setData({ saving: true });
    try {
      if (form._id) await auth.put(`/api/admin/ads/contents/${form._id}`, payload);
      else await auth.post('/api/admin/ads/contents', payload);
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
