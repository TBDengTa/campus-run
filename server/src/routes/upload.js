const express = require('express');
const { wrap, ok, ApiError } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const { makeUploader, publicUploadUrl, unlinkUpload } = require('../utils/uploader');
const FileObject = require('../models/file-object');
const unionSvc = require('../services/union');

// 头像上限：原为 2MB，但手机相册原图（尤其 iPhone HEIC / 高像素 JPEG）经常 3~8MB，
// 用户 2026-10-26 报「头像拍照和图库都传不上」就是被这条挡掉的。
// 前端已用 wx.compressImage 压缩（quality 60），这里放宽到 5MB 兜住「压缩失败退回原图」的情况。
// 头像文件只落 /uploads 且按扩展名白名单命名，放宽体积不影响安全。
const AVATAR_MAX_MB = 5;
const upload = makeUploader({ maxMb: AVATAR_MAX_MB });

// 检查留证照片：现场拍摄需要比其它入口宽松得多。用**独立的 multer 实例**，不动头像链路。
//
// 用户要求演进（都记下来，避免以后有人"顺手"调小）：
//   2026-10-26 ① 「现场照片选相册的照片上传错误」→ 相册原图 6~12MB，5MB 上限直接拒掉；
//   2026-10-26 ② 「检查录入照片可以大一点 清晰一点」→ 别为了能传就压得很糊；
//   2026-10-28 ③ 「我希望不限制照片大小，或者限制 100MB」→ 上限提到 **100MB**。
//
// 为什么是 100MB 而不是"完全不限制"：
//   完全不限 = 任何人可以往服务器硬盘灌任意大小的文件（一次上传就能占满磁盘），
//   这在生产上是不可接受的。100MB 已经远超手机原图（iPhone ProRAW 也就 25~75MB），
//   实际上等于"日常不会撞到上限"，同时仍然有一道防滥用闸门。
//
// 上限必须在**三层同时对上**，否则会撞到中间那层却收不到可读的报错：
//   ① 前端 entry.js 的 PHOTO_SAFE_BYTES / 压缩策略
//   ② 本文件 CHECK_PHOTO_MAX_MB（multer fileSize）
//   ③ nginx client_max_body_size（deploy/nginx/*.conf，现为 128m）
// 想再调整不必改代码：设 .env 的 CHECK_PHOTO_MAX_MB（缺省 100）。
const CHECK_PHOTO_MAX_MB = Number(process.env.CHECK_PHOTO_MAX_MB || 100) || 100;
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
