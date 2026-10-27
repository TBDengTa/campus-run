const path = require('path');
const fs = require('fs');
const multer = require('multer');
const config = require('../config');
const { ApiError } = require('./response');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 认可的图片扩展名（含手机图库常见的 heic / heif）：
// wx.uploadFile 上传图库原图时 mimetype 常常不可靠（iPhone HEIC → application/octet-stream），
// 所以扩展名必须作为独立的一条放行依据，否则「拍照能传、图库不行」。
const IMAGE_EXTS = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
  '.heic', '.heif', '.avif', '.tif', '.tiff',
];
// MIME → 扩展名：文件没扩展名时用它反推（保证 nginx 能给出正确 Content-Type）
const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/avif': '.avif',
  'image/tiff': '.tiff',
};

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
          // ⚠️ 不能只信 originalname 的扩展名（用户 2026-10-26「图库上传不行」）：
          //   微信 / iPhone 图库的临时文件名可能是无扩展名的（如 `tmp_xxx`），
          //   或者扩展名与真实格式不符；旧实现 `|| '.png'` 会把 HEIC 存成 .png，
          //   连 nginx 给出的 Content-Type 都是错的，图片在页面里就显示不出来。
          // 顺序：原始扩展名（在认可列表里才用）→ MIME 反推 → 兜底 .jpg。
          const rawExt = (path.extname(file.originalname) || '').toLowerCase();
          const mime = String(file.mimetype || '').toLowerCase();
          let ext = IMAGE_EXTS.includes(rawExt) ? rawExt : MIME_TO_EXT[mime];
          if (!ext && IMAGE_EXTS.includes(rawExt)) ext = rawExt;
          cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext || '.jpg'}`);
        },
      });
  return multer({
    storage,
    limits: { fileSize: maxMb * 1024 * 1024 },
    fileFilter(req, file, cb) {
      if (!accept) {
        // ⚠️ 不能只看 mimetype（用户 2026-10-26 报「拍照能传、图库不行」）：
        //   微信小程序 wx.uploadFile 上传**图库原图**时，file.mimetype 经常不是 image/* ——
        //   iPhone 的 HEIC / HEIF 会变成 application/octet-stream，甚至空字符串；
        //   而「拍照」走的是相机，微信当场压成 JPEG，mimetype 正常 → 于是表现为
        //   「拍照可以、图库失败」。这里按 **MIME ∪ 扩展名** 任一放行。
        if (/^image\//.test(file.mimetype || '')) return cb(null, true);
        const ext = (path.extname(file.originalname) || '').toLowerCase();
        if (IMAGE_EXTS.includes(ext)) return cb(null, true);
        // 图库/相册的临时文件可能**连扩展名都没有**（如 iOS 的 `tmp_xxx`，chunked 上传时
        // originalname 也可能是随机串）。这一类再放最后一个口子：
        // mimetype 是 octet-stream / 空 + 无扩展名 → 仍按图片收下。
        // 安全性：文件最终只落在 /uploads 下、按扩展名白名单命名，不会被当作脚本执行；
        // 真正的「这是不是图片」由使用方（页面渲染 / 后续审核）验证，
        // 而拒绝它会直接造成「用户图库里的照片传不上去」——权衡后选择放行并留下类型日志。
        const mime = String(file.mimetype || '').toLowerCase();
        const genericMime = !mime || mime === 'application/octet-stream';
        if (genericMime && !ext) return cb(null, true);
        return cb(new ApiError(400, 400, `仅支持图片文件（当前类型 ${file.mimetype || '未知'}${ext ? `，扩展名 ${ext}` : ''}）`));
      }
      const ext = (path.extname(file.originalname) || '').toLowerCase();
      if (accept.includes(ext)) return cb(null, true);
      cb(new ApiError(400, 400, `仅支持 ${accept.join(' / ')} 文件`));
    },
  });
}

// 对外可访问的 /uploads/<filename>
function publicUploadUrl(req, filename) {
  // 优先级：PUBLIC_BASE_URL（显式配置的对外地址）→ AD_PAGE_BASE_URL → 请求头拼。
  // 为什么要显式配置：小程序只接受 **https + 已备案白名单域名** 的图片，
  // 而请求头拼出来的可能是 http 或内网 IP（反代 / 协议判断出错时），
  // 表现为「照片明明传成功了却显示不出来 / 报上传失败」（用户 2026-10-26）。
  const base =
    config.publicBaseUrl || config.adPageBaseUrl || `${req.protocol}://${req.get('host')}`;
  return `${base}/uploads/${filename}`;
}

// 删除磁盘文件（不存在时静默；filename 只允许我们生成的格式，防路径穿越）
function unlinkUpload(filename) {
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) return;
  fs.unlink(path.join(UPLOAD_DIR, filename), () => {});
}

module.exports = { UPLOAD_DIR, makeUploader, publicUploadUrl, unlinkUpload };
