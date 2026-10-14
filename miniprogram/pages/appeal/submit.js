const auth = require('../../utils/request');

Page({
  data: {
    content: '',
    contentLength: 0,
    submitting: false,
    user: null,
    // 生效中的限制（限制登录 / 限制微信同步 / 限制 GPS）——用户选一类申诉
    restrictions: [],
    scope: '',
  },

  onLoad(options) {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    const user = getApp().globalData.userInfo || auth.getUser();
    this.setData({ user });
    this.loadRestrictions(options && options.scope);
  },

  // 拉取当前生效的限制：只有一类时自动选中
  async loadRestrictions(preferScope) {
    try {
      await getApp().ensureLogin();
      const res = await auth.get('/api/appeals/restrictions');
      const list = (res && res.restrictions) || [];
      const prefer = list.find((r) => r.scope === preferScope);
      const scope = (prefer && prefer.scope) || (list.length === 1 ? list[0].scope : list.length ? 'login' : '');
      this.setData({
        restrictions: list.map((r) => ({
          ...r,
          untilText: r.until ? String(r.until).slice(0, 16).replace('T', ' ') : '永久',
        })),
        scope,
      });
    } catch (e) {
      // 被限制登录的用户也能调这个接口（白名单内），失败时不阻塞申诉
      this.setData({ restrictions: [] });
    }
  },

  pickScope(e) {
    this.setData({ scope: e.currentTarget.dataset.scope });
  },

  input(e) {
    const value = e.detail.value;
    this.setData({ content: value, contentLength: (value || '').length });
  },

  async submit() {
    const { content, submitting, scope, restrictions } = this.data;
    if (submitting) return;
    if (!content || content.trim().length < 10) {
      wx.showToast({ title: '请填写至少 10 字的申诉说明', icon: 'none' });
      return;
    }
    if (restrictions.length && !scope) {
      wx.showToast({ title: '请选择要申诉的限制类型', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      await getApp().ensureLogin();
      await auth.post('/api/appeals', { content: content.trim(), scope: scope || undefined });
      wx.showToast({ title: '申诉已提交', icon: 'success' });
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/appeal/list' });
      }, 1200);
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
