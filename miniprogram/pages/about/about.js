Page({
  data: {
    version: '2.0.0',
    intro:
      '唐唐快跑是一款面向校园师生的运动记录小程序，结合微信运动和天地图能力，精准记录每一次跑步轨迹，帮助用户追踪运动目标、达成每日步数挑战，与同学好友一起健康奔跑。',
    company: '河北唐博科技有限公司',
    officialAccount: '唐博客',
  },

  copyOfficialAccount() {
    wx.setClipboardData({
      data: this.data.officialAccount,
      success: () => {
        wx.showToast({ title: '公众号名称已复制，去微信搜索关注', icon: 'none', duration: 2500 });
      },
    });
  },
});
