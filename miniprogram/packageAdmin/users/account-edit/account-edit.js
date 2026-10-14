const auth = require('../../../utils/request');

const GENDERS = [
  { value: 1, label: '男' },
  { value: 2, label: '女' },
  { value: 0, label: '保密' },
];

// 班级选择器末尾的「手动输入」项
const CLASS_MANUAL_OPTION = '手动输入其他班级';

// 年级推导：学号前 4 位即入学年份（如 20230101 → "2023"）
// 与 server/src/services/roster.js::gradeFromStudentId 保持一致，避免两边显示不一致
function gradeFromStudentId(studentId) {
  const m = String(studentId || '').trim().match(/^(\d{4})/);
  if (!m) return '';
  const year = Number(m[1]);
  return year >= 1900 && year <= 2099 ? m[1] : '';
}

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
    gradeText: '', // 按学号前 4 位自动识别的年级（只读展示）
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
    // ===== 班级选择（取自已有数据；无数据时退化为手填） =====
    classNames: [],
    classPickerRange: [],
    classIndex: -1,
    classManual: false,
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
    this.loadClasses();
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
      this.userDoc = user;
      this.setData({
        role: user.role || 'student',
        account: user.account || user.realName || '',
        gender: user.gender || 0,
        birthdate: user.birthdate ? String(user.birthdate).slice(0, 10) : '',
        studentId: user.studentId || '',
        gradeText: gradeFromStudentId(user.studentId) || user.grade || '',
        school: user.schoolName || '',
        department: user.departmentName || '',
        specialty: user.specialty || '',
        className: user.className || '',
        loading: false,
      });
      this.tryPrefillOrg();
      this.loadClasses(); // 按该用户的系部/专业收窄班级选项
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
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

  // 系部选择 → 联动专业 + 收窄班级选项
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
    this.loadClasses();
  },

  // 专业选择
  onSpecialtyPick(e) {
    const i = Number(e.detail.value);
    const name = this.data.specialtyNames[i];
    if (!name) return;
    this.setData({ specialtyIndex: i, specialty: name });
    this.loadClasses();
  },

  // ===== 班级：优先从已有班级里选，允许手动输入 =====
  async loadClasses() {
    const d = this.data;
    try {
      const res = await auth.get('/api/admin/users/classes', {
        department: d.department || '',
        specialty: d.specialty || '',
      });
      this.setData({ classNames: (res.classes || []).filter(Boolean) });
      this.buildClassPicker();
    } catch (e) {
      // 无权限或接口异常：退化为手动输入
      this.setData({ classNames: [], classPickerRange: [], classIndex: -1 });
    }
  },

  buildClassPicker() {
    const list = this.data.classNames;
    this.setData({
      classPickerRange: list.length ? [...list, CLASS_MANUAL_OPTION] : [],
      classIndex: list.indexOf(this.data.className),
    });
  },

  onClassPick(e) {
    const i = Number(e.detail.value);
    const list = this.data.classNames;
    if (i >= list.length) {
      this.setData({ classManual: true, className: '', classIndex: -1 });
      return;
    }
    this.setData({ className: list[i] || '', classIndex: i, classManual: false });
  },

  useClassInput() {
    this.setData({ classManual: true, className: '', classIndex: -1 });
  },

  useClassPicker() {
    this.buildClassPicker();
    this.setData({ classManual: false });
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

  // 学号：同步推导年级（前 4 位）
  inputStudentId(e) {
    const studentId = e.detail.value;
    this.setData({ studentId, gradeText: gradeFromStudentId(studentId) });
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
