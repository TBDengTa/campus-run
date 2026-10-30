Page({
  data: {
    // 版本号：与 README / GitHub 发布标签保持一致（用户 2026-10-27「现在版本是 2.0.5 了」）；
// 服务端状态页与 /health 的 version 来自 server/package.json，三处必须一致。
    version: '2.0.5',
    company: '河北唐博科技有限公司',
    officialAccount: '唐博客',
    tagline: '校园运动记录 · 微信运动同步 · 轨迹与目标管理',
    stack: '微信小程序原生框架 · TDesign · Node.js/Express · MongoDB',
    intro:
      '面向校园师生的运动健康小程序。结合微信运动与设备定位记录步数与跑步轨迹，支持个人目标计划、成就徽章与班超评比，帮助师生建立可坚持的运动习惯。',
    // 开源仓库（本项目已在 GitHub 开源）
    repoUrl: 'https://github.com/TBDengTa/campus-run',
    repoText: 'TBDengTa/campus-run',
    // 核心能力（静态文案，不请求接口；紧凑版只取标题做成 chip 行）
    features: [
      { key: 'werun', icon: 'refresh', title: '微信运动同步' },
      { key: 'gps', icon: 'location', title: 'GPS 轨迹记录' },
      { key: 'plan', icon: 'flag', title: '目标计划' },
      { key: 'badge', icon: 'star', title: '徽章成就' },
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

  // 开源仓库地址：**只复制，不跳转**。
  // 小程序里打开外部网页只有 <web-view> 一条路，而它要求域名在微信公众平台
  // 「业务域名」白名单里 —— github.com 不可能（也不应该）为了展示一个仓库地址去登记。
  // 所以这里复制链接，用户粘到浏览器即可（这也是同类小程序的通行做法）。
  copyRepo() {
    wx.setClipboardData({
      data: this.data.repoUrl,
      success: () => {
        wx.showToast({
          title: '仓库地址已复制，粘贴到浏览器打开',
          icon: 'none',
          duration: 2500,
        });
      },
    });
  },

  // 版本日志（公开页，已登记在 app.json）
  goChangelogs() {
    wx.navigateTo({ url: '/pages/changelogs/changelogs' });
  },
});
