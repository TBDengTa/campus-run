// 自定义 tabBar：白色悬浮胶囊，全部为普通导航项（不做中间凸起圆钮）
// 学生（普通）：首页 / 跑步 / 记录 / 排行 / 我的
// 学生（班委）：首页 / 跑步 / 记录 / 班超 / 我的（本班检查结果与班级数据，只读）
// 学生（学生会成员）：首页 / 跑步 / 记录 / 学生会 / 我的（检查录入工作台）
// 学生（有管理权限，如 superadmin）：首页 / 跑步 / 记录 / 管理 / 排行 / 我的
// 教师：首页 / 管理(或班超/公告) / 我的（教师不参与排名与运动记录）
//
// **管理入口只看权限、不看角色**：超级管理员（permissions 含 '*'）在后台可以是学生身份，
// 若按角色分流就会落进学生那套 5 项 tab、中间没有管理入口（历史 bug）。所以先判权限，再判角色。
// **动态项只放 1 个**：既是班委又是学生会成员时优先「班超」，学生会入口在首页「学生会块」与「我的」页。
const STUDENT_TABS = [
  { key: 'home', path: '/pages/home/home', text: '首页', icon: 'home', activeIcon: 'home-filled', tab: true },
  { key: 'run', path: '/pages/run/index', text: '跑步', icon: 'play-circle', activeIcon: 'play-circle-filled', tab: true },
  { key: 'records', path: '/pages/records/records', text: '记录', icon: 'file-paste', activeIcon: 'file-paste-filled', tab: true },
  { key: 'ranking', path: '/pages/ranking/ranking', text: '排行', icon: 'chart-bar', activeIcon: 'chart-bar-filled', tab: true },
  { key: 'profile', path: '/pages/profile/profile', text: '我的', icon: 'user-circle', activeIcon: 'user-circle-filled', tab: true },
];

// 学生 + 管理权限：在「记录」与「排行」之间插入「管理」项（= 管理中枢，主包 tabBar 页）
const STUDENT_TAB_HUB = { key: 'hub', path: '/pages/hub/hub', text: '管理', icon: 'dashboard', activeIcon: 'dashboard-filled', tab: true };

// 我的班级（班主任 / 班委管自己名下的班）：教师端中间项与学生端动态项共用，
// 指向 /packageAdmin/class/class（packageAdmin 分包，页内 4 tab：学生名单 / 校园跑 / **班超联赛** / 班级配置）。
// 页内「班超联赛」tab 已并入原 pages/banchao/banchao（班超详细页）的全部内容，那个页面已删除。
// 栏目文案用「班级」而不是「我的班级」：底栏位置有限（胶囊里 2 个字最稳）。
// 命名口径（2026-10-19 用户澄清）：「我的班级」= 页面名与入口名（教师 / 班委管自己班）；
//                                 「班超联赛」= 该页内承载班超评比的那个 tab（原「班级考勤」改名）；
//                                 「班级管理」= 管理员管全校台账（只在管理中枢）。三者别混。
const BANCHAO_TAB = {
  key: 'banchao',
  path: '/packageAdmin/class/class',
  text: '班级',
  icon: 'usergroup',
  activeIcon: 'usergroup-filled',
  tab: false,
};

// 学生会工作台：仅学生会成员（且不是班委、无管理权限时）占用动态项位
const UNION_TAB = { key: 'union', path: '/pages/union/union', text: '学生会', icon: 'app', activeIcon: 'app-filled', tab: false };

// 教师（有管理权限）：管理端入口 = 「管理中枢」，它是主包 tabBar 页（受底部导航控制，切换时导航栏常驻）
const TEACHER_TABS_ADMIN = [
  { key: 'home', path: '/pages/home/home', text: '首页', icon: 'home', activeIcon: 'home-filled', tab: true },
  { key: 'hub', path: '/pages/hub/hub', text: '管理', icon: 'dashboard', activeIcon: 'dashboard-filled', tab: true },
  { key: 'profile', path: '/pages/profile/profile', text: '我的', icon: 'user-circle', activeIcon: 'user-circle-filled', tab: true },
];

// 教师（无管理权限但被设为班主任）：导航中间项直接进「我的班级」（页内第三个 tab 是「班超联赛」）
const TEACHER_TABS_CLASS = [
  { key: 'home', path: '/pages/home/home', text: '首页', icon: 'home', activeIcon: 'home-filled', tab: true },
  { key: 'banchao', path: '/packageAdmin/class/class', text: '班级', icon: 'usergroup', activeIcon: 'usergroup-filled', tab: false },
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
    // 依据权限与角色生成导航项：**权限优先**（学生+管理员必须有管理入口）
    buildList() {
      const user = currentUser();
      if (!user) return STUDENT_TABS;
      const canManage = hasManagePermission(user);
      if (user.role !== 'teacher') {
        // 学生 + 管理权限：中间项 = 管理中枢（'*' 或任一管理权限 / 权限组非空都算）
        if (canManage) {
          const hubIdx = STUDENT_TABS.findIndex((t) => t.key === 'records');
          return [...STUDENT_TABS.slice(0, hubIdx + 1), STUDENT_TAB_HUB, ...STUDENT_TABS.slice(hubIdx + 1)];
        }
        // 学生（无管理权限）：班委 → 班超；学生会成员 → 学生会；两者都是时优先班超（动态项只放 1 个）
        const dynamic = user.isClassOfficer ? BANCHAO_TAB : user.isUnionMember ? UNION_TAB : null;
        if (!dynamic) return STUDENT_TABS;
        const idx = STUDENT_TABS.findIndex((t) => t.key === 'profile');
        return [...STUDENT_TABS.slice(0, idx), dynamic, ...STUDENT_TABS.slice(idx)];
      }
      if (canManage) return TEACHER_TABS_ADMIN;
      // 无管理权限但被设为班主任：中间项进班超（教师端无「管理」入口，避免误入无权限页面）
      if ((user.homeroomClasses || []).length) return TEACHER_TABS_CLASS;
      return TEACHER_TABS_BASIC;
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
