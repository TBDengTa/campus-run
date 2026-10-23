// 扫码加人（学生会干部用，用户 2026-10-22）
//
// 流程（用户 2026-10-22 明确）：「主席团/部长/副部长需要先在扫码页面中设置部门然后直接去扫，
// 成为部员。」
//   ① 先选部门（只能选自己在学生会里的部门，服务端也会再校一次）
//   ② 再扫码 —— 扫到即加入，无需二次确认
//
// 为什么改成「先选部门」：之前是「扫码 → 预览 → 选部门 → 确认」，
// 干部现场要连点四次；把部门前置后，扫码动作本身就是确认，现场只需两步。
// 预览信息仍在：扫到的**是谁**会立即以 toast + 结果卡片显示，加错人可当场撤回（页面提供）。
//
// 权限：与成员管理同一套闸门（服务端 assertMemberManager）——
// 只有主席团 / 部长 / 副部长 / 总管能进。
//
// 路径：本文件在 miniprogram/packageAdmin/union/scan-join/ → 到 miniprogram/utils 是 ../../../
const auth = require('../../../utils/request');
// 「能不能扫码加人」的唯一判定（与管理中枢入口同一份）：utils/nav-groups.js::canUnionScanJoin
const { canUnionScanJoin } = require('../../../utils/nav-groups');

Page({
  data: {
    canManage: false,
    loading: false,
    error: '',
    // 可选部门（来自自己在学生会里的成员记录）
    deptOptions: [],
    deptIndex: 0,
    deptReady: false, // 是否已选定部门（未选不能扫）
    // 上一次加入的结果
    lastResult: null, // { realName, className, studentId, deptName, memberId }
    lastJoined: false, // 刚加入（用于显示「撤回」）
  },

  onLoad() {
    if (!getApp().requireLogin()) return;
    const user = getApp().globalData.userInfo || {};
    // 判定口径与管理中枢入口完全一致（用户 2026-10-22「学生会扫码加入不应该显示」）：
    // 主席团 / 部长 / 副部长 / 学生会总管；**普通部员不再算**（服务端 assertMemberManager 会拒）。
    const canManage = canUnionScanJoin(user);
    this.setData({ canManage });
    if (canManage) this.loadDepts();
  },

  onShow() {
    if (!getApp().requireLogin()) return;
  },

  // 取自己在学生会里的部门（干部只能往自己的部门加人）
  async loadDepts() {
    try {
      const res = await auth.get('/api/union/mine');
      const roles = (res && res.roles) || [];
      const opts = [];
      const seen = new Set();
      for (const r of roles) {
        if (!r || !r.deptKey) continue;
        const key = r.deptKey;
        if (seen.has(key)) continue;
        seen.add(key);
        const name = r.deptName || (key === 'presidium' ? '主席团' : key);
        const levelText = r.level === 'school' ? '校学生会' : r.orgTitle || r.schoolName || '分院';
        opts.push({ key, name, levelText });
      }
      this.setData({ deptOptions: opts, deptIndex: 0, deptReady: opts.length > 0 });
    } catch (e) {
      this.setData({ deptOptions: [], deptReady: false, error: e.message || '读取你的部门失败' });
    }
  },

  onDeptChange(e) {
    const idx = Number(e.detail.value) || 0;
    this.setData({ deptIndex: idx, deptReady: (this.data.deptOptions[idx] || null) !== null });
  },

  // 扫码：必须已选部门
  scan() {
    if (!this.data.canManage) {
      wx.showToast({ title: '只有主席团 / 部长 / 副部长可以加人', icon: 'none' });
      return;
    }
    const dept = this.data.deptOptions[this.data.deptIndex] || null;
    if (!dept) {
      wx.showToast({ title: '请先选择要加入的部门', icon: 'none' });
      return;
    }
    if (this.data.loading) return;
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode', 'barCode'],
      success: (res) => {
        const raw = String((res && res.result) || '').trim();
        // 码内容形如 ttkp://union-invite/<token>；也容忍直接扫到 token 本身
        const m = raw.match(/union-invite\/([a-f0-9]{16,64})/i);
        const token = m ? m[1] : /^[a-f0-9]{16,64}$/i.test(raw) ? raw : '';
        if (!token) {
          wx.showToast({ title: '这不是入会二维码', icon: 'none' });
          return;
        }
        this.accept(token, dept);
      },
      fail: () => {
        /* 用户取消扫码不是错误 */
      },
    });
  },

  // 扫到即加入（部门已在扫之前选定）
  async accept(token, dept) {
    this.setData({ loading: true, error: '', lastResult: null, lastJoined: false });
    try {
      const res = await auth.post(`/api/union/invite/${encodeURIComponent(token)}/accept`, {
        deptKey: dept.key,
      });
      const m = (res && res.member) || {};
      this.setData({
        loading: false,
        lastJoined: true,
        lastResult: {
          realName: m.realName || (res && res.realName) || '该同学',
          className: m.className || '',
          studentId: m.studentId || '',
          deptName: (res && res.deptName) || dept.name,
          memberId: m.id || '',
        },
      });
      wx.showToast({ title: `已加入${(res && res.deptName) || dept.name}`, icon: 'success' });
    } catch (e) {
      this.setData({ loading: false, error: e.message || '加入失败' });
      wx.showToast({ title: e.message || '加入失败', icon: 'none' });
    }
  },

  // 撤回：加错人时当场把人撤出（离任），不用跳去成员页
  async undo() {
    const r = this.data.lastResult;
    if (!r || !r.memberId) return;
    const that = this;
    wx.showModal({
      title: `撤回 ${r.realName}？`,
      content: '会把他从刚加入的部门移出（保留历史记录，不删档）。',
      confirmColor: '#e34d59',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          // 用户端接口（干部只有学生会身份，没有 union.manage）：
          // 走 POST /manage/members/:id/remove ——它与管理端的效果一致（status='left'，保留历史）
          await auth.post(`/api/union/manage/members/${r.memberId}/remove`, {});
          wx.showToast({ title: '已撤回', icon: 'success' });
          that.setData({ lastResult: null, lastJoined: false });
        } catch (e) {
          wx.showToast({ title: e.message || '撤回失败', icon: 'none' });
        }
      },
    });
  },

  clearResult() {
    this.setData({ lastResult: null, lastJoined: false, error: '' });
  },
});
