const mongoose = require('mongoose');

// 班级配置（班超的班级维度台账）
//   存在的三个理由：
//   ① 早操 / 早八「本班到底有没有」必须能标记（领导明确点名：有的班级无早操）→ 出勤率分母问题；
//   ② 考勤类应到人数需要默认值（从 users 聚合带出，可覆盖）；
//   ③ 班级的院校 / 系部 / 年级需要冗余，便于分院校看板与按年级筛选（避免每次都 $lookup users）。
//
// 组织层级口径（organizations：school → department → specialty）：
//   「院校」= school 层（schoolId / schoolName），「系部」= department 层（departmentId / departmentName）。
//   命名与用户管理页（packageAdmin/users）的筛选器一致：院校 / 系部 / 年级。
//   两层都由学籍同步带出（users 上同时有 schoolId/schoolName 与 departmentId/departmentName），
//   **不开放手工编辑**：归属跟随组织架构与名单导入（见 routes/admin/class-profile.js 的 PUT 白名单）。
//
// 初始化：services/roster.js::syncClassProfiles()（管理端「从学籍生成」按钮 / 启动期可选），
// 生成后老师可在管理端单条修改（hasMorningExercise 的按年级批量设置也走这里）。
const classProfileSchema = new mongoose.Schema(
  {
    className: { type: String, required: true, unique: true },
    // 院校（organizations 的 school 层）：冗余自 users.schoolId / schoolName
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
    schoolName: { type: String, default: '' },
    // 系部（organizations 的 department 层）
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
    departmentName: { type: String, default: '' },
    grade: { type: String, default: '' },
    specialty: { type: String, default: '' },

    // 以下两个字段是**历史快照**，仅作兜底与兼容存量读取：
    // 应到人数 = 本班在册学生数（users 聚合）、应住人数 = 本班在住学生数（dorm_assignments 聚合）。
    // 页面与接口一律用 services/class-counts.js 实时统计，**不接受手工写入**（写接口会显式拒绝）。
    studentCount: { type: Number, default: 0 },
    dormCount: { type: Number, default: 0 },

    // 是否有早操 / 早八 / 晚自习：false 的班级不进录入台、不计入出勤率分母（见方案 §4.4）
    // 晚自习（用户 2026-10-21「增设班级管理中的晚自习开关，部分班级是没有晚自习的所以不涉及考勤」）：
    // 与早操/早八完全同构 —— 走 band-chao.entryTargets 的同一处跳过逻辑 + 分母过滤。
    hasMorningExercise: { type: Boolean, default: true },
    hasMorningClass: { type: Boolean, default: true },
    hasNightStudy: { type: Boolean, default: true },
    // 是否参加**校园跑**（不是早操！）：与 hasMorningExercise 语义分开，两个都是班级配置项
    //   hasMorningExercise 管早操考勤（录入台对象 + 出勤率分母）；
    //   hasMorningRun 管校园跑相关统计（班级运动榜 / 校园跑参与范围）——「不跑操」的班级两项都可能为 false
    hasMorningRun: { type: Boolean, default: true },

    homeroomNames: { type: [String], default: [] }, // 班主任姓名（展示用，由 users 同步）

    // 本班教室（如「1号教学楼·201」）：卫生检查（教室）录入时显示给检查人核对，
    // 也是管理员在「班级管理」里能直接看到的信息 —— 教室**不参与**任何统计口径，纯展示与核对用。
    // 刻意只存字符串：教室没有独立的实体表，做成 ObjectId 关联要先造一张表并考虑历史数据迁移。
    classroom: { type: String, default: '' },

    enabled: { type: Boolean, default: true },
    // 班级状态（管理端批量设置）：
    //   normal    正常 —— 参加早操 / 早八 / 查宿 / 卫生等班超检查与校园跑统计；
    //   intern    实习 —— 学生仍可登录，但不参加任何班超检查与校园跑（不进榜、不进录入台）；
    //   graduated 毕业 —— 学生不可登录，且不参加任何班超检查与校园跑。
    // 缺省（老数据）按 normal 处理：!== 'intern' && !== 'graduated' 即正常。
    status: { type: String, enum: ['normal', 'intern', 'graduated'], default: 'normal' },
    remark: { type: String, default: '' },
    syncedAt: { type: Date, default: null }, // 最近一次从学籍同步的时间
  },
  { timestamps: true, collection: 'class_profiles' }
);

classProfileSchema.index({ departmentId: 1, grade: 1 });
// 班级管理页的三级筛选「院校 → 系部 → 年级」：按院校（schoolName，筛选值就是它）收敛的路径
// 集合只有几百个班，这条主要是给「分院校看板」留查询口径，不是性能救火。
classProfileSchema.index({ schoolName: 1, departmentId: 1, grade: 1 });
classProfileSchema.index({ hasMorningExercise: 1 });
// 「不跑操」筛选（管理端班级台账 / 班级配置页按校园跑标记过滤）
classProfileSchema.index({ hasMorningRun: 1 });
// 班级状态筛选（正常 / 实习 / 毕业）与「不进榜」查询
classProfileSchema.index({ status: 1 });

// 状态文案与「是否参加班超 / 校园跑」的唯一判定处。
//   normal    正常：全参加
//   intern    实习：学生可登录，但不参加任何班超检查与校园跑统计
//   graduated 毕业：学生不可登录，且不参加任何班超检查与校园跑统计
classProfileSchema.statics.STATUS_TEXT = {
  normal: '正常',
  intern: '实习',
  graduated: '毕业',
};

// 缺省 / 非法值一律当「正常」：老数据没有 status 字段，不能因此被静默排除
classProfileSchema.statics.normalizeStatus = (v) => (v === 'intern' || v === 'graduated' ? v : 'normal');

// 是否参加班超与校园跑统计（实习 / 毕业都不参加）
classProfileSchema.statics.joinsBandChao = (profile) =>
  classProfileSchema.statics.normalizeStatus(profile && profile.status) === 'normal';

module.exports = mongoose.model('ClassProfile', classProfileSchema, 'class_profiles');
