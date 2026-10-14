const auth = require('../../utils/request');
const fmt = require('../../utils/format');

function fmtTime(v) {
  return v ? String(v).slice(0, 16).replace('T', ' ') : '';
}

// 日期 → 「M月D日」
function dateText(dateKey) {
  if (!dateKey) return '';
  return `${Number(dateKey.slice(5, 7))}月${Number(dateKey.slice(8, 10))}日`;
}

// 运动明细每页条数（按钮翻页）
const PAGE_SIZE = 10;

// 页码条：页数少时全列，多时首尾 + 当前页附近，间隔用省略号
function buildPageItems(current, total) {
  const out = [];
  const push = (page, label) => out.push({ k: `${page}-${out.length}`, page, label: label || String(page) });
  if (total <= 7) {
    for (let i = 1; i <= total; i += 1) push(i);
    return out;
  }
  push(1);
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) push(0, '…');
  for (let i = start; i <= end; i += 1) push(i);
  if (end < total - 1) push(0, '…');
  push(total);
  return out;
}

Page({
  data: {
    id: '',
    user: null,
    bans: [],
    loading: true,
    isSuper: false,
    // 当前登录者权限：编辑资料/重置密码/删除账户需 permission.manage，解绑微信需 user.manage
    canManagePerms: false,
    canManageUser: false,
    // 当前生效的限制（限制登录 / 限制微信同步 / 限制 GPS）
    restrictions: [],
    // 「限制账号功能」抽屉
    banSheet: { visible: false, user: null, busy: false },
    // ===== 考核与运动全景 =====
    rates: null,
    goal: null,
    recordTab: 'daily', // 最近运动 runs | 日记录 daily | 周记录 weekly | 饮水 water | 徽章 badges
    // 运动明细：按 Tab 分页缓存（每页 PAGE_SIZE 条，按钮翻页，不是触底追加）
    records: { runs: [], daily: [], weekly: [], water: [], badges: [] },
    recordPages: { runs: 1, daily: 1, weekly: 1, water: 1, badges: 1 }, // 各 Tab 记忆自己的页码
    recordTotals: { runs: 0, daily: 0, weekly: 0, water: 0, badges: 0 },
    recordPage: 1,
    recordPagesTotal: 1,
    recordTotal: 0,
    pageItems: [], // 页码条：[{ k, label, page }]
    recordLoading: false,
    loginInfo: null,
    unbinding: false,
  },

  onLoad(options) {
    this.setData({ id: options.id || '' });
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const me = (getApp().globalData.userInfo || {}).effectivePermissions || [];
      this.setData({
        canManagePerms: me.includes('*') || me.includes('permission.manage'),
        canManageUser: me.includes('*') || me.includes('user.manage'),
      });
      const [detail, sportDetail] = await Promise.all([
        auth.get(`/api/admin/users/${this.data.id}`),
        auth.get(`/api/admin/users/${this.data.id}/sport-detail`).catch(() => null),
      ]);
      const { user, bans, sport: sportArg, goal: goalArg, loginInfo, restrictions } = detail;
      const SCOPE_TEXT = { login: '限制登录', sync: '限制微信同步', gps: '限制 GPS', manual: '限制登录' };
      // 限制类型对应图标（在 JS 里算好：WXML 的三元表达式会让静态检查把 'sync' 当成图标名）
      const SCOPE_ICON = { login: 'lock-on', sync: 'logo-wechat-stroke', gps: 'location' };
      const recentRuns = ((sportArg && sportArg.recentRuns) || []).map((r) => ({
        ...r,
        dateText: dateText(r.date),
        distanceText: fmt.formatDistance(r.distance),
        durationText: fmt.formatDuration(r.durationSeconds),
        sourceText: r.source === 'gps' ? 'GPS 实跑' : '微信运动',
      }));

      const rates = sportDetail && sportDetail.rates;
      const goal = (sportDetail && sportDetail.goal) || goalArg || null;
      this.setData({
        loading: false,
        isSuper: (user.permissionGroups || []).includes('superadmin'),
        user: {
          ...user,
          createdText: fmtTime(user.createdAt),
          bannedUntilText: user.bannedUntil ? user.bannedUntil.slice(0, 16).replace('T', ' ') : '',
        },
        bans: bans.map((b) => ({
          ...b,
          timeText: fmtTime(b.createdAt),
          typeText: SCOPE_TEXT[b.banType] || (b.banType === 'manual' ? '限制登录' : '功能限制'),
        })),
        restrictions: (restrictions || []).map((r) => ({
          ...r,
          icon: SCOPE_ICON[r.scope] || 'lock-on',
          untilText: r.until ? fmtTime(r.until) : '永久',
        })),
        sport: {
          totalStepsText: fmt.formatNumber(user.totalSteps || 0),
          totalDistanceText: fmt.formatDistance(user.totalDistance || 0),
          totalDays: user.totalDays || 0,
          badgeCount: (sportArg && sportArg.badgeCount) || 0,
          waterToday: (sportArg && sportArg.waterToday) || { total: 0, target: 0 },
          recentRuns,
        },
        rates: rates
          ? {
              dailyRateText: rates.dailyRate == null ? '—' : `${rates.dailyRate}%`,
              weeklyRateText: rates.weeklyRate == null ? '—' : `${rates.weeklyRate}%`,
              dailyText: rates.dailyTotal ? `达标 ${rates.dailyAchieved} / ${rates.dailyTotal} 天` : '暂无记录',
              weeklyText: rates.weeklyTotal ? `达标 ${rates.weeklyAchieved} / ${rates.weeklyTotal} 周` : '暂无记录',
            }
          : null,
        goal: goal
          ? {
              planName: goal.planName || '默认目标',
              dailyStepsText: fmt.formatNumber(goal.daily && goal.daily.steps),
              weeklyStepsText: fmt.formatNumber(goal.weekly && goal.weekly.steps),
            }
          : null,
        // 明细列表改由 /:id/records 分页加载（见 loadRecords），这里不再接收全量
        loginInfo: loginInfo
          ? {
              ...loginInfo,
              wechatBoundAtText: fmtTime(loginInfo.wechatBoundAt),
              lastLoginText: fmtTime(loginInfo.lastLogin),
              lastWxSessionText: fmtTime(loginInfo.lastWxSessionAt),
              lastSyncText: fmtTime(loginInfo.lastSyncAt),
              devices: (loginInfo.devices || []).map((d) => ({
                ...d,
                lastUsedText: fmtTime(d.lastUsedAt || d.createdAt),
                expireText: d.revoked ? '已吊销' : fmtTime(d.expiresAt) + ' 过期',
              })),
            }
          : null,
        // 换用户时清空明细分页缓存，随后按当前 Tab 拉第一页
        records: { runs: [], daily: [], weekly: [], water: [], badges: [] },
        recordPages: { runs: 1, daily: 1, weekly: 1, water: 1, badges: 1 },
        recordTotals: { runs: 0, daily: 0, weekly: 0, water: 0, badges: 0 },
        recordPage: 1,
        recordPagesTotal: 1,
        recordTotal: 0,
        pageItems: [],
      });
      this.loadRecords(this.data.recordTab, 1);
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  // 明细 Tab 切换：首次进入该 Tab 才拉数据；已加载过则恢复它自己的页码
  switchRecordTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.recordTab) return;
    const cached = ((this.data.records || {})[tab] || []).length > 0;
    const pages = this.data.recordPages || {};
    const totals = this.data.recordTotals || {};
    const page = cached ? pages[tab] || 1 : 1;
    const total = cached ? totals[tab] || 0 : 0;
    this.setData({
      recordTab: tab,
      recordPage: page,
      recordTotal: total,
      recordPagesTotal: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      pageItems: buildPageItems(page, Math.max(1, Math.ceil(total / PAGE_SIZE))),
    });
    if (!cached) this.loadRecords(tab, 1);
  },

  // 运动明细分页加载：每次只取一页（type: runs|daily|weekly|water|badges）
  async loadRecords(tab, page) {
    const type = tab || this.data.recordTab;
    if (this.data.recordLoading) return;
    const p = Math.max(1, page || 1);
    this.setData({ recordLoading: true });
    try {
      const res = await auth.get(`/api/admin/users/${this.data.id}/records`, { type, page: p, limit: PAGE_SIZE });
      const list = ((res && res.list) || []).map((it) => this.fmtRecord(type, it));
      const total = (res && res.total) || 0;
      const pagesTotal = Math.max(1, Math.ceil(total / PAGE_SIZE));
      this.setData({
        records: { ...this.data.records, [type]: list },
        recordPages: { ...this.data.recordPages, [type]: p },
        recordTotals: { ...this.data.recordTotals, [type]: total },
        recordPage: p,
        recordTotal: total,
        recordPagesTotal: pagesTotal,
        pageItems: buildPageItems(p, pagesTotal),
      });
    } catch (e) {
      wx.showToast({ title: e.message || '明细加载失败', icon: 'none' });
    } finally {
      this.setData({ recordLoading: false });
    }
  },

  // 各类型明细的展示字段（与详情接口口径一致）
  fmtRecord(type, it) {
    if (type === 'runs') {
      return {
        ...it,
        dateText: dateText(it.date),
        distanceText: fmt.formatDistance(it.distance),
        durationText: fmt.formatDuration(it.durationSeconds),
        sourceText: it.source === 'gps' ? 'GPS 实跑' : '微信运动',
      };
    }
    if (type === 'daily') return { ...it, dateText: dateText(it.date), stepsText: fmt.formatNumber(it.steps) };
    if (type === 'weekly') {
      return {
        ...it,
        rangeText: `${String(it.weekStart).slice(5).replace('-', '.')} - ${String(it.weekEnd).slice(5).replace('-', '.')}`,
        stepsText: fmt.formatNumber(it.steps),
      };
    }
    if (type === 'water') return { ...it, dateText: dateText(it.date) };
    return { ...it, earnedText: fmtTime(it.earnedAt) };
  },

  // 按钮翻页：上一页 / 指定页 / 下一页
  goRecordPage(e) {
    const p = Number(e.currentTarget.dataset.page) || 0;
    if (!p || p === this.data.recordPage) return;
    if (p < 1 || p > this.data.recordPagesTotal) return;
    this.loadRecords(this.data.recordTab, p);
  },

  prevRecordPage() {
    if (this.data.recordPage > 1) this.loadRecords(this.data.recordTab, this.data.recordPage - 1);
  },

  nextRecordPage() {
    if (this.data.recordPage < this.data.recordPagesTotal) {
      this.loadRecords(this.data.recordTab, this.data.recordPage + 1);
    }
  },

  // 解绑微信：二次确认后清除绑定（可被新微信重新绑定）
  unbindWechat() {
    const that = this;
    wx.showModal({
      title: '解绑微信',
      content: '解绑后该账号将被此微信退出登录，可由任意微信重新绑定姓名密码；其运动等数据保留。确认解绑？',
      confirmColor: '#e5484d',
      success: async (res) => {
        if (!res.confirm) return;
        that.setData({ unbinding: true });
        try {
          await auth.post(`/api/admin/users/${that.data.id}/unbind-wechat`);
          wx.showToast({ title: '已解绑', icon: 'success' });
          that.load();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        } finally {
          that.setData({ unbinding: false });
        }
      },
    });
  },

  openRun(e) {
    wx.navigateTo({ url: `/pages/run/detail?id=${e.currentTarget.dataset.id}&admin=1&uid=${this.data.id}` });
  },

  // 日/周记录 → 时段明细页（日：当天逐条；周：按天拆分）
  openPeriod(e) {
    const { type, date } = e.currentTarget.dataset;
    if (!date) return;
    const u = this.data.user || {};
    const name = u.realName || u.nickname || '';
    wx.navigateTo({
      url: `/packageAdmin/user-detail/period-detail/period-detail?id=${this.data.id}&type=${type || 'day'}&date=${date}&name=${encodeURIComponent(name)}`,
    });
  },

  goEdit() {
    wx.navigateTo({ url: `/packageAdmin/users/account-edit/account-edit?id=${this.data.id}` });
  },

  // 限制账号功能（类型 + 时长 + 原因）——走 ban-sheet 抽屉
  openBanSheet() {
    const u = this.data.user || {};
    this.setData({
      banSheet: { visible: true, user: { _id: this.data.id, account: u.account || u.nickname || u.realName || '' }, busy: false },
    });
  },

  onBanSheetClose() {
    this.setData({ 'banSheet.visible': false });
  },

  async onBanSubmit(e) {
    const { scope, days, reason } = e.detail || {};
    this.setData({ 'banSheet.busy': true });
    try {
      await auth.post(`/api/admin/users/${this.data.id}/ban`, { scope, days, reason: reason || '违反社区规范' });
      const text = { login: '限制登录', sync: '限制微信同步', gps: '限制 GPS' }[scope] || '已限制';
      wx.showToast({ title: `${text}${days > 0 ? ' ' + days + ' 天' : '（永久）'}`, icon: 'none' });
      this.setData({ 'banSheet.visible': false });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' });
    } finally {
      this.setData({ 'banSheet.busy': false });
    }
  },

  // 解除限制：列出生效中的限制，再补固定三类 + 全部解除
  unban() {
    const that = this;
    const items = [{ label: '全部解除', scope: 'all' }];
    (this.data.restrictions || []).forEach((r) => items.push({ label: `解除「${r.text}」`, scope: r.scope }));
    [
      { label: '解除限制登录', scope: 'login' },
      { label: '解除微信同步限制', scope: 'sync' },
      { label: '解除 GPS 限制', scope: 'gps' },
    ].forEach((f) => {
      if (!items.some((i) => i.scope === f.scope)) items.push(f);
    });
    wx.showActionSheet({
      itemList: items.map((i) => i.label),
      success: async (res) => {
        const scope = (items[res.tapIndex] || {}).scope || 'all';
        try {
          const r = await auth.post(`/api/admin/users/${that.data.id}/unban`, { scope });
          wx.showToast({ title: r && r.lifted && r.lifted.length ? '已解除' : '该类型当前无生效限制', icon: 'none' });
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
