const auth = require('../../utils/request');

Page({
  data: {
    mode: 'create', // create 导入新用户 | update 仅更新已有用户
    payload: '',
    parsing: false, // 解析预览中
    previewData: null, // { cacheId, total, valid, failedCount, failed, preview }
    confirming: false,
    result: null, // { total, created, updated, failed: [{row, reason}] }
  },

  switchMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode });
  },

  inputPayload(e) {
    this.setData({ payload: e.detail.value });
  },

  // 选择表格文件（xlsx/xls/csv/json/txt）→ 上传到预览接口由服务端解析
  async chooseFile() {
    try {
      const res = await wx.chooseMessageFile({ count: 1, type: 'file', extension: ['csv', 'xlsx', 'xls', 'json', 'txt'] });
      if (!res.tempFiles || !res.tempFiles.length) return;
      const { path, size } = res.tempFiles[0];
      if (size > 5 * 1024 * 1024) {
        wx.showToast({ title: '文件不能超过 5MB', icon: 'none' });
        return;
      }
      wx.showLoading({ title: '解析中…' });
      const previewData = await auth.uploadFile(path, { url: '/api/admin/users/import/preview' });
      wx.hideLoading();
      this.applyPreview(previewData);
    } catch (e) {
      wx.hideLoading();
      if (e && /cancel/i.test(e.errMsg || '')) return;
      wx.showToast({ title: e.message || '解析失败', icon: 'none' });
    }
  },

  // 粘贴文本解析预览
  async parseText() {
    const { payload, parsing } = this.data;
    if (parsing) return;
    if (!payload.trim()) {
      wx.showToast({ title: '请先粘贴数据或选择文件', icon: 'none' });
      return;
    }
    this.setData({ parsing: true });
    try {
      await getApp().ensureLogin();
      const previewData = await auth.post('/api/admin/users/import/preview', { payload });
      this.applyPreview(previewData);
    } catch (e) {
      wx.showToast({ title: e.message || '解析失败', icon: 'none' });
    } finally {
      this.setData({ parsing: false });
    }
  },

  applyPreview(previewData) {
    this.setData({
      previewData: { ...previewData, preview: previewData.preview || [] },
      result: null, // 新预览使旧导入结果失效
    });
    wx.showToast({
      title: `共 ${previewData.total} 行${previewData.failedCount ? `，异常 ${previewData.failedCount} 行` : '，全部可导入'}`,
      icon: 'none',
    });
  },

  // 预览确认后真正写库（缓存一次性，换模式需重新解析）
  async confirmImport() {
    const { previewData, mode, confirming } = this.data;
    if (confirming || !previewData) return;
    if (!previewData.valid) {
      wx.showToast({ title: '没有可导入的数据（所有行均异常）', icon: 'none' });
      return;
    }
    this.setData({ confirming: true });
    try {
      const result = await auth.post('/api/admin/users/import/confirm', { cacheId: previewData.cacheId, mode });
      this.setData({ result, previewData: null });
      const failed = (result.failed || []).length;
      wx.showToast({
        title: `新增${result.created} 更新${result.updated}${failed ? ` 失败${failed}` : ''}`,
        icon: failed ? 'none' : 'success',
      });
    } catch (e) {
      wx.showToast({ title: e.message || '导入失败', icon: 'none' });
    } finally {
      this.setData({ confirming: false });
    }
  },

  fillSample() {
    const sample =
      this.data.mode === 'update'
        ? '学号,性别,出生日期\n2023010101,男,2004-01-01\n2023010102,女,2004-02-02'
        : '姓名,学号,身份证号,学校,院系,专业,性别,出生日期\n张三,2023010101,110101200401011234,北校区,机电建工系,机电一体化,男,2004-01-01\n李四,2023010102,110101200402025678,北校区,机电建工系,机电一体化,女,2004-02-02';
    this.setData({ payload: sample });
  },
});
