const express = require('express');
const config = require('../config');
const { wrap, ok, ApiError } = require('../utils/response');
const roster = require('../services/roster');

const router = express.Router();

// 学校后台名单推送接口（预留）：Header X-Roster-Key 校验
// body: { rows: [{name, studentId, idCardNo, school, department, className, specialty}] } 或 CSV/JSON 文本
router.post(
  '/push',
  wrap(async (req, res) => {
    if (!config.rosterPushKey) throw new ApiError(403, 403, '推送接口未启用（未配置 ROSTER_PUSH_KEY）');
    const key = req.get('X-Roster-Key') || '';
    if (key !== config.rosterPushKey) throw new ApiError(401, 401, '推送密钥错误');
    const mode = req.body?.mode === 'update' ? 'update' : 'create';
    const rows = roster.parseRows(req.body?.rows || req.body);
    if (!rows.length) throw new ApiError(400, 400, '未解析到数据');
    const result = await roster.importRows(rows, mode);
    ok(res, result);
  })
);

module.exports = router;
