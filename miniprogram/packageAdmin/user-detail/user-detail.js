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
    isSuper: false,
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
      const { user, bans, sport: sportArg, goal: goalArg } = await auth.get(
        `/api/admin/users/${this.data.id}`
      );
      const fmt = require('../../utils/format');
      const recentRuns = ((sportArg && sportArg.recentRuns) || []).map((r) => ({
        ...r,
        dateText: r.date ? `${Number(r.date.slice(5, 7))}月${Number(r.date.slice(8, 10))}日` : '',
        distanceText: fmt.formatDistance(r.distance),
        durationText: fmt.formatDuration(r.durationSeconds),
        sourceText: r.source === 'gps' ? 'GPS 实跑' : '微信运动',
      }));
      this.setData({
        loading: false,
        isSuper: (user.permissionGroups || []).includes('superadmin'),
        user: {
          ...user,
          createdText: (user.createdAt || '').slice(0, 16).replace('T', ' '),
          bannedUntilText: user.bannedUntil ? user.bannedUntil.slice(0, 16).replace('T', ' ') : '',
        },
        bans: bans.map((b) => ({
          ...b,
          timeText: (b.createdAt || '').slice(0, 16).replace('T', ' '),
        })),
        sport: {
          totalStepsText: fmt.formatNumber(user.totalSteps || 0),
          totalDistanceText: fmt.formatDistance(user.totalDistance || 0),
          totalDays: user.totalDays || 0,
          badgeCount: (sportArg && sportArg.badgeCount) || 0,
          waterToday: (sportArg && sportArg.waterToday) || { total: 0, target: 0 },
          recentRuns,
        },
        goal: goalArg || null,
      });
      this.loadPermEditor(user);
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  openRun(e) {
    wx.navigateTo({ url: `/pages/run/detail?id=${e.currentTarget.dataset.id}` });
  },

  goEdit() {
    wx.navigateTo({ url: `/packageAdmin/users/account-edit/account-edit?id=${this.data.id}` });
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

  // 删除账户：与列表左滑「删除」同一接口，删完返回列表
  removeAccount() {
    const that = this;
    const u = this.data.user || {};
    const name = u.account || u.nickname || u.realName || '该用户';
    wx.showModal({
      title: '删除账户',
      content: `将删除「${name}」及其全部运动 / 饮水 / 徽章等数据，不可恢复！确认删除？`,
      confirmText: '删除',
      confirmColor: '#e5484d',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await auth.del(`/api/admin/users/${that.data.id}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 600);
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
