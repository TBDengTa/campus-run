// 房间填写对话框（教室 / 宿舍共用）：**一个对话框里选楼号 + 填门号，一次保存**
//
// 用户 2026-10-22：「尽量使用 Dialog 对话框完整的，现在你选择教学楼竟然还有弹窗让输入门号，
// 直接让用户一次输入完。」
// 旧流程是 action sheet 选楼 → 再弹 wx.showModal 填门号（第二个弹窗压在第一个上），
// 现在合成一个面板：楼号点选胶囊 + 门号输入 + 实时预览 + 保存。
//
// 用法（父页面）：
//   <room-dialog
//     visible="{{roomVisible}}" kind="dorm|classroom"
//     title="所住房间" sub="张三 · 未分配"
//     value="{{dormForm.roomText}}" bed-no="{{dormForm.bedNo}}"
//     buildings="{{dormBuildings}}" show-bed="{{true}}"
//     can-clear="{{hasRoom}}" saving="{{dormSaving}}" can-manage="{{true}}"
//     bind:confirm="onRoomConfirm" bind:clear="onRoomClear" bind:close="closeRoom" />
//   — confirm 的 detail: { roomText:'1号楼·201', bedNo:'3' }
//
// 属性：
//   visible    是否显示
//   kind       'dorm' | 'classroom'（决定文案与是否显示床位号）
//   title/sub  标题 / 副标题
//   value      当前值（形如「1号楼·201」，组件内部拆成 楼号 + 门号）
//   bedNo      当前床位号（kind='dorm' 时使用）
//   buildings  可选楼名（白名单，**只能选**）
//   showBed    是否显示床位号（固定 1~8）
//   canClear   是否显示「清空」按钮（已设置过才显示）
//   canManage  是否有写权限（无权限时只读展示）
//   saving     保存中
Component({
  properties: {
    visible: { type: Boolean, value: false },
    kind: { type: String, value: 'dorm' },
    title: { type: String, value: '所住房间' },
    sub: { type: String, value: '' },
    value: { type: String, value: '' },
    bedNo: { type: String, value: '' },
    buildings: { type: Array, value: [] },
    showBed: { type: Boolean, value: false },
    canClear: { type: Boolean, value: false },
    canManage: { type: Boolean, value: true },
    saving: { type: Boolean, value: false },
  },

  data: {
    pickBuilding: '',
    roomNo: '',
    bedOptions: [1, 2, 3, 4, 5, 6, 7, 8],
    canSave: false,
    icon: 'location',
    buildingLabel: '楼号',
  },

  observers: {
    // 打开时把当前值拆成楼号 + 门号；buildings 变化也要重算（白名单可能后到）
    'visible, value, buildings, kind': function (visible, value, buildings, kind) {
      if (!visible) return;
      const list = (buildings || []).map((b) => (b && b.name) || b).filter(Boolean);
      const raw = String(value || '');
      // 与服务端 services/dorms.js::parseRoomLabel 同一套分隔符
      const parts = raw.split(/[·・\-—/、,\s]+/).filter(Boolean);
      let pick = '';
      let no = '';
      if (parts.length >= 2 && list.includes(parts[0])) {
        pick = parts[0];
        no = parts.slice(1).join('');
      } else if (parts.length === 1 && list.includes(parts[0])) {
        pick = parts[0];
      } else if (list.length) {
        const hit = list.find((name) => raw.startsWith(name));
        if (hit) {
          pick = hit;
          no = raw.slice(hit.length).replace(/^[·・\-—/、,\s]+/, '');
        } else {
          no = parts.length >= 2 ? parts.slice(1).join('') : raw;
        }
      } else {
        no = parts.length >= 2 ? parts.slice(1).join('') : raw;
      }
      this.setData({
        pickBuilding: pick,
        roomNo: no,
        icon: kind === 'classroom' ? 'book' : 'houses',
        buildingLabel: kind === 'classroom' ? '教学楼' : '楼号',
      });
      this.refreshCanSave(pick, no);
    },
  },

  methods: {
    refreshCanSave(building, roomNo) {
      const ok = !!(String(building || '').trim() && String(roomNo || '').trim()) && this.data.canManage;
      if (ok !== this.data.canSave) this.setData({ canSave: ok });
    },

    onVisibleChange(e) {
      if (e.detail && !e.detail.visible) this.triggerEvent('close');
    },

    close() {
      this.triggerEvent('close');
    },

    tapBuilding(e) {
      if (!this.data.canManage) return;
      const name = e.currentTarget.dataset.name;
      if (!name) return;
      this.setData({ pickBuilding: name });
      this.refreshCanSave(name, this.data.roomNo);
    },

    // 门号：只收数字、限 6 位；返回过滤后的值让输入框回填
    onRoomInput(e) {
      const digits = String(e.detail.value || '').replace(/\D/g, '').slice(0, 6);
      this.setData({ roomNo: digits });
      this.refreshCanSave(this.data.pickBuilding, digits);
      return digits;
    },

    tapBed(e) {
      if (!this.data.canManage) return;
      const bed = String(e.currentTarget.dataset.bed || '');
      this.triggerEvent('bed', { bedNo: this.data.bedNo === bed ? '' : bed });
    },

    submit() {
      if (this.data.saving) return;
      const b = String(this.data.pickBuilding || '').trim();
      const r = String(this.data.roomNo || '').trim();
      if (!b) {
        wx.showToast({ title: '请先选择楼号', icon: 'none' });
        return;
      }
      if (!r) {
        wx.showToast({ title: '请填写门号', icon: 'none' });
        return;
      }
      this.triggerEvent('confirm', {
        roomText: `${b}·${r}`,
        bedNo: String(this.data.bedNo || '').trim(),
      });
    },

    clear() {
      if (!this.data.canManage) return;
      this.triggerEvent('clear');
    },
  },
});
