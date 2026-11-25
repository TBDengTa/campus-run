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

function addDaysKey(key, delta) {
  const d = new Date(`${key}T00:00:00`);
  d.setDate(d.getDate() + delta);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function prizeLabelOf(list, key) {
  if (!key) return '';
  const hit = (list || []).find((p) => p.key === key);
  return hit ? hit.label || hit.key : key;
}

// 铜版流水来源 → 标签配色桶（rv-src-*）。服务端真实来源见 beidou.js::COIN_SOURCE_TEXT：
// welcome/video/checkin/share/wheel/grid/refund。三个任务来源各自一色；
// 游戏产出与赠送（wheel/grid/refund/welcome/prize）统一归品牌橙「prize」桶；其余灰底「unknown」。
function coinSrcKind(source) {
  if (source === 'video' || source === 'share' || source === 'checkin') return source;
  if (source === 'wheel' || source === 'grid' || source === 'refund' || source === 'welcome' || source === 'prize') return 'prize';
  return 'unknown';
}

const TYPE_LABELS = ['步数', '铜版', '谢谢参与', '再来一次'];
const TYPE_VALUES = ['steps', 'coin', 'none', 'draw'];
const TIER_LABELS = ['低价值', '中价值', '高价值', '无'];
const TIER_VALUES = ['low', 'mid', 'high', 'none'];
const SYMBOL_TYPE_LABELS = ['铜版', '步数', '空白'];
const SYMBOL_TYPE_VALUES = ['coin', 'steps', 'none'];
const LINE_LABELS = ['0 线', '1 线', '2 线'];
const LINE_VALUES = [0, 1, 2];

function indexOf(list, value) {
  const i = (list || []).indexOf(value);
  return i < 0 ? 0 : i;
}

// 把用户输入（可能缺字段/是旧文档）补齐成可编辑形态
function decoratePrizes(prizes, effectivePrizes) {
  const pct = new Map((effectivePrizes || []).map((p) => [p.key, p.percent]));
  return (prizes || []).map((p) => ({
    ...p,
    typeIndex: indexOf(TYPE_VALUES, p.type),
    tierIndex: indexOf(TIER_VALUES, p.tier || 'low'),
    percentText: pct.has(p.key) ? `${pct.get(p.key)}%` : '—',
  }));
}

function decorateSymbols(symbols, effectiveSymbols) {
  // 编辑态展示「单局获奖概率」（≥1 线，服务端容斥精确算），不是单格概率（用户 2026-11-25）
  const win = new Map((effectiveSymbols || []).map((s) => [s.key, s.winPercent]));
  const lines = new Map((effectiveSymbols || []).map((s) => [s.key, s.expectedLines]));
  const cell = new Map((effectiveSymbols || []).map((s) => [s.key, s.percent]));
  return (symbols || []).map((s) => ({
    ...s,
    typeIndex: indexOf(SYMBOL_TYPE_VALUES, s.type),
    tierIndex: indexOf(TIER_VALUES, s.tier || 'low'),
    percentText: s.type === 'none' ? '—' : win.has(s.key) ? `${win.get(s.key)}%` : '—',
    expectedLinesText: s.type === 'none' ? '—' : lines.has(s.key) ? `${lines.get(s.key)} 线` : '—',
    // 空白行只读展示「剩余概率」= 1-Σ奖品单格概率（目标概率模式下由服务端分配）
    remainderText: s.type === 'none' ? (cell.has(s.key) ? `${cell.get(s.key)}%` : '—') : '',
  }));
}

/**
 * 保底选择器（用户 2026-11-22「保底key是什么我后台又看不见，建议使用选择器」）：
 * 后台不再让管理员手填内部 key，而是从当前奖品图案里选**看得懂的名字**。
 * 第一项永远是「自动」= 服务端按最低单线奖自动挑，空 key 不落库。
 */
function pityPrizeView(prizes, currentKey) {
  const labels = ['自动选择最低档铜版奖'];
  const keys = [''];
  for (const p of prizes || []) {
    if (p.type === 'none') continue;
    const typeText = p.type === 'steps' ? '步数' : p.type === 'coin' ? '铜版' : '再来一次';
    const amount = ` · ${p.amount} ${p.type === 'steps' ? '步' : p.type === 'coin' ? '铜版' : '次'}`;
    labels.push(`${p.label || p.key}（${typeText}${amount}）`);
    keys.push(p.key);
  }
  let index = keys.indexOf(currentKey || '');
  if (index < 0) index = 0;
  return { labels, keys, index, label: labels[index] };
}

function pitySymbolView(symbols, currentKey) {
  const labels = ['自动选择最低单线奖图案'];
  const keys = [''];
  for (const s of symbols || []) {
    if (s.type === 'none') continue;
    const unit = s.type === 'coin' ? '铜版' : '步';
    labels.push(`${s.label || s.key}（单线 ${s.amount} ${unit}）`);
    keys.push(s.key);
  }
  let index = keys.indexOf(currentKey || '');
  if (index < 0) index = 0;
  return { labels, keys, index, label: labels[index] };
}

/**
 * 北斗运动 v3 配置页（铜版经济 / 转盘 / 九宫格 / 任务 / 流水）。
 *
 * 三条硬约束：
 *   ① 概率/期望返还/警告由服务端 `POST /beidou-preview` 算（与保存、用户端公示同一份），
 *      页面只做输入与展示；本地 recalcOdds 只是预览失败时的兜底；
 *   ② 所有写入口必须有 canManage 守卫（只读账号能看、能筛流水）；
 *   ③ 保存只回传 `beidou` 一组，未回传的其它配置键不动。
 */
Page({
  sectionKeys: ['beidou'],

  data: {
    canManage: false,
    config: null,
    saving: false,
    loading: true,
    tab: 'basic',
    effective: null,
    warnings: [],
    previewLoading: false,
    oddsInvalid: '',

    // picker 选项
    typeLabels: TYPE_LABELS,
    typeValues: TYPE_VALUES,
    tierLabels: TIER_LABELS,
    tierValues: TIER_VALUES,
    symbolTypeLabels: SYMBOL_TYPE_LABELS,
    symbolTypeValues: SYMBOL_TYPE_VALUES,
    lineLabels: LINE_LABELS,
    lineValues: LINE_VALUES,
    symbolLabels: [],
    symbolKeys: [],
    // 保底选择器（不再手填 key）
    pityPrizeLabels: ['自动选择最低档铜版奖'],
    pityPrizeKeys: [''],
    pityPrizeIndex: 0,
    pityPrizeLabel: '自动选择最低档铜版奖',
    pitySymbolLabels: ['自动选择最低单线奖图案'],
    pitySymbolKeys: [''],
    pitySymbolIndex: 0,
    pitySymbolLabel: '自动选择最低单线奖图案',
    // 图标上传中（防重复点击）
    iconBusy: false,

    // 中奖/游戏流水
    draws: [],
    drawsTotal: 0,
    drawsPage: 1,
    drawsLoading: false,
    drawFilter: { dateFrom: addDaysKey(todayKey(), -6), dateTo: todayKey(), game: '', source: '', prizeKey: '', type: '' },
    drawFilterActive: false,
    gameFacets: [],
    sourceFacets: [],
    typeFacets: [],
    prizeOptions: [],
    prizeLabels: ['全部奖品'],
    prizeKeys: [''],
    drawFilterPrizeIndex: 0,
    drawFilterPrizeLabel: '',
    todayKeyText: todayKey(),
    sourceNote: '',

    // 铜版流水
    coinLogs: [],
    coinTotal: 0,
    coinPage: 1,
    coinLoading: false,
    coinFilter: { dateFrom: addDaysKey(todayKey(), -6), dateTo: todayKey(), source: '', game: '', direction: '' },
    coinFilterActive: false,
    coinFacets: { source: [], game: [] },
    coinTotals: { earned: 0, spent: 0 },

    // 经济概览
    economy: null,
    economyLoading: false,
  },

  onShow() {
    section.onShow(this);
  },

  async checkAndLoad() {
    await section.checkAndLoad(this);
    const config = this.data.config;
    if (!config || !config.beidou) return;
    const effective = config.beidouEffective || (await this.fetchPreview(config.beidou));
    if (effective) this.applyEffective(effective);
    this.setData({ loading: false });
    if (this.data.tab === 'logs') this.loadLogs(true);
  },

  save() {
    return section.save(this).then((res) => {
      if (res && res.beidouEffective) this.applyEffective(res.beidouEffective);
      if (res && res.beidou) this.applyEditable(res.beidou, res.beidouEffective);
      if (this.data.tab === 'logs') this.loadLogs(true);
      return res;
    });
  },

  // 把服务端生效配置铺到页面（概率/EV/警告）
  applyEffective(effective) {
    const e = effective || {};
    this.setData({
      effective: e,
      warnings: e.warnings || [],
    });
    this.decorateConfig(e);
  },

  applyEditable(beidou, effective) {
    if (!beidou) return;
    this.setData({ 'config.beidou': beidou });
    this.decorateConfig(effective || this.data.effective);
  },

  // 只刷新「百分比/奖值」等派生物，不覆盖管理员输入。
  // **派生字段走点路径回写**：整数组替换会在编辑中途重置输入框（中文 IME / 小数点 / 清空），
  // 即用户 2026-11-25 报的「编辑九宫格图案会被刷新」。
  decorateConfig(effective) {
    const b = (this.data.config && this.data.config.beidou) || {};
    const e = effective || this.data.effective || {};
    const prizes = decoratePrizes(b.prizes, e.wheel && e.wheel.prizes);
    const symbols = decorateSymbols(b.grid && b.grid.symbols, e.grid && e.grid.symbols);
    const milestones = ((b.checkin && b.checkin.milestones) || []).slice(0, 7).map((m, i) => ({
      ...m,
      dayNo: i + 1,
    }));
    while (milestones.length < 7) milestones.push({ coin: 1, draw: 0, steps: 0, dayNo: milestones.length + 1 });
    const wheelPity = pityPrizeView(prizes, b.wheel && b.wheel.pity && b.wheel.pity.prizeKey);
    const gridPity = pitySymbolView(symbols, b.grid && b.grid.pity && b.grid.pity.symbolKey);
    const patch = {
      'config.beidou.checkin.milestones': milestones,
      symbolLabels: symbols.map((s) => s.label || s.key),
      symbolKeys: symbols.map((s) => s.key),
      pityPrizeLabels: wheelPity.labels,
      pityPrizeKeys: wheelPity.keys,
      pityPrizeIndex: wheelPity.index,
      pityPrizeLabel: wheelPity.label,
      pitySymbolLabels: gridPity.labels,
      pitySymbolKeys: gridPity.keys,
      pitySymbolIndex: gridPity.index,
      pitySymbolLabel: gridPity.label,
    };
    prizes.forEach((p, i) => {
      patch[`config.beidou.prizes[${i}].percentText`] = p.percentText;
      patch[`config.beidou.prizes[${i}].typeIndex`] = p.typeIndex;
      patch[`config.beidou.prizes[${i}].tierIndex`] = p.tierIndex;
    });
    symbols.forEach((s, i) => {
      patch[`config.beidou.grid.symbols[${i}].percentText`] = s.percentText;
      patch[`config.beidou.grid.symbols[${i}].expectedLinesText`] = s.expectedLinesText;
      patch[`config.beidou.grid.symbols[${i}].typeIndex`] = s.typeIndex;
      patch[`config.beidou.grid.symbols[${i}].tierIndex`] = s.tierIndex;
      patch[`config.beidou.grid.symbols[${i}].remainderText`] = s.remainderText;
      // 概率输入框预填当前实际获奖概率（仅草稿未填时；填过就不覆盖，防编辑中途重置）
      const draft = ((b.grid && b.grid.symbols) || [])[i];
      if (s.type !== 'none' && (draft == null || draft.winTarget === undefined || draft.winTarget === null || draft.winTarget === '')) {
        const eSym = ((e.grid && e.grid.symbols) || []).find((x) => x.key === s.key);
        if (eSym && eSym.winPercent !== undefined) patch[`config.beidou.grid.symbols[${i}].winTarget`] = String(eSym.winPercent);
      }
    });
    this.setData(patch);
  },

  async fetchPreview(beidou) {
    try {
      const res = await auth.post('/api/admin/config/beidou-preview', { beidou });
      return (res && res.effective) || null;
    } catch (e) {
      return null;
    }
  },

  schedulePreview() {
    if (this._previewTimer) clearTimeout(this._previewTimer);
    this._previewTimer = setTimeout(async () => {
      this._previewTimer = null;
      if (!this.data.config || !this.data.config.beidou) return;
      this.setData({ previewLoading: true });
      const effective = await this.fetchPreview(this.data.config.beidou);
      this.setData({ previewLoading: false });
      if (effective) {
        this.applyEffective(effective);
        this.setData({ oddsInvalid: '' });
      } else {
        // 预览不可用：概率显示诚实置「—」，不留旧数字误导
        const symbols = (this.data.config && this.data.config.beidou && this.data.config.beidou.grid && this.data.config.beidou.grid.symbols) || [];
        const patch = {};
        symbols.forEach((s, i) => {
          patch[`config.beidou.grid.symbols[${i}].percentText`] = '—';
          patch[`config.beidou.grid.symbols[${i}].expectedLinesText`] = '—';
        });
        this.setData(patch);
      }
    }, 350);
  },

  switchTab(e) {
    const tab = (e.currentTarget.dataset && e.currentTarget.dataset.tab) || 'basic';
    if (tab === this.data.tab) return;
    this.setData({ tab });
    if (tab === 'logs') this.loadLogs(true);
  },

  // ===== 基础 / 任务：数值与开关 =====
  onField(e) {
    const { field } = e.currentTarget.dataset;
    const value = e.detail.value;
    const patch = {};
    if (typeof value === 'boolean') {
      patch[`config.${field}`] = value;
    } else {
      const raw = String(value == null ? '' : value).trim();
      const n = Number(raw);
      patch[`config.${field}`] = raw === '' || !Number.isFinite(n) ? 0 : Math.max(0, Math.round(n));
    }
    this.setData(patch);
    this.recalcOdds();
    this.schedulePreview();
  },

  // 签到阶梯单独处理：直接按 index 重建 7 行，避免 data-field 里的 {{index}} 拼路径
  // 在某些基础库下把数组改坏（用户 2026-11-22：输入/删除后只剩「第 21 天」一行）。
  onMilestoneField(e) {
    if (!this.data.canManage) return;
    const index = Number(e.currentTarget.dataset.index);
    if (!Number.isFinite(index)) return;
    const raw = String(e.detail.value == null ? '' : e.detail.value).trim();
    const n = Number(raw);
    const coin = raw === '' || !Number.isFinite(n) ? 0 : Math.max(0, Math.round(n));
    const list = ((this.data.config && this.data.config.beidou && this.data.config.beidou.checkin
      && this.data.config.beidou.checkin.milestones) || []).slice(0, 7);
    if (!list[index]) return;
    list[index] = { ...list[index], dayNo: index + 1, coin };
    this.setData({ 'config.beidou.checkin.milestones': list });
    this.recalcOdds();
    this.schedulePreview();
  },

  onTextField(e) {
    const { field } = e.currentTarget.dataset;
    this.setData({ [`config.${field}`]: e.detail.value });
    this.schedulePreview();
  },

  // 保底：从奖池/结果里选（不再手填 key）
  onPityPrize(e) {
    const idx = Number(e.detail.value) || 0;
    const key = this.data.pityPrizeKeys[idx] || '';
    this.setData({
      'config.beidou.wheel.pity.prizeKey': key,
      pityPrizeIndex: idx,
      pityPrizeLabel: this.data.pityPrizeLabels[idx] || '自动选择最低档铜版奖',
    });
    this.recalcOdds();
    this.schedulePreview();
  },

  onPitySymbol(e) {
    const idx = Number(e.detail.value) || 0;
    const key = this.data.pitySymbolKeys[idx] || '';
    this.setData({
      'config.beidou.grid.pity.symbolKey': key,
      pitySymbolIndex: idx,
      pitySymbolLabel: this.data.pitySymbolLabels[idx] || '自动选择最低单线奖图案',
    });
    this.recalcOdds();
    this.schedulePreview();
  },

  // ===== 转盘奖池 =====
  onPrizeField(e) {
    const { index, key } = e.currentTarget.dataset;
    const list = ((this.data.config && this.data.config.beidou && this.data.config.beidou.prizes) || []).slice();
    const row = { ...(list[Number(index)] || {}) };
    const value = e.detail.value;
    if (key === 'type') {
      row.type = TYPE_VALUES[Number(value)] || 'none';
      row.typeIndex = Number(value) || 0;
      if (row.type === 'none') row.amount = 0;
    } else if (key === 'tier') {
      row.tier = TIER_VALUES[Number(value)] || 'none';
      row.tierIndex = Number(value) || 0;
    } else if (key === 'weight' || key === 'amount') {
      const raw = String(value == null ? '' : value).trim();
      const n = Number(raw);
      row[key] = raw === '' || !Number.isFinite(n) ? 0 : Math.max(0, Math.round(n));
    } else {
      row[key] = value;
    }
    list[Number(index)] = row;
    this.setData({ 'config.beidou.prizes': list });
    this.recalcOdds();
    this.schedulePreview();
  },

  addPrize() {
    const list = ((this.data.config && this.data.config.beidou && this.data.config.beidou.prizes) || []).slice();
    if (list.length >= 8) {
      wx.showToast({ title: '最多 8 个奖项（扇区数上限）', icon: 'none' });
      return;
    }
    list.push({ key: `coin_${Date.now().toString(36)}`, label: '新奖项', type: 'coin', amount: 1, weight: 1, tier: 'low' });
    this.setData({ 'config.beidou.prizes': list });
    this.recalcOdds();
    this.schedulePreview();
  },

  removePrize(e) {
    const { index } = e.currentTarget.dataset;
    const list = ((this.data.config && this.data.config.beidou && this.data.config.beidou.prizes) || []).slice();
    list.splice(Number(index), 1);
    this.setData({ 'config.beidou.prizes': list });
    this.recalcOdds();
    this.schedulePreview();
  },

  // ===== 九宫格符号 =====
  onSymbolField(e) {
    const { index, key } = e.currentTarget.dataset;
    const i = Number(index);
    const row = ((this.data.config && this.data.config.beidou && this.data.config.beidou.grid && this.data.config.beidou.grid.symbols) || [])[i];
    if (!row) return;
    const value = e.detail.value;
    const base = `config.beidou.grid.symbols[${i}]`;
    const patch = {};
    if (key === 'type') {
      const type = SYMBOL_TYPE_VALUES[Number(value)] || 'none';
      patch[`${base}.type`] = type;
      patch[`${base}.typeIndex`] = Number(value) || 0;
      if (type === 'none') patch[`${base}.amount`] = 0;
    } else if (key === 'tier') {
      patch[`${base}.tier`] = TIER_VALUES[Number(value)] || 'none';
      patch[`${base}.tierIndex`] = Number(value) || 0;
    } else if (key === 'amount' || key === 'weight' || key === 'winTarget') {
      // 保留原始字符串：编辑中途把空串/小数点强转 0 会重置输入框（「编辑被刷新」根因之一）；
      // 数值归一由服务端 normalize 在预览/保存时做（winTarget 由服务端反解权重）
      patch[`${base}.${key}`] = String(value == null ? '' : value);
    } else {
      patch[`${base}.${key}`] = value;
    }
    this.setData(patch);
    this.recalcOdds();
    this.schedulePreview();
  },

  addSymbol() {
    const grid = (this.data.config && this.data.config.beidou && this.data.config.beidou.grid) || {};
    const list = (grid.symbols || []).slice();
    if (list.length >= 8) {
      wx.showToast({ title: '最多 8 个符号', icon: 'none' });
      return;
    }
    list.push({ key: `sym_${Date.now().toString(36)}`, label: '新图案', icon: '⭐', iconUrl: '', type: 'coin', amount: 1, weight: 10, tier: 'low' });
    this.setData({ 'config.beidou.grid.symbols': list });
    this.recalcOdds();
    this.schedulePreview();
  },

  removeSymbol(e) {
    const { index } = e.currentTarget.dataset;
    const list = ((this.data.config && this.data.config.beidou && this.data.config.beidou.grid && this.data.config.beidou.grid.symbols) || []).slice();
    list.splice(Number(index), 1);
    this.setData({ 'config.beidou.grid.symbols': list });
    this.recalcOdds();
    this.schedulePreview();
  },

  // ===== 图标上传（九宫格图案 / 铜版）=====
  async uploadSymbolIcon(e) {
    if (!this.data.canManage || this.data.iconBusy) return;
    const index = Number(e.currentTarget.dataset.index) || 0;
    const url = await this.pickAndUploadIcon();
    if (!url) return;
    const list = ((this.data.config && this.data.config.beidou && this.data.config.beidou.grid && this.data.config.beidou.grid.symbols) || []).slice();
    if (!list[index]) return;
    list[index] = { ...list[index], iconUrl: url };
    this.setData({ 'config.beidou.grid.symbols': list });
    this.schedulePreview();
  },

  clearSymbolIcon(e) {
    if (!this.data.canManage) return;
    const index = Number(e.currentTarget.dataset.index) || 0;
    const list = ((this.data.config && this.data.config.beidou && this.data.config.beidou.grid && this.data.config.beidou.grid.symbols) || []).slice();
    if (!list[index]) return;
    list[index] = { ...list[index], iconUrl: '' };
    this.setData({ 'config.beidou.grid.symbols': list });
    this.schedulePreview();
  },

  async uploadCoinIcon() {
    if (!this.data.canManage || this.data.iconBusy) return;
    const url = await this.pickAndUploadIcon();
    if (!url) return;
    this.setData({ 'config.beidou.coinIconUrl': url });
    this.schedulePreview();
  },

  clearCoinIcon() {
    if (!this.data.canManage) return;
    this.setData({ 'config.beidou.coinIconUrl': '' });
    this.schedulePreview();
  },

  // 统一上传链路：chooseMedia → /api/admin/upload（category=beidou）→ 返回 URL
  async pickAndUploadIcon() {
    // PC 微信 chooseMedia 可能不可用（用户 2026-11-25「上传不上去」）：失败回退 chooseImage
    const media = wx.chooseMedia ? await wx.chooseMedia({ count: 1, mediaType: ['image'] }).catch(() => null) : null;
    let filePath = media && media.tempFiles && media.tempFiles[0] && media.tempFiles[0].tempFilePath;
    if (!filePath && wx.chooseImage) {
      const img = await new Promise((resolve) => {
        wx.chooseImage({
          count: 1,
          sizeType: ['original'],
          sourceType: ['album', 'camera'],
          success: resolve,
          fail: () => resolve(null),
        });
      });
      filePath = img && img.tempFilePaths && img.tempFilePaths[0];
    }
    if (!filePath) return '';
    this.setData({ iconBusy: true });
    wx.showLoading({ title: '上传中…', mask: true });
    try {
      const data = await auth.uploadFile(filePath, { formData: { category: 'beidou' } });
      if (!data || !data.url) throw new Error('上传未返回图片地址');
      wx.showToast({ title: '已上传', icon: 'success' });
      return data.url;
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '上传失败，请重试', icon: 'none' });
      return '';
    } finally {
      wx.hideLoading();
      this.setData({ iconBusy: false });
    }
  },

  // ===== 本地概率兜底（服务端预览失败时也能看到大致数字）=====
  recalcOdds() {
    const b = (this.data.config && this.data.config.beidou) || {};
    const prizes = Array.isArray(b.prizes) ? b.prizes : [];
    const valid = prizes.filter((p) => {
      const w = Number(p.weight) || 0;
      if (w <= 0) return false;
      if (p.type === 'steps' || p.type === 'coin' || p.type === 'draw') return (Number(p.amount) || 0) > 0;
      return true;
    });
    const total = valid.reduce((s, p) => s + (Number(p.weight) || 0), 0);
    let oddsInvalid = '';
    if (!valid.length) oddsInvalid = '所有奖项权重都是 0 或数量为 0，用户端将回退到默认奖池';
    else if (total <= 0) oddsInvalid = '权重合计为 0，无法归一';
    const prizeRows = prizes.map((p) => {
      const w = Number(p.weight) || 0;
      const usable = valid.includes(p);
      return {
        ...p,
        typeIndex: indexOf(TYPE_VALUES, p.type),
        tierIndex: indexOf(TIER_VALUES, p.tier || 'low'),
        percentText: usable && total > 0 ? `${((w / total) * 100).toFixed(2)}%` : '—',
      };
    });

    const grid = b.grid || {};
    const symbols = grid.symbols || [];
    if (!symbols.some((s) => s.type !== 'none' && (Number(s.weight) || 0) > 0)) {
      oddsInvalid = oddsInvalid || '九宫格没有权重>0的奖品图案，用户端会回退默认图案';
    }
    const wheelPity = pityPrizeView(prizeRows, b.wheel && b.wheel.pity && b.wheel.pity.prizeKey);
    const gridPity = pitySymbolView(symbols, b.grid && b.grid.pity && b.grid.pity.symbolKey);

    // 点路径回写派生字段（不整数组替换，防编辑中途输入框被重置）。
    // 符号获奖概率以服务端预览 winPercent 为唯一权威（decorateConfig 回写），本地不算。
    const patch = {
      oddsInvalid,
      pityPrizeLabels: wheelPity.labels,
      pityPrizeKeys: wheelPity.keys,
      pityPrizeIndex: wheelPity.index,
      pityPrizeLabel: wheelPity.label,
      pitySymbolLabels: gridPity.labels,
      pitySymbolKeys: gridPity.keys,
      pitySymbolIndex: gridPity.index,
      pitySymbolLabel: gridPity.label,
    };
    prizeRows.forEach((p, i) => {
      patch[`config.beidou.prizes[${i}].percentText`] = p.percentText;
      patch[`config.beidou.prizes[${i}].typeIndex`] = p.typeIndex;
      patch[`config.beidou.prizes[${i}].tierIndex`] = p.tierIndex;
    });
    symbols.forEach((s, i) => {
      patch[`config.beidou.grid.symbols[${i}].typeIndex`] = indexOf(SYMBOL_TYPE_VALUES, s.type);
      patch[`config.beidou.grid.symbols[${i}].tierIndex`] = indexOf(TIER_VALUES, s.tier || 'low');
    });
    this.setData(patch);
  },

  // ===== 流水 =====
  loadLogs(reset) {
    this.loadEconomy();
    this.loadDraws(reset);
    this.loadCoinLogs(reset);
  },

  async loadEconomy() {
    if (this.data.economyLoading) return;
    this.setData({ economyLoading: true });
    try {
      const data = await auth.get('/api/admin/config/beidou-economy?days=7');
      this.setData({ economy: data || null, economyLoading: false });
    } catch (e) {
      this.setData({ economyLoading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async loadDraws(reset) {
    if (this.data.drawsLoading) return;
    const page = reset ? 1 : this.data.drawsPage;
    this.setData({ drawsLoading: true });
    try {
      const f = this.data.drawFilter || {};
      const q = [`page=${page}`, 'limit=20'];
      if (f.dateFrom) q.push(`dateFrom=${encodeURIComponent(f.dateFrom)}`);
      if (f.dateTo) q.push(`dateTo=${encodeURIComponent(f.dateTo)}`);
      if (f.game) q.push(`game=${encodeURIComponent(f.game)}`);
      if (f.source) q.push(`source=${encodeURIComponent(f.source)}`);
      if (f.prizeKey) q.push(`prizeKey=${encodeURIComponent(f.prizeKey)}`);
      if (f.type) q.push(`type=${encodeURIComponent(f.type)}`);
      const data = await auth.get(`/api/admin/config/beidou-draws?${q.join('&')}`);
      const rows = (data.list || []).map((r) => ({
        ...r,
        whoSubText: [r.studentId, r.className].filter(Boolean).join(' · '),
        timeText: fmt.formatDateTime(r.createdAt) || r.date || '',
        // 服务端 v3 已下发 prizeLabel；旧接口/异常缺字段时给出可读兜底，绝不渲染空白
        prizeText: r.prizeLabel || (r.type === 'steps' ? `${r.amount} 步` : r.type === 'coin' ? `${r.amount} 铜版` : r.type === 'draw' ? '再来一次' : '谢谢参与'),
        prizePrefix: r.type === 'coin' || r.type === 'steps' || r.type === 'mixed' ? '+' : '',
        sourceText: r.sourceText || '未记录',
        flagsText: [r.pity ? '保底' : '', r.capped ? '步数封顶' : '', r.coinCapped ? '铜版封顶' : ''].filter(Boolean).join(' · '),
      }));
      const prizeOptions = (data.facets && data.facets.prizes) || this.data.prizeOptions || [];
      const prizeLabels = ['全部奖品'].concat(prizeOptions.map((p) => p.label));
      const prizeKeys = [''].concat(prizeOptions.map((p) => p.key));
      const defaultFrom = addDaysKey(todayKey(), -6);
      const defaultTo = todayKey();
      this.setData({
        draws: reset ? rows : this.data.draws.concat(rows),
        drawsTotal: data.total || 0,
        drawsPage: page + 1,
        drawsLoading: false,
        gameFacets: (data.facets && data.facets.game) || [],
        sourceFacets: (data.facets && data.facets.source) || [],
        typeFacets: (data.facets && data.facets.type) || [],
        prizeOptions,
        prizeLabels,
        prizeKeys,
        sourceNote: data.sourceNote || this.data.sourceNote || '',
        // 默认最近 7 天不算「已筛选」；只有改了日期/玩法/来源/结果/奖品才提示
        drawFilterActive: !!(f.game || f.source || f.type || f.prizeKey
          || f.dateFrom !== defaultFrom || f.dateTo !== defaultTo),
        drawFilterPrizeLabel: prizeLabelOf(prizeOptions, f.prizeKey),
        drawFilterPrizeIndex: Math.max(0, prizeKeys.indexOf(f.prizeKey || '')),
      });
    } catch (e) {
      this.setData({ drawsLoading: false, ...(reset ? { draws: [] } : {}) });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async loadCoinLogs(reset) {
    if (this.data.coinLoading) return;
    const page = reset ? 1 : this.data.coinPage;
    this.setData({ coinLoading: true });
    try {
      const f = this.data.coinFilter || {};
      const q = [`page=${page}`, 'limit=20'];
      if (f.dateFrom) q.push(`dateFrom=${encodeURIComponent(f.dateFrom)}`);
      if (f.dateTo) q.push(`dateTo=${encodeURIComponent(f.dateTo)}`);
      if (f.source) q.push(`source=${encodeURIComponent(f.source)}`);
      if (f.game) q.push(`game=${encodeURIComponent(f.game)}`);
      if (f.direction) q.push(`direction=${encodeURIComponent(f.direction)}`);
      const data = await auth.get(`/api/admin/config/beidou-coin-logs?${q.join('&')}`);
      const rows = (data.list || []).map((r) => ({
        ...r,
        whoSubText: [r.studentId, r.className].filter(Boolean).join(' · '),
        timeText: fmt.formatDateTime(r.createdAt) || r.date || '',
        deltaText: `${r.delta > 0 ? '+' : ''}${r.delta}`,
        directionText: r.delta > 0 ? '发放' : '扣除',
        srcKind: coinSrcKind(r.source),
      }));
      const defaultFrom = addDaysKey(todayKey(), -6);
      const defaultTo = todayKey();
      this.setData({
        coinLogs: reset ? rows : this.data.coinLogs.concat(rows),
        coinTotal: data.total || 0,
        coinPage: page + 1,
        coinLoading: false,
        coinFacets: (data.facets && data.facets) || this.data.coinFacets,
        coinTotals: data.totals || this.data.coinTotals,
        coinFilterActive: !!(f.source || f.game || f.direction
          || f.dateFrom !== defaultFrom || f.dateTo !== defaultTo),
      });
    } catch (e) {
      this.setData({ coinLoading: false, ...(reset ? { coinLogs: [] } : {}) });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  onDrawDate(e) {
    const { key } = e.currentTarget.dataset;
    this.setData({ [`drawFilter.${key}`]: e.detail.value || '' });
    this.loadDraws(true);
  },

  onDrawGame(e) {
    const { key } = e.currentTarget.dataset;
    const cur = (this.data.drawFilter || {}).game || '';
    this.setData({ 'drawFilter.game': cur === key ? '' : key });
    this.loadDraws(true);
  },

  onDrawSource(e) {
    const { key } = e.currentTarget.dataset;
    const cur = (this.data.drawFilter || {}).source || '';
    this.setData({ 'drawFilter.source': cur === key ? '' : key });
    this.loadDraws(true);
  },

  onDrawType(e) {
    const { key } = e.currentTarget.dataset;
    const cur = (this.data.drawFilter || {}).type || '';
    this.setData({ 'drawFilter.type': cur === key ? '' : key });
    this.loadDraws(true);
  },

  onDrawPrize(e) {
    const idx = Number(e.detail.value);
    const key = this.data.prizeKeys[idx] || '';
    this.setData({
      'drawFilter.prizeKey': key,
      drawFilterPrizeIndex: Number.isFinite(idx) ? idx : 0,
      drawFilterPrizeLabel: prizeLabelOf(this.data.prizeOptions, key),
    });
    this.loadDraws(true);
  },

  clearDrawFilter() {
    this.setData({
      drawFilter: { dateFrom: addDaysKey(todayKey(), -6), dateTo: todayKey(), game: '', source: '', prizeKey: '', type: '' },
      drawFilterPrizeIndex: 0,
      drawFilterPrizeLabel: '',
    });
    this.loadDraws(true);
  },

  // 兼容旧页面/旧检查器：只清来源维度
  clearDrawFilterSource() {
    this.setData({ 'drawFilter.source': '' });
    this.loadDraws(true);
  },

  toggleDraws() {
    this.setData({ tab: 'logs' });
    this.loadLogs(true);
  },

  loadMoreDraws() {
    if (this.data.draws.length >= this.data.drawsTotal) return;
    this.loadDraws(false);
  },

  onCoinDate(e) {
    const { key } = e.currentTarget.dataset;
    this.setData({ [`coinFilter.${key}`]: e.detail.value || '' });
    this.loadCoinLogs(true);
  },

  onCoinSource(e) {
    const { key } = e.currentTarget.dataset;
    const cur = (this.data.coinFilter || {}).source || '';
    this.setData({ 'coinFilter.source': cur === key ? '' : key });
    this.loadCoinLogs(true);
  },

  onCoinGame(e) {
    const { key } = e.currentTarget.dataset;
    const cur = (this.data.coinFilter || {}).game || '';
    this.setData({ 'coinFilter.game': cur === key ? '' : key });
    this.loadCoinLogs(true);
  },

  onCoinDirection(e) {
    const { key } = e.currentTarget.dataset;
    const cur = (this.data.coinFilter || {}).direction || '';
    this.setData({ 'coinFilter.direction': cur === key ? '' : key });
    this.loadCoinLogs(true);
  },

  clearCoinFilter() {
    this.setData({
      coinFilter: { dateFrom: addDaysKey(todayKey(), -6), dateTo: todayKey(), source: '', game: '', direction: '' },
    });
    this.loadCoinLogs(true);
  },

  loadMoreCoins() {
    if (this.data.coinLogs.length >= this.data.coinTotal) return;
    this.loadCoinLogs(false);
  },
});
