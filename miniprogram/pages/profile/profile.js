const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// ===== 可选插画素材：把 PNG 放到下列路径即可自动启用（未放置时回退到矢量图标）=====
//   实现与首页「插画素材位」完全一致（见 docs/ui-design.md 第 8 节）：
//   4 个入口插画：miniprogram/assets/profile/entry-body.png / entry-plan.png / entry-water.png / entry-badge.png（建议 240×240）
//   这些是扁平小图，PNG 比 WebP 更小（实测 WebP 反而大 3%~40%），所以统一用 PNG，不做格式切换
const ENTRY_IMAGES = {
  body: 'assets/profile/entry-body.png',
  plan: 'assets/profile/entry-plan.png',
  water: 'assets/profile/entry-water.png',
  badge: 'assets/profile/entry-badge.png',
};

// 判断代码包内文件是否存在（不存在则用矢量图标兜底）
function assetExists(p) {
  try {
    wx.getFileSystemManager().accessSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

function resolveAssets() {
  const entries = {};
  for (const key of Object.keys(ENTRY_IMAGES)) {
    entries[key] = assetExists(ENTRY_IMAGES[key]) ? `/${ENTRY_IMAGES[key]}` : '';
  }
  return { entries };
}

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
    // 插画素材（自动探测）：有图用图片，没图回退 t-icon
    entryImages: { body: '', plan: '', water: '', badge: '' },
    stats: null,
    monitor: null,
    isTeacher: false,
    // 角色是否已确认（/api/auth/me 回来过）：首帧 isTeacher 恒为 false，
    // 直接用它判断显隐会让教师账号**先闪一下学生的菜单项**（隐私设置 / 我的申诉）。
    // 与下面的 showAd 同一个思路：角色确认后才按角色渲染。
    roleReady: false,
    // 广告位闸门：只有「角色已确认为学生」才渲染原生模板广告。
    // 首帧 isTeacher 还是默认 false（/api/auth/me 未回来），若直接用 !isTeacher，
    // 教师账号会先渲染出广告节点并可能产生一次曝光 —— 所以单独用 showAd 兜住这个窗口。
    showAd: false,
    roleText: '学生',
    banned: false,
    // 跑分（学生端展示，来自 /api/points/me；教师或未开启时为 null）
    points: null,
    // 学生会（仅成员渲染）与班超（仅班主任 / 班委渲染）：见 refresh() 里的赋值
    union: null,
    banchao: null,
    devMode: !!auth.env.DEV_LOGIN, // 本地测试登录：登录的是 dev_* 账号，不是真实学籍
    // 我的二维码（用户 2026-10-22）：所有用户都有码，含教师。
    // 学生/教师出示，学生会干部扫码后把本人加进自己部门。凭证一次性、10 分钟有效。
    qrVisible: false,
    qrLoading: false,
    qrError: '',
    qr: { token: '', qrImage: '', expiresText: '' },
  },

  onLoad() {
    // 插画素材位：与首页同样在页面加载时探测一次（有图用图，没图回退 t-icon）
    this.setData({ entryImages: resolveAssets().entries });
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
              // 日/周超出档位都按「个人目标的百分比」算（perStep 已完全弃用，不再展示步数口径）
              extraPercent: p.config.extraPercent,
              weeklyExtraPercent: p.config.weeklyExtraPercent,
              perStepScore: p.config.perStepScore,
              dailyExtraCap: p.config.dailyExtraCap,
              // 周上限 0 = 不封顶（文案在 JS 里拼好，避免 WXML 里写长表达式）
              weeklyCapText: p.config.weeklyExtraCap > 0 ? `（单周上限 ${p.config.weeklyExtraCap} 分）` : '（不封顶）',
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
        roleReady: true, // 角色已确认：教师专属的「隐藏项」（隐私设置 / 我的申诉）从这里开始生效
        showAd: !isTeacher, // 角色已确认是学生：广告位才渲染（教师 / 加载失败都不渲染）
        points,
        roleText: isTeacher ? '教师' : '学生',
        banned,
        // 学生会（仅成员渲染整块）：身份字段由 /api/auth/me 下发（services/union.js::decorateUser）
        union: user.isUnionMember
          ? { roleText: user.unionText || '', roleCount: user.unionRoleCount || (user.unionRoles || []).length }
          : null,
        // 班超（仅班主任 / 班委渲染整块）：普通学生不显示，与首页「班超块」同一口径
        banchao:
          (user.homeroomClasses || []).length || user.isClassOfficer
            ? { classText: (user.homeroomClasses || [])[0] || user.className || '' }
            : null,
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
      } else if (e.code === 401) {
        // 登录失效：**绝不能留在页面上继续显示上一个账号**（用户 2026-10-22
        // 「登录刘恩琦后依旧是陈宇航」的观感来源之一 —— 刷新失败只弹个 toast，
        // data.user 还是旧账号，看上去就像"换号没生效"）。直接回登录页重新确定身份。
        auth.logout();
        getApp().goLogin();
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

  // ===== 我的二维码（用户 2026-10-22）=====
  // 所有用户都有码（含教师账号）：教师不是学生会成员，但可以出示码做身份识别；
  // 干部扫码后若试图把教师加进学生会，服务端会明确拒绝（routes/union.js::accept 里的教师拦截）。
  //
  // 不传 userId —— 这个接口默认就是「当前登录者」，正是这里需要的。
  async openMyQr() {
    this.setData({ qrVisible: true, qrLoading: true, qrError: '' });
    await this.loadMyQr();
  },

  async loadMyQr() {
    this.setData({ qrLoading: true, qrError: '' });
    try {
      const res = await auth.get('/api/union/invite/mine');
      const exp = res && res.expiresAt ? new Date(res.expiresAt) : null;
      const pad = (n) => String(n).padStart(2, '0');
      const expiresText = exp
        ? `${pad(exp.getMonth() + 1)}-${pad(exp.getDate())} ${pad(exp.getHours())}:${pad(exp.getMinutes())}`
        : '';
      this.setData({
        qrLoading: false,
        qr: {
          token: (res && res.token) || '',
          // 后端生成的二维码 PNG dataURL；空 = 生成失败，页面回退显示凭证串
          qrImage: (res && res.qrImage) || '',
          expiresText,
        },
      });
    } catch (e) {
      this.setData({ qrLoading: false, qrError: e.message || '生成失败' });
    }
  },

  async refreshMyQr() {
    if (this.data.qrLoading) return;
    await this.loadMyQr();
  },

  closeMyQr() {
    this.setData({ qrVisible: false });
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

  // ===== 原生模板广告（ad-custom）事件：仅日志，无任何副作用 =====
  // 广告加载失败（无填充、开发者工具无广告等）时页面其余功能完全正常，连点彩蛋也不受影响。
  adLoad() {
    console.log('[profile] 原生模板广告加载成功');
  },

  adError(e) {
    console.error('[profile] 原生模板广告加载失败', e && e.detail);
  },

  adClose() {
    console.log('[profile] 原生模板广告已关闭');
  },

  // 累计数据卡片：连点 5 次进入「北斗运动」（原「看视频赚步数」，入口已隐藏）
  // 教师拦截（第一道）：北斗运动写 run_records，教师不参与运动记录 → 连点 5 次也不跳转，
  // 只给一句明确提示。页面侧还有 onLoad/onShow 两道兜底（见 pages/reward/reward.js）。
  onStatsTap() {
    const user = this.data.user || {};
    if (user.role === 'teacher') {
      wx.showToast({ title: '教师账号不参与运动记录', icon: 'none' });
      return;
    }
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

  // ===== 学生会（仅成员可见的整块）=====
  // 命名与「学生会配置 / 学生会成员」两个管理入口同一口径；本页只放成员自用的入口，
  // 不放任何管理端页面（普通学生看不到管理入口）。
  goUnion() {
    wx.navigateTo({ url: '/pages/union/union' });
  },

  goUnionEntry() {
    wx.navigateTo({ url: '/packageUnion/entry/entry' });
  },

  goUnionRecords() {
    wx.navigateTo({ url: '/packageUnion/records/records?mine=1' });
  },

  goUnionRoster() {
    wx.navigateTo({ url: '/packageUnion/roster/roster' });
  },

  // ===== 班超（仅班主任 / 班委可见的整块）=====
  // 命名口径（2026-10-19 用户澄清）：「班超」= 班级检查评比域的产品名，「班超排名」保持这个叫法；
  // 教师 / 班委管自己名下班级的那页**页面名与入口名都叫「我的班级」**
  //（/packageAdmin/class/class；其页内第三个 tab 叫「班超联赛」，已并入原班超详细页的内容），
  // 「班级管理」留给管理员管全校台账（/packageAdmin/class-manage）—— 本页不给普通学生放管理入口。
  goBanChao() {
    wx.navigateTo({ url: '/packageAdmin/class/class' });
  },

  // 本班检查记录的申诉入口：先看记录列表（班委 / 班主任对本班记录可申诉）
  goBanChaoRecords() {
    const className = (this.data.banchao && this.data.banchao.classText) || (this.data.user && this.data.user.className) || '';
    wx.navigateTo({ url: `/packageUnion/records/records?className=${encodeURIComponent(className)}` });
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
