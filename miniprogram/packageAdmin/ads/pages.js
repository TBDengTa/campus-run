const auth = require('../../utils/request');
const { env } = require('../../utils/request');
// 写权限（ad.manage）：只有 ad.view 的账号看不到新增/编辑/删除/保存
const adminPerm = require('../../utils/admin-perm');

const HTML_TEMPLATE = [
  '<!doctype html>',
  '<html>',
  '<head>',
  '  <meta charset="utf-8">',
  '  <meta name="viewport" content="width=device-width, initial-scale=1">',
  '  <title>活动页</title>',
  '  <style>body{font-family:-apple-system,sans-serif;padding:24px}</style>',
  '</head>',
  '<body>',
  '  <h1>活动标题</h1>',
  '  <p>活动内容…</p>',
  '</body>',
  '</html>',
].join('\n');

const EMPTY = { _id: '', name: '', slug: '', htmlContent: '', enabled: true };
// 服务端 body 限制 2MB，HTML 留出富余：单文件 ≤1.5MB
const MAX_HTML_BYTES = 1.5 * 1024 * 1024;

// 新建落地页自动生成 slug（可改）；编辑时禁改，保证老链接不失效
function makeSlug() {
  return `ad-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

Page({
  data: {
    list: [],
    loading: true,
    saving: false,
    importing: false,
    canManage: false, // ad.manage / '*'：只有 ad.view 时不显示新增/编辑/删除/保存
    formVisible: false,
    form: EMPTY,
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      await adminPerm.applyManage(this, 'ad.manage');
      const res = await auth.get('/api/admin/ads/pages', { limit: 100 });
      this.setData({
        list: (res.list || []).map((p) => ({
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
      formVisible: true,
      saving: false,
      form: { ...EMPTY, slug: makeSlug(), htmlContent: HTML_TEMPLATE },
    });
  },

  openEdit(e) {
    const item = this.data.list.find((x) => x._id === e.currentTarget.dataset.id);
    if (!item) return;
    this.setData({ formVisible: true, saving: false, form: { ...EMPTY, ...item } });
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

  onHtml(e) {
    this.setData({ 'form.htmlContent': e.detail.value });
  },

  toggleEnabled(e) {
    this.setData({ 'form.enabled': e.detail.value });
  },

  // 导入本地 HTML 文件（.html/.htm，≤1.5MB）→ 读为 utf8 填入编辑器，保存仍走 JSON 接口
  async importHtml() {
    if (this.data.importing) return;
    let res;
    try {
      res = await wx.chooseMessageFile({ count: 1, type: 'file', extension: ['html', 'htm'] });
    } catch (e) {
      if (e && /cancel/i.test(e.errMsg || e.message || '')) return;
      wx.showToast({ title: '选择文件失败', icon: 'none' });
      return;
    }
    if (!res || !res.tempFiles || !res.tempFiles.length) return;
    const file = res.tempFiles[0];
    const fileName = file.name || file.path || '';
    if (!/\.html?$/i.test(fileName)) {
      wx.showToast({ title: '仅支持 .html / .htm 文件', icon: 'none' });
      return;
    }
    if (file.size > MAX_HTML_BYTES) {
      wx.showToast({ title: '文件超过 1.5MB，请精简后再导入', icon: 'none' });
      return;
    }
    this.setData({ importing: true });
    wx.showLoading({ title: '读取中…', mask: true });
    try {
      const content = await new Promise((resolve, reject) => {
        wx.getFileSystemManager().readFile({
          filePath: file.path,
          encoding: 'utf8',
          success: (r) => resolve(r.data),
          fail: reject,
        });
      });
      const patch = { 'form.htmlContent': String(content || '') };
      // 名称留空时用文件名兜底，省一次手输
      if (!String(this.data.form.name || '').trim()) patch['form.name'] = fileName.replace(/\.html?$/i, '');
      this.setData(patch);
      wx.showToast({ title: `已导入 ${Math.round((content || '').length / 1024)}KB`, icon: 'none' });
    } catch (e) {
      wx.showToast({ title: (e && (e.message || e.errMsg)) || '读取文件失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ importing: false });
    }
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
    const name = String(form.name || '').trim();
    const slug = String(form.slug || '').trim();
    if (!name || !slug) {
      wx.showToast({ title: '名称和 slug 必填', icon: 'none' });
      return;
    }
    const payload = {
      name,
      slug,
      htmlContent: form.htmlContent || '',
      enabled: !!form.enabled,
    };
    // 编辑时不改 slug（老链接不失效）
    if (form._id) delete payload.slug;
    this.setData({ saving: true });
    try {
      if (form._id) await auth.put(`/api/admin/ads/pages/${form._id}`, payload);
      else await auth.post('/api/admin/ads/pages', payload);
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
