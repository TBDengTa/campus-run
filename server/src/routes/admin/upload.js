const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const config = require('../../config');
const { wrap, ok, ApiError } = require('../../utils/response');

const uploadDir = path.join(__dirname, '../../../uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, uploadDir);
  },
  filename(req, file, cb) {
    const ext = (path.extname(file.originalname) || '.png').toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.uploadMaxMb * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    cb(new ApiError(400, 400, '仅支持图片文件'));
  },
});

const router = express.Router();

router.post(
  '/',
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw new ApiError(400, 400, '未收到文件');
    const base = config.adPageBaseUrl || `${req.protocol}://${req.get('host')}`;
    ok(res, { url: `${base}/uploads/${req.file.filename}` });
  })
);

module.exports = router;
