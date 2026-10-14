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
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '文件超出大小限制' : '文件上传失败';
    return res.status(400).json({ code: 400, message: msg });
  }
  if (err.code === 11000) {
    return res.status(400).json({ code: 400, message: '数据重复（唯一键冲突）' });
  }
  console.error('[error]', err);
  res.status(500).json({ code: 500, message: '服务器内部错误' });
}

module.exports = { notFound, errorHandler };
