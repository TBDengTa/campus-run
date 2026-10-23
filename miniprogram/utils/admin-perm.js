/**
 * 管理端页面统一的「写权限」判定（用户 2026-10-22：
 * 「只有查看权限时应该不显示操作功能按钮，而不是点击后被后端拒绝掉」）。
 *
 * 用法（页面 onShow / load 里先调一次，再按 data.canManage 渲染）：
 *   管理端页面都在 packageAdmin/<模块>/<页面>.js，所以要**上两级**引本文件：
 *   `const adminPerm = require(<上两级>/utils/admin-perm)` —— 即 ../../utils/admin-perm
 *   ...
 *   await adminPerm.applyManage(this, 'content.manage');   // data.canManage = 有 '*' 或该项
 *
 * 为什么要有这个工具：
 *   ① 各页面以前各写一遍 `perms.includes('*') || perms.includes('xxx.manage')`，
 *      漏一个页面就出现「只读账号能看到新增/编辑/删除按钮，点了 403」；
 *   ② 权限来源必须统一 —— 读 `globalData.userInfo`（登录/刷新时写入），
 *      没有就向服务端确认一次，**绝不在页面里各自调用 /api/auth/me**。
 *
 * 注意：前端只控显隐，真正的鉴权永远在服务端（requirePermission）。
 */
const auth = require('./request');

function hasPerm(list, wanted) {
  const arr = list || [];
  if (arr.includes('*')) return true;
  const wants = Array.isArray(wanted) ? wanted : [wanted];
  return wants.some((w) => w && arr.includes(w));
}

// 取有效权限（优先内存缓存，缺失时才请求一次）
async function readPerms() {
  const app = getApp();
  const cached = app && app.globalData && app.globalData.userInfo;
  if (cached && Array.isArray(cached.effectivePermissions)) return cached.effectivePermissions;
  const user = await app.refreshUser();
  return (user && user.effectivePermissions) || [];
}

/**
 * 给页面写入 canManage（以及可选的额外标志）。
 * @param {Object} page 页面实例
 * @param {string|string[]} wanted 写权限项（任一满足即可）
 * @param {{extra?: string[]}} [opts] extra: 额外的权限，算进 canManage 之外单独下发
 * @returns {Promise<{perms: string[], canManage: boolean}>}
 */
async function applyManage(page, wanted, opts = {}) {
  try {
    const perms = await readPerms();
    const canManage = hasPerm(perms, wanted);
    const patch = { canManage };
    const extras = opts.extra || [];
    for (const e of extras) patch[e] = canManage;
    if (page && typeof page.setData === 'function') page.setData(patch);
    return { perms, canManage };
  } catch (e) {
    // 取不到权限：一律按只读渲染（fail-closed，宁可少显示按钮也不给必然 403 的入口）
    if (page && typeof page.setData === 'function') page.setData({ canManage: false });
    return { perms: [], canManage: false };
  }
}

// 单独判定（不想写进 data 时用）
async function can(wanted) {
  try {
    return hasPerm(await readPerms(), wanted);
  } catch (e) {
    return false;
  }
}

module.exports = { applyManage, can, hasPerm };
