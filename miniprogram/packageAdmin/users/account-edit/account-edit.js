const auth = require('../../../utils/request');
const permUi = require('../../../utils/permission-ui');

const GENDERS = [
  { value: 1, label: '男' },
  { value: 2, label: '女' },
  { value: 0, label: '保密' },
];

// 年级推导：学号前 4 位即入学年份（如 20230101 → "2023"）
// 与 server/src/services/roster.js::gradeFromStudentId 保持一致
function gradeFromStudentId(studentId) {
  const m = String(studentId || '').trim().match(/^(\d{4})/);
  if (!m) return '';
  const year = Number(m[1]);
  return year >= 1900 && year <= 2099 ? m[1] : '';
}

// 班级 = 年级后两位 + 专业（如 2023 + 大数据技术 →「23级大数据技术」）
// 已有更细分的班名（如「23级机电1班」）原样保留；年级或专业缺失时保留原值
// 与 server/src/services/roster.js::classNameFromGradeSpecialty 保持一致（落库以服务端为准）
function composeClassName(grade, specialty, current = '') {
  const g = String(grade || '').trim();
  const s = String(specialty || '').trim();
  const cur = String(current || '').trim();
  if (!g || !s) return cur;
  const prefix = `${g.slice(-2)}级${s}`;
  if (cur.indexOf(prefix) === 0 && cur.length > prefix.length) return cur;
  return prefix;
}

const uniq = (arr) => [...new Set((arr || []).filter(Boolean))];
// 把账号「当前值」补进选项首位：值不在组织架构里时（存量脏数据，如从没配过的「机电系」），
// 不显示就会让 picker 回落到第 0 项 —— 管理员看到的是一个**他没选的系部**，保存还把真值改掉。
// 这不是自由输入的后门：只能看见并保留这一个已存在的值，**造不出新名字**。
const ensureValue = (list, current) => (current && !list.includes(current) ? [current, ...list] : list);
const detailValue = (e) => (Array.isArray(e.detail) ? e.detail : (e.detail && e.detail.value) || []);

Page({
  data: {
    id: '', // 有值 = 编辑模式
    mode: 'create',
    // 班主任视角（scope=class）：只能改姓名 / 性别 / 出生日期，学籍字段只读展示。
    // 入口在「用户详情 → 编辑资料」（用户 2026-10-22：班主任没有管理权限也要能编辑本班学生资料）。
    // 数据与保存都走班级域 /api/class/student/:id/*（服务端按班主任+本班学生鉴权）。
    classScope: false,
    classClassName: '',
    role: 'student', // student | teacher（编辑模式下需 permission.manage 才能改）
    account: '',
    initialPassword: '', // 仅创建，留空系统生成
    gender: 0,
    birthdate: '',
    studentId: '',
    gradeText: '', // 按学号前 4 位自动识别的年级（只读展示）
    school: '',
    department: '',
    specialty: '',
    className: '', // 按「年级 + 专业」自动生成（只读展示，落库由服务端推导）
    submitting: false,
    loading: false,
    genders: GENDERS,
    today: '',
    // ===== 院校/系部/专业选择器（选项只来自组织架构 ∪ 存量 observed 节点，**不提供手填**）=====
    optSchool: [],
    optDepartment: [],
    optSpecialty: [],
    orgHints: { school: '', department: '', specialty: '' }, // 某级无可选项时指向「组织架构」页
    schoolIndex: -1,
    departmentIndex: -1,
    specialtyIndex: -1,
    usedSchools: [],
    usedDepartments: [],
    usedSpecialties: [],
    orgTree: [], // /api/org/tree（组织架构原始树）
    filterTree: [], // /filters 的联动树（组织架构 ∪ 存量数据，含只有数据的节点）
    // ===== 权限（需 permission.manage，接口 403 时整块隐藏）=====
    canManagePerms: false,
    isSuper: false,
    permGroups: [],
    groupOptions: [],
    groupNamesText: '',
    permModules: [], // 按模块分组的权限目录（多选）
    groupPickerVisible: false,
    permPickerVisible: false,
    draft: { groups: [], perms: [] },
  },

  onLoad(options) {
    const today = new Date();
    this.setData({
      id: options.id || '',
      mode: options.id ? 'edit' : 'create',
      // 班主任视角：学籍字段只读 + 只提交姓名/性别/生日（服务端 PUT /api/class/student/:id/profile）
      classScope: options.scope === 'class',
      classClassName: options.className ? decodeURIComponent(options.className) : '',
      today: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
    });
    wx.setNavigationBarTitle({
      title: options.scope === 'class' ? '编辑学生资料' : options.id ? '编辑账户' : '创建账户',
    });
    // 班主任视角不加载「账户类型 / 权限 / 组织架构选项」那几套数据：
    // 它们要么只对管理端有意义（权限 / 组织架构），要么服务端会 403（filters 需 user.view）。
    // 少发三个注定失败或无关的请求，也避免 403 弹窗。
    if (options.scope !== 'class') {
      this.loadFilters();
      this.loadOrgTree();
    }
    if (options.id) this.load();
    else this.loadPermEditor(null);
  },

  // 存量数据里的院校/系部/专业：组织树往往是另一套命名，必须并进来否则根本选不到
  async loadFilters() {
    try {
      await getApp().ensureLogin();
      const opt = await auth.get('/api/admin/users/filters');
      this.setData({
        usedSchools: opt.schools || [],
        usedDepartments: opt.departments || [],
        usedSpecialties: opt.specialties || [],
        filterTree: opt.tree || [], // 服务端合并好的联动树（组织架构 ∪ 存量数据）
      });
      this.buildOptions();
      this.tryPrefillOrg(); // filters 可能晚于用户数据返回，加载完再尝试回显一次
    } catch (e) {
      /* 无用户查看权限时忽略：仍可用组织树选项 */
    }
  },

  async loadOrgTree() {
    try {
      await getApp().ensureLogin();
      const tree = await auth.get('/api/org/tree');
      this.setData({ orgTree: tree });
      this.buildOptions();
      this.tryPrefillOrg(); // 组织树可能晚于用户数据返回，加载完再尝试回显一次
    } catch (e) {
      /* 组织树加载失败时，选项仍来自存量数据 */
    }
  },

  // 级联选项：院校 → 系部 → 专业 **逐级按上级收窄**（用户 2026-10-20「希望所有涉及院校、系部、
  // 专业的筛选与选择都是联动的，如选择了教师院才有教师系」）。
  //
  // ⚠️ 不提供「手动输入」（用户 2026-10-21「这个手动输入是什么鬼 组织架构只能有有权限的更改」）：
  //   组织架构的增删改挂在 content.manage（routes/admin/content.js），
  //   账户编辑页只要只读权限就能凭空造一个系部名 —— 那是绕过权限的后门，已整个移除。
  //   选项只可能来自：① 组织架构树（权威）；② /filters 合并的存量 observed 节点（真实存在过的值）。
  //   账号当前值若不在选项里（存量脏数据，如从没配进组织架构的「机电系」，实测 2 人），
  //   由 ensureValue 把它补进列表**保留可见**——既不丢数据，也造不出新名字。
  //
  // 收窄口径（真实数据验证）：
  //  · 选了上级且在树里命中 → 下级严格只给该上级下的节点；命中但子节点为空 = 服务端确认什么都没有，
  //    保持为空（退回全量会塞进别校系部，管理员一选就造出「洋河校区 + 计财系」脏数据）；
  //  · 没选上级 / 上级不在树里 → 给全量（树各层 ∪ 存量），保证绝不空下拉。
  // null = 无层级信息（走全量）；数组（含空数组）= 有层级信息（严格用之）。
  // 级联源优先用 /filters 的 tree（服务端已把组织架构与存量数据合并，含 observed 节点），
  // 退回 /api/org/tree（无 user.view 权限时 filters 会 403）。
  cascadeTree() {
    const d = this.data;
    return d.filterTree && d.filterTree.length ? d.filterTree : d.orgTree || [];
  },

  buildOptions() {
    const d = this.data;
    const tree = this.cascadeTree();
    const schoolNode = tree.find((s) => s.name === d.school) || null;
    const deptNode = schoolNode ? (schoolNode.children || []).find((x) => x.name === d.department) || null : null;
    // childNames：取一个节点的直接子级名字（院校→系部、系部→专业，同一棵树两种用法）
    const childNames = (n) => (n.children || []).map((x) => x.name);
    const specsOf = (s) => (s.children || []).reduce((a, x) => a.concat(childNames(x)), []);

    // 全量兜底（未选上级 / 上级不在树里时用）
    const allDepts = uniq([...tree.reduce((acc, s) => acc.concat(childNames(s)), []), ...d.usedDepartments]);
    const allSpecs = uniq([...tree.reduce((acc, s) => acc.concat(specsOf(s)), []), ...d.usedSpecialties]);

    // null = 无层级信息（走全量）；数组（含空数组，JS 里 truthy 所以 `|| ` 不会误退）=
    // 有层级信息，严格用之。
    const deptNarrow = d.school && schoolNode ? childNames(schoolNode) : null;
    const specNarrow = d.department && deptNode
      ? childNames(deptNode)
      : d.school && schoolNode ? uniq(specsOf(schoolNode)) : null;

    // 每级「组织架构里真正有没有可选项」—— 决定是显示 picker 还是提示去配置页。
    // 用来源数量判断，而不是 optXxx.length：optXxx 里可能只有 ensureValue 补进来的
    // 那一个存量值（如从没配进组织架构的「机电系」），此时 picker 只有一项、点了没意义，
    // 仍应提示去组织架构补，而不是假装"有的选"。
    const deptOpts = deptNarrow || allDepts;
    const specOpts = specNarrow || allSpecs;
    const schoolHas = tree.length > 0;
    const deptHas = deptOpts.length > 0;
    const specHas = specOpts.length > 0;

    const optSchool = ensureValue(uniq([...tree.map((s) => s.name), ...d.usedSchools]), d.school);
    const optDepartment = ensureValue(deptOpts, d.department);
    const optSpecialty = ensureValue(specOpts, d.specialty);

    this.setData({
      optSchool,
      optDepartment,
      optSpecialty,
      schoolIndex: optSchool.indexOf(d.school),
      departmentIndex: optDepartment.indexOf(d.department),
      specialtyIndex: optSpecialty.indexOf(d.specialty),
      // 某级无可选项（组织架构没配到这一层）→ 给出指向配置页的提示，而不是空 picker
      orgHints: {
        school: schoolHas ? '' : '组织架构里还没有院校，请到「组织架构」页添加',
        department: deptHas ? '' : `「${d.school || '该院校'}」下还没有系部，请到「组织架构」页添加`,
        specialty: specHas ? '' : `「${d.department || '该系部'}」下还没有专业，请到「组织架构」页添加`,
      },
    });
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      // 班主任视角：走班级域（服务端校验「是不是本班班主任 + 目标是不是普通学生」）。
      // 不读 /api/admin/users/:id —— 没有 user.view 的班主任那里会 403。
      if (this.data.classScope) {
        const cls = this.data.classClassName || '';
        const r = await auth.get(
          `/api/class/student/${this.data.id}/manage?className=${encodeURIComponent(cls)}`
        );
        const p = (r && r.profile) || {};
        this.originalClassName = p.className || cls;
        this.userDoc = p;
        this.setData({
          role: 'student',
          account: p.realName || p.account || '',
          gender: Number(p.gender) || 0,
          birthdate: p.birthdate ? String(p.birthdate).slice(0, 10) : '',
          studentId: p.studentId || '',
          gradeText: p.grade || gradeFromStudentId(p.studentId) || '',
          school: p.schoolName || '',
          department: p.departmentName || '',
          specialty: p.specialty || '',
          className: p.className || cls,
          loading: false,
        });
        return;
      }
      const { user } = await auth.get(`/api/admin/users/${this.data.id}`);
      const grade = gradeFromStudentId(user.studentId) || user.grade || '';
      this.originalClassName = user.className || '';
      this.userDoc = user;
      this.setData({
        role: user.role || 'student',
        account: user.account || user.realName || '',
        gender: user.gender || 0,
        birthdate: user.birthdate ? String(user.birthdate).slice(0, 10) : '',
        studentId: user.studentId || '',
        gradeText: grade,
        school: user.schoolName || '',
        department: user.departmentName || '',
        specialty: user.specialty || '',
        className: composeClassName(grade, user.specialty, this.originalClassName),
        loading: false,
      });
      this.buildOptions();
      this.tryPrefillOrg();
      this.loadPermEditor(user);
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  // 权限编辑数据（无 permission.manage 时 403，静默降级）
  async loadPermEditor(user) {
    try {
      const { catalog, groups } = await auth.get('/api/admin/permissions');
      const selGroups = (user && user.permissionGroups) || [];
      const selPerms = (user && user.permissions) || [];
      this.setData({
        canManagePerms: true,
        isSuper: selGroups.includes('superadmin'),
        permGroups: groups,
        groupOptions: permUi.buildGroupOptions(groups),
        groupNamesText: permUi.groupNamesText(selGroups, groups),
        permModules: permUi.buildModules(catalog, selPerms),
        draft: { groups: [...selGroups], perms: [...selPerms] },
      });
    } catch (e) {
      this.setData({ canManagePerms: false });
    }
  },

  // 级联树与用户数据都就绪后重算一次选项（两者异步，谁后到谁触发）。
  // 不再单独 prefill index：buildOptions 已按当前 school/department/specialty 值
  // 重算三个 index 并做手填判定，回显只是「值已在 data 里 → buildOptions 收窄」的自然结果。
  tryPrefillOrg() {
    if (!this.userDoc || !this.cascadeTree().length) return;
    this.buildOptions();
  },

  // 班级只读展示：年级（学号）+ 专业 一变就重算
  refreshClassName() {
    const d = this.data;
    this.setData({ className: composeClassName(d.gradeText, d.specialty, this.originalClassName || '') });
  },

  // ===== 三级选择器（只能从组织架构里选，无手填 —— 见 buildOptions 注释）=====
  pickedName(listKey, index) {
    return this.data[listKey][index] || '';
  },

  onSchoolPick(e) {
    const i = Number(e.detail.value);
    this.setData({
      school: this.pickedName('optSchool', i),
      department: '',
      specialty: '',
    });
    this.buildOptions();
    this.refreshClassName();
  },

  onDepartmentPick(e) {
    const i = Number(e.detail.value);
    this.setData({
      department: this.pickedName('optDepartment', i),
      specialty: '',
    });
    this.buildOptions();
    this.refreshClassName();
  },

  onSpecialtyPick(e) {
    const i = Number(e.detail.value);
    this.setData({ specialty: this.pickedName('optSpecialty', i) });
    this.refreshClassName();
  },

  // 跳到组织架构配置页（需要 content.manage，无权限时该页自己会拦）
  goOrganizations() {
    wx.navigateTo({
      url: '/packageAdmin/content/organizations',
      fail: () => wx.showToast({ title: '打开组织架构失败', icon: 'none' }),
    });
  },

  // ===== 账户类型 =====
  pickRole(e) {
    const value = e.currentTarget.dataset.value;
    if (this.data.mode === 'edit' && !this.data.canManagePerms) {
      wx.showToast({ title: '需要「管理用户权限」权限', icon: 'none' });
      return;
    }
    this.setData({ role: value });
  },

  // ===== 权限多选（底部抽屉 + 复选框组）=====
  openGroupPicker() {
    this.setData({ groupPickerVisible: true });
  },

  openPermPicker() {
    this.setData({ permPickerVisible: true });
  },

  closePickers() {
    this.setData({ groupPickerVisible: false, permPickerVisible: false });
  },

  onGroupPickerVisible(e) {
    this.setData({ groupPickerVisible: !!(e.detail && e.detail.visible) });
  },

  onPermPickerVisible(e) {
    this.setData({ permPickerVisible: !!(e.detail && e.detail.visible) });
  },

  onGroupsChange(e) {
    const keys = detailValue(e);
    this.setData({
      'draft.groups': keys,
      groupNamesText: permUi.groupNamesText(keys, this.data.permGroups),
    });
  },

  onModulePermsChange(e) {
    const moduleName = e.currentTarget.dataset.module;
    const mod = (this.data.permModules || []).find((m) => m.name === moduleName);
    if (!mod) return;
    const perms = permUi.mergeModuleKeys(this.data.draft.perms, mod.keys, detailValue(e));
    this.setData({
      'draft.perms': perms,
      permModules: permUi.refreshSelected(this.data.permModules, perms),
    });
  },

  // 权限组管理页
  goGroupManager() {
    wx.navigateTo({ url: '/packageAdmin/permissions/groups' });
  },

  inputAccount(e) {
    this.setData({ account: e.detail.value });
  },

  inputPassword(e) {
    this.setData({ initialPassword: e.detail.value });
  },

  pickGender(e) {
    this.setData({ gender: Number(e.currentTarget.dataset.value) });
  },

  pickBirthdate(e) {
    this.setData({ birthdate: e.detail.value });
  },

  // 学号：同步推导年级与班级（前 4 位）
  inputStudentId(e) {
    const studentId = e.detail.value;
    const gradeText = gradeFromStudentId(studentId);
    this.setData({
      studentId,
      gradeText,
      className: composeClassName(gradeText, this.data.specialty, this.originalClassName || ''),
    });
  },

  // 权限保存（账户类型 + 权限组 + 独立权限，与账户资料分开提交）
  async savePerms(id, role) {
    if (!this.data.canManagePerms) return;
    const { draft } = this.data;
    await auth.put(`/api/admin/users/${id}/permissions`, {
      role,
      permissionGroups: draft.groups,
      permissions: draft.perms,
    });
  },

  async submit() {
    const d = this.data;
    if (d.submitting) return;
    if (!d.account.trim()) {
      wx.showToast({ title: '请填写账号（姓名）', icon: 'none' });
      return;
    }
    // 班主任视角：只提交姓名 / 性别 / 生日（学籍字段服务端会拒绝，前端也不提交）
    if (d.classScope) {
      this.setData({ submitting: true });
      try {
        await getApp().ensureLogin();
        await auth.put(
          `/api/class/student/${d.id}/profile?className=${encodeURIComponent(d.classClassName || '')}`,
          {
            account: d.account.trim(),
            gender: d.gender,
            birthdate: d.birthdate || null,
          }
        );
        wx.showToast({ title: '已保存', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 800);
      } catch (e) {
        wx.showToast({ title: e.message || '保存失败', icon: 'none' });
      } finally {
        this.setData({ submitting: false });
      }
      return;
    }
    if (d.mode === 'create' && d.initialPassword && d.initialPassword.length < 6) {
      wx.showToast({ title: '初始密码至少 6 位', icon: 'none' });
      return;
    }
    if (d.role === 'student' && (!d.school.trim() || !d.department.trim())) {
      wx.showToast({ title: '学生需填写院校与系部', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      await getApp().ensureLogin();
      // 班级不提交：由服务端按「年级(学号前4位) + 专业」统一推导
      // ⚠️ studentId 只对学生提交：教师表单里学号/年级是隐藏的（见 wxml），
      // 但 data.studentId 可能残留「先按学生填了再切教师」的旧值 ——
      // studentId 是唯一稀疏索引，落到教师身上会污染数据，所以教师一律传空（后端空值=不改）。
      const base = {
        account: d.account.trim(),
        gender: d.gender,
        birthdate: d.birthdate || null,
        school: d.school.trim(),
        department: d.department.trim(),
        specialty: d.specialty.trim(),
        studentId: d.role === 'student' ? d.studentId.trim() : '',
      };
      if (d.mode === 'create') {
        const created = await auth.post('/api/admin/users/account', {
          ...base,
          role: d.role,
          initialPassword: d.initialPassword,
        });
        if (d.draft.groups.length || d.draft.perms.length) {
          await this.savePerms(created._id, d.role);
        }
        wx.showModal({
          title: '账户已创建',
          content: `账号：${created.account}\n初始密码：${created.initialPassword}\n\n请立即告知该用户，密码仅显示这一次。`,
          showCancel: false,
          success: () => wx.navigateBack(),
        });
      } else {
        await auth.put(`/api/admin/users/${d.id}/profile`, base);
        await this.savePerms(d.id, d.role);
        wx.showToast({ title: '已保存', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 800);
      }
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
