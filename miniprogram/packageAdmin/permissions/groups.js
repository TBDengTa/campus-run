const auth = require('../../utils/request');
const permUi = require('../../utils/permission-ui');

const EMPTY_FORM = { _id: '', key: '', name: '', description: '' };
const detailValue = (e) => (Array.isArray(e.detail) ? e.detail : (e.detail && e.detail.value) || []);

Page({
  data: {
    loading: true,
    saving: false,
    list: [],
    formVisible: false,
    form: EMPTY_FORM,
    modules: [],
    selectedCount: 0,
  },

  onLoad() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      const [res, perm] = await Promise.all([
        auth.get('/api/admin/permission-groups'),
        auth.get('/api/admin/permissions'),
      ]);
      const catalog = perm.catalog || [];
      const nameOf = new Map(catalog.map((p) => [p.key, p.name]));
      this.catalog = catalog;
      this.setData({
        loading: false,
        list: (res.list || []).map((g) => {
          const keys = g.permissions || [];
          return {
            ...g,
            permissionText: keys[0] === '*' ? '全部权限' : `${keys.length} 项权限`,
            permNames: keys[0] === '*' ? '通配全部' : keys.map((k) => nameOf.get(k) || k).join('、'),
          };
        }),
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  openCreate() {
    this.setData({
      formVisible: true,
      form: { ...EMPTY_FORM },
      modules: permUi.buildModules(this.catalog || [], []),
      selectedCount: 0,
    });
  },

  openEdit(e) {
    const id = e.currentTarget.dataset.id;
    const g = (this.data.list || []).find((x) => x._id === id);
    if (!g) return;
    // 内置组可编辑（用户 2026-10-20），但 superadmin 除外：
    // 它是唯一持 '*' 的组，改坏等于把自己锁在门外（后端也会 400 兜底）。
    if (g.key === 'superadmin') {
      wx.showToast({ title: '超级管理员组固定为全部权限，不可修改', icon: 'none' });
      return;
    }
    const selected = [...(g.permissions || [])];
    this.setData({
      formVisible: true,
      form: { _id: g._id, key: g.key, name: g.name, description: g.description || '' },
      modules: permUi.buildModules(this.catalog || [], selected),
      selectedCount: selected.length,
    });
  },

  onFormVisible(e) {
    this.setData({ formVisible: !!(e.detail && e.detail.visible) });
  },

  closeForm() {
    this.setData({ formVisible: false });
  },

  onField(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onModulePermsChange(e) {
    const moduleName = e.currentTarget.dataset.module;
    const mod = (this.data.modules || []).find((m) => m.name === moduleName);
    if (!mod) return;
    const merged = permUi.mergeModuleKeys(this.draftSelected(), mod.keys, detailValue(e));
    this.draftPerms = merged;
    this.setData({
      modules: permUi.refreshSelected(this.data.modules, merged),
      selectedCount: merged.length,
    });
  },

  // 当前勾选的权限 key（保存在实例上，避免与 list 的展示数据混淆）
  draftSelected() {
    if (!this.draftPerms) {
      const flat = [];
      for (const m of this.data.modules || []) flat.push(...(m.selected || []));
      this.draftPerms = flat;
    }
    return this.draftPerms;
  },

  async save() {
    const { form } = this.data;
    const name = String(form.name || '').trim();
    if (!name) {
      wx.showToast({ title: '请填写权限组名称', icon: 'none' });
      return;
    }
    if (!form._id && !/^[a-z][a-z0-9_.-]{1,31}$/.test(String(form.key || '').trim().toLowerCase())) {
      wx.showToast({ title: '标识：小写字母开头，2~32 位（数字/._-）', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      const permissions = this.draftSelected();
      if (form._id) {
        await auth.put(`/api/admin/permission-groups/${form._id}`, { name, description: form.description, permissions });
      } else {
        await auth.post('/api/admin/permission-groups', {
          key: String(form.key).trim().toLowerCase(),
          name,
          description: form.description,
          permissions,
        });
      }
      wx.showToast({ title: form._id ? '已保存' : '已创建', icon: 'success' });
      this.setData({ formVisible: false });
      this.draftPerms = null;
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  remove(e) {
    const { id, name } = e.currentTarget.dataset;
    const that = this;
    wx.showModal({
      title: '删除权限组',
      content: `确认删除「${name}」？仍有账号使用时无法删除。`,
      confirmText: '删除',
      confirmColor: '#e5484d',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`/api/admin/permission-groups/${id}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message || '删除失败', icon: 'none' });
        }
      },
    });
  },
});
