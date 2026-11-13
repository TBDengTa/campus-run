// 宿舍绑定抽屉（公共组件）：**「班级管理 → 宿舍」与「管理端 → 用户详情」两处共用同一形态**
//
// 为什么抽成组件：这两个弹窗原来各写了一套（班级侧 .cd-sheet 单输入框、用户侧 .ud-dorm-sheet 两个输入框），
// 骨架 / 字段名 / 文案 / 间距全不一样，用户看到的是「同一件事、两个样子」。
//
// 形态（用户 2026-10-22「楼号只能选择，床号只能是1至8，输入的只有门号」）：
//   ① 楼号 → **只能点选**（来自系统设置 → 楼名管理 的「宿舍用楼」白名单）
//   ② 门号 → 唯一的自由输入（纯数字）
//   ③ 床位号 → 固定 1~8 点选
// 手打楼名的后果是「1号楼 / 一教 / 1-201」各写各的，按楼栋统计、按房间查人都对不上；
// 所以只保留门号一个输入项。
//
// 对外接口保持**向后兼容**：父页面仍然只传 `roomText`（形如「1号楼·201」）与 `bedNo`，
// 组件内部把它拆成 pickBuilding + roomNo 两段来渲染，改动时再拼回去 ——
// 这样两处父页面（class-manage/dorms 与 user-detail）不需要跟着改。
//
// ⚠️ 楼号胶囊 = `buildings`（服务端下发的白名单口径，见 services/student-dorm.js::buildingOptions）
//   ∪ 「该生当前住的楼」（只在清单里没有时补一条）。补这一条不是为了放宽白名单，
//   而是防止住在旧写法楼里的人（实测库里 739 人住「洋河」，标准清单已改成「洋河-男宿/女宿」）
//   打开抽屉时没有选中态、点保存被「请先选择楼号」挡住，只能改选另一栋 ——
//   想调个床位却把人换到别的楼。补的那条带 `legacy` 标记，界面单独提示、不会扩散给别人。
//
// 用法（父页面）：
//  1) 页面 json 注册： "usingComponents": { "dorm-sheet": "/components/dorm-sheet/dorm-sheet" }
//  2) wxml：
//       <dorm-sheet visible="{{dormVisible}}" title="所住房间" sub="{{dormSub}}"
//         room-text="{{dormForm.roomText}}" bed-no="{{dormForm.bedNo}}"
//         buildings="{{dormBuildings}}" quick-rooms="{{dormQuickRooms}}"
//         loading="{{dormLoading}}" saving="{{dormSaving}}"
//         disabled="{{!dormWechatBound}}" disabled-text="…" can-unbind="{{dormCanUnbind}}"
//         bind:change="onDormFormChange" bind:save="submitDorm" bind:unbind="unbindDorm" bind:close="closeDormSheet" />
//  3) 页面 data：dormVisible / dormForm:{roomText,bedNo} / dormSaving / dormCanUnbind / dormSub
//
// 事件：
//   change  detail:{ field:'roomText'|'bedNo', value }  — roomText 始终是**拼好的**「楼号·门号」
//   save    detail:{ roomText, bedNo }（已 trim）
//   unbind  detail:{}   close detail:{}
Component({
  properties: {
    visible: { type: Boolean, value: false },
    title: { type: String, value: '所住房间' },
    sub: { type: String, value: '' },
    roomText: { type: String, value: '' },
    bedNo: { type: String, value: '' },
    buildings: { type: Array, value: [] },
    quickRooms: { type: Array, value: [] },
    loading: { type: Boolean, value: false },
    saving: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false },
    disabledText: { type: String, value: '' },
    canUnbind: { type: Boolean, value: false },
    unbindText: { type: String, value: '退宿' },
  },

  data: {
    // 楼号（选中的楼名，空 = 还没选）
    pickBuilding: '',
    // 门号（唯一的自由输入，纯数字）
    roomNo: '',
    // 实际渲染的楼号胶囊：白名单 ∪（只在清单外时）该生当前住的楼，见文件头 ⚠️
    chips: [],
    // 当前选中的是「清单外的旧写法楼名」时非空，界面据此给单独提示
    legacyBuilding: '',
    // 床位号固定 1~8（用户 2026-10-22「床号只能是1至8」）
    bedOptions: [1, 2, 3, 4, 5, 6, 7, 8],
  },

  observers: {
    // 父页面回灌 roomText（如打开抽屉时展示当前宿舍）→ 拆成楼号 + 门号
    'roomText, buildings': function (roomText, buildings) {
      const raw = String(roomText || '');
      // 与服务端 services/dorms.js::parseRoomLabel 同一套分隔符，避免「1号楼 201」拆不出来
      const parts = raw.split(/[·・\-—/、,\s]+/).filter(Boolean);
      const list = (buildings || [])
        .map((b) => (typeof b === 'string' ? b : (b && b.name) || ''))
        .filter(Boolean);
      let pick = '';
      let no = '';
      if (parts.length >= 2 && list.includes(parts[0])) {
        pick = parts[0];
        no = parts.slice(1).join('');
      } else if (parts.length === 1 && list.includes(parts[0])) {
        // 只有楼名、还没填门号
        pick = parts[0];
      } else if (list.length) {
        // 拆不出来但首段与某个楼名高度相似（历史数据）→ 尽力匹配，匹配不到就留空让人重选
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

      // 楼名白名单收窄后（脏楼名不再下发），住在旧写法楼里的人会走到这里：
      // 把「最后一个分隔符之前」那段当楼名补成一条胶囊（门号 = 最后一段）。
      // 只补**该生自己当前这一条**，别的学生的胶囊仍是干净的白名单。
      let legacy = '';
      if (!pick && parts.length >= 2) {
        // 非全局 + 负向先行：命中的是**最后一个**分隔符串
        const lastSep = raw.match(/[·・\-—/、,\s]+(?!.*[·・\-—/、,\s])/);
        if (lastSep) {
          const cut = lastSep.index;
          const cand = raw.slice(0, cut).trim();
          no = raw.slice(cut + lastSep[0].length).trim();
          if (cand && !list.includes(cand)) {
            pick = cand;
            legacy = cand;
          } else {
            no = parts[parts.length - 1];
          }
        }
      }

      const chips = (buildings || [])
        .map((b) => (typeof b === 'string' ? { name: b } : b))
        .filter((b) => b && b.name);
      if (legacy) chips.push({ name: legacy, rooms: 0, legacy: true });

      const patch = {};
      if (pick !== this.data.pickBuilding) patch.pickBuilding = pick;
      if (no !== this.data.roomNo) patch.roomNo = no;
      if (legacy !== this.data.legacyBuilding) patch.legacyBuilding = legacy;
      if (chips.length !== this.data.chips.length || chips.some((c, i) => {
        const o = this.data.chips[i];
        return !o || o.name !== c.name || !!o.legacy !== !!c.legacy;
      })) patch.chips = chips;
      if (Object.keys(patch).length) this.setData(patch);
    },
  },

  methods: {
    onVisibleChange(e) {
      if (e.detail && !e.detail.visible) this.triggerEvent('close');
    },

    close() {
      this.triggerEvent('close');
    },

    // 选楼号：只更新选中态，把「拼好的 roomText」抛给父页面
    tapBuilding(e) {
      const name = e.currentTarget.dataset.name;
      if (!name) return;
      const patch = { pickBuilding: name };
      // 一旦改选标准清单里的楼，就把补出来的「旧写法」胶囊与提示撤掉：
      // 那是为「沿现住楼只调床位」补的入口，人已经主动换楼了就不该继续挂在那儿。
      if (name !== this.data.legacyBuilding) {
        patch.legacyBuilding = '';
        patch.chips = (this.data.chips || []).filter((c) => c && !c.legacy);
      }
      this.setData(patch);
      this.emitRoom(name, this.data.roomNo);
    },

    // 门号输入：只收数字（负数/小数/字母都不进），最多 6 位
    onRoomInput(e) {
      const digits = String(e.detail.value || '').replace(/\D/g, '').slice(0, 6);
      this.setData({ roomNo: digits });
      this.emitRoom(this.data.pickBuilding, digits);
      // 回填被过滤后的值（否则输入框仍显示字母）
      return digits;
    },

    // 床位号：再点一次取消（选填）
    tapBed(e) {
      const bed = String(e.currentTarget.dataset.bed || '');
      const next = this.data.bedNo === bed ? '' : bed;
      this.triggerEvent('change', { field: 'bedNo', value: next });
    },

    // 已有房间快捷：整串填入 → 观察器会把它拆成楼号 + 门号
    tapRoom(e) {
      const label = e.currentTarget.dataset.label;
      if (!label) return;
      this.triggerEvent('change', { field: 'roomText', value: label });
    },

    // 把「楼号 + 门号」拼成 roomText 抛出去（父页面只认识这一个字段）
    emitRoom(building, roomNo) {
      const b = String(building || '').trim();
      const r = String(roomNo || '').trim();
      const value = b && r ? `${b}·${r}` : b ? `${b}·` : r;
      this.triggerEvent('change', { field: 'roomText', value });
    },

    submit() {
      if (this.data.saving || this.data.disabled) return;
      const b = String(this.data.pickBuilding || '').trim();
      const r = String(this.data.roomNo || '').trim();
      // 楼号必选（它现在只能点选，没选就是没填）
      if (!b) {
        wx.showToast({ title: '请先选择楼号', icon: 'none' });
        return;
      }
      if (!r) {
        wx.showToast({ title: '请填写门号', icon: 'none' });
        return;
      }
      this.triggerEvent('save', {
        roomText: `${b}·${r}`,
        bedNo: String(this.data.bedNo || '').trim(),
      });
    },

    unbind() {
      if (!this.data.canUnbind) return;
      this.triggerEvent('unbind');
    },
  },
});
