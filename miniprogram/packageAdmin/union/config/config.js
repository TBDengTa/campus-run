// 学生会配置（管理端 packageAdmin）：部门 / 检查模块（班超评比项）
//
// 命名口径：管理入口统一叫「学生会配置」「学生会成员」「班级管理」「我的班级」，
// 而「班超」是**产品名**（班级检查评比域），只出现在门户页与评比相关文案里
// —— 用户明确要求过这个区分，别把两者混用。
//
// 「班级台账」已拆到独立页 packageAdmin/class-manage（叫「班级管理」，权限走 class.view/class.manage）：
// 台账管的是全校所有班级，与学生会不是一回事，硬放在这里会让管理员找不到改「不跑操」的地方，
// 也会逼学生处为改一个班的标记额外去持有 union.manage。
const auth = require('../../../utils/request');
// 部门「归属校区」判定与成员页共用一份（两页各写会漂移：配置页只显示本校区部门、
// 成员页却能把人分到别校区的部门）
const { deptFitsCampus, isPresidium } = require('../../../utils/union-dept');

const TABS = [
  { key: 'departments', label: '部门' },
  { key: 'modules', label: '检查模块' },
];

// 部门树的根 —— scope 是**唯一**的层级来源（union-department.js 没有 parentId，
// 也刻意不加：「多级」在数据里就是 school / branch / both 的两级语义）。
//
// 根 = 「全校」+ organizations 里**每一个 `type === 'school'` 的真院校**（北校区 / 洋河校区 / 教师院…）。
// 上一版把它渲染成「校级学生会 / 分院学生会」两个抽象根，用户明确否定了这种做法：
// 院校就是组织架构里的 school 节点，根必须是「全校 + 每个院校」，而不是「校级 / 分院」这种抽象词。
//   「全校」根      = scope ∈ {school, both}（全校口径的部门定义）
//   每个院校根      = scope ∈ {branch, both}（该院校口径的部门定义）
// scope='both' 的部门是**全校 / 各院校共用一套定义**，因此在「全校」和**每一个**院校根下都出现（多挂），
// 所以 nodeId 必须用复合形式（`school-<key>` / `<院校id>-<key>`），不能拿裸 key 当 wx:key。
// 院校列表走现成的 `GET /api/org/tree`（与 union/members 同一口径），**不新增、不改动任何后端接口**。
const ALL_ROOT_KEY = 'school'; // 「全校」根在 deptExpanded / nodeId 里的键名
const ALL_ROOT = {
  rootKey: ALL_ROOT_KEY,
  name: '全校',
  icon: 'layers',
  memberLevel: 'school',
  isAll: true,
  note: '按「适用范围」归属：仅校学生会 → 全校；仅院校 / 全校 + 各院校 → 全校与每个院校',
};
const CAMPUS_ICON = 'city'; // 每个院校根
// 叶子节点图标（写成 icon 字段，让 tools/check-miniprogram.js 的图标存在性检查一并覆盖）
const DEPT_LEAF = { icon: 'bulletpoint' };
const DEPT_SCOPE_TEXT = { school: '仅校学生会', branch: '仅院校学生会', both: '全校 + 各院校' };

// 院校根下的成员数**不能**说成「该校区的人数」：departments 接口的 branchCount
// = 该部门 level='branch' 的在任成员**全校总数**，并没有按校区细分（模型里没有校区维度）。
// 三个院校会显示同一个数字，所以文案必须显式声明「未按校区细分」，不自称精确。
const BRANCH_MEMBER_HINT = '（未按校区细分）';

// /api/org/tree 里没有 school 节点时的提示（不许白屏 / 空树，只渲染「全校」+ 这行提示）
const NO_CAMPUS_TIP = '未配置院校，请到「组织架构」添加（如 北校区 / 洋河校区）';
const CAMPUS_LOAD_FAIL_TIP = '院校列表读取失败，下拉刷新重试（不影响下方「全校」部门）';

Page({
  data: {
    loading: true,
    tab: 'departments',
    tabs: TABS,
    canManage: false,
    // 部门（树：「全校」+ 每个院校根 + 按 scope 归属的叶子）
    departments: [],
    deptNodes: [], // 拍平后的树节点（只含已展开分支），与组织架构页同一渲染契约
    // 院校（organizations 里 type='school' 的节点，来自 GET /api/org/tree）
    campusList: [],
    campusTip: '', // 「未配置院校」/「读取失败」的提示行（不许白屏、不许空树）
    deptStat: { deptCount: 0, campusCount: 0, allCount: 0, branchCount: 0 },
    deptExpanded: { school: true }, // 展开态（键 = rootKey）；每次加载由 withDefaultExpand() 补全为「默认全展开」
    deptRoleKeys: [],
    showDeptAdd: false,
    // 部门归属（用户 2026-10-21「应该只有校学生会和院校(选择)学生会才对」）：
    // 只有「校学生会（仅校级）」与「具体校区」两类；不再有「各院校通用」这种到处都出现的中间态。
    // 表单只有名称 + 归属（标识由服务端自动生成，不再是表单字段）
    deptForm: { name: '', scope: 'school', schoolId: '' },
    // 真实选项在 load() 里按校区生成；这里只是首屏兜底（只含校级，避免出现已废弃的「各院校通用」）
    deptSchoolOptions: [{ id: '', scope: 'school', name: '校学生会（仅校级）' }],
    deptSchoolIndex: 0,
    // 模块
    modules: [],
    // 模块概览（N 个模块 / M 个未配录入部门）—— 配置缺口显性化
    moduleStat: { total: 0, noDept: 0, enabled: 0 },
    moduleDeptOptions: [],
    // 录入部门按层级分组（校学生会 / <校区>学生会）——抽屉内直接勾选，不再套第二层弹窗
    moduleDeptGroups: [],
    moduleEditingKey: '',
    moduleForm: null,
  },

  onLoad() {
    if (!getApp().requireLogin()) return;
    const user = getApp().globalData.userInfo || {};
    const perms = user.effectivePermissions || [];
    this.setData({ canManage: perms.includes('*') || perms.includes('union.manage') });
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  onTabTap(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.tab) return;
    this.setData({ tab });
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      // 院校列表（/api/org/tree）与部门、模块并发；院校取不到**不能**影响部门树渲染
      const [deptRes, modRes, orgRes] = await Promise.all([
        auth.get('/api/admin/union/departments'),
        auth.get('/api/admin/union/modules'),
        auth.get('/api/org/tree').catch(() => null),
      ]);
      const deptList = (deptRes.list || []).map((d) => {
        const scope = this.normalizeScope(d.scope);
        const schoolCount = d.schoolCount || 0;
        const branchCount = d.branchCount || 0;
        return {
          ...d,
          scope,
          // 归属文案走 belongText：挂到具体校区的部门必须显示「仅 洋河校区」，
          // 而不是「仅院校学生会」（那会被读成所有校区都有它，正是用户要修的误解）
          scopeText: this.belongText({ schoolId: d.schoolId, scope }),
          schoolCount,
          branchCount,
          memberCount: schoolCount + branchCount,
          // 职责模块用服务端的 dutyNames（按 check_modules.entryDeptKeys 反推的**中文模块名**）。
          // 旧实现直接 join dutyModules（内部 key），既显示 hygiene / study_evening 这种
          // 管理员看不懂的字符串，又是一份可能与实际鉴权脱钩的手写绑定。
          // 主席团按设计不参与录入（只读+复核）→ 显示「—」而不是「未配置」，
          // 否则看起来像有个配置缺口要补。
          dutyText: (d.dutyNames || []).length
            ? (d.dutyNames || []).join('、')
            : d.noEntryByDesign
              ? '不参与录入（只读 + 复核）'
              : '未配置',
          // 非主席团且没被任何模块引用 → 标出来，管理员才知道「这个部门目前谁都进不了」
          dutyWarn: !(d.dutyNames || []).length && !d.noEntryByDesign,
        };
      });
      this._deptList = deptList;
      this._campusList = this.pickCampuses(orgRes);
      const campusTip = this._campusList.length
        ? ''
        : orgRes === null
          ? CAMPUS_LOAD_FAIL_TIP
          : NO_CAMPUS_TIP;
      const deptExpanded = this.withDefaultExpand();
      this.setData({
        loading: false,
        departments: deptList,
        campusList: this._campusList,
        campusTip,
        deptExpanded,
        deptNodes: this.flattenDeptTree(deptList, deptExpanded),
        deptStat: this.deptTreeStat(deptList),
        modules: (modRes.list || []).map((m) => ({
          ...m,
          // 部门名带校区前缀：两校区可以各有「生活部」，只显示「生活部」会看不出绑的是哪个校区的。
          entryNames: (m.entryDeptKeys || [])
            .map((k) => this.deptLabel((deptRes.list || []).find((d) => d.key === k), k))
            .join('、'),
          // 「录入部门没配」= 鉴权口径没配，这个模块实际上没人能录 —— 把配置缺口显性化
          // （原先只显示「录入部门：未配置」，扫一眼很难发现有几个模块是这种状态）
          noEntryDept: !(m.entryDeptKeys || []).length,
          scoreText:
            m.scoring && m.scoring.mode === 'percent'
              ? '百分制扣分'
              : m.scoring && m.scoring.mode === 'rate'
                ? '出勤率折算'
                : '按人数扣分',
        })),
        moduleDeptOptions: (deptRes.list || []).map((d) => ({ key: d.key, name: d.name })),
        // 按层级分组的录入部门（校学生会 / <校区>学生会）；抽屉里直接勾选
        moduleDeptGroups: this.moduleDeptGroups(deptRes.list || []),
        // 部门表单的「归属」下拉（用户 2026-10-21「应该只有校学生会和院校(选择)学生会才对」）：
        //   校学生会（仅校级） → 只挂「全校」根
        //   具体校区           → 只挂那个校区根，两校区可各有自己的部门
        // ⚠️ 刻意**去掉「所有院校（各院校通用）」**：它是旧 scope='both' 的产物，
        //   会让同一个部门同时出现在每个校区下（用户反复反馈的「所有部门都是一个、只是在不同校区显示」）。
        //   现在每个部门必须明确归属：要么校级、要么某一个校区。
        deptSchoolOptions: [
          { id: '', scope: 'school', name: '校学生会（仅校级）' },
        ].concat((this._campusList || []).map((c) => ({ id: c.rootKey, scope: 'branch', name: c.name }))),
        // 模块概览：N 个模块 / M 个未配录入部门（管理员最需要一眼看到的就是这个缺口）
        moduleStat: (() => {
          const list = modRes.list || [];
          const noDept = list.filter((m) => !(m.entryDeptKeys || []).length).length;
          return { total: list.length, noDept, enabled: list.filter((m) => m.enabled !== false).length };
        })(),
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  // ===== 院校（organizations 里 type='school' 的节点）=====
  // 接口形态兼容：/api/org/tree 服务端直接把数组当 data 下发（organizations.js 就是这么读的），
  // 这里同时容忍 {tree:[...]} / {list:[...]} 两种包装。取不到（null / 异常 / 空）→ 返回 []。
  pickCampuses(orgRes) {
    const tree = Array.isArray(orgRes) ? orgRes : (orgRes && (orgRes.tree || orgRes.list)) || [];
    const out = [];
    const walk = (nodes) => {
      for (const n of nodes || []) {
        const type = n.type || '';
        if (type === 'school') {
          out.push({
            rootKey: String(n._id || n.id || n.name), // nodeId 前缀：必须全局唯一、且不与其他根撞车
            name: n.name || '未命名院校',
            icon: CAMPUS_ICON,
            memberLevel: 'branch',
            isAll: false,
            sort: Number(n.sort) || 0,
            note: '',
            error: false,
          });
        }
        // 只把顶层 school 当院校根，不再往下钻（院系 / 专业不做根）；
        // 但 school 可能被配成了别人的子级，所以递归兜一层，避免“配了却看不见”。
        if (n.children) walk(n.children);
      }
    };
    walk(tree);
    // 按 sort 升序、同 sort 按名称（服务端已按 sort 排过，这里再稳定排一次，保证与组织架构页一致）
    out.sort((a, b) => a.sort - b.sort || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
    return out;
  },

  // scope 归一：历史/异常值一律按 'both' 处理（与 union-department.js 的默认值同口径）
  normalizeScope(scope) {
    return scope === 'school' || scope === 'branch' ? scope : 'both';
  },

  // 拍平的根序列：「全校」固定第一，其后为每个院校
  deptRoots() {
    return [ALL_ROOT].concat(this._campusList || []);
  },

  // 默认展开态：**「全校」与每个院校根都默认展开**（用户要「一眼看到每个院校都有自己的部门」；
  // 部门定义数量很少，树不会长，看不到时点根名即可收起）。用户在会话内手动收起过的根保持收起。
  withDefaultExpand() {
    const cur = this.data.deptExpanded || {};
    const next = {};
    for (const r of this.deptRoots()) next[r.rootKey] = cur[r.rootKey] === undefined ? true : !!cur[r.rootKey];
    return next;
  },

  // 归属判定统一走 utils/union-dept（成员页用同一份，避免两页口径漂移）：
  //  · schoolId 有值 → 只属于那一个校区（北校区「生活部」不会出现在洋河）
  //  · schoolId 为空 → 按 scope 兼容旧数据（school=只全校 / branch=所有校区 / both=全校+所有校区）
  belongsToRoot(dept, root) {
    // forDeptTree=true：主席团只在「全校」根下出现一次（用户 2026-10-21「主席团是一样的代码，需要不一样」）；
    // 但在成员页/模块选择器里它是可选职务，任何校区都能选（见 utils/union-dept.js 注释）
    return deptFitsCampus(dept, root.isAll ? '' : root.rootKey, { forDeptTree: true });
  },

  // 归属文案：有 schoolId 直接显示校区名（服务端已带 schoolName）。
  // 「仅院校学生会」这种说法对挂到具体校区的部门是错的 —— 它只属于那一个校区。
  belongText(dept) {
    // 主席团：全局唯一（分会主席团是成员记录上的 level，不是另一个部门）
    if (isPresidium(dept)) return '全校（全局唯一）';
    if (dept.schoolId) return `仅 ${dept.schoolName || '某院校'}`;
    return DEPT_SCOPE_TEXT[this.normalizeScope(dept.scope)];
  },

  // 部门的完整标签：挂到具体校区时带上校区名。
  // 两校区可以各有「生活部」（key 不同），只显示名字会看不出模块绑的是哪个校区的部门。
  deptLabel(dept, fallbackKey) {
    if (!dept) return fallbackKey || '未知部门';
    return dept.schoolId && dept.schoolName ? `${dept.schoolName} · ${dept.name}` : dept.name;
  },

  // 模块「允许录入的部门」选择器：按**层级**分组 —— 校学生会 / 各院校学生会。
  //
  // 用户 2026-10-21「为什么有全校通用 这里还是要分开，要不然操作困难，就分为校学生会和院校学生会
  // 别写通用 要不然操作成本高」：
  //   · 旧分组名「全校 / 通用」既不是组织里的真实称谓，又把「没指定校区的部门」笼统塞在一起，
  //     管理员要点开一个含糊的「通用」才能找部门，操作成本高。
  //   · 现在按**组织层级**直说：第一组「校学生会」，其后每个校区一组「<校区>学生会」。
  //     这正是成员管理的真实结构（校学生会 / 各院校学生会是两个层级），不需要额外理解。
  //
  // 分组只影响展示；entryDeptKeys 存的仍是全局唯一的部门 key，鉴权口径不变。
  moduleDeptGroups(deptList) {
    const list = deptList || [];
    const groups = [];
    // 第一组：校学生会 —— 现在只有主席团（用户 2026-10-21「全校仅有主席团没有其他部门了」）。
    const schoolItems = list.filter((d) => deptFitsCampus(d, ''));
    if (schoolItems.length) {
      groups.push({ rootKey: '__school__', name: '校学生会', items: schoolItems.map((d) => ({ key: d.key, name: d.name })) });
    }
    // 第二组：**未指定校区的共用部门**（生活部/学习部/纪检部等），只能出现在这一个组里。
    // ⚠️ 不能把它们在每个校区组里各列一遍：entryDeptKeys 里存的是**一个** key，
    //   同一 key 渲染两处会让「我勾了北校区那个，洋河那个也变成已勾」——
    //   用户会以为勾了两个部门，实际只有一个。归属不明确是组织架构的事，
    //   在部门页给它指定校区后，它就会从这组移到对应校区组。
    const sharedItems = list.filter((d) => !isPresidium(d) && !d.schoolId);
    if (sharedItems.length) {
      groups.push({
        rootKey: '__shared__',
        name: '各院校共用（未指定校区）',
        items: sharedItems.map((d) => ({ key: d.key, name: d.name })),
      });
    }
    // 其后每个院校学生会一组：只列**明确归属该校区**的部门。
    for (const c of this._campusList || []) {
      const items = list.filter((d) => !isPresidium(d) && d.schoolId && String(d.schoolId) === String(c.rootKey));
      groups.push({
        rootKey: c.rootKey,
        name: `${c.name}学生会`,
        empty: items.length === 0,
        items: items.map((d) => ({ key: d.key, name: d.name })),
      });
    }
    return groups;
  },

  // 部门列表 → 拍平树节点（与组织架构页同一渲染契约：单层 wx:for + depth 内联缩进）
  // 只把**已展开**根的叶子放进列表；nodeId 为复合 key（both 部门多挂，不能用裸 key 当 wx:key）
  flattenDeptTree(list, expandedMap) {
    const expanded = expandedMap || this.data.deptExpanded || {};
    const nodes = [];
    // nodeId 全局唯一是硬要求（wx:key="nodeId"）：同名院校 / 同名根都会撞车，
    // 这里再兜一层，撞了就加后缀，绝不让两个节点的 key 相同（否则复用同一节点、展开态错乱）。
    const used = new Set();
    const uniqueId = (id) => {
      let out = id;
      let i = 2;
      while (used.has(out)) out = `${id}#${i++}`;
      used.add(out);
      return out;
    };
    for (const root of this.deptRoots()) {
      const children = (list || []).filter((d) => this.belongsToRoot(d, root));
      const isOpen = !!expanded[root.rootKey];
      nodes.push({
        nodeId: uniqueId(root.rootKey),
        isRoot: true,
        isAll: !!root.isAll,
        rootKey: root.rootKey,
        level: root.memberLevel,
        depth: 0,
        icon: root.icon,
        name: root.name,
        note: root.note || '',
        childCount: children.length,
        expandable: children.length > 0,
        expanded: isOpen,
        metaText: children.length
          ? `共 ${children.length} 个部门 · ${isOpen ? '收起' : '展开'}`
          : '暂无部门',
      });
      if (!isOpen) continue;
      for (const d of children) {
        // 「全校」根下用 schoolCount（level='school' 在任数，口径就是全校）；
        // 院校根下的 branchCount 是**全局分院校计数的旧口径**（未按校区细分）→ 文案显式声明，
        // 不假装它是该校区的人数。
        const n = root.memberLevel === 'school' ? d.schoolCount || 0 : d.branchCount || 0;
        const exact = root.memberLevel === 'school';
        nodes.push({
          nodeId: uniqueId(`${root.rootKey}-${d.key}`),
          isRoot: false,
          isAll: false,
          rootKey: root.rootKey,
          level: root.memberLevel,
          depth: 1,
          icon: DEPT_LEAF.icon,
          id: d.id,
          key: d.key,
          name: d.name,
          builtIn: !!d.builtIn,
          enabled: d.enabled !== false,
          scopeText: d.scopeText,
          memberText: exact ? `${n} 名在任成员` : `分院在任成员 ${n} 名${BRANCH_MEMBER_HINT}`,
          memberExact: exact,
          dutyText: d.dutyText,
        });
      }
    }
    return nodes;
  },

  // 顶部统计：部门数按**定义**去重（挂多个根时节点数会翻倍，不能拿来当「共 N 个部门」）；
  // 院校数按实际渲染的院校根数。
  // allCount / branchCount 现在按**归属校区**统计（schoolId 有值的只算它那个校区），
  // 不再是「scope ∈ {school,both}」这种全校区同义的旧口径。
  deptTreeStat(list) {
    const rows = list || [];
    const roots = this.deptRoots();
    const allRoot = roots.find((r) => r.isAll);
    const campusRoots = roots.filter((r) => !r.isAll);
    return {
      deptCount: rows.length,
      campusCount: campusRoots.length,
      allCount: allRoot ? rows.filter((d) => this.belongsToRoot(d, allRoot)).length : 0,
      branchCount: rows.filter((d) => campusRoots.some((r) => this.belongsToRoot(d, r))).length,
    };
  },

  // 点根节点的名称行：展开 / 收起。
  // 叶子行也绑了这个事件（与组织架构页「每行都绑」的写法一致），但必须靠 data-root 挡掉——
  // 否则点叶子会连带收起整棵根（叶子也在 dataset 里带 rootKey）。
  toggleDeptExpand(e) {
    const ds = e.currentTarget.dataset || {};
    const isRoot = ds.root === true || ds.root === 'true' || ds.root === '1';
    if (!isRoot) return; // 叶子行不误触收起
    const rootKey = ds.rootkey || ds.rootKey;
    if (!rootKey) return;
    const root = this.deptRoots().find((r) => r.rootKey === rootKey);
    if (!root) return;
    // 该根下没有部门时不可展开（按归属校区判定，与 flattenDeptTree 同一函数，避免两处口径漂移）
    if (!(this._deptList || []).some((d) => this.belongsToRoot(d, root))) return;
    const deptExpanded = { ...this.data.deptExpanded, [rootKey]: !this.data.deptExpanded[rootKey] };
    this.setData({ deptExpanded, deptNodes: this.flattenDeptTree(this._deptList, deptExpanded) });
  },

  // ===== 部门新增：单一「归属」选择器 =====
  // 用户要求去掉「适用范围」（它原本与归属校区语义重叠），折进这一个下拉：
  //   校学生会（仅校级）→ schoolId 空 + scope 'school'
  //   具体校区          → schoolId 有值 + scope 'branch'
  //   （旧的「所有院校通用」已移除，它会让部门在每个校区都出现）
  openDeptAdd(e) {
    // 从某个院校根下的「+ 部门」进来时预填该校区（用户最常做的动作就是「给洋河建一个卫生部」）
    const presetSchool = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.schoolid) || '';
    const opts = this.data.deptSchoolOptions || [];
    const idx = Math.max(0, opts.findIndex((o) => o.id === presetSchool));
    // 兜底用「校级」，不要回落到已废弃的 'both'
    const picked = opts[idx] || { id: '', scope: 'school' };
    this.setData({
      showDeptAdd: true,
      deptForm: { name: '', scope: picked.scope || 'school', schoolId: picked.id || '' },
      deptSchoolIndex: idx,
    });
  },

  closeDeptAdd() {
    this.setData({ showDeptAdd: false });
  },

  // 选归属：三项各自决定 schoolId + scope，一个控件表达完整归属
  onDeptSchool(e) {
    const i = Number(e.detail.value) || 0;
    const opt = (this.data.deptSchoolOptions || [])[i] || { id: '', scope: 'both' };
    this.setData({
      deptSchoolIndex: i,
      'deptForm.schoolId': opt.id || '',
      'deptForm.scope': opt.scope || 'both',
    });
  },

  onDeptInput(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [`deptForm.${key}`]: e.detail.value });
  },

  async submitDept() {
    const f = this.data.deptForm;
    if (!f.name) {
      wx.showToast({ title: '请填部门名称', icon: 'none' });
      return;
    }
    // 标识（key）不再让用户填：它只是鉴权用的内部唯一键，手填既麻烦又容易撞车。
    // 服务端会按名称自动生成（拼音/序号 + 冲突后缀），前端不传 key 即可。
    try {
      await auth.post('/api/admin/union/departments', { name: f.name, scope: f.scope, schoolId: f.schoolId || '' });
      wx.showToast({ title: '已添加', icon: 'success' });
      this.setData({ showDeptAdd: false });
      await this.load();
    } catch (e) {
      wx.showToast({ title: e.message || '添加失败', icon: 'none' });
    }
  },

  renameDept(e) {
    const { id, name } = e.currentTarget.dataset;
    const that = this;
    wx.showModal({
      title: '修改部门名称',
      editable: true,
      placeholderText: name || '',
      success: async (r) => {
        if (!r.confirm) return;
        const value = (r.content || '').trim();
        if (!value) return;
        try {
          await auth.put(`/api/admin/union/departments/${id}`, { name: value });
          wx.showToast({ title: '已保存', icon: 'success' });
          await that.load();
        } catch (err) {
          wx.showToast({ title: err.message || '保存失败', icon: 'none' });
        }
      },
    });
  },

  toggleDept(e) {
    const { id, enabled } = e.currentTarget.dataset;
    const that = this;
    (async () => {
      try {
        await auth.put(`/api/admin/union/departments/${id}`, { enabled: !enabled });
        await that.load();
      } catch (err) {
        wx.showToast({ title: err.message || '操作失败', icon: 'none' });
      }
    })();
  },

  removeDept(e) {
    const { id, name, builtin } = e.currentTarget.dataset;
    if (builtin) {
      wx.showToast({ title: '内置部门不可删除', icon: 'none' });
      return;
    }
    const that = this;
    wx.showModal({
      title: '删除部门',
      content: `确认删除「${name}」？有在任成员时无法删除。`,
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await auth.del(`/api/admin/union/departments/${id}`);
          wx.showToast({ title: '已删除', icon: 'success' });
          await that.load();
        } catch (err) {
          wx.showToast({ title: err.message || '删除失败', icon: 'none' });
        }
      },
    });
  },

  // ===== 检查模块 =====
  editModule(e) {
    const key = e.currentTarget.dataset.key;
    const module = this.data.modules.find((m) => m.key === key);
    if (!module) return;
    this.setData({
      moduleEditingKey: key,
      moduleForm: {
        key,
        name: module.name,
        shortName: module.shortName || '',
        entryDeptKeys: (module.entryDeptKeys || []).slice(),
        weight: (module.scoring && module.scoring.weight) || 1,
        enabled: module.enabled !== false,
      },
    });
    // 打开抽屉就要把选中态算好：WXML 不能调 indexOf，只读预计算的 active
    this.refreshModuleGroups(module.entryDeptKeys || []);
  },

  closeModuleEdit() {
    this.setData({ moduleEditingKey: '', moduleForm: null });
  },

  onModuleInput(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [`moduleForm.${key}`]: e.detail.value });
  },

  toggleModuleDept(e) {
    const key = e.currentTarget.dataset.key;
    const list = (this.data.moduleForm.entryDeptKeys || []).slice();
    const idx = list.indexOf(key);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(key);
    this.setData({ 'moduleForm.entryDeptKeys': list });
    this.refreshModuleGroups(list);
  },

  /**
   * 给每个部门 chip 预计算 active 布尔值。
   *
   * ⚠️ **WXML 表达式不支持方法调用**：`moduleForm.entryDeptKeys.indexOf(item.key) >= 0`
   * 在小程序模板里不会执行（只有 WXS 能调方法），求值结果恒为 undefined/false ——
   * 表现就是「所有 chips 永远全灰、看不出哪个已选」，而点击其实生效了
   * （用户 2026-10-21「我依旧无法改变部门啊」）。
   * 所以选中态必须在 JS 里算好，WXML 只读 {{item.active}}。
   */
  refreshModuleGroups(entryKeys) {
    const picked = new Set(entryKeys || (this.data.moduleForm && this.data.moduleForm.entryDeptKeys) || []);
    const mark = (list) => (list || []).map((it) => ({ ...it, active: picked.has(it.key) }));
    const groups = (this.data.moduleDeptGroups || []).map((g) => ({ ...g, items: mark(g.items) }));
    const options = mark(this.data.moduleDeptOptions);
    this.setData({ moduleDeptGroups: groups, moduleDeptOptions: options });
  },

  toggleModuleEnabled() {
    this.setData({ 'moduleForm.enabled': !this.data.moduleForm.enabled });
  },

  async submitModule() {
    const f = this.data.moduleForm;
    if (!f) return;
    try {
      await auth.put(`/api/admin/union/modules/${f.key}`, {
        name: f.name,
        shortName: f.shortName,
        entryDeptKeys: f.entryDeptKeys,
        enabled: f.enabled,
        scoring: { weight: Number(f.weight) || 0 },
      });
      wx.showToast({ title: '已保存', icon: 'success' });
      this.closeModuleEdit();
      await this.load();
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    }
  },

  resetModule(e) {
    const key = e.currentTarget.dataset.key;
    const that = this;
    wx.showModal({
      title: '恢复默认',
      content: '将把该模块的检查项、指标公式与计分方式恢复为内置默认值（不动录入部门）。',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await auth.post(`/api/admin/union/modules/${key}/reset`, {});
          wx.showToast({ title: '已恢复', icon: 'success' });
          await that.load();
        } catch (err) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },
});
