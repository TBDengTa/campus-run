const section = require('./section');

/**
 * AI 严谨度档位（用户 2026-10-28「在反作弊中可以调整 AI 封禁的严谨程度」）。
 *
 * 与服务端 services/anticheat-model.js::STRICTNESS_PRESETS 逐字对应 ——
 * 这里的数字只用于**预览展示**，真正生效的阈值以服务端为准（服务端还要叠加在线校准）。
 * 改档位时两处必须同时改（契约里有断言）。
 */
const STRICTNESS_OPTIONS = [
  {
    key: 'loose',
    label: '宽松',
    desc: '只封明显作弊，宁漏不误伤。适合开学初 / 大型活动期间',
    suspicious: 0.72,
    autoBan: 0.88,
  },
  {
    key: 'balanced',
    label: '平衡',
    desc: '默认档位，与历史校准基线一致',
    suspicious: 0.62,
    autoBan: 0.78,
  },
  {
    key: 'strict',
    label: '严格',
    desc: '宁可多抓，接受少量误伤。需要有人手复核待研判记录',
    suspicious: 0.52,
    autoBan: 0.68,
  },
  {
    key: 'custom',
    label: '自定义',
    desc: '手调两个阈值（高级用法）',
    suspicious: 0.62,
    autoBan: 0.78,
  },
];

Page({
  // 步数异常记录（用户 2026-10-27）：可疑但未自动封禁的记录查看 + 手动封禁
  goAnomalies() {
    wx.navigateTo({ url: '/packageAdmin/config/anomalies/anomalies' });
  },

  sectionKeys: ['anticheat'],

  data: {
    // 写权限（用户 2026-10-22）：由 section.js 在 checkAndLoad 里 setData 注入；
    // 只读用户（仅 config.view）看不到保存按钮、输入框禁用。
    canManage: false,
    config: null,
    saving: false,
    loading: true,
    // AI 严谨度（用户 2026-10-28）
    aiStrictnessOptions: STRICTNESS_OPTIONS,
    aiPreview: { suspicious: 0.62, autoBan: 0.78 },
  },

  onShow() {
    section.onShow(this);
  },

  checkAndLoad() {
    return section.checkAndLoad(this).then((r) => {
      this.refreshAiPreview();
      return r;
    });
  },

  save() {
    return section.save(this).then((r) => {
      this.refreshAiPreview();
      return r;
    });
  },

  onAnticheat(e) {
    const { field } = e.currentTarget.dataset;
    const value = e.detail.value;
    this.setData(
      { [`config.anticheat.${field}`]: typeof value === 'boolean' ? value : Number(value) || 0 },
      () => this.refreshAiPreview()
    );
  },

  // 选严谨度档位（写入口，只读用户点了无效）
  onPickStrictness(e) {
    if (!this.data.canManage) {
      wx.showToast({ title: '只有查看权限，不能修改', icon: 'none' });
      return;
    }
    const key = String((e.currentTarget.dataset || {}).key || '');
    if (!STRICTNESS_OPTIONS.some((o) => o.key === key)) return;
    this.setData({ 'config.anticheat.aiStrictness': key }, () => this.refreshAiPreview());
  },

  // 刷新「当前生效阈值」的预览文案
  //
  // 注意：这里算的是**档位基线**，服务端还会叠加在线校准（±0.06 封顶）。
  // 文案里写「当前生效」而不是「精确值」，避免管理员拿它当作绝对真值去核对。
  refreshAiPreview() {
    const ac = (this.data.config && this.data.config.anticheat) || {};
    const mode = ac.aiStrictness || 'balanced';
    const preset = STRICTNESS_OPTIONS.find((o) => o.key === mode) || STRICTNESS_OPTIONS[1];
    let suspicious = preset.suspicious;
    let autoBan = preset.autoBan;
    if (mode === 'custom') {
      // 与服务端同样的钳位：0.3~0.95 / 0.4~0.99，且 autoBan 至少比 suspicious 高 0.02
      const s = Number(ac.aiSuspiciousThreshold);
      const a = Number(ac.aiAutoBanThreshold);
      suspicious = Number.isFinite(s) ? Math.min(0.95, Math.max(0.3, s)) : 0.62;
      autoBan = Number.isFinite(a) ? Math.min(0.99, Math.max(0.4, a)) : 0.78;
      autoBan = Math.max(suspicious + 0.02, autoBan);
    }
    this.setData({ aiPreview: { suspicious: suspicious.toFixed(2), autoBan: autoBan.toFixed(2) } });
  },
});
