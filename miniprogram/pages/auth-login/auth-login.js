const auth = require('../../utils/request');
const history = require('../../utils/login-history');

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (sameDay) return `今天 ${hm}`;
  if (yest) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

Page({
  data: {
    account: '',
    password: '',
    studentId: '', // 同名账号消歧用：服务端返回 400902 后才展开输入框
    needStudentId: false,
    submitting: false,
    devRoles: null, // DEV 模式下的快速角色切换
    loggedOut: false, // 是否是「主动退出登录」后回到本页
    historyList: [], // 历史登录记录（本地）
    quickLoadingKey: '',
  },

  onLoad() {
    const { env } = auth;
    this.setData({ loggedOut: auth.isLoggedOut() });
    if (env.DEV_LOGIN) {
      this.setData({ devRoles: ['dev-student', 'dev-teacher', 'dev-admin', 'dev-sadmin'] });
    }
  },

  onShow() {
    // 登录页是页面栈里唯一的页面，微信会在胶囊旁显示「返回首页」按钮 —— 用官方 API 隐藏
    if (typeof wx.hideHomeButton === 'function') {
      wx.hideHomeButton({ fail: () => {} });
    }
    this.setData({ loggedOut: auth.isLoggedOut() });
    this.loadHistory();
  },

  loadHistory() {
    const list = history.list().map((e) => ({
      ...e,
      timeText: fmtTime(e.lastAt),
      roleText: e.role === 'teacher' ? '教师' : '学生',
      subText: [e.studentId, e.departmentName, e.className].filter(Boolean).join(' · ') || '—',
      initial: String(e.name || '?').slice(0, 1),
      key: `${e.account || ''}|${e.studentId || ''}`,
    }));
    this.setData({ historyList: list });
  },

  // 一键登录：用本地保存的设备令牌换正式 token
  //
  // ⚠️ 只有「服务端明确说这条令牌无效」才删除本地记录（用户 2026-10-23 报障：
  //    「历史登录支持一键登录……现在虽然不限制绑定微信，但是会出现历史记录失效」）。
  //    旧实现把**任何**失败都当成失效，于是网络抖动、服务端 500、换绑瞬间的 401
  //    都会把用户的登录记录**永久删掉**（删了就必须重新输密码，再也回不来）。
  //    现在分三类处理：
  //      · 401 401001（令牌失效/被撤销）→ 删记录（它确实没用了），填入姓名引导改密码登录
  //      · 网络异常 / 5xx → **保留记录**，只提示稍后重试（令牌多半仍然有效）
  //      · 其它 4xx → 同样保留记录，只提示原因
  async quickLogin(e) {
    const { key } = e.currentTarget.dataset;
    const entry = this.data.historyList.find((x) => x.key === key);
    if (!entry || this.data.quickLoadingKey) return;
    this.setData({ quickLoadingKey: key });
    try {
      auth.clearLoggedOut();
      const result = await auth.deviceLogin(entry.deviceToken);
      wx.showToast({ title: `欢迎回来，${entry.name}`, icon: 'success' });
      this.afterLogin(result);
    } catch (err) {
      const dead = err && (err.code === 401001 || err.deviceTokenInvalid === true);
      if (!dead) {
        // 令牌可能还有效：保留历史记录，用户点一次就能重试
        wx.showModal({
          title: '一键登录暂时失败',
          content: `${err.message || '网络异常，请稍后重试'}\n\n登录记录已保留，可以直接再试一次。`,
          showCancel: false,
        });
        return;
      }
      // 令牌确实失效/被撤销 → 移除该条记录并提示改用密码登录
      await auth.revokeDevice(entry.deviceToken);
      history.remove(entry.account, entry.studentId);
      this.loadHistory();
      this.setData({ account: entry.account });
      wx.showModal({
        title: '该登录记录已失效',
        content: `${err.message || '请重新登录'}\n\n已自动填入姓名，请输入密码完成登录。`,
        showCancel: false,
      });
    } finally {
      this.setData({ quickLoadingKey: '' });
    }
  },

  // 删除一条历史登录记录（同时撤销服务端令牌）
  removeHistory(e) {
    const { key } = e.currentTarget.dataset;
    const entry = this.data.historyList.find((x) => x.key === key);
    if (!entry) return;
    wx.showModal({
      title: '删除登录记录',
      content: `删除后「${entry.name}」将不能再一键登录，需要重新输入密码。`,
      confirmText: '删除',
      confirmColor: '#d54941',
      success: async (r) => {
        if (!r.confirm) return;
        await auth.revokeDevice(entry.deviceToken);
        history.remove(entry.account, entry.studentId);
        this.loadHistory();
        wx.showToast({ title: '已删除', icon: 'none' });
      },
    });
  },

  // 点击历史记录行 → 填入姓名（仍需密码）
  fillAccount(e) {
    const { key } = e.currentTarget.dataset;
    const entry = this.data.historyList.find((x) => x.key === key);
    if (entry) this.setData({ account: entry.account });
  },

  inputAccount(e) {
    this.setData({ account: e.detail.value });
  },

  inputPassword(e) {
    this.setData({ password: e.detail.value });
  },

  inputStudentId(e) {
    this.setData({ studentId: e.detail.value });
  },

  async submit() {
    const { account, password, submitting } = this.data;
    if (submitting) return;
    if (!account.trim() || !password) {
      wx.showToast({ title: '请输入姓名和密码', icon: 'none' });
      return;
    }
    // 本地测试登录会强制使用 dev_* 测试账号：此时姓名/密码不生效，明确告知而不是静默顶替
    if (auth.env.DEV_LOGIN) {
      wx.showModal({
        title: '当前为本地测试登录',
        content:
          'env.js 里 DEV_LOGIN=true 时，小程序会直接以测试账号（dev-student/teacher/admin）登录，姓名与密码不会生效，也看不到真实学籍、无法同步微信运动。\n\n要登录真实账号：请在 server/.env 填写 WX_APPSECRET，并把 miniprogram/config/env.js 的 DEV_LOGIN 改为 false。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    this.setData({ submitting: true });
    try {
      // 用户主动登录：先清掉「已退出」标记，再让服务端按当前微信确定身份
      // 已绑定的微信 → 直接拿正式 token；未绑定 → 拿游客 token 再走姓名+密码绑定
      auth.clearLoggedOut();
      if (auth.getToken()) auth.clearAuth();
      const loginResult = await auth.login();
      if (loginResult.bound !== false) {
        // ⚠️ 串号防线（用户 2026-10-20「学生与教师账号重名」）：
        // /api/auth/login 是**按微信 openid** 定身份的，一旦这个微信已绑定某账号就直接返回该身份，
        // 页面上输入的姓名/密码根本不会被使用 —— 旧实现直接 afterLogin，于是
        // 「微信绑的是学生陈宇航，输入教师陈宇航的密码」会静默进学生身份，且用户完全无从察觉。
        // 所以姓名对不上时必须显式问一句，绝不静默顶替。
        const typed = account.trim();
        const boundName = (loginResult.userInfo && (loginResult.userInfo.account || loginResult.userInfo.realName)) || '';
        if (typed && boundName && typed !== boundName) {
          // 用 actionSheet 而不是 showModal：这里需要**三个**选择（用输入的账号登 / 继续进入已绑账号 / 返回），
          // showModal 只有两个按钮。旧实现只有「继续登录 / 返回」，于是同一个微信要从教师 A 切到教师 B
          // 时是死胡同（截图里那个弹窗）—— 现在可以直接「用「B」登录」：
          // 服务端 /api/auth/bind 支持已登录态换绑，教师账号之间允许顶替（学生账号仍不允许）。
          wx.showActionSheet({
            itemList: [`用「${typed}」登录`, `继续进入「${boundName}」`],
            success: (r) => {
              if (r.tapIndex === 0) {
                this.loginAsTyped(typed, password, loginResult);
                return;
              }
              this.afterLogin(loginResult);
            },
            fail: () => {
              // 取消：auth.login() 已经把「已绑定账号」的 token 写进本地并标记为已登录
              // （request.js 的 setAuth），必须回滚，否则停在登录页却处于登录态，
              // 后续任何 requireLogin 的页面都会直接放行进入那个人的身份。
              auth.clearAuth();
              getApp().globalData.userInfo = null;
            },
          });
          return;
        }
        this.afterLogin(loginResult);
        return;
      }
      const result = await auth.bindAccount(account.trim(), password, this.data.studentId.trim());
      wx.showToast({ title: '登录成功', icon: 'success' });
      this.afterLogin(result);
    } catch (e) {
      this.handleLoginError(e);
    } finally {
      this.setData({ submitting: false });
    }
  },

  // 「用输入的账号登录」——当前微信已绑在另一个账号上时给用户的第二条路。
  // 走 /api/auth/bind（已登录态调用，服务端会用它自己的 openid 做换绑）：
  //   · 目标教师账号 → 允许换绑（教师之间可以顶替，用户 2026-10-22）；
  //   · 目标学生账号 → 仍然拒绝（学生微信不能被顶掉）。
  // 失败时回滚登录态：否则会停在登录页却处于「已绑账号」的登录态，后续页面直接放行进那个人。
  async loginAsTyped(typed, password, fallback) {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      const result = await auth.bindAccount(typed, password, this.data.studentId.trim());
      wx.showToast({ title: `已登录「${typed}」`, icon: 'success' });
      this.afterLogin(result);
    } catch (e) {
      auth.clearAuth();
      getApp().globalData.userInfo = null;
      if (e.code === 403004) {
        // 学生账号换微信 / 学生微信被顶：必须让用户看清原因，不能一闪而过
        wx.showModal({ title: '无法用这个账号登录', content: e.message || '该账号不能更换绑定的微信', showCancel: false });
      } else {
        this.handleLoginError(e);
      }
      // 保留了 fallback 参数：将来若要「失败后仍进入已绑账号」可在这里用，当前刻意不这么做
      void fallback;
    } finally {
      this.setData({ submitting: false });
    }
  },

  // 登录失败的统一提示（submit 与 loginAsTyped 共用）
  handleLoginError(e) {
    if (e.code === 429) {
      wx.showModal({ title: '账号已锁定', content: e.message, showCancel: false });
    } else if (e.code === 400902) {
      // 同名账号需要学号区分：展开学号输入框并提示，而不是把错误文案一闪而过
      // （用户 2026-10-20「学生与教师账号重名」：旧实现 matched[0] 会静默登进另一个人的身份）
      this.setData({ needStudentId: true });
      wx.showToast({ title: '存在同名账号，请填写学号', icon: 'none', duration: 2500 });
    } else {
      wx.showToast({ title: e.message || '登录失败', icon: 'none' });
    }
  },

  // 登录成功后的分流：强制改密 → 改密页；否则回首页
  afterLogin(result) {
    if (result.mustChangePassword) {
      wx.reLaunch({ url: '/pages/password/change?first=1' });
    } else {
      wx.switchTab({ url: '/pages/home/home' });
    }
  },

  // DEV：快速角色登录（切换 env.DEV_ROLE 后按新角色静默登录）
  devLogin(e) {
    const { env } = auth;
    const role = e.currentTarget.dataset.role;
    env.DEV_ROLE = role;
    auth.logout(); // 清掉旧 token（会打上「已退出」标记）
    auth.clearLoggedOut(); // 这是主动登录动作，清掉标记
    wx.showToast({ title: `已切换 ${role.replace('dev-', '')}，重新登录中`, icon: 'none' });
    setTimeout(async () => {
      try {
        const result = await auth.login();
        this.afterLogin(result);
      } catch (err) {
        wx.showToast({ title: err.message, icon: 'none' });
      }
    }, 600);
  },
});
