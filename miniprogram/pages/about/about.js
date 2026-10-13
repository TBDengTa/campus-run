Page({
  data: {
    version: '2.0.0',
    intro:
      '唐唐快跑是一款面向校园师生的运动记录小程序，结合微信运动和天地图能力，精准记录每一次跑步轨迹，帮助用户追踪运动目标、达成每日步数挑战，与同学好友一起健康奔跑。',
    company: '河北唐博科技有限公司',
    officialAccount: '唐博客',
    // 核心能力（静态文案，不请求接口）
    features: [
      { key: 'werun', icon: 'refresh', title: '微信运动同步', desc: '一键同步每日步数' },
      { key: 'gps', icon: 'location', title: 'GPS 轨迹记录', desc: '实跑路线完整留存' },
      { key: 'plan', icon: 'flag', title: '目标计划', desc: '按身体数据匹配' },
      { key: 'badge', icon: 'star', title: '徽章成就', desc: '坚持即可解锁' },
    ],
  },

  copyOfficialAccount() {
    wx.setClipboardData({
      data: this.data.officialAccount,
      success: () => {
        wx.showToast({ title: '公众号名称已复制，去微信搜索关注', icon: 'none', duration: 2500 });
      },
    });
  },

  // 版本日志（公开页，已登记在 app.json）
  goChangelogs() {
    wx.navigateTo({ url: '/pages/changelogs/changelogs' });
  },
});
