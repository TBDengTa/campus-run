// 学生会通讯录（分包 packageUnion）：所有在职成员可查看
//
// 数据来自 /api/union/roster（只读，不下发 openid / 学号）。
// 结构：院校（校学生会 / 北校区学生会）→ 部门 → 成员；院校和部门都可折叠。
// 顶部支持院校 / 系部 / 部门筛选 + 姓名搜索。
const auth = require('../../utils/request');

const DEPT_FALLBACK = '未设置部门';

function schoolValue(row) {
  return row.level === 'school' ? 'school' : `branch:${row.schoolName || ''}`;
}

function schoolTitle(row) {
  if (row.orgTitle) return row.orgTitle;
  return row.level === 'school' ? '校学生会' : `${row.schoolName || '未设院校'}学生会`;
}

Page({
  data: {
    loading: true,
    groups: [],
    total: 0,
    shown: 0,
    keyword: '',
    currentTermName: '',
    currentTermLabel: '',
    currentSessionName: '',
    terms: [],

    schools: [{ value: '', label: '全部院校' }],
    schoolIndex: 0,
    school: '',
    departments: [{ value: '', label: '全部系部' }],
    departmentIndex: 0,
    department: '',
    deptNames: [{ value: '', label: '全部部门' }],
    deptIndex: 0,
    deptName: '',
    hasFilter: false,
  },

  onLoad() {
    if (!getApp().requireLogin()) return;
    this._raw = [];
    this._collapsedOrgs = new Set();
    this._collapsedDepts = new Set();
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLogin();
      const data = await auth.get('/api/union/roster', { limit: 500 });
      this._raw = data.list || [];
      this.setData({
        loading: false,
        total: this._raw.length,
        currentTermName: data.currentTermName || '',
        currentTermLabel: data.currentTermLabel || data.currentTermName || '',
        currentSessionName: data.currentSessionName || '',
        terms: data.terms || [],
      });
      this.refreshOptions({ reset: true });
      this.rebuild();
    } catch (e) {
      this.setData({ loading: false, groups: [], total: 0, shown: 0 });
      wx.showToast({ title: e.message || '没有查看通讯录的权限', icon: 'none' });
    }
  },

  // 筛选选项按当前选择级联：院校 → 系部 → 部门。
  refreshOptions({ reset = false } = {}) {
    const rows = this._raw || [];
    const schoolMap = new Map();
    for (const r of rows) {
      const v = schoolValue(r);
      if (!schoolMap.has(v)) schoolMap.set(v, { value: v, label: schoolTitle(r) });
    }
    const schools = [{ value: '', label: '全部院校' }, ...schoolMap.values()].sort((a, b) => {
      if (!a.value) return -1;
      if (!b.value) return 1;
      if (a.value === 'school') return -1;
      if (b.value === 'school') return 1;
      return a.label.localeCompare(b.label);
    });

    const school = reset ? '' : this.data.school;
    let schoolIndex = schools.findIndex((x) => x.value === school);
    if (schoolIndex < 0) schoolIndex = 0;
    const schoolVal = schools[schoolIndex].value;

    const deptMap = new Map();
    for (const r of rows) {
      if (schoolVal && schoolValue(r) !== schoolVal) continue;
      const name = r.departmentName || '';
      if (name && !deptMap.has(name)) deptMap.set(name, { value: name, label: name });
    }
    const departments = [{ value: '', label: '全部系部' }, ...deptMap.values()];
    let departmentIndex = reset ? 0 : departments.findIndex((x) => x.value === this.data.department);
    if (departmentIndex < 0) departmentIndex = 0;
    const departmentVal = departments[departmentIndex].value;

    const nameMap = new Map();
    for (const r of rows) {
      if (schoolVal && schoolValue(r) !== schoolVal) continue;
      if (departmentVal && (r.departmentName || '') !== departmentVal) continue;
      const name = r.deptName || '';
      if (name && !nameMap.has(name)) nameMap.set(name, { value: name, label: name });
    }
    const deptNames = [{ value: '', label: '全部部门' }, ...nameMap.values()];
    let deptIndex = reset ? 0 : deptNames.findIndex((x) => x.value === this.data.deptName);
    if (deptIndex < 0) deptIndex = 0;

    this.setData({
      schools,
      schoolIndex,
      school: schoolVal,
      departments,
      departmentIndex,
      department: departmentVal,
      deptNames,
      deptIndex,
      deptName: deptNames[deptIndex].value,
    });
  },

  rebuild() {
    const kw = String(this.data.keyword || '').trim();
    const school = this.data.school;
    const department = this.data.department;
    const deptName = this.data.deptName;

    const rows = (this._raw || []).filter((r) => {
      if (school && schoolValue(r) !== school) return false;
      if (department && (r.departmentName || '') !== department) return false;
      if (deptName && (r.deptName || '') !== deptName) return false;
      if (!kw) return true;
      return `${r.realName}${r.className}${r.departmentName}${r.deptName}${r.schoolName}${r.roleText}${r.termName}`.indexOf(kw) >= 0;
    });

    const orgMap = new Map();
    for (const r of rows) {
      const orgKey = schoolValue(r);
      let org = orgMap.get(orgKey);
      if (!org) {
        org = {
          key: orgKey,
          title: schoolTitle(r),
          depts: [],
          memberCount: 0,
          deptMap: new Map(),
        };
        orgMap.set(orgKey, org);
      }
      const deptKey = r.deptName || DEPT_FALLBACK;
      let dept = org.deptMap.get(deptKey);
      if (!dept) {
        dept = { key: deptKey, title: deptKey, members: [] };
        org.deptMap.set(deptKey, dept);
      }
      const name = r.realName || '—';
      dept.members.push({
        id: r.id,
        realName: name,
        initial: name.slice(0, 1),
        roleText: r.roleText || '成员',
        subText: [r.departmentName, r.className, r.termName].filter(Boolean).join(' · '),
        sessionName: r.sessionName || '',
      });
      org.memberCount += 1;
    }

    const groups = [...orgMap.values()]
      .sort((a, b) => (a.key === 'school' ? -1 : b.key === 'school' ? 1 : a.key.localeCompare(b.key)))
      .map((org) => {
        const depts = [...org.deptMap.values()]
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((dept) => ({
            ...dept,
            count: dept.members.length,
            collapsed: this._collapsedDepts.has(`${org.key}|${dept.key}`),
          }));
        return {
          key: org.key,
          title: org.title,
          memberCount: org.memberCount,
          deptCount: depts.length,
          collapsed: this._collapsedOrgs.has(org.key),
          depts,
        };
      });

    this.setData({
      groups,
      shown: rows.length,
      hasFilter: !!(school || department || deptName),
    });
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value || '' }, () => this.rebuild());
  },

  onSchoolChange(e) {
    const idx = Number(e.detail.value) || 0;
    const school = (this.data.schools[idx] || {}).value || '';
    this.setData({ school, schoolIndex: idx, department: '', departmentIndex: 0, deptName: '', deptIndex: 0 }, () => {
      this.refreshOptions();
      this.rebuild();
    });
  },

  onDepartmentChange(e) {
    const idx = Number(e.detail.value) || 0;
    const department = (this.data.departments[idx] || {}).value || '';
    this.setData({ department, departmentIndex: idx, deptName: '', deptIndex: 0 }, () => {
      this.refreshOptions();
      this.rebuild();
    });
  },

  onDeptChange(e) {
    const idx = Number(e.detail.value) || 0;
    const deptName = (this.data.deptNames[idx] || {}).value || '';
    this.setData({ deptName, deptIndex: idx }, () => this.rebuild());
  },

  resetFilters() {
    this.setData(
      { school: '', schoolIndex: 0, department: '', departmentIndex: 0, deptName: '', deptIndex: 0 },
      () => {
        this.refreshOptions();
        this.rebuild();
      }
    );
  },

  toggleOrg(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    if (this._collapsedOrgs.has(key)) this._collapsedOrgs.delete(key);
    else this._collapsedOrgs.add(key);
    this.rebuild();
  },

  toggleDept(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    if (this._collapsedDepts.has(key)) this._collapsedDepts.delete(key);
    else this._collapsedDepts.add(key);
    this.rebuild();
  },
});
