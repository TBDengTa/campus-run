const express = require('express');
const { wrap, ok, ApiError } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const WaterRecord = require('../models/water-record');
const { todayKey } = require('../utils/dates');

const router = express.Router();
router.use(auth);

async function getOrCreate(openid, date) {
  let doc = await WaterRecord.findOne({ openid, date });
  if (!doc) doc = await WaterRecord.create({ openid, date });
  return doc;
}

// 今日喝水记录
router.get(
  '/today',
  wrap(async (req, res) => {
    ok(res, await getOrCreate(req.user.openid, todayKey()));
  })
);

// 记一笔
router.post(
  '/record',
  wrap(async (req, res) => {
    const amount = Number(req.body?.amount);
    if (!amount || amount <= 0 || amount > 2000) {
      throw new ApiError(400, 400, '单次饮水量应在 1-2000ml 之间');
    }
    const type = req.body?.type || '水';
    const doc = await getOrCreate(req.user.openid, todayKey());
    doc.logs.push({ time: new Date(), amount, type });
    doc.total += amount;
    await doc.save();
    ok(res, doc);
  })
);

// 设置每日目标
router.put(
  '/target',
  wrap(async (req, res) => {
    const target = Number(req.body?.target);
    if (!target || target < 500 || target > 6000) {
      throw new ApiError(400, 400, '目标应在 500-6000ml 之间');
    }
    const doc = await getOrCreate(req.user.openid, todayKey());
    doc.target = target;
    await doc.save();
    ok(res, doc);
  })
);

module.exports = router;
