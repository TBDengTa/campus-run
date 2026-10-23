const mongoose = require('mongoose');

// 卫生区（包干区）：班级 ↔ 区域映射
//   一个区域可由多个班级共管（如操场分片），按 weight 权重分摊得分；
//   录入时按区域检查，班级归属由本表反查写入 check_records.className（**不手填班级，避免填错**）
const sanitaryAreaSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    // classroom 教室区 / outdoor 室外区 / corridor 楼道 / canteen 食堂 / other
    areaType: { type: String, default: 'outdoor' },
    location: { type: String, default: '' }, // 位置描述（如「教学楼东侧」）

    // 责任班级（多班共管）
    classNames: { type: [String], default: [], index: true },
    // 各责任班权重，默认均分；求和不必为 1，按比例分摊
    weights: { type: mongoose.Schema.Types.Mixed, default: {} }, // { 班级名: 权重 }

    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
    departmentName: { type: String, default: '' },

    enabled: { type: Boolean, default: true },
    remark: { type: String, default: '' },
  },
  { timestamps: true, collection: 'sanitary_areas' }
);

sanitaryAreaSchema.index({ areaType: 1, enabled: 1 });

// 取某班级的权重（缺省 1，用于共管分摊）
sanitaryAreaSchema.methods.weightOf = function (className) {
  const w = this.weights && typeof this.weights === 'object' ? Number(this.weights[className]) : NaN;
  return Number.isFinite(w) && w > 0 ? w : 1;
};

module.exports = mongoose.model('SanitaryArea', sanitaryAreaSchema, 'sanitary_areas');
