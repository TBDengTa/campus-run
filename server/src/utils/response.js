// 统一响应与错误
class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function ok(res, data = null, message = 'ok') {
  res.json({ code: 0, message, data });
}

function fail(res, status, code, message, extra = {}) {
  res.status(status).json({ code, message, ...extra });
}

// async 路由包装，异常统一交给错误中间件
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parsePagination(query, defaults = { page: 1, limit: 20 }) {
  const page = Math.max(1, parseInt(query.page, 10) || defaults.page);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || defaults.limit));
  return { page, limit, skip: (page - 1) * limit };
}

module.exports = { ApiError, ok, fail, wrap, parsePagination };
