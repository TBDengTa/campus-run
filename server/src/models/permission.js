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
  { key: 'assessment.view', name: '查看运动考核', module: '考核', sort: 52 },
  { key: 'assessment.manage', name: '管理运动考核（默认目标/计划库）', module: '考核', sort: 53 },
  { key: 'permission.manage', name: '管理用户权限', module: '权限', sort: 60 },
];

module.exports = mongoose.model('Permission', permissionSchema);
