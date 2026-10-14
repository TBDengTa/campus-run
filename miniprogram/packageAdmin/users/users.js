const auth = require('../../utils/request');

// 左滑按钮：滑出区域由组件内部节点渲染，只能用内联样式。
// 三个必须遵守的点：
//   ① `display` 只能是 `inline-flex`（TDesign 自带的 `.t-swipe-cell__content` 就是 inline-flex）——
//      写成 `display:flex` 会让按钮变成块级、在滑出容器里**竖着堆叠**，被行高一裁就只剩第一个「编辑」；
//   ② 显式写 `padding:0`，否则 TDesign 的 `padding:0 32rpx` 会把每个按钮从 104rpx 撑到 168rpx，
//      三个按钮要滑出 504rpx 才吸附展开，手机上一次很难滑到底；
//   ③ 宽度/字号按手机端收敛（104rpx / 24rpx），颜色取设计令牌。
const BTN_BASE = 'box-sizing:border-box;padding:0;color:#fff;font-size:24rpx;width:104rpx;height:100%;display:inline-flex;align-items:center;justify-content:center';
const BTN_STYLE = {
  edit: `background:#ff6b00;${BTN_BASE}`,
  ban: `background:#e5484d;${BTN_BASE}`,
  unban: `background:#16a34a;${BTN_BASE}`,
  del: `background:#6b7280;${BTN_BASE}`,
};

// 筛选条件的展示名（用于「已筛选」提示条）
const FILTER_LABELS = {
  school: '院校',
  department: '系部',
  specialty: '专业',
  grade: '年级',
  dailyAchieved: '日目标',
  weeklyAchieved: '周目标',
};

// 列表上方常驻分类 Tab：管理员不是角色而是权限，单独传 manager=1
const ROLE_TABS = [
  { key: 'all', label: '全部' },
  { key: 'student', label: '学生' },
  { key: 'teacher', label: '教师' },
  { key: 'manager', label: '管理员' },
];
const ROLE_TAB_LABELS = { all: '全部', student: '学生', teacher: '教师', manager: '管理员' };

// 日/周目标筛的是「当日 / 当周是否达标」，不是目标步数
const ACHIEVE_OPTIONS = [
  { label: '已达标', value: '1' },
  { label: '未达标', value: '0' },
];
const ACHIEVE_TEXT = { 1: '已达标', 0: '未达标' };

// 生效中的限制类型：login 限制登录 / sync 限制微信同步 / gps 限制 GPS 实跑
// （限制登录 = status=banned 且未到期；sync/gps = restrictions[s].until 未到期）
const SCOPE_LABELS = { login: '限制登录', sync: '限制微信同步', gps: '限制 GPS' };
function activeScopes(u) {
  const now = Date.now();
  const out = [];
  if (u.status === 'banned' && (!u.bannedUntil || new Date(u.bannedUntil).getTime() > now)) out.push('login');
  for (const s of ['sync', 'gps']) {
    const r = (u.restrictions || {})[s];
    if (r && r.until && new Date(r.until).getTime() > now) out.push(s);
  }
  return out;
}
function hasActiveRestriction(u) {
  return activeScopes(u).length > 0;
}

Page({
  data: {
    keyword: '',
    status: '',
    role: '',
    manager: '', // '1' = 管理员 Tab（按权限过滤）
    roleTab: 'all',
    tabs: ROLE_TABS,
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
      dailyAchieved: ACHIEVE_OPTIONS,
      weeklyAchieved: ACHIEVE_OPTIONS,
    },
    filters: { school: '', department: '', specialty: '', grade: '', dailyAchieved: '', weeklyAchieved: '' },
    hasActiveFilter: false,
    filterCount: 0, // 筛选面板按钮上的角标
    filterSummary: '', // 已生效条件文案
    showFilters: false, // 筛选面板默认收起，把首屏留给列表
    canManage: false,
    // 「限制账号功能」抽屉（ban-sheet 组件）
    banSheet: { visible: false, user: null, busy: false },
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
          ...this.data.filterOptions,
          schools: toOptions(opt.schools),
          departments: toOptions(opt.departments),
          specialties: toOptions(opt.specialties),
          // 年级展示为「2024级」，筛选值仍是年份
          grades: (opt.grades || []).map((v) => ({ label: `${v}级`, value: String(v) })),
        },
      });
    } catch (e) {
      /* 筛选项加载失败不阻塞列表 */
    }
  },

  updateFilterState() {
    const f = this.data.filters;
    const summary = [];
    for (const k of Object.keys(FILTER_LABELS)) {
      if (!f[k]) continue;
      if (k === 'dailyAchieved' || k === 'weeklyAchieved') {
        summary.push(`${FILTER_LABELS[k]} ${ACHIEVE_TEXT[f[k]] || ''}`);
        continue;
      }
      summary.push(`${FILTER_LABELS[k]} ${f[k]}`);
    }
    if (this.data.status === 'active') summary.push('状态 正常');
    if (this.data.status === 'banned') summary.push('状态 封禁');
    if (this.data.roleTab !== 'all') summary.push(`分类 ${ROLE_TAB_LABELS[this.data.roleTab]}`);
    if (this.data.keyword) summary.push(`关键词「${this.data.keyword}」`);
    this.setData({
      hasActiveFilter: summary.length > 0,
      filterCount: summary.length,
      filterSummary: summary.join(' · '),
    });
  },

  // 展开 / 收起筛选面板
  toggleFilters() {
    this.setData({ showFilters: !this.data.showFilters });
  },

  clearFilters() {
    this.setData({
      filters: { school: '', department: '', specialty: '', grade: '', dailyAchieved: '', weeklyAchieved: '' },
      keyword: '',
      status: '',
      role: '',
      manager: '',
      roleTab: 'all',
      hasActiveFilter: false,
      filterCount: 0,
      filterSummary: '',
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

  // 分类 Tab：'' 全部 / student 学生 / teacher 教师 / manager 管理员（按权限）
  switchTab(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.roleTab) return;
    const patch = { roleTab: key, role: '', manager: '' };
    if (key === 'student' || key === 'teacher') patch.role = key;
    if (key === 'manager') patch.manager = '1';
    this.setData(patch);
    this.updateFilterState();
    this.reload();
  },

  buildQuery(extra = {}) {
    const { keyword, status, role, manager, filters } = this.data;
    const q = { ...extra };
    if (keyword) q.keyword = keyword;
    if (status) q.status = status;
    if (role) q.role = role;
    if (manager) q.manager = manager;
    for (const k of ['school', 'department', 'specialty', 'grade', 'dailyAchieved', 'weeklyAchieved']) {
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
      const list = res.list.map((u) => {
        // 先算出 isSuper 再生成滑动按钮：buildSwipeButtons 依赖 isSuper，
        // 直接把原始 u 传进去会让超管的「封禁/删除」也出现（u.isSuper 为 undefined）
        const item = { ...u, isSuper: (u.permissionGroups || []).includes('superadmin') };
        // 生效中的限制（限制登录 / 微信同步 / GPS）：Hover 标签与「解除」按钮都依赖它
        item.activeScopes = activeScopes(item);
        item.scopeLabels = item.activeScopes.map((s) => SCOPE_LABELS[s]);
        // 展示字段：WXML 不做表达式拼接，这里预计算好
        item.nameText = u.account || u.nickname || u.realName || '未命名';
        item.initial = item.nameText.charAt(0);
        item.isTeacher = u.role === 'teacher';
        if (item.isTeacher) {
          // 教师无学号/班级/目标，展示所属院系
          item.deptText = [u.departmentName, u.schoolName].filter(Boolean).join(' · ');
        } else {
          // 运动目标显示计划名称；没有个人计划（走全局默认）的学生显示「默认目标」
          item.goalText = (u.goal && u.goal.planName) || '默认目标';
        }
        item.swipeRight = this.buildSwipeButtons(item);
        return item;
      });
      // 触底加载下一页：拼在已有列表后面（不能整体覆盖，否则翻页会冲掉前面的数据）
      this.setData({ list: [...this.data.list, ...list], total: res.total });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false, loadingMore: false });
    }
  },

  // 每行滑动按钮（对象里带 uid/type 供回调分发）
  // 「详细」改为点击卡片进入；封禁改为打开「限制账号功能」抽屉（可选类型 + 时长）
  buildSwipeButtons(u) {
    const id = u._id;
    const btns = [{ text: '编辑', type: 'edit', uid: id, style: BTN_STYLE.edit }];
    if (!u.isSuper) {
      btns.push({ text: '限制', type: 'ban', uid: id, nickname: u.nickname || u.realName, style: BTN_STYLE.ban });
    }
    if (u.status === 'banned' || hasActiveRestriction(u)) {
      btns.push({ text: '解除', type: 'unban', uid: id, style: BTN_STYLE.unban });
    }
    if (!u.isSuper) {
      btns.push({ text: '删除', type: 'del', uid: id, nickname: u.nickname || u.realName, style: BTN_STYLE.del });
    }
    return btns;
  },

  // 打开「限制账号功能」抽屉
  openBanSheet(uid) {
    const u = (this.data.list || []).find((x) => x._id === uid);
    if (!u) return;
    this.setData({
      banSheet: {
        visible: true,
        user: { _id: u._id, account: u.account || u.nickname || u.realName || '' },
        busy: false,
      },
    });
  },

  onBanSheetClose() {
    this.setData({ 'banSheet.visible': false });
  },

  // 提交限制：类型（登录/微信同步/GPS）+ 时长（>0 天 / 0 = 永久）
  async onBanSubmit(e) {
    const id = this.data.banSheet.user && this.data.banSheet.user._id;
    if (!id) return;
    const { scope, days, reason } = e.detail || {};
    this.setData({ 'banSheet.busy': true });
    try {
      await auth.post(`/api/admin/users/${id}/ban`, {
        scope,
        days,
        reason: reason || '违反社区规范',
      });
      const text = { login: '限制登录', sync: '限制微信同步', gps: '限制 GPS' }[scope] || '已限制';
      wx.showToast({ title: `${text}${days > 0 ? ' ' + days + ' 天' : '（永久）'}`, icon: 'none' });
      this.setData({ 'banSheet.visible': false });
      this.reload();
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' });
    } finally {
      this.setData({ 'banSheet.busy': false });
    }
  },

  // 解除限制：可选按类型解除或全部解除
  onUnban(uid) {
    const that = this;
    wx.showActionSheet({
      itemList: ['全部解除', '解除限制登录', '解除微信同步限制', '解除 GPS 限制'],
      success: async (r) => {
        const scope = ['all', 'login', 'sync', 'gps'][r.tapIndex];
        try {
          const res = await auth.post(`/api/admin/users/${uid}/unban`, { scope });
          wx.showToast({
            title: res && res.lifted && res.lifted.length ? '已解除' : '该类型当前无生效限制',
            icon: 'none',
          });
          that.reload();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },

  // 点击整行 → 用户详情（手机端主操作路径，不必先左滑）
  onRowTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/packageAdmin/user-detail/user-detail?id=${id}` });
  },

  // 滑动按钮点击分发
  async onSwipeAction(e) {
    const act = e.detail || {};
    if (act.type === 'edit') {
      wx.navigateTo({ url: `/packageAdmin/users/account-edit/account-edit?id=${act.uid}` });
      return;
    }
    if (act.type === 'detail') {
      wx.navigateTo({ url: `/packageAdmin/user-detail/user-detail?id=${act.uid}` });
      return;
    }
    if (act.type === 'ban') {
      this.openBanSheet(act.uid);
      return;
    }
    if (act.type === 'unban') {
      this.onUnban(act.uid);
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

  // 创建账户：独立页面填写（注意是两级目录，路径必须写全）
  goCreateAccount() {
    wx.navigateTo({ url: '/packageAdmin/users/account-edit/account-edit' });
  },
});
