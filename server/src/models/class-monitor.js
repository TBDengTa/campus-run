const mongoose = require('mongoose');

// 班长绑定
const classMonitorSchema = new mongoose.Schema(
  {
    openid: { type: String, required: true },
    studentId: { type: String, default: '' },
    className: { type: String, required: true, index: true },
  },
  { timestamps: true }
);

classMonitorSchema.index({ openid: 1 }, { unique: true });

module.exports = mongoose.model('ClassMonitor', classMonitorSchema, 'class_monitors');
