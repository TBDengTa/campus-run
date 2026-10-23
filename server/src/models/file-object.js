const mongoose = require('mongoose');

// 上传文件元数据（磁盘文件在 server/uploads，这里记录用途与归属，支撑文件管理）
// category 就是文件管理里的「用途/分类」：avatar 用户头像 / ad 广告素材 / badge 徽章图标 /
// check_photo 检查记录现场照片 / other 其它
//
// ⚠️ check_photo 由第四轮新增：学生会录入检查时的现场照片。与 avatar 不同，检查照片**不做旧文件清理**
//   （留证用途，见 routes/upload.js 的 /check-photo）—— 这是刻意行为，不要"顺手"加清理。
//   enum 是闭合的，漏了这项会让 FileObject.create 直接 ValidationError（接口 400 不可用）。
const CATEGORIES = ['avatar', 'ad', 'badge', 'check_photo', 'other'];

const fileObjectSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true, unique: true }, // 磁盘文件名
    originalName: { type: String, default: '' },
    url: { type: String, required: true },
    size: { type: Number, default: 0 }, // 字节
    mime: { type: String, default: '' },
    category: { type: String, enum: CATEGORIES, default: 'other' },
    uploader: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // 头像类必填，管理端上传可空
  },
  { timestamps: true, collection: 'files' }
);

fileObjectSchema.index({ createdAt: -1 });
fileObjectSchema.index({ category: 1, createdAt: -1 });
fileObjectSchema.index({ uploader: 1, category: 1 });

fileObjectSchema.statics.CATEGORIES = CATEGORIES;

module.exports = mongoose.model('FileObject', fileObjectSchema);
