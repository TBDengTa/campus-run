const mongoose = require('mongoose');

// 节假日（用于跑步日历特殊日标记）
const holidaySchema = new mongoose.Schema(
  {
    date: { type: String, required: true, unique: true }, // YYYY-MM-DD
    name: { type: String, required: true },
    type: { type: String, default: 'festival' },
    year: { type: Number, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Holiday', holidaySchema, 'holidays');
