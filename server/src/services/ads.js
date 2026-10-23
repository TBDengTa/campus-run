const AdSlot = require('../models/ad-slot');
const AdContent = require('../models/ad-content');
const AdStat = require('../models/ad-stat');
const { todayKey } = require('../utils/dates');

// 内置广告位播种（幂等）：
//   · 缺失的内置位按 DEFAULT_SLOTS 创建（builtIn: true）
//   · 已存在的内置位只强制 builtIn 标记 + 补齐缺失字段，不覆盖运营改动（名称/开关/限额等）
async function seedAdSlots() {
  let created = 0;
  let patched = 0;
  for (const def of AdSlot.DEFAULT_SLOTS) {
    const existing = await AdSlot.findOne({ key: def.key }).lean();
    if (!existing) {
      await AdSlot.create({ ...def, builtIn: true, enabled: true });
      created += 1;
      continue;
    }
    const patch = {};
    if (existing.builtIn !== true) patch.builtIn = true;
    for (const field of ['name', 'type', 'page', 'maxSponsors', 'exclusive', 'enabled']) {
      const v = existing[field];
      if (v === undefined || v === null || v === '') patch[field] = def[field];
    }
    if (Object.keys(patch).length) {
      await AdSlot.updateOne({ _id: existing._id }, { $set: patch });
      patched += 1;
    }
  }
  if (created || patched) {
    console.log(`[ads] 内置广告位播种完成：新增 ${created} 个，补齐 ${patched} 个`);
  }
  return { created, patched, total: AdSlot.DEFAULT_SLOTS.length };
}

// 拉取某广告位当日有效的广告，按权重排序
//   · 广告位停用 → 不下发
//   · exclusive（独占位）→ 只返回权重最高的一条
//   · maxSponsors → 按广告主去重并限量（同一位最多展示 maxSponsors 条素材）
async function pickAdsForSlot(slotKey) {
  const slot = await AdSlot.findOne({ key: slotKey }).select('enabled exclusive maxSponsors').lean();
  if (slot && slot.enabled === false) return [];

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
    .limit(50)
    .select('-__v')
    .lean();

  // 未登记的广告位（自定义 key 未播种）保持原行为
  if (!slot) return ads.slice(0, 20);
  if (slot.exclusive) return ads.slice(0, 1);
  const max = Math.max(1, Number(slot.maxSponsors) || 1);

  const seenSponsors = new Set();
  const picked = [];
  for (const ad of ads) {
    const sponsor = ad.sponsorId ? String(ad.sponsorId) : '';
    if (sponsor) {
      if (seenSponsors.has(sponsor)) continue;
      seenSponsors.add(sponsor);
    }
    picked.push(ad);
    if (picked.length >= max) break;
  }
  return picked;
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

module.exports = { seedAdSlots, pickAdsForSlot, reportStat };
