const auth = require('../../utils/request');

const STATUS = {
  pending: { text: '待审核', theme: 'warning' },
  approved: { text: '已通过', theme: 'success' },
  rejected: { text: '已驳回', theme: 'danger' },
};

Page({
  data: {
    tab: 'pending',
    list: [],
    loading: false,
  },

  onShow() {
    this.reload();
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
    this.reload();
  },

  reload() {
    this.setData({ list: [] });
    this.load();
  },

  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      const res = await auth.get('/api/admin/appeals', { status: this.data.tab, limit: 50 });
      this.setData({
        list: res.list.map((a) => {
          const u = a.user || null;
          return {
            ...a,
            openidShort: (a.openid || '').slice(0, 8),
            statusInfo: STATUS[a.status] || STATUS.pending,
            timeText: (a.createdAt || '').slice(0, 16).replace('T', ' '),
            typeText: a.banTypeText || '限制登录',
            untilText: a.banUntil ? String(a.banUntil).slice(0, 16).replace('T', ' ') : '永久',
            // 用户当前事实：是否仍在受限、哪些限制生效
            userText: u ? `${u.realName || '未命名'}${u.studentId ? ' · ' + u.studentId : ''}` : a.openidShort,
            className: (u && u.className) || '',
            activeText: u && u.restrictions && u.restrictions.length ? u.restrictions.map((r) => r.text).join('、') : '无生效限制',
          };
        }),
      });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  review(e) {
    const { id, approve } = e.currentTarget.dataset;
    const that = this;
    const row = (this.data.list || []).find((x) => x._id === id) || {};
    wx.showModal({
      title: approve === 'true' ? `通过并解除「${row.typeText || '限制'}」` : '驳回申诉',
      editable: true,
      placeholderText: '回复内容（可空）',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          // 不传 scope：服务端按申诉针对的类型解除（避免误解除其它限制）
          await auth.post(`/api/admin/appeals/${id}/review`, {
            approve: approve === 'true',
            reply: res.content || '',
          });
          wx.showToast({ title: '已处理', icon: 'success' });
          that.reload();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },
});
