const auth = require('../../utils/request');

const GENDER_TEXT = { 1: '男', 2: '女', 0: '保密' };

// 三档导入模式：智能（列自动识别 + 缺失字段推导）/ 新增 / 更新
const MODES = [
  { value: 'smart', title: '智能', desc: '列自动识别+推导' },
  { value: 'create', title: '新增', desc: '创建新账户' },
  { value: 'update', title: '更新', desc: '仅更新已有用户' },
];

function tipsOf(mode) {
  if (mode === 'smart') {
    return [
      '只需保证「学号」列（姓名建议提供），其余列有多少算多少：姓名 / 性别 / 证件号码 / 班级 / 专业 / 院系 / 学校 / 出生日期 / 年级',
      '列名自动识别（证件号码 / 身份证号、院系 / 系部 等写法均可）',
      '出生日期、性别从证件号码提取；专业从班级解析；班级 = 年级 + 专业；院系、学校按班级或专业匹配已有数据',
      '库中已有学号 → 自动更新；不存在 → 创建账户（此时姓名必填）',
      '初始密码 = 证件号后8位（无证件用学号后8位），首次登录强制修改',
    ];
  }
  if (mode === 'update') {
    return [
      '仅更新模式：表头 学号,性别,出生日期；按学号匹配已有用户',
      '学号不存在则失败报告，绝不创建',
    ];
  }
  return [
    '表头：学号,姓名,证件号码,学校,院系,专业,性别,出生日期（班级可选，按「年级+专业」自动组合）',
    '按「学号」upsert：已存在的学生仅更新资料，不会改动密码和微信绑定',
    '初始密码 = 证件号后8位（无证件用学号后8位），首次登录强制修改',
    '同名且同初始密码的记录会被拒绝，请学校核实后调整',
  ];
}

Page({
  data: {
    mode: 'smart', // smart 智能 | create 新增 | update 更新
    modes: MODES,
    tipLines: tipsOf('smart'),
    payload: '',
    parsing: false, // 解析预览中
    previewData: null, // { cacheId, mode, total, valid, failedCount, failed, preview }
    confirming: false,
    importing: { active: false, done: 0, total: 0, created: 0, updated: 0, failedCount: 0, percent: 0 },
    result: null, // { total, created, updated, failed: [{row, reason}] }
  },

  switchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (!mode || mode === this.data.mode) return;
    this.setData({ mode, tipLines: tipsOf(mode) });
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
      wx.showLoading({ title: '上传中 0%', mask: true });
      const previewData = await auth.uploadFile(path, {
        url: '/api/admin/users/import/preview',
        formData: { mode: this.data.mode },
        onProgress: (p) => wx.showLoading({ title: `上传中 ${p}%`, mask: true }),
      });
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
    const { payload, parsing, mode } = this.data;
    if (parsing) return;
    if (!payload.trim()) {
      wx.showToast({ title: '请先粘贴数据或选择文件', icon: 'none' });
      return;
    }
    this.setData({ parsing: true });
    try {
      await getApp().ensureLogin();
      const previewData = await auth.post('/api/admin/users/import/preview', { payload, mode });
      this.applyPreview(previewData);
    } catch (e) {
      wx.showToast({ title: e.message || '解析失败', icon: 'none' });
    } finally {
      this.setData({ parsing: false });
    }
  },

  applyPreview(previewData) {
    const preview = (previewData.preview || []).map((r) => ({
      ...r,
      genderText: GENDER_TEXT[r.gender] || '',
      birthText: r.birthdate || '',
      deptText: r.department || '',
      // 智能模式后端标记 exists：true=库中已有（将更新），false=将新增
      statusText: r.exists === true ? '更新' : r.exists === false ? '新增' : '',
    }));
    this.setData({
      previewData: { ...previewData, preview },
      result: null, // 新预览使旧导入结果失效
    });
    wx.showToast({
      title: `共 ${previewData.total} 行${previewData.failedCount ? `，异常 ${previewData.failedCount} 行` : '，全部可导入'}`,
      icon: 'none',
    });
  },

  // 预览确认后分片写库（每批 200 行），驱动进度条；中途失败可从断点继续（缓存 15 分钟内有效）
  async confirmImport() {
    const { previewData, mode, confirming, importing } = this.data;
    if (confirming || importing.active || !previewData) return;
    if (!previewData.valid) {
      wx.showToast({ title: '没有可导入的数据（所有行均异常）', icon: 'none' });
      return;
    }
    const CHUNK = 200;
    const total = previewData.valid;
    const start = Math.min(importing.done || 0, total); // 断点续传：从上次完成处继续
    const failedAll = [];
    let created = 0;
    let updated = 0;
    let offset = start;
    this.setData({
      confirming: true,
      importing: { active: true, done: start, total, created: 0, updated: 0, failedCount: 0, percent: Math.round((start / total) * 100) },
    });
    try {
      await getApp().ensureLogin();
      while (offset < total) {
        const r = await auth.post('/api/admin/users/import/confirm', {
          cacheId: previewData.cacheId,
          mode,
          offset,
          limit: CHUNK,
        });
        created += r.created || 0;
        updated += r.updated || 0;
        failedAll.push(...(r.failed || []));
        offset = r.offset + (r.limit || 0);
        const done = Math.min(offset, r.total);
        this.setData({
          importing: {
            active: true,
            done,
            total: r.total,
            created,
            updated,
            failedCount: failedAll.length,
            percent: Math.min(100, Math.round((done / (r.total || 1)) * 100)),
          },
        });
        if (r.done) break;
      }
      const result = { mode, total, created, updated, failed: failedAll };
      this.setData({
        result,
        previewData: null,
        importing: { active: false, done: 0, total: 0, created: 0, updated: 0, failedCount: 0, percent: 0 },
        confirming: false,
      });
      wx.showToast({
        title: `新增${created} 更新${updated}${failedAll.length ? ` 失败${failedAll.length}` : ''}`,
        icon: failedAll.length ? 'none' : 'success',
      });
    } catch (e) {
      // 中断：预览缓存未删，保留进度，可点「继续导入」从断点重试
      this.setData({ confirming: false });
      wx.showModal({
        title: '导入中断',
        content: `已完成 ${this.data.importing.done} / ${total} 行。预览 15 分钟内有效，可点「继续导入」从断点重试。`,
        showCancel: false,
      });
    }
  },

  fillSample() {
    let sample;
    if (this.data.mode === 'smart') {
      // 最小列：无班级/性别/出生日期 —— 预览可见自动组班与证件号推导
      sample = '学号,姓名,证件号码,专业\n2023010101,张三,110101200401011234,机电一体化\n2023010102,李四,110101200402025678,机电一体化';
    } else if (this.data.mode === 'update') {
      sample = '学号,性别,出生日期\n2023010101,男,2004-01-01\n2023010102,女,2004-02-02';
    } else {
      sample = '姓名,学号,身份证号,学校,院系,专业,性别,出生日期\n张三,2023010101,110101200401011234,北校区,机电建工系,机电一体化,男,2004-01-01\n李四,2023010102,110101200402025678,北校区,机电建工系,机电一体化,女,2004-02-02';
    }
    this.setData({ payload: sample });
  },
});
