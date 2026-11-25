// 自定义 tabBar：玻璃悬浮胶囊（Glassmorphism），全部为普通导航项（不做中间凸起圆钮）
// 学生（普通）：首页 / 跑步 / 记录 / 排行 / 我的
// 学生（班委 / 学生会成员 / 有管理权限，任一或叠加）：首页 / 跑步 / 记录 / **工作台** / 排行 / 我的
// 教师（有管理权限或班主任）：首页 / 工作台 / 我的（教师不参与排名与运动记录）
// 教师（无权限无班主任）：首页 / 公告 / 我的
//
// **管理入口只看权限、不看角色**：超级管理员（permissions 含 '*'）在后台可以是学生身份，
// 若按角色分流就会落进学生那套 5 项 tab、中间没有管理入口（历史 bug）。所以先判权限，再判角色。
// **统一「工作台」入口（用户 2026-11-23 多身份导航整合）**：动态项永远只有 1 个「工作台」，
// 管理 / 班级 / 学生会全部入口收进工作台页（pages/hub/hub，按身份分组展示）。
// 旧方案「班委优先班超、学生会入口挪去首页」会让多身份用户丢入口（班委+学生会时学生会 tab 被挤掉、
// 管理员+班委时班级 tab 被挤掉）——现在任何身份组合底栏都 ≤6 项，入口一个不丢。
const STUDENT_TABS = [
  { key: 'home', path: '/pages/home/home', text: '首页', icon: 'home', activeIcon: 'home-filled', tab: true },
  { key: 'run', path: '/pages/run/index', text: '跑步', icon: 'play-circle', activeIcon: 'play-circle-filled', tab: true },
  { key: 'records', path: '/pages/records/records', text: '记录', icon: 'file-paste', activeIcon: 'file-paste-filled', tab: true },
  { key: 'ranking', path: '/pages/ranking/ranking', text: '排行', icon: 'chart-bar', activeIcon: 'chart-bar-filled', tab: true },
  { key: 'profile', path: '/pages/profile/profile', text: '我的', icon: 'user-circle', activeIcon: 'user-circle-filled', tab: true },
];

// 工作台：唯一动态项（= 原管理中枢，主包 tabBar 页，switchTab 进入导航常驻）。
// 学生插在「记录」与「排行」之间；教师作为中间项。
// 班委 / 班主任的「我的班级」、学生会成员的「检查录入」都在工作台内按身份分组
//（utils/nav-groups.js 单一数据源；「检查录入」条目 key = unionEntry，仅成员可见）。
const WORKBENCH_TAB = { key: 'hub', path: '/pages/hub/hub', text: '工作台', icon: 'dashboard', activeIcon: 'dashboard-filled', tab: true };

// 教师（有管理权限或班主任）：中间项 = 工作台（主包 tabBar 页，切换时导航栏常驻）
const TEACHER_TABS_WORKBENCH = [
  { key: 'home', path: '/pages/home/home', text: '首页', icon: 'home', activeIcon: 'home-filled', tab: true },
  WORKBENCH_TAB,
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

// 「有管理权限」的判定（与 /api/auth/me、管理中枢 hub.js 同一口径）：
//   user.effectivePermissions 是 /api/auth/me 下发的**有效权限**数组（user.permissions ∪ 所在权限组展开，'*' 通配）；
//   isManager 是服务端在同一出口给出的等价布尔（effective.length > 0）。
// 只要有任意一项有效权限（或 '*'）就认为该账号能进管理端 —— 与角色无关（学生身份同样成立）。
function hasManagePermission(user) {
  if (!user) return false;
  const perms = user.effectivePermissions || [];
  return !!user.isManager || perms.includes('*') || perms.length > 0;
}

const screen = require('../utils/screen');

Component({
  data: {
    list: STUDENT_TABS,
    selected: 0,
    currentPath: '',
    // 三端响应式：宽屏挂 .tabbar-wide（居中胶囊 + px），图标尺寸随档位切换（宽屏禁 rpx）
    screenMode: 'compact',
    iconSize: '46rpx',
  },

  attached() {
    this.refresh();
    this.applyScreen(screen.currentMode());
    this._screenOff = screen.onResize((mode) => this.applyScreen(mode));
  },

  detached() {
    if (this._screenOff) {
      this._screenOff();
      this._screenOff = null;
    }
  },

  pageLifetimes: {
    show() {
      this.refresh();
    },
  },

  methods: {
    applyScreen(mode) {
      if (mode === this.data.screenMode) return;
      this.setData({ screenMode: mode, iconSize: mode === 'compact' ? '46rpx' : '22px' });
    },

    // 依据权限与角色生成导航项：**权限优先**（学生+管理员必须有工作台入口）
    // 多身份统一：canManage / isClassOfficer / isUnionMember 任一成立 → 插唯一「工作台」项，
    // 身份叠加不再互相挤占（全部入口在工作台内按身份分组，utils/nav-groups.js）。
    buildList() {
      const user = currentUser();
      if (!user) return STUDENT_TABS;
      const canManage = hasManagePermission(user);
      if (user.role !== 'teacher') {
        const hasWorkbench = canManage || user.isClassOfficer || user.isUnionMember;
        if (!hasWorkbench) return STUDENT_TABS;
        const idx = STUDENT_TABS.findIndex((t) => t.key === 'records');
        return [...STUDENT_TABS.slice(0, idx + 1), WORKBENCH_TAB, ...STUDENT_TABS.slice(idx + 1)];
      }
      // 教师：有管理权限或班主任 → 工作台；普通教师 → 公告（不给无权限账号假入口）
      if (canManage || (user.homeroomClasses || []).length) return TEACHER_TABS_WORKBENCH;
      return TEACHER_TABS_BASIC;
    },

    refresh(path) {
      // 身份字段缺失时先按「未知」渲染，同时异步补一次 /api/auth/me 再重画。
      //
      // 用户 2026-10-25 报障「示例学生2 导航栏没有学生会入口」：`isUnionMember` 是
      // /api/auth/me 现算下发的，而 currentUser() 读的 globalData.userInfo 可能是
      // 旧版本登录留下的对象（没有该字段），于是 buildList 里 `user.isUnionMember`
      // 是 undefined → 动态项为 null → 底部导航直接少一项，且没有任何提示。
      // tabBar 的 refresh 是同步的（setActive 在页面 onShow 里同步调），
      // 所以这里不能 await：先渲染不带的版本，补到数据后再 refresh 一次。
      const self = this;
      const user = currentUser();
      if (user && typeof user.isUnionMember !== 'boolean' && user.role !== 'teacher' && !this._unionProbe) {
        this._unionProbe = (async () => {
          try {
            await getApp().refreshUser();
            self.refresh(path);
          } catch (e) {
            /* 失败保持当前渲染 */
          } finally {
            self._unionProbe = null;
          }
        })();
      }
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
