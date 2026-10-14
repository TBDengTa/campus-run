// 内容管理分类中枢：公告 / 版本日志 / 节假日 / 组织架构 / 徽章
Page({
  data: {
    cats: [
      { key: 'announcements', icon: 'notification', title: '公告管理', desc: '发布 / 启用 / 排序', url: '/packageAdmin/content/announcements' },
      { key: 'changelogs', icon: 'history', title: '版本日志', desc: '版本更新记录', url: '/packageAdmin/content/changelogs' },
      { key: 'holidays', icon: 'calendar', title: '节假日', desc: '放假与调休安排', url: '/packageAdmin/content/holidays' },
      { key: 'organizations', icon: 'usergroup', title: '组织架构', desc: '学校 / 院系 / 专业', url: '/packageAdmin/content/organizations' },
      { key: 'badges', icon: 'star', title: '徽章', desc: '徽章定义与发放条件', url: '/packageAdmin/content/badges' },
    ],
  },

  onShow() {
    this.checkAndLoad();
  },

  async checkAndLoad() {
    try {
      await getApp().ensureLogin();
      const user = await getApp().refreshUser();
      const perms = user.effectivePermissions || [];
      if (!user.isManager || (!perms.includes('content.view') && !perms.includes('*'))) {
        wx.showModal({
          title: '无权限',
          content: '该功能仅限持有内容权限的教师/管理员使用',
          showCancel: false,
          success: () => wx.switchTab({ url: '/pages/home/home' }),
        });
      }
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  go(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url });
  },
});
