const auth = require('../../../utils/request');
// 处置是写操作（user.manage）：只有 user.view 的账号能看列表，但看不到「封禁 / 标记正常」。
// 与项目约定一致：只读账号不显示写入口（check-write-guard 会扫）。
const adminPerm = require('../../../utils/admin-perm');

// 状态标签：open 待研判 / banned 已封禁 / dismissed 已排除
const STATUS = {
  open: { text: '待研判', theme: 'warning' },
  banned: { text: '已封禁', theme: 'danger' },
  dismissed: { text: '已排除', theme: 'default' },
};

Page({
  data: {
    tab: 'open',
    list: [],
    loading: false,
    canManage: false,
    counts: { open: 0, banned: 0, dismissed: 0 },
    // 学习引擎状态（模型就绪度 / 样本量 / 自校准阈值），见 loadEngine()
    engine: null,
    // 升级为有监督模型的进度（标注够不够），见 loadUpgrade()
    upgrade: null,
    keyword: '',
    // 封禁弹层：选天数 + 备注
    banSheetVisible: false,
    banTargetId: '',
    banTargetName: '',
    banDays: 7,
    banNote: '',
    banSaving: false,
    dayOptions: [1, 3, 7, 15, 30],
  },

  onShow() {
    this.reload();
    this.loadEngine();
    this.loadUpgrade();
  },

  /**
   * 加载「升级为有监督模型」的进度（用户 2026-10-27「标注积累到阈值后自动提示升级」）。
   *
   * 为什么要有这个提示：
   *   当前是无监督模型（不需要标签），但它的上限就在那里 —— 只能判「像不像异常」。
   *   想再准一步必须换成**有监督分类器**，而前提是攒够人工标注。
   *   标注只能靠管理员日常处置积累，所以系统要主动告诉他「还差多少、够了没」，
   *   否则这个能力永远躺在代码里没人知道。
   */
  async loadUpgrade() {
    try {
      const r = await auth.get('/api/admin/step-anomalies/upgrade-status');
      this.setData({
        upgrade: {
          ready: !!r.ready,
          progress: Number(r.progress) || 0,
          total: Number(r.total) || 0,
          suggestion: r.suggestion || '',
          missing: r.missing || [],
          perClass: r.perClass || { cheat: 0, normal: 0 },
          perSource: r.perSource || {},
        },
      });
    } catch (e) {
      /* 进度展示失败不影响主列表 */
    }
  },

  /**
   * 加载学习引擎状态（模型是否就绪、样本量、当前判定阈值）。
   * 这是**只读展示**，失败不影响主列表；首次打开时模型可能还在后台预热，
   * 所以显示「预热中」而不是报错。
   */
  async loadEngine() {
    try {
      const r = await auth.get('/api/admin/step-anomalies/model-status');
      const models = r.models || {};
      const th = r.threshold || {};
      const fmt = (x) => (Number.isFinite(Number(x)) ? Number(x).toFixed(2) : '-');
      this.setData({
        engine: {
          werunReady: !!(models.werun && models.werun.ready),
          werunRows: (models.werun && models.werun.rows) || 0,
          gpsReady: !!(models.gps && models.gps.ready),
          gpsRows: (models.gps && models.gps.rows) || 0,
          thresholdText: `可疑 ${fmt(th.suspicious)} / 自动封禁 ${fmt(th.autoBan)}`,
        },
      });
    } catch (e) {
      /* 状态展示失败不影响主列表 */
    }
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab || 'open';
    this.setData({ tab }, () => this.reload());
  },

  reload() {
    this.load();
  },

  onKeyword(e) {
    this.setData({ keyword: (e.detail && e.detail.value) || '' });
  },

  onSearch() {
    this.load();
  },

  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      // 写权限：user.manage（处置账号）；取不到时按只读渲染（fail-closed）
      await adminPerm.applyManage(this, 'user.manage');
      // ⚠️ 不要传 undefined 值的参数（用户 2026-10-27 报「待研判 85 条但列表是空的」）。
      //   wx.request 在 GET 时把 data 拼成 query，而 `{ keyword: undefined }` 的**键仍然存在**，
      //   微信会序列化成字面量 `keyword=undefined` → 服务端当成真关键字，
      //   去匹配「姓名/学号/班级里含 undefined」→ total=0、列表全空。
      //   而 counts（待研判 85）走的是**不加 keyword 的独立 count**，所以徽章仍有数字 ——
      //   两个数字对不上，界面就自相矛盾了（这正是截图里的现象）。
      //   正确做法：只在真有关键字时才带上它。
      const query = { status: this.data.tab, limit: 50 };
      const kw = String(this.data.keyword || '').trim();
      if (kw) query.keyword = kw;
      const res = await auth.get('/api/admin/step-anomalies', query);
      const list = (res.list || []).map((r) => ({
        ...r,
        statusInfo: STATUS[r.status] || { text: r.status, theme: 'default' },
        // 命中原因直接拼成一行，管理员不用点开就知道为什么可疑
        reasonText: (r.reasons || []).join(' · ') || '—',
        scoreText: String(r.score || 0),
        stepsText: Number(r.cumulativeSteps || 0).toLocaleString('zh-CN'),
        deltaText: Number(r.deltaSteps || 0).toLocaleString('zh-CN'),
        // 模型分（0~1）：0.5 是「与人群一样正常」的基准线。
        // 显示到两位小数，管理员能看出「这条主要是学习模型判的还是硬规则判的」。
        modelScoreText:
          r.modelScore == null || !Number.isFinite(Number(r.modelScore))
            ? ''
            : Number(r.modelScore).toFixed(2),
        // 来源分流：微信同步与 GPS 是两套模型，列表必须能区分
        sourceText: r.sourceText || (r.source === 'gps' ? 'GPS 实跑' : '微信同步'),
        source: r.source || 'werun',
      }));
      this.setData({
        list,
        counts: res.counts || this.data.counts,
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  // ===== 手动封禁 =====
  openBan(e) {
    if (!this.data.canManage) return;
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name || '';
    this.setData({
      banSheetVisible: true,
      banTargetId: id,
      banTargetName: name,
      banDays: 7,
      banNote: '',
    });
  },

  closeBan() {
    this.setData({ banSheetVisible: false, banSaving: false });
  },

  onBanDays(e) {
    this.setData({ banDays: Number(e.currentTarget.dataset.days) || 7 });
  },

  onBanNote(e) {
    this.setData({ banNote: (e.detail && e.detail.value) || '' });
  },

  async submitBan() {
    if (!this.data.canManage || this.data.banSaving) return;
    const { banTargetId, banDays, banNote } = this.data;
    if (!banTargetId) return;
    this.setData({ banSaving: true });
    try {
      const r = await auth.post(`/api/admin/step-anomalies/${banTargetId}/ban`, {
        days: banDays,
        note: banNote,
      });
      this.setData({ banSheetVisible: false, banSaving: false });
      wx.showModal({
        title: '已封禁',
        content: `已限制该账号微信同步 ${r.days} 天。${r.reason ? `原因：${r.reason}` : ''}`,
        showCancel: false,
      });
      this.load();
    } catch (err) {
      this.setData({ banSaving: false });
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    }
  },

  // ===== 标记为正常 =====
  dismiss(e) {
    if (!this.data.canManage) return;
    const id = e.currentTarget.dataset.id;
    const that = this;
    wx.showModal({
      title: '标记为正常',
      content: '确认该记录不是异常？标记后将从待研判列表移除。',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.post(`/api/admin/step-anomalies/${id}/dismiss`, {});
          wx.showToast({ title: '已标记', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },
});
