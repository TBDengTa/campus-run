const section = require('./section');

// 跑分设置（系统配置子页）：与 config/anticheat、config/reward-video 同款写法与权限判断
// （config.view 查看 / config.manage 保存，均由 section 与 /api/admin/config 负责）
// 只编辑本组键（points），保存只回传本组，服务端按白名单合并本组字段。
// 口径唯一来源 server/src/services/points.js（本页只做同公式的实时预览，不另立一套）：
//   日档位 = max(1, 个人日目标 × extraPercent%)       → 超出加分封顶 dailyExtraCap
//   周档位 = max(1, 个人周目标 × weeklyExtraPercent%)  → 超出加分仅当 weeklyExtraCap > 0 时封顶（0 = 不封顶）
//   perStep（固定步数档位）已**完全弃用**：日、周公式都不再读取，本页只做说明、不提供输入框。
Page({
  sectionKeys: ['points'],

  data: {
    config: null,
    saving: false,
    loading: true,
    // 旧配置（缺少 extraPercent / weeklyExtraPercent）的显式迁移提示，见 /api/admin/config
    legacy: null,
    legacyText: '',
    legacyAction: '',
    legacyWeeklyAction: '',
    // 档位换算说明：日（目标 6000 步 → 每多少步一档）/ 周（周目标 25000 步 → 每多少步一档）
    unitHint: '',
    weeklyUnitHint: '',
    // 公式预览（按当前输入实时算，避免管理员看不懂「每达成目标的 X% 加 1 分」）
    preview: [],
    weekPreview: [],
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
    let legacyWeeklyAction = '';
    if (legacy) {
      const old = legacy.perStep != null ? `旧字段 perStep = ${legacy.perStep} 步` : '旧配置没有 perStep';
      const parts = [];
      if (legacy.extraPercentMissing) {
        const goal = legacy.globalDailySteps ? `（全局日目标 ${legacy.globalDailySteps} 步）` : '';
        const same = legacy.legacyPercent ? `，与改造前的日跑分完全一致对应 ${legacy.legacyPercent}%` : '';
        parts.push(`日档位按目标的 ${legacy.extraPercent}% 生效${goal}${same}`);
        if (legacy.legacyPercent) legacyAction = `日填入 ${legacy.legacyPercent}%（与旧口径一致）`;
      }
      if (legacy.weeklyExtraPercentMissing) {
        const goal = legacy.globalWeeklySteps ? `（全局周目标 ${legacy.globalWeeklySteps} 步）` : '';
        const same = legacy.legacyWeeklyPercent ? `，与改造前的周跑分完全一致对应 ${legacy.legacyWeeklyPercent}%` : '';
        parts.push(`周档位按目标的 ${legacy.weeklyExtraPercent}% 生效${goal}${same}`);
        if (legacy.legacyWeeklyPercent) legacyWeeklyAction = `周填入 ${legacy.legacyWeeklyPercent}%（与旧口径一致）`;
      }
      legacyText = `${old}：${parts.join('；')}。perStep 已完全弃用（日、周公式都不再读取它），保存后本提示消失。`;
    }
    this.setData({ legacy, legacyText, legacyAction, legacyWeeklyAction }, () => this.buildPreview());
  },

  save() {
    const p = (this.data.config && this.data.config.points) || {};
    // 字段校验：两个百分比都必须是整数 1~100；单周上限是整数 0~1000（0 = 不封顶）
    // （服务端同样夹紧，见 routes/admin/config.js）
    const badPercent = [p.extraPercent, p.weeklyExtraPercent].some((v) => {
      const n = Number(v);
      return String(v == null ? '' : v).trim() === '' || !Number.isInteger(n) || n < 1 || n > 100;
    });
    if (badPercent) {
      wx.showToast({ title: '超出档位需填 1~100 的整数', icon: 'none' });
      return undefined;
    }
    const cap = Number(p.weeklyExtraCap);
    if (!Number.isInteger(cap) || cap < 0 || cap > 1000) {
      wx.showToast({ title: '单周上限需填 0~1000 的整数（0 = 不封顶）', icon: 'none' });
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

  // 百分比字段（日 extraPercent / 周 weeklyExtraPercent）：数字输入框给的是字符串，转成整数存入
  // （空串保留为 ''，保存时会被上面的校验拦下）
  onPercent(e) {
    const { field } = e.currentTarget.dataset;
    const raw = String(e.detail.value == null ? '' : e.detail.value).trim();
    const n = Number(raw);
    const value = raw === '' || !Number.isFinite(n) ? '' : Math.round(n);
    this.setData({ [`config.points.${field}`]: value }, () => {
      this.buildPreview();
    });
  },

  // 一键采用「与旧口径等价」的日百分比（= 旧 perStep 占全局日目标的百分比）
  useLegacyPercent() {
    const legacy = this.data.legacy;
    if (!legacy || legacy.legacyPercent == null) return;
    this.setData({ 'config.points.extraPercent': legacy.legacyPercent }, () => {
      this.buildPreview();
      wx.showToast({ title: `日档位已填入 ${legacy.legacyPercent}%（与旧口径一致）`, icon: 'none' });
    });
  },

  // 一键采用「与旧口径等价」的周百分比（= 旧 perStep 占全局周目标的百分比）
  useLegacyWeeklyPercent() {
    const legacy = this.data.legacy;
    if (!legacy || legacy.legacyWeeklyPercent == null) return;
    this.setData({ 'config.points.weeklyExtraPercent': legacy.legacyWeeklyPercent }, () => {
      this.buildPreview();
      wx.showToast({ title: `周档位已填入 ${legacy.legacyWeeklyPercent}%（与旧口径一致）`, icon: 'none' });
    });
  },

  // 公式预览：与 server/src/services/points.js 的 pointsForDay / pointsForWeek 完全一致。
  // 档位随个人目标缩放：日/周各列多个目标，直观看到「目标越大，一档步数越大」。
  buildPreview() {
    const c = (this.data.config && this.data.config.points) || {};
    const dailyGoal = Number(c.dailyGoal) || 0;
    const weeklyGoal = Number(c.weeklyGoal) || 0;
    const extraPercent = Number(c.extraPercent) || 0;
    const weeklyExtraPercent = Number(c.weeklyExtraPercent) || 0;
    const perStepScore = Number(c.perStepScore) || 0;
    const cap = Number(c.dailyExtraCap) || 0;
    const weekCap = Number(c.weeklyExtraCap) || 0;
    const unit = (goal) => Math.max(1, (goal * extraPercent) / 100);
    const weekUnit = (goal) => Math.max(1, (goal * weeklyExtraPercent) / 100);
    const unitText = (goal) => Math.round(unit(goal)); // 仅展示用（整数百分比 × 整数目标必为整数）
    const weekUnitText = (goal) => Math.round(weekUnit(goal));
    // 日：达标基础分 + min(超出加分, 单日上限)
    const calc = (steps, goal) => {
      if (goal <= 0) return 0;
      const extra =
        extraPercent > 0 && perStepScore > 0 ? Math.floor(Math.max(0, steps - goal) / unit(goal)) * perStepScore : 0;
      return (steps >= goal ? dailyGoal : 0) + Math.min(extra, cap);
    };
    // 周：达标基础分 + 超出加分（weekCap > 0 才封顶，0 = 不封顶）
    const calcWeek = (steps, goal) => {
      if (goal <= 0) return 0;
      const extra =
        weeklyExtraPercent > 0 && perStepScore > 0
          ? Math.floor(Math.max(0, steps - goal) / weekUnit(goal)) * perStepScore
          : 0;
      return (steps >= goal ? weeklyGoal : 0) + (weekCap > 0 ? Math.min(extra, weekCap) : extra);
    };
    this.setData({
      unitHint: extraPercent > 0 ? `目标 6000 步 → 每 ${unitText(6000)} 步一档` : '请填 1~100 的整数',
      weeklyUnitHint: weeklyExtraPercent > 0 ? `周目标 25000 步 → 每 ${weekUnitText(25000)} 步一档` : '请填 1~100 的整数',
      preview: [
        { key: 'a', label: '日目标 5000 步 · 恰好达标', value: calc(5000, 5000) },
        { key: 'b', label: `日目标 6000 步 · 超出 ${unitText(6000)} 步（一档）`, value: calc(6000 + unit(6000), 6000) },
        { key: 'c', label: `日目标 10000 步 · 超出 ${unitText(10000)} 步（一档）`, value: calc(10000 + unit(10000), 10000) },
        { key: 'd', label: `日目标 15000 步 · 超出 ${unitText(15000)} 步（一档）`, value: calc(15000 + unit(15000), 15000) },
        { key: 'e', label: '日目标 5000 步 · 超出 20 档（触顶）', value: calc(5000 + unit(5000) * 20, 5000) },
        { key: 'f', label: '日目标 5000 步 · 未达标 3000 步', value: calc(3000, 5000) },
      ],
      weekPreview: [
        { key: 'w1', label: '周目标 15000 步 · 恰好达标', value: calcWeek(15000, 15000) },
        { key: 'w2', label: `周目标 15000 步 · 超出 ${weekUnitText(15000)} 步（一档）`, value: calcWeek(15000 + weekUnit(15000), 15000) },
        { key: 'w3', label: `周目标 25000 步 · 超出 ${weekUnitText(25000)} 步（一档）`, value: calcWeek(25000 + weekUnit(25000), 25000) },
        { key: 'w4', label: `周目标 40000 步 · 超出 ${weekUnitText(40000)} 步（一档）`, value: calcWeek(40000 + weekUnit(40000), 40000) },
        { key: 'w5', label: '周目标 25000 步 · 周步数 43097（原固定步数口径为 38 分）', value: calcWeek(43097, 25000) },
        { key: 'w6', label: '周目标 25000 步 · 超出 20 档（单周上限生效时触顶）', value: calcWeek(25000 + weekUnit(25000) * 20, 25000) },
        { key: 'w7', label: '周目标 25000 步 · 未达标 10000 步', value: calcWeek(10000, 25000) },
      ],
    });
  },
});
