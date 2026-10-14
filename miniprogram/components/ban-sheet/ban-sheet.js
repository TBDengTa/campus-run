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
    visible(v) {
      // 每次打开都重置为默认值，避免沿用上一次的选择
      if (v) this.setData({ scope: 'login', days: 7, reason: '', scopeTip: SCOPES[0].tip });
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
