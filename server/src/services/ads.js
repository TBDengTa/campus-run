const AdContent = require('../models/ad-content');
const AdStat = require('../models/ad-stat');
const { todayKey } = require('../utils/dates');

// 拉取某广告位当日有效的广告，按权重排序
async function pickAdsForSlot(slotKey) {
  const date = todayKey();
  const ads = await AdContent.find({
    slotKey,
    enabled: true,
    $and: [
      { $or: [{ startDate: '' }, { startDate: { $exists: false } }, { startDate: { $lte: date } }] },
      { $or: [{ endDate: '' }, { endDate: { $exists: false } }, { endDate: { $gte: date } }] },
    ],
  })
    .sort({ weight: -1, updatedAt: -1 })
    .limit(20)
    .select('-__v')
    .lean();
  return ads;
}

async function reportStat(contentId, type, openid) {
  const content = await AdContent.findById(contentId);
  if (!content) return null;
  await AdStat.create({
    contentId: content._id,
    slotKey: content.slotKey,
    sponsorId: content.sponsorId,
    type,
    openid: openid || '',
    date: todayKey(),
  });
  const inc = type === 'pv' ? { totalPv: 1 } : { totalClick: 1 };
  await AdContent.updateOne({ _id: content._id }, { $inc: inc });
  return content;
}

module.exports = { pickAdsForSlot, reportStat };
