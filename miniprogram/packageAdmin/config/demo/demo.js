const auth = require('../../../utils/request');
// 示例账户页在 packageAdmin/config/demo/ 下 → utils 在**上三级**
const { applyManage } = require('../../../utils/admin-perm');

/**
 * 示例账户管理（系统设置 → 示例账户）。
 *
 * 用户 2026-10-24：「增加新的功能 示例账户 功能，创建 示例学生1(班长权限)、
 * 示例教师1(班主任权限)、示例学生2(学生会) 密码为123456，不自动绑定微信，
 * 并且在首次登录输入新的密码增加跳过功能」+「退出登录自动解绑」。
 *
 * 页面只做三件事：看状态 / 创建重置 / 解绑与清理。
 * 三条示例账号的特殊规则（微信可抢占、退出自动解绑、可跳过改密）全在服务端实现，
 * 这里不重复判断，避免两处漂移。
 */
Page({
  data: {
    loading: true,
    busy: false,
    canManage: false,
    password: '123456',
    className: '',
    // rows = 规格 + 当前状态**合并后的一项**，模板只遍历它。
    // 不再在 WXML 里用 list[index] 跨数组取值（两数组顺序一旦不一致就会错位，
    // 表现为「明明创建了却显示未创建」，且没有任何报错 —— 用户 2026-10-24 报的就是这个）。
    rows: [],
    anyExists: false,
    // 接口版本（排查用）：老后端没有 apiVersion → 显示「旧版本」，
    // 一眼分清「代码没部署」还是「逻辑真有 bug」
    apiVersion: '',
    dbText: '', // 后端连的库（主机/库名），排查「看的账号和问的后端不是同一个库」
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      // applyManage 是 async（取不到缓存权限时会向服务端确认一次），必须 await，
      // 否则紧接着渲染时 canManage 还是默认 false，写按钮会闪一下才出现。
      await applyManage(this, 'config.manage');
      const res = await auth.get('/api/admin/demo');
      this.setData({
        loading: false,
        password: res.password || '123456',
        className: res.className || '',
        apiVersion: res.apiVersion || '旧版本（请重新部署后端）',
        dbText: res.db && res.db.host ? `${res.db.host}/${res.db.dbName}` : '',
        rows: buildRows(res),
        anyExists: !!res.anyExists,
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  // 创建 / 重置（幂等：已存在则把密码、权限、班级、学生会身份重置回预设值）
  async seed() {
    if (this.data.busy) return;
    const first = !this.data.anyExists;
    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: first ? '创建示例账户' : '重置示例账户',
        content: first
          ? `将创建 3 个示例账号（示例学生1 / 示例教师1 / 示例学生2），统一密码 ${this.data.password}，不会自动绑定微信。`
          : `将把 3 个示例账号重置为初始状态（密码 ${this.data.password}、权限与学生会身份恢复）。已绑定的微信不受影响。`,
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirm) return;

    this.setData({ busy: true });
    try {
      const res = await auth.post('/api/admin/demo/seed', { className: this.data.className });
      // 不传 className：让服务端自动挑（默认班不存在时回退到任意非毕业班）。
      // 以前的 bug：把云端的 DEFAULT_CLASS 又传回去，换环境时永远命中「班级不存在」。
      const cls = res.className ? `（班级：${res.className}）` : '';
      wx.showToast({
        title: first ? `已创建 ${res.created.length} 个${cls}` : `已重置${cls}`,
        icon: 'none',
        duration: 2500,
      });
      await this.load();
    } catch (e) {
      // 关键修复：失败时**不能只弹一个 toast 就结束** —— 用户看到的是「点了创建但列表还是未创建」，
      // 完全不知道哪里错了。这里用 showModal 把服务端原文完整展示出来。
      wx.showModal({
        title: '创建失败',
        content: e.message || '未知错误',
        showCancel: false,
      });
    } finally {
      this.setData({ busy: false });
    }
  },

  // 解绑某个示例账号的微信：换人试用时用（退出登录也会自动解绑，这里给个手动出口）
  unbind(e) {
    const key = e.currentTarget.dataset.key;
    const item = this.data.rows.find((x) => x.key === key);
    if (!item || !item.exists) {
      wx.showToast({ title: '请先创建示例账户', icon: 'none' });
      return;
    }
    if (!item.bound) {
      wx.showToast({ title: '该账号未绑定微信', icon: 'none' });
      return;
    }
    wx.showModal({
      title: `解绑「${item.label}」的微信`,
      content: '解绑后该微信退出该账号，任何人都可以用自己的微信登录它。示例账号退出登录时也会自动解绑。',
      success: async (r) => {
        if (!r.confirm) return;
        this.setData({ busy: true });
        try {
          await auth.post(`/api/admin/demo/${key}/unbind`, {});
          wx.showToast({ title: '已解绑', icon: 'success' });
          await this.load();
        } catch (err) {
          wx.showToast({ title: err.message || '解绑失败', icon: 'none' });
        } finally {
          this.setData({ busy: false });
        }
      },
    });
  },

  // 全部清理：只删示例账号与学生会记录，**不动班级与真实学生**
  removeAll() {
    if (this.data.busy) return;
    wx.showModal({
      title: '清理示例账户',
      content: '将删除 3 个示例账号及其学生会记录。班级与真实学生数据完全不受影响。',
      success: async (r) => {
        if (!r.confirm) return;
        this.setData({ busy: true });
        try {
          const res = await auth.del('/api/admin/demo');
          wx.showToast({ title: `已清理 ${res.removed} 个`, icon: 'success' });
          await this.load();
        } catch (e) {
          wx.showToast({ title: e.message || '清理失败', icon: 'none' });
        } finally {
          this.setData({ busy: false });
        }
      },
    });
  },

  // 复制密码：方便在另一个设备上登录试用
  copyPassword() {
    wx.setClipboardData({ data: this.data.password });
  },
});

/**
 * 组装页面行数据。
 *
 * **优先用服务端返回的 rows**（服务端已按 key 合并定义与状态，是唯一权威口径）；
 * 老版本后端没有 rows 时才在本地按 key 合并 list。
 *
 * 为什么这样分工（用户 2026-10-24 报「创建后示例账户页仍显示未创建」）：
 *   旧实现遍历 specs 却用 `list[index]` 取状态 —— 依赖两个数组顺序严格一一对应。
 *   服务端只要少一条 / 顺序变化，状态就整体错位成「未创建」，且**不报错**。
 *   现在合并逻辑只存在于服务端一处，前端无论遍历谁都拿的是同一份结果。
 */
function buildRows(res) {
  // ① 服务端已算好（新版本）：直接用，只补图标名
  if (res && Array.isArray(res.rows) && res.rows.length) {
    return res.rows.map((r) => ({ ...r, icon: iconOf(r.key) }));
  }
  // ② 兼容老版本后端：按 key 合并（绝不用下标）
  const specs = (res && res.specs) || [];
  const list = (res && res.list) || [];
  const byKey = new Map(list.map((it) => [it.key, it]));
  return specs.map((s) => {
    const st = byKey.get(s.key) || {};
    return {
      key: s.key,
      label: s.label || st.label || s.key,
      desc: s.desc || st.desc || '',
      exists: !!st.exists,
      bound: !!st.bound,
      icon: iconOf(s.key),
      boundAtText: st.boundAt ? fmtTime(st.boundAt) : '',
      diag: st.diag || null,
    };
  });
}

// 图标名在 JS 里定，不要写在 WXML 的三元里：
// 静态检查会把 'teacher1' 当成图标名报「图标不存在」，且模板里塞分支更难读
function iconOf(key) {
  return key === 'teacher1' ? 'usergroup' : key === 'student2' ? 'star' : 'user';
}

function fmtTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
