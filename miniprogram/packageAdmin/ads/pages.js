const auth = require('../../utils/request');
const { env } = require('../../utils/request');

const EMPTY = { _id: '', name: '', slug: '', htmlContent: '', enabled: true };

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
      const res = await auth.get('/api/admin/ads/pages', { limit: 100 });
      this.setData({
        list: res.list.map((p) => ({
          ...p,
          url: `${env.AD_PAGE_BASE_URL || env.BASE_URL}/p/${p.slug}`,
          htmlSize: `${Math.round((p.htmlContent || '').length / 1024)}KB`,
        })),
      });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  openCreate() {
    this.setData({
      form: {
        ...EMPTY,
        htmlContent:
          '<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>活动页</title>\n  <style>body{font-family:-apple-system,sans-serif;padding:24px}</style>\n</head>\n<body>\n  <h1>活动标题</h1>\n  <p>活动内容…</p>\n</body>\n</html>',
      },
    });
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

  onHtml(e) {
    this.setData({ 'form.htmlContent': e.detail.value });
  },

  toggleEnabled(e) {
    this.setData({ 'form.enabled': e.detail.value });
  },

  copyLink(e) {
    const { url } = e.currentTarget.dataset;
    wx.setClipboardData({ data: url });
  },

  preview(e) {
    const { url } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/webview/webview?url=${encodeURIComponent(url)}&title=${encodeURIComponent('落地页预览')}` });
  },

  async save() {
    const { form } = this.data;
    if (!form.name || !form.slug) {
      wx.showToast({ title: '名称和 slug 必填', icon: 'none' });
      return;
    }
    const payload = { ...form };
    delete payload._id;
    delete payload.createdAt;
    delete payload.updatedAt;
    delete payload.__v;
    delete payload.url;
    delete payload.htmlSize;
    try {
      if (form._id) await auth.put(`/api/admin/ads/pages/${form._id}`, payload);
      else await auth.post('/api/admin/ads/pages', payload);
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
      title: '删除落地页',
      content: '引用它的素材将改为无跳转，确认删除？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`/api/admin/ads/pages/${id}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },
});
