// 学生会成员管理（分包 packageUnion）：主席团 / 部长按本校、本院、本部门调整成员
//
// 权限以服务端 /api/union/manage/members 为准：
//   · 校主席团：全校；
//   · 分院主席团：本院校分院成员；
//   · 部长 / 副部长：本部门成员。
// 页面提供「改职务 / 转移部门 / 移出」；新增成员仍走管理端，避免在用户端误加全校账号。
const auth = require('../../utils/request');

const ROLE_ACTIONS = [
  { label: '设为部员', role: 'member' },
  { label: '设为副部长', role: 'vice_minister' },
  { label: '设为部长', role: 'minister' },
];

Page({
  data: {
    loading: true,
    saving: false,
    list: [],
    total: 0,
    scopeText: '',
    canTransfer: false,
    departments: [],
  },

  onLoad() {
    if (!getApp().requireLogin()) return;
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      const data = await auth.get('/api/union/manage/members');
      const list = (data.list || []).map((m) => ({
        ...m,
        initial: (m.realName || '—').slice(0, 1),
        roleClass: ['president', 'vice_president'].includes(m.role) ? 'top' : m.role,
        subText: [m.orgTitle || m.levelText, m.deptName || m.departmentName].filter(Boolean).join(' · '),
        termText: m.termLabel || m.termName || '',
        classText: m.className || '',
      }));
      this.setData({
        loading: false,
        list,
        total: data.total || list.length,
        scopeText: data.scopeText || '',
        canTransfer: !!data.canTransfer,
        departments: data.departments || [],
      });
    } catch (e) {
      this.setData({ loading: false, list: [], total: 0 });
      wx.showToast({ title: e.message || '没有成员管理权限', icon: 'none' });
    }
  },

  onMemberTap(e) {
    if (this.data.saving) return;
    const id = e.currentTarget.dataset.id;
    const member = this.data.list.find((m) => m.id === id);
    if (!member) return;
    const actions = ROLE_ACTIONS.map((r) => ({ ...r, type: 'role' }));
    if (this.data.canTransfer) actions.push({ type: 'transfer', label: '转移部门' });
    actions.push({ type: 'remove', label: '移出学生会' });
    const items = actions.map((a) => (a.role && a.role === member.role ? `${a.label}（当前）` : a.label));
    wx.showActionSheet({
      itemList: items,
      success: (res) => {
        const action = actions[res.tapIndex];
        if (!action) return;
        if (action.type === 'remove') {
          this.confirmRemove(member);
          return;
        }
        if (action.type === 'transfer') {
          this.chooseTransfer(member);
          return;
        }
        if (action.role === member.role) return;
        this.changeRole(member, action);
      },
    });
  },

  async changeRole(member, action) {
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      await auth.put(`/api/union/manage/members/${member.id}`, { role: action.role });
      wx.showToast({ title: `已设为${action.label.replace('设为', '')}`, icon: 'success' });
      await this.load();
    } catch (e) {
      wx.showToast({ title: e.message || '调整失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  chooseTransfer(member) {
    if (this.data.saving) return;
    const options = (this.data.departments || []).filter(
      (d) => (d.scope === 'both' || d.scope === member.level) && d.key !== member.deptKey
    );
    if (!options.length) {
      wx.showToast({ title: '没有可转移的部门', icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: options.map((d) => d.name),
      success: async (res) => {
        const dept = options[res.tapIndex];
        if (!dept) return;
        this.setData({ saving: true });
        try {
          await auth.put(`/api/union/manage/members/${member.id}`, { deptKey: dept.key });
          wx.showToast({ title: `已转移到${dept.name}`, icon: 'success' });
          await this.load();
        } catch (e) {
          wx.showToast({ title: e.message || '转移失败', icon: 'none' });
        } finally {
          this.setData({ saving: false });
        }
      },
    });
  },

  confirmRemove(member) {
    wx.showModal({
      title: '移出学生会',
      content: `确定将「${member.realName}」移出学生会？移出后其录入 / 复核权限立即失效。`,
      confirmText: '移出',
      confirmColor: '#e34d59',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ saving: true });
        try {
          await auth.post(`/api/union/manage/members/${member.id}/remove`, {});
          wx.showToast({ title: '已移出', icon: 'success' });
          await this.load();
        } catch (e) {
          wx.showToast({ title: e.message || '移出失败', icon: 'none' });
        } finally {
          this.setData({ saving: false });
        }
      },
    });
  },
});
