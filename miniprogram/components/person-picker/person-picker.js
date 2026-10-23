// 通用「选人」组件（搜索 + 筛选 + 多选）
//
// **为什么在主包 components 而不是某个分包**：它被两个不同分包引用
// （packageUnion/entry 的缺勤/未归名单、packageAdmin/union/members 的成员添加），
// 而小程序平台规则是「分包页面只能引用同包或主包的组件」—— 放在任一分包里，
// 另一个分包引用就会在真机注入失败（开发者工具能预览，真机白屏）。
// 代价是主包多约 13KB；`tools/check-app-json.js` 会拦下跨分包引用，别再把它挪回分包。
//
// 为什么要有它：凡是需要填人的地方（学生会成员、缺勤/未归名单……）都不应该手输姓名或学号 ——
// 「张伟 / 张玮」与录错一位学号在检查数据里是没法回滚的错误。统一走这个组件：
//   输入关键字 → 服务端搜索（/api/admin/union/members/candidates 或 /api/union/entry/students）
//   → 点选 → 已选列表；外部只拿 selected 数组。
//
// 用法：
//   <person-picker
//     api="/api/union/entry/students"
//     query-key="className"
//     query-value="{{current.className}}"
//     extra-query="{{pickerQuery}}"
//     limit="{{personsLimit}}"
//     selected="{{form.absentList}}"
//     bind:change="onPersonsChange"
//   />
//
// 交互约定：
//   · 搜索防抖 300ms，并用自增 seq 丢弃过期响应（快速输入时不会闪回旧结果）；
//   · 已选在结果列表里显示为「已选」并点击即取消（不需要来回滚动）；
//   · 未输入关键字时也可以传 initial 做「列全班」的场景（entry/students 支持空关键字）。
// 主包 components 下比分包少一层，务必用 ../../ 才能到根（多一层会整页白屏）
const auth = require('../../utils/request');

Component({
  properties: {
    // 搜索接口（两个域都支持）：/api/union/entry/students、/api/admin/union/members/candidates
    api: { type: String, value: '' },
    // 固定查询参数（如 className / departmentId）
    queryKey: { type: String, value: '' },
    queryValue: { type: String, value: '' },
    // 追加查询参数对象（如 { className: 'xx', departmentId: 'yy' }）
    // 变化时重新搜索：录入台是「先选受检对象、再出名单」，父页面的 queryValue 是后到的
    extraQuery: {
      type: Object,
      value: {},
      observer(next, prev) {
        if (!this.data.api) return;
        if (prev && JSON.stringify(next) === JSON.stringify(prev)) return;
        // 还没搜过且不需要自动列全部时，等用户输入即可
        if (!this._searched && !this.data.autoLoad) return;
        this.search(true);
      },
    },
    // 已选项（[{userId,name,studentId,reason,roomNo}]）
    selected: {
      type: Array,
      value: [],
      observer() {
        this.syncSelectedFlags();
      },
    },
    limit: { type: Number, value: 50 },
    placeholder: { type: String, value: '输入姓名 / 学号搜索' },
    // 是否允许填「原因」（缺勤原因 / 未归说明）
    withReason: { type: Boolean, value: false },
    reasonOptions: { type: Array, value: ['事假', '病假', '公假', '无故'] },
    autoLoad: { type: Boolean, value: false }, // 打开即列全部（班级人数有限时好用）
  },

  data: {
    keyword: '',
    loading: false,
    list: [],
    loadingMore: false,
    page: 1,
    hasMore: false,
    selectedCount: 0,
    limitText: '',
  },

  lifetimes: {
    attached() {
      this.setData({ limitText: `最多 ${this.data.limit} 人` });
      if (this.data.autoLoad) this.search(true);
    },
  },

  methods: {
    onInput(e) {
      const keyword = e.detail.value || '';
      this.setData({ keyword });
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => this.search(true), 300);
    },

    onConfirm() {
      if (this._timer) clearTimeout(this._timer);
      this.search(true);
    },

    // 清空关键字：回到「全班 / 全范围」列表（没有它就只能一个个删字，现场录入很费劲）
    clearKeyword() {
      if (this._timer) clearTimeout(this._timer);
      this.setData({ keyword: '' }, () => this.search(true));
    },

    async search(reset) {
      if (!this.data.api) return;
      this._searched = true;
      const page = reset ? 1 : this.data.page + 1;
      const seq = (this._seq || 0) + 1;
      this._seq = seq;
      this.setData(reset ? { loading: true } : { loadingMore: true });
      try {
        const query = {
          keyword: this.data.keyword,
          page,
          limit: 20,
        };
        if (this.data.queryKey) query[this.data.queryKey] = this.data.queryValue;
        const extra = this.data.extraQuery || {};
        for (const k of Object.keys(extra)) {
          if (extra[k] !== '' && extra[k] !== null && extra[k] !== undefined) query[k] = extra[k];
        }
        const data = await auth.get(this.data.api, query);
        if (seq !== this._seq) return; // 过期响应直接丢弃
        const rows = (data.list || []).map((r) => ({
          userId: r.userId,
          name: r.name,
          studentId: r.studentId || '',
          roomNo: r.roomNo || '',
          className: r.className || '',
          subText: r.subText || '',
          unionTags: r.unionTags || [],
          picked: false,
        }));
        const merged = reset ? rows : this.data.list.concat(rows);
        this.setData({
          loading: false,
          loadingMore: false,
          list: merged,
          page,
          hasMore: !!data.hasMore,
        });
        this.syncSelectedFlags();
      } catch (e) {
        if (seq !== this._seq) return;
        this.setData({ loading: false, loadingMore: false });
        wx.showToast({ title: e.message || '搜索失败', icon: 'none' });
      }
    },

    onLoadMore() {
      if (this.data.hasMore && !this.data.loadingMore) this.search(false);
    },

    // 结果列表里标记「已选」（包含不在当前结果里的已选项，由 selected 属性维护）
    syncSelectedFlags() {
      const picked = new Set((this.data.selected || []).map((s) => s.userId));
      this.setData({
        list: this.data.list.map((r) => ({ ...r, picked: picked.has(r.userId) })),
        selectedCount: (this.data.selected || []).length,
      });
    },

    toggle(e) {
      const userId = e.currentTarget.dataset.id;
      const row = this.data.list.find((r) => r.userId === userId);
      if (!row) return;
      const selected = (this.data.selected || []).slice();
      const idx = selected.findIndex((s) => s.userId === userId);
      if (idx >= 0) {
        selected.splice(idx, 1);
        this.emit(selected);
        return;
      }
      if (selected.length >= this.data.limit) {
        wx.showToast({ title: `最多选 ${this.data.limit} 人`, icon: 'none' });
        return;
      }
      selected.push({
        userId: row.userId,
        name: row.name,
        studentId: row.studentId,
        roomNo: row.roomNo,
        reason: this.data.withReason ? this.data.reasonOptions[3] || '' : '',
      });
      this.emit(selected);
    },

    remove(e) {
      const userId = e.currentTarget.dataset.id;
      const selected = (this.data.selected || []).filter((s) => s.userId !== userId);
      this.emit(selected);
    },

    // 原因切换（缺勤 / 未归）：只改这一条的原因，不影响勾选
    onReason(e) {
      const userId = e.currentTarget.dataset.id;
      const reason = e.currentTarget.dataset.reason;
      const selected = (this.data.selected || []).map((s) => (s.userId === userId ? { ...s, reason } : s));
      this.emit(selected);
    },

    emit(selected) {
      this.setData({ selected });
      this.syncSelectedFlags();
      this.triggerEvent('change', { selected });
    },

    clearAll() {
      this.emit([]);
    },
  },
});
