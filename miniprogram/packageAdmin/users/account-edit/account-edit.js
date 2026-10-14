const auth = require('../../../utils/request');
const permUi = require('../../../utils/permission-ui');

const GENDERS = [
  { value: 1, label: '男' },
  { value: 2, label: '女' },
  { value: 0, label: '保密' },
];

// 选择器末位的「手动输入」项
const MANUAL = '✎ 手动输入';

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
const withManual = (list) => (list.length ? [...list, MANUAL] : []);
const detailValue = (e) => (Array.isArray(e.detail) ? e.detail : (e.detail && e.detail.value) || []);

Page({
  data: {
    id: '', // 有值 = 编辑模式
    mode: 'create',
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
    // ===== 院校/系部/专业选择器（选项 = 组织树 ∪ 存量数据，末位固定「手动输入」）=====
    optSchool: [],
    optDepartment: [],
    optSpecialty: [],
    manual: { school: false, department: false, specialty: false },
    schoolIndex: -1,
    departmentIndex: -1,
    specialtyIndex: -1,
    usedSchools: [],
    usedDepartments: [],
    usedSpecialties: [],
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
      today: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
    });
    wx.setNavigationBarTitle({ title: options.id ? '编辑账户' : '创建账户' });
    this.loadFilters();
    this.loadOrgTree();
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
      });
      this.buildOptions();
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

  // 选项 = 组织树（按已选上级收窄）+ 存量数据；两套命名都可能缺，合并后才不会「没得选」
  buildOptions() {
    const d = this.data;
    const tree = d.orgTree || [];
    const schoolNode = tree.find((s) => s.name === d.school) || null;
    const deptNode = schoolNode ? (schoolNode.children || []).find((x) => x.name === d.department) : null;

    const optSchool = withManual(uniq([...tree.map((s) => s.name), ...d.usedSchools]));
    const optDepartment = withManual(uniq([...(schoolNode ? (schoolNode.children || []).map((x) => x.name) : []), ...d.usedDepartments]));
    const optSpecialty = withManual(uniq([...(deptNode ? (deptNode.children || []).map((x) => x.name) : []), ...d.usedSpecialties]));

    this.setData({
      optSchool,
      optDepartment,
      optSpecialty,
      schoolIndex: optSchool.indexOf(d.school),
      departmentIndex: optDepartment.indexOf(d.department),
      specialtyIndex: optSpecialty.indexOf(d.specialty),
      // 已有值但不在选项里 → 直接进入手填模式，仍然看得见、改得了
      'manual.school': d.school ? optSchool.indexOf(d.school) < 0 : d.manual.school,
      'manual.department': d.department ? optDepartment.indexOf(d.department) < 0 : d.manual.department,
      'manual.specialty': d.specialty ? optSpecialty.indexOf(d.specialty) < 0 : d.manual.specialty,
    });
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
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

  // 组织树与用户数据都就绪后再回显级联（两者异步，谁后到谁触发）
  tryPrefillOrg() {
    const u = this.userDoc;
    if (!u || !this.data.orgTree.length) return;
    this.prefillOrg(u.schoolName || '', u.departmentName || '', u.specialty || '');
  },

  prefillOrg(schoolName, departmentName, specialtyName) {
    const tree = this.data.orgTree;
    const si = tree.findIndex((s) => s.name === schoolName);
    if (si < 0) return; // 名字不在树里：保留原值，由 buildOptions 走手填/存量选项
    const school = tree[si];
    const departmentNames = (school.children || []).map((x) => x.name);
    this.setData({
      schoolIndex: si,
      departmentNames,
      departmentIndex: departmentName ? departmentNames.indexOf(departmentName) : -1,
    });
  },

  // 班级只读展示：年级（学号）+ 专业 一变就重算
  refreshClassName() {
    const d = this.data;
    this.setData({ className: composeClassName(d.gradeText, d.specialty, this.originalClassName || '') });
  },

  // ===== 三个选择器的选择/手填切换 =====
  pickFrom(listKey, index) {
    return this.data[listKey][index] === MANUAL ? '' : this.data[listKey][index] || '';
  },

  isManual(listKey, index) {
    return this.data[listKey][index] === MANUAL;
  },

  onSchoolPick(e) {
    const i = Number(e.detail.value);
    const manual = this.isManual('optSchool', i);
    this.setData({
      school: this.pickFrom('optSchool', i),
      department: '',
      specialty: '',
      'manual.school': manual,
      'manual.department': false,
      'manual.specialty': false,
    });
    this.buildOptions();
    this.refreshClassName();
  },

  onDepartmentPick(e) {
    const i = Number(e.detail.value);
    const manual = this.isManual('optDepartment', i);
    this.setData({
      department: this.pickFrom('optDepartment', i),
      specialty: '',
      'manual.department': manual,
      'manual.specialty': false,
    });
    this.buildOptions();
    this.refreshClassName();
  },

  onSpecialtyPick(e) {
    const i = Number(e.detail.value);
    const manual = this.isManual('optSpecialty', i);
    this.setData({ specialty: this.pickFrom('optSpecialty', i), 'manual.specialty': manual });
    this.refreshClassName();
  },

  // 手填 → 选已有
  usePicker(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`manual.${field}`]: false });
    this.buildOptions();
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

  input(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
    if (field === 'specialty') this.refreshClassName();
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
      const base = {
        account: d.account.trim(),
        gender: d.gender,
        birthdate: d.birthdate || null,
        school: d.school.trim(),
        department: d.department.trim(),
        specialty: d.specialty.trim(),
        studentId: d.studentId.trim(),
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
