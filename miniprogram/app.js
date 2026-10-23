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
      // ⚠️ 每个启动周期向服务端确认一次「我是谁」。
      //
      // 它要同时满足两条互相拉扯的需求：
      //   ① 2026-10-22「登录刘恩琦后依旧是陈宇航」→ 本地残留的**旧令牌**不能继续生效；
      //   ② 2026-10-23「历史登录一键登录……会出现历史记录失效」→ **一键登录进来的身份不能被顶掉**。
      //
      // 关键：确认用 `/api/auth/me`（按 token 校验），**不要**用 `/api/auth/login`（按微信 openid 定身份）。
      //   · 需求① 现在由**服务端**保证：middlewares/auth.js 会比对令牌里的 openid 与 user.openid，
      //     解绑 / 换绑过的旧令牌一律 401 → 这里 catch 到后由 request() 自动重登按 openid 重新认定，
      //     自愈链路依然成立，不需要启动时再按 openid 覆盖身份；
      //   · 需求② 恰恰要求**不能**按 openid 覆盖：教师在 A 账号一键登录后，这个小程序 token 属于 A，
      //     而「当前微信」可能绑在 B 上（教师允许换绑）。启动时若按 openid 重新登录，
      //     就会静默把身份切回 B —— 表现就是「一键登录成功，重启后又是另一个账号」。
      //     用 /api/auth/me 校验令牌，谁登录的就还是谁，一键登录才真正站得住。
      if (!this._identityChecked) {
        if (!this._identityPromise) {
          this._identityPromise = (async () => {
            try {
              // refreshUser() 走 /api/auth/me；401 时 request() 内部会自动重登（尊重「已退出」标记）
              const user = await this.refreshUser();
              this.globalData.userInfo = user || null;
              this._identityChecked = true; // 只有成功才记为已确认；失败下次 onShow 再试
            } catch (e) {
              // 网络异常 / 服务不可用：退回本地缓存，不阻塞页面
              if (!this.globalData.userInfo) this.globalData.userInfo = auth.getUser();
            } finally {
              this._identityPromise = null;
            }
          })();
        }
        await this._identityPromise;
      }
      if (!this.globalData.userInfo) this.globalData.userInfo = auth.getUser();
      return this.globalData.userInfo;
    }
    const data = await auth.login();
    this.globalData.userInfo = data.userInfo || null;
    this._identityChecked = true;
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
