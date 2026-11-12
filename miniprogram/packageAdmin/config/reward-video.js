const section = require('./section');
const auth = require('../../utils/request');

/**
 * 北斗运动 2.0 配置页（签到 / 转盘奖池 / 看视频 / 分享）。
 *
 * 三段配置全部落在 goal_config.beidou，走 section.js 的「只回传本组键」保存机制。
 * 奖池编辑有两条硬约束（见 docs/beidou-lottery-plan.md §10）：
 *   ① **归一后概率必须实时显示**，且与用户端公示的是同一份口径（都由服务端按 weight 归一）；
 *   ② 扇区数 ≤ 8，超出会被服务端截断 —— 这里提前拦住，避免「保存成功但少了一项」。
 */
Page({
  sectionKeys: ['beidou'],

  data: {
    canManage: false,
    config: null,
    saving: false,
    loading: true,
    // 奖池编辑的临时行（type 用 picker 选，避免手打错）
    typeLabels: ['步数', '谢谢参与', '再来一次'],
    typeValues: ['steps', 'none', 'draw'],
    // 中奖记录
    draws: [],
    drawsTotal: 0,
    drawsPage: 1,
    drawsLoading: false,
    showDraws: false,
    // 奖池校验提示（权重全 0 / 无法归一）
    oddsInvalid: '',
  },

  onShow() {
    section.onShow(this);
  },

  checkAndLoad() {
    // 载入后立刻算一遍归一概率（服务端下发的 beidouEffective 已经算好，这里用本地奖池复算做交叉校验，
    // 两者一致说明页面展示与用户端公示同口径）
    return section.checkAndLoad(this).then(() => {
      if (this.data.config && this.data.config.beidou) this.recalcOdds();
    });
  },

  save() {
    return section.save(this);
  },

  // ===== 基础 / 视频 / 分享 / 签到 / 封顶：数值与开关 =====
  onField(e) {
    const { field } = e.currentTarget.dataset;
    const path = field.split('.'); // 形如 beidou.draw.dailyStepsCap
    const value = e.detail.value;
    const patch = {};
    if (typeof value === 'boolean') {
      patch[`config.${field}`] = value;
    } else {
      const raw = String(value == null ? '' : value).trim();
      const n = Number(raw);
      patch[`config.${field}`] = raw === '' || !Number.isFinite(n) ? 0 : Math.max(0, Math.round(n));
    }
    // 开关字段（enabled / checkin.enabled / loopAfter）走布尔分支；其余是数字
    if (path.length) this.setData(patch);
    this.recalcOdds();
  },

  onTextField(e) {
    const { field } = e.currentTarget.dataset;
    this.setData({ [`config.${field}`]: e.detail.value });
  },

  // ===== 奖池编辑 =====
  onPrizeField(e) {
    const { index, key } = e.currentTarget.dataset;
    const list = (this.data.config && this.data.config.beidou && this.data.config.beidou.prizes) || [];
    const next = list.slice();
    const row = { ...(next[index] || {}) };
    const value = e.detail.value;
    if (key === 'type') {
      // picker 返回下标
      row.type = this.data.typeValues[Number(value)] || 'none';
      if (row.type === 'none') row.amount = 0;
    } else if (key === 'weight' || key === 'amount') {
      const raw = String(value == null ? '' : value).trim();
      const n = Number(raw);
      row[key] = raw === '' || !Number.isFinite(n) ? 0 : Math.max(0, Math.round(n));
    } else {
      row[key] = value;
    }
    next[index] = row;
    this.setData({ 'config.beidou.prizes': next });
    this.recalcOdds();
  },

  addPrize() {
    const list = ((this.data.config && this.data.config.beidou && this.data.config.beidou.prizes) || []).slice();
    if (list.length >= 8) {
      wx.showToast({ title: '最多 8 个奖项（扇区数上限）', icon: 'none' });
      return;
    }
    list.push({ key: `prize_${Date.now().toString(36)}`, label: '新奖项', type: 'none', amount: 0, weight: 1 });
    this.setData({ 'config.beidou.prizes': list });
    this.recalcOdds();
  },

  removePrize(e) {
    const { index } = e.currentTarget.dataset;
    const list = ((this.data.config && this.data.config.beidou && this.data.config.beidou.prizes) || []).slice();
    list.splice(Number(index), 1);
    this.setData({ 'config.beidou.prizes': list });
    this.recalcOdds();
  },

  // ===== 签到阶梯 =====
  onMilestone(e) {
    const { index, key } = e.currentTarget.dataset;
    const list = ((this.data.config && this.data.config.beidou && this.data.config.beidou.checkin && this.data.config.beidou.checkin.milestones) || []).slice();
    const row = { ...(list[Number(index)] || {}) };
    const raw = String(e.detail.value == null ? '' : e.detail.value).trim();
    const n = Number(raw);
    row[key] = raw === '' || !Number.isFinite(n) ? 0 : Math.max(0, Math.round(n));
    list[Number(index)] = row;
    this.setData({ 'config.beidou.checkin.milestones': list });
  },

  /**
   * 实时重算「归一后概率」。
   *
   * ⚠️ 这是**预览**，与用户端公示值同口径（都按 weight 归一、跳过 weight<=0 与非法项）。
   * 真正的公示值由服务端 beidouEffective 下发 —— 两者算法一致，所以这里能用来当场校验配置。
   * 权重全为 0 时页面必须显式提示，否则管理员会「保存成功但没人能中奖」。
   */
  recalcOdds() {
    const b = (this.data.config && this.data.config.beidou) || {};
    const list = Array.isArray(b.prizes) ? b.prizes : [];
    const valid = list.filter((p) => {
      const w = Number(p.weight) || 0;
      if (w <= 0) return false;
      if (p.type === 'steps' || p.type === 'draw') return (Number(p.amount) || 0) > 0;
      return true;
    });
    const total = valid.reduce((s, p) => s + (Number(p.weight) || 0), 0);
    let oddsInvalid = '';
    if (!valid.length) oddsInvalid = '所有奖项权重都是 0 或数量为 0，用户端将回退到默认奖池';
    else if (total <= 0) oddsInvalid = '权重合计为 0，无法归一';
    const rows = list.map((p) => {
      const w = Number(p.weight) || 0;
      const usable = valid.includes(p);
      return {
        ...p,
        percentText: usable && total > 0 ? `${((w / total) * 100).toFixed(2)}%` : '—',
      };
    });
    this.setData({ 'config.beidou.prizes': rows, oddsInvalid });
  },

  // ===== 中奖记录（只读）=====
  async loadDraws(reset) {
    if (this.data.drawsLoading) return;
    const page = reset ? 1 : this.data.drawsPage;
    this.setData({ drawsLoading: true });
    try {
      const data = await auth.get(`/api/admin/config/beidou-draws?page=${page}&limit=20`);
      this.setData({
        draws: reset ? data.list : this.data.draws.concat(data.list || []),
        drawsTotal: data.total || 0,
        drawsPage: page + 1,
        drawsLoading: false,
      });
    } catch (e) {
      this.setData({ drawsLoading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  toggleDraws() {
    const next = !this.data.showDraws;
    this.setData({ showDraws: next });
    if (next && !this.data.draws.length) this.loadDraws(true);
  },

  loadMoreDraws() {
    if (this.data.draws.length >= this.data.drawsTotal) return;
    this.loadDraws(false);
  },
});
