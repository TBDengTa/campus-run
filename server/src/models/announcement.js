const mongoose = require('mongoose');

// 公告
const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    content: { type: String, default: '' },
    type: { type: String, default: 'notice' },
    priority: { type: Number, default: 0 },
    enabled: { type: Boolean, default: true },
    startAt: { type: Date },
    endAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Announcement', announcementSchema, 'announcements');
