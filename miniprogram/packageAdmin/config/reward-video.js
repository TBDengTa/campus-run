const section = require('./section');
const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// 本地日历键 YYYY-MM-DD（日期 picker 的 end 上界用；不允许选未来）
function todayKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// 奖品 key → 展示名（筛选回显用；找不到就显示 key，不吞掉信息）
function prizeLabelOf(prizes, key) {
  if (!key) return '';
  const hit = (prizes || []).find((p) => p.key === key);
  return hit ? hit.label : key;
}

/**
 * 中奖明细行的展示字段（模块级纯函数，便于运行时自检直接调用）。
 *
 * 为什么在 JS 里拼而不是写进模板：仓库约定「含变量的整句一律 JS 预计算」——
 * 模板里写 `{{item.type === 'steps' ? ('+' + item.amount + ' 步') : ...}}`
 * 等于把服务端下发的 prizeLabel 又重拼一遍，管理员改了奖项名称后这里不会跟着变。
 */
function decorateDraws(list) {
  return (list || []).map((r) => {
    // 学号必须显示：本校姓名可重复（账号同名靠密码区分），只给姓名等于没法定位到人
    const whoSub = [r.studentId, r.className].filter(Boolean).join(' · ');
    return {
      ...r,
      whoSubText: whoSub,
      prizeText:
        r.prizeLabel
        || (r.type === 'steps' ? `${r.amount} 步` : r.type === 'draw' ? '再来一次' : '谢谢参与'),
      prizePrefix: r.type === 'steps' ? '+' : '',
      // 时间走 formatDateTime（北京时区），绝不从 ISO 串切片
      timeText: fmt.formatDateTime(r.createdAt) || r.date || '',
      sourceText: r.sourceText || '未记录',
    };
  });
}

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
    // 中奖记录筛选（用户 2026-11-12）：日期范围 / 抽奖来源 / 奖品
    drawFilter: { dateFrom: '', dateTo: '', source: '', prizeKey: '' },
    drawFilterActive: false,
    // 来源口径整句（服务端下发，页面只渲染；空则不显示，不编造一份）
    sourceNote: '',
    sourceFacets: [], // [{key,label,count}]
    prizeOptions: [],
    // labels/keys 都含首项「全部奖品」/''（与 onDrawPrize 的下标语义配套）
    prizeLabels: ['全部奖品'],
    prizeKeys: [''],
    drawFilterPrizeIndex: 0,
    drawFilterPrizeLabel: '',
    // 奖池校验提示（权重全 0 / 无法归一）
    oddsInvalid: '',
    // 日期 picker 上界（不允许选未来，否则永远筛出空）
    todayKeyText: todayKey(),
    // 奖品下拉当前文案（picker 不回填会一直显示「全部奖品」，误导管理员）
    drawFilterPrizeLabel: '',
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

  // ===== 中奖记录（只读 + 筛选）=====
  //
  // 三个筛选维度（用户 2026-11-12）：日期范围 / 抽奖来源 / 奖品。
  // ⚠️ 筛选条件一律由**服务端**执行（query 参数），前端只传不筛 ——
  //    前端本地筛选会让「共 N 条」与列表对不上，且翻页时越翻越少。
  async loadDraws(reset) {
    if (this.data.drawsLoading) return;
    const page = reset ? 1 : this.data.drawsPage;
    this.setData({ drawsLoading: true });
    try {
      // 组装查询串：空值不传（服务端把非法/空值当「不筛」）
      const f = this.data.drawFilter || {};
      const q = [`page=${page}`, 'limit=20'];
      if (f.dateFrom) q.push(`dateFrom=${encodeURIComponent(f.dateFrom)}`);
      if (f.dateTo) q.push(`dateTo=${encodeURIComponent(f.dateTo)}`);
      if (f.source) q.push(`source=${encodeURIComponent(f.source)}`);
      if (f.prizeKey) q.push(`prizeKey=${encodeURIComponent(f.prizeKey)}`);
      const data = await auth.get(`/api/admin/config/beidou-draws?${q.join('&')}`);
      // 明细字段一律在这里预计算：模板里不写三元拼接（服务端已下发 prizeLabel / sourceText，
      // 前端再拼一遍「+N 步」就是第二份口径，改了服务端文案页面不会跟着变）。
      const rows = decorateDraws(data.list || []);
      // 奖池候选只在第一次拿到（给奖品下拉用）
      const prizes = (data.facets && data.facets.prizes) || this.data.prizeOptions || [];
      // ⚠️ labels / keys 都必须在**最前面插一个「全部奖品」占位**，与 prizeKeys 下标一一对应。
      //    早先只 map 奖品本身、却在 onDrawPrize 里按「下标 0 = 全部」做 idx-1 偏移，
      //    于是整个下拉错位一格：选第一个奖品 = 不筛选、选第二个 = 筛中第一个，
      //    而且永远筛不到最后一个奖品 —— 不报错、只是结果一直是错的。
      const prizeLabels = ['全部奖品'].concat(prizes.map((p) => p.label));
      const prizeKeys = [''].concat(prizes.map((p) => p.key));
      this.setData({
        draws: reset ? rows : this.data.draws.concat(rows),
        drawsTotal: data.total || 0,
        drawsPage: page + 1,
        drawsLoading: false,
        // 分面计数：下拉里直接显示「视频 12」，避免选完才发现是空
        sourceFacets: (data.facets && data.facets.source) || [],
        prizeOptions: prizes,
        prizeLabels,
        prizeKeys,
        // 来源口径整句：服务端拼好下发（含扣减优先级）。页面不再硬编码顺序，
        // 否则 SOURCE_ORDER 一改，说明句就在骗管理员。
        sourceNote: data.sourceNote || this.data.sourceNote || '',
        // 有筛选时把「已筛」状态回显出来
        drawFilterActive: !!(f.dateFrom || f.dateTo || f.source || f.prizeKey),
        // 奖品下拉的当前文案与下标（picker 需要显式回填，否则每次打开都高亮第一项）
        drawFilterPrizeLabel: prizeLabelOf(prizes, f.prizeKey),
        drawFilterPrizeIndex: Math.max(0, prizeKeys.indexOf(f.prizeKey || '')),
      });
    } catch (e) {
      this.setData({ drawsLoading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  // 日期范围（两个 picker 共用，data-key 区分起止）
  onDrawDate(e) {
    const { key } = e.currentTarget.dataset;
    const val = e.detail.value || '';
    this.setData({ [`drawFilter.${key}`]: val });
    this.loadDraws(true);
  },

  // 来源 chips（点同一条再点一次 = 取消筛选）
  onDrawSource(e) {
    const { key } = e.currentTarget.dataset;
    const cur = (this.data.drawFilter || {}).source || '';
    this.setData({ 'drawFilter.source': cur === key ? '' : key });
    this.loadDraws(true);
  },

  // 「全部来源」：只清来源维度，不影响日期/奖品（与「清空筛选」区分开）
  clearDrawFilterSource() {
    this.setData({ 'drawFilter.source': '' });
    this.loadDraws(true);
  },

  // 奖品 picker：range 的第一项就是「全部奖品」占位，所以**下标直接查 prizeKeys**，
  // 不能再做 idx-1 偏移（那是 labels/keys 没插占位时的写法，两者必须配套改）。
  onDrawPrize(e) {
    const idx = Number(e.detail.value);
    const key = this.data.prizeKeys[idx];
    this.setData({
      'drawFilter.prizeKey': key || '',
      // 同步回填下标与文案：不回填的话管理员下次打开 picker 高亮的还是第一项
      drawFilterPrizeIndex: Number.isFinite(idx) ? idx : 0,
      drawFilterPrizeLabel: prizeLabelOf(this.data.prizeOptions, key || ''),
    });
    this.loadDraws(true);
  },

  // 清空筛选：三个维度一起清，奖品下标也要归零（否则 picker 高亮与实际条件不一致）
  clearDrawFilter() {
    this.setData({
      drawFilter: { dateFrom: '', dateTo: '', source: '', prizeKey: '' },
      drawFilterPrizeIndex: 0,
      drawFilterPrizeLabel: '',
    });
    this.loadDraws(true);
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
