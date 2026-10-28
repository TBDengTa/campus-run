// 学生会成员管理（管理端 packageAdmin）：紧凑列表 + 滑动操作 + 搜索选人添加
//
// 列表：
//   · 顶部筛选 = 院校（全部 / 校学生会 / 教师院 / 洋河校区 / 北校区）+ 部门 + 学年 + 搜索；
//   · 每行左滑出「改职务 / 调部门 / 离任」，不再在行内堆按钮。
// 添加：
//   · 不再有「校 / 分院」层级概念，统一用院校选择器（校学生会 + 各院校）；
//   · 学年用选择器（2026学年…2024学年），默认当前学年，服务端按 9 月自动切换。
//
// 权限：union.view 查看、union.manage 增改删（服务端逐个校验）；成员是独立集合，
// 不会让成员顺带获得管理端权限。
const auth = require('../../../utils/request');
// 部门「归属校区」判定与配置页共用一份：两页各写必然漂移
//（配置页只显示本校区部门、成员页却能把人分到别校区的部门）
const { deptFitsCampus, normalizeScope } = require('../../../utils/union-dept');
// 写权限的判定与服务端 canManageMembers 同口径（主席团/部长/副部长/总管），
// 不能再只写 union.manage —— 主席团是学生、没有该项权限，会被误判成只读（用户 2026-10-28 报障）。
const { canUnionScanJoin } = require('../../../utils/nav-groups');

const ROLES = [
  { key: 'president', label: '主席' },
  { key: 'vice_president', label: '副主席' },
  { key: 'minister', label: '部长' },
  { key: 'vice_minister', label: '副部长' },
  { key: 'member', label: '部员' },
];
const PRESIDIUM_ROLES = ['president', 'vice_president'];
// 主席团里可选的职务（主席 / 副主席）；业务部门则可选部长 / 副部长 / 部员。
// 用户 2026-10-21：「主席团中怎么能有部长这类的职务呢」——两侧必须联动，只做前端过滤不够，
// 服务端 assertRoleFitsDept 同样会拦（绕过 UI 直接 POST 也造不出矛盾数据）。
const PRESIDIUM_ROLE_SET = ROLES.filter((r) => PRESIDIUM_ROLES.includes(r.key));
const DEPT_ROLE_SET = ROLES.filter((r) => !PRESIDIUM_ROLES.includes(r.key));

// 列表每次重载递增：拼进行 key，强制 t-swipe-cell 重建（否则操作后行仍停在滑开状态）
let listRev = 0;

Page({
  // 权限重算（用户 2026-10-22「登录账户时一定要刷新缓存」）：
  // 换账号登录后页面 data 里的 canManage 可能还是上一个身份的结论 ——
  // 表现就是「只读账号仍看到操作按钮」。onShow 与登录回调都会调这里。
  refreshPermission() {
    const user = getApp().globalData.userInfo || {};
    const perms = user.effectivePermissions || [];
    // 用户 2026-10-28：主席团可管理（虽是学生但服务端放行），部长/副部长只读。
    this.setData({ canManage: canUnionScanJoin(user, perms) });
  },

  data: {
    loading: true,
    list: [],
    page: 1,
    limit: 20,
    total: 0,
    hasMore: false,
    keyword: '',
    canManage: false,

    // 筛选：院校（'' = 全部，'school' = 全校，其它 = 院校组织 id）
    campusOptions: [{ id: '', name: '全部成员' }, { id: 'school', name: '校学生会' }],
    campusIndex: 0,
    // 默认「全部成员」（用户 2026-10-22 最终口径）：进来就该看到全部成员，
    // 而不是先限定在某一层再让用户自己改。
    campus: '',
    deptFilterOptions: [{ key: '', name: '全部部门' }],
    deptFilterIndex: 0,
    deptKeyFilter: '',
    termOptions: [{ termId: '', termName: '全部学年' }],
    termIndex: 0,
    termIdFilter: '',

    // 批量管理（用户 2026-10-21「增加批量管理操作(改职务、调部门、离任)」）
    batchMode: false,
    checkedIds: [],
    checkedCount: 0,
    batchSaving: false,

    // 添加抽屉
    showAdd: false,
    roleOptions: ROLES,
    roleIndex: 4,
    picked: [],
    addCampusOptions: [{ id: 'school', name: '校学生会' }],
    addCampusIndex: 0,
    addDeptOptions: [{ key: '', name: '请选择部门' }],
    addDeptIndex: 0,
    addTermOptions: [],
    addTermIndex: 0,
    saving: false,
    pickerQuery: {},
  },

  onLoad() {
    if (!getApp().requireLogin()) return;
    const user = getApp().globalData.userInfo || {};
    const perms = user.effectivePermissions || [];
    // 用户 2026-10-28：主席团可管理（虽是学生但服务端放行），部长/副部长只读。
    this.setData({ canManage: canUnionScanJoin(user, perms) });
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    this.refreshPermission();
    this.load(true);
  },

  onPullDownRefresh() {
    this.load(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.load(false);
  },

  async load(reset) {
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      // 列表走**用户端**接口（用户 2026-10-28 图1「无权限（需要 union.view）」）：
      //
      // 根因：这个页面原来请求 /api/admin/union/members，而管理端整棵树在挂载时
      // 要求 `union.view` —— 主席团 / 部长 / 副部长是**学生**、没有任何管理权限，
      // 于是进去后立刻弹「无权限（需要 union.view）」，列表空、只剩一句 toast。
      // 服务端其实早有面向干部的用户端实现（/api/union/manage/members，
      // 用成员身份 assertMemberManager + 范围过滤 memberManageAllowed），
      // 与管理端**同一份数据、同一套口径**，只是鉴权方式不同。
      //
      // 回退策略：管理员（持 union.view）通常不是学生会成员，用户端接口会 403，
      // 这时回退到管理端接口 —— 两条路都保住。
      const params = {
        page,
        limit: this.data.limit,
        campus: this.data.campus,
        deptKey: this.data.deptKeyFilter,
        termId: this.data.termIdFilter,
        keyword: this.data.keyword,
        status: 'active',
      };
      let data;
      try {
        data = await auth.get('/api/union/manage/members', params);
      } catch (e) {
        // 403：不是学生会成员（学生处 / 团委老师）→ 改用管理端接口
        if (e && (e.code === 403002 || e.code === 403)) {
          data = await auth.get('/api/admin/union/members', params);
        } else {
          throw e;
        }
      }
      listRev += 1;
      const rev = listRev;
      const rows = (data.list || []).map((m) => ({
        ...m,
        rowKey: `${m.id}_${rev}`,
        initial: (m.realName || '—').slice(0, 1),
        roleClass: PRESIDIUM_ROLES.includes(m.role) ? 'top' : m.role,
        // 「全校」是层级口径（level='school'），与筛选器里的「校学生会」同一件事，
        // 统一叫法避免同屏出现两个名字指同一个东西
        orgText: m.level === 'school' ? '校学生会' : m.schoolName || '未设院校',
        deptText: m.deptName || '主席团',
        // 学年 + 届次一起显示（如「2026学年 · 第24届」），服务端已按锚点推算
        termText: m.termLabel || m.termName || '未设学年',
        subText: [m.className, m.studentId].filter(Boolean).join(' · '),
      }));
      // 新加载/翻页进来的行也要带上勾选态（批量模式跨页勾选不能丢）
      const merged = reset ? rows : this.data.list.concat(rows);
      this.setData({
        loading: false,
        list: this.markChecked(merged, this.data.checkedIds),
        page,
        total: data.total || 0,
        hasMore: !!data.hasMore,
      });
      // 注意：applyOptions 只刷新选项、**不复位已选筛选**；reset 只表示「重新拉第一页」
      this.applyOptions(data);
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  // 筛选选项全部来自服务端：院校（校学生会 + 组织树院校）、部门、学年。
  applyOptions(data) {
    const patch = {};
    // 本次将要生效的院校值：部门筛选要按**它**算，不能用 this.data.campus
    // （那是上一次的值，patch 还没 setData，会算出上一所院校的部门）
    let nextCampus = this.data.campus;

    if (Array.isArray(data.schools) && data.schools.length) {
      // 院校筛选（用户 2026-10-22 最终口径：「我还是要全部成员」）：
      //   「全部成员」= 不限层级（校学生会 + 各校区都算）→ campus=''（不带筛选条件）
      //   「校学生会」= 只列 level='school' 的校级成员 → campus='school'
      //   其余各项 = 具体校区
      // 「全部成员」与会「校学生会」不是重复：前者是"什么都不筛"，后者是"只筛校级那一层"。
      const campusOptions = [{ id: '', name: '全部成员' }, { id: 'school', name: '校学生会' }].concat(
        data.schools.map((s) => ({ id: s.id, name: s.name }))
      );
      let campusIndex = campusOptions.findIndex((x) => x.id === this.data.campus);
      if (campusIndex < 0) campusIndex = 0;
      nextCampus = campusOptions[campusIndex].id;
      Object.assign(patch, {
        campusOptions,
        campusIndex,
        campus: nextCampus,
        addCampusOptions: [{ id: 'school', name: '校学生会' }].concat(
          data.schools.map((s) => ({ id: s.id, name: s.name }))
        ),
      });
    }

    if (Array.isArray(data.departments) && data.departments.length) {
      // 部门选项保留 scope + schoolId：调部门/加成员时按**校区**过滤
      //（用户 2026-10-21「北校区有生活部、洋河叫卫生部，互不干扰」）
      const deptAll = data.departments
        .filter((d) => d.enabled !== false)
        .map((d) => ({ key: d.key, name: d.name, scope: d.scope, schoolId: d.schoolId || '', schoolName: d.schoolName || '' }));
      // 原始全量留一份：换校区时要按它重算可选部门（不能用已被过滤过的列表当全量，
      // 否则第二次换校区就只剩上次那批，选项越换越少）
      this._deptAll = deptAll;
      // 部门筛选按**当前院校**联动（用户 2026-10-21「院校与部门的联动筛选不正常」）：
      // 之前是全量不分院校，选了「北校区」还能筛出洋河才有的部门，筛出来必然是 0 条。
      const deptFilterOptions = this.buildDeptFilterOptions(nextCampus);
      let deptFilterIndex = deptFilterOptions.findIndex((x) => x.key === this.data.deptKeyFilter);
      if (deptFilterIndex < 0) deptFilterIndex = 0;
      Object.assign(patch, {
        deptFilterOptions,
        deptFilterIndex,
        deptKeyFilter: deptFilterOptions[deptFilterIndex].key,
        addDeptOptions: [{ key: '', name: '请选择部门' }].concat(deptAll),
      });
    }

    if (Array.isArray(data.terms) && data.terms.length) {
      // 选择器文案统一用「学年 · 届次」，避免只写学年时对不上团委换届的说法
      const termOptions = [{ termId: '', termName: '全部学年' }].concat(
        data.terms.map((t) => ({ termId: t.termId, termName: t.termLabel || t.termName, rawName: t.termName }))
      );
      let termIndex = termOptions.findIndex((x) => x.termId === this.data.termIdFilter);
      if (termIndex < 0) termIndex = 0;
      const addTermOptions = data.terms.map((t) => ({
        termId: t.termId,
        termName: t.termLabel || t.termName,
        rawName: t.termName,
      }));
      const currentAddIndex = Math.max(
        0,
        addTermOptions.findIndex((t) => t.termId === data.currentTerm)
      );
      Object.assign(patch, {
        termOptions,
        termIndex,
        termIdFilter: termOptions[termIndex].termId,
        addTermOptions,
        addTermIndex: currentAddIndex,
      });
    }

    this.setData(patch);
  },

  onCampusChange(e) {
    const idx = Number(e.detail.value) || 0;
    const campus = (this.data.campusOptions[idx] || {}).id || '';
    // 切换院校必须**同时重算部门筛选**（用户 2026-10-21「院校与部门的联动筛选不正常」）：
    // 否则上一所院校选的部门还留在筛选里，与新的院校条件相互矛盾 → 结果永远是 0 条，
    // 而界面上两个筛选器各自看起来都"选着东西"，很难看出是矛盾。
    const deptFilterOptions = this.buildDeptFilterOptions(campus);
    this.setData(
      {
        campusIndex: idx,
        campus,
        deptFilterOptions,
        deptFilterIndex: 0,
        deptKeyFilter: '',
      },
      () => this.load(true)
    );
  },

  // 部门筛选选项：按院校过滤 + 名称带校区前缀。
  //
  // ⚠️ campus=''（「全部成员」）**不能**直接传给 deptFitsCampus：
  // 那里的 `''` 是「校级层」的意思（只匹配 scope='school'/主席团）——
  // 于是「全部成员」下只会列出校级部门，各校区分会的部门全都筛不出来
  // （用户 2026-10-22 恢复「全部成员」后，这个坑会立刻暴露）。
  // 不限层级时应当列出**全部部门**，让用户自己选。
  buildDeptFilterOptions(campusId) {
    const all = this._deptAll || [];
    const fits = campusId ? all.filter((d) => deptFitsCampus(d, campusId)) : all;
    const items = fits.map((d) => ({
      key: d.key,
      name: d.schoolName ? `${d.schoolName} · ${d.name}` : d.name,
      scope: d.scope,
      schoolId: d.schoolId || '',
      schoolName: d.schoolName || '',
    }));
    return [{ key: '', name: '全部部门' }].concat(items);
  },

  onDeptFilterChange(e) {
    const idx = Number(e.detail.value) || 0;
    this.setData({ deptFilterIndex: idx, deptKeyFilter: (this.data.deptFilterOptions[idx] || {}).key || '' }, () =>
      this.load(true)
    );
  },

  onTermChange(e) {
    const idx = Number(e.detail.value) || 0;
    this.setData({ termIndex: idx, termIdFilter: (this.data.termOptions[idx] || {}).termId || '' }, () => this.load(true));
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value || '' });
  },

  onSearch() {
    this.load(true);
  },

  onResetFilters() {
    // 恢复「全部成员」（用户 2026-10-22）：清除筛选就该回到不限层级，
    // 而不是把院校限定在「校学生会」——那反而是一个隐藏的筛选条件。
    this.setData(
      { campusIndex: 0, campus: '', deptFilterIndex: 0, deptKeyFilter: '', termIndex: 0, termIdFilter: '', keyword: '' },
      () => this.load(true)
    );
  },

  // ===== 批量管理（改职务 / 调部门 / 离任）=====
  // 为什么要批量：开学换届时整届几十号人要一起改职务/调部门，一个个左滑操作不现实。
  toggleBatchMode() {
    const next = !this.data.batchMode;
    this.setData({
      batchMode: next,
      checkedIds: [],
      checkedCount: 0,
      list: this.markChecked(this.data.list, []),
    });
  },

  /**
   * 把勾选态写进每个列表项（item.checked）。
   *
   * ⚠️ 必须在 JS 里算好：WXML 表达式不能调用方法，`checkedIds.indexOf(item.id)` 在模板里
   * 恒为 undefined/false —— 界面上就会「勾了但看不到勾」，这个坑本仓库已踩过两次。
   */
  markChecked(list, checkedIds) {
    const set = new Set(checkedIds || []);
    return (list || []).map((m) => ({ ...m, checked: set.has(m.id) }));
  },

  // 批量模式下点整行 = 勾选/取消（非批量模式点行无操作，仍靠左滑与「更多」）
  onItemTap(e) {
    if (!this.data.batchMode) return;
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const set = new Set(this.data.checkedIds || []);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    const checkedIds = [...set];
    this.setData({
      checkedIds,
      checkedCount: checkedIds.length,
      list: this.markChecked(this.data.list, checkedIds),
    });
  },

  // 全选 / 取消全选（只作用于**当前已加载**的列表，不是整个筛选结果 ——
  // 分页只加载了前 N 页，说"全选"却只选了看到的这些会误导，文案里写清「本页」）
  toggleCheckAll() {
    const ids = (this.data.list || []).map((m) => m.id).filter(Boolean);
    const allChecked = ids.length > 0 && ids.every((id) => (this.data.checkedIds || []).includes(id));
    const checkedIds = allChecked ? [] : ids;
    this.setData({
      checkedIds,
      checkedCount: checkedIds.length,
      list: this.markChecked(this.data.list, checkedIds),
    });
  },

  // 三个批量操作统一走这里：先把选中项送去服务端，再把「哪几个没成、为什么」讲清楚
  async runBulk(action, payload) {
    const ids = this.data.checkedIds || [];
    if (!ids.length) {
      wx.showToast({ title: '请先勾选成员', icon: 'none' });
      return;
    }
    if (this.data.batchSaving) return;
    this.setData({ batchSaving: true });
    try {
      // 批量改职务 / 调部门：用户端**没有批量接口**（干部走身份校验），
      // 所以干部身份下逐条调 PUT /api/union/manage/members/:id；
      // 管理员（非成员）走管理端的批量接口（一次请求更省）。
      // 用户 2026-10-28：主席团在管理端接口上会「无权限（需要 union.view）」。
      const isManager = !!this.data.canManage;
      let res;
      const isUnionMember = !!((getApp().globalData.userInfo || {}).isUnionMember);
      if (isUnionMember && isManager) {
        // 逐条：与单条改职务 / 调部门完全同一条路径，失败逐条收集
        const updatedIds = [];
        const failed = [];
        for (const id of ids) {
          try {
            const body = action === 'role' ? { role: payload.role } : { deptKey: payload.deptKey };
            await auth.put(`/api/union/manage/members/${id}`, body);
            updatedIds.push(id);
          } catch (e) {
            failed.push({ id, name: '', reason: (e && e.message) || '失败' });
          }
        }
        res = { updated: updatedIds.length, failed };
      } else {
        res = await auth.post('/api/admin/union/members/bulk-update', { ids, action, ...payload });
      }
      const updated = (res && res.updated) || 0;
      const failed = (res && res.failed) || [];
      if (failed.length) {
        // 部分失败必须逐条说明：只报「成功了 N 个」会让人以为全好了
        const lines = failed.slice(0, 8).map((f) => `${f.name || f.id}：${f.reason}`).join('\n');
        wx.showModal({
          title: `${updated} 人已更新，${failed.length} 人失败`,
          content: lines + (failed.length > 8 ? `\n…等 ${failed.length} 人` : ''),
          showCancel: false,
        });
      } else {
        wx.showToast({ title: `已更新 ${updated} 人`, icon: 'success' });
      }
      this.setData({ batchMode: false, checkedIds: [], checkedCount: 0 });
      await this.load(true);
    } catch (e) {
      wx.showToast({ title: e.message || '批量操作失败', icon: 'none' });
    } finally {
      this.setData({ batchSaving: false });
    }
  },

  batchSetRole() {
    // 批量的职务只能从「业务部门可用的职务」里选：主席/副主席要求挂主席团，
    // 而批量选中的人可能分属各部门，统一改成主席会大面积造出矛盾记录。
    // 需要设主席/副主席的，用单条的「改职务」（它会自动把部门也改成主席团）。
    const options = DEPT_ROLE_SET;
    wx.showActionSheet({
      itemList: options.map((r) => r.label),
      success: (res) => {
        const role = options[res.tapIndex];
        if (!role) return;
        this.runBulk('role', { role: role.key });
      },
    });
  },

  batchSetDept() {
    // 候选部门：按**当前院校筛选**收敛（若选了具体院校），否则给全量里各院校通用的部门。
    // 主席团排除：调部门不负责设主席，那是「改职务」的事。
    const opts = (this.buildDeptFilterOptions(this.data.campus) || []).filter((d) => d.key && d.key !== 'presidium');
    if (!opts.length) {
      wx.showToast({ title: '没有可选的部门', icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: opts.map((d) => d.name),
      success: (res) => {
        const dept = opts[res.tapIndex];
        if (!dept) return;
        this.runBulk('dept', { deptKey: dept.key });
      },
    });
  },

  batchLeave() {
    const n = this.data.checkedCount;
    wx.showModal({
      title: `让勾选的 ${n} 人离任？`,
      content: '离任是软删除：保留历史记录与统计，只是不再算在任成员。',
      confirmColor: '#e34d59',
      success: (r) => {
        if (!r.confirm) return;
        this.runBulk('leave', {});
      },
    });
  },

  // ===== 滑动操作 =====
  onSwipeAction(e) {
    const { action, id } = e.currentTarget.dataset;
    const member = this.data.list.find((m) => m.id === id);
    if (!member || !action) return;
    if (action === 'role') this.editRole(member);
    else if (action === 'dept') this.transferDept(member);
    else if (action === 'leave') this.leave(member);
  },

  // 右滑（或滑不动时）的兜底入口：点「⋯」弹出同一套操作
  onFallbackAction(e) {
    const id = e.currentTarget.dataset.id;
    const member = this.data.list.find((m) => m.id === id);
    if (!member) return;
    wx.showActionSheet({
      itemList: ['改职务', '调部门', '离任'],
      success: (res) => {
        if (res.tapIndex === 0) this.editRole(member);
        else if (res.tapIndex === 1) this.transferDept(member);
        else if (res.tapIndex === 2) this.leave(member);
      },
    });
  },

  editRole(member) {
    // 职务选项按成员所在部门联动：主席团只给 主席 / 副主席，业务部门只给 部长 / 副部长 / 部员。
    // 否则在主席团成员上能看到并选到「部长」，就会造出「主席团 · 部长」这种矛盾记录。
    const isPresidium = member.deptKey === 'presidium';
    const options = isPresidium ? PRESIDIUM_ROLE_SET : DEPT_ROLE_SET;
    if (!options.length) return;
    wx.showActionSheet({
      itemList: options.map((r) => (r.key === member.role ? `${r.label}（当前）` : r.label)),
      success: async (res) => {
        const role = options[res.tapIndex];
        if (!role || role.key === member.role) return;
        try {
          await auth.put(`/api/union/manage/members/${member.id}`, { role: role.key });
          wx.showToast({ title: '已更新职务', icon: 'success' });
          await this.load(true);
        } catch (err) {
          wx.showToast({ title: err.message || '更新失败', icon: 'none' });
        }
      },
    });
  },

  transferDept(member) {
    // 只列「该成员所在校区可用」的部门，且排除主席团（主席团由职务决定，不靠调部门）。
    // 用 deptFitsCampus（与配置页同一份）：旧实现只看 scope，
    // 而 scope='branch' 的部门属于**所有**校区 → 把北校区的人调到洋河才有的部门也放行，
    // 正是用户报的「所有部门都是一个、只是不同校区显示」。
    const campusOfMember = member.level === 'school' ? 'school' : member.schoolId || '';
    const options = (this.data.deptFilterOptions || []).filter(
      (d) => d.key && d.key !== member.deptKey && d.key !== 'presidium' && deptFitsCampus(d, campusOfMember)
    );
    if (!options.length) {
      wx.showToast({ title: '该校区没有可调整的部门', icon: 'none' });
      return;
    }
    wx.showActionSheet({
      // 两校区可能各有同名部门（生活部），选项里带校区名才分得清
      itemList: options.map((d) => (d.schoolName ? `${d.schoolName} · ${d.name}` : d.name)),
      success: async (res) => {
        const dept = options[res.tapIndex];
        if (!dept) return;
        // 部门 ↔ 职务联动：业务部门之间可自由互调，但**主席团不在候选里**（上面已排除），
        // 所以这里只需兜住「把主席/副主席调进业务部门」——他们必须先改成部长类职务。
        if (PRESIDIUM_ROLES.includes(member.role)) {
          wx.showToast({ title: '主席 / 副主席属于主席团，不能调入业务部门', icon: 'none', duration: 2500 });
          return;
        }
        try {
          await auth.put(`/api/union/manage/members/${member.id}`, { deptKey: dept.key });
          wx.showToast({ title: `已调到${dept.name}`, icon: 'success' });
          await this.load(true);
        } catch (err) {
          wx.showToast({ title: err.message || '调整失败', icon: 'none' });
        }
      },
    });
  },

  leave(member) {
    wx.showModal({
      title: '成员离任',
      content: `确认将「${member.realName || '该成员'}」标记为离任？离任后不再有检查录入权限，历史记录保留。`,
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await auth.post(`/api/union/manage/members/${member.id}/remove`, {});
          wx.showToast({ title: '已离任', icon: 'success' });
          await this.load(true);
        } catch (err) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },

  // ===== 添加成员 =====
  async openAdd() {
    this.setData({
      showAdd: true,
      picked: [],
      addCampusIndex: 0,
      addDeptIndex: 0,
      // 默认「未选部门」→ 职务选项用业务部门那套（部员），
      // 避免上一次选过主席团后残留成「请选择部门 + 主席」这种怪组合
      roleOptions: DEPT_ROLE_SET,
      roleIndex: DEPT_ROLE_SET.length - 1,
      pickerQuery: {},
    });
  },

  closeAdd() {
    this.setData({ showAdd: false });
  },

  // 部门变化 → 职务选项联动（主席团 ⇄ 主席/副主席）
  // 用户 2026-10-21：「主席团中怎么能有部长这类的职务呢」。两侧都要收敛：
  //   · 选到主席团 → 职务只剩 主席 / 副主席（当前若不是，自动落到主席）；
  //   · 选到业务部门 → 职务只剩 部长 / 副部长 / 部员（当前若是主席/副主席，自动落到部员）。
  syncRoleOptionsForDept(deptKey) {
    const isPresidium = deptKey === 'presidium';
    const roleOptions = isPresidium ? PRESIDIUM_ROLE_SET : DEPT_ROLE_SET;
    const cur = (this.data.roleOptions[this.data.roleIndex] || {}).key || '';
    const stillValid = roleOptions.some((r) => r.key === cur);
    const roleIndex = stillValid ? roleOptions.findIndex((r) => r.key === cur) : 0;
    this.setData({ roleOptions, roleIndex });
  },

  onPicked(e) {
    this.setData({ picked: e.detail.selected || [] });
  },

  onAddCampus(e) {
    const index = Number(e.detail.value) || 0;
    const campus = this.data.addCampusOptions[index] || {};
    // 院校同时作为候选人搜索条件：学籍里的院校多数只有文本名，按名字过滤更准
    // ⚠️ 部门选项**必须跟着校区重算**（用户 2026-10-21「互不干扰」）：
    //   旧实现 addDeptOptions 是全量不分校区，给洋河加人时能选北校区才有的部门，
    //   选完就落库成「洋河成员 + 北校区部门」这种自相矛盾的数据。
    const deptOptions = this.buildAddDeptOptions(campus.id || '');
    this.setData({
      addCampusIndex: index,
      pickerQuery: campus.id && campus.id !== 'school' ? { school: campus.name } : {},
      addDeptOptions: deptOptions,
      addDeptIndex: 0,
    });
    // 换校区后部门被重置为「请选择部门」，职务选项回到业务部门那套
    this.syncRoleOptionsForDept('');
  },

  // 按校区过滤「可选部门」：首项是「请选择部门」占位，其余只留该校区可用的。
  // 源用 this._deptAll（原始全量），不能用 data.addDeptOptions ——后者已被本次过滤过，
  // 反复换校区会把选项越换越少。
  buildAddDeptOptions(campusId) {
    const fits = (this._deptAll || []).filter((d) => deptFitsCampus(d, campusId));
    return [{ key: '', name: '请选择部门' }].concat(fits.map((d) => ({
      key: d.key,
      name: d.schoolName ? `${d.schoolName} · ${d.name}` : d.name,
      scope: d.scope,
      schoolId: d.schoolId || '',
      schoolName: d.schoolName || '',
    })));
  },

  onAddRole(e) {
    const roleIndex = Number(e.detail.value) || 0;
    const role = (this.data.roleOptions[roleIndex] || {}).key || '';
    // 反向联动：选到主席 / 副主席 → 部门自动锁定主席团（部门下拉里本来也有主席团这一项）
    if (PRESIDIUM_ROLES.includes(role)) {
      const presidiumIdx = this.data.addDeptOptions.findIndex((d) => d.key === 'presidium');
      if (presidiumIdx >= 0) {
        this.setData({ roleIndex, addDeptIndex: presidiumIdx });
        return;
      }
    }
    this.setData({ roleIndex });
  },

  onAddDept(e) {
    const addDeptIndex = Number(e.detail.value) || 0;
    const dept = this.data.addDeptOptions[addDeptIndex] || {};
    this.setData({ addDeptIndex });
    // 正向联动：部门变了，职务选项跟着换（见 syncRoleOptionsForDept）
    this.syncRoleOptionsForDept(dept.key || '');
  },

  onAddTerm(e) {
    this.setData({ addTermIndex: Number(e.detail.value) || 0 });
  },

  async submitAdd() {
    if (this.data.saving) return;
    const campus = this.data.addCampusOptions[this.data.addCampusIndex] || {};
    const role = (this.data.roleOptions[this.data.roleIndex] || {}).key || 'member';
    const dept = this.data.addDeptOptions[this.data.addDeptIndex] || {};
    const term = this.data.addTermOptions[this.data.addTermIndex] || {};

    if (!this.data.picked.length) {
      wx.showToast({ title: '请先搜索并选择学生', icon: 'none' });
      return;
    }
    if (!dept.key) {
      wx.showToast({ title: '请选择部门', icon: 'none' });
      return;
    }
    // 部门必须属于所选校区（用户 2026-10-21「互不干扰」）。
    // 即使选项已按校区过滤，这里仍兜一道：换校区后残留的旧选择、
    // 或两人同时操作导致选项过期，都会落库成「洋河成员 + 北校区部门」这种矛盾数据。
    if (!PRESIDIUM_ROLES.includes(role) && !deptFitsCampus(dept, campus.id || '')) {
      wx.showToast({ title: `「${dept.name}」不属于所选校区，请重新选择`, icon: 'none', duration: 2500 });
      return;
    }
    // 部门 ↔ 职务匹配（与后端 assertRoleFitsDept 同一口径）：
    //   主席团只能设 主席/副主席；主席/副主席只能挂主席团。
    if (dept.key === 'presidium' && !PRESIDIUM_ROLES.includes(role)) {
      wx.showToast({ title: '主席团成员只能是主席或副主席', icon: 'none', duration: 2500 });
      return;
    }
    if (PRESIDIUM_ROLES.includes(role) && dept.key !== 'presidium') {
      wx.showToast({ title: '主席 / 副主席必须归入主席团', icon: 'none', duration: 2500 });
      return;
    }

    // 校学生会 = level 'school'；选具体院校 = level 'branch' + schoolId
    const isSchoolLevel = !campus.id || campus.id === 'school';
    const body = {
      level: isSchoolLevel ? 'school' : 'branch',
      schoolId: isSchoolLevel ? '' : campus.id,
      // 主席 / 副主席恒挂主席团；其余部门用用户所选（上面已校验过匹配关系）
      deptKey: dept.key,
      role,
      termId: term.termId || '',
      // 落库仍只写学年名（termName），届次是派生展示，不进库
      termName: term.rawName || term.termName || '',
    };

    this.setData({ saving: true });
    try {
      // 添加成员：用户端**没有这个接口**（加人走「扫码加人」——学生出示二维码、干部扫码），
      // 管理端 /api/admin/union/members 要求 union.manage，干部（学生）必然 403。
      //
      // 判断口径：持 union.manage / '*' 的是管理员 → 走管理端添加；
      // 否则是干部（主席团 / 部长，靠身份加人）→ 引导到扫码加人页。
      const perms = (getApp().globalData.userInfo || {}).effectivePermissions || [];
      const canAdminAdd = perms.includes('*') || perms.includes('union.manage');
      if (!canAdminAdd) {
        this.setData({ saving: false });
        wx.showModal({
          title: '请用扫码加人',
          content:
            '你的身份是学生会干部（不是管理员），加人需要学生出示「加入学生会二维码」后扫码加入。\n\n现在去扫码加人？',
          confirmText: '去扫码',
          success: (r) => {
            if (r.confirm) {
              this.closeAdd();
              wx.navigateTo({ url: '/packageAdmin/union/scan-join/scan-join' });
            }
          },
        });
        return;
      }
      if (this.data.picked.length === 1) {
        const one = this.data.picked[0];
        await auth.post('/api/admin/union/members', { ...body, userId: one.userId });
        wx.showToast({ title: `已添加 ${one.name}`, icon: 'success' });
      } else {
        const res = await auth.post('/api/admin/union/members/bulk', {
          ...body,
          userIds: this.data.picked.map((p) => p.userId),
        });
        const extra = res.failed && res.failed.length ? `，${res.failed.length} 个失败` : '';
        wx.showToast({
          title: `新增 ${res.created} 人${res.skipped ? `，跳过 ${res.skipped}` : ''}${extra}`,
          icon: 'none',
        });
      }
      this.setData({ showAdd: false, picked: [] });
      await this.load(true);
    } catch (e) {
      wx.showToast({ title: e.message || '添加失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  goConfig() {
    wx.navigateTo({ url: '/packageAdmin/union/config/config' });
  },
});
