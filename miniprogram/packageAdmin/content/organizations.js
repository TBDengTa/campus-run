const auth = require('../../utils/request');
// 写权限（content.manage）：只有 content.view 的账号能看这棵树，但看不到增删改入口
// （用户 2026-10-21「组织架构只能有有权限的更改」+ 2026-10-22「只读不显示操作按钮」）
const adminPerm = require('../../utils/admin-perm');

// 层级类型文案（类型由服务端按父级推导，前端不再手选）
const TYPE_TEXT = { school: '学校', department: '院系', specialty: '专业' };
const DEPTH_ICONS = ['layers', 'folder', 'bulletpoint'];

Page({
  data: {
    nodes: [], // 拍平后的树节点（只含已展开分支）
    schoolCount: 0,
    loading: false,
    canManage: false,
    expanded: {}, // _id → 是否展开，默认全部收起
    form: null, // { _id, name, parentId, parentName, sort }
    formVisible: false,
    saving: false,
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      await adminPerm.applyManage(this, 'content.manage');
      const tree = await auth.get('/api/org/tree');
      this._tree = tree;
      this.setData({ schoolCount: tree.length, nodes: this.flatten() });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 树 → 拍平列表；未展开的节点不深入子级
  flatten() {
    const { expanded } = this.data;
    const nodes = [];
    const walk = (list, depth, parentName) => {
      for (const node of list || []) {
        const children = node.children || [];
        nodes.push({
          _id: node._id,
          name: node.name,
          typeText: TYPE_TEXT[node.type] || '',
          depth,
          icon: DEPTH_ICONS[depth] || 'bulletpoint',
          childCount: children.length,
          expandable: children.length > 0,
          expanded: !!expanded[node._id],
          parentName: parentName || '',
          sort: node.sort || 0,
          canAddChild: node.type === 'school' || node.type === 'department',
        });
        if (expanded[node._id]) walk(children, depth + 1, node.name);
      }
    };
    walk(this._tree, 0, '');
    return nodes;
  },

  toggleExpand(e) {
    const { id } = e.currentTarget.dataset;
    this.setData({ [`expanded.${id}`]: !this.data.expanded[id] });
    this.setData({ nodes: this.flatten() });
  },

  openCreate(e) {
    const { parentId, parentName } = e.currentTarget.dataset;
    this.setData({
      form: { _id: '', name: '', parentId: parentId || '', parentName: parentName || '（顶层·学校）', sort: 0 },
      formVisible: true,
    });
  },

  openCreateRoot() {
    this.setData({ form: { _id: '', name: '', parentId: '', parentName: '（顶层·学校）', sort: 0 }, formVisible: true });
  },

  openEdit(e) {
    const d = e.currentTarget.dataset;
    this.setData({
      form: { _id: d.id, name: d.name, parentId: '', parentName: d.parentName || '（顶层·学校）', sort: Number(d.sort) || 0 },
      formVisible: true,
    });
  },

  onFormVisible(e) {
    this.setData({ formVisible: !!(e.detail && e.detail.visible) });
  },

  closeForm() {
    this.setData({ formVisible: false });
  },

  onField(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value });
  },

  async save() {
    if (this.data.saving) return;
    const { form } = this.data;
    const name = (form.name || '').trim();
    if (!name) {
      wx.showToast({ title: '名称必填', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      if (form._id) {
        // 编辑只能改名称/排序：类型与父级由服务端管理
        await auth.put(`/api/admin/content/organizations/${form._id}`, { name, sort: Number(form.sort) || 0 });
      } else {
        await auth.post('/api/admin/content/organizations', {
          name,
          parentId: form.parentId || null,
          sort: Number(form.sort) || 0,
        });
      }
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
      title: '删除组织节点',
      content: `「${name}」及其全部下级将一并删除，确认删除？`,
      confirmColor: '#e34d59',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`/api/admin/content/organizations/${id}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },
});
