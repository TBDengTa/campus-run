const auth = require('../../utils/request');

// 达成条件下拉（与 server/src/models/badge.js 的 type 枚举一一对应）
// 最后两项是跑分体系的数据源：points=全历史累计跑分达标；rank=跑分总榜排名前 N 名
const TYPES = [
  { value: 'total_steps', label: '累计步数' },
  { value: 'total_distance', label: '累计距离(米)' },
  { value: 'total_days', label: '累计打卡天数' },
  { value: 'goal_days', label: '达标天数' },
  { value: 'single_steps', label: '单日步数' },
  { value: 'single_distance', label: '单次距离(米)' },
  { value: 'streak_days', label: '连续打卡天数' },
  { value: 'points', label: '跑分达标' },
  { value: 'rank', label: '跑分排名前 N' },
];

// 目标值输入框的标签与说明（不同条件单位不同：步/米/天/分/名次）
const TARGET_META = {
  total_steps: { label: '累计步数', hint: '单位：步。累计步数达到该值时发放。' },
  total_distance: { label: '累计距离', hint: '单位：米（5000 = 5 公里）。' },
  total_days: { label: '打卡天数', hint: '单位：天。累计有运动记录的天数。' },
  goal_days: { label: '达标天数', hint: '单位：天。累计「当日步数达标」的天数。' },
  single_steps: { label: '单日步数', hint: '单位：步。任意一天步数达到该值即发放。' },
  single_distance: { label: '单次距离', hint: '单位：米。任意一次运动距离达到该值。' },
  streak_days: { label: '连续天数', hint: '单位：天。从最近一次打卡往前连续的天数。' },
  points: { label: '跑分', hint: '单位：分。全历史累计跑分 ≥ 该值即发放（口径与「我的跑分」一致）。' },
  rank: { label: '名次', hint: '填写名次 N：全校跑分总榜排名前 N 名即发放（例如 100 = 前 100 名）。' },
};

// 等级组级别的阈值后缀（阈值带单位提示，与管理端列表摘要同一套口径）
const TARGET_UNIT = {
  total_steps: ' 步',
  single_steps: ' 步',
  total_distance: ' 米',
  single_distance: ' 米',
  total_days: ' 天',
  goal_days: ' 天',
  streak_days: ' 天',
  points: ' 分',
  rank: ' 名',
};

const TIER_MIN_LEVELS = 2;
const TIER_MAX_LEVELS = 8;
// 组名（tierGroup）＝ 徽章 key 前缀来源，必须 ASCII：与 1.0 迁移的 hex key 同规格（后端也会 slug 化）
const GROUP_RE = /^[a-z][a-z0-9_-]{1,31}$/;

const EMPTY_SINGLE = {
  _id: '',
  key: '',
  name: '',
  description: '',
  icon: '',
  iconUrl: '', // 仅用于抽屉里的缩略图预览（图标名没有图片可显示）
  type: 'total_steps',
  target: 1,
  tierColor: '',
  sort: 0,
  enabled: true,
};

const metaOf = (type) => TARGET_META[type] || TARGET_META.total_steps;
const labelOf = (type) => (TYPES.find((t) => t.value === type) || {}).label || type;
const typeIndexOf = (type) => Math.max(0, TYPES.findIndex((t) => t.value === type));
const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
const unitOf = (type) => TARGET_UNIT[type] || '';

// 阈值文案：跑分是「≥ N 分」、排名是「前 N 名」，其余是「N 天/步/米」
function targetTextOf(type, target) {
  const n = Number(target) || 0;
  if (type === 'rank') return `前 ${fmtNum(n)} 名`;
  return `${fmtNum(n)}${unitOf(type)}`;
}

// 级别摘要（管理端列表/表单副标题）：`Lv1 7 天 / Lv2 30 天 / Lv3 120 天`
function tierSummaryOf(levels) {
  return (levels || []).map((l) => `Lv${l.tierLevel} ${targetTextOf(l.type, l.target)}`).join(' / ');
}

// 新建等级组时给一个可读的组名草稿（可手改，必须唯一）
function draftGroupName() {
  return `tier_${Date.now().toString(36)}`;
}

// 新建组的一行级别草稿：tierLevel 只是行序展示，真正落库由服务端按行序重排
function draftLevel(index, type) {
  return {
    key: '',
    tierLevel: index + 1,
    name: `Lv${index + 1} 徽章`,
    target: '',
    icon: '',
    tierColor: '',
    type,
    targetText: '',
  };
}

Page({
  data: {
    list: [],
    singleCount: 0,
    tierGroupCount: 0,
    types: TYPES,
    loading: false,
    saving: false,
    formVisible: false,
    formMode: 'single',
    // 独立徽章表单
    form: { ...EMPTY_SINGLE },
    typeIndex: 0,
    targetLabel: metaOf('total_steps').label,
    targetHint: metaOf('total_steps').hint,
    // 等级组（组级）表单
    groupForm: {
      _id: '',
      tierGroup: '',
      type: 'total_steps',
      description: '',
      sort: 0,
      enabled: true,
    },
    groupLocked: false,
    groupTypeIndex: 0,
    groupHint: metaOf('total_steps').hint,
    groupSummary: '',
    levelRows: [],
    // 图标：从文件管理（用途 = badge）挑选的弹层
    iconVisible: false,
    iconLoading: false,
    iconList: [],
    iconTarget: { scope: 'single', index: -1 },
    iconBusy: false,
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      const list = await auth.get('/api/admin/content/badges');
      this.setData(this.buildRows(list || []));
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 把「一枚徽章一条定义」的扁平列表聚合成管理端行：等级组一行 + 独立徽章各一行。
  // 等级组按组内 Lv1 的 sort 参与排序；独立徽章按自身 sort —— 与用户端 pages/badges 同规则。
  buildRows(list) {
    const decorated = list.map((b) => {
      const type = b.type;
      const target = Number(b.target) || 0;
      return {
        ...b,
        type,
        target,
        typeLabel: labelOf(type),
        // 老数据可能没有 mode：按 tierGroup 兜底推一个（与后端 backfillBadgeModes 同规则）
        mode: b.mode || (b.tierGroup ? 'tier' : 'single'),
        targetText: targetTextOf(type, target),
      };
    });
    const singles = [];
    const groupMap = new Map();
    decorated.forEach((b, i) => {
      const group = String(b.tierGroup || '').trim();
      if (b.mode !== 'single' && group) {
        if (!groupMap.has(group)) groupMap.set(group, []);
        groupMap.get(group).push({ ...b, seq: i });
        return;
      }
      singles.push({ ...b, seq: i });
    });

    const rows = singles.map((b) => ({
      kind: 'single',
      id: `single:${b._id}`,
      key: b.key,
      name: b.name,
      icon: b.icon || '',
      typeLabel: b.typeLabel,
      targetText: b.targetText,
      enabled: b.enabled !== false,
      mode: b.mode,
      sort: Number(b.sort) || 0,
      seq: b.seq,
    }));

    for (const [group, items] of groupMap) {
      const levels = [...items].sort((a, b) => (Number(a.tierLevel) || 0) - (Number(b.tierLevel) || 0));
      const enabledLevels = levels.filter((l) => l.enabled !== false).length;
      const allEnabled = enabledLevels === levels.length;
      rows.push({
        kind: 'tier',
        id: `tier:${group}`,
        tierGroup: group,
        name: group,
        icon: (levels[0] && levels[0].icon) || '',
        type: (levels[0] && levels[0].type) || 'total_steps',
        typeLabel: (levels[0] && levels[0].typeLabel) || '',
        levelCount: levels.length,
        levelText: `${levels.length} 级`,
        summary: tierSummaryOf(levels),
        enabled: allEnabled,
        enabledText: allEnabled ? '启用' : `部分停用（${enabledLevels}/${levels.length} 级启用）`,
        enabledLevels,
        // 等级组按组内 Lv1 的排序值参与混排
        sort: Number(levels[0] && levels[0].sort) || 0,
        seq: Number(levels[0] && levels[0].seq) || 0,
        levels: levels.map((l) => ({
          _id: l._id,
          key: l.key,
          name: l.name,
          icon: l.icon || '',
          type: l.type,
          target: l.target,
          targetText: l.targetText,
          tierLevel: Number(l.tierLevel) || 0,
          tierColor: l.tierColor || '',
          enabled: l.enabled !== false,
        })),
      });
    }

    rows.sort((a, b) => a.sort - b.sort || a.seq - b.seq);
    return {
      list: rows,
      singleCount: singles.length,
      tierGroupCount: groupMap.size,
    };
  },

  // ===== 抽屉：模式切换 =====
  openCreate() {
    this.setData({
      formVisible: true,
      formMode: 'single',
      form: { ...EMPTY_SINGLE },
      typeIndex: 0,
      targetLabel: metaOf(EMPTY_SINGLE.type).label,
      targetHint: metaOf(EMPTY_SINGLE.type).hint,
    });
  },

  // 独立徽章行：只编辑自己那一条
  openEdit(e) {
    const item = this.data.list.find((x) => x.id === e.currentTarget.dataset.id && x.kind === 'single');
    if (!item) return;
    this.setData({
      formVisible: true,
      formMode: 'single',
      typeIndex: typeIndexOf(item.type),
      targetLabel: metaOf(item.type).label,
      targetHint: metaOf(item.type).hint,
      form: {
        ...EMPTY_SINGLE,
        _id: item._id,
        key: item.key || '',
        name: item.name || '',
        description: item.description || '',
        icon: item.icon || '',
        iconUrl: this.isImageIcon(item.icon) ? item.icon : '',
        type: item.type,
        target: Number(item.target) || 0,
        tierColor: '',
        sort: Number(item.sort) || 0,
        enabled: item.enabled !== false,
      },
    });
  },

  // 等级组行：整组一起编辑（级别逐行编辑，一次提交）
  openGroupEdit(e) {
    const item = this.data.list.find((x) => x.id === e.currentTarget.dataset.id && x.kind === 'tier');
    if (!item) return;
    this.fillGroupForm(item.tierGroup, item.levels, true);
  },

  fillGroupForm(tierGroup, levels, locked) {
    const type = (levels[0] && levels[0].type) || 'total_steps';
    const rows = (levels || []).map((l, i) => ({
      key: l.key || '',
      tierLevel: Number(l.tierLevel) || i + 1,
      name: l.name || '',
      target: Number(l.target) || 0,
      icon: l.icon || '',
      tierColor: l.tierColor || '',
      type,
      targetText: targetTextOf(type, l.target),
    }));
    const first = levels[0] || {};
    this.setData({
      formVisible: true,
      formMode: 'tier',
      groupLocked: !!locked,
      groupForm: {
        _id: '',
        tierGroup,
        type,
        description: first.description || '',
        sort: Number(first.sort) || 0,
        enabled: first.enabled !== false,
      },
      groupTypeIndex: typeIndexOf(type),
      groupHint: metaOf(type).hint,
      levelRows: rows,
      groupSummary: tierSummaryOf(rows),
    });
  },

  openGroupCreate() {
    const type = 'goal_days';
    const rows = [draftLevel(0, type), draftLevel(1, type)];
    this.setData({
      formVisible: true,
      formMode: 'tier',
      groupLocked: false,
      groupForm: {
        _id: '',
        tierGroup: draftGroupName(),
        type,
        description: '',
        sort: 0,
        enabled: true,
      },
      groupTypeIndex: typeIndexOf(type),
      groupHint: metaOf(type).hint,
      levelRows: rows,
      groupSummary: tierSummaryOf(rows),
    });
  },

  onMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.formMode) return;
    if (mode === 'tier') {
      this.openGroupCreate();
      return;
    }
    this.setData({
      formMode: 'single',
      form: { ...EMPTY_SINGLE },
      typeIndex: 0,
      targetLabel: metaOf(EMPTY_SINGLE.type).label,
      targetHint: metaOf(EMPTY_SINGLE.type).hint,
    });
  },

  // t-popup 的可见性由组件回调同步（下拉/点击遮罩关闭也要复位）
  onFormVisible(e) {
    const visible = !!(e.detail && e.detail.visible);
    this.setData({ formVisible: visible });
  },

  closeForm() {
    this.setData({ formVisible: false });
  },

  // ===== 独立徽章表单 =====
  onField(e) {
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    // 图标行同时带 data-field="icon" 与 data-url="1"：手填也要刷新预览 ——
    // 是图片地址才写 iconUrl，图标名/清空都要把 iconUrl 置空，否则占位 <image src="star"> 会裂图
    if (e.currentTarget.dataset.url) {
      this.setData({ 'form.icon': value, 'form.iconUrl': this.isImageIcon(value) ? value : '' });
      return;
    }
    this.setData({ [`form.${field}`]: value });
  },

  onType(e) {
    const i = Number(e.detail.value);
    const type = TYPES[i].value;
    const meta = metaOf(type);
    this.setData({ typeIndex: i, targetLabel: meta.label, targetHint: meta.hint, 'form.type': type });
  },

  toggleEnabled(e) {
    this.setData({ 'form.enabled': e.detail.value });
  },

  // ===== 等级组表单 =====
  onGroupField(e) {
    this.setData({ [`groupForm.${e.currentTarget.dataset.field}`]: e.detail.value });
  },

  onGroupType(e) {
    const i = Number(e.detail.value);
    const type = TYPES[i].value;
    // 组内所有级别共用同一条件类型：换类型时整组同步
    const levelRows = this.data.levelRows.map((r) => ({
      ...r,
      type,
      targetText: targetTextOf(type, r.target),
    }));
    this.setData({
      groupTypeIndex: i,
      groupHint: metaOf(type).hint,
      'groupForm.type': type,
      levelRows,
      groupSummary: tierSummaryOf(levelRows),
    });
  },

  onGroupSwitch(e) {
    this.setData({ 'groupForm.enabled': e.detail.value });
  },

  onLevelField(e) {
    const i = Number(e.currentTarget.dataset.index);
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    const rows = this.data.levelRows.map((r, idx) => {
      if (idx !== i) return r;
      const next = { ...r, [field]: value };
      if (field === 'target') next.targetText = targetTextOf(next.type, value);
      return next;
    });
    this.setData({ levelRows: rows, groupSummary: tierSummaryOf(rows) });
  },

  // ===== 图标：缩略图 + 上传 / 从文件管理选择（独立徽章与「等级组每一级」共用同一套） =====
  // 是否按图片渲染：与列表页同口径 —— http(s) 开头或 / 开头的绝对/根路径才算图片，其余当图标名交给 t-icon
  isImageIcon(icon) {
    const s = String(icon || '');
    return s.indexOf('http') === 0 || s.indexOf('/') === 0;
  },

  // 把选中的图标 URL / 图标名写回目标字段；target 由 data-scope / data-index 决定
  applyIcon(target, value) {
    if (!target || target.scope === 'level') {
      const i = Number(target && target.index);
      if (!(i >= 0)) return;
      const rows = this.data.levelRows.map((r, idx) => (idx === i ? { ...r, icon: value } : r));
      if (!rows.length) return;
      // 直接 setData 完整数组而不是 `levelRows[i].icon` 路径：saveGroup 读的是 data.levelRows，
      // 路径写法万一没落进 data 就会出现「缩略图已变、保存还是旧值」。
      this.setData({ levelRows: rows, groupSummary: tierSummaryOf(rows) });
      return;
    }
    // 缩略图预览字段同样挂在 form 下（WXML 读 form.iconUrl）
    this.setData({ 'form.icon': value, 'form.iconUrl': this.isImageIcon(value) ? value : '' });
  },

  onIconUpload(e) {
    const { scope, index } = e.currentTarget.dataset;
    this.materializeIcon({ scope: scope || 'single', index: Number(index) });
  },

  onIconPick(e) {
    const { scope, index } = e.currentTarget.dataset;
    this.materializeIcon({ scope: scope || 'single', index: Number(index) });
  },

  // 上传走项目既有链路：utils/request.js::auth.uploadFile → POST /api/admin/upload（multer 落盘 + files 集合），
  // 不新增上传服务、不写死域名；用途固定传 badge，服务端按用途鉴权（需 content.manage 或 file.manage/*）
  async materializeIcon(target) {
    if (this.data.iconBusy) return;
    const res = await wx.chooseMedia({ count: 1, mediaType: ['image'] }).catch(() => null);
    if (!res || !res.tempFiles || !res.tempFiles.length) return;
    this.setData({ iconBusy: true });
    wx.showLoading({ title: '上传中…', mask: true });
    try {
      const data = await auth.uploadFile(res.tempFiles[0].tempFilePath, { formData: { category: 'badge' } });
      if (!data || !data.url) throw new Error('上传未返回图片地址');
      this.applyIcon(target, data.url);
      wx.showToast({ title: '已上传', icon: 'success' });
    } catch (err) {
      // 失败要可读：服务端 403 会带「无权限（上传徽章图标需要 content.manage）」这类文案，原样透出
      wx.showToast({ title: (err && err.message) || '上传失败，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ iconBusy: false });
    }
  },

  // 从文件管理里挑：数据来自 GET /api/admin/content/badge-icons（content.view，最近 120 个 badge 用途文件）
  async openIconPicker(e) {
    const { scope, index } = e.currentTarget.dataset;
    this.setData({ iconVisible: true, iconTarget: { scope: scope || 'single', index: Number(index) } });
    await this.loadIcons();
  },

  async loadIcons() {
    this.setData({ iconLoading: true });
    try {
      const list = await auth.get('/api/admin/content/badge-icons');
      this.setData({ iconList: list || [] });
    } catch (err) {
      this.setData({ iconList: [] });
      wx.showToast({ title: (err && err.message) || '读取徽章图片失败', icon: 'none' });
    } finally {
      this.setData({ iconLoading: false });
    }
  },

  onIconVisible(e) {
    this.setData({ iconVisible: !!(e.detail && e.detail.visible) });
  },

  closeIconPicker() {
    this.setData({ iconVisible: false });
  },

  // 只选不删：删除仍归文件管理（file.manage），避免「能选但删不掉 / 越权删」的不一致
  chooseIcon(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    this.applyIcon(this.data.iconTarget, url);
    this.setData({ iconVisible: false });
    wx.showToast({ title: '已使用该图片', icon: 'success' });
  },

  // 去文件管理上传 / 整理徽章用途的图片（该页需要 file 权限，无权限时服务端会拦）
  gotoFiles() {
    this.setData({ iconVisible: false });
    wx.navigateTo({ url: '/packageAdmin/files/files' });
  },

  addLevel() {
    const rows = [...this.data.levelRows];
    if (rows.length >= TIER_MAX_LEVELS) {
      wx.showToast({ title: `最多 ${TIER_MAX_LEVELS} 级`, icon: 'none' });
      return;
    }
    const type = this.data.groupForm.type;
    rows.push(draftLevel(rows.length, type));
    this.setData({ levelRows: rows, groupSummary: tierSummaryOf(rows) });
  },

  removeLevel(e) {
    const i = Number(e.currentTarget.dataset.index);
    const rows = [...this.data.levelRows];
    if (rows.length <= TIER_MIN_LEVELS) {
      wx.showToast({ title: `至少保留 ${TIER_MIN_LEVELS} 级`, icon: 'none' });
      return;
    }
    const removed = rows.splice(i, 1)[0];
    // 行序即 tierLevel：删掉一行后重排，并提示后端会拒绝删除「已有用户获得」的级别
    const next = rows.map((r, idx) => ({ ...r, tierLevel: idx + 1 }));
    this.setData({ levelRows: next, groupSummary: tierSummaryOf(next) });
    if (removed) wx.showToast({ title: `已移除 Lv${removed.tierLevel}（保存时生效）`, icon: 'none' });
  },

  // ===== 保存 =====
  async save() {
    if (this.data.formMode === 'tier') return this.saveGroup();
    return this.saveSingle();
  },

  async saveSingle() {
    const { form } = this.data;
    const key = String(form.key || '').trim();
    const name = String(form.name || '').trim();
    const target = Number(form.target);
    if (!key || !name || !target) {
      wx.showToast({ title: 'key / 名称 / 目标值必填', icon: 'none' });
      return;
    }
    const payload = {
      key,
      name,
      description: String(form.description || ''),
      icon: String(form.icon || ''),
      type: form.type,
      target,
      mode: 'single',
      // 独立徽章清空阶梯字段：mode=single + tierGroup 非空是脏数据（后端校验也拦）
      tierGroup: '',
      tierLevel: 0,
      tierColor: '',
      sort: Number(form.sort) || 0,
      enabled: form.enabled !== false,
    };
    this.setData({ saving: true });
    try {
      if (form._id) await auth.put(`/api/admin/content/badges/${form._id}`, payload);
      else await auth.post('/api/admin/content/badges', payload);
      wx.showToast({ title: form._id ? '已保存' : '已创建', icon: 'success' });
      this.setData({ formVisible: false, form: { ...EMPTY_SINGLE } });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  // 前端校验与后端同规则：组名格式/唯一、级别 ≥2 且 ≤8、阈值严格递增、级别名不重复、级别名与阈值必填
  validateGroup() {
    const g = this.data.groupForm;
    const group = String(g.tierGroup || '').trim();
    if (!group) return '请填写组名（tierGroup）';
    if (!GROUP_RE.test(group)) return '组名只能是 2~32 位小写字母/数字/下划线，且以字母开头';
    const rows = this.data.levelRows;
    if (rows.length < TIER_MIN_LEVELS) return `等级徽章至少 ${TIER_MIN_LEVELS} 级`;
    if (rows.length > TIER_MAX_LEVELS) return `等级徽章最多 ${TIER_MAX_LEVELS} 级`;
    const names = new Set();
    let prev = null;
    for (let i = 0; i < rows.length; i += 1) {
      const name = String(rows[i].name || '').trim();
      const target = Number(rows[i].target);
      if (!name) return `第 ${i + 1} 级缺少等级名`;
      if (!Number.isFinite(target) || target <= 0) return `第 ${i + 1} 级「${name}」的目标值必须大于 0`;
      if (prev != null && !(target > prev)) {
        return `目标值必须随等级严格递增（Lv${i} 与 Lv${i + 1} 都是 ${target} 或更小）`;
      }
      prev = target;
      const nk = name.replace(/\s+/g, '');
      if (names.has(nk)) return `组内级别名重复：${name}`;
      names.add(nk);
    }
    return '';
  },

  async saveGroup() {
    const err = this.validateGroup();
    if (err) {
      wx.showToast({ title: err, icon: 'none' });
      return;
    }
    const g = this.data.groupForm;
    const group = String(g.tierGroup || '').trim();
    const levels = this.data.levelRows.map((r, i) => ({
      // key 交给服务端生成/沿用（编辑时回传原 key，保证历史获得记录不脱锚）
      key: r.key || '',
      tierLevel: i + 1,
      name: String(r.name || '').trim(),
      target: Number(r.target) || 0,
      icon: String(r.icon || ''),
      tierColor: String(r.tierColor || ''),
    }));
    const payload = {
      tierGroup: group,
      type: g.type,
      description: String(g.description || ''),
      sort: Number(g.sort) || 0,
      enabled: g.enabled !== false,
      levels,
    };
    this.setData({ saving: true });
    try {
      if (this.data.groupLocked) await auth.put(`/api/admin/content/badges/group/${encodeURIComponent(group)}`, payload);
      else await auth.post('/api/admin/content/badges/group', payload);
      wx.showToast({ title: this.data.groupLocked ? '已保存整组' : '已创建整组', icon: 'success' });
      this.setData({ formVisible: false, levelRows: [] });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  // ===== 删除 =====
  remove(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除徽章',
      content: '用户已获得的该徽章记录将保留，确认删除？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`/api/admin/content/badges/${id}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          this.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },

  // 整组删除：任一级已有用户获得会被服务端 409 拦下（这里只做一次确认，文案与服务端一致）
  removeGroup(e) {
    const item = this.data.list.find((x) => x.id === e.currentTarget.dataset.id && x.kind === 'tier');
    if (!item) return;
    wx.showModal({
      title: '删除等级组',
      content: `将删除「${item.tierGroup}」的 ${item.levelCount} 级定义。任一级已有用户获得时会被拒绝，确认删除？`,
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`/api/admin/content/badges/group/${encodeURIComponent(item.tierGroup)}`);
          wx.showToast({ title: '已删除整组', icon: 'success' });
          this.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },
});
