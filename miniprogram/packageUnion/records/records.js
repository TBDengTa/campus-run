// 检查记录列表（分包 packageUnion）：吸顶筛选（模块/状态 + 高频 + 日期 + 班级/院校/系部/楼栋）+ 卡片列表
//
// 权限：服务端 /api/union/records 已按身份过滤可见范围（校级全校 / 分院本院系 / 班主任本班 / 总管全校），
// 页面只负责把 query 透传过去，不做任何本地判权。
//
// ===== 筛选维度（用户 2026-11-19「有学生会总管的权限查看检查记录没有办法筛选与查看所有记录，
//   增加筛选如班级、系部、院校、楼栋等全面的筛选搜索功能」）=====
// 服务端已支持的参数（server/src/routes/union.js::GET /records）：
//   page / limit / moduleKey / status / className / date / from / to / mine / pendingAppeal /
//   inspectorOpenid &#47; school / department / building / keyword
//   —— 其中 school / department / building / keyword 是本次新增，与身份范围**求交集**（fail-closed）。
// 候选（facets：班级/院校/系部/楼栋 + 条数）由服务端按身份范围下发，前端不自己算。
//
// ⚠️ 三条铁律（改这块之前先读）：
//   ① **搜索必须防抖 + 丢弃过期响应**：每个字符都打接口会让「搜 3 个字看到第 1 个字的结果」；
//      用自增 seq 丢弃过期响应，且**不要用 `if (loading) return` 挡请求**（那正是丢搜索的成因）。
//   ② 筛选条件全部**进服务端**（与 scope 求交集）。前端自己过滤会让「列表变了但总数没变」，
//      而且越权风险（前端过滤 = 服务端把不该给的数据也发下来了）。
//   ③ 文案一律 JS 预计算（仓库约定：模板不做表达式拼接）。
const auth = require('../../utils/request');
const fmt = require('../../utils/format');

const STATUS_ALL = { key: '', label: '全部' };

// 日期快捷：一次点击**同时**设置 from 与 to（两个 picker 仍保留做精确日期选择）
const DATE_PRESETS = [
  { key: 'today', label: '今天' },
  { key: 'week', label: '近 7 天' },
  { key: 'month', label: '本月' },
];

// 卡片上的名单折叠上限（与服务端 check-modules.ROSTER_PREVIEW_MAX 同值；
// 服务端只下发 3 个姓名，这里再 join 成一行文案）
const ROSTER_JOIN = '、';
// 卡片照片缩略图上限（服务端 photoLimit=3，这里只做文案兜底）
const PHOTO_MASK_FALLBACK = '宿舍照片仅检查人 / 主席团 / 所属部门部长 / 教师可见';

Page({
  data: {
    loading: true,
    list: [],
    page: 1,
    limit: 20,
    total: 0,
    hasMore: false,
    loadingMore: false,
    // ===== 筛选：基础维度 =====
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
    // ===== 筛选：组织维度（本次新增）=====
    // 每一项都是 { value, label } 的 picker 数组，index 0 = 不限
    schoolLabels: ['全部院校'],
    schoolIndex: 0,
    school: '',
    deptLabels: ['全部系部'],
    deptIndex: 0,
    department: '',
    buildingLabels: ['全部楼栋'],
    buildingIndex: 0,
    building: '',
    classLabels: ['全部班级'],
    classIndex: 0,
    keyword: '',
    // 候选（服务端 facets，含条数）：切筛选时不清空，避免面板闪空
    schools: [],
    departments: [],
    buildings: [],
    classes: [],
    // 筛选面板展开态（默认收起：现场高频是模块/状态+日期）
    showMore: false,
    // 有多少个「更多筛选」生效中（按钮角标）
    moreCount: 0,
    moreSummary: '',
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
    // 本班视角：非成员且带了 className（班主任/班委从「班超」的「全部 ›」进来）
    classView: false,
    // 是否显示组织维度筛选（班级/院校/系部/楼栋）：
    // 只有「能看到多个班」的人才需要（学生会成员 / 总管）。班主任 / 班委只有一个班，
    // 给他一个只有 1 项的班级下拉是噪音 —— 那是本次需求的「如果是班主任还要注意」。
    showOrgFilters: false,
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

  onUnload() {
    clearTimeout(this._searchTimer);
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
    if (this.data.school) parts.push(this.data.school);
    if (this.data.department) parts.push(this.data.department);
    if (this.data.building) parts.push(this.data.building);
    // className 在「本班视角」下是入口带进来的范围（不是用户点选的筛选项），
    // 那种情况下面已经由标题说明，不再重复成一行噪音。
    if (this.data.className && this.data.classView === false) parts.push(this.data.className);
    if (this.data.keyword) parts.push(`搜索「${this.data.keyword}」`);
    if (this.data.fromDate || this.data.toDate) {
      parts.push(`${this.data.fromDate || '不限'} ~ ${this.data.toDate || '不限'}`);
    }
    // 「更多筛选」角标：只数组织维度 + 关键词（日期与模块在常驻区已可见）
    const more = [this.data.school, this.data.department, this.data.building, this.data.keyword].filter(Boolean);
    const moreCount = more.length + (this.data.className && !this.data.classView ? 1 : 0);
    this.setData({
      filterTip: parts.length ? parts.join(' · ') : '全部记录',
      moreCount,
      moreSummary: more.length ? more.join(' · ') : '',
    });
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
        // 组织维度筛选只给「能看到多个班」的人：学生会成员 / 总管（canReview 或 isMember）。
        // 班主任 / 班委只有一个班，给他们一个单选项的班级下拉是噪音
        // （用户 2026-11-19「如果是班主任还要注意」）。
        showOrgFilters: isMember || !this.data.className,
        // 本班视角下「仅我的」「待复核」没有意义（他们既不提交也不复核），直接清掉，
        // 避免带着一个恒空的筛选进页面却不自知。
        ...(isMember ? {} : { mine: false }),
      });
      this._modulesLoaded = true;
    } catch (e) {
      // 模块字典拉不到不影响列表
    }
  },

  // 把服务端 facets 转成 picker 选项（保留当前选中项；选中项若已不在候选里也追加进去，
  // 否则用户切了日期导致候选收窄时，picker 会显示错位的那一项）
  applyFacets(facets) {
    if (!facets) return;
    const toOptions = (arr, keyOf, labelOf) => (arr || []).map((x) => ({ value: keyOf(x), label: labelOf(x) }));
    const schools = toOptions(facets.schools, (x) => x.school, (x) => `${x.school}（${x.count}）`);
    const departments = toOptions(facets.departments, (x) => x.department, (x) => `${x.department}（${x.count}）`);
    const buildings = toOptions(facets.buildings, (x) => x.building, (x) => `${x.building}（${x.count}）`);
    const classes = toOptions(facets.classes, (x) => x.className, (x) => `${x.className}（${x.count}）`);
    this.setData({
      schools,
      departments,
      buildings,
      classes,
      ...this.pickerState('school', schools, 'schoolLabels', 'schoolIndex', '全部院校'),
      ...this.pickerState('department', departments, 'deptLabels', 'deptIndex', '全部系部'),
      ...this.pickerState('building', buildings, 'buildingLabels', 'buildingIndex', '全部楼栋'),
      ...this.pickerState('className', classes, 'classLabels', 'classIndex', '全部班级'),
    });
  },

  // 一个 picker 的 { labels, index }：index = 选中项在「不限 + 候选」里的位置
  pickerState(valueKey, options, labelsKey, indexKey, allLabel) {
    const cur = this.data[valueKey];
    const labels = [allLabel].concat((options || []).map((o) => o.label));
    const idx = cur ? (options || []).findIndex((o) => o.value === cur) + 1 : 0;
    return { [labelsKey]: labels, [indexKey]: idx > 0 ? idx : 0 };
  },

  async load(reset) {
    const page = reset ? 1 : this.data.page + 1;
    if (!reset && (this.data.loading || this.data.loadingMore)) return;
    // 搜索/筛选并发：自增 seq 丢弃过期响应（末次输入必须生效）。
    // ⚠️ 不用 `if (loading) return` 挡请求 —— 那会让「搜 3 个字只看到第 1 个字的结果」。
    const seq = (this._seq || 0) + 1;
    this._seq = seq;
    this.setData(reset ? { loading: true } : { loadingMore: true });
    this.syncTip();
    try {
      await getApp().ensureLogin();
      // 只拉一次字典（非成员的 modules 恒为「全部模块」，否则每次翻页都会重复请求）
      if (!this._modulesLoaded) await this.loadModules();
      if (seq !== this._seq) return;
      const status = this.data.statuses[this.data.statusIndex] || STATUS_ALL;
      const data = await auth.get('/api/union/records', {
        page,
        limit: this.data.limit,
        moduleKey: (this.data.modules[this.data.moduleIndex] || {}).key || '',
        status: status.key || '',
        className: this.data.className,
        school: this.data.school,
        department: this.data.department,
        building: this.data.building,
        keyword: this.data.keyword,
        from: this.data.fromDate,
        to: this.data.toDate,
        mine: this.data.mine ? 1 : '',
        pendingAppeal: this.data.pendingAppeal ? 1 : '',
      });
      if (seq !== this._seq) return;
      // 只有第一页带 facets（翻页不需要重复统计）
      if (reset && data.facets) this.applyFacets(data.facets);
      const rows = (data.list || []).map((r) => this.decorate(r));
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
      if (seq !== this._seq) return;
      this.setData({ loading: false, loadingMore: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  // 单条记录 → 卡片展示字段（全部预计算，模板不拼表达式）
  //
  // 缺勤人（用户 2026-11-19「卡片要增加缺勤人的显示」）：
  //   服务端 roster = { label, names(≤3), count, more, hidden }。
  //   文案分三段拼，因为 count 与 names.length **可能不一致**（老记录 actualCount 是手填的，
  //   absentCount = 应到 − 实到 会大于名单人数）：
  //     「缺勤 8 人 · 张三、李四、王五 +5」   ← 正常
  //     「缺勤 8 人 · 名单未记录」            ← 名单为空但计数 >0（不能显示 0 人）
  //     「缺勤 5 人 · 名单仅管理端可见」      ← 普通学生视角（姓名被服务端按权限置空）
  decorate(r) {
    const appealText = !r.appeal
      ? ''
      : r.appeal.status === 'pending'
        ? '申诉中'
        : r.appeal.status === 'approved'
          ? '申诉成立'
          : '申诉未通过';
    const roster = r.roster || null;
    let rosterText = '';
    let rosterNamesText = '';
    let rosterMoreText = '';
    let rosterFlagText = '';
    if (roster && (roster.count > 0 || (roster.names || []).length)) {
      rosterText = `${roster.label || '缺勤'} ${roster.count} 人`;
      const names = (roster.names || []).filter(Boolean);
      if (names.length) {
        rosterNamesText = names.join(ROSTER_JOIN);
        rosterMoreText = roster.more > 0 ? `+${roster.more}` : '';
      } else if (roster.hidden) {
        rosterFlagText = '名单仅管理端可见';
      } else {
        rosterFlagText = '名单未记录';
      }
    }
    const photos = r.photos || [];
    const photoCount = Number(r.photoCount) || photos.length;
    return {
      ...r,
      // ⚠️ date 用 String() 兜底再切片：记录缺字段时 `r.date.slice` 直接抛错，
      // 整页列表白屏（服务端理论上一定有 date，但卡片渲染不能赌数据完整性）。
      dateText: /^\d{4}-\d{2}-\d{2}/.test(String(r.date || ''))
        ? `${Number(String(r.date).slice(5, 7))}/${Number(String(r.date).slice(8, 10))}`
        : '',
      // 10 分制（用户 2026-11-12）：扣分固定两位小数。
      // 以前是模板字符串直出，0.05 与 5 在列表里都只有两位有效数字的视觉宽度，
      // 而同页的「检查记录」详情用的是 scoreText（两位小数）—— 两处位数不一致最容易被当成算错。
      deductText: r.deduct ? `-${fmt.scoreText(r.deduct)}` : fmt.scoreText(0),
      statusClass: r.status === 'approved' ? 'done' : r.status === 'submitted' ? 'todo' : 'warn',
      appealText,
      appealClass: r.appeal && r.appeal.status === 'pending' ? 'pending' : 'done',
      // 缺勤人三段文案
      rosterText,
      rosterNamesText,
      rosterMoreText,
      rosterFlagText,
      hasRoster: !!rosterText,
      // 照片（用户 2026-11-19「卡片要增加照片显示」）：服务端已只给前 3 张，
      // photoCount 是总数 → 多出来的用 +N 表示（点击进详情看全部）。
      photos,
      hasPhotos: photos.length > 0,
      photoMoreText: photoCount > photos.length ? `+${photoCount - photos.length}` : '',
      // 宿舍照片被裁剪：服务端给 photosBlurred + photoNote，不显示空白区
      photosBlurred: !!r.photosBlurred,
      photoMaskText: r.photosBlurred ? r.photoNote || PHOTO_MASK_FALLBACK : '',
    };
  },

  // 照片预览（catch:tap 阻止冒泡进详情）
  previewPhoto(e) {
    const ds = e.currentTarget.dataset || {};
    const row = (this.data.list || []).find((r) => r.id === ds.id);
    if (!row || !row.photos || !row.photos.length) return;
    const idx = Number(ds.index) || 0;
    wx.previewImage({ urls: row.photos, current: row.photos[idx] || row.photos[0] });
  },

  // ===== 基础筛选 =====
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

  // ===== 组织维度筛选（院校 / 系部 / 楼栋 / 班级）=====
  // 统一入口：valueKey 是 data 里的字段名，picker 的 index → 候选值
  onOrgPick(e) {
    const ds = e.currentTarget.dataset || {};
    const valueKey = ds.key;
    const optionsKey = ds.options;
    const idx = Number(e.detail.value) || 0;
    const options = this.data[optionsKey] || [];
    const value = idx === 0 ? '' : (options[idx - 1] || {}).value || '';
    if (valueKey === 'className') {
      // className 在「本班视角」下是入口带进来的范围，用户手动选班级就变成主动筛选。
      // 两种语义都走同一个 query 参数（服务端只认 className），这里只清掉入口范围，
      // 否则「选了 A 班又带着入口的 B 班」会被服务端求交集成 0 条而用户不知道为什么。
      this.setData({ className: value, classView: false }, () => this.load(true));
      return;
    }
    this.setData({ [valueKey]: value }, () => this.load(true));
  },

  // 关键词搜索：300ms 防抖 + seq 丢弃过期响应（与仓库其它搜索页同一口径）
  onKeyword(e) {
    const keyword = String((e.detail && e.detail.value) || '').trim();
    this.setData({ keyword });
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this.load(true), 300);
  },

  onClearKeyword() {
    clearTimeout(this._searchTimer);
    this.setData({ keyword: '' }, () => this.load(true));
  },

  toggleMore() {
    this.setData({ showMore: !this.data.showMore });
  },

  // 清掉组织维度（保留模块/状态/日期/仅我的等常驻筛选）
  clearOrgFilters() {
    this.setData(
      { school: '', department: '', building: '', className: '', classView: false, keyword: '', schoolIndex: 0, deptIndex: 0, buildingIndex: 0, classIndex: 0 },
      () => this.load(true)
    );
  },

  // ===== 高频筛选 =====
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
      {
        moduleIndex: 0,
        statusIndex: 0,
        fromDate: '',
        toDate: '',
        activePreset: '',
        mine: false,
        pendingAppeal: false,
        school: '',
        department: '',
        building: '',
        className: '',
        classView: false,
        keyword: '',
        schoolIndex: 0,
        deptIndex: 0,
        buildingIndex: 0,
        classIndex: 0,
      },
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
