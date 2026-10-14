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
    // 公式预览（按当前输入实时算，避免管理员看不懂「每 1000 步加 1 分」）
    preview: [],
  },

  onShow() {
    this.checkAndLoad();
  },

  async checkAndLoad() {
    await section.checkAndLoad(this);
    if (this.data.config) this.buildPreview();
  },

  save() {
    return section.save(this);
  },

  onPoints(e) {
    const { field } = e.currentTarget.dataset;
    const value = e.detail.value;
    this.setData({ [`config.points.${field}`]: typeof value === 'boolean' ? value : Number(value) || 0 }, () => {
      this.buildPreview();
    });
  },

  // 公式预览：达标基础分 + min(超出加分, 单日上限)，与 services/points.js 完全一致
  buildPreview() {
    const c = (this.data.config && this.data.config.points) || {};
    const dailyGoal = Number(c.dailyGoal) || 0;
    const perStep = Number(c.perStep) || 0;
    const perStepScore = Number(c.perStepScore) || 0;
    const cap = Number(c.dailyExtraCap) || 0;
    const calc = (steps, goal) => {
      if (goal <= 0) return 0;
      const extra = perStep > 0 ? Math.floor(Math.max(0, steps - goal) / perStep) * perStepScore : 0;
      return (steps >= goal ? dailyGoal : 0) + Math.min(extra, cap);
    };
    this.setData({
      preview: [
        { key: 'a', label: '刚好达标 5000 步', value: calc(5000, 5000) },
        { key: 'b', label: '超出 1000 步', value: calc(6000, 5000) },
        { key: 'c', label: '超出 15000 步', value: calc(20000, 5000) },
        { key: 'd', label: '未达标 3000 步', value: calc(3000, 5000) },
      ],
    });
  },
});
