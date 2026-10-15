const section = require('./section');

// 跑分设置（系统配置子页）：与 config/anticheat、config/reward-video 同款写法与权限判断
// （config.view 查看 / config.manage 保存，均由 section 与 /api/admin/config 负责）
// 只编辑本组键（points），保存只回传本组，服务端按白名单合并本组字段
Page({
  sectionKeys: ['points'],

  data: {
    config: null,
    saving: false,
    loading: true,
    // 旧配置（只有已弃用的 perStep、没有 extraPercent）的显式迁移提示，见 /api/admin/config
    legacy: null,
    legacyText: '',
    legacyAction: '',
    // 档位换算说明（示例目标 6000 步 → 每多少步一档）
    unitHint: '',
    // 公式预览（按当前输入实时算，避免管理员看不懂「每达成目标的 X% 加 1 分」）
    preview: [],
  },

  onShow() {
    this.checkAndLoad();
  },

  async checkAndLoad() {
    await section.checkAndLoad(this);
    if (!this.data.config) return;
    const legacy = this.data.config.pointsLegacy || null;
    // 提示文案在 JS 里拼好（WXML 只做插值，避免长三元表达式）
    let legacyText = '';
    let legacyAction = '';
    if (legacy) {
      const old = legacy.perStep != null ? `旧字段 perStep = ${legacy.perStep} 步` : '旧配置没有 perStep';
      const global = legacy.globalDailySteps ? `，当前全局日目标 ${legacy.globalDailySteps} 步` : '';
      const same = legacy.legacyPercent ? `；若要与改造前的日跑分完全一致，请填 ${legacy.legacyPercent}%` : '';
      legacyText = `日超出档位已从「固定步数」改为「个人目标的百分比」：${old}${global}，新版按目标的 ${legacy.extraPercent}% 生效${same}。perStep 已弃用（日公式不再读取；仅周跑分仍在用），保存后本提示消失。`;
      if (legacy.legacyPercent) legacyAction = `填入 ${legacy.legacyPercent}%（与旧口径一致）`;
    }
    this.setData({ legacy, legacyText, legacyAction }, () => this.buildPreview());
  },

  save() {
    const pct = Number((this.data.config && this.data.config.points && this.data.config.points.extraPercent));
    // 字段校验：整数 1~100（服务端同样夹紧，见 routes/admin/config.js）
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
      wx.showToast({ title: '超出档位需填 1~100 的整数', icon: 'none' });
      return undefined;
    }
    return section.save(this);
  },

  onPoints(e) {
    const { field } = e.currentTarget.dataset;
    const value = e.detail.value;
    this.setData({ [`config.points.${field}`]: typeof value === 'boolean' ? value : Number(value) || 0 }, () => {
      this.buildPreview();
    });
  },

  // 百分比字段：数字输入框给的是字符串，转成整数存入（空串保留为 ''，保存时会被上面的校验拦下）
  onExtraPercent(e) {
    const raw = String(e.detail.value == null ? '' : e.detail.value).trim();
    const n = Number(raw);
    const value = raw === '' || !Number.isFinite(n) ? '' : Math.round(n);
    this.setData({ 'config.points.extraPercent': value }, () => {
      this.buildPreview();
    });
  },

  // 一键采用「与旧口径等价」的百分比（= 旧 perStep 占全局日目标的百分比）
  useLegacyPercent() {
    const legacy = this.data.legacy;
    if (!legacy || legacy.legacyPercent == null) return;
    this.setData({ 'config.points.extraPercent': legacy.legacyPercent }, () => {
      this.buildPreview();
      wx.showToast({ title: `已填入 ${legacy.legacyPercent}%（与旧口径一致）`, icon: 'none' });
    });
  },

  // 公式预览：达标基础分 + min(超出加分, 单日上限)，与 services/points.js 完全一致
  // 档位步数 = max(1, 个人目标 × extraPercent%)：多个不同目标各给一行，直观看到「目标越大档位越大」
  buildPreview() {
    const c = (this.data.config && this.data.config.points) || {};
    const dailyGoal = Number(c.dailyGoal) || 0;
    const extraPercent = Number(c.extraPercent) || 0;
    const perStepScore = Number(c.perStepScore) || 0;
    const cap = Number(c.dailyExtraCap) || 0;
    const unit = (goal) => Math.max(1, (goal * extraPercent) / 100);
    const unitText = (goal) => Math.round(unit(goal)); // 仅展示用（整数百分比 × 整数目标必为整数）
    const calc = (steps, goal) => {
      if (goal <= 0) return 0;
      const extra =
        extraPercent > 0 && perStepScore > 0 ? Math.floor(Math.max(0, steps - goal) / unit(goal)) * perStepScore : 0;
      return (steps >= goal ? dailyGoal : 0) + Math.min(extra, cap);
    };
    this.setData({
      unitHint: extraPercent > 0 ? `目标 6000 步 → 每 ${unitText(6000)} 步一档` : '请填 1~100 的整数',
      preview: [
        { key: 'a', label: '目标 5000 步 · 恰好达标', value: calc(5000, 5000) },
        { key: 'b', label: `目标 6000 步 · 超出 ${unitText(6000)} 步（一档）`, value: calc(6000 + unit(6000), 6000) },
        { key: 'c', label: `目标 10000 步 · 超出 ${unitText(10000)} 步（一档）`, value: calc(10000 + unit(10000), 10000) },
        { key: 'd', label: `目标 15000 步 · 超出 ${unitText(15000)} 步（一档）`, value: calc(15000 + unit(15000), 15000) },
        { key: 'e', label: '目标 5000 步 · 超出 20 档（触顶）', value: calc(5000 + unit(5000) * 20, 5000) },
        { key: 'f', label: '目标 5000 步 · 未达标 3000 步', value: calc(3000, 5000) },
      ],
    });
  },
});
