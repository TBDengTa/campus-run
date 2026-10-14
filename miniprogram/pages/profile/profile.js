const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// 年级展示：优先用名单里的 grade；没有则按学号前 4 位（19xx/20xx）推导；都没有返回 —
function gradeTextOf(user) {
  const raw = String((user && user.grade) || '').replace(/级$/, '').trim();
  if (raw) return `${raw}级`;
  const sid = String((user && user.studentId) || '').trim();
  const m = sid.match(/^(19|20)(\d{2})/);
  if (m) return `${m[1]}${m[2]}级`;
  return '—';
}

// 学籍信息（来自学校名单，学生不可自行修改）
function enrollOf(user) {
  const u = user || {};
  return {
    realName: u.realName || u.account || '',
    studentId: u.studentId || '',
    schoolName: u.schoolName || '',
    departmentName: u.departmentName || '',
    specialty: u.specialty || '',
    className: u.className || '',
    gradeText: gradeTextOf(u),
  };
}

// 顶部用户卡的一行关键信息（学籍卡已列全部字段，这里只做摘要，避免重复）
function heroMetaOf(user, enroll, isTeacher) {
  const e = enroll || enrollOf(user);
  if (isTeacher) return '教师账号不参与运动记录与排名';
  const parts = [e.departmentName, e.className].filter(Boolean);
  if (parts.length) return parts.join(' · ');
  if (e.studentId) return `学号 ${e.studentId}`;
  return '点击昵称可修改';
}

Page({
  data: {
    user: null,
    enroll: enrollOf(null),
    heroMeta: '',
    stats: null,
    monitor: null,
    isAdmin: false,
    isTeacher: false,
    canManagePerms: false,
    roleText: '学生',
    banned: false,
    // 跑分（学生端展示，来自 /api/points/me；教师或未开启时为 null）
    points: null,
    devMode: !!auth.env.DEV_LOGIN, // 本地测试登录：登录的是 dev_* 账号，不是真实学籍
  },

  onShow() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    this.syncTabBar();
    this.refresh();
  },

  // 自定义 tabBar 选中态（教师端导航项与学生不同）
  syncTabBar() {
    if (typeof this.getTabBar !== 'function') return;
    const bar = this.getTabBar();
    if (bar && typeof bar.setActive === 'function') bar.setActive('/pages/profile/profile');
  },

  async refresh() {
    try {
      await getApp().ensureLogin();
      const user = await getApp().refreshUser();
      let banned = false;
      // 永久限制（bannedUntil 为空）也算封禁态
      if (user.status === 'banned' && (!user.bannedUntil || new Date(user.bannedUntil) > new Date())) {
        banned = true;
      }
      const perms = user.effectivePermissions || [];
      const isTeacher = user.role === 'teacher';
      const enroll = enrollOf(user);
      // 跑分（学生端展示；接口不可用或未开启时为 null）
      let points = null;
      if (!isTeacher) {
        try {
          const p = await auth.get('/api/points/me');
          if (p && p.config && p.config.enabled) {
            points = {
              today: fmt.formatNumber(p.today || 0),
              week: fmt.formatNumber(p.week || 0),
              total: fmt.formatNumber(p.total || 0),
              dailyGoal: p.config.dailyGoal,
              weeklyGoal: p.config.weeklyGoal,
              perStep: p.config.perStep,
              perStepScore: p.config.perStepScore,
            };
          }
        } catch (e) {
          points = null;
        }
      }
      this.setData({
        user,
        enroll,
        heroMeta: heroMetaOf(user, enroll, isTeacher),
        isTeacher,
        points,
        isAdmin: !!user.isManager,
        canManagePerms: perms.includes('*') || perms.includes('permission.manage'),
        roleText: isTeacher ? '教师' : '学生',
        banned,
        stats: {
          totalSteps: fmt.formatNumber(user.totalSteps || 0),
          totalDistance: fmt.formatDistance(user.totalDistance || 0),
          totalDays: user.totalDays || 0,
        },
      });
      this.syncTabBar();
    } catch (e) {
      if (e.code === 403001) {
        // 封禁用户仍可看基本页
        this.setData({ banned: true, user: getApp().globalData.userInfo });
      } else {
        wx.showToast({ title: e.message || '加载失败', icon: 'none' });
      }
    }
  },

  async chooseAvatar(e) {
    const { avatarUrl: tempPath } = e.detail;
    if (!tempPath) return;
    // 先上传到服务器拿到正式 URL（微信临时路径其他设备不可见），再保存到资料
    wx.showLoading({ title: '上传中…' });
    try {
      const { url } = await auth.uploadFile(tempPath, { url: '/api/upload/avatar' });
      await this.applyProfile({ avatarUrl: url });
    } catch (err) {
      wx.showToast({ title: err.message || '头像上传失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  async nicknameInput(e) {
    const nickname = (e.detail.value || '').trim();
    if (nickname && nickname !== this.data.user?.nickname) {
      this.applyProfile({ nickname });
    }
  },

  async applyProfile(patch) {
    try {
      const user = await auth.put('/api/auth/profile', patch);
      const enroll = enrollOf(user);
      this.setData({ user, enroll, heroMeta: heroMetaOf(user, enroll, user.role === 'teacher') });
      getApp().globalData.userInfo = user;
      auth.setUser(user);
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  // 学籍信息由学校名单同步，不可自行修改
  onEnrollTip() {
    wx.showModal({
      title: '学籍信息',
      content: '姓名 / 学号 / 院系 / 专业 / 班级 / 年级来自学校名单同步，不能自行修改。有问题请找班主任。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  // 累计数据卡片：连点 5 次进入「北斗运动」（原「看视频赚步数」，入口已隐藏）
  onStatsTap() {
    const now = Date.now();
    const taps = now - (this._tapLast || 0) < 2000 ? (this._taps || 0) + 1 : 1;
    this._taps = taps;
    this._tapLast = now;
    if (taps >= 5) {
      this._taps = 0;
      if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
      wx.navigateTo({ url: '/pages/reward/reward' });
      return;
    }
    if (taps >= 3) wx.showToast({ title: `再点 ${5 - taps} 次进入北斗运动`, icon: 'none', duration: 800 });
  },

  go(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url });
  },

  // 权限管理：进用户列表选人（持有 permission.manage 时显示）
  goPerms() {
    wx.navigateTo({ url: '/packageAdmin/users/users?selectForPerms=1' });
  },

  goBanned() {
    wx.navigateTo({ url: '/pages/banned/banned' });
  },

  goChangePwd() {
    wx.navigateTo({ url: '/pages/password/change' });
  },

  // 授权管理：打开微信授权设置
  openAuthSetting() {
    wx.openSetting({});
  },

  goAbout() {
    wx.navigateTo({ url: '/pages/about/about' });
  },

  goPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy' });
  },

  // 退出登录：清除本机会话 → 回登录页（已绑定微信的账号重新进入会自动登录）
  logout() {
    wx.showModal({
      title: '退出登录',
      content: '将清除本机登录信息并返回登录页',
      confirmText: '退出',
      // 微信 API 只接受 hex 字符串，取值同 --td-error-color-6
      confirmColor: '#e5484d',
      success: (r) => {
        if (!r.confirm) return;
        auth.logout();
        wx.reLaunch({ url: '/pages/auth-login/auth-login' });
      },
    });
  },
});
