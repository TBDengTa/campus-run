// 本班宿舍绑定（管理员在「班级管理」里维护）
//
// ⚠️ 关键口径（用户明确纠正过）：宿舍是**学生 ↔ 房间**的关系，不是班级 ↔ 房间。
// 一个房间可能同时住几个班的学生（混宿），同班学生也可能分散在不同楼。
// 所以本页只处理「本班每个学生住哪间」，不去猜「这个班归哪几间房」。
//
// 录入形式（与「用户详情 → 宿舍」**完全同一形态**，都走公共组件 components/dorm-sheet）：
// 「宿舍号（楼号·门号）」主输入 + 可选「床位号」次输入 + 楼栋 / 本班已有房间快捷。
// 刻意不做成「楼栋下拉 + 门号」两个必填框：混宿场景下管理员经常要在已有房间后加人，
// 两栏式会逼他重新选楼栋；单栏 + 快捷填充最少点击，且后端 parseRoomLabel 会自己拆楼号/门号。
// 床位号后端 assignStudentRoom 一直支持（bedNo），此前只有本页 UI 没给入口 —— 统一后两处能力一致。
const auth = require('../../../utils/request');

Page({
  data: {
    id: '',
    className: '',
    loading: true,
    canManage: false,
    students: [],
    shown: [],
    assigned: 0,
    unassigned: 0,
    buildings: [], // [{name, rooms}]
    quickRooms: [], // 本班已用过的房间（再次绑定最常用）
    keyword: '',
    onlyUnassigned: false,
    // 绑定抽屉（公共组件 dorm-sheet 的受控状态）
    sheetVisible: false,
    sheet: null, // { userId, name, studentId }
    sheetSub: '', // 抽屉副标题：学号 · 当前宿舍
    sheetForm: { roomText: '', bedNo: '' },
    sheetCanUnbind: false,
    saving: false,
  },

  onLoad(options) {
    if (!getApp().requireLogin()) return;
    const user = getApp().globalData.userInfo || {};
    const perms = user.effectivePermissions || [];
    this.setData({
      id: options.id || '',
      className: options.className ? decodeURIComponent(options.className) : '',
      canManage: perms.includes('*') || perms.includes('class.manage'),
    });
    if (this.data.className) wx.setNavigationBarTitle({ title: `${this.data.className} · 宿舍` });
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    if (!this.data.id) {
      this.setData({ loading: false });
      wx.showToast({ title: '缺少班级参数', icon: 'none' });
      return;
    }
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      const data = await auth.get(`/api/admin/class/profiles/${this.data.id}/dorms`);
      const students = (data.students || []).map((s) => ({ ...s, roomText: s.roomText || '未分配' }));
      // 常用房间：本班已经住进去的房间去重列出（混宿时给下一个学生复用同一间）
      const seen = new Set();
      const quickRooms = [];
      for (const s of students) {
        if (!s.assigned || seen.has(s.roomText)) continue;
        seen.add(s.roomText);
        quickRooms.push(s.roomText);
      }
      // 宿舍楼快捷（用户 2026-10-21「系统设置里维护宿舍用楼的楼名列表，选楼名再填门牌号」）：
      // ① 先用后台配置的**宿舍用楼**清单（即使还没住过人也列出来 —— 新楼要能直接选）；
      // ② 再并入历史已有房间的楼（配置漏配时不会因为清单为空就填不了宿舍）。
      // 配置的楼排前面：那是学校认定的标准楼名，历史数据里的可能是错的写法。
      // ⚠️ 走班级域的只读楼名接口（/api/class/buildings）而不是 /api/admin/config/buildings：
      //    宿管维护楼名需要 building.manage，而「填宿舍先选楼」只需要 class.view / 班主任身份
      //    （用户 2026-10-22「为什么教师权限组无法获取楼名」）。
      const cfgBuildings = await auth
        .get('/api/class/buildings')
        .then((r) => (r && r.dorm) || [])
        .catch(() => []);
      const cfgSet = new Set(cfgBuildings);
      const merged = cfgBuildings
        .map((name) => ({ name, rooms: ((data.buildings || []).find((x) => x.name === name) || {}).rooms || 0 }))
        .concat((data.buildings || []).filter((b) => !cfgSet.has(b.name)));
      this.setData({
        loading: false,
        students,
        shown: this.filter(students),
        assigned: data.assigned || 0,
        unassigned: data.unassigned || 0,
        buildings: merged,
        quickRooms,
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  filter(list) {
    const kw = String(this.data.keyword || '').trim();
    let out = list || [];
    if (this.data.onlyUnassigned) out = out.filter((s) => !s.assigned);
    if (kw) out = out.filter((s) => `${s.name}${s.studentId}${s.roomText}`.indexOf(kw) >= 0);
    return out.slice(0, 300);
  },

  applyFilter() {
    this.setData({ shown: this.filter(this.data.students) });
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value || '' }, () => this.applyFilter());
  },

  toggleUnassigned() {
    this.setData({ onlyUnassigned: !this.data.onlyUnassigned }, () => this.applyFilter());
  },

  // 清空关键字（双列卡片上输入框较窄，给个一键清空）
  clearKeyword() {
    this.setData({ keyword: '' }, () => this.applyFilter());
  },

  // ===== 绑定 / 改绑（抽屉是公共组件 dorm-sheet，这里只做受控回灌与提交）=====
  openBind(e) {
    const userId = e.currentTarget.dataset.id;
    const s = (this.data.students || []).find((x) => x.userId === userId);
    if (!s) return;
    this.setData({
      sheetVisible: true,
      sheet: { userId: s.userId, name: s.name, studentId: s.studentId },
      sheetSub: `${s.studentId || '—'} · ${s.assigned ? s.roomText : '未分配'}`,
      sheetForm: {
        roomText: s.assigned ? s.roomText || '' : '',
        bedNo: (s.assigned && s.bedNo) || '',
      },
      // 只有当前在住（已绑定）才允许退宿：未分配的学生按钮置灰而不是消失
      sheetCanUnbind: !!s.assigned,
    });
  },

  closeSheet() {
    // 只收 visible，不清 sheet / sheetSub：清空会让抽屉在 240ms 收起动画里把标题从
    // 「张三 的宿舍」闪成兜底文案（下一次 openBind 会整体覆盖这些值）
    this.setData({ sheetVisible: false });
  },

  // 受控回灌：组件内的输入与楼栋 / 已有房间快捷点击都只抛 change，值由页面持有
  onSheetChange(e) {
    const { field, value } = (e.detail || {});
    if (field !== 'roomText' && field !== 'bedNo') return;
    this.setData({ [`sheetForm.${field}`]: value });
  },

  async submitBind(e) {
    if (this.data.saving) return;
    const s = this.data.sheet;
    if (!s) return;
    // 值以组件抛出的 detail 为准（组件已 trim）；页面 state 只作回灌
    const detail = (e && e.detail) || {};
    const label = String(detail.roomText || this.data.sheetForm.roomText || '').trim();
    const bedNo = String(detail.bedNo || this.data.sheetForm.bedNo || '').trim();
    if (!label) {
      wx.showToast({ title: '请填写宿舍号，如 1号楼·201', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      // 床位号一并提交（后端 assignStudentRoom 支持 bedNo，与用户详情页同一口径）
      const res = await auth.put(`/api/admin/class/profiles/${this.data.id}/dorms/${s.userId}`, {
        roomLabel: label,
        bedNo,
      });
      const extra = res && res.createdRoom ? '（已新建房间）' : res && res.movedFrom ? `（原 ${res.movedFrom}）` : '';
      wx.showToast({ title: `已绑定 ${s.name}${extra}`, icon: 'none' });
      // 同样只收 visible（理由同 closeSheet），随后重拉列表刷新房间/床位显示
      this.setData({ sheetVisible: false, saving: false });
      await this.load();
    } catch (err) {
      this.setData({ saving: false });
      wx.showToast({ title: err.message || '绑定失败', icon: 'none' });
    }
  },

  // 退宿：组件只在 canUnbind 为真时抛事件，这里再按当前抽屉里的学生确认一次
  async unbind() {
    const s = this.data.sheet;
    if (!s) return;
    if (!this.data.canManage) {
      wx.showToast({ title: '没有修改权限（需要 class.manage）', icon: 'none' });
      return;
    }
    const that = this;
    wx.showModal({
      title: '退宿',
      content: `确认把「${s.name}」标记为退宿？历史记录保留，之后可重新绑定。`,
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await auth.del(`/api/admin/class/profiles/${that.data.id}/dorms/${s.userId}`);
          wx.showToast({ title: '已退宿', icon: 'none' });
          that.setData({ sheetVisible: false });
          await that.load();
        } catch (err) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },
});
