const auth = require('../../utils/request');

// 配置分类子页共享逻辑：载入全量配置 → 子页只编辑本组字段 → 保存只回传本组键
// （页面通过 sectionKeys 声明自己负责的键；服务端按白名单合并，未提供的键不动）
// 用法：Page({ sectionKeys: ['anticheat'], onShow() { section.onShow(this); }, checkAndLoad() {...}, save() {...} })
async function checkAndLoad(page) {
  try {
    await getApp().ensureLogin();
    const user = await getApp().refreshUser();
    const perms = user.effectivePermissions || [];
    if (!user.isManager || (!perms.includes('config.view') && !perms.includes('*'))) {
      wx.showModal({
        title: '无权限',
        content: '该功能仅限持有配置权限的教师/管理员使用',
        showCancel: false,
        success: () => wx.switchTab({ url: '/pages/home/home' }),
      });
      return;
    }
    // 只读 / 可写分开（用户 2026-10-22：「只有查看权限时应该不显示操作功能按钮，
    // 而不是点击后被后端拒绝掉」）。config.view 能进来看，config.manage 才能保存。
    // 各子页的 WXML 用 canManage 控制保存栏与输入框的 disabled。
    page.setData({ canManage: perms.includes('*') || perms.includes('config.manage') });
    await load(page);
  } catch (e) {
    wx.showToast({ title: e.message, icon: 'none' });
  }
}

async function load(page) {
  try {
    const config = await auth.get('/api/admin/config');
    page.setData({ config, loading: false });
  } catch (e) {
    page.setData({ loading: false });
    if (e.code === 403002) {
      wx.showModal({ title: '无权限', content: '该功能仅管理员可用', showCancel: false });
      return;
    }
    wx.showToast({ title: e.message, icon: 'none' });
  }
}

async function save(page) {
  if (page.data.saving) return;
  page.setData({ saving: true });
  const { config } = page.data;
  const payload = {};
  for (const key of page.sectionKeys || []) payload[key] = config[key];
  try {
    await auth.put('/api/admin/config', payload);
    wx.showToast({ title: '配置已保存', icon: 'success' });
  } catch (e) {
    wx.showToast({ title: e.message, icon: 'none' });
  } finally {
    page.setData({ saving: false });
  }
}

function onShow(page) {
  page.checkAndLoad();
}

module.exports = { checkAndLoad, load, save, onShow };
