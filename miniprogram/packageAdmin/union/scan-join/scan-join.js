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
    // 主席团：可选全校所有业务部门（用户 2026-10-28）
    isPresidium: false,
    // 职务选项（部员 / 副部长 / 部长）：不高于自己在部门里的职务，主席团不限
    roleOptions: [],
    roleIndex: 0,
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

  // 取「可加入的部门 + 可选职务」（用户 2026-10-28）。
  //
  // 旧实现读 /api/union/mine 的 roles（= 自己在哪个部门），于是主席团成员
  // （deptKey='presidium'）只能往主席团加人 —— 而主席团根本没有部员。
  // 现在改走 /api/union/manage/join-options：
  //   · 主席团 → 返回全校**所有业务部门**（主席团本身被服务端排除，它不是可加入的部门）
  //   · 其它干部 → 只返回自己所在的部门
  // 同时该接口按「不能授予高于自己的职务」下发每个部门可选的职务。
  async loadDepts() {
    try {
      const res = await auth.get('/api/union/manage/join-options');
      const depts = (res && res.departments) || [];
      const isPresidium = !!(res && res.presidium);
      const opts = depts.map((d) => ({
        key: d.key,
        name: d.name,
        // 主席团看的是「全校」；其余干部看自己部门所在层级
        levelText: isPresidium ? '校学生会' : d.scope === 'branch' ? '本校区' : '校学生会',
        roles: d.roles || [],
      }));
      this.setData({
        isPresidium,
        deptOptions: opts,
        deptIndex: 0,
        deptReady: opts.length > 0,
        // 换部门要重置职务（不同部门可授予的职务可能不同）
        roleIndex: 0,
        roleOptions: opts.length ? opts[0].roles || [] : [],
      });
    } catch (e) {
      this.setData({ deptOptions: [], deptReady: false, error: e.message || '读取部门失败' });
    }
  },

  onDeptChange(e) {
    const idx = Number(e.detail.value) || 0;
    const dept = this.data.deptOptions[idx] || null;
    const roles = (dept && dept.roles) || [];
    this.setData({
      deptIndex: idx,
      deptReady: !!dept,
      // 换部门后职务回到第一个（通常是「部员」），避免残留上一个部门的高职务
      roleIndex: 0,
      roleOptions: roles,
    });
  },

  // 选职务（部员 / 副部长 / 部长）
  onRolePick(e) {
    const idx = Number(e.currentTarget.dataset.index) || 0;
    if (!this.data.roleOptions[idx]) return;
    this.setData({ roleIndex: idx });
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
        const role = (this.data.roleOptions[this.data.roleIndex] || {}).key || 'member';
        this.accept(token, dept, role);
      },
      fail: () => {
        /* 用户取消扫码不是错误 */
      },
    });
  },

  // 扫到即加入（部门与职务已在扫之前选定）
  // 用户 2026-10-28：「只能加入部门，成为部员或副部长、部长等」—— role 随扫码一起提交。
  async accept(token, dept, role) {
    this.setData({ loading: true, error: '', lastResult: null, lastJoined: false });
    try {
      const res = await auth.post(`/api/union/invite/${encodeURIComponent(token)}/accept`, {
        deptKey: dept.key,
        role: role || 'member',
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
