const auth = require('../../utils/request');
const fmt = require('../../utils/format');

const EMPTY = {
  _id: '',
  name: '',
  gender: 'all',
  preferenceLevel: 'moderate',
  bmiMin: 0,
  bmiMax: 100,
  daily: { steps: 5000, distance: 3000, calories: 250 },
  weekly: { steps: 35000, distance: 21000 },
  enabled: true,
  isDefault: false,
};

const GENDERS = [
  { label: '通用', value: 'all' },
  { label: '男生', value: 'male' },
  { label: '女生', value: 'female' },
];
const LEVELS = [
  { label: '轻松', value: 'relaxed' },
  { label: '适中', value: 'moderate' },
  { label: '激进', value: 'intense' },
];

Page({
  data: {
    list: [],
    loading: false,
    form: null,
    formVisible: false,
    saving: false,
    genders: GENDERS,
    levels: LEVELS,
    genderIndex: 0,
    levelIndex: 1,
  },

  onShow() {
    this.checkAndLoad();
  },

  async checkAndLoad() {
    try {
      await getApp().ensureLogin();
      const user = await getApp().refreshUser();
      const perms = user.effectivePermissions || [];
      if (!user.isManager || (!perms.includes('assessment.view') && !perms.includes('*'))) {
        wx.showModal({
          title: '无权限',
          content: '该功能仅限持有运动考核权限的教师/管理员使用',
          showCancel: false,
          success: () => wx.switchTab({ url: '/pages/home/home' }),
        });
        return;
      }
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async load() {
    this.setData({ loading: true });
    try {
      const list = await auth.get('/api/admin/assessment/plans');
      this.setData({ list: list.map((p) => this.decorate(p)) });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  decorate(p) {
    const gender = GENDERS.find((g) => g.value === p.gender);
    const level = LEVELS.find((l) => l.value === p.preferenceLevel);
    return {
      ...p,
      genderText: gender ? gender.label : '通用',
      levelText: level ? level.label : '适中',
      bmiText: `${p.bmiMin} ~ ${p.bmiMax}`,
      dailyStepsText: fmt.formatNumber(p.daily && p.daily.steps),
      refText: p.refCount ? `${p.refCount} 人应用` : '',
    };
  },

  openCreate() {
    this.setData({
      form: { ...EMPTY, daily: { ...EMPTY.daily }, weekly: { ...EMPTY.weekly } },
      genderIndex: 0,
      levelIndex: 1,
      formVisible: true,
    });
  },

  openEdit(e) {
    const item = this.data.list.find((x) => x._id === e.currentTarget.dataset.id);
    if (!item) return;
    this.setData({
      form: { ...item, daily: { ...item.daily }, weekly: { ...item.weekly } },
      genderIndex: Math.max(0, GENDERS.findIndex((g) => g.value === item.gender)),
      levelIndex: Math.max(0, LEVELS.findIndex((l) => l.value === item.preferenceLevel)),
      formVisible: true,
    });
  },

  onFormVisible(e) {
    this.setData({ formVisible: !!(e.detail && e.detail.visible) });
  },

  closeForm() {
    this.setData({ formVisible: false });
  },

  onName(e) {
    this.setData({ 'form.name': e.detail.value });
  },

  // 通用数字输入：data-group 存在时写 form.<group>.<field>，否则写 form.<field>
  onNum(e) {
    const { group, field } = e.currentTarget.dataset;
    const value = Number(e.detail.value) || 0;
    if (group) this.setData({ [`form.${group}.${field}`]: value });
    else this.setData({ [`form.${field}`]: value });
  },

  onGender(e) {
    const i = Number(e.detail.value);
    this.setData({ genderIndex: i, 'form.gender': GENDERS[i].value });
  },

  onLevel(e) {
    const i = Number(e.detail.value);
    this.setData({ levelIndex: i, 'form.preferenceLevel': LEVELS[i].value });
  },

  toggleEnabled(e) {
    this.setData({ 'form.enabled': e.detail.value });
  },

  toggleDefault(e) {
    this.setData({ 'form.isDefault': e.detail.value });
  },

  async save() {
    if (this.data.saving) return;
    const { form } = this.data;
    if (!form.name || !form.name.trim()) {
      wx.showToast({ title: '计划名称必填', icon: 'none' });
      return;
    }
    if (form.bmiMin >= form.bmiMax) {
      wx.showToast({ title: 'BMI 下限必须小于上限', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    const payload = {
      name: form.name.trim(),
      gender: form.gender,
      preferenceLevel: form.preferenceLevel,
      bmiMin: form.bmiMin,
      bmiMax: form.bmiMax,
      daily: form.daily,
      weekly: form.weekly,
      enabled: form.enabled,
      isDefault: form.isDefault,
    };
    try {
      if (form._id) await auth.put(`/api/admin/assessment/plans/${form._id}`, payload);
      else await auth.post('/api/admin/assessment/plans', payload);
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ formVisible: false });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  remove(e) {
    const { id, name } = e.currentTarget.dataset;
    const that = this;
    wx.showModal({
      title: '删除计划',
      content: `确认删除「${name}」？已有用户应用时将无法删除，可改为停用。`,
      confirmColor: '#e34d59',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`/api/admin/assessment/plans/${id}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },
});
