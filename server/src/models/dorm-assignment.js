const mongoose = require('mongoose');

// 住宿名单：学生 ↔ 床位（查宿的「应住人数 / 未归名单 / 网课人数」全部来自这里）
//   导入：管理端 Excel/CSV（楼栋 + 房号 + 学号/姓名）→ services/dorms.js::importAssignments
//   一个学生同一时间只应有一条 active 记录（换房时旧的置 moved 并留痕，不物理删除）
const dormAssignmentSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    openid: { type: String, default: '', index: true },
    realName: { type: String, default: '' },
    studentId: { type: String, default: '' },
    className: { type: String, default: '', index: true },

    roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'DormRoom', default: null },
    buildingId: { type: String, default: '' },
    buildingName: { type: String, default: '' },
    roomNo: { type: String, default: '' },
    bedNo: { type: String, default: '' },

    // checked_in 在住 / moved 已换房 / checked_out 已退宿 / guest 借住
    status: { type: String, enum: ['checked_in', 'moved', 'checked_out', 'guest'], default: 'checked_in' },
    movedTo: { type: String, default: '' }, // 换房后的房号（历史查询用）
    remark: { type: String, default: '' },
  },
  { timestamps: true, collection: 'dorm_assignments' }
);

// 一人一床位（在住状态唯一）；换房/退宿后不占唯一键
dormAssignmentSchema.index(
  { openid: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['checked_in', 'guest'] } }, name: 'uniq_dorm_active' }
);
// 查宿按房间取名单
dormAssignmentSchema.index({ roomId: 1, status: 1 });
dormAssignmentSchema.index({ className: 1, status: 1 });

module.exports = mongoose.model('DormAssignment', dormAssignmentSchema, 'dorm_assignments');
