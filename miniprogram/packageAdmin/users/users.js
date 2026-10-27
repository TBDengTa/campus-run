const auth = require('../../utils/request');

// 左滑按钮：滑出区域由组件内部节点渲染，只能用内联样式。
// 三个必须遵守的点：
//   ① `display` 只能是 `inline-flex`（TDesign 自带的 `.t-swipe-cell__content` 就是 inline-flex）——
//      写成 `display:flex` 会让按钮变成块级、在滑出容器里**竖着堆叠**，被行高一裁就只剩第一个「编辑」；
//   ② 显式写 `padding:0`，否则 TDesign 的 `padding:0 32rpx` 会把每个按钮从 104rpx 撑到 168rpx，
//      三个按钮要滑出 504rpx 才吸附展开，手机上一次很难滑到底；
//   ③ 宽度/字号按手机端收敛（104rpx / 24rpx），颜色取设计令牌。
const BTN_BASE = 'box-sizing:border-box;padding:0;color:#fff;font-size:24rpx;width:104rpx;height:100%;display:inline-flex;align-items:center;justify-content:center';
const BTN_STYLE = {
  edit: `background:#ff6b00;${BTN_BASE}`,
  ban: `background:#e5484d;${BTN_BASE}`,
  unban: `background:#16a34a;${BTN_BASE}`,
  del: `background:#6b7280;${BTN_BASE}`,
};

// 筛选条件的展示名（用于「已筛选」提示条）
const FILTER_LABELS = {
  school: '院校',
  department: '系部',
  specialty: '专业',
  grade: '年级',
  dailyAchieved: '日目标',
  weeklyAchieved: '周目标',
  classStatus: '班级状态',
  identity: '身份',
};

// 班级状态（与 server/src/models/class-profile.js::STATUS_TEXT 同口径）
// 注意「正常」在服务端包含**老数据没有 status 字段**的班，所以选项文案要说明这点，
// 否则管理员筛「正常」看到的人数比台账里的 status=normal 多，会以为筛选坏了。
const CLASS_STATUS_OPTIONS = [
  { label: '全部', value: '' },
  { label: '正常', value: 'normal' },
  { label: '实习', value: 'intern' },
  { label: '毕业', value: 'graduated' },
];
const CLASS_STATUS_TEXT = { normal: '正常', intern: '实习', graduated: '毕业' };
// 实习 / 毕业是「不参加班超与校园跑」的信号，要跳出来；正常不显示标签（噪音）。
// 实习用 warning 琥珀色而不是品牌橙：本仓库把 TDesign 的 primary 整套换成了橙色主题
//（--td-primary-color-7 = #ff6b00 = --tt-brand），所以「橙底」已经被管理员/学生会占用了。
const CLASS_STATUS_CHIP = { intern: 'warn', graduated: 'neutral' };

// 身份筛选：班委 / 班主任 / 学生会成员（与「管理员 Tab」是不同维度，可叠加）
const IDENTITY_OPTIONS = [
  { label: '全部', value: '' },
  { label: '班委', value: 'officer' },
  { label: '班主任', value: 'homeroom' },
  { label: '学生会成员', value: 'union' },
];
const IDENTITY_TEXT = { officer: '班委', homeroom: '班主任', union: '学生会成员' };

// 列表上方常驻分类 Tab：管理员不是角色而是权限，单独传 manager=1
const ROLE_TABS = [
  { key: 'all', label: '全部' },
  { key: 'student', label: '学生' },
  { key: 'teacher', label: '教师' },
  { key: 'manager', label: '管理员' },
];
const ROLE_TAB_LABELS = { all: '全部', student: '学生', teacher: '教师', manager: '管理员' };

// 筛选键 → filterOptions 里的选项数组键（年级/院校/系部/专业的选项是复数键，其余同名）。
// 必须显式列全：漏一个（如 grade→grades）不会报错，只会静默回退成显示原始 value
// ——「2025」而不是「2025级」，正是这类映射最容易悄悄错的地方。
const FILTER_OPTION_KEYS = {
  school: 'schools',
  department: 'departments',
  specialty: 'specialties',
  grade: 'grades',
  dailyAchieved: 'dailyAchieved',
  weeklyAchieved: 'weeklyAchieved',
  classStatus: 'classStatus',
  identity: 'identity',
};

// 日/周目标筛的是「当日 / 当周是否达标」，不是目标步数
const ACHIEVE_OPTIONS = [
  { label: '已达标', value: '1' },
  { label: '未达标', value: '0' },
];
const ACHIEVE_TEXT = { 1: '已达标', 0: '未达标' };

// ===== 筛选联动：院校 → 系部 → 专业（年级是正交属性，不参与联动）=====
// 数据来自 /api/admin/users/filters 的 tree（服务端已按 parentId + 数据共现合并）：
//   tree = [{ name, label, count, configured, observed, children: [{ ...同层, children: [节点] }] }]
// t-dropdown-item 的 options / value 都是**受控**属性，所以联动只需要在 change 时 setData 换掉
// filterOptions.departments / specialties —— tree 一次拉全量，之后纯内存收窄，**不再发任何请求**。
// 三个下拉共用的「全部」项：value 为空串，语义与原来一致（不传该查询参数）。
const ALL_OPTION = { label: '全部', value: '' };
const withAll = (list) => [ALL_OPTION, ...(list || [])];
// 已选值（value）始终是名字；label 只用于展示。
// ⚠️ 这里**一律给不带人数的基础 label**，人数由 applyFilterCounts() 统一装饰 ——
// 以前 tree 的 label 自带「计财系（1424）」这种全量人数，若在这里再拼实时人数就会出现双括号，
// 不拼则永远是静态数字（用户报的问题）。单一出口才不会两处算漂移。
const nodeOption = (n) => ({ label: String(n.name), value: String(n.name) });
// 同名节点合并（「全部院校」视图下同一系部名可能出现在多个院校里，按名字去重）
function mergeByName(nodes) {
  const byName = new Map();
  for (const n of nodes || []) {
    const name = String(n.name == null ? '' : n.name);
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, { ...n, name });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}
// 平铺数组 → 受控选项（接口只返回 schools/departments/specialties 时为兜底数据源）
const toOptions = (arr) => (arr || []).map((v) => ({ label: String(v), value: String(v) }));

// 按已选院校 / 系部收窄「系部 / 专业」两组选项：
//  · 院校 = 全部 → 系部恢复全量（所有院校的系部，同名合并）
//  · 系部 = 全部 → 专业恢复全量（选了院校就是该院校的专业，否则全树专业）
//  · 接口没给 tree（旧服务端 / 异常）→ 整体退回平铺数组：不联动，但下拉绝不空、也不报错
function resolveFilterOptions(tree, filters, flat) {
  const fallback = flat || {};
  if (!Array.isArray(tree) || !tree.length) {
    return {
      departments: withAll(fallback.departments),
      specialties: withAll(fallback.specialties),
    };
  }
  const f = filters || {};
  const schoolNode = f.school ? tree.find((s) => s.name === f.school) : null;
  const deptNode = schoolNode && f.department
    ? (schoolNode.children || []).find((d) => d.name === f.department)
    : null;

  const deptNodes = schoolNode
    ? schoolNode.children || []
    : tree.reduce((acc, s) => acc.concat(s.children || []), []);
  const specNodes = deptNode
    ? deptNode.children || []
    : (schoolNode
        ? (schoolNode.children || []).reduce((acc, d) => acc.concat(d.children || []), [])
        : tree.reduce((acc, s) => acc.concat((s.children || []).reduce((a, d) => a.concat(d.children || []), [])), []));

  return {
    departments: withAll(mergeByName(deptNodes).map(nodeOption)),
    specialties: withAll(mergeByName(specNodes).map(nodeOption)),
  };
}

// 生效中的限制类型：login 限制登录 / sync 限制微信同步 / gps 限制 GPS 实跑
// （限制登录 = status=banned 且未到期；sync/gps = restrictions[s].until 未到期）
const SCOPE_LABELS = { login: '限制登录', sync: '限制微信同步', gps: '限制 GPS' };

// ===== 行内标签的单行排版 =====
// 用户截图反馈：「实习」和「学生会·主席团 · 主席」被 flex-wrap 拆成两行，
// 橙色那块孤零零占满第二行，比没有标签还难看。
// 修法三件：① 容器不折行（宁可少显示一个标签，也不让一行变两行）；
//          ② 标签文案压缩（去掉「 · 」的空格、主席团的角色不重复部门名）；
//          ③ 按宽度预算**从右往左**丢弃放不下的标签，折叠成一个「+N」。
// 预算用「估算宽度」而不是量 DOM：小程序列表里逐行 createSelectorQuery 会拖慢首屏。
// 数值按 rpx 设计稿算（rpx 与设备无关）：中文字宽≈字号，数字/字母≈0.55 倍。
const NAME_ROW_BUDGET = 470; // .user-row-main 可用宽（750 − 页边距 − 卡片内边距 − 头像 − 箭头）
const CHIP_PAD = 20; // .users-chip 左右 padding 各 10rpx
const CHIP_GAP = 8;
const estWidth = (text, size) => {
  let w = 0;
  for (const ch of String(text || '')) w += /[\u4e00-\u9fff·]/.test(ch) ? size : size * 0.55;
  return Math.round(w);
};
const chipWidth = (c) => estWidth(c.text, 19) + (c.more ? estWidth(`+${c.more}`, 17) : 0) + CHIP_PAD;
const chipWidthWithMore = (c) => chipWidth(c) + (c.more ? CHIP_GAP : 0);

// 学生会标签文案压缩：服务端 unionText 是「部门 · 职务」（如「主席团 · 主席」）。
// 直接拼成「学生会·主席团 · 主席」有 11 个字，单行放不下（就是用户截图那次的成因）。
// 压缩规则：主席团的「部门名」没有信息量（职务「主席/副主席」已经说明身份）→ 只留职务；
// 其他部门保留部门名（「生活部 · 部员」里部门名才是关键），并把「 · 」压成「·」。
function unionChipText(roles) {
  const first = (roles || [])[0];
  if (!first) return '学生会·成员';
  const dept = String(first.deptName || '');
  const role = String(first.roleText || '');
  if (!dept || dept === '主席团') return `学生会·${role || '成员'}`;
  return `学生会·${dept}${role ? `·${role}` : ''}`;
}

// 按预算挑出可见标签：优先保留**排在前面的**（班级状态 > 班委/班主任 > 学生会），
// 放不下的折叠成 +N；连一个都放不下时只留 +N（姓名仍完整可读）。
function layoutChips(chips, nameText) {
  const nameW = Math.min(estWidth(nameText, 28), 300) + (chips.length ? CHIP_GAP : 0);
  let used = nameW;
  const shown = [];
  for (const c of chips) {
    const w = chipWidthWithMore(c) + (shown.length ? CHIP_GAP : 0);
    if (used + w > NAME_ROW_BUDGET) break;
    used += w;
    shown.push(c);
  }
  const dropped = chips.length - shown.length;
  if (dropped > 0) {
    // 折叠标记本身也要占位：预算不够时连它一起丢（宁可少一个提示，也不撑破一行）
    //
    // ⚠️ 一行里不能出现**两个** `+N`：union 标签自带的 `+N` 表示「还有 N 个学生会部门」，
    // 折叠标记的 `+N` 表示「还有 N 个标签没显示」——两个数字并排没人分得清。
    // 所以一旦发生折叠，就把各标签自带的 `+N` 收进来一起计数（信息不丢，只是合并表达），
    // 完整明细在用户详情页里看。
    let absorbed = 0;
    for (const c of shown) {
      if (c.more) {
        absorbed += c.more;
        c.more = 0;
      }
    }
    const moreChip = { text: `+${dropped + absorbed}`, cls: 'fold', more: 0 };
    if (used + CHIP_GAP + chipWidth(moreChip) <= NAME_ROW_BUDGET || !shown.length) shown.push(moreChip);
  }
  return shown;
}
function activeScopes(u) {
  const now = Date.now();
  const out = [];
  if (u.status === 'banned' && (!u.bannedUntil || new Date(u.bannedUntil).getTime() > now)) out.push('login');
  for (const s of ['sync', 'gps']) {
    const r = (u.restrictions || {})[s];
    if (r && r.until && new Date(r.until).getTime() > now) out.push(s);
  }
  return out;
}
function hasActiveRestriction(u) {
  return activeScopes(u).length > 0;
}

Page({
  // 权限重算（用户 2026-10-22「登录账户时一定要刷新缓存」）：
  // 换账号登录后页面 data 里的 canManage 可能还是上一个身份的结论 ——
  // 表现就是「只读账号仍看到操作按钮」。onShow 与登录回调都会调这里。
  //
  // 三个写权限各自独立（用户 2026-10-22 要求「用户管理中的操作」按权限隐藏）：
  //   canManage = user.manage        → 限制 / 解除 / 设班委 / 转移 / 解绑微信 / 宿舍
  //   canPerms  = permission.manage  → 重置密码 / 删除 / 创建账户 / 编辑资料
  //   canImport = user.import        → 导入名单
  refreshPermission() {
    const user = getApp().globalData.userInfo || {};
    const perms = user.effectivePermissions || [];
    const star = perms.includes('*');
    this.setData({
      canManage: star || perms.includes('user.manage'),
      canPerms: star || perms.includes('permission.manage'),
      canImport: star || perms.includes('user.import'),
    });
  },

  data: {
    keyword: '',
    status: '',
    role: '',
    manager: '', // '1' = 管理员 Tab（按权限过滤）
    roleTab: 'all',
    tabs: ROLE_TABS,
    page: 1,
    limit: 20,
    total: 0,
    list: [],
    loading: false,
    loadingMore: false,
    // 下拉筛选（院校 / 系部 / 专业 三项联动，年级与达标情况正交、始终全量）
    filterOptions: {
      schools: [],
      departments: [],
      specialties: [],
      grades: [],
      dailyAchieved: ACHIEVE_OPTIONS,
      weeklyAchieved: ACHIEVE_OPTIONS,
      classStatus: CLASS_STATUS_OPTIONS,
      identity: IDENTITY_OPTIONS,
    },
    filters: {
      school: '',
      department: '',
      specialty: '',
      grade: '',
      dailyAchieved: '',
      weeklyAchieved: '',
      classStatus: '',
      identity: '',
    },
    // 联动数据源：filterTree 来自接口（院校 → 系部 → 专业），filterFlat 是旧接口/异常时的兜底选项
    filterTree: [],
    filterFlat: null,
    // 不带人数的基础选项（label 干净）；人数由 renderFilterOptions 统一装饰成 filterOptions
    filterBase: { schools: [], departments: [], specialties: [], grades: [], classStatus: [], identity: [] },
    // 服务端随列表返回的实时人数；null = 当前条件下刻意不计数；undefined = 还没到货
    facetCounts: undefined,
    // 每个下拉触发器显示的标题：未选=维度名，已选=选中值（见 computeFilterLabels）
    filterLabels: {
      school: '院校',
      department: '系部',
      specialty: '专业',
      grade: '年级',
      dailyAchieved: '日目标',
      weeklyAchieved: '周目标',
      classStatus: '班级状态',
      identity: '身份',
    },
    hasActiveFilter: false,
    filterCount: 0, // 筛选面板按钮上的角标
    filterSummary: '', // 已生效条件文案
    showFilters: false, // 筛选面板默认收起，把首屏留给列表
    canManage: false,
    // 与 canManage 分开的写权限（见 refreshPermission 注释）：创建账户/重置密码/删除需要
    // permission.manage，导入名单需要 user.import —— 只有查看权限的账号一个都看不到。
    canPerms: false,
    canImport: false,
    // 「限制账号功能」抽屉（ban-sheet 组件）
    banSheet: { visible: false, user: null, busy: false },
    // ===== 批量操作模式 =====
    // 刻意**默认关闭**：常态是「看人 → 点进详情」，选择框常驻会让每行多占一块且容易误触删除。
    batchMode: false,
    // 已选 id → 展示名（用对象而不是数组：翻页追加 / 取消勾选都是 O(1)，且能带名字给确认弹窗）
    selected: {},
    selectedCount: 0,
    // 全选只作用于「当前已加载的列表」——筛选出 2600 人时不该让人以为全选了整个库
    allChecked: false,
    batchBusy: false,
    // ===== 批量转移抽屉 =====
    // 刻意**不用 wx.showModal 的 editable 输入框**（用户 2026-10-21「在转移中应该是多级而不是
    // 点击后出现一个弹窗进行输入」）：自由文本能凭空造出一个不存在的院校名，
    // 且与「组织架构只能由有权限的人更改」冲突。改成按组织架构级联选。
    // mode: 'full' 四级都可选 / 'school' 只选院校（一键转院校，两校区系部与专业同名时用）
    transferSheet: { visible: false, mode: 'full', busy: false },
    transfer: { school: '', department: '', specialty: '', grade: '', gradeLabel: '' },
    transferOptions: { schools: [], departments: [], specialties: [], grades: [] },
    transferIndex: { schools: 0, departments: 0, specialties: 0, grades: 0 },
  },

  onShow() {
    this.refreshPermission();
    this.reload();
    this.loadFilters();
  },

  // ===== 筛选选项 =====
  async loadFilters() {
    try {
      await getApp().ensureLogin();
      const opt = await auth.get('/api/admin/users/filters').catch(() => null);
      if (!opt) return; // 无 user.view 以外权限等
      // 院校选项 = 平铺数组 ∪ 树的院校节点：组织架构里配了但还没有用户的院校（如刚建好的校区）
      // 只存在于 tree 里，只取平铺数组会选不到。
      const treeByName = new Map((opt.tree || []).map((s) => [String(s.name), s]));
      const schoolNames = [...new Set([...(opt.schools || []).map(String), ...treeByName.keys()])];
      const schools = schoolNames
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
        .map((name) => ({ label: name, value: name }));
      // 平铺数组留着做兜底数据源（旧服务端没有 tree 时全靠它，退化为不联动而不是空下拉）
      const flat = {
        departments: toOptions(opt.departments),
        specialties: toOptions(opt.specialties),
      };
      const linked = resolveFilterOptions(opt.tree, this.data.filters, flat);
      // ⚠️ 这里只存**不带人数**的基础选项；人数一律由 renderFilterOptions 用服务端 facets 装饰。
      // 旧实现在此处把 /filters 的**整库全量**人数拼进 label（「计财系（1424）」），
      // 于是选了别的条件数字也不变 —— 用户 2026-10-21 报的就是这个。
      // 班级状态 / 身份仍用 /filters 的**选项列表**（值与文案，服务端可能新增取值），
      // 只是不再用它自带的人数。
      // 与改造前**完全一致**的选项集合（只去掉人数）：
      // 服务端给了列表 → 前面补「全部」；没给 → 用静态兜底（兜底数组本身已含「全部」，不能重复补）。
      const plain = (list, fallback) =>
        Array.isArray(list) && list.length
          ? [ALL_OPTION, ...list.map((x) => ({ label: String(x.label), value: String(x.value) }))]
          : fallback.map((o) => ({ label: o.label, value: o.value }));
      this.setData({
        filterTree: opt.tree || [],
        filterFlat: flat,
        filterBase: {
          schools: withAll(schools),
          departments: linked.departments,
          specialties: linked.specialties,
          // 年级展示为「2024级」，筛选值仍是年份；年级不参与联动，保持全量。
          // 刻意**不加**「全部」项（与改造前一致）：年级靠「清除筛选」整体复位。
          grades: (opt.grades || []).map((v) => ({ label: `${v}级`, value: String(v) })),
          classStatus: plain(opt.classStatuses, CLASS_STATUS_OPTIONS),
          identity: plain(opt.identities, IDENTITY_OPTIONS),
        },
      });
      this.renderFilterOptions();
      // 选项是异步到的：若此时已有筛选值（如从详情页返回、onShow 重新拉选项），
      // 触发器可能还停在旧结果上，重算一次才能显示成选项 label（2025级）。
      this.updateFilterState();
    } catch (e) {
      /* 筛选项加载失败不阻塞列表 */
    }
  },

  // 按当前已选院校 / 系部重算「系部 / 专业」选项（纯内存收窄，不发请求）
  applyFilterLinkage() {
    const linked = resolveFilterOptions(this.data.filterTree, this.data.filters, this.data.filterFlat);
    this.setData({
      'filterBase.departments': linked.departments,
      'filterBase.specialties': linked.specialties,
    });
    this.renderFilterOptions();
  },

  /**
   * 把「基础选项 + 实时人数」合成最终 label（**唯一**装饰出口）。
   * 用户 2026-10-21「括号中的人数要根据筛选实时计算才对」：
   * 旧实现的数字来自 buildFilterTree 的整库全量，选了别的条件也不变 → 点进去对不上。
   * 现在数字由列表接口随结果一起返回（facets），与列表同时刻、同口径。
   * facets 为 null（选了日/周目标，服务端刻意不算）或还没到货时 → **不显示括号**，
   * 宁可没有数字，也不给一个对不上的数字。
   */
  renderFilterOptions() {
    const base = this.data.filterBase || {};
    const f = this.data.facetCounts;
    const dec = (list, counts, toValue) => (list || []).map((o) => {
      if (!counts) return { label: o.label, value: o.value };
      const n = counts[toValue ? toValue(o) : o.value];
      return { label: n ? `${o.label}（${n}）` : o.label, value: o.value };
    });
    this.setData({
      filterOptions: {
        ...this.data.filterOptions,
        schools: dec(base.schools, f && f.school),
        departments: dec(base.departments, f && f.department),
        specialties: dec(base.specialties, f && f.specialty),
        // 年级选项 value 是「2025」、服务端计数键也是「2025」，直接对得上
        grades: dec(base.grades, f && f.grade),
        classStatus: dec(base.classStatus, f && f.classStatus),
        identity: dec(base.identity, f && f.identity),
      },
    });
    // label 变了，触发器标题也要跟着重算（它取的是选项 label）
    this.setData({ filterLabels: this.computeFilterLabels() });
  },

  // 下拉触发器的标题：未选 = 维度名（院校/年级…），已选 = 选中项的 label（2025级/计财系…）。
  // ⚠️ 必须自己算：TDesign 的菜单条渲染的是 `label || computedLabel`
  //   （dropdown-menu.js::getAllItems），我们一直传静态 label="年级"，
  //   非空就把组件自己算的 computedLabel 永久盖住了 —— 于是选完仍显示「年级」，
  //   用户只能靠选项上的勾判断生效没有（用户 2026-10-21「筛选选择后应该显示一下」）。
  // 维度名在已选时让位给值：一行三列、每列约 190rpx，「年级 2025级」放不下；
  // 完整「维度 + 值」由面板底部摘要条（filterSummary）与工具栏角标兜住。
  computeFilterLabels() {
    const { filters, filterOptions } = this.data;
    const out = {};
    for (const k of Object.keys(FILTER_LABELS)) {
      // 显式判空而不是 `|| ''`：日/周目标的「未达标」value 是 '0'，
      // 万一哪天存成数字 0，`0 || ''` 会让它显示回维度名（筛选生效了但看不出来）。
      const raw = filters[k];
      const value = raw === null || raw === undefined || raw === '' ? '' : String(raw);
      if (!value) {
        out[k] = FILTER_LABELS[k];
        continue;
      }
      // 选项数组键走显式映射表（grade→grades 这类复数键漏了不会报错，只会静默显示原始 value）
      const list = filterOptions[FILTER_OPTION_KEYS[k]] || [];
      const hit = list.find((o) => String(o.value) === value);
      // 去掉「（2679）」人数尾巴：选项里带人数是有用的，但触发器每列只有约 190rpx，
      // 「冶金材料系（535）」这种放不下（与 packageAdmin/class-manage 的 short 同一口径）。
      out[k] = ((hit && hit.label) || value).replace(/（[^（）]*）$/, '');
    }
    return out;
  },

  updateFilterState() {
    const f = this.data.filters;
    const summary = [];
    for (const k of Object.keys(FILTER_LABELS)) {
      if (!f[k]) continue;
      if (k === 'dailyAchieved' || k === 'weeklyAchieved') {
        summary.push(`${FILTER_LABELS[k]} ${ACHIEVE_TEXT[f[k]] || ''}`);
        continue;
      }
      if (k === 'classStatus') {
        summary.push(`${FILTER_LABELS[k]} ${CLASS_STATUS_TEXT[f[k]] || ''}`);
        continue;
      }
      if (k === 'identity') {
        summary.push(`${FILTER_LABELS[k]} ${IDENTITY_TEXT[f[k]] || ''}`);
        continue;
      }
      summary.push(`${FILTER_LABELS[k]} ${f[k]}`);
    }
    if (this.data.status === 'active') summary.push('状态 正常');
    if (this.data.status === 'banned') summary.push('状态 封禁');
    if (this.data.roleTab !== 'all') summary.push(`分类 ${ROLE_TAB_LABELS[this.data.roleTab]}`);
    if (this.data.keyword) summary.push(`关键词「${this.data.keyword}」`);
    this.setData({
      hasActiveFilter: summary.length > 0,
      filterCount: summary.length,
      filterSummary: summary.join(' · '),
      filterLabels: this.computeFilterLabels(),
    });
  },

  // 展开 / 收起筛选面板
  toggleFilters() {
    this.setData({ showFilters: !this.data.showFilters });
  },

  // 清除筛选：同时复位联动状态 —— 系部/专业回到「全部院校」下的全量选项，再按全空过滤条件重算一次
  clearFilters() {
    const empty = {
      school: '',
      department: '',
      specialty: '',
      grade: '',
      dailyAchieved: '',
      weeklyAchieved: '',
      classStatus: '',
      identity: '',
    };
    this.setData({
      filters: empty,
      keyword: '',
      status: '',
      role: '',
      manager: '',
      roleTab: 'all',
    });
    // 摘要三件套（hasActiveFilter / filterCount / filterSummary）与触发器标题（filterLabels）
    // **一律交给 updateFilterState 算**，不在这里手写：手写就会漏掉 filterLabels，
    // 出现「筛选已清除、下拉却还显示 2025级」（同一份状态两处计算必然漂移）。
    this.updateFilterState();
    this.applyFilterLinkage();
    this.reload();
  },

  // 任一下拉变化：先写回 filter，再按发生变化的层级复位下级并重建选项
  // 院校 → 系部（重置系部与专业）；系部 → 专业（重置专业）；选「全部」→ 下级恢复全量；
  // 年级 / 达标情况与这三层正交，不触发任何联动。
  onDropdownChange(e) {
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value || '';
    const patch = { [`filters.${key}`]: value };
    if (key === 'school') {
      patch['filters.department'] = '';
      patch['filters.specialty'] = '';
    } else if (key === 'department') {
      patch['filters.specialty'] = '';
    }
    this.setData(patch);
    if (key === 'school' || key === 'department') this.applyFilterLinkage();
    this.updateFilterState();
    this.reload();
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value || '' });
    this.updateFilterState();
    this.reload();
  },

  onClear() {
    this.setData({ keyword: '' });
    this.reload();
  },

  filterStatus(e) {
    const status = e.currentTarget.dataset.status;
    this.setData({ status: this.data.status === status ? '' : status });
    this.updateFilterState();
    this.reload();
  },

  // 分类 Tab：'' 全部 / student 学生 / teacher 教师 / manager 管理员（按权限）
  switchTab(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.roleTab) return;
    const patch = { roleTab: key, role: '', manager: '' };
    if (key === 'student' || key === 'teacher') patch.role = key;
    if (key === 'manager') patch.manager = '1';
    this.setData(patch);
    this.updateFilterState();
    this.reload();
  },

  buildQuery(extra = {}) {
    const { keyword, status, role, manager, filters } = this.data;
    const q = { ...extra };
    if (keyword) q.keyword = keyword;
    if (status) q.status = status;
    if (role) q.role = role;
    if (manager) q.manager = manager;
    for (const k of ['school', 'department', 'specialty', 'grade', 'dailyAchieved', 'weeklyAchieved', 'classStatus', 'identity']) {
      if (filters[k]) q[k] = filters[k];
    }
    return q;
  },

  async reload() {
    this.setData({ page: 1, list: [] });
    await this.load();
  },

  async load() {
    const { page, limit, loading } = this.data;
    if (loading) return;
    this.setData({ loading: page === 1, loadingMore: page > 1 });
    try {
      await getApp().ensureLogin();
      const me = getApp().globalData.userInfo;
      if (me && !this.data.canManage) this.setData({ canManage: !!me.isManager });
      // withFacets 只在第一页要：page>1 是 onReachBottom 翻页，筛选条件没变，
      // 重算六个维度的计数纯属浪费（服务端按同一标记跳过）。
      const q = this.buildQuery({ page, limit });
      if (page === 1) q.withFacets = '1';
      const res = await auth.get('/api/admin/users', q);
      // 实时人数随列表一起到（同一次请求 → 与列表结果同时刻同口径）。
      // 判 `!== undefined` 而不是 `'facets' in res`：服务端没算时该键经 JSON 序列化会被丢掉，
      // 但内存对象里可能仍是 undefined —— 用 in 会把「这次没要」（翻页）误判成「刻意不计数」，
      // 从而在翻页时把已有数字清空。
      // null = 服务端刻意不计数（选了日/周目标）→ 不显示括号。
      const withCounts = res.facets !== undefined;
      const list = res.list.map((u) => {
        // 先算出 isSuper 再生成滑动按钮：buildSwipeButtons 依赖 isSuper，
        // 直接把原始 u 传进去会让超管的「封禁/删除」也出现（u.isSuper 为 undefined）
        const item = { ...u, isSuper: (u.permissionGroups || []).includes('superadmin') };
        // 生效中的限制（限制登录 / 微信同步 / GPS）：
        // activeScopes 既给「限制」标签用，也给左滑的「解除」按钮判定用（hasActiveRestriction）。
        // 标签文案不再单独存 scopeLabels —— 它已并入下面的 chips 统一渲染。
        item.activeScopes = activeScopes(item);
        // 展示字段：WXML 不做表达式拼接，这里预计算好
        item.nameText = u.account || u.nickname || u.realName || '未命名';
        item.initial = item.nameText.charAt(0);
        item.isTeacher = u.role === 'teacher';
        if (item.isTeacher) {
          // 教师无学号/班级/目标，展示所属院系
          item.deptText = [u.departmentName, u.schoolName].filter(Boolean).join(' · ');
        } else {
          // 宿舍（dorm_assignments 在住记录，列表接口按本页 openid 一次批量补，无 N+1）：
          // 未分配不显示（空 roomText 就留空），避免一屏「宿舍 未分配」噪音
          const dr = u.dorm || null;
          item.dormText = (dr && dr.roomText) || '';
          item.dormBedText = dr && dr.bedNo ? ` ${dr.bedNo} 床` : '';
        }
        // ===== 行上标签：一行内**只用一套**标签体系 =====
        // 以前「管理员/教师/限制」用 t-tag、「班级状态/班委/班主任/学生会」用 .users-chip，
        // 两者字号、内距、圆角、高度都不同，并排就是用户截图里那种错位感。
        // 现在全部走 .users-chip（也才能一起参与 layoutChips 的宽度预算与折叠）。
        //
        // 配色刻意避开 primary：本仓库把 TDesign 的 primary 整套换成了品牌橙
        //（--td-primary-color-7 = #ff6b00 = --tt-brand），用它当「班委」色会和「实习」撞色
        //（底色 --td-primary-color-1 = #fff4ec = --tt-brand-soft，完全相同）。
        const chips = [];
        // 示例账户标签放最前：管理员扫一眼就知道这条不是真实学生/教师，
        // 不会拿它去核对学籍、也不会误当成「数据异常」处理（用户 2026-10-24）。
        if (item.isDemo) chips.push({ text: '示例', cls: 'demo' });
        if (item.isSuper) chips.push({ text: '管理员', cls: 'role' });
        else if (item.isTeacher) chips.push({ text: '教师', cls: 'neutral' });
        // 生效中的限制放在状态类之前：它是管理员最需要立刻看到的（可操作信号）
        item.activeScopes.forEach((s) => chips.push({ text: SCOPE_LABELS[s], cls: 'danger' }));
        // 班级状态只给实习/毕业加标签：全校 54 个班里 45 个是正常，
        // 给正常也打标签等于没打（一屏全是灰点，反而看不出谁特殊）。
        if (item.classStatus && item.classStatus !== 'normal') {
          chips.push({ text: u.classStatusText || CLASS_STATUS_TEXT[item.classStatus], cls: CLASS_STATUS_CHIP[item.classStatus] || 'neutral' });
        }
        if (item.isClassOfficer) chips.push({ text: '班委', cls: 'info' });
        if (item.isTeacher && item.homeroomClasses && item.homeroomClasses.length) {
          // 「班主任4班」会被读成「4 班」这个班名（用户就是因此发问），改成「班主任·4个班」
          chips.push({ text: item.homeroomClasses.length > 1 ? `班主任·${item.homeroomClasses.length}个班` : '班主任', cls: 'info' });
        }
        if (item.isUnionMember) {
          chips.push({ text: unionChipText(u.unionRoles), cls: 'union', more: item.unionMore || 0 });
        }
        // 单行排版：超预算的标签折叠成 +N（用户截图：长标签被 flex-wrap 甩到第二行）
        item.chips = layoutChips(chips, item.nameText);
        item.chipTotal = chips.length;
        // 元信息合并成一行（紧凑排版的关键：不再学号/班级/宿舍/目标各占一行）。
        // 刻意**不带「学号」「宿舍」前缀**：一行 532rpx 装不下「前缀+四项」，
        // 加前缀就只能靠 ellipsis 截断，而截断等于把宿舍/目标从管理员眼前**弄丢**（比换行更糟）。
        // 去掉前缀后靠格式即可辨识：10 位数字=学号、含「级」=班级、含「楼」=宿舍。
        const meta = [];
        if (item.isTeacher) {
          if (item.deptText) meta.push(item.deptText);
        } else {
          meta.push(u.studentId || '无学号');
          meta.push(u.className || '未分班');
          if (item.dormText) meta.push(`${item.dormText}${item.dormBedText}`);
          // 「默认目标」对管理员没有信息量（全校大多数人都是它），只在有个人计划时显示
          if (u.goal && u.goal.planName) meta.push(u.goal.planName);
        }
        item.metaText = meta.join(' · ');
        item.swipeRight = this.buildSwipeButtons(item);
        return item;
      });
      // 触底加载下一页：拼在已有列表后面（不能整体覆盖，否则翻页会冲掉前面的数据）
      this.setData({ list: [...this.data.list, ...list], total: res.total });
      if (withCounts) {
        this.setData({ facetCounts: res.facets || null });
        this.renderFilterOptions();
      }
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false, loadingMore: false });
    }
  },

  // 每行滑动按钮（对象里带 uid/type 供回调分发）
  // 「详细」改为点击卡片进入；封禁改为打开「限制账号功能」抽屉（可选类型 + 时长）
  buildSwipeButtons(u) {
    const id = u._id;
    const btns = [];
    // 左滑动作也按写权限构建（用户 2026-10-22「用户管理中的操作」不该给只读账号）：
    //   编辑 / 删除 → permission.manage（账户编辑页与服务端 DELETE 都是这个权限）
    //   限制 / 解除 → user.manage
    if (this.data.canPerms) btns.push({ text: '编辑', type: 'edit', uid: id, style: BTN_STYLE.edit });
    if (this.data.canManage && !u.isSuper) {
      btns.push({ text: '限制', type: 'ban', uid: id, nickname: u.nickname || u.realName, style: BTN_STYLE.ban });
    }
    if (this.data.canManage && (u.status === 'banned' || hasActiveRestriction(u))) {
      btns.push({ text: '解除', type: 'unban', uid: id, style: BTN_STYLE.unban });
    }
    if (this.data.canPerms && !u.isSuper) {
      btns.push({ text: '删除', type: 'del', uid: id, nickname: u.nickname || u.realName, style: BTN_STYLE.del });
    }
    return btns;
  },

  // 打开「限制账号功能」抽屉
  openBanSheet(uid) {
    const u = (this.data.list || []).find((x) => x._id === uid);
    if (!u) return;
    this.setData({
      banSheet: {
        visible: true,
        user: { _id: u._id, account: u.account || u.nickname || u.realName || '' },
        busy: false,
      },
    });
  },

  onBanSheetClose() {
    this.setData({ 'banSheet.visible': false });
  },

  // 提交限制：类型（登录/微信同步/GPS）+ 时长（>0 天 / 0 = 永久）
  async onBanSubmit(e) {
    const id = this.data.banSheet.user && this.data.banSheet.user._id;
    if (!id) return;
    const { scope, days, reason } = e.detail || {};
    this.setData({ 'banSheet.busy': true });
    try {
      await auth.post(`/api/admin/users/${id}/ban`, {
        scope,
        days,
        reason: reason || '违反社区规范',
      });
      const text = { login: '限制登录', sync: '限制微信同步', gps: '限制 GPS' }[scope] || '已限制';
      wx.showToast({ title: `${text}${days > 0 ? ' ' + days + ' 天' : '（永久）'}`, icon: 'none' });
      this.setData({ 'banSheet.visible': false });
      this.reload();
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' });
    } finally {
      this.setData({ 'banSheet.busy': false });
    }
  },

  // 解除限制：可选按类型解除或全部解除
  onUnban(uid) {
    const that = this;
    wx.showActionSheet({
      itemList: ['全部解除', '解除限制登录', '解除微信同步限制', '解除 GPS 限制'],
      success: async (r) => {
        const scope = ['all', 'login', 'sync', 'gps'][r.tapIndex];
        try {
          const res = await auth.post(`/api/admin/users/${uid}/unban`, { scope });
          wx.showToast({
            title: res && res.lifted && res.lifted.length ? '已解除' : '该类型当前无生效限制',
            icon: 'none',
          });
          that.reload();
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' });
        }
      },
    });
  },

  // 点击整行：批量模式 = 勾选，否则进详情（手机端主操作路径，不必先左滑）
  onRowTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    if (this.data.batchMode) {
      this.onCheckOne(e);
      return;
    }
    wx.navigateTo({ url: `/packageAdmin/user-detail/user-detail?id=${id}` });
  },

  // 滑动按钮点击分发
  async onSwipeAction(e) {
    const act = e.detail || {};
    if (act.type === 'edit') {
      wx.navigateTo({ url: `/packageAdmin/users/account-edit/account-edit?id=${act.uid}` });
      return;
    }
    if (act.type === 'detail') {
      wx.navigateTo({ url: `/packageAdmin/user-detail/user-detail?id=${act.uid}` });
      return;
    }
    if (act.type === 'ban') {
      this.openBanSheet(act.uid);
      return;
    }
    if (act.type === 'unban') {
      this.onUnban(act.uid);
      return;
    }
    if (act.type === 'del') {
      const that = this;
      wx.showModal({
        title: '删除用户',
        content: '将删除该用户及其全部运动/饮水/徽章等数据，不可恢复！确认删除？',
        confirmColor: '#d54941',
        success: async (res) => {
          if (!res.confirm) return;
          try {
            await auth.del(`/api/admin/users/${act.uid}`);
            wx.showToast({ title: '已删除', icon: 'success' });
            that.reload();
          } catch (err) {
            wx.showToast({ title: err.message, icon: 'none' });
          }
        },
      });
    }
  },

  // ===== 批量操作 =====
  // 进入/退出批量模式：退出时清空选择（避免「以为没选，实际还选着」就误点动作）
  toggleBatchMode() {
    const next = !this.data.batchMode;
    this.setData({ batchMode: next, selected: {}, selectedCount: 0, allChecked: false });
  },

  // 勾选单个（selected 是 id → name 的对象，翻页追加与取消都是 O(1)）
  onCheckOne(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name || '';
    if (!id) return;
    const selected = { ...this.data.selected };
    if (selected[id]) delete selected[id];
    else selected[id] = name;
    this.syncSelection(selected);
  },

  // 全选/取消全选：只作用于**当前已加载**的列表，并在文案里写清楚（不谎称选中整个筛选结果）
  toggleCheckAll() {
    const list = this.data.list || [];
    if (!list.length) return;
    if (this.data.allChecked) {
      this.syncSelection({});
      return;
    }
    const selected = {};
    for (const u of list) selected[u._id] = u.nameText || '';
    this.syncSelection(selected);
  },

  syncSelection(selected) {
    const n = Object.keys(selected).length;
    const listLen = (this.data.list || []).length;
    this.setData({
      selected,
      selectedCount: n,
      allChecked: n > 0 && listLen > 0 && n >= listLen,
    });
  },

  // 批量动作分发：删除 / 转移这类需要额外输入或强确认的，各自走独立弹窗
  onBatchAction(e) {
    const action = e.currentTarget.dataset.action;
    const ids = Object.keys(this.data.selected);
    if (!ids.length) {
      wx.showToast({ title: '请先选择用户', icon: 'none' });
      return;
    }
    if (this.data.batchBusy) return;
    // 转移走级联抽屉（需要用户先选目标），不在这里直接发请求
    if (action === 'transfer') return this.openBatchTransfer(e);
    if (action === 'delete') return this.confirmBatchDelete(ids);
    if (action === 'ban') return this.promptBatchBan(ids);
    if (action === 'officer') return this.runBatch({ action, ids, body: { isClassOfficer: true } });
    if (action === 'unofficer') return this.runBatch({ action: 'officer', ids, body: { isClassOfficer: false } });
    if (action === 'unban') return this.runBatch({ action, ids, body: { scope: 'all' } });
    if (action === 'reset-password') return this.runBatch({ action, ids, body: {} });
    // ⚠️ 未知 action **绝不落到默认分支发请求**：以前这里是 `return this.runBatch({action, ...})`，
    // 新增一个动作却忘了加分支，就会带着空 body 打到服务端（比如 transfer 变成「什么都不改」的假成功）。
    // 宁可提示不支持，也不发一个自己没想清楚的请求。
    wx.showToast({ title: `暂不支持的操作：${action || '（空）'}`, icon: 'none' });
  },

  // 删除是不可恢复的：确认弹窗里明确列出人数与「会连带删除的数据」
  confirmBatchDelete(ids) {
    const that = this;
    wx.showModal({
      title: `批量删除 ${ids.length} 个账号`,
      content: '将删除这些用户及其运动 / 饮水 / 徽章 / 申诉等全部数据，且不可恢复！\n超级管理员账号会被自动跳过。确认继续？',
      confirmText: '确认删除',
      confirmColor: '#d54941',
      success: (r) => {
        if (r.confirm) that.runBatch({ action: 'delete', ids, body: {} });
      },
    });
  },

  // 批量限制：复用 ban-sheet 的字段语义（scope + days + reason），这里用 actionSheet + 一次输入
  promptBatchBan(ids) {
    const that = this;
    wx.showActionSheet({
      itemList: ['限制登录', '限制微信同步', '限制 GPS 实跑'],
      success: (r) => {
        const scope = ['login', 'sync', 'gps'][r.tapIndex];
        wx.showModal({
          title: '限制时长（天）',
          editable: true,
          placeholderText: '输入天数，填 0 表示永久',
          success: async (m) => {
            if (!m.confirm) return;
            const days = Number((m.content || '').trim()) || 0;
            await that.runBatch({ action: 'ban', ids, body: { scope, days, reason: '批量限制' } });
          },
        });
      },
      fail: () => {},
    });
  },

  // ===== 批量转移：按组织架构级联选择（用户 2026-10-21）=====
  // 旧实现是 wx.showModal(editable) 让管理员**手打**院校/系部/专业名 —— 两个问题：
  //   ① 打错一个字就把学生变成一个不存在的院校（筛选、班超分组全对不上）；
  //   ② 组织架构只应由有 content.manage 权限的人维护，这里等于开了后门。
  // 现在选项只来自 filterTree（组织架构），每级按上级收窄；每级首项「不修改」= 不传该字段。
  KEEP: '不修改',

  openBatchTransfer(e) {
    const ids = Object.keys(this.data.selected);
    if (!ids.length) {
      wx.showToast({ title: '请先选择用户', icon: 'none' });
      return;
    }
    if (this.data.batchBusy) return;
    const mode = (e && e.currentTarget && e.currentTarget.dataset.mode) === 'school' ? 'school' : 'full';
    if (!(this.data.filterTree || []).length) {
      wx.showToast({ title: '组织架构还没配置，无法级联选择', icon: 'none' });
      return;
    }
    this.setData({
      transferSheet: { visible: true, mode, busy: false },
      transfer: { school: '', department: '', specialty: '', grade: '', gradeLabel: '' },
    });
    this.buildTransferOptions();
  },

  // 级联选项：院校 → 系部 → 专业（与账户编辑页同一口径，数据源 filterTree）
  buildTransferOptions() {
    const t = this.data.transfer;
    const tree = this.data.filterTree || [];
    const schoolNode = tree.find((s) => s.name === t.school) || null;
    const deptNode = schoolNode ? (schoolNode.children || []).find((d) => d.name === t.department) : null;
    const names = (list) => (list || []).map((x) => x.name);
    // 首项「不修改」= 该字段不提交（服务端 undefined 分支保持原值）
    const withKeep = (list) => [{ label: this.KEEP, value: '' }, ...list.map((n) => ({ label: n, value: n }))];

    const opts = {
      schools: withKeep(names(tree)),
      departments: withKeep(schoolNode ? names(schoolNode.children) : []),
      specialties: withKeep(deptNode ? names(deptNode.children) : []),
      // 年级选项已是 {label:'2025级', value:'2025'}，直接复用（别用 value 重建，会丢「级」字）
      grades: [{ label: this.KEEP, value: '' }, ...(this.data.filterOptions.grades || [])],
    };
    const idxOf = (list, v) => Math.max(0, list.findIndex((o) => o.value === (v || '')));
    this.setData({
      transferOptions: opts,
      transferIndex: {
        schools: idxOf(opts.schools, t.school),
        departments: idxOf(opts.departments, t.department),
        specialties: idxOf(opts.specialties, t.specialty),
        grades: idxOf(opts.grades, t.grade),
      },
    });
  },

  // 选上级 → 写值并清空下级（换校区后旧系部/专业不一定成立）
  onTransferPick(e) {
    const level = e.currentTarget.dataset.level;
    const listKey = { school: 'schools', department: 'departments', specialty: 'specialties', grade: 'grades' }[level];
    const opt = this.data.transferOptions[listKey][Number(e.detail.value) || 0];
    const value = opt ? opt.value : '';
    const patch = { [`transfer.${level}`]: value };
    // 年级的 value 是「2025」、label 是「2025级」：picker 显示必须用 label，
    // 否则回填成裸年份（与筛选触发器同一类错误，见 computeFilterLabels）。
    if (level === 'grade') patch['transfer.gradeLabel'] = value ? (opt && opt.label) || value : '';
    if (level === 'school') { patch['transfer.department'] = ''; patch['transfer.specialty'] = ''; }
    if (level === 'department') patch['transfer.specialty'] = '';
    this.setData(patch);
    this.buildTransferOptions();
  },

  closeTransferSheet() {
    this.setData({ 'transferSheet.visible': false });
  },

  async submitTransfer() {
    const ids = Object.keys(this.data.selected);
    const t = this.data.transfer;
    const body = {};
    if (t.school) body.school = t.school;
    if (t.department) body.department = t.department;
    if (t.specialty) body.specialty = t.specialty;
    if (t.grade) body.grade = t.grade;
    if (!Object.keys(body).length) {
      wx.showToast({ title: '每一项都是「不修改」，没有要改的', icon: 'none' });
      return;
    }
    this.setData({ 'transferSheet.busy': true });
    try {
      await this.runBatch({ action: 'transfer', ids, body });
      this.setData({ 'transferSheet.visible': false });
    } finally {
      this.setData({ 'transferSheet.busy': false });
    }
  },

  // 真正发请求：结果如实回报「成功 N / 失败 M / 未找到 K」，半成功绝不只弹一句「已完成」
  async runBatch({ action, ids, body }) {
    this.setData({ batchBusy: true });
    wx.showLoading({ title: '处理中…', mask: true });
    try {
      const res = await auth.post('/api/admin/users/batch', { ids, action, ...body });
      wx.hideLoading();
      const done = (res && res.done) || [];
      const failed = (res && res.failed) || [];
      const missing = (res && res.missing) || [];
      const parts = [`成功 ${done.length}`];
      if (failed.length) parts.push(`失败 ${failed.length}`);
      if (missing.length) parts.push(`未找到 ${missing.length}`);
      const firstFail = failed[0];
      wx.showModal({
        title: `${res.label || '批量操作'}完成`,
        content: parts.join(' · ') + (firstFail ? `\n示例失败原因：${firstFail.reason}` : ''),
        showCancel: false,
      });
      this.setData({ selected: {}, selectedCount: 0, allChecked: false });
      this.reload();
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '批量操作失败', icon: 'none' });
    } finally {
      this.setData({ batchBusy: false });
    }
  },

  onReachBottom() {
    if (this.data.list.length < this.data.total) {
      this.setData({ page: this.data.page + 1 });
      this.load();
    }
  },

  goImport() {
    wx.navigateTo({ url: '/packageAdmin/users/import' });
  },

  // 创建账户：独立页面填写（注意是两级目录，路径必须写全）
  goCreateAccount() {
    wx.navigateTo({ url: '/packageAdmin/users/account-edit/account-edit' });
  },
});
