const auth = require('../../../utils/request');

const GENDERS = [
  { value: 1, label: '男' },
  { value: 2, label: '女' },
  { value: 0, label: '保密' },
];

// 年级推导：学号前 4 位即入学年份（如 20230101 → "2023"）
// 与 server/src/services/roster.js::gradeFromStudentId 保持一致，避免两边显示不一致
function gradeFromStudentId(studentId) {
  const m = String(studentId || '').trim().match(/^(\d{4})/);
  if (!m) return '';
  const year = Number(m[1]);
  return year >= 1900 && year <= 2099 ? m[1] : '';
}

// 班级 = 年级后两位 + 专业（如 2023 + 大数据技术 →「23级大数据技术」）
// 已有更细分的班名（如「23级机电1班」）原样保留，避免丢掉班序号；年级或专业缺失时保留原值
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

// WXML 无法调用方法，选中态用映射表
function toMap(arr) {
  const m = {};
  for (const k of arr || []) m[k] = true;
  return m;
}

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
    // ===== 院校/系部/专业级联选择 =====
    hasOrgTree: false,
    orgTree: [],
    schoolNames: [],
    departmentNames: [],
    specialtyNames: [],
    schoolIndex: -1,
    departmentIndex: -1,
    specialtyIndex: -1,
    // ===== 权限（需 permission.manage，接口 403 时静默隐藏） =====
    canManagePerms: false,
    isSuper: false,
    permGroups: [],
    permModules: [], // 按模块分组的权限目录
    draft: { groups: [], perms: [], groupMap: {}, permMap: {} },
  },

  onLoad(options) {
    const today = new Date();
    this.setData({
      id: options.id || '',
      mode: options.id ? 'edit' : 'create',
      today: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
    });
    wx.setNavigationBarTitle({ title: options.id ? '编辑账户' : '创建账户' });
    this.loadOrgTree();
    if (options.id) this.load();
    else this.loadPermEditor(null);
  },

  async loadOrgTree() {
    try {
      await getApp().ensureLogin();
      const tree = await auth.get('/api/org/tree');
      this.setData({
        hasOrgTree: tree.length > 0,
        orgTree: tree,
        schoolNames: tree.map((s) => s.name),
      });
      this.tryPrefillOrg(); // 组织树可能晚于用户数据返回，加载完再尝试回显一次
    } catch (e) {
      /* 组织树加载失败时降级为手填（WXML 按 hasOrgTree 切换为输入框） */
    }
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
      const moduleMap = new Map();
      for (const p of catalog) {
        if (!moduleMap.has(p.module)) moduleMap.set(p.module, []);
        moduleMap.get(p.module).push(p);
      }
      const g = (user && user.permissionGroups) || [];
      const p = (user && user.permissions) || [];
      this.setData({
        canManagePerms: true,
        isSuper: g.includes('superadmin'),
        permGroups: groups,
        permModules: [...moduleMap.entries()].map(([name, list]) => ({ name, list })),
        draft: { groups: [...g], perms: [...p], groupMap: toMap(g), permMap: toMap(p) },
      });
    } catch (e) {
      this.setData({ canManagePerms: false });
    }
  },

  // 组织树与用户数据都就绪后再回显级联索引（两者异步，谁后到谁触发）
  tryPrefillOrg() {
    const u = this.userDoc;
    if (!u || !this.data.orgTree.length) return;
    this.prefillOrg(u.schoolName || '', u.departmentName || '', u.specialty || '');
  },

  // 编辑模式回显：按名称定位 院校/系部/专业 索引
  prefillOrg(schoolName, departmentName, specialtyName) {
    const tree = this.data.orgTree;
    const si = tree.findIndex((s) => s.name === schoolName);
    if (si < 0) {
      this.setData({ schoolIndex: -1, departmentNames: [], departmentIndex: -1, specialtyNames: [], specialtyIndex: -1 });
      return;
    }
    const school = tree[si];
    const departmentNames = (school.children || []).map((x) => x.name);
    const di = departmentName ? departmentNames.indexOf(departmentName) : -1;
    const specialtyNames = di >= 0 ? (school.children[di].children || []).map((x) => x.name) : [];
    const spi = specialtyName ? specialtyNames.indexOf(specialtyName) : -1;
    this.setData({
      schoolIndex: si,
      departmentNames,
      departmentIndex: di,
      specialtyNames,
      specialtyIndex: spi,
    });
  },

  // 班级只读展示：年级（学号）+ 专业 一变就重算
  refreshClassName() {
    const d = this.data;
    this.setData({ className: composeClassName(d.gradeText, d.specialty, this.originalClassName || '') });
  },

  // 院校选择 → 联动系部
  onSchoolPick(e) {
    const i = Number(e.detail.value);
    const school = this.data.orgTree[i];
    if (!school) return;
    this.setData({
      schoolIndex: i,
      school: school.name,
      departmentNames: (school.children || []).map((x) => x.name),
      department: '',
      departmentIndex: -1,
      specialtyNames: [],
      specialty: '',
      specialtyIndex: -1,
    });
    this.refreshClassName();
  },

  // 系部选择 → 联动专业
  onDepartmentPick(e) {
    const i = Number(e.detail.value);
    const school = this.data.orgTree[this.data.schoolIndex];
    const dept = (school.children || [])[i];
    if (!dept) return;
    this.setData({
      departmentIndex: i,
      department: dept.name,
      specialtyNames: (dept.children || []).map((x) => x.name),
      specialty: '',
      specialtyIndex: -1,
    });
    this.refreshClassName();
  },

  // 专业选择 → 重算班级
  onSpecialtyPick(e) {
    const i = Number(e.detail.value);
    const name = this.data.specialtyNames[i];
    if (!name) return;
    this.setData({ specialtyIndex: i, specialty: name });
    this.refreshClassName();
  },

  // ===== 权限组 / 独立权限 =====
  toggleGroup(e) {
    const key = e.currentTarget.dataset.key;
    const groups = [...this.data.draft.groups];
    const groupMap = { ...this.data.draft.groupMap };
    const i = groups.indexOf(key);
    if (i >= 0) {
      groups.splice(i, 1);
      delete groupMap[key];
    } else {
      groups.push(key);
      groupMap[key] = true;
    }
    this.setData({ 'draft.groups': groups, 'draft.groupMap': groupMap });
  },

  togglePerm(e) {
    const key = e.currentTarget.dataset.key;
    const perms = [...this.data.draft.perms];
    const permMap = { ...this.data.draft.permMap };
    const i = perms.indexOf(key);
    if (i >= 0) {
      perms.splice(i, 1);
      delete permMap[key];
    } else {
      perms.push(key);
      permMap[key] = true;
    }
    this.setData({ 'draft.perms': perms, 'draft.permMap': permMap });
  },

  // 账户类型：新建时自由选；编辑时需要「管理用户权限」权限（与保存权限同一接口）
  pickRole(e) {
    const value = e.currentTarget.dataset.value;
    if (this.data.mode === 'edit' && !this.data.canManagePerms) {
      wx.showToast({ title: '需要「管理用户权限」权限', icon: 'none' });
      return;
    }
    this.setData({ role: value });
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
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
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
        // 选了权限组/独立权限时再补一次授权
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
