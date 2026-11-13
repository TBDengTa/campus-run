const config = require('../config');
const { ApiError } = require('../utils/response');

function notFound(req, res) {
  res.status(404).json({ code: 404, message: '接口不存在' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ code: err.code, message: err.message, ...err.extra });
  }
  if (err.name === 'ValidationError') {
    return res.status(400).json({ code: 400, message: Object.values(err.errors)[0]?.message || '参数错误' });
  }
  if (err.name === 'MulterError') {
    // 用户 2026-10-28「上传不成功要提示原因」：
    //   旧实现一律回「文件超出大小限制」，用户不知道上限多少、也不知道该压还是该换图。
    //   现在把**实际上限**报出来（检查照片已不限体积，0 时回落到其它入口的上限），
    //   并按错误码区分：超大小 / 字段名不对 / 文件数过多 / 分段过多。
    const photoMb = Number(process.env.CHECK_PHOTO_MAX_MB || 0) || 0;
    const limitMb = photoMb > 0 ? photoMb : config.uploadMaxMb;
    let msg = '文件上传失败';
    if (err.code === 'LIMIT_FILE_SIZE') {
      msg = `文件太大：该入口单张上限约 ${limitMb} MB（检查照片入口已取消体积限制），请换更小的文件重试`;
    } else if (err.code === 'LIMIT_FILE_COUNT') {
      msg = '一次上传的文件数量过多';
    } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      msg = '上传字段名不正确（应为 file）';
    } else if (err.code === 'LIMIT_PART_COUNT') {
      msg = '上传内容分段过多，请减少照片数量后重试';
    }
    return res.status(413).json({ code: 413, message: msg, limitMb });
  }
  // nginx 在 Node 之前拦下超限请求时会回 413（请求根本没到业务代码）。
  // 这里兜一道：反代没透传、或 body-parser 抛 413 时，也要给出可读原因。
  if (err.status === 413 || err.statusCode === 413) {
    const photoMb = Number(process.env.CHECK_PHOTO_MAX_MB || 0) || 0;
    return res.status(413).json({
      code: 413,
      message:
        '请求体过大被网关 / 解析器拒绝：检查照片入口已取消体积限制，请确认 Nginx 的 client_max_body_size 设为 0',
      limitMb: photoMb > 0 ? photoMb : 0,
    });
  }
  if (err.code === 11000) {
    return res.status(400).json({ code: 400, message: '数据重复（唯一键冲突）' });
  }
  console.error('[error]', err);
  res.status(500).json({ code: 500, message: '服务器内部错误' });
}

module.exports = { notFound, errorHandler };
