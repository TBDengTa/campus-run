// 房间填写对话框（教室 / 宿舍共用）：**一个对话框里选楼号 + 填门号，一次保存**
//
// 用户 2026-10-22：「尽量使用 Dialog 对话框完整的，现在你选择教学楼竟然还有弹窗让输入门号，
// 直接让用户一次输入完。」
// 旧流程是 action sheet 选楼 → 再弹 wx.showModal 填门号（第二个弹窗压在第一个上），
// 现在合成一个面板：楼号点选胶囊 + 门号输入 + 实时预览 + 保存。
//
// 用户 2026-10-28：「在设置教室中会出现没有门号而是名的问题，需要进行扩充一下」——
//   教室的「门号」不再限定纯数字：阶梯教室 / 报告厅 / A301 这类没有门牌号的场所也要能填。
//   **宿舍仍然只收数字**（宿舍的房号是门牌号，且床位号 1~8 与按房间查宿都依赖数字口径）。
//   所以这个组件按 kind 区分输入模式，见下面的 allowText。
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
//   kind       'dorm' | 'classroom'（决定文案、输入模式与是否显示床位号）
//   title/sub  标题 / 副标题
//   value      当前值（形如「1号楼·201」，组件内部拆成 楼号 + 门号）
//   bedNo      当前床位号（kind='dorm' 时使用）
//   buildings  可选楼名（白名单，**只能选**）
//   showBed    是否显示床位号（固定 1~8）
//   canClear   是否显示「清空」按钮（已设置过才显示）
//   canManage  是否有写权限（无权限时只读展示）
//   saving     保存中
//
// ⚠️ 楼名分隔符一律不允许出现在「门号」里（见 sanitizeRoomNo）：
//    读回时组件与服务端都按 [·・\-—/、,\s] 拆分，门号里带这些字符会把自己拆成两段，
//    存进去再打开就变成「楼名 + 半截门号」—— 这类脏数据很难收拾。
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
    // 用户 2026-10-28：教室的门号可以是名称（阶梯教室 / 报告厅 / A301），宿舍仍是纯数字
    allowText: false,
    roomLabel: '门号',
    roomPlaceholder: '只填数字，如 201',
    roomHint: '',
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
      const isClassroom = kind === 'classroom';
      this.setData({
        pickBuilding: pick,
        roomNo: no,
        icon: isClassroom ? 'book' : 'houses',
        buildingLabel: isClassroom ? '教学楼' : '楼号',
        allowText: isClassroom,
        roomLabel: isClassroom ? '门号 / 场所' : '门号',
        roomPlaceholder: isClassroom ? '如 404 / A301 / 阶梯教室' : '只填数字，如 201',
        roomHint: isClassroom
          ? '没有门牌号的场所可直接填名称（如「阶梯教室」「报告厅」）；不能含 · - / 等分隔符'
          : '',
      });
      this.refreshCanSave(pick, no);
    },
  },

  methods: {
    // 门号清洗：与楼名分隔符冲突的字符一律去掉（否则读回时会被拆成两段，见文件头）
    sanitizeRoomNo(raw) {
      const s = String(raw === undefined || raw === null ? '' : raw)
        .replace(/[·・\-—/、,\n\r\t]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      // 教室允许名称（最多 20 字，与 class_profiles.classroom 的 40 字上限留出楼名余量）；
      // 宿舍只收数字（房号就是门牌号，床位与查宿都按它匹配），最多 6 位
      return this.data.allowText ? s.slice(0, 20) : s.replace(/\D/g, '').slice(0, 6);
    },

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

    // 门号：教室收文本（清洗分隔符、限 20 字）；宿舍只收数字、限 6 位
    // 返回值让输入框回填过滤后的值（否则输入框里还留着被过滤掉的字符）
    onRoomInput(e) {
      const v = this.sanitizeRoomNo(e.detail.value);
      this.setData({ roomNo: v });
      this.refreshCanSave(this.data.pickBuilding, v);
      return v;
    },

    tapBed(e) {
      if (!this.data.canManage) return;
      const bed = String(e.currentTarget.dataset.bed || '');
      this.triggerEvent('bed', { bedNo: this.data.bedNo === bed ? '' : bed });
    },

    submit() {
      if (this.data.saving) return;
      const b = String(this.data.pickBuilding || '').trim();
      const r = this.sanitizeRoomNo(this.data.roomNo);
      if (!b) {
        wx.showToast({ title: '请先选择楼号', icon: 'none' });
        return;
      }
      if (!r) {
        wx.showToast({ title: this.data.allowText ? '请填写门号或场所名' : '请填写门号', icon: 'none' });
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
