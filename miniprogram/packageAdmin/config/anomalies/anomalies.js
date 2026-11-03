const auth = require('../../../utils/request');
// 权限（用户 2026-11-03 小程序适配判定/处置分组）：能力表由服务端列表接口下发
// （caps.label = 可标注/归档，caps.ban = 可封禁），缺省 false 按只读渲染（fail-closed）；
// 鉴权仍在服务端各写路由，这里只控显隐 —— 与 check-write-guard 的 caps.* 守卫约定一致。
const adminPerm = require('../../../utils/admin-perm');

// 状态标签：open 待研判 / judged 已判定·待处置（标了作弊/轻微但未处置）/ banned / dismissed。
// 文案与 Web 控制台 statusPill 同一份语义，不要两头漂移。
const STATUS = {
  open: { text: '待研判', theme: 'warning' },
  judged: { text: '已判定 · 待处置', theme: 'warning' },
  banned: { text: '已封禁', theme: 'danger' },
  dismissed: { text: '已排除', theme: 'default' },
};

// 「已判定·待处置」徽标色用警示（区别于纯待研判的默认黄）：这里复用 warning 主题，
// 靠文案区分即可，不再多造一种颜色。

function statusOf(r) {
  if (r.status === 'banned') return STATUS.banned;
  if (r.status === 'dismissed') return STATUS.dismissed;
  if (r.label === 'cheat' || r.label === 'minor') return STATUS.judged;
  return STATUS.open;
}

const pad2 = (x) => (x < 10 ? '0' + x : String(x));
// 秒 → 18'22" / 1:02:03（与 Web 控制台 durText 同一口径）
function durText(sec) {
  const v = Math.round(Number(sec) || 0);
  if (v <= 0) return '—';
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = v % 60;
  if (h > 0) return h + ':' + pad2(m) + ':' + pad2(s);
  return m + "'" + pad2(s) + '"';
}

Page({
  data: {
    tab: 'open',
    list: [],
    loading: false,
    // 能力表（服务端下发；缺省只读）
    caps: { label: false, ban: false },
    // canManage 保留 user.manage 兜底（弹层「确定封禁」按钮的 disabled 仍引用它；
    // 真正的显隐已由 caps 驱动，两者并存的过渡期不改变鉴权语义）
    canManage: false,
    // 判定四分类按钮（文案由服务端 labelText 下发，首包后填充）
    labelBtns: [
      { kind: 'normal', text: '正常' },
      { kind: 'device', text: '设备/网络' },
      { kind: 'minor', text: '轻微违规' },
      { kind: 'cheat', text: '作弊' },
    ],
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
      // 兜底写权限（user.manage）：真正的按钮显隐由服务端下发的 caps 驱动
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

      // 判定按钮文案：以服务端下发为准（与 Web 台 / 训练集同一份 LABEL_TEXT）
      const kinds = (res.labelKinds || []).length ? res.labelKinds : this.data.labelBtns.map((b) => b.kind);
      const text = res.labelText || {};
      const labelBtns = kinds.map((k) => ({ kind: k, text: text[k] || k }));

      const list = (res.list || []).map((r) => ({
        ...r,
        statusInfo: statusOf(r),
        // 命中原因直接拼成一行，管理员不用点开就知道为什么可疑
        reasonText: (r.reasons || []).join(' · ') || '—',
        scoreText: String(r.score || 0),
        stepsText: Number(r.cumulativeSteps || 0).toLocaleString('zh-CN'),
        deltaText: Number(r.deltaSteps || 0).toLocaleString('zh-CN'),
        // 同步/判定时间（用户 2026-11-03「增加记录时的同步时间」）：
        // anomaly 的 createdAt 就是本次同步被判定的时刻
        timeText: r.createdAt ? String(r.createdAt).slice(5, 16).replace('T', ' ') : '',
        // 模型分（0~1）：0.5 是「与人群一样正常」的基准线。
        // 显示到两位小数，管理员能看出「这条主要是学习模型判的还是硬规则判的」。
        modelScoreText:
          r.modelScore == null || !Number.isFinite(Number(r.modelScore))
            ? ''
            : Number(r.modelScore).toFixed(2),
        // 来源分流：微信同步与 GPS 是两套模型，列表必须能区分
        sourceText: r.sourceText || (r.source === 'gps' ? 'GPS 实跑' : '微信同步'),
        source: r.source || 'werun',
        // 当日同步历史（增速研判）：默认收起，点开懒加载
        histOpen: false,
        histRows: null,
        histSummaryText: '',
      }));
      this.setData({
        list,
        labelBtns,
        caps: res.caps || { label: false, ban: false },
        counts: res.counts || this.data.counts,
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  // ===== ① 判定（四分类，喂 AI 训练） =====
  // 与 Web 控制台同一语义：正常/设备 = 无需处置 → 移出待研判；作弊/轻微 = 留在队列等处置。
  // toast 必须说明去向，否则用户以为没生效（用户 2026-11-02 的教训）。
  async label(e) {
    if (!this.data.caps.label) return;
    const { id, kind } = e.currentTarget.dataset;
    try {
      const r = await auth.post(`/api/admin/step-anomalies/${id}/label`, { label: kind });
      const dest =
        r.status === 'dismissed' ? '移出待研判' : r.status === 'banned' ? '已封禁' : '待处置（封禁或归档）';
      wx.showToast({ title: `已判定「${r.labelText || kind}」→ ${dest}`, icon: 'none' });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message || '标注失败', icon: 'none' });
    }
  },

  // ===== ② 处置 · 归档（记录违规，不封禁，移出队列） =====
  archive(e) {
    if (!this.data.caps.label) return;
    const id = e.currentTarget.dataset.id;
    const that = this;
    wx.showModal({
      title: '归档 · 不封禁',
      content: '记录该违规并移出待研判队列，但不限制该学生。确认归档？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.post(`/api/admin/step-anomalies/${id}/archive`, {});
          wx.showToast({ title: '已归档（记录违规·不封禁）', icon: 'none' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message || '归档失败', icon: 'none' });
        }
      },
    });
  },

  // ===== 当日同步历史（增速研判）：点开懒加载 =====
  // 展示字段一律 JS 预计算（timeText/stepsText/intervalText/rateText），模板不写三元拼接。
  async toggleHist(e) {
    const id = e.currentTarget.dataset.id;
    const item = (this.data.list || []).find((x) => x.id === id);
    if (!item) return;
    if (item.histOpen || item.histRows) {
      // 已加载过：只切换收起/展开，不再发请求
      this.setData({ [`list[${(this.data.list || []).indexOf(item)}].histOpen`]: !item.histOpen });
      return;
    }
    try {
      const r = await auth.get(`/api/admin/step-anomalies/${id}/sync-history`);
      const rows = (r.rows || []).map((h) => {
        const t = h.at ? new Date(h.at) : null;
        const valid = t && !isNaN(t.getTime());
        return {
          timeText: valid ? pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds()) : '—',
          stepsText: Number(h.steps || 0).toLocaleString('zh-CN'),
          intervalText: h.intervalSec == null ? '—' : durText(h.intervalSec),
          // 窗口过短不给增速数字（判定也不看它，微信步数有分钟级聚合延迟）
          rateText: h.short ? '窗口短' : h.perSec == null ? '—' : Number(h.perSec).toFixed(1) + ' 步/秒',
          short: !!h.short,
          fast: !h.short && h.perSec != null && Number(h.perSec) >= 15,
        };
      });
      const s = r.summary || {};
      this.setData({
        [`list[${(this.data.list || []).indexOf(item)}].histOpen`]: true,
        [`list[${(this.data.list || []).indexOf(item)}].histRows`]: rows,
        [`list[${(this.data.list || []).indexOf(item)}].histSummaryText`]:
          `当日 ${s.syncs || 0} 次同步 · 高增速(≥15步/秒) ${s.fastSyncs || 0} 次`,
      });
    } catch (err) {
      wx.showToast({ title: err.message || '历史加载失败', icon: 'none' });
    }
  },

  // ===== 手动封禁 =====
  openBan(e) {
    if (!this.data.caps.ban) return;
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
    if (!this.data.caps.ban || this.data.banSaving) return;
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
});
