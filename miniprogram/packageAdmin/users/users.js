const auth = require('../../utils/request');

const BTN_STYLE = {
  edit: 'background:#ff6b00;color:#fff;font-size:26rpx;width:120rpx;height:100%;display:flex;align-items:center;justify-content:center',
  detail: 'background:#2f7cf6;color:#fff;font-size:26rpx;width:120rpx;height:100%;display:flex;align-items:center;justify-content:center',
  ban: 'background:#d54941;color:#fff;font-size:26rpx;width:120rpx;height:100%;display:flex;align-items:center;justify-content:center',
  unban: 'background:#16a34a;color:#fff;font-size:26rpx;width:120rpx;height:100%;display:flex;align-items:center;justify-content:center',
  del: 'background:#383838;color:#fff;font-size:26rpx;width:120rpx;height:100%;display:flex;align-items:center;justify-content:center',
};

Page({
  data: {
    keyword: '',
    status: '',
    page: 1,
    limit: 20,
    total: 0,
    list: [],
    loading: false,
    loadingMore: false,
    // 下拉筛选
    filterOptions: {
      schools: [],
      departments: [],
      specialties: [],
      grades: [],
      dailyGoals: [],
      weeklyGoals: [],
    },
    filters: { school: '', department: '', specialty: '', grade: '', dailyGoal: '', weeklyGoal: '' },
    hasActiveFilter: false,
    canManage: false,
  },

  onShow() {
    this.reload();
    this.loadFilters();
  },

  // ===== 筛选选项 =====
  async loadFilters() {
    try {
      await getApp().ensureLogin();
      const opt = await auth.get('/api/admin/users/filters').catch(() => null);
      if (!opt) return; // 无 user.view 以外权限等
      const toOptions = (arr) => (arr || []).map((v) => ({ label: String(v), value: String(v) }));
      this.setData({
        filterOptions: {
          schools: toOptions(opt.schools),
          departments: toOptions(opt.departments),
          specialties: toOptions(opt.specialties),
          grades: toOptions(opt.grades),
          dailyGoals: toOptions(opt.dailyGoals).map((o) => ({ label: `${o.label} 步`, value: o.value })),
          weeklyGoals: toOptions(opt.weeklyGoals).map((o) => ({ label: `${o.label} 步`, value: o.value })),
        },
      });
    } catch (e) {
      /* 筛选项加载失败不阻塞列表 */
    }
  },

  updateFilterState() {
    const f = this.data.filters;
    const active = !!(f.school || f.department || f.specialty || f.grade || f.dailyGoal || f.weeklyGoal || this.data.keyword || this.data.status);
    this.setData({ hasActiveFilter: active });
  },

  clearFilters() {
    this.setData({
      filters: { school: '', department: '', specialty: '', grade: '', dailyGoal: '', weeklyGoal: '' },
      keyword: '',
      status: '',
      hasActiveFilter: false,
    });
    this.reload();
  },

  onDropdownChange(e) {
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value || '';
    this.setData({ [`filters.${key}`]: value });
    this.updateFilterState();
    this.reload();
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value || '' });
    this.updateFilterState();
    this.reload();
  },

  onClear() {
    this.setData({ keyword: '' });
    this.reload();
  },

  filterStatus(e) {
    const status = e.currentTarget.dataset.status;
    this.setData({ status: this.data.status === status ? '' : status });
    this.updateFilterState();
    this.reload();
  },

  buildQuery(extra = {}) {
    const { keyword, status, filters } = this.data;
    const q = { ...extra };
    if (keyword) q.keyword = keyword;
    if (status) q.status = status;
    for (const k of ['school', 'department', 'specialty', 'grade', 'dailyGoal', 'weeklyGoal']) {
      if (filters[k]) q[k] = filters[k];
    }
    return q;
  },

  async reload() {
    this.setData({ page: 1, list: [] });
    await this.load();
  },

  async load() {
    const { page, limit, loading } = this.data;
    if (loading) return;
    this.setData({ loading: page === 1, loadingMore: page > 1 });
    try {
      await getApp().ensureLogin();
      const me = getApp().globalData.userInfo;
      if (me && !this.data.canManage) this.setData({ canManage: !!me.isManager });
      const res = await auth.get('/api/admin/users', this.buildQuery({ page, limit }));
      const list = res.list.map((u) => ({
        ...u,
        isSuper: (u.permissionGroups || []).includes('superadmin'),
        swipeRight: this.buildSwipeButtons(u),
      }));
      this.setData({ list, total: res.total });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false, loadingMore: false });
    }
  },

  // 每行滑动按钮（对象里带 uid/type 供回调分发）
  buildSwipeButtons(u) {
    const id = u._id;
    const btns = [
      { text: '编辑', type: 'edit', uid: id, style: BTN_STYLE.edit },
      { text: '详细', type: 'detail', uid: id, style: BTN_STYLE.detail },
    ];
    if (u.status !== 'banned' && !u.isSuper) {
      btns.push({ text: '封禁', type: 'ban', uid: id, nickname: u.nickname || u.realName, style: BTN_STYLE.ban });
    }
    if (u.status === 'banned') {
      btns.push({ text: '解封', type: 'unban', uid: id, style: BTN_STYLE.unban });
    }
    if (!u.isSuper) {
      btns.push({ text: '删除', type: 'del', uid: id, nickname: u.nickname || u.realName, style: BTN_STYLE.del });
    }
    return btns;
  },

  // 滑动按钮点击分发
  async onSwipeAction(e) {
    const act = e.detail || {};
    if (act.type === 'edit') {
      wx.navigateTo({ url: `/packageAdmin/users/account-edit?id=${act.uid}` });
      return;
    }
    if (act.type === 'detail') {
      wx.navigateTo({ url: `/packageAdmin/user-detail/user-detail?id=${act.uid}` });
      return;
    }
    if (act.type === 'ban') {
      const that = this;
      wx.showModal({
        title: '封禁用户',
        editable: true,
        placeholderText: '封禁原因',
        success: async (res) => {
          if (!res.confirm) return;
          try {
            await auth.post(`/api/admin/users/${act.uid}/ban`, { reason: res.content || '违反社区规范', days: 7 });
            wx.showToast({ title: '已封禁 7 天', icon: 'success' });
            that.reload();
          } catch (err) {
            wx.showToast({ title: err.message, icon: 'none' });
          }
        },
      });
      return;
    }
    if (act.type === 'unban') {
      try {
        await auth.post(`/api/admin/users/${act.uid}/unban`);
        wx.showToast({ title: '已解封', icon: 'success' });
        this.reload();
      } catch (err) {
        wx.showToast({ title: err.message, icon: 'none' });
      }
      return;
    }
    if (act.type === 'del') {
      const that = this;
      wx.showModal({
        title: '删除用户',
        content: '将删除该用户及其全部运动/饮水/徽章等数据，不可恢复！确认删除？',
        confirmColor: '#d54941',
        success: async (res) => {
          if (!res.confirm) return;
          try {
            await auth.del(`/api/admin/users/${act.uid}`);
            wx.showToast({ title: '已删除', icon: 'success' });
            that.reload();
          } catch (err) {
            wx.showToast({ title: err.message, icon: 'none' });
          }
        },
      });
    }
  },

  onReachBottom() {
    if (this.data.list.length < this.data.total) {
      this.setData({ page: this.data.page + 1 });
      this.load();
    }
  },

  goImport() {
    wx.navigateTo({ url: '/packageAdmin/users/import' });
  },

  // 创建账户：独立页面填写
  goCreateAccount() {
    wx.navigateTo({ url: '/packageAdmin/users/account-edit' });
  },
});
