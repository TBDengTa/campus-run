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

const EMPTY = {
  _id: '',
  key: '',
  name: '',
  description: '',
  icon: '',
  type: 'total_steps',
  target: 1,
  mode: 'single',
  tierGroup: '',
  tierLevel: 0,
  tierColor: '',
  sort: 0,
  enabled: true,
};

const metaOf = (type) => TARGET_META[type] || TARGET_META.total_steps;
const labelOf = (type) => (TYPES.find((t) => t.value === type) || {}).label || type;

Page({
  data: {
    list: [],
    types: TYPES,
    typeIndex: 0,
    typeLabel: TYPES[0].label,
    targetLabel: metaOf('total_steps').label,
    targetHint: metaOf('total_steps').hint,
    loading: false,
    saving: false,
    formVisible: false,
    form: { ...EMPTY },
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      const list = await auth.get('/api/admin/content/badges');
      this.setData({
        list: list.map((b) => ({
          ...b,
          mode: b.mode || (b.tierGroup ? 'tier' : 'single'),
          typeLabel: labelOf(b.type),
        })),
      });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  openCreate() {
    this.setData({
      formVisible: true,
      form: { ...EMPTY },
      typeIndex: 0,
      typeLabel: TYPES[0].label,
      targetLabel: metaOf(EMPTY.type).label,
      targetHint: metaOf(EMPTY.type).hint,
    });
  },

  openEdit(e) {
    const item = this.data.list.find((x) => x._id === e.currentTarget.dataset.id);
    if (!item) return;
    const typeIndex = Math.max(0, TYPES.findIndex((t) => t.value === item.type));
    const meta = metaOf(item.type);
    this.setData({
      formVisible: true,
      typeIndex,
      typeLabel: labelOf(item.type),
      targetLabel: meta.label,
      targetHint: meta.hint,
      form: {
        ...EMPTY,
        ...item,
        // 老数据可能没有 mode：按 tierGroup 兜底推一个（与后端 backfillBadgeModes 同规则）
        mode: item.mode || (item.tierGroup ? 'tier' : 'single'),
        key: item.key || '',
        description: item.description || '',
        icon: item.icon || '',
        tierGroup: item.tierGroup || '',
        tierLevel: Number(item.tierLevel) || 0,
        tierColor: item.tierColor || '',
        target: Number(item.target) || 0,
        sort: Number(item.sort) || 0,
        enabled: item.enabled !== false,
      },
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

  onField(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value });
  },

  onType(e) {
    const i = Number(e.detail.value);
    const type = TYPES[i].value;
    const meta = metaOf(type);
    this.setData({ typeIndex: i, typeLabel: labelOf(type), targetLabel: meta.label, targetHint: meta.hint, 'form.type': type });
  },

  onMode(e) {
    this.setData({ 'form.mode': e.currentTarget.dataset.mode });
  },

  toggleEnabled(e) {
    this.setData({ 'form.enabled': e.detail.value });
  },

  async save() {
    const { form } = this.data;
    const key = String(form.key || '').trim();
    const name = String(form.name || '').trim();
    const target = Number(form.target);
    if (!key || !name || !target) {
      wx.showToast({ title: 'key / 名称 / 目标值必填', icon: 'none' });
      return;
    }
    const isTier = form.mode === 'tier';
    if (isTier && !String(form.tierGroup || '').trim()) {
      wx.showToast({ title: '等级徽章必须填写阶梯组', icon: 'none' });
      return;
    }
    if (isTier && !(Number(form.tierLevel) >= 1)) {
      wx.showToast({ title: '等级徽章的等级必须 ≥ 1', icon: 'none' });
      return;
    }
    const payload = {
      key,
      name,
      description: String(form.description || ''),
      icon: String(form.icon || ''),
      type: form.type,
      target,
      mode: isTier ? 'tier' : 'single',
      // 独立徽章清空阶梯字段：mode=single + tierGroup 非空是脏数据（后端校验也拦）
      tierGroup: isTier ? String(form.tierGroup || '').trim() : '',
      tierLevel: isTier ? Number(form.tierLevel) || 1 : 0,
      tierColor: String(form.tierColor || ''),
      sort: Number(form.sort) || 0,
      enabled: form.enabled !== false,
    };
    this.setData({ saving: true });
    try {
      if (form._id) await auth.put(`/api/admin/content/badges/${form._id}`, payload);
      else await auth.post('/api/admin/content/badges', payload);
      wx.showToast({ title: form._id ? '已保存' : '已创建', icon: 'success' });
      this.setData({ formVisible: false, form: { ...EMPTY } });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  remove(e) {
    const { id } = e.currentTarget.dataset;
    const that = this;
    wx.showModal({
      title: '删除徽章',
      content: '用户已获得的该徽章记录将保留，确认删除？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`/api/admin/content/badges/${id}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },
});
