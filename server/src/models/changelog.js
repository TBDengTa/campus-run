const mongoose = require('mongoose');

// 版本更新日志
const changelogSchema = new mongoose.Schema(
  {
    version: { type: String, required: true },
    title: { type: String, default: '' },
    content: { type: String, default: '' },
    date: { type: String, default: '' }, // YYYY-MM-DD
  },
  { timestamps: true }
);

changelogSchema.index({ version: -1 });

module.exports = mongoose.model('Changelog', changelogSchema, 'changelogs');
