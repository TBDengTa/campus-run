const mongoose = require('mongoose');

// 宿舍房间（查宿与宿舍卫生的受检对象）
//   className 为房间的**默认归属班级**；实际住宿名单以 dorm_assignments 为准
//   （一间房可能混住多个班 —— 班级得分按该班实际住宿人数分摊，见 services/band-chao.js）
const dormRoomSchema = new mongoose.Schema(
  {
    buildingId: { type: String, default: '' }, // 楼栋标识（如 A / 1号楼）
    buildingName: { type: String, default: '' },
    roomNo: { type: String, required: true },
    floor: { type: String, default: '' },

    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
    departmentName: { type: String, default: '' },
    className: { type: String, default: '', index: true },

    gender: { type: Number, default: 0 }, // 0 未知 1 男 2 女
    capacity: { type: Number, default: 0 },
    residents: { type: Number, default: 0 }, // 当前住宿人数（由 dorm_assignments 刷新，展示用）

    enabled: { type: Boolean, default: true },
    remark: { type: String, default: '' },
  },
  { timestamps: true, collection: 'dorm_rooms' }
);

// 同一楼栋内房号唯一
dormRoomSchema.index({ buildingId: 1, roomNo: 1 }, { unique: true });
dormRoomSchema.index({ buildingName: 1, floor: 1 });

module.exports = mongoose.model('DormRoom', dormRoomSchema, 'dorm_rooms');
