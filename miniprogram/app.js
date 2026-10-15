const auth = require('./utils/request');

App({
  globalData: {
    userInfo: null,
    // 今日数据缓存（首页/日历页共享）
    today: null,
  },

  onLaunch() {
    // 用户主动退出登录后不再静默登录（必须由登录页手动登录）
    if (auth.isLoggedOut()) return;
    this.ensureLogin().catch((e) => {
      // 未绑定/待改密的跳转已在 ensureLogin 内处理
      if (e.code !== 403003 && e.code !== 403004) {
        console.warn('[app] 静默登录失败（未配置后端或网络异常）:', e.message);
      }
    });
  },

  // 是否处于「已登录且已绑定名单账号」状态（游客 token 不算登录）
  isBound() {
    return auth.isBound();
  },

  // 统一登录闸门：未登录 / 已退出 / 游客（未绑定）→ 跳登录页并返回 false
  // 各业务页首行调用：if (!getApp().requireLogin()) return;  —— 不执行任何业务逻辑
  requireLogin() {
    if (auth.isBound()) return true;
    this.goLogin();
    return false;
  },

  // 跳登录页（带去重，避免多个页面同时 reLaunch）
  goLogin() {
    if (this._redirectingToLogin) return;
    this._redirectingToLogin = true;
    this.globalData.userInfo = null;
    wx.reLaunch({
      url: '/pages/auth-login/auth-login',
      complete: () => {
        setTimeout(() => {
          this._redirectingToLogin = false;
        }, 1500);
      },
    });
  },

  // 确保已登录：有 token 直接用；无 token 静默登录；未绑定账号 → 登录页
  // 已主动退出登录 → 不做任何登录动作
  async ensureLogin() {
    if (auth.isLoggedOut()) return null;
    if (auth.getToken()) {
      if (!this.globalData.userInfo) {
        this.globalData.userInfo = auth.getUser();
      }
      return this.globalData.userInfo;
    }
    const data = await auth.login();
    this.globalData.userInfo = data.userInfo || null;
    if (data.bound === false) {
      const err = new Error('请先登录账号');
      err.code = 403003;
      this.goLogin();
      throw err;
    }
    if (data.mustChangePassword) {
      const err = new Error('请先修改密码');
      err.code = 403004;
      wx.reLaunch({ url: '/pages/password/change?first=1' });
      throw err;
    }
    return data.userInfo;
  },

  // 流量主广告（ad-custom）的**第二道闸门**：必须在 `await ensureLogin()` 之后调用。
  // 用法（页面 data 里先声明 `isTeacher: false, showAd: false`）：
  //   await getApp().ensureLogin();
  //   getApp().applyAdGate(this);
  // 为什么两道：首帧 `isTeacher` 还是默认 false，只用 `!isTeacher` 会让教师账号先渲染出
  // 广告节点、产生一次曝光；`showAd` 只有**确认角色是学生**之后才为真。
  // 角色来源：优先用内存里已确认的 userInfo（/api/auth/me 或 login 写过）；
  // 拿不到就按需查一次 /api/auth/me（每次启动最多一次，成功即缓存）——
  // 这样「本地缓存的旧角色」不会让教师闪一条广告；接口不可用则保持 false（宁可不展示）。
  applyAdGate(page) {
    if (!page || typeof page.setData !== 'function') return false;
    const cached = this.globalData.userInfo || auth.getUser() || null;
    if (cached && cached.role) return this._setAdGate(page, cached.role);
    if (auth.isLoggedOut() || !auth.isBound()) return false;
    if (!this._roleProbe) {
      this._roleProbe = auth
        .get('/api/auth/me')
        .then((user) => {
          if (user && user.role) {
            this.globalData.userInfo = user;
            auth.setUser(user);
          }
          return (user && user.role) || '';
        })
        .catch(() => '');
    }
    const probe = this._roleProbe;
    probe.then((role) => {
      if (role) this._setAdGate(page, role);
    });
    return false;
  },

  // 把闸门结果写回页面 data（值与当前一致时不 setData，避免无意义渲染）
  _setAdGate(page, role) {
    const isTeacher = role === 'teacher';
    const showAd = !!role && !isTeacher;
    if (page.data.isTeacher !== isTeacher || page.data.showAd !== showAd) {
      page.setData({ isTeacher, showAd });
    }
    return showAd;
  },

  // 刷新用户信息
  async refreshUser() {
    const user = await auth.get('/api/auth/me');
    this.globalData.userInfo = user;
    auth.setUser(user);
    return user;
  },
});
