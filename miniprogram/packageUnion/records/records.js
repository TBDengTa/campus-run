// 检查记录列表（分包 packageUnion）：吸顶筛选（日期快捷 + 高频筛选）+ 卡片列表
//
// 权限：服务端 /api/union/records 已按身份过滤可见范围（校级全校 / 分院本院系），
// 页面只负责把 query 透传过去，不做任何本地判权。
//
// ⚠️ 筛选参数**只允许**用接口已支持的这几个（server/src/routes/union.js::GET /records）：
//    page / limit / moduleKey / status / className / date / from / to / mine / pendingAppeal / inspectorOpenid
//    没有任何字段级的高级筛选，不要凭空调参数（传了也会被忽略，界面却像生效了 —— 这类假筛选最坑人）。
//    「仅我的」= mine=1；「待复核」= status=submitted。两者都是上面已有的参数，没有发明新契约。
const auth = require('../../utils/request');

const STATUS_ALL = { key: '', label: '全部' };

// 日期快捷：一次点击**同时**设置 from 与 to（两个 picker 仍保留做精确日期选择）
const DATE_PRESETS = [
  { key: 'today', label: '今天' },
  { key: 'week', label: '近 7 天' },
  { key: 'month', label: '本月' },
];

Page({
  data: {
    loading: true,
    list: [],
    page: 1,
    limit: 20,
    total: 0,
    hasMore: false,
    loadingMore: false,
    // 筛选
    modules: [{ key: '', label: '全部模块' }],
    moduleIndex: 0,
    statuses: [
      STATUS_ALL,
      { key: 'submitted', label: '待复核' },
      { key: 'approved', label: '已复核' },
      { key: 'rejected', label: '已退回' },
      { key: 'cancelled', label: '已取消' },
    ],
    statusIndex: 0,
    fromDate: '',
    toDate: '',
    className: '',
    mine: false,
    pendingAppeal: false,
    // 高频筛选 / 日期快捷的选中态（仅用于渲染高亮，数据仍从上面几个字段出）
    datePresets: DATE_PRESETS,
    activePreset: '',
    title: '检查记录',
    filterTip: '全部记录',
    // ===== 身份（决定「哪些筛选项有意义」）=====
    // 这个页面同时给两种人用，筛选条不能一样（用户 2026-10-19 报障：
    // 「检查申诉记录不应该是这样啊，上面不应该与学生会中的仅我的和待复核一样」）：
    //   · 学生会成员 → 「仅我的」(我提交的) / 「待复核」(我能审的) 有意义；
    //   · 班主任 / 班委（非成员，只看本班）→ 这两项对他们恒为空，
    //     有意义的是「申诉中」（本班哪些记录在申诉流程里）。
    isMember: true,
    canReview: false,
    // 本班视角：非成员且带了 className（班主任/班委从「班超」页的「全部 ›」进来）
    classView: false,
  },

  onLoad(options) {
    if (!getApp().requireLogin()) return;
    const statusIndex = Math.max(0, this.data.statuses.findIndex((s) => s.key === (options.status || '')));
    this.setData({
      className: options.className ? decodeURIComponent(options.className) : '',
      mine: options.mine === '1',
      pendingAppeal: options.pendingAppeal === '1',
      statusIndex,
      title: options.mine === '1' ? '我的录入记录' : options.pendingAppeal === '1' ? '申诉待处理' : '检查记录',
    });
    wx.setNavigationBarTitle({ title: this.data.title });
    this.syncTip();
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    this.load(true);
  },

  onPullDownRefresh() {
    this.load(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) this.load(false);
  },

  // 当前生效的筛选摘要（吸顶条下方一行，让「为什么列表变短了」一眼可见）
  syncTip() {
    const parts = [];
    const mod = this.data.modules[this.data.moduleIndex] || {};
    const status = this.data.statuses[this.data.statusIndex] || STATUS_ALL;
    if (mod.key) parts.push(mod.label);
    if (status.key) parts.push(status.label);
    if (this.data.mine) parts.push('仅我的');
    if (this.data.pendingAppeal) parts.push('申诉待处理');
    if (this.data.className) parts.push(this.data.className);
    if (this.data.fromDate || this.data.toDate) parts.push(`${this.data.fromDate || '不限'} ~ ${this.data.toDate || '不限'}`);
    this.setData({ filterTip: parts.length ? parts.join(' · ') : '全部记录' });
  },

  async loadModules() {
    try {
      const mine = await auth.get('/api/union/mine');
      const isMember = !!(mine && mine.isMember);
      const mods = [{ key: '', label: '全部模块' }].concat(
        ((mine && mine.modules) || []).map((m) => ({ key: m.key, label: m.shortName || m.name }))
      );
      this.setData({
        modules: mods,
        isMember,
        canReview: !!(mine && mine.canReview),
        // 非成员 + 指定了班级 = 班主任 / 班委的本班视图
        classView: !isMember && !!this.data.className,
        // 本班视角下「仅我的」「待复核」没有意义（他们既不提交也不复核），直接清掉，
        // 避免带着一个恒空的筛选进页面却不自知。
        ...(isMember ? {} : { mine: false }),
      });
      this._modulesLoaded = true;
    } catch (e) {
      // 模块字典拉不到不影响列表
    }
  },

  async load(reset) {
    const page = reset ? 1 : this.data.page + 1;
    if (pagesGuard(this, reset)) return;
    this.setData(reset ? { loading: true } : { loadingMore: true });
    this.syncTip();
    try {
      await getApp().ensureLogin();
      // 只拉一次字典（非成员的 modules 恒为「全部模块」，否则每次翻页都会重复请求）
      if (!this._modulesLoaded) await this.loadModules();
      const status = this.data.statuses[this.data.statusIndex] || STATUS_ALL;
      const data = await auth.get('/api/union/records', {
        page,
        limit: this.data.limit,
        moduleKey: (this.data.modules[this.data.moduleIndex] || {}).key || '',
        status: status.key || '',
        className: this.data.className,
        from: this.data.fromDate,
        to: this.data.toDate,
        mine: this.data.mine ? 1 : '',
        pendingAppeal: this.data.pendingAppeal ? 1 : '',
      });
      const rows = (data.list || []).map((r) => {
        const appealText = !r.appeal
          ? ''
          : r.appeal.status === 'pending'
            ? '申诉中'
            : r.appeal.status === 'approved'
              ? '申诉成立'
              : '申诉未通过';
        return {
          ...r,
          dateText: `${Number(r.date.slice(5, 7))}/${Number(r.date.slice(8, 10))}`,
          deductText: r.deduct ? `-${r.deduct}` : '0',
          statusClass: r.status === 'approved' ? 'done' : r.status === 'submitted' ? 'todo' : 'warn',
          appealText,
          appealClass: r.appeal && r.appeal.status === 'pending' ? 'pending' : 'done',
        };
      });
      this.setData(
        {
          loading: false,
          loadingMore: false,
          list: reset ? rows : this.data.list.concat(rows),
          page,
          total: data.total || 0,
          hasMore: !!data.hasMore,
        },
        () => this.syncTip()
      );
    } catch (e) {
      this.setData({ loading: false, loadingMore: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  onModuleChange(e) {
    this.setData({ moduleIndex: Number(e.detail.value) || 0 }, () => this.load(true));
  },

  onStatusChange(e) {
    this.setData({ statusIndex: Number(e.detail.value) || 0 }, () => this.load(true));
  },

  onFromDate(e) {
    // 手选日期即离开快捷区间（避免快捷药丸高亮与实际区间不符）
    this.setData({ fromDate: e.detail.value, activePreset: '' }, () => this.load(true));
  },

  onToDate(e) {
    this.setData({ toDate: e.detail.value, activePreset: '' }, () => this.load(true));
  },

  // 日期快捷：一次点击同时写入 from / to（再点一次取消该区间）
  onPresetDate(e) {
    const key = e.currentTarget.dataset.key || '';
    if (key === this.data.activePreset) {
      this.setData({ fromDate: '', toDate: '', activePreset: '' }, () => this.load(true));
      return;
    }
    const range = presetRange(key);
    if (!range) return;
    this.setData({ fromDate: range.from, toDate: range.to, activePreset: key }, () => this.load(true));
  },

  // 高频筛选：仅我的（mine=1，接口既有参数）
  toggleMine() {
    this.setData({ mine: !this.data.mine }, () => this.load(true));
  },

  // 高频筛选：待复核（status=submitted，接口既有参数）
  togglePending() {
    const index = this.data.statuses.findIndex((s) => s.key === 'submitted');
    const next = this.data.statusIndex === index ? 0 : index;
    this.setData({ statusIndex: Math.max(0, next) }, () => this.load(true));
  },

  // 高频筛选：申诉中（pendingAppeal=1，接口既有参数）
  // 班主任 / 班委视角下这是唯一有意义的高频筛选 —— 他们要看「本班哪些记录在申诉流程里」，
  // 而不是「我提交的 / 等我复核的」（那两项对他们恒为空）。
  toggleAppeal() {
    this.setData({ pendingAppeal: !this.data.pendingAppeal }, () => this.load(true));
  },

  clearDates() {
    this.setData({ fromDate: '', toDate: '', activePreset: '' }, () => this.load(true));
  },

  resetFilters() {
    this.setData(
      { moduleIndex: 0, statusIndex: 0, fromDate: '', toDate: '', activePreset: '', mine: false, pendingAppeal: false },
      () => this.load(true)
    );
  },

  goRecord(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/packageUnion/record/record?id=${id}` });
  },
});

// 日期快捷区间 → { from, to }（本地日期，YYYY-MM-DD，与服务端 dateKey 同口径）
function presetRange(key) {
  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const now = new Date();
  const today = keyOf(now);
  if (key === 'today') return { from: today, to: today };
  if (key === 'week') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    return { from: keyOf(start), to: today };
  }
  if (key === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: keyOf(start), to: today };
  }
  return null;
}

// 防止 onShow 与 onReachBottom 并发拉同一页
function pagesGuard(page, reset) {
  return !reset && page.data.loading;
}
