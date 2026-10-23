// 限制账号功能：选类型（登录 / 微信同步 / GPS）+ 时长 + 原因
// 组件只负责收集与校验，接口调用由页面（triggerEvent('submit')）完成
const SCOPES = [
  { value: 'login', label: '限制登录', tip: '整账号禁止登录，用户只能提交申诉' },
  { value: 'sync', label: '限制微信同步', tip: '禁止微信运动步数同步，其它功能不受影响' },
  { value: 'gps', label: '限制 GPS 实跑', tip: '禁止 GPS 实跑记录，其它功能不受影响' },
];

const DURATIONS = [
  { value: 1, label: '1 天' },
  { value: 3, label: '3 天' },
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: 0, label: '永久' },
];

Component({
  properties: {
    visible: { type: Boolean, value: false },
    user: { type: Object, value: null }, // { _id, account }
    busy: { type: Boolean, value: false },
    // 允许的限制类型（值数组，如 ['sync','gps']）：null/空 = 全部。
    // 用途：班主任在班级域只能限制「同步 / GPS」，「限制登录」是校级处置
    //（服务端 /api/class/student/:id/ban 会拒绝 login，前端不把注定 403 的选项摆出来）。
    allowScopes: { type: Array, value: null },
  },

  data: {
    scopes: SCOPES,
    durations: DURATIONS,
    scope: 'login',
    days: 7,
    reason: '',
    scopeTip: SCOPES[0].tip,
  },

  observers: {
    // 打开时按 allowScopes 收敛选项，并重置为「第一个可用类型」
    'visible, allowScopes'(v) {
      if (!v) return;
      const allow = Array.isArray(this.data.allowScopes) ? this.data.allowScopes : [];
      const scopes = allow.length ? SCOPES.filter((s) => allow.includes(s.value)) : SCOPES;
      const first = scopes[0] || SCOPES[0];
      this.setData({ scopes, scope: first.value, days: 7, reason: '', scopeTip: first.tip });
    },
  },

  methods: {
    onVisibleChange(e) {
      const visible = !!(e.detail && e.detail.visible);
      if (!visible) this.triggerEvent('close');
    },

    close() {
      this.triggerEvent('close');
    },

    pickScope(e) {
      const value = e.currentTarget.dataset.value;
      const hit = SCOPES.find((s) => s.value === value) || SCOPES[0];
      this.setData({ scope: hit.value, scopeTip: hit.tip });
    },

    pickDays(e) {
      this.setData({ days: Number(e.currentTarget.dataset.value) });
    },

    onReason(e) {
      this.setData({ reason: e.detail.value });
    },

    submit() {
      if (this.data.busy) return;
      this.triggerEvent('submit', {
        scope: this.data.scope,
        days: this.data.days,
        reason: this.data.reason.trim(),
      });
    },
  },
});
