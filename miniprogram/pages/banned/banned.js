const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// 申诉状态文案（与 pages/appeal/list 同口径；这里只读展示，不改那边）
const APPEAL_STATUS = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已驳回',
};

// 兜底：服务端没下发 sourceText 时用短词（与 models/ban-record.js::SOURCE_TEXT 同值）
// ⚠️ 只是兜底 —— 只要服务端给了 sourceText 就必须用它（服务端是唯一文案源）
const BAN_SOURCE_TEXT = {
  manual: '人封',
  ai: 'AI封',
  rule: '机封',
  appeal: '申诉',
  legacy: '早期',
};

Page({
  data: {
    user: null,
    loading: true,
    untilText: '',
    // 生效中的全部限制（限制登录 / 限制微信同步 / 限制 GPS）：用户 2026-11-02
    // 「点击可以进入详细并申诉等」—— 详情页要能一次看全，而不是只说「限制登录」一句
    restrictions: [],
    // 最近一条申诉（有就显示进度，并据此把「提交申诉」变成「查看进度」）
    latestAppeal: null,
    appealPending: false,
    sourceText: '',
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    this.load();
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const user = await auth.get('/api/auth/me');
      // 三个读接口都在服务端「被封禁仍可访问」白名单内（middlewares/auth.js::BANNED_ALLOW）。
      // 任何一项失败都不能让整页白屏 —— 封禁页本来就是用户唯一的出口。
      const [resRes, appealRes] = await Promise.allSettled([
        auth.get('/api/appeals/restrictions'),
        auth.get('/api/appeals/mine', { limit: 10 }),
      ]);
      const restrictions = resRes.status === 'fulfilled' && resRes.value ? resRes.value.restrictions || [] : [];
      const appeals = appealRes.status === 'fulfilled' && appealRes.value ? appealRes.value.list || [] : [];
      this.apply(user, restrictions, appeals);
    } catch (e) {
      const user = getApp().globalData.userInfo;
      this.apply(user, [], []);
    }
  },

  apply(user, restrictions, appeals) {
    const login = (restrictions || []).find((r) => r.scope === 'login');
    const rows = (restrictions || []).map((r) => ({
      scope: r.scope,
      text: r.text || '',
      reason: r.reason || '违反社区规范',
      untilText: r.until ? fmt.formatDateTime(r.until) : '无固定期限（永久）',
      // 分类文案：服务端 sourceText 优先，前端表只做兜底
      sourceText: r.sourceText || BAN_SOURCE_TEXT[r.source] || '',
    }));
    const latest = (appeals || [])[0] || null;
    const appealPending = !!(latest && latest.status === 'pending');
    this.setData({
      loading: false,
      user,
      untilText: user && user.bannedUntil ? fmt.formatDateTime(user.bannedUntil) : '',
      restrictions: rows,
      latestAppeal: latest
        ? {
            ...latest,
            statusText: APPEAL_STATUS[latest.status] || '待审核',
            createdAtText: fmt.formatDateTime(latest.createdAt),
            banTypeText: latest.banTypeText || '',
          }
        : null,
      appealPending,
      sourceText: (login && login.sourceText) || BAN_SOURCE_TEXT[(user && user.banSource) || ''] || '',
    });
  },

  goSubmit() {
    wx.navigateTo({ url: '/pages/appeal/submit?scope=login' });
  },

  goList() {
    wx.navigateTo({ url: '/pages/appeal/list' });
  },

  async refreshStatus() {
    try {
      const user = await getApp().refreshUser();
      if (user.status !== 'banned') {
        wx.showToast({ title: '已解除封禁', icon: 'success' });
        setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 1000);
        return;
      }
      await this.load();
      wx.showToast({ title: '仍在封禁中', icon: 'none' });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
});
