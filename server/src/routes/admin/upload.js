const express = require('express');
const { wrap, ok, ApiError } = require('../../utils/response');
const { makeUploader, publicUploadUrl } = require('../../utils/uploader');
const FileObject = require('../../models/file-object');

const upload = makeUploader();

// 「用途」→ 可上传该用途所需的权限（与 src/routes/admin/index.js 的挂载级权限一致）。
// 挂载级放行 = ad.manage 或 file.manage 或 content.manage（多了 content.manage：徽章图标上传者只需要徽章管理权限）；
// 但挂载级只回答「能不能调用上传接口」，具体能传哪个用途由这张表逐项校验，避免一个权限传遍所有用途。
const CATEGORY_PERMS = {
  ad: ['ad.manage', 'file.manage'],
  other: ['file.manage'],
  badge: ['content.manage'],
};

// 请求体 → 落库用途。未知/缺省值保持原行为落到 'other'（不因为新增校验把老调用方打成 400）。
// avatar 不走管理端上传（用户头像固定走 POST /api/upload/avatar，那里会做旧头像清理），
// 从管理端传 avatar 会产出无人回收的孤儿头像文件，故显式拒绝。
function resolveCategory(raw) {
  if (raw === 'avatar') {
    throw new ApiError(400, 400, '用户头像请走头像上传入口，管理端不支持 avatar 用途');
  }
  return FileObject.CATEGORIES.includes(raw) ? raw : 'other';
}

// 用途级鉴权：调用者必须持有该用途要求的任一权限（持有 '*' 视为全部权限）
function assertCategoryAllowed(req, category) {
  const need = CATEGORY_PERMS[category];
  if (!need || !need.length) return;
  const perms = req.userPermissions || [];
  if (perms.includes('*')) return;
  if (need.some((p) => perms.includes(p))) return;
  const label = category === 'badge' ? '徽章图标' : category === 'ad' ? '广告素材' : '文件';
  throw new ApiError(403, 403002, `无权限（上传${label}需要 ${need.join(' 或 ')}）`);
}

const router = express.Router();

router.post(
  '/',
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw new ApiError(400, 400, '未收到文件');
    const category = resolveCategory(req.body.category);
    assertCategoryAllowed(req, category);
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
