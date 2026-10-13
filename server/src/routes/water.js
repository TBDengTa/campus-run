const express = require('express');
const { wrap, ok, ApiError } = require('../utils/response');
const { auth } = require('../middlewares/auth');
const WaterRecord = require('../models/water-record');
const RunRecord = require('../models/run-record');
const BodyData = require('../models/body-data');
const { todayKey } = require('../utils/dates');

const router = express.Router();
router.use(auth);

// 饮水目标自动计算：体重×30 + 步数/1000×50，按 BMI 系数调整
// BMI 系数：偏轻 0.9 / 正常 1.0 / 超重 1.1 / 偏胖 1.2；未填身体数据时基线 2000ml
async function computeTarget(openid) {
  const [body, werun] = await Promise.all([
    BodyData.findOne({ openid }).lean(),
    RunRecord.findOne({ openid, date: todayKey(), source: 'werun' }).select('steps').lean(),
  ]);
  const todaySteps = werun?.steps || 0;
  const stepBonus = Math.round((todaySteps / 1000) * 50);
  if (!body || !body.weight) {
    const target = 2000 + stepBonus;
    return {
      target: Math.round(target / 50) * 50,
      base: 2000,
      stepBonus,
      bmiFactor: 1,
      hasBodyData: false,
      todaySteps,
      formula: '未填写身体数据：基线 2000ml + 运动补充',
    };
  }
  const bmiFactorMap = { underweight: 0.9, normal: 1.0, overweight: 1.1, obese: 1.2 };
  const bmiFactor = bmiFactorMap[body.bmiLevel] || 1.0;
  const base = Math.round(body.weight * 30);
  const raw = (base + stepBonus) * bmiFactor;
  return {
    target: Math.round(raw / 50) * 50,
    base,
    stepBonus,
    bmiFactor,
    hasBodyData: true,
    todaySteps,
    formula: `体重 ${body.weight}kg × 30 + 步数 ${todaySteps} ÷ 1000 × 50，按 BMI 系数 ${bmiFactor} 调整`,
  };
}

async function getOrCreate(openid, date) {
  let doc = await WaterRecord.findOne({ openid, date });
  if (!doc) doc = await WaterRecord.create({ openid, date });
  return doc;
}

// 今日喝水记录（目标自动计算，用户不可改）
router.get(
  '/today',
  wrap(async (req, res) => {
    const openid = req.user.openid;
    const [doc, targetInfo] = await Promise.all([getOrCreate(openid, todayKey()), computeTarget(openid)]);
    doc.target = targetInfo.target; // 目标始终由系统计算
    await doc.save();
    ok(res, { ...doc.toJSON(), targetInfo });
  })
);

// 历史饮水数据
router.get(
  '/history',
  wrap(async (req, res) => {
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 14));
    const list = await WaterRecord.find({ openid: req.user.openid })
      .sort({ date: -1 })
      .limit(limit)
      .select('date total target logs -_id')
      .lean();
    ok(res, {
      list: list.map((d) => ({
        date: d.date,
        total: d.total,
        target: d.target,
        count: (d.logs || []).length,
        percent: d.target ? Math.min(100, Math.round((d.total / d.target) * 100)) : 0,
      })),
    });
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
    const openid = req.user.openid;
    const [doc, targetInfo] = await Promise.all([getOrCreate(openid, todayKey()), computeTarget(openid)]);
    doc.target = targetInfo.target;
    doc.logs.push({ time: new Date(), amount, type });
    doc.total += amount;
    await doc.save();
    ok(res, { ...doc.toJSON(), targetInfo });
  })
);

module.exports = router;
