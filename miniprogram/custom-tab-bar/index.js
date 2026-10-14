// 自定义 tabBar：白色悬浮胶囊，全部为普通导航项（不做中间凸起圆钮）
// 学生：首页 / 跑步 / 记录 / 排行 / 我的
// 教师：首页 / 管理(或公告) / 我的（教师不参与排名与运动记录）
const STUDENT_TABS = [
  { key: 'home', path: '/pages/home/home', text: '首页', icon: 'home', activeIcon: 'home-filled', tab: true },
  { key: 'run', path: '/pages/run/index', text: '跑步', icon: 'play-circle', activeIcon: 'play-circle-filled', tab: true },
  { key: 'records', path: '/pages/records/records', text: '记录', icon: 'file-paste', activeIcon: 'file-paste-filled', tab: true },
  { key: 'ranking', path: '/pages/ranking/ranking', text: '排行', icon: 'chart-bar', activeIcon: 'chart-bar-filled', tab: true },
  { key: 'profile', path: '/pages/profile/profile', text: '我的', icon: 'user-circle', activeIcon: 'user-circle-filled', tab: true },
];

// 教师（有管理权限）：管理端入口作为普通导航项
const TEACHER_TABS_ADMIN = [
  { key: 'home', path: '/pages/home/home', text: '首页', icon: 'home', activeIcon: 'home-filled', tab: true },
  { key: 'admin', path: '/packageAdmin/users/users', text: '管理', icon: 'dashboard', activeIcon: 'dashboard-filled', tab: false },
  { key: 'profile', path: '/pages/profile/profile', text: '我的', icon: 'user-circle', activeIcon: 'user-circle-filled', tab: true },
];

// 教师（无管理权限）：公告作为普通导航项
const TEACHER_TABS_BASIC = [
  { key: 'home', path: '/pages/home/home', text: '首页', icon: 'home', activeIcon: 'home-filled', tab: true },
  { key: 'announcements', path: '/pages/announcements/announcements', text: '公告', icon: 'notification', activeIcon: 'notification-filled', tab: false },
  { key: 'profile', path: '/pages/profile/profile', text: '我的', icon: 'user-circle', activeIcon: 'user-circle-filled', tab: true },
];

function currentUser() {
  const app = getApp();
  return (app && app.globalData && app.globalData.userInfo) || null;
}

Component({
  data: {
    list: STUDENT_TABS,
    selected: 0,
    currentPath: '',
  },

  attached() {
    this.refresh();
  },

  pageLifetimes: {
    show() {
      this.refresh();
    },
  },

  methods: {
    // 依据角色与权限生成导航项
    buildList() {
      const user = currentUser();
      if (!user || user.role !== 'teacher') return STUDENT_TABS;
      const perms = user.effectivePermissions || [];
      const canManage = !!user.isManager || perms.length > 0;
      return canManage ? TEACHER_TABS_ADMIN : TEACHER_TABS_BASIC;
    },

    refresh(path) {
      const list = this.buildList();
      const target = path || this.data.currentPath;
      let selected = 0;
      if (target) {
        const idx = list.findIndex((t) => t.path === target);
        if (idx >= 0) selected = idx;
      }
      this.setData({ list, selected });
    },

    // 由各 tab 页在 onShow 中调用，传入自身路径
    setActive(path) {
      this.setData({ currentPath: path });
      this.refresh(path);
    },

    onTap(e) {
      const idx = Number(e.currentTarget.dataset.index);
      const item = this.data.list[idx];
      if (!item) return;
      if (item.tab) {
        if (this.data.selected === idx) return;
        wx.switchTab({ url: item.path });
      } else {
        wx.navigateTo({ url: item.path });
      }
    },
  },
});
