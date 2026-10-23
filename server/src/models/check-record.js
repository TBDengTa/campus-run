const mongoose = require('mongoose');

// 检查记录主表（单表 + details 明细）：卫生 / 晚自习 / 查宿 / 早操 / 早八共用
//
// 为什么单表：五类检查的「公共维度」完全一致（模块 + 日期 + 时段 + 受检对象 + 检查人 + 复核 + 申诉），
// 只有明细不同；单表让首页总评、班级页、看板、导出**只写一套聚合**。
// 明细结构由 check_modules.fields + services/check-modules.js::normalizeDetails() 双向约束：
// 数据库宽松（Mixed），接口严格（写入前校验、未知字段丢弃）。
const checkRecordSchema = new mongoose.Schema(
  {
    moduleKey: { type: String, required: true },
    date: { type: String, required: true }, // 日历键 YYYY-MM-DD（与全库一致）
    period: { type: String, default: '' },

    targetType: { type: String, enum: ['classroom', 'dorm_room', 'area', 'class'], required: true },
    targetId: { type: String, required: true }, // 班级名 / dorm_rooms._id / sanitary_areas._id
    targetName: { type: String, default: '' }, // 展示名（班级名 / 房间号 / 区域名）

    // 结果归属班级（宿舍与卫生区经映射反查后写入）—— 班级维度查询与排名全靠它
    className: { type: String, default: '', index: true },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
    grade: { type: String, default: '' },

    inspectorOpenid: { type: String, default: '' },
    inspectorName: { type: String, default: '' },
    inspectorDeptKey: { type: String, default: '' },

    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
    score: { type: Number, default: 0 }, // 本条折算分（百分制得分或扣分，语义见模块 scoring.mode）
    deduct: { type: Number, default: 0 }, // 本条折算出的人均/整体扣分（班级总评直接求和）

    photos: { type: [String], default: [] },
    remark: { type: String, default: '' },

    // submitted 已提交（参与统计）/ approved 已复核 / rejected 已退回（不参与统计）
    // cancelled 已取消（如早操临时取消：退出统计，而不是算 0 分）
    status: { type: String, enum: ['submitted', 'approved', 'rejected', 'cancelled'], default: 'submitted' },
    cancelReason: { type: String, default: '' },
    rejectReason: { type: String, default: '' },
    reviewedBy: { type: String, default: '' },
    reviewedByName: { type: String, default: '' },
    reviewedAt: { type: Date, default: null },

    source: { type: String, enum: ['union', 'import', 'appeal'], default: 'union' },
    revision: { type: Number, default: 1 },
    // 修改留痕：[{ revision, at, by, byName, changes: { 字段: { from, to } } }]
    history: { type: [mongoose.Schema.Types.Mixed], default: [] },

    appeal: {
      status: { type: String, enum: ['', 'pending', 'approved', 'rejected'], default: '' },
      reason: { type: String, default: '' },
      byOpenid: { type: String, default: '' },
      byName: { type: String, default: '' },
      byRole: { type: String, default: '' }, // officer 班委 / homeroom 班主任
      at: { type: Date, default: null },
      result: { type: String, default: '' },
      reviewedBy: { type: String, default: '' },
      reviewedAt: { type: Date, default: null },
    },

    voided: { type: Boolean, default: false }, // 管理端作废（软失效，不物理删除）
  },
  { timestamps: true, collection: 'check_records' }
);

// ===== 索引（大集合必须有，见 docs/database-v2.md 约定）=====
// 班级视角：本班某模块历史
checkRecordSchema.index({ className: 1, date: -1, moduleKey: 1 });
// 录入台：某模块某天待复核 / 录入状态
checkRecordSchema.index({ moduleKey: 1, date: 1, status: 1 });
// 分院看板
checkRecordSchema.index({ departmentId: 1, moduleKey: 1, date: -1 });
// 全校当日汇总
checkRecordSchema.index({ date: 1, moduleKey: 1 });
// 「我提交的」
checkRecordSchema.index({ inspectorOpenid: 1, createdAt: -1 });
// 申诉待处理
checkRecordSchema.index({ 'appeal.status': 1, date: -1 });
// 同一「模块 + 受检对象 + 日期 + 时段」只允许一条生效记录（防重复提交 / 防并发双写）。
// ⚠️ 键里必须带 className：混宿房间与共管卫生区一次检查会**按归属班级各存一条**（见 routes/union.js
// 的多班分摊写入），不带 className 的话第二班那条会被唯一索引直接拒掉（曾经的真实事故：宿舍卫生
// 只能记给一个班）。
// cancelled / rejected 不参与唯一约束，因此「取消后可重录」不会被索引拦死。
const UNIQUE_SLOT_KEYS = { moduleKey: 1, targetType: 1, targetId: 1, date: 1, period: 1, className: 1 };
const UNIQUE_SLOT_NAME = 'uniq_slot_active_v2';
checkRecordSchema.index(UNIQUE_SLOT_KEYS, {
  unique: true,
  partialFilterExpression: { status: { $in: ['submitted', 'approved'] } },
  name: UNIQUE_SLOT_NAME,
});
checkRecordSchema.statics.UNIQUE_SLOT = { name: UNIQUE_SLOT_NAME, keys: UNIQUE_SLOT_KEYS, oldName: 'uniq_slot_active' };

// 参与统计的状态（cancelled / rejected / voided 一律排除）
checkRecordSchema.statics.COUNTED_STATUS = ['submitted', 'approved'];

module.exports = mongoose.model('CheckRecord', checkRecordSchema, 'check_records');
