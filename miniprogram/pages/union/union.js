// 学生会工作台（主包）：待办优先（待复核 / 今日未录）+ 模块进度卡片 + 快捷入口
//
// 仅学生会成员可进（服务端 /api/union/* 全部做成员资格校验）；非成员进来会被 403002 拦住，
// 这里再兜一层：/api/union/mine 返回 isMember=false 时提示并返回上一页。
const auth = require('../../utils/request');

Page({
  data: {
    loading: true,
    date: '',
    dateText: '',
    roles: [],
    roleText: '',
    termName: '',
    termSession: null,
    termSessionName: '',
    isPresidium: false,
    reviewLevel: '',
    canReview: false,
    canManageMembers: false,
    // 扫码加人（主席团 / 部长 / 副部长 / union.steward）；服务端 dashboard 下发
    canUnionScanJoin: false,
    modules: [],
    pendingReview: 0,
    myPendingAppeal: 0,
    myToday: 0,
    myTotal: 0,
    // 待办优先：今日未录总数 / 「去录入」首选模块 / 全部录完的成功态
    missingTotal: 0,
    firstEntryKey: '',
    firstEntryName: '',
    allDone: false,
    isMember: false,
  },

  onLoad() {
    if (!getApp().requireLogin()) return;
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    this.syncTabBar();
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  syncTabBar() {
    if (typeof this.getTabBar !== 'function') return;
    const bar = this.getTabBar();
    if (bar && typeof bar.setActive === 'function') bar.setActive('/pages/union/union');
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const mine = await auth.get('/api/union/mine');
      if (!mine || !mine.isMember) {
        this.setData({ loading: false, isMember: false });
        return;
      }
      const data = await auth.get('/api/union/dashboard');
      const modules = (data.modules || []).map((m) => {
        const expected = m.expected || 0;
        const missing = m.missing || 0;
        // 「只记异常人」的模块（早八）：没有记录 = 当天没人迟到，不是漏录。
        // 服务端已把它的 missing 记为 0（不计待办），这里把文案也改掉，
        // 否则会出现「已完成」但进度写着 0/54 的自相矛盾观感。
        const optional = m.optionalWhenMissing === true;
        return {
          key: m.key,
          name: m.shortName || m.name,
          fullName: m.name,
          ownerDeptName: m.ownerDeptName || '',
          canEnter: m.canEnter,
          expected,
          entered: m.entered || 0,
          cancelled: m.cancelled || 0,
          missing,
          optionalWhenMissing: optional,
          noRecordText: m.noRecordText || '',
          progressText: m.canEnter ? `${m.entered}/${expected || '—'}` : '—',
          percent: m.canEnter && expected ? Math.min(100, Math.round((m.entered / expected) * 100)) : 0,
          // 状态徽标文案：非本部门 / 今日无对象 / **无迟到（早八专有）** / 已完成 / N 未录
          stateText: !m.canEnter
            ? '非本部门'
            : expected === 0
              ? '今日无对象'
              : optional && m.entered === 0
                ? m.noRecordText || '无迟到'
                : missing === 0
                  ? '已完成'
                  : `${missing} 未录`,
          stateClass: !m.canEnter ? '' : missing === 0 ? 'done' : 'todo',
        };
      });
      // 待办优先：未录完的模块置顶；其余保持接口返回的相对顺序（只改展示顺序，不发任何请求参数）
      const todo = modules.filter((m) => m.canEnter && m.missing > 0);
      const rest = modules.filter((m) => !(m.canEnter && m.missing > 0));
      const ordered = todo.concat(rest);
      const canEnterModules = ordered.filter((m) => m.canEnter);
      const missingTotal = canEnterModules.reduce((a, m) => a + m.missing, 0);
      const firstMissing = canEnterModules.find((m) => m.missing > 0) || canEnterModules[0] || null;
      this.setData({
        loading: false,
        isMember: true,
        date: data.date,
        dateText: `${Number(data.date.slice(5, 7))}月${Number(data.date.slice(8, 10))}日`,
        roles: data.roles || [],
        roleText: data.roleText || '',
        termName: mine.termName || '',
        termSession: mine.termSession || null,
        termSessionName: mine.termSessionName || '',
        isPresidium: !!mine.isPresidium,
        reviewLevel: data.reviewLevel || '',
        canReview: !!data.canReview,
        canManageMembers: !!data.canManageMembers,
        canUnionScanJoin: !!data.canScanJoin,
        modules: ordered,
        pendingReview: data.pendingReview || 0,
        myPendingAppeal: data.myPendingAppeal || 0,
        myToday: data.myToday || 0,
        myTotal: data.myTotal || 0,
        missingTotal,
        firstEntryKey: firstMissing ? firstMissing.key : '',
        firstEntryName: firstMissing ? firstMissing.name : '',
        allDone: canEnterModules.length > 0 && missingTotal === 0,
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  goEntry(e) {
    const key = e.currentTarget.dataset.key || '';
    if (!key) return;
    // 非本部门模块在行上也绑了 goEntry，但进入录入台只会被服务端 403002 拒 —— 这里直接返回
    const ds = e.currentTarget.dataset || {};
    if (ds.enter === '0' || ds.enter === 0 || ds.enter === false) return;
    wx.navigateTo({ url: `/packageUnion/entry/entry?moduleKey=${key}` });
  },

  goRecords() {
    wx.navigateTo({ url: '/packageUnion/records/records?mine=1' });
  },

  goReviewList() {
    wx.navigateTo({ url: '/packageUnion/records/records?status=submitted' });
  },

  goAppeals() {
    wx.navigateTo({ url: '/packageUnion/records/records?pendingAppeal=1' });
  },

  goAllRecords() {
    wx.navigateTo({ url: '/packageUnion/records/records' });
  },

  // 成员管理（用户 2026-10-28「去掉学生会成员管理，都是这个学生会成员」）：
  //   两个页面合为一个 —— 原来 packageUnion/members/manage（标题「成员管理」）与
  //   packageAdmin/union/members/members（标题「学生会成员」）功能重复，用户要求只留后者。
  //   现在从学生会工作台点「成员管理」直接进**同一个**页面，不再有两套 UI。
  goManageMembers() {
    wx.navigateTo({ url: '/packageAdmin/union/members/members' });
  },

  // 扫码加人（用户 2026-10-27）：扫码页在 packageAdmin/union/scan-join
  goScanJoin() {
    wx.navigateTo({ url: '/packageAdmin/union/scan-join/scan-join' });
  },

  goStats() {
    wx.navigateTo({ url: '/packageUnion/stats/stats' });
  },

  goRoster() {
    wx.navigateTo({ url: '/packageUnion/roster/roster' });
  },
});
