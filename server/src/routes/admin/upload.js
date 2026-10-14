const express = require('express');
const { wrap, ok, ApiError } = require('../../utils/response');
const { makeUploader, publicUploadUrl } = require('../../utils/uploader');
const FileObject = require('../../models/file-object');

const upload = makeUploader();

const router = express.Router();

router.post(
  '/',
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw new ApiError(400, 400, '未收到文件');
    const category = FileObject.CATEGORIES.includes(req.body.category) ? req.body.category : 'other';
    const url = publicUploadUrl(req, req.file.filename);
    const doc = await FileObject.create({
      filename: req.file.filename,
      originalName: req.file.originalname || '',
      url,
      size: req.file.size || 0,
      mime: req.file.mimetype || '',
      category,
      uploader: req.user && req.user._id,
    });
    ok(res, { id: doc._id, url, category });
  })
);

module.exports = router;
