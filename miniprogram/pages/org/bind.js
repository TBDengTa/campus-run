const auth = require('../../utils/request');

// 仅用于展示：统计已绑定的院校/班级信息项数
function countBound(user) {
  if (!user) return 0;
  return ['schoolName', 'departmentName', 'specialty', 'className'].filter((k) => !!user[k]).length;
}

Page({
  data: {
    tree: [],
    schools: [],
    departments: [],
    specialties: [],
    schoolIndex: -1,
    departmentIndex: -1,
    specialtyIndex: -1,
    schoolLabel: '请选择学校',
    departmentLabel: '请选择院系',
    specialtyLabel: '请选择专业（可选）',
    realName: '',
    studentId: '',
    className: '',
    specialtyName: '',
    boundCount: 0,
    readOnly: false, // 学生只读：学籍信息由学校名单同步，不能自行修改
    submitting: false,
  },

  onLoad() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    const user = getApp().globalData.userInfo || auth.getUser() || {};
    this.setData({
      realName: user.realName || '',
      studentId: user.studentId || '',
      className: user.className || '',
      specialtyName: user.specialty || '',
      boundCount: countBound(user),
      readOnly: user.role !== 'teacher',
    });
    this.loadTree();
  },

  async loadTree() {
    try {
      await getApp().ensureLogin();
      const tree = await auth.get('/api/org/tree');
      this.setData({
        tree,
        schools: tree.map((s) => s.name),
      });
      // 回显已保存的选择
      const user = getApp().globalData.userInfo || {};
      this.setData({ boundCount: countBound(user), readOnly: user.role !== 'teacher' });
      if (user.schoolName) {
        const si = tree.findIndex((s) => s.name === user.schoolName);
        if (si >= 0) {
          const school = tree[si];
          this.setData({ schoolIndex: si, schoolLabel: user.schoolName, departments: (school.children || []).map((d) => d.name) });
          if (user.departmentName) {
            const di = (school.children || []).findIndex((d) => d.name === user.departmentName);
            if (di >= 0) {
              const dept = school.children[di];
              this.setData({
                departmentIndex: di,
                departmentLabel: user.departmentName,
                specialties: (dept.children || []).map((s) => s.name),
              });
            }
          }
        }
      }
      if (user.specialty) this.setData({ specialtyLabel: user.specialty, specialtyName: user.specialty });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  pickSchool(e) {
    const i = Number(e.detail.value);
    const school = this.data.tree[i];
    this.setData({
      schoolIndex: i,
      schoolLabel: school.name,
      departments: (school.children || []).map((d) => d.name),
      departmentIndex: -1,
      departmentLabel: '请选择院系',
      specialties: [],
      specialtyIndex: -1,
      specialtyLabel: '请选择专业（可选）',
    });
  },

  pickDepartment(e) {
    const i = Number(e.detail.value);
    const school = this.data.tree[this.data.schoolIndex];
    const dept = (school.children || [])[i];
    if (!dept) return;
    this.setData({
      departmentIndex: i,
      departmentLabel: dept.name,
      specialties: (dept.children || []).map((s) => s.name),
      specialtyIndex: -1,
      specialtyLabel: '请选择专业（可选）',
    });
  },

  pickSpecialty(e) {
    const i = Number(e.detail.value);
    const name = this.data.specialties[i];
    this.setData({ specialtyIndex: i, specialtyLabel: name, specialtyName: name });
  },

  inputName(e) {
    this.setData({ realName: e.detail.value });
  },

  inputStudentId(e) {
    this.setData({ studentId: e.detail.value });
  },

  inputClass(e) {
    this.setData({ className: e.detail.value });
  },

  async submit() {
    const { schoolIndex, departmentIndex, tree, realName, studentId, className, specialtyName, submitting } = this.data;
    if (submitting) return;
    if (this.data.readOnly) {
      wx.showToast({ title: '学籍信息由学校名单同步，不能自行修改', icon: 'none' });
      return;
    }
    if (schoolIndex < 0 || departmentIndex < 0) {
      wx.showToast({ title: '请选择学校和院系', icon: 'none' });
      return;
    }
    if (!realName.trim() || !studentId.trim()) {
      wx.showToast({ title: '请填写姓名和学号', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      const school = tree[schoolIndex];
      const dept = school.children[departmentIndex];
      await auth.put('/api/auth/profile', { realName: realName.trim(), studentId: studentId.trim(), className: className.trim() });
      await auth.put('/api/auth/school', {
        schoolId: school._id,
        departmentId: dept._id,
        className: className.trim(),
      });
      if (specialtyName) {
        await auth.put('/api/auth/profile', { specialty: specialtyName });
      }
      await getApp().refreshUser();
      wx.showToast({ title: '认证信息已保存', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
