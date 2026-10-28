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
    // 院校（校学生会 + 各校区）：与「学生会成员→添加成员」同款两级选择
    campusOptions: [],
    campusIndex: 0,
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

  // 取「院校 + 部门 + 可选职务」（用户 2026-10-28）。
  //
  // 对齐管理端「学生会成员 → 添加成员」的两级选择器（用户原话：
  //   「你看在学生会成员(具有权限)中的增加成员就是院校与部门」），口径完全一致：
  //   · 院校 = 校学生会 / 各校区（服务端下发 campuses）
  //   · 部门 = 只列该院校可用的；共用部门（生活部/学习部/纪检部）在**每个校区各出现一次**
  //
  // 旧实现有两次错：① 读 /api/union/mine 的 roles（自己在哪个部门）→ 主席团只能加主席团；
  // ② 按 isPresidium 把层级一律写「校学生会」→ 各校区分会被说成校级。
  // 现在全部以服务端 join-options 为准，前端只做「院校→部门」联动。
  async loadDepts() {
    try {
      const res = await auth.get('/api/union/manage/join-options');
      const depts = (res && res.departments) || [];
      const campuses = (res && res.campuses) || [];
      const isPresidium = !!(res && res.presidium);

      // 院校选项：校学生会（全校）+ 各校区。都是"整条部门记录代入"的口径，
      // 这里只是选择器的分组维度 —— 真正的归属由 dept.schoolId 表达。
      const campusOptions = [{ id: 'school', name: '校学生会' }].concat(
        campuses.map((c) => ({ id: c.id, name: c.name || '未命名校区' }))
      );

      // 原始全量存一份（this._deptAll）：反复切院校不能把选项越换越少
      this._deptAll = depts.map((d) => ({
        key: d.key,
        name: d.name,
        levelText: d.levelText || (d.schoolName ? `${d.schoolName}学生会` : '校学生会'),
        schoolId: d.schoolId || '',
        schoolName: d.schoolName || '',
        scope: d.scope || 'both',
        roles: d.roles || [],
      }));

      this.setData({
        isPresidium,
        campusOptions,
        campusIndex: 0,
        deptOptions: [],
        deptIndex: 0,
        deptReady: false,
        roleIndex: 0,
        roleOptions: [],
      });
      // 默认落在第一个"有部门可选"的院校上，省掉一次无意义的空列表
      const firstIdx = campusOptions.findIndex((c) => this.buildDeptOptions(c.id).length > 0);
      this.applyCampus(firstIdx >= 0 ? firstIdx : 0);
    } catch (e) {
      this.setData({ deptOptions: [], deptReady: false, error: e.message || '读取部门失败' });
    }
  },

  // 按院校过滤可选部门（与服务端 join-options 的展开结果对齐）：
  //   ① 部门明确挂了校区 → 只在那个校区出现
  //   ② 共用部门（无 schoolId）→ 在**每个**校区各出现一次，但不出现在「校学生会」层
  //      （与 utils/union-dept.js::deptFitsCampus 的既有约定一致：
  //       全校层除主席团外不再有别的部门 —— 用户 2026-10-21）
  buildDeptOptions(campusId) {
    const all = this._deptAll || [];
    const isSchoolLevel = !campusId || campusId === 'school';
    return all
      .filter((d) => {
        if (d.schoolId) return !isSchoolLevel && String(d.schoolId) === String(campusId);
        return !isSchoolLevel; // 共用部门：各校区共用
      })
      .map((d) => ({
        ...d,
        // ⚠️ 选择器里必须带**校区前缀**（用户 2026-10-28「你看没有前缀·这就很难受」）：
        //   生活部/学习部/纪检部在两个校区各有一条，两个「体育部」也分属不同校区，
        //   只显示部门名的话下拉里会出现两个一模一样的「体育部」，根本没法选。
        //   label 只用于**显示**，提交时仍用 key + schoolId。
        label: d.schoolName ? `${d.schoolName} · ${d.name}` : d.name,
      }));
  },

  // 应用某个院校（切院校与初次加载共用）
  applyCampus(index) {
    const campus = this.data.campusOptions[index] || {};
    const opts = this.buildDeptOptions(campus.id);
    this.setData({
      campusIndex: index,
      deptOptions: opts,
      deptIndex: 0,
      deptReady: opts.length > 0,
      roleIndex: 0,
      roleOptions: opts.length ? opts[0].roles || [] : [],
    });
  },

  onCampusChange(e) {
    this.applyCampus(Number(e.detail.value) || 0);
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
        // 共用部门（生活部等）在每个校区各展开一条，必须把选中的校区一起提交，
        // 否则服务端只能按干部自己的记录猜 → 又把北校区的加人记成校级
        schoolId: dept.schoolId || '',
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
