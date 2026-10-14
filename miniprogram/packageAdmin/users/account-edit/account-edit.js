const auth = require('../../../utils/request');

const GENDERS = [
  { value: 1, label: '男' },
  { value: 2, label: '女' },
  { value: 0, label: '保密' },
];

Page({
  data: {
    id: '', // 有值 = 编辑模式
    mode: 'create',
    role: 'student', // student | teacher
    account: '',
    initialPassword: '', // 仅创建，留空系统生成
    gender: 0,
    birthdate: '',
    studentId: '',
    school: '',
    department: '',
    specialty: '',
    className: '',
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
    } catch (e) {
      /* 组织树加载失败时降级为手填 */
    }
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      const { user } = await auth.get(`/api/admin/users/${this.data.id}`);
      this.setData({
        role: user.role || 'student',
        account: user.account || user.realName || '',
        gender: user.gender || 0,
        birthdate: user.birthdate ? String(user.birthdate).slice(0, 10) : '',
        studentId: user.studentId || '',
        school: user.schoolName || '',
        department: user.departmentName || '',
        specialty: user.specialty || '',
        className: user.className || '',
        loading: false,
      });
      // 编辑模式：按已保存的名称回显级联选择索引
      if (user.schoolName && this.data.orgTree.length) {
        this.prefillOrg(user.schoolName, user.departmentName || '', user.specialty || '');
      }
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  // 编辑模式回显：按名称定位 院校/系部/专业 索引
  prefillOrg(schoolName, departmentName, specialtyName) {
    const si = this.data.orgTree.findIndex((s) => s.name === schoolName);
    if (si < 0) return;
    const school = this.data.orgTree[si];
    const departments = (school.children || []).map((x) => x.name);
    let di = departmentName ? departments.indexOf(departmentName) : -1;
    let specialtyNames = [];
    if (di >= 0) {
      const dept = school.children[di];
      specialtyNames = (dept.children || []).map((x) => x.name);
    }
    this.setData({
      schoolIndex: si,
      departmentNames,
      departmentIndex: di,
      specialtyNames,
      specialtyIndex: specialtyName ? specialtyNames.indexOf(specialtyName) : -1,
    });
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
  },

  // 专业选择
  onSpecialtyPick(e) {
    const i = Number(e.detail.value);
    const name = this.data.specialtyNames[i];
    if (!name) return;
    this.setData({ specialtyIndex: i, specialty: name });
  },

  pickRole(e) {
    if (this.data.mode === 'edit') {
      wx.showToast({ title: '角色请在详情页「权限管理」中调整', icon: 'none' });
      return;
    }
    this.setData({ role: e.currentTarget.dataset.value });
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

  inputStudentId(e) {
    this.setData({ studentId: e.detail.value });
  },

  input(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
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
      const base = {
        account: d.account.trim(),
        gender: d.gender,
        birthdate: d.birthdate || null,
        school: d.school.trim(),
        department: d.department.trim(),
        specialty: d.specialty.trim(),
        className: d.className.trim(),
        studentId: d.studentId.trim(),
      };
      let savedId = d.id;
      if (d.mode === 'create') {
        const created = await auth.post('/api/admin/users/account', {
          ...base,
          role: d.role,
          initialPassword: d.initialPassword,
        });
        savedId = created._id;
        wx.showModal({
          title: '账户已创建',
          content: `账号：${created.account}\n初始密码：${created.initialPassword}\n\n请立即告知该用户，密码仅显示这一次。`,
          showCancel: false,
          success: () => wx.navigateBack(),
        });
      } else {
        await auth.put(`/api/admin/users/${savedId}/profile`, base);
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
