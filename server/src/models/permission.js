const mongoose = require('mongoose');

// 权限目录（独立权限项）
const permissionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    module: { type: String, default: '' }, // 所属功能模块，便于管理端分组展示
    sort: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'permissions' }
);

permissionSchema.statics.DEFAULT_CATALOG = [
  { key: 'dashboard.view', name: '查看数据看板', module: '看板', sort: 1 },
  { key: 'user.view', name: '查看用户', module: '用户', sort: 10 },
  { key: 'user.manage', name: '封禁/解封用户', module: '用户', sort: 11 },
  { key: 'user.import', name: '导入学生名单', module: '用户', sort: 12 },
  // 徽章管理（发放 / 回收）：与 content.manage（徽章定义维护）分离——
  // 定义维护是「改规则」，发放回收是「改某个用户的获得记录」，可由不同角色持有
  { key: 'badge.manage', name: '发放与回收徽章', module: '用户', sort: 13 },
  { key: 'appeal.view', name: '查看申诉', module: '申诉', sort: 20 },
  { key: 'appeal.review', name: '审核申诉', module: '申诉', sort: 21 },
  { key: 'ad.view', name: '查看广告数据', module: '广告', sort: 30 },
  { key: 'ad.manage', name: '管理广告（素材/广告位/落地页/上传）', module: '广告', sort: 31 },
  { key: 'content.view', name: '查看内容', module: '内容', sort: 40 },
  { key: 'content.manage', name: '管理内容（公告/版本/节假日/组织/徽章）', module: '内容', sort: 41 },
  { key: 'file.view', name: '查看文件', module: '文件', sort: 45 },
  { key: 'file.manage', name: '管理文件（上传/删除）', module: '文件', sort: 46 },
  { key: 'config.view', name: '查看系统配置', module: '配置', sort: 50 },
  { key: 'config.manage', name: '修改系统配置', module: '配置', sort: 51 },
  // 楼名白名单（教学用楼 / 宿舍用楼，用户 2026-10-22 要求独立权限项）：
  // 为什么不复用 config.view/config.manage —— 那两个覆盖反作弊阈值、跑分参数等**全局计分口径**，
  // 而楼名只是「教室 / 宿舍怎么填」的基础字典。宿管老师需要维护宿舍楼名，
  // 不该因此获得改反作弊阈值与跑分规则的权力。读写也分开：填表的人（班委/班主任）只要能选。
  { key: 'building.view', name: '查看楼名清单', module: '配置', sort: 54 },
  { key: 'building.manage', name: '管理楼名清单（教学楼/宿舍楼）', module: '配置', sort: 55 },
  { key: 'assessment.view', name: '查看运动考核', module: '考核', sort: 52 },
  { key: 'assessment.manage', name: '管理运动考核（默认目标/计划库）', module: '考核', sort: 53 },
  // 学生会 / 班超（班级检查）：查看与管理分开 —— 班主任、学生处干事可以只看，
  // 成员名单、部门、检查模块与计分规则的增删改需要 union.manage
  { key: 'union.view', name: '查看学生会与班超', module: '学生会', sort: 70 },
  { key: 'union.manage', name: '管理学生会（成员/部门/检查模块/班超设置）', module: '学生会', sort: 71 },
  // 学生会总管（用户 2026-10-20 要求新增）：**一个权限覆盖学生会全部事务**。
  // 授予后自动具备 union.view + union.manage（见下方 PERM_IMPLIES），
  // 并且**不要求本人是学生会成员** —— 团委老师 / 学生处干事不必先被加进成员名单也能管理学生会。
  { key: 'union.steward', name: '学生会总管（管理学生会全部事务，含成员与设置）', module: '学生会', sort: 72 },
  // 班级配置（是否有早操 / 是否参加校园跑 / 应到人数 / 应住人数 / 备注）：
  // 读改写分开 —— 学生处、年级组长可以只看；改班级属性会影响录入台对象与出勤率分母，需 class.manage。
  // 注意：班级域 /api/class/* 走成员资格校验（班主任 / 班委），**不看这两个权限项**；
  // 这两项只管管理端 /api/admin/class/*。
  { key: 'class.view', name: '查看班级配置', module: '班级', sort: 73 },
  { key: 'class.manage', name: '管理班级配置（早操/校园跑标记、人数）', module: '班级', sort: 74 },
  { key: 'permission.manage', name: '管理用户权限', module: '权限', sort: 60 },
  // ===== 反作弊 / AI 训练（用户 2026-10-29 要求独立权限组）=====
  // 四项刻意拆开，核心是「标注」与「封禁」分离（用户确认「分开」）：
  //   · 标注会进 AI 训练集，是长期资产，误标只是模型学偏（可纠正）；
  //   · 封禁是不可逆处置，直接影响学生。
  // 让同一人「谁标谁杀」等于没有复核 —— 拆开后走「研判员标注 → 管理员批准封禁」。
  // 也不放进内置「教师管理组」：反作弊能封号，不该默认给所有教师。
  { key: 'anticheat.view', name: '查看反作弊状态台与异常记录', module: '反作弊', sort: 80 },
  { key: 'anticheat.label', name: 'AI 标注（判定作弊/轻微/设备问题/正常）', module: '反作弊', sort: 81 },
  { key: 'anticheat.manage', name: '管理 AI 模型（严谨度档位/重训/自动封禁开关）', module: '反作弊', sort: 82 },
  { key: 'anticheat.ban', name: '执行封禁/解封（反作弊处置）', module: '反作弊', sort: 83 },
];

// 权限蕴含表：持有 key 即自动拥有 values（由 user.js::getEffectivePermissions 在**唯一出口**展开）。
// 为什么放在模型里而不是各处判：管理端中间件、/api/auth/me 的 effectivePermissions、
// 前端导航显隐（nav-groups 按 perm 匹配）全都读同一个有效权限数组 ——
// 只在这里展开一次，三条链路自动一致；漏在某一处判就会出现「入口看得见但接口 403」。
permissionSchema.statics.PERM_IMPLIES = {
  // 学生会总管 = 查看 + 管理学生会（成员、部门、检查模块、班级台账、宿舍、卫生区、记录与导出）
  'union.steward': ['union.view', 'union.manage'],
  // 反作弊（用户 2026-10-29）：能处置的人必然能看列表 —— 否则给了 ban 却打不开待研判页，
  // 只能靠猜 anomalyId 调接口，等于不可用。蕴含关系放在这里展开一次，
  // 有效权限、Web 控制台入口、小程序导航三条链路自动一致。
  'anticheat.label': ['anticheat.view'],
  'anticheat.manage': ['anticheat.view'],
  'anticheat.ban': ['anticheat.view'],
};

permissionSchema.statics.expandImplies = function expandImplies(perms) {
  const map = permissionSchema.statics.PERM_IMPLIES;
  const set = new Set(perms || []);
  for (const [from, to] of Object.entries(map)) {
    if (!set.has(from)) continue;
    for (const p of to) set.add(p);
  }
  return [...set];
};

module.exports = mongoose.model('Permission', permissionSchema);
