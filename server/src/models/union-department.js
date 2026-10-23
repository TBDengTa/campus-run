const mongoose = require('mongoose');

// 学生会部门字典（校级 / 分院共用一套定义）
//   - 部门 → 检查模块的绑定**只有一个真源**：check_modules.entryDeptKeys（鉴权用的就是它）。
//     本表旧字段 dutyModules 是"另一份手写绑定"，会与真源矛盾（改了模块部门，这行还显示旧的），
//     现已不再作为数据来源：GET /departments 按 entryDeptKeys 反推返回（见 routes/admin/union.js）。
//     字段保留只为兼容存量文档，不再写入。
//   - builtIn 只留给**主席团**：它的 key 被代码当语义常量用于复核权限判定
//     （services/union.js::PRESIDIUM_KEY，20 处引用 `deptKey === 'presidium'`），
//     删掉或改名会让复核权限失效，所以它由播种维护、不可删除、key 不可改。
//     其余部门（含原来内置的生活部/学习部/纪检部）**一律视为普通部门**，
//     学校可自行改名、停用、删除、配置职责（用户 2026-10-21「这几个内置应该不需要内置」）。
const unionDepartmentSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    // school 仅校级 / branch 仅院校 / both 两级都有
    scope: { type: String, enum: ['school', 'branch', 'both'], default: 'both' },
    // ⚠️ 部门归属校区（用户 2026-10-21「现在所有部门都是一个、只是在不同校区显示，我要互不干扰」）。
    //   旧模型只有 scope，而 scope='branch' 的语义是「挂到**所有**校区根下」，
    //   所以北校区的「生活部」必然同时出现在洋河校区 —— 无法表达「北校区叫生活部、洋河叫卫生部」。
    //   现在：schoolId 有值 → **只属于那一个校区**（scope 固定 'branch'）；
    //        schoolId 为空 + scope='school' → 只属于全校；
    //        schoolId 为空 + scope='both' → 全局（两级都有），目前只留给主席团
    //          （分会主席团是真实概念：level='branch' 且 deptKey='presidium'，鉴权按 key 判定，与校区无关）。
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
    /** @deprecated 真源是 check_modules.entryDeptKeys；接口按它反推，本字段不再写入 */
    dutyModules: { type: [String], default: [] },
    sort: { type: Number, default: 0 },
    enabled: { type: Boolean, default: true },
    builtIn: { type: Boolean, default: false },
    remark: { type: String, default: '' },
  },
  { timestamps: true, collection: 'union_departments' }
);

// 启动播种只保证「主席团」一定存在（复核权限依赖它的 key）。
// 三个检查部门仍列在这里，但 builtIn=false 且**只在缺失时创建**：
// 存在即视为学校自己的数据，改名/停用/删除/配职责都不会被启动流程覆盖。
unionDepartmentSchema.statics.DEFAULT_DEPARTMENTS = [
  { key: 'presidium', name: '主席团', scope: 'both', sort: 1, builtIn: true, remark: '只读 + 复核，不参与录入' },
  { key: 'life', name: '生活部', scope: 'both', sort: 10, builtIn: false, remark: '卫生检查（教室 / 宿舍 / 卫生区）' },
  { key: 'study', name: '学习部', scope: 'both', sort: 11, builtIn: false, remark: '晚自习考勤（含在宿舍网课与插班）' },
  { key: 'discipline', name: '纪检部', scope: 'both', sort: 12, builtIn: false, remark: '查宿 / 早操出勤 / 早八出勤' },
];

module.exports = mongoose.model('UnionDepartment', unionDepartmentSchema, 'union_departments');
