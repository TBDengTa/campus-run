const express = require('express');
const { wrap, ok, ApiError } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const { makeUploader, publicUploadUrl, unlinkUpload } = require('../utils/uploader');
const FileObject = require('../models/file-object');

const AVATAR_MAX_MB = 2;
const upload = makeUploader({ maxMb: AVATAR_MAX_MB });

const router = express.Router();

router.use(auth);

// 用户头像上传：限 2MB 图片；入库元数据，并清理该用户旧头像（文档 + 磁盘）
router.post(
  '/avatar',
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw new ApiError(400, 400, '未收到文件');
    const url = publicUploadUrl(req, req.file.filename);
    await FileObject.create({
      filename: req.file.filename,
      originalName: req.file.originalname || '',
      url,
      size: req.file.size || 0,
      mime: req.file.mimetype || '',
      category: 'avatar',
      uploader: req.user._id,
    });

    const olds = await FileObject.find({
      uploader: req.user._id,
      category: 'avatar',
      filename: { $ne: req.file.filename },
    });
    for (const old of olds) {
      await old.deleteOne();
      unlinkUpload(old.filename);
    }

    ok(res, { url });
  })
);

module.exports = router;
