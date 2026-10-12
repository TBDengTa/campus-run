const auth = require('../../utils/request');

Page({
  data: {
    payload: '',
    submitting: false,
    result: null, // { total, created, updated, failed: [{row, reason}] }
  },

  inputPayload(e) {
    this.setData({ payload: e.detail.value });
  },

  // 选择文件（.csv / .json）读取为文本
  async chooseFile() {
    try {
      const res = await wx.chooseMessageFile({ count: 1, type: 'file', extension: ['csv', 'json', 'txt'] });
      if (!res.tempFiles || !res.tempFiles.length) return;
      const path = res.tempFiles[0].path;
      if (res.tempFiles[0].size > 2 * 1024 * 1024) {
        wx.showToast({ title: '文件不能超过 2MB', icon: 'none' });
        return;
      }
      const text = await new Promise((resolve, reject) => {
        const fs = wx.getFileSystemManager();
        fs.readFile({
          filePath: path,
          encoding: 'utf8',
          success: (r) => resolve(r.data),
          fail: (e) => reject(new Error(e.errMsg || '读取文件失败')),
        });
      });
      this.setData({ payload: text });
      wx.showToast({ title: '已读取文件', icon: 'success' });
    } catch (e) {
      if (e && /cancel/i.test(e.errMsg || '')) return;
      wx.showToast({ title: e.message || '选择文件失败', icon: 'none' });
    }
  },

  fillSample() {
    const sample = `姓名,学号,身份证号,学校,院系,班级,专业
张三,2023010101,110101200401011234,北校区,机电建工系,23级机电1班,机电一体化
李四,2023010102,110101200402025678,北校区,机电建工系,23级机电1班,机电一体化`;
    this.setData({ payload: sample });
  },

  async submit() {
    const { payload, submitting } = this.data;
    if (submitting) return;
    if (!payload.trim()) {
      wx.showToast({ title: '请先粘贴数据或选择文件', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      await getApp().ensureLogin();
      const result = await auth.post('/api/admin/users/import', { payload });
      this.setData({ result });
      const failed = (result.failed || []).length;
      wx.showToast({
        title: `新增${result.created} 更新${result.updated}${failed ? ` 失败${failed}` : ''}`,
        icon: failed ? 'none' : 'success',
      });
    } catch (e) {
      wx.showToast({ title: e.message || '导入失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
