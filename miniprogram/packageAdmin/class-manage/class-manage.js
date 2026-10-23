// 班级管理（管理员视角）：全校所有班级的台账与跑操设置
//
// 命名口径（用户明确）：
//   · 「班级管理」= **管理员管所有班级**（本页）：早操 / 早八 / 校园跑标记、应到与住宿人数、从学籍同步；
//   · 「我的班级」= **教师（班主任）/ 班委管自己名下的班**，页面是 /packageAdmin/class/class
//     （该页页面名与入口名都叫「我的班级」；页内第三个 tab 叫「班超联赛」——
//      原「班级考勤」按用户要求改名，且已并入原班超详细页的内容）。
//   两者是同一套 class_profiles 台账的两个视角，权限模型不同：
//   本页走 requirePermission('class.view' / 'class.manage')，教师那页走成员资格校验。
//
// 为什么从「学生会配置」里拆出来单独成页：班级台账管的是**全校所有班**，
// 与学生会（部门、检查模块）不是一回事；混在一起会让管理员找不到地方改「哪个班不跑操」。
const auth = require('../../utils/request');

// 筛选：与服务端 GET /api/admin/class/profiles 的参数一一对应
const FILTERS = [
  { key: '', label: '全部标记' },
  { key: 'noExercise', label: '只看无早操' },
  { key: 'noClass', label: '只看无早八' },
  // 晚自习（用户 2026-10-21）：与无早操/无早八同一套筛选口径
  { key: 'noNightStudy', label: '只看无晚自习' },
  { key: 'noRun', label: '只看不参跑' },
];

// 班级状态筛选：正常 / 实习 / 毕业（缺省 = 正常）
const STATUS_FILTERS = [
  { key: '', label: '全部状态' },
  { key: 'normal', label: '只显示正常班' },
  { key: 'intern', label: '只显示实习班' },
  { key: 'graduated', label: '只显示毕业班' },
];

// 状态文案与说明（与 models/class-profile.js::STATUS_TEXT 同口径，前端只做展示）
const STATUS_TEXT = { normal: '正常', intern: '实习', graduated: '毕业' };
const STATUS_HINT = {
  normal: '',
  intern: '实习中：学生可登录，但不参加任何班超检查与校园跑统计',
  graduated: '已毕业：学生不可登录，且不参加任何班超检查与校园跑统计',
};

// 卫生区类型标签（与服务端 /api/admin/union/areas 的 areaTypes 同一套 key）
const AREA_TYPES = {
  classroom: '教室区',
  outdoor: '室外区',
  corridor: '楼道',
  canteen: '食堂',
  other: '其他',
};

const PAGE_SIZE = 20;

// 四个开关的展示文案（点一下取反；文案要说清「影响什么」，否则管理员不敢点）
// 晚自习（用户 2026-10-21「部分班级是没有晚自习的所以不涉及考勤」）与早操/早八完全同构。
const FLAG_LABELS = {
  hasMorningExercise: { on: '有早操', off: '无早操', short: '早操', actionOn: '设为无早操', actionOff: '设为有早操' },
  hasMorningClass: { on: '有早八', off: '无早八', short: '早八', actionOn: '设为无早八', actionOff: '设为有早八' },
  hasNightStudy: { on: '有晚自习', off: '无晚自习', short: '晚自习', actionOn: '设为无晚自习', actionOff: '设为有晚自习' },
  hasMorningRun: { on: '参跑', off: '不参跑', short: '参跑', actionOn: '设为不参跑', actionOff: '设为参跑' },
};

Page({
  // 权限重算（用户 2026-10-22「登录账户时一定要刷新缓存」）：
  // 换账号登录后页面 data 里的 canManage 可能还是上一个身份的结论 ——
  // 表现就是「只读账号仍看到操作按钮」。onShow 与登录回调都会调这里。
  refreshPermission() {
    const user = getApp().globalData.userInfo || {};
    const perms = user.effectivePermissions || [];
    this.setData({ canManage: perms.includes('*') || perms.includes('class.manage') });
  },

  data: {
    loading: true,
    canManage: false,
    list: [],
    // 教学用楼楼名清单（系统设置里维护）：填教室时先选楼名再填门号。
    // 空数组 = 还没配置 → 对话框里给出明确指引（不再退回自由输入，
    // 那等于把「楼名只能选」这条规则作废）。
    teachingBuildings: [],
    // 教室对话框（用户 2026-10-22「尽量使用 Dialog 对话框完整的…一次输入完」）
    roomVisible: false,
    roomValue: '',
    roomSaving: false,
    roomTarget: null, // { id, name }
    total: 0,
    page: 1,
    pagesTotal: 1,
    keyword: '',
    filterOptions: FILTERS,
    filterIndex: 0,
    filter: '',
    // 班级状态筛选（正常 / 实习 / 毕业）
    // 状态默认「正常」：班级管理的主场景就是管在读班级，实习/毕业是低频查看
    statusOptions: STATUS_FILTERS,
    statusIndex: 1,
    statusFilter: 'normal',
    // 批量编辑
    bulkMode: false,
    checkedNames: [],
    checkedCount: 0,
    allPageChecked: false,
    filterCount: 0,
    hasFilter: false,
    syncing: false,
    savingKey: '',
    // 院校 / 系部 / 专业 / 年级筛选：选项由台账接口的 facets 带回（年级库里常为空，服务端按班级名推导，
    // 让管理员手敲年级必然出现「2023 / 23级 / 2023级」三种写法）
    // 组织层级口径与用户管理页一致：院校 = organizations.school，系部 = organizations.department，
    // 专业 = organizations.specialty（台账里也有 specialty 文本值）
    // 联动：院校 → 系部 → 专业（四级筛选的前三级），**年级是正交属性，不参与联动、始终全量**。
    schoolOptions: [],
    schoolIndex: 0,
    schoolKey: '',
    deptOptions: [],
    deptIndex: 0,
    deptKey: '',
    specialtyOptions: [],
    specialtyIndex: 0,
    specialtyKey: '',
    gradeOptions: [],
    gradeIndex: 0,
    gradeKey: '',
    // 院校/系部选项为空时的引导文案（要先「从学籍同步」）—— 空下拉与"没做这功能"看起来一样
    facetHint: '',
    // 专业级为空 / 服务端没给联动树时的**轻量说明**（一行，不当成故障）
    specHint: '',
    // 服务端 facets.tree 缺失（旧服务端 / 异常）：前端退回平铺选项，联动退化为全量
    treeMissing: false,
    // 列表为空时的针对性说明（选中"组织架构配了但暂无班级"的院校时不能只给通用文案）
    emptyReason: '',
    // 卫生区多选抽屉
    areaSheetVisible: false,
    areaSheet: null,
    newAreaName: '',
  },

  onLoad() {
    if (!getApp().requireLogin()) return;
    const user = getApp().globalData.userInfo || {};
    const perms = user.effectivePermissions || [];
    this.setData({ canManage: perms.includes('*') || perms.includes('class.manage') });
    // 教学用楼清单：填教室时先选楼名（用户 2026-10-21），失败不阻断页面
    this.loadBuildings();
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    // 权限先重算再拉数据：换账号登录后 userInfo 变了，页面 data 里的 canManage 还是旧的
    this.refreshPermission();
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

// 权限口径：读 class.view / 写 class.manage（服务端 routes/admin/class-profile.js 校验）。
// 刻意**不走** /api/admin/union/class-profiles —— 那套挂在 union.manage 下，
// 而「改一个班的跑操标记」是班级配置，不该逼学生处额外持有学生会管理权限。
  // 空选项提示：院校 / 系部 / 专业是「组织架构配置 + 从学籍同步」两处带出来的字段
  //（存量台账与纯导入建号的学校都可能是空），不提示的话管理员会以为筛选功能坏了
  // —— 点开下拉只有「全部院校」，与"没做"看不出区别。
  facetHint() {
    const { schoolOptions = [], deptOptions = [], specialtyOptions = [] } = this.data;
    const onlyAll = (list) => list.length <= 1;
    if (onlyAll(schoolOptions) && onlyAll(deptOptions)) {
      return '院校 / 系部筛选暂无选项：可在「组织架构」里配置院校，或点右上「从学籍同步」带出归属';
    }
    if (onlyAll(schoolOptions)) return '院校筛选暂无选项：可在「组织架构」里配置院校，或点右上「从学籍同步」';
    if (onlyAll(deptOptions)) return '系部筛选暂无选项：可在「组织架构」里配置系部，或点右上「从学籍同步」';
    if (onlyAll(specialtyOptions)) return '专业筛选暂无选项：可在「组织架构」里配置专业，或点右上「从学籍同步」带出专业';
    return '';
  },

  // 列表为空时的针对性说明：筛了一个「组织架构里配了但还没有班」的院校/系部/专业时，
  // 通用文案（"没有符合条件的班级"）会让管理员以为筛选坏了 —— 实际是这一层还没班。
  emptyReason() {
    const { list, schoolKey, schoolOptions = [], deptKey, deptOptions = [], specialtyKey, specialtyOptions = [], keyword } = this.data;
    if (list.length || keyword) return '';
    const pick = (opts, key) => (opts || []).find((o) => o.key === key);
    const s = schoolKey ? pick(schoolOptions, schoolKey) : null;
    const d = deptKey ? pick(deptOptions, deptKey) : null;
    const sp = specialtyKey ? pick(specialtyOptions, specialtyKey) : null;
    if (sp && !sp.count) {
      return `「${sp.label}」在组织架构里已配置，但还没有班级台账归属它 —— 点右上角「从学籍同步」把名单里的专业带过来。`;
    }
    if (s && !s.count) {
      return `「${s.label}」在组织架构里已配置，但还没有班级台账归属它 —— 点右上角「从学籍同步」把学生名单里的院校带过来（若名单里也没写，需要先在名单导入时填「学校」列）。`;
    }
    if (d && !d.count) {
      return `「${d.label}」在组织架构里已配置，但还没有班级台账归属它 —— 点右上角「从学籍同步」带出归属。`;
    }
    return '';
  },

  // 「未归入组织架构」兜底节点（服务端 facets.tree 的 key）：它不是一个真实校名，
  // 而是「台账里院校名为空」的行集合。选项 label 必须说清这一点，否则管理员会把它当成一个校区。
  UNASSIGNED_KEY: '__unassigned__',

  // 选项 label 带上「几个班」（沿用上一轮口径）：count=0 的项（组织架构配了但还没有班）
  // 必须能看出来，否则管理员以为筛选坏了。
  withCount(list) {
    return (list || []).map((o) => ({
      ...o,
      label: o.count > 0 ? `${o.label}（${o.count}个班）` : `${o.label}（暂无班级）`,
    }));
  },

  // ===== 联动选项：院校 → 系部 → 专业 =====
  // 数据源是服务端 facets.tree（嵌套，院校下挂系部、系部下挂专业），
  // **降级兜底**：接口没给 tree（旧服务端 / 异常）时退回平铺 facets.departments / specialties，
  // 联动退化为「系部 / 专业 = 全量」，但绝不白屏、绝不空下拉（不能因为一次接口形状变更就整页不可用）。
  //
  // 规则（严格）：
  //   · 选院校 → 系部 = 该校的系部 +「全部系部」，专业 = 该校「全部系部」下的全量专业 +「全部专业」；
  //   · 选系部 → 专业 = 该系部的专业 +「全部专业」；
  //   · 任一级选「全部」→ 下一级恢复全量；
  //   · 年级不参与联动，始终全量。
  buildOptions(facets = {}) {
    const tree = Array.isArray(facets.tree) ? facets.tree : [];
    const treeMissing = !tree.length;
    // 平铺兜底（无 tree 时用它；同时提供「当前院校 / 系部 key → 平铺全量」的映射）
    const flat = {
      schools: facets.schools || [],
      departments: facets.departments || [],
      specialties: facets.specialties || [],
    };
    const schoolTree = new Map(tree.map((s) => [s.key, s]));
    const { schoolKey, deptKey, specialtyKey } = this.data;

    // 第一级院校：树（或平铺）里**去掉**兜底节点，然后固定追加在最后 ——
    // 兜底节点是排查入口，不该排在一个真实校区前面（它通常 count 最大，按 count 排序会霸占首位）。
    const dropUnassigned = (list) => (list || []).filter((o) => o.key !== this.UNASSIGNED_KEY);
    const pickUnassigned = (list) => (list || []).filter((o) => o.key === this.UNASSIGNED_KEY);

    // 二级 / 三级：严格联动，口径与 packageAdmin/users/account-edit 一致（用户 2026-10-20
    // 「希望所有涉及院校、系部、专业的筛选与选择都是联动的」）：
    //   · 未选上级（=「全部」）→ 下级给全量；
    //   · 选了上级且命中 → **只给该上级下的**，命中但为空也保持为空（不退回全量）。
    // 旧实现在这两处都是错的（真实数据实测）：
    //   ① 系部：`schoolTree.get('')` 未命中 → 返回 []，于是「全部院校」时系部下拉**完全没得选**，
    //      与上面注释的承诺、也与专业级的行为都不一致；
    //   ② 专业：命中院校但该校没有专业时 `return flat.specialties` 退回全量 →
    //      选「洋河校区」（真实库里配了院校没配系部）会看到 21 个北校区专业，选了就是跨院校的空筛选。
    // 只有 tree 整体缺失（旧服务端 / 接口异常）才退化成全量，那才是「没有层级信息」。
    const rawDepts = (() => {
      if (treeMissing) return flat.departments;
      if (!schoolKey) return flat.departments; // 未选院校 = 全量
      const s = schoolTree.get(schoolKey);
      return s ? s.departments || [] : flat.departments; // 未命中（如哨兵值）= 无层级信息，给全量
    })();
    // 专业：优先「当前院校 + 当前系部」下的专业；院校已选但系部为「全部」时，
    // 汇总该院校下所有系部的专业（去重合并 count），这样「选了院校还没选系部」也有意义。
    const rawSpecs = (() => {
      if (treeMissing) return flat.specialties;
      if (!schoolKey) return flat.specialties; // 未选院校 = 全量
      const school = schoolTree.get(schoolKey);
      if (!school) return flat.specialties; // 未命中 = 无层级信息，给全量
      if (deptKey) {
        const d = (school.departments || []).find((x) => x.key === deptKey);
        return d ? d.specialties || [] : [];
      }
      const seen = new Map();
      for (const d of school.departments || []) {
        for (const sp of d.specialties || []) {
          const cur = seen.get(sp.key) || { ...sp, count: 0 };
          cur.count += sp.count || 0;
          cur.configured = cur.configured || sp.configured;
          cur.synced = cur.synced || sp.synced;
          seen.set(sp.key, cur);
        }
      }
      // 「院校名在组织架构里但没写系部」的班：专业直接挂在院校节点上（服务端如此建树），要一起显示
      for (const sp of school.specialties || []) {
        const cur = seen.get(sp.key) || { ...sp, count: 0 };
        cur.count += sp.count || 0;
        seen.set(sp.key, cur);
      }
      // 命中了院校但该校确实没有专业 → 返回空（**不再退回全量**，否则就是跨院校泄漏）。
      // 空选项由 specHint 说明「该范围内暂无专业数据」，不会让人以为页面坏了。
      return [...seen.values()];
    })();

    const sortByCount = (list) =>
      [...(list || [])].sort((a, b) => (b.count || 0) - (a.count || 0) || String(a.label).localeCompare(String(b.label), 'zh-Hans-CN'));
    const schools = sortByCount(dropUnassigned(treeMissing ? flat.schools : tree)).concat(pickUnassigned(treeMissing ? flat.schools : tree));
    const departments = sortByCount(rawDepts);
    const specialties = sortByCount(rawSpecs);

    return {
      treeMissing,
      schoolOptions: [{ key: '', label: '全部院校', short: '院校' }].concat(
        this.withCount(schools).map((o) => ({ ...o, short: o.label.replace(/（.*）$/, '') }))
      ),
      deptOptions: [{ key: '', label: '全部系部', short: '系部' }].concat(
        this.withCount(departments).map((o) => ({ ...o, short: o.label.replace(/（.*）$/, '') }))
      ),
      specialtyOptions: [{ key: '', label: '全部专业', short: '专业' }].concat(
        this.withCount(specialties).map((o) => ({ ...o, short: o.label.replace(/（.*）$/, '') }))
      ),
      gradeOptions: [{ key: '', label: '全部年级', short: '年级' }].concat(
        (facets.grades || []).map((g) => ({ ...g, short: g.label }))
      ),
      // 专业级为空时的轻量说明：不显示成故障，只说「这一层还没有数据」以及补数据的地方。
      // 选了院校/系部之后仍然为空才提示（否则全库没有专业时每选一次都弹一行）。
      specHint:
        !specialties.length && !schoolKey
          ? ''
          : !specialties.length
            ? '该范围内暂无专业数据：可在「组织架构」里配置专业，或从学籍同步带出学生专业'
            : '',
    };
  },

  // 把下标对齐回当前值（选项集变化后 picker 的 value 必须仍有对应项，否则显示会漂）
  indexOf(options, key) {
    return Math.max(0, (options || []).findIndex((o) => o.key === key));
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      const data = await auth.get('/api/admin/class/profiles', this.query());
      // 批量勾选跨页保留，但只在批量模式下有意义；退出批量时清空。
      // 必须先算出勾选集合再 decorate —— 否则列表用的还是上一次的 checkedNames，
      // 会出现「已退出批量、卡片却仍是选中色」的残留。
      const checkedNames = this.data.bulkMode ? this.data.checkedNames || [] : [];
      const checkedSet = new Set(checkedNames);
      const list = (data.list || []).map((c) => this.decorate(c, checkedSet));
      const total = data.total || 0;
      const opts = this.buildOptions(data.facets || {});
      // 服务端返回了 tree 但当前选中的院校/系部/专业已不在选项里（如组织架构刚被改）→ 直接退回「全部」，
      // 否则 picker 显示第 0 项（"全部"）却还在按旧值筛选，看起来像筛选失灵。
      const schoolKey = opts.schoolOptions.some((o) => o.key === this.data.schoolKey) ? this.data.schoolKey : '';
      const deptKey = opts.deptOptions.some((o) => o.key === this.data.deptKey) ? this.data.deptKey : '';
      const specialtyKey = opts.specialtyOptions.some((o) => o.key === this.data.specialtyKey) ? this.data.specialtyKey : '';
      const patch = {
        loading: false,
        list,
        checkedNames,
        checkedCount: checkedNames.length,
        total,
        pagesTotal: Math.max(1, Math.ceil(total / PAGE_SIZE)),
        filterCount: this.activeFilterCount(data),
        hasFilter: !!(
        this.data.keyword ||
        this.data.filter ||
        this.data.statusFilter ||
        schoolKey ||
        deptKey ||
        specialtyKey ||
        this.data.gradeKey
      ),
        schoolKey,
        deptKey,
        specialtyKey,
        ...opts,
        treeMissing: opts.treeMissing,
        schoolIndex: this.indexOf(opts.schoolOptions, schoolKey),
        deptIndex: this.indexOf(opts.deptOptions, deptKey),
        specialtyIndex: this.indexOf(opts.specialtyOptions, specialtyKey),
        gradeIndex: this.indexOf(opts.gradeOptions, this.data.gradeKey),
      };
      this.setData(patch);
      // 提示依赖最新的 options / key，setData 之后按新状态再算一次（否则会用到上一次的值）
      this.setData({ facetHint: this.facetHint(), emptyReason: this.emptyReason() });
      // 选中值被服务端回退成「全部」时，列表也要跟着回退（否则列表是旧筛选的结果、下拉却显示全部）
      if (schoolKey !== this.data.schoolKey || deptKey !== this.data.deptKey || specialtyKey !== this.data.specialtyKey) {
        this.setData({ page: 1 }, () => this.load());
      }
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  query() {
    const { page, keyword, filter, schoolKey, deptKey, specialtyKey, gradeKey } = this.data;
    const q = { page, limit: PAGE_SIZE, keyword };
    if (filter === 'noExercise') q.noMorningExercise = 1;
    if (filter === 'noClass') q.noMorningClass = 1;
    if (filter === 'noNightStudy') q.noNightStudy = 1;
    if (filter === 'noRun') q.noMorningRun = 1;
    if (this.data.statusFilter) q.status = this.data.statusFilter;
    if (schoolKey) q.school = schoolKey;
    // 系部按**名字**筛（与后端筛选、facets 归组三处同一口径）：
    // 名单导入只写 departmentName、没有 id，按 id 筛会让纯导入学校的「系部」下拉永远是空
    // （同页「院校」却正常 —— 一半能用一半不能用比全都缺更糟）。
    if (deptKey) q.department = deptKey;
    // 专业同样按**名字**筛（后端 /profiles 的 specialty 参数就是 class_profiles.specialty 等值匹配）
    if (specialtyKey) q.specialty = specialtyKey;
    if (gradeKey) q.grade = gradeKey;
    return q;
  },

  // 有没有生效中的筛选（关键字 / 标记 / 院校 / 系部 / 专业 / 年级任一）：决定列表上方要不要显示命中数与清除入口
  activeFilterCount(data) {
    const { keyword, filter, statusFilter, schoolKey, deptKey, specialtyKey, gradeKey } = this.data;
    return keyword || filter || statusFilter || schoolKey || deptKey || specialtyKey || gradeKey ? data.total || 0 : 0;
  },

  // 院校（organizations 的 school 层）：选项 key 是 schoolName 文本（与用户管理页的「院校」筛选同口径），
  // 存量台账只有 schoolId 时服务端也认（GET /profiles 的 school 参数两种都能匹配）。
  // 联动：换院校**同时重置系部与专业**为「全部」，年级不变。
  onSchoolChange(e) {
    const index = Number(e.detail.value) || 0;
    const opt = this.data.schoolOptions[index] || { key: '' };
    this.setData({ schoolIndex: index, schoolKey: opt.key, page: 1 }, () => this.load());
  },

  // 系部：换系部**重置专业**为「全部」；院校不动。
  onDeptChange(e) {
    const index = Number(e.detail.value) || 0;
    const opt = this.data.deptOptions[index] || { key: '' };
    this.setData({ deptIndex: index, deptKey: opt.key, specialtyKey: '', page: 1 }, () => this.load());
  },

  onSpecialtyChange(e) {
    const index = Number(e.detail.value) || 0;
    const opt = this.data.specialtyOptions[index] || { key: '' };
    this.setData({ specialtyIndex: index, specialtyKey: opt.key, page: 1 }, () => this.load());
  },

  // 年级是**正交属性**（由班级名 / 学号推导），不参与院校 → 系部 → 专业的联动，选项始终全量。
  onGradeChange(e) {
    const index = Number(e.detail.value) || 0;
    const opt = this.data.gradeOptions[index] || { key: '' };
    this.setData({ gradeIndex: index, gradeKey: opt.key, page: 1 }, () => this.load());
  },

  // 清掉全部筛选（管理员筛完常忘了清，下一次进来看着像「只剩几个班」）
  resetFilters() {
    this.setData(
      {
        keyword: '',
        filter: '',
        filterIndex: 0,
        statusFilter: 'normal',
        statusIndex: 1,
        checkedNames: [],
        checkedCount: 0,
        allPageChecked: false,
        schoolKey: '',
        deptKey: '',
        specialtyKey: '',
        gradeKey: '',
        schoolIndex: 0,
        deptIndex: 0,
        specialtyIndex: 0,
        gradeIndex: 0,
        page: 1,
      },
      () => this.load()
    );
  },

  decorate(c, checkedSet) {
    // 晚自习放在早八之后、校园跑之前（与班级里「早操→早八→晚自习→参跑」的自然顺序一致）
    const flags = ['hasMorningExercise', 'hasMorningClass', 'hasNightStudy', 'hasMorningRun'].map((field) => {
      const on = c[field] !== false;
      const t = FLAG_LABELS[field];
      return { field, on, text: on ? t.on : t.off, short: t.short, action: on ? t.actionOn : t.actionOff };
    });
    const status = ['intern', 'graduated'].includes(c.status) ? c.status : 'normal';
    const set = checkedSet || new Set(this.data.checkedNames || []);
    const checked = set.has(c.className);
    return {
      ...c,
      flags,
      status,
      statusText: STATUS_TEXT[status],
      statusHint: STATUS_HINT[status] || '',
      checked,
      homeroomText: (c.homeroomNames || []).join('、') || '未分配班主任',
      // 归属副标题：院校 · 系部（与筛选器同一套词，组织树 school → department）
      orgText: [c.schoolName, c.departmentName].filter(Boolean).join(' · ') || '—',
      classroomText: c.classroom || '未设置教室',
      hasClassroom: !!c.classroom,
      // 「不跑操」= hasMorningRun 为 false；单独给一行说明，避免管理员以为它跟早操是一回事
      runText: c.hasMorningRun === false ? '本班不参加校园跑' : '参加校园跑',
      isRunOff: c.hasMorningRun === false,
    };
  },

  // ===== 教室（用户 2026-10-22「尽量使用 Dialog 对话框完整的…直接让用户一次输入完」）=====
  // 一个对话框里：点选教学用楼（白名单，只能选）+ 填门号（纯数字）→ 一次保存。
  // 不再走「action sheet 选楼 → 再弹 wx.showModal 填门号」的两步流程
  //（第二个弹窗会压在第一个上，用户要来回确认）。
  editClassroom(e) {
    if (!this.requireManage()) return;
    const { id, name, classroom } = e.currentTarget.dataset;
    this.setData({
      roomTarget: { id, name: name || '' },
      roomVisible: true,
    });
    // 稍后再灌值：让 room-dialog 的 visible observer 先跑一次，避免首帧闪空
    wx.nextTick(() => {
      this.setData({ roomValue: classroom || '' });
    });
  },

  // 对话框确认：一次拿到「楼名·门号」
  async onRoomConfirm(e) {
    const d = (e && e.detail) || {};
    const target = this.data.roomTarget || {};
    if (!target.id) return;
    const value = String(d.roomText || '').trim();
    if (value.length > 40) {
      wx.showToast({ title: '教室名称过长', icon: 'none' });
      return;
    }
    this.setData({ roomSaving: true });
    try {
      await this.putProfile(target.id, { classroom: value }, value ? '已设置教室' : '已清空教室');
      this.setData({ roomVisible: false, roomSaving: false });
    } catch (err) {
      this.setData({ roomSaving: false });
    }
  },

  // 对话框「清空」
  async onRoomClear() {
    const target = this.data.roomTarget || {};
    if (!target.id) return;
    this.setData({ roomSaving: true });
    try {
      await this.putProfile(target.id, { classroom: '' }, '已清空教室');
      this.setData({ roomVisible: false, roomSaving: false });
    } catch (err) {
      this.setData({ roomSaving: false });
    }
  },

  closeRoomDialog() {
    this.setData({ roomVisible: false });
  },

  // 取教学用楼清单（失败不阻断页面）
  // ⚠️ 走班级域的只读楼名接口：宿管/教务处填教室只需要 class.view，
  //    不该为了一个下拉去拿 building.manage（楼名维护权限，用户 2026-10-22）
  async loadBuildings() {
    try {
      const res = await auth.get('/api/class/buildings');
      this.setData({ teachingBuildings: (res && res.teaching) || [] });
    } catch (e) {
      this.setData({ teachingBuildings: [] });
    }
  },

  // ===== 卫生区（多选：改的是「本班加入哪些区域」，不动别的班）=====
  async openAreas(e) {
    const { id, name } = e.currentTarget.dataset;
    wx.showLoading({ title: '加载中…', mask: true });
    try {
      const data = await auth.get(`/api/admin/class/profiles/${id}/sanitary`);
      const mineIds = new Set((data.mine || []).map((a) => a.id));
      this.setData({
        areaSheetVisible: true,
        areaSheet: {
          id,
          className: name,
          options: (data.options || []).map((a) => ({
            ...a,
            checked: mineIds.has(a.id),
            typeLabel: AREA_TYPES[a.areaType] || a.areaType || '',
          })),
        },
      });
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  toggleArea(e) {
    const id = e.currentTarget.dataset.id;
    const list = (this.data.areaSheet.options || []).map((a) => (a.id === id ? { ...a, checked: !a.checked } : a));
    this.setData({ 'areaSheet.options': list });
  },

  // 就地新建区域：全校卫生区没有独立维护页（后端有 /api/admin/union/areas 接口但没有 UI），
  // 不支持新建的话，新学校在勾选框里看到的永远是空的 —— 功能等于没有。
  // 同名区域服务端会复用已有的那条，不会建出重复区域。
  onNewAreaInput(e) {
    this.setData({ newAreaName: e.detail.value || '' });
  },

  addNewArea() {
    const name = String(this.data.newAreaName || '').trim();
    if (!name) {
      wx.showToast({ title: '先填区域名称', icon: 'none' });
      return;
    }
    const options = this.data.areaSheet.options || [];
    if (options.some((a) => a.name === name)) {
      wx.showToast({ title: '已有同名区域，直接勾选即可', icon: 'none' });
      this.setData({ newAreaName: '' });
      return;
    }
    const id = `new-${options.length + 1}`;
    this.setData({
      newAreaName: '',
      'areaSheet.options': options.concat([{ id, name, areaType: 'outdoor', typeLabel: '室外区', location: '', checked: true, isNew: true }]),
    });
  },

  closeAreas() {
    this.setData({ areaSheetVisible: false, areaSheet: null, newAreaName: '' });
  },

  async saveAreas() {
    if (!this.requireManage()) return;
    const sheet = this.data.areaSheet;
    if (!sheet) return;
    const checked = sheet.options.filter((a) => a.checked);
    // 新建的区域不能把 'new-3' 这种本地 id 发给服务端 —— 只报名字，由服务端建档
    const areaIds = checked.filter((a) => !a.isNew).map((a) => a.id);
    const newAreas = checked
      .filter((a) => a.isNew)
      .map((a) => ({ name: a.name, areaType: a.areaType || 'outdoor', location: a.location || '' }));
    try {
      const res = await auth.put(`/api/admin/class/profiles/${sheet.id}/sanitary`, { areaIds, newAreas });
      const n = (res.added || []).length + (res.removed || []).length + (res.created || []).length;
      wx.showToast({ title: n ? '已更新本班卫生区' : '没有变化', icon: 'none' });
      this.closeAreas();
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    }
  },

  // ===== 宿舍：跳独立页（按学生绑，一间房可能有别班学生）=====
  goDorms(e) {
    const { id, name } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/packageAdmin/class-manage/dorms/dorms?id=${id}&className=${encodeURIComponent(name)}` });
  },

  requireManage() {
    if (this.data.canManage) return true;
    wx.showToast({ title: '没有修改权限（需要 class.manage）', icon: 'none' });
    return false;
  },

  async putProfile(id, patch, okText) {
    try {
      await auth.put(`/api/admin/class/profiles/${id}`, patch);
      wx.showToast({ title: okText || '已保存', icon: 'none' });
      await this.load();
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    }
  },

  // ===== 批量编辑：班级状态（正常 / 实习 / 毕业）=====
  toggleBulk() {
    // 只读用户不进批量模式（用户 2026-10-22：「只有查看权限时应该不显示操作功能按钮，
    // 而不是点击后被后端拒绝掉」）。批量模式里全是写操作（改状态 / 改跑操标记），
    // 让只读用户进去再被 403 拒绝是最差的体验。入口按钮在 WXML 里也按 canManage 隐藏了。
    if (!this.data.canManage) {
      wx.showToast({ title: '没有修改权限（需要 class.manage）', icon: 'none' });
      return;
    }
    const next = !this.data.bulkMode;
    // 退出批量时不能只清 checkedNames：list 里的 checked 是在 decorate 时算好的，
    // 不清就会留下橙底描边（用户实测反馈过这个残留状态）。
    if (!next) {
      const list = this.data.list.map((c) => ({ ...c, checked: false }));
      this.setData(
        {
          bulkMode: false,
          checkedNames: [],
          checkedCount: 0,
          allPageChecked: false,
          list,
        },
        () => this.refreshChecked()
      );
      return;
    }
    this.setData({ bulkMode: true }, () => this.refreshChecked());
  },

  // 勾选状态变了要重算列表里的 checked（decorate 会读 checkedNames）
  refreshChecked() {
    const names = this.data.checkedNames || [];
    const list = this.data.list.map((c) => ({ ...c, checked: names.includes(c.className) }));
    const allPageChecked = list.length > 0 && list.every((c) => c.checked);
    this.setData({ list, checkedCount: names.length, allPageChecked });
  },

  // 整卡点击：批量模式下=勾选/取消；非批量=打开「更多」菜单
  onCardTap(e) {
    const { name, id, status } = e.currentTarget.dataset;
    if (this.data.bulkMode) {
      this.toggleByName(name);
      return;
    }
    this.openMore({ currentTarget: { dataset: { id, name, status } } });
  },

  toggleByName(name) {
    if (!name) return;
    const names = new Set(this.data.checkedNames || []);
    if (names.has(name)) names.delete(name);
    else names.add(name);
    this.setData({ checkedNames: [...names] }, () => this.refreshChecked());
  },

  toggleCheck(e) {
    this.toggleByName(e.currentTarget.dataset.name);
  },

  selectAllPage() {
    const names = new Set(this.data.checkedNames || []);
    for (const c of this.data.list) names.add(c.className);
    this.setData({ checkedNames: [...names] }, () => this.refreshChecked());
  },

  clearChecked() {
    // 「取消全选」只清本页：跨页保留的其它勾选不受影响
    const pageNames = new Set(this.data.list.map((c) => c.className));
    const rest = (this.data.checkedNames || []).filter((n) => !pageNames.has(n));
    this.setData({ checkedNames: rest }, () => this.refreshChecked());
  },

  // 批量设置状态：有勾选就只改勾选的班，否则按当前筛选条件整批改
  applyStatus(e) {
    if (!this.requireManage()) return;
    const status = e.currentTarget.dataset.status;
    if (!['normal', 'intern', 'graduated'].includes(status)) return;
    const checked = this.data.checkedNames || [];
    const q = this.query();
    const scope = checked.length
      ? { classNames: checked }
      : { school: q.school, department: q.department, grade: q.grade };
    const scopeText = checked.length ? '勾选的 ' + checked.length + ' 个班' : '当前筛选下的全部班级';
    const warn =
      status === 'graduated'
        ? '该班学生将不能登录，且不参加任何班超与校园跑统计。'
        : status === 'intern'
          ? '该班学生仍可登录，但不参加任何班超与校园跑统计。'
          : '该班恢复参加班超与校园跑统计；因毕业被限制登录的学生会一并恢复。';

    wx.showModal({
      title: '将' + scopeText + '设为「' + STATUS_TEXT[status] + '」？',
      content: warn,
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const res = await auth.post('/api/admin/class/profiles/status', { status, ...scope });
          const extra = res.banned ? '，' + res.banned + ' 名学生已限制登录' : '';
          wx.showToast({ title: '已更新 ' + res.modified + ' 个班' + extra, icon: 'none' });
          this.setData({ checkedNames: [], checkedCount: 0 }, () => this.load());
        } catch (err) {
          wx.showToast({ title: err.message || '批量设置失败', icon: 'none' });
        }
      },
    });
  },

  // 批量改单个标记（早操 / 早八 / 参跑）：与批量状态共用同一个接口
  applyFlag(e) {
    if (!this.requireManage()) return;
    const { field, value } = e.currentTarget.dataset;
    const FLAG_FIELDS = ['hasMorningExercise', 'hasMorningClass', 'hasNightStudy', 'hasMorningRun'];
    if (!FLAG_FIELDS.includes(field)) return;
    const next = String(value) === '1';
    // 文案统一从 FLAG_LABELS 取，别再写 if/else 链 —— 加一个开关就要改三处是漏项根源
    const label = field === 'hasMorningRun' ? '校园跑' : (FLAG_LABELS[field] || {}).short || '';
    const action = next ? (field === 'hasMorningRun' ? '参加' : '有') : field === 'hasMorningRun' ? '不参加' : '无';

    const checked = this.data.checkedNames || [];
    const q = this.query();
    const scope = checked.length
      ? { classNames: checked }
      : { school: q.school, department: q.department, grade: q.grade };
    const scopeText = checked.length ? '勾选的 ' + checked.length + ' 个班' : '当前筛选下的全部班级';

    wx.showModal({
      title: '将' + scopeText + '设为「' + action + label + '」？',
      content:
        field === 'hasMorningRun'
          ? next
            ? '这些班将重新计入班级运动榜与校园跑统计。'
            : '这些班将退出班级运动榜与校园跑统计。'
          : next
            ? '这些班将进入' + label + '考勤（录入台会出现这些班）。'
            : '这些班将退出' + label + '考勤（录入台不再出现这些班）。',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const res = await auth.post('/api/admin/class/profiles/status', {
            field,
            value: next,
            ...scope,
          });
          wx.showToast({ title: '已更新 ' + res.modified + ' 个班', icon: 'none' });
          this.setData({ checkedNames: [], checkedCount: 0 }, () => this.load());
        } catch (err) {
          wx.showToast({ title: err.message || '批量设置失败', icon: 'none' });
        }
      },
    });
  },

  // 行内「更多」：把状态、卫生区、宿舍、教室收进一个菜单，牌面只留三个高频标记
  openMore(e) {
    const { id, name, status } = e.currentTarget.dataset;
    const items = ['改班级状态', '设置教室', '卫生区', '宿舍'];
    wx.showActionSheet({
      itemList: items,
      success: (res) => {
        if (res.tapIndex === 0) {
          this.editStatus({ currentTarget: { dataset: { id, name, status } } });
        } else if (res.tapIndex === 1) {
          const item = this.data.list.find((c) => c.id === id);
          this.editClassroom({
            currentTarget: { dataset: { id, name, classroom: (item && item.classroom) || '' } },
          });
        } else if (res.tapIndex === 2) {
          this.openAreas({ currentTarget: { dataset: { id, name } } });
        } else if (res.tapIndex === 3) {
          this.goDorms({ currentTarget: { dataset: { id, name } } });
        }
      },
    });
  },

  // 单个班改状态（点行内「状态 ›」）
  editStatus(e) {
    if (!this.requireManage()) return;
    const { name, status } = e.currentTarget.dataset;
    const keys = ['normal', 'intern', 'graduated'];
    const labels = { normal: '正常', intern: '实习', graduated: '毕业' };
    const items = keys.map((k) => (k === status ? labels[k] + '（当前）' : labels[k]));
    wx.showActionSheet({
      itemList: items,
      success: async (res) => {
        const next = keys[res.tapIndex];
        if (!next || next === status) return;
        const tip =
          next === 'graduated'
            ? '该班学生将不能登录，且不参加班超与校园跑统计。'
            : next === 'intern'
              ? '学生仍可登录，但不参加班超与校园跑统计。'
              : '恢复参加班超与校园跑；因毕业被限制登录的学生会一并恢复。';
        wx.showModal({
          title: name + ' 设为「' + labels[next] + '」？',
          content: tip,
          success: async (r2) => {
            if (!r2.confirm) return;
            try {
              await auth.post('/api/admin/class/profiles/status', { status: next, classNames: [name] });
              wx.showToast({ title: '已更新', icon: 'success' });
              await this.load();
            } catch (err) {
              wx.showToast({ title: err.message || '设置失败', icon: 'none' });
            }
          },
        });
      },
    });
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value || '' });
  },

  search() {
    this.setData({ page: 1 }, () => this.load());
  },

  clearKeyword() {
    this.setData({ keyword: '', page: 1 }, () => this.load());
  },

  // 状态选择器：全部 / 只显示正常 / 实习 / 毕业
  onStatusChange(e) {
    const index = Number(e.detail.value) || 0;
    const opt = this.data.statusOptions[index] || { key: '' };
    this.setData({ statusIndex: index, statusFilter: opt.key, page: 1 }, () => this.load());
  },

  // 标记选择器：全部 / 只看无早操 / 无早八 / 不参跑
  onFilterChange(e) {
    const index = Number(e.detail.value) || 0;
    const opt = this.data.filterOptions[index] || { key: '' };
    this.setData({ filterIndex: index, filter: opt.key, page: 1 }, () => this.load());
  },

  prevPage() {
    if (this.data.page <= 1) return;
    this.setData({ page: this.data.page - 1 }, () => this.load());
  },

  nextPage() {
    if (this.data.page >= this.data.pagesTotal) return;
    this.setData({ page: this.data.page + 1 }, () => this.load());
  },

  // 从学籍补新班 + 刷新人数（不会覆盖手工设过的早操 / 跑操标记）
  async sync() {
    if (this.data.syncing) return;
    this.setData({ syncing: true });
    try {
      const res = await auth.post('/api/admin/class/profiles/sync', {});
      // 归属冲突必须让人看见：同名班级在不同院校/系部时，同步只能按多数票选一个值，
      // 静默的话管理员会以为"院校显示错了"，实际是名单数据本身有歧义（services/class-profiles.js 的 conflicts）
      const conflicts = res.conflicts || [];
      if (conflicts.length) {
        this.setData({ conflicts });
        const first = conflicts[0];
        wx.showModal({
          title: `同步完成，但有 ${conflicts.length} 处归属冲突`,
          content: `例如「${first.className}」的${first.field === 'school' ? '院校' : '系部'}有多个值：${first.values.join('、')}，已按人数最多的「${first.chosen}」记入台账。请在名单或组织架构里核对。`,
          showCancel: false,
        });
      } else {
        wx.showToast({ title: `新增 ${res.created || 0} 个班`, icon: 'none' });
      }
      await this.load();
    } catch (e) {
      wx.showToast({ title: e.message || '同步失败', icon: 'none' });
    } finally {
      this.setData({ syncing: false });
    }
  },

  // 单个开关：走管理端台账接口（需要 class.manage）
  async toggleFlag(e) {
    const { id, field, value, name } = e.currentTarget.dataset;
    if (!this.data.canManage) {
      wx.showToast({ title: '没有修改权限（需要 class.manage）', icon: 'none' });
      return;
    }
    if (this.data.savingKey) return;
    const that = this;
    wx.showModal({
      title: name,
      content: `确认把「${field === 'hasMorningRun' ? '校园跑' : (FLAG_LABELS[field] || {}).short || field}」改为 ${value ? '关闭' : '开启'}？`,
      success: async (r) => {
        if (!r.confirm) return;
        that.setData({ savingKey: `${id}:${field}` });
        try {
          await auth.put(`/api/admin/class/profiles/${id}`, { [field]: !value });
          await that.load();
        } catch (err) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        } finally {
          that.setData({ savingKey: '' });
        }
      },
    });
  },
});
