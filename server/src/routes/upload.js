const express = require('express');
const { wrap, ok, ApiError } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const { makeUploader, publicUploadUrl, unlinkUpload } = require('../utils/uploader');
const FileObject = require('../models/file-object');
const unionSvc = require('../services/union');

const AVATAR_MAX_MB = 2;
const upload = makeUploader({ maxMb: AVATAR_MAX_MB });

// 检查留证照片：现场拍摄需要比头像宽松（头像 2MB 会在原图直传时频繁失败），单张上限 5MB。
// 用**独立的 multer 实例**，不动头像那条链路的大小限制（头像仍然 2MB）。
const CHECK_PHOTO_MAX_MB = 5;
const checkPhotoUpload = makeUploader({ maxMb: CHECK_PHOTO_MAX_MB });

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

// 检查留证照片上传（学生会成员专用）：限 5MB 图片，入库 category='check_photo'。
//
// 与头像的两个**刻意不同点**（改动前请先读这里）：
//   ① **只有学生会成员能传**：检查录入台是学生会职能，非成员上传只会产出无法归属的孤儿文件。
//      用 services/union.js::resolveIdentity 判定（与 /api/union/* 同一套身份口径），非成员 403 + 403002
//      —— 刻意不用 403003：那是「未绑定账号」，会把已登录用户踢回登录页（见 routes/union.js 文件头）。
//   ② **不清理旧文件**：头像会删旧图，检查照片是**留证材料**，删了就没法复核了。不清理是刻意行为。
//
// 前端 uploadFile 默认发 name='file'（见 miniprogram/utils/request.js），这里保持同名。
//
// 成员校验放在 **multer 之前**：非成员时请求根本不会落盘，不留任何孤儿文件
// （multer 已经把文件写进磁盘再回滚，是最容易漏清理的写法）。
//
// 学生会总管（union.steward）也放行（用户 2026-10-21「学生会总管是可以查看检查记录的」＋
// 「所有检查拍照片中可以上传或拍摄多个照片」）：总管通常**不在成员名单里**（团委老师/学生处干事），
// 但 union.steward 的语义是「管理学生会全部事务，含记录与复核」（见 models/permission.js::PERM_IMPLS），
// 他要能补拍留证照片。否则逐张上传时第一张就 403，表现像「只能传一张」。
const assertUnionMember = wrap(async (req, res, next) => {
  const identity = await unionSvc.resolveIdentity(req.user);
  if (identity && identity.isMember) {
    req.unionIdentity = identity;
    return next();
  }
  const perms = (await req.user.getEffectivePermissions()) || [];
  if (perms.includes('union.steward')) {
    // 总管：身份标记为空（scopeFilter/canEnterModule 仍按成员身份判定，不会因此得到录入权）
    req.unionIdentity = identity || null;
    req.unionSteward = true;
    return next();
  }
  throw new ApiError(403, 403002, '你还不是学生会成员，不能上传检查照片');
});

router.post(
  '/check-photo',
  assertUnionMember,
  checkPhotoUpload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw new ApiError(400, 400, '未收到文件');
    const url = publicUploadUrl(req, req.file.filename);
    await FileObject.create({
      filename: req.file.filename,
      originalName: req.file.originalname || '',
      url,
      size: req.file.size || 0,
      mime: req.file.mimetype || '',
      category: 'check_photo',
      uploader: req.user._id,
    });
    ok(res, { url });
  })
);

module.exports = router;
