const auth = require('../../utils/request');
const fmt = require('../../utils/format');

const PAGE_SIZE = 24;
// 用途（与 server/src/models/file-object.js 的 CATEGORIES 一一对应）
const CATS = [
  { key: '', label: '全部' },
  { key: 'avatar', label: '头像' },
  { key: 'ad', label: '广告' },
  { key: 'badge', label: '徽章' },
  { key: 'other', label: '其他' },
];

Page({
  data: {
    list: [],
    cats: [],
    statCats: [],
    activeCat: '',
    total: 0,
    totalSizeText: '0 B',
    page: 1,
    finished: false,
    loading: false,
    canManage: false,
  },

  onShow() {
    this.checkAndLoad();
  },

  onReachBottom() {
    this.load();
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh());
  },

  async checkAndLoad() {
    try {
      await getApp().ensureLogin();
      const user = await getApp().refreshUser();
      const perms = user.effectivePermissions || [];
      if (!user.isManager || (!perms.includes('file.view') && !perms.includes('*'))) {
        wx.showModal({
          title: '无权限',
          content: '该功能仅限持有文件权限的教师/管理员使用',
          showCancel: false,
          success: () => wx.switchTab({ url: '/pages/home/home' }),
        });
        return;
      }
      this.setData({ canManage: perms.includes('*') || perms.includes('file.manage') });
      this.reload();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  decorate(item) {
    return {
      ...item,
      name: item.originalName || item.filename,
      sizeText: fmt.formatSize(item.size),
      dateText: (item.createdAt || '').slice(0, 10),
      uploaderName: item.uploader && item.uploader.nickname ? item.uploader.nickname : '',
    };
  },

  async reload() {
    if (this.data.loading) return; // 上一页请求未返回时忽略重载，避免空列表
    this.setData({ page: 1, finished: false, list: [] });
    await this.load(true);
  },

  async load(reset = false) {
    if (this.data.loading) return;
    if (!reset && this.data.finished) return;
    const { page, activeCat } = this.data;
    this.setData({ loading: true });
    try {
      const query = { page, size: PAGE_SIZE };
      if (activeCat) query.category = activeCat;
      const res = await auth.get('/api/admin/files', query);
      const list = res.list.map((x) => this.decorate(x));
      // 筛选条需要「全部」；统计网格放不下 5 项，且「全部」= 总览卡右上角的总数，故不重复计入
      const cats = CATS.map((c) => ({
        ...c,
        count: c.key === '' ? res.stats.byCategory.all : res.stats.byCategory[c.key] || 0,
      }));
      const statCats = cats.filter((c) => c.key !== '');
      this.setData({
        list: reset ? list : this.data.list.concat(list),
        cats,
        statCats,
        total: res.total,
        totalSizeText: fmt.formatSize(res.stats.totalSize),
        finished: list.length < PAGE_SIZE,
        page: page + 1,
      });
    } catch (e) {
      if (e.code === 403002) {
        wx.showModal({ title: '无权限', content: '该功能仅管理员可用', showCancel: false });
        return;
      }
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onCat(e) {
    const { key } = e.currentTarget.dataset;
    if (key === this.data.activeCat) return;
    this.setData({ activeCat: key });
    this.reload();
  },

  preview(e) {
    const { url } = e.currentTarget.dataset;
    wx.previewImage({ current: url, urls: this.data.list.map((x) => x.url) });
  },

  remove(e) {
    const { id, name } = e.currentTarget.dataset;
    const that = this;
    wx.showModal({
      title: '删除文件',
      content: `确认删除「${name}」？引用该图的素材/头像将一并清空。`,
      confirmColor: '#e34d59',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`/api/admin/files/${id}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          that.reload();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },

  async upload() {
    const res = await wx.chooseMedia({ count: 1, mediaType: ['image'] }).catch(() => null);
    if (!res) return;
    wx.showLoading({ title: '上传中…' });
    try {
      await auth.uploadFile(res.tempFiles[0].tempFilePath, {
        formData: { category: this.data.activeCat || 'other' },
      });
      wx.showToast({ title: '已上传', icon: 'success' });
      this.reload();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },
});
