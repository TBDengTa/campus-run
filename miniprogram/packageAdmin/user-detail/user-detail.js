const auth = require('../../utils/request');

function toMap(arr) {
  const m = {};
  for (const k of arr || []) m[k] = true;
  return m;
}

Page({
  data: {
    id: '',
    user: null,
    bans: [],
    loading: true,
    // ===== 权限管理（需 permission.manage）=====
    canManagePerms: false,
    permsCatalog: [],
    permGroups: [],
    permModules: [], // 按模块分组的权限目录
    draft: { role: 'student', groups: [], perms: [] },
    savingPerms: false,
  },

  onLoad(options) {
    this.setData({ id: options.id || '' });
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const { user, bans } = await auth.get(`/api/admin/users/${this.data.id}`);
      this.setData({
        loading: false,
        user: {
          ...user,
          createdText: (user.createdAt || '').slice(0, 16).replace('T', ' '),
          bannedUntilText: user.bannedUntil ? user.bannedUntil.slice(0, 16).replace('T', ' ') : '',
        },
        bans: bans.map((b) => ({
          ...b,
          timeText: (b.createdAt || '').slice(0, 16).replace('T', ' '),
        })),
      });
      this.loadPermEditor(user);
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  // 尝试加载权限编辑数据（无 permission.manage 权限时 403，静默降级）
  async loadPermEditor(user) {
    try {
      const { catalog, groups } = await auth.get('/api/admin/permissions');
      // 按模块分组
      const moduleMap = new Map();
      for (const p of catalog) {
        if (!moduleMap.has(p.module)) moduleMap.set(p.module, []);
        moduleMap.get(p.module).push(p);
      }
      this.setData({
        canManagePerms: true,
        permsCatalog: catalog,
        permGroups: groups,
        permModules: [...moduleMap.entries()].map(([name, list]) => ({ name, list })),
        draft: {
          role: user.role || 'student',
          groups: [...(user.permissionGroups || [])],
          perms: [...(user.permissions || [])],
          // WXML 无法调用方法，用映射表做选中态
          groupMap: toMap(user.permissionGroups),
          permMap: toMap(user.permissions),
        },
      });
    } catch (e) {
      this.setData({ canManagePerms: false });
    }
  },

  pickRole(e) {
    this.setData({ 'draft.role': e.currentTarget.dataset.value });
  },

  toggleGroup(e) {
    const key = e.currentTarget.dataset.key;
    const groups = [...this.data.draft.groups];
    const groupMap = { ...this.data.draft.groupMap };
    const i = groups.indexOf(key);
    if (i >= 0) {
      groups.splice(i, 1);
      delete groupMap[key];
    } else {
      groups.push(key);
      groupMap[key] = true;
    }
    this.setData({ 'draft.groups': groups, 'draft.groupMap': groupMap });
  },

  togglePerm(e) {
    const key = e.currentTarget.dataset.key;
    const perms = [...this.data.draft.perms];
    const permMap = { ...this.data.draft.permMap };
    const i = perms.indexOf(key);
    if (i >= 0) {
      perms.splice(i, 1);
      delete permMap[key];
    } else {
      perms.push(key);
      permMap[key] = true;
    }
    this.setData({ 'draft.perms': perms, 'draft.permMap': permMap });
  },

  async savePerms() {
    if (this.data.savingPerms) return;
    this.setData({ savingPerms: true });
    const { id, draft } = this.data;
    try {
      const user = await auth.put(`/api/admin/users/${id}/permissions`, {
        role: draft.role,
        permissionGroups: draft.groups,
        permissions: draft.perms,
      });
      this.setData({
        user: {
          ...this.data.user,
          ...user,
          createdText: this.data.user.createdText,
          bannedUntilText: this.data.user.bannedUntilText,
        },
      });
      wx.showToast({ title: '权限已更新', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ savingPerms: false });
    }
  },

  ban() {
    const that = this;
    wx.showModal({
      title: '封禁该用户',
      editable: true,
      placeholderText: '封禁原因',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.post(`/api/admin/users/${that.data.id}/ban`, { reason: res.content || '违反社区规范', days: 7 });
          wx.showToast({ title: '已封禁 7 天', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },

  unban() {
    const that = this;
    wx.showModal({
      title: '解封该用户',
      content: '确认解除封禁？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.post(`/api/admin/users/${that.data.id}/unban`);
          wx.showToast({ title: '已解封', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },

  // 重置登录密码：恢复为初始密码（学号/身份证后8），需 permission.manage
  resetPassword() {
    const that = this;
    wx.showModal({
      title: '重置登录密码',
      content: '该用户的密码将重置为初始密码，并要求下次登录时修改。确认重置？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const r = await auth.post(`/api/admin/users/${that.data.id}/reset-password`);
          wx.showModal({ title: '已重置', content: r.message, showCancel: false });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },
});
