const path = require('path');
const fs = require('fs');
const multer = require('multer');
const config = require('../config');
const { ApiError } = require('./response');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// multer 工厂：默认图片落盘（diskStorage）；memory=true 用内存存储（名单等临时文件，不落盘）；
// accept 缺省校验图片，传扩展名数组（如 ['.xlsx', '.csv']）时按扩展名校验
function makeUploader({ dir = UPLOAD_DIR, maxMb = config.uploadMaxMb, memory = false, accept } = {}) {
  const storage = memory
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination(req, file, cb) {
          cb(null, dir);
        },
        filename(req, file, cb) {
          const ext = (path.extname(file.originalname) || '.png').toLowerCase();
          cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
        },
      });
  return multer({
    storage,
    limits: { fileSize: maxMb * 1024 * 1024 },
    fileFilter(req, file, cb) {
      if (!accept) {
        if (/^image\//.test(file.mimetype)) return cb(null, true);
        return cb(new ApiError(400, 400, '仅支持图片文件'));
      }
      const ext = (path.extname(file.originalname) || '').toLowerCase();
      if (accept.includes(ext)) return cb(null, true);
      cb(new ApiError(400, 400, `仅支持 ${accept.join(' / ')} 文件`));
    },
  });
}

// 对外可访问的 /uploads/<filename>
function publicUploadUrl(req, filename) {
  const base = config.adPageBaseUrl || `${req.protocol}://${req.get('host')}`;
  return `${base}/uploads/${filename}`;
}

// 删除磁盘文件（不存在时静默；filename 只允许我们生成的格式，防路径穿越）
function unlinkUpload(filename) {
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) return;
  fs.unlink(path.join(UPLOAD_DIR, filename), () => {});
}

module.exports = { UPLOAD_DIR, makeUploader, publicUploadUrl, unlinkUpload };
