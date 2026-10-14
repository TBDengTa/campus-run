const auth = require('../../utils/request');

// 管理中枢：把管理端全部入口按「分类」列出来（教师端导航「管理」指向本页，不再直接跳用户管理）
// 每项按权限过滤：perms 为 '*'（超级管理员）或含该项 perm 才显示
const GROUPS = [
  {
    key: 'class',
    title: '我的班级',
    desc: '班主任可管理本班，班委仅查看',
    items: [{ key: 'class', perm: '', icon: 'usergroup', label: '班级管理', url: '/packageAdmin/class/class', bg: 'var(--tt-brand-soft)', color: 'var(--tt-brand)' }],
  },
  {
    key: 'user',
    title: '用户与权限',
    items: [
      { key: 'users', perm: 'user.view', icon: 'usergroup', label: '用户管理', url: '/packageAdmin/users/users' },
      { key: 'import', perm: 'user.manage', icon: 'file-add', label: '导入名单', url: '/packageAdmin/users/import' },
      { key: 'groups', perm: 'permission.manage', icon: 'secured', label: '权限组', url: '/packageAdmin/permissions/groups' },
      { key: 'appeals', perm: 'appeal.view', icon: 'assignment-checked', label: '申诉审核', url: '/packageAdmin/appeals/appeals' },
    ],
  },
  {
    key: 'assessment',
    title: '考核与目标',
    items: [
      { key: 'assessment', perm: 'assessment.view', icon: 'task-checked', label: '运动考核', url: '/packageAdmin/assessment/index' },
      { key: 'goals', perm: 'assessment.view', icon: 'flag', label: '目标计划', url: '/packageAdmin/assessment/goals' },
      { key: 'plans', perm: 'assessment.view', icon: 'calendar', label: '考核方案', url: '/packageAdmin/assessment/plans' },
      { key: 'files', perm: 'file.view', icon: 'folder-open', label: '文件管理', url: '/packageAdmin/files/files' },
    ],
  },
  {
    key: 'content',
    title: '内容与通知',
    items: [
      { key: 'content', perm: 'content.view', icon: 'layers', label: '内容中枢', url: '/packageAdmin/content/index' },
      { key: 'announcements', perm: 'content.view', icon: 'notification', label: '公告', url: '/packageAdmin/content/announcements' },
      { key: 'changelogs', perm: 'content.view', icon: 'history', label: '版本日志', url: '/packageAdmin/content/changelogs' },
      { key: 'organizations', perm: 'content.view', icon: 'city', label: '组织架构', url: '/packageAdmin/content/organizations' },
      { key: 'badges', perm: 'content.view', icon: 'star', label: '徽章', url: '/packageAdmin/content/badges' },
      { key: 'holidays', perm: 'content.view', icon: 'calendar-1', label: '节假日', url: '/packageAdmin/content/holidays' },
    ],
  },
  {
    key: 'ads',
    title: '广告运营',
    items: [
      { key: 'adContents', perm: 'ad.view', icon: 'play-circle', label: '广告管理', url: '/packageAdmin/ads/contents' },
      { key: 'adSponsors', perm: 'ad.view', icon: 'user-add', label: '赞助商', url: '/packageAdmin/ads/sponsors' },
      { key: 'adSlots', perm: 'ad.view', icon: 'app', label: '广告位', url: '/packageAdmin/ads/slots' },
      { key: 'adStats', perm: 'ad.view', icon: 'chart-bar', label: '广告统计', url: '/packageAdmin/ads/stats' },
    ],
  },
  {
    key: 'config',
    title: '系统设置',
    items: [
      { key: 'config', perm: 'config.view', icon: 'setting', label: '系统配置', url: '/packageAdmin/config/config' },
      { key: 'points', perm: 'config.view', icon: 'chart-bubble', label: '跑分设置', url: '/packageAdmin/config/points' },
      { key: 'anticheat', perm: 'config.view', icon: 'shield-error', label: '反作弊', url: '/packageAdmin/config/anticheat' },
      { key: 'reward', perm: 'config.view', icon: 'play-circle', label: '看视频奖励', url: '/packageAdmin/config/reward-video' },
    ],
  },
];

Page({
  data: {
    loading: true,
    groups: [],
    name: '',
    roleText: '',
    classText: '',
    hasAny: false,
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    // 本页是 tabBar 页（教师端「管理」），要主动点亮底部导航
    this.syncTabBar();
    this.load();
  },

  syncTabBar() {
    if (typeof this.getTabBar !== 'function') return;
    const bar = this.getTabBar();
    if (bar && typeof bar.setActive === 'function') bar.setActive('/pages/hub/hub');
  },

  async load() {
    try {
      await getApp().ensureLogin();
      const me = await getApp().refreshUser();
      const perms = (me && me.effectivePermissions) || [];
      const isSuper = perms.includes('*');
      // 班主任 / 班委：无管理权限也能进班级管理
      let classRole = null;
      let homeroomClasses = [];
      try {
        const mine = await auth.get('/api/class/mine');
        classRole = mine && mine.role ? mine.role : null;
        homeroomClasses = (mine && mine.homeroomClasses) || [];
      } catch (e) {
        classRole = null; // 接口未就绪/无班级身份：不显示班级分组
      }

      const groups = GROUPS.map((g) => {
        if (g.key === 'class') {
          if (!classRole) return null;
          const g2 = {
            ...g,
            desc: classRole === 'homeroom' ? `班主任：${homeroomClasses.join('、') || '未分配班级'}` : '班委：仅查看本班数据',
          };
          return g2;
        }
        const items = g.items.filter((it) => isSuper || perms.includes(it.perm));
        return items.length ? { ...g, items } : null;
      }).filter(Boolean);

      this.setData({
        loading: false,
        groups,
        hasAny: groups.length > 0,
        name: (me && (me.realName || me.nickname)) || '',
        roleText: me && me.role === 'teacher' ? '教师' : '学生',
        classText: (me && me.className) || '',
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  go(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.navigateTo({ url });
  },
});
