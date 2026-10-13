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
      this.setData({ devRoles: ['dev-student', 'dev-teacher', 'dev-admin'] });
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
      // 令牌失效/被撤销 → 移除该条记录并提示改用密码登录
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
        this.afterLogin(loginResult);
        return;
      }
      const result = await auth.bindAccount(account.trim(), password);
      wx.showToast({ title: '登录成功', icon: 'success' });
      this.afterLogin(result);
    } catch (e) {
      if (e.code === 429) {
        wx.showModal({ title: '账号已锁定', content: e.message, showCancel: false });
      } else {
        wx.showToast({ title: e.message || '登录失败', icon: 'none' });
      }
    } finally {
      this.setData({ submitting: false });
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
