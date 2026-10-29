/**
 * 异常记录的**处置**（标注 / 封禁 / 排除）—— 唯一实现。
 *
 * ===== 为什么从 routes/admin/step-anomalies.js 抽出来 =====
 * 用户 2026-10-29 要求新增 Web 控制台（/console），它同样要能标注与封禁。
 * 若控制台另写一套处置逻辑，就会重演历史上踩过的坑
 * （「单条会恢复初始密码、批量不会」「管理端吊销设备令牌、班级域不吊销」）：
 *   · 一边写了 recordFeedback、另一边忘了 → 封禁了但没进 AI 训练集；
 *   · 一边校验 status、另一边不校验 → 重复封禁出双份 ban_records。
 * 所以：**routes 只做鉴权与取参，业务在这里只有一份**，小程序管理端与 Web 控制台共用。
 *
 * ===== 两条正交线（用户 2026-10-29「标注要能分开」）=====
 *   认知线（label）：人怎么看这条数据 → 进 step_labels 喂 AI。权限 anticheat.label。
 *   处置线（status）：要不要限制学生。权限 anticheat.ban。
 *   分开是为了「研判员标注 → 管理员批准」的复核流程（谁标谁杀 = 没有复核）。
 */
const StepAnomaly = require('../models/step-anomaly');
const StepLabel = require('../models/step-label');
const User = require('../models/user');
const anticheat = require('./anticheat');
const acModel = require('./anticheat-model');
const { ApiError } = require('../utils/response');

/**
 * 标注一条异常（四分类，可改判）。
 *
 * device（设备/网络问题）会顺带把记录移出待研判队列 —— 它不是人的问题，
 * 继续留在队列里只会被误封；但 status 走 dismissed 时 handleNote 写明原因，
 * 审计时能区分「人工排除误报」与「设备问题」。
 *
 * @param {string} anomalyId
 * @param {'cheat'|'minor'|'device'|'normal'} label
 * @param {{note?:string, operator?:string}} [opts]
 */
async function labelAnomaly(anomalyId, label, { note = '', operator = '' } = {}) {
  if (!StepLabel.LABEL_KINDS.includes(label)) {
    throw new ApiError(
      400,
      400,
      `label 只能是 ${StepLabel.LABEL_KINDS.join(' / ')}（作弊 / 轻微违规 / 设备网络问题 / 正常）`
    );
  }
  const rec = await StepAnomaly.findById(anomalyId);
  if (!rec) throw new ApiError(404, 404, '异常记录不存在');
  const noteText = String(note || '').slice(0, 200);

  await recordFeedback(rec, label, noteText, operator);

  rec.label = label;
  rec.labeledBy = operator || 'admin';
  rec.labeledAt = new Date();
  if (label === 'device' && rec.status === 'open') {
    rec.status = 'dismissed';
    rec.handleNote = noteText || '标注为设备/网络问题，移出待研判';
    rec.handledBy = rec.labeledBy;
    rec.handledAt = rec.labeledAt;
  }
  await rec.save();

  return {
    labeled: true,
    label,
    labelText: StepLabel.LABEL_TEXT[label],
    // 明确告诉调用方这条有没有进训练集（device 没有），界面要能说明白
    trainable: label !== 'device',
    status: rec.status,
  };
}

/**
 * 封禁（限制微信同步 scope=sync），与自动封禁同一实现（anticheat.manualBan）。
 *
 * 封禁隐含一条 cheat 标注（点封禁 = 判定作弊），但**研判员已标 device 的记录不覆盖**：
 * 设备问题也可能需要处置（比如先让这台手机停同步），把它当作弊样本喂给模型是错的。
 *
 * @param {string} anomalyId
 * @param {{days?:number, note?:string, operator?:string}} [opts]
 */
async function banAnomaly(anomalyId, { days = 7, note = '', operator = '' } = {}) {
  const rec = await StepAnomaly.findById(anomalyId);
  if (!rec) throw new ApiError(404, 404, '异常记录不存在');
  if (rec.status === 'banned') throw new ApiError(400, 400, '该记录已封禁');

  const user = await User.findById(rec.userId);
  if (!user) throw new ApiError(404, 404, '该用户已不存在');

  const finalDays = Math.min(Math.max(Number(days) || 7, 1), 365);
  const noteText = String(note || '').slice(0, 200);
  const reason =
    `步数异常（${(rec.reasons || []).join('、') || '人工研判'}）` + (noteText ? ` · ${noteText}` : '');

  // 人工封禁不 escalate（避免一次操作直接封号）
  await anticheat.manualBan(user, { scope: 'sync', days: finalDays, reason, operator: operator || 'admin' });

  try {
    const label = rec.label || 'cheat';
    await recordFeedback(rec, label, noteText, operator);
    if (!rec.label) {
      rec.label = label;
      rec.labeledBy = operator || 'admin';
      rec.labeledAt = new Date();
    }
  } catch (e) {
    /* 反馈失败不影响封禁本身 */
  }

  rec.status = 'banned';
  rec.handledBy = operator || 'admin';
  rec.handledAt = new Date();
  rec.handleNote = noteText || '管理员手动封禁';
  await rec.save();

  return { banned: true, days: finalDays, reason };
}

/**
 * 排除（标记为正常）= 标注 normal + 移出队列。
 * 误报样本对校准**更重要** —— 它直接决定阈值会不会把正常人推进黑名单。
 */
async function dismissAnomaly(anomalyId, { note = '', operator = '' } = {}) {
  const rec = await StepAnomaly.findById(anomalyId);
  if (!rec) throw new ApiError(404, 404, '异常记录不存在');
  if (rec.status !== 'open') throw new ApiError(400, 400, '该记录已处理');
  const noteText = String(note || '').slice(0, 200);

  try {
    await recordFeedback(rec, 'normal', noteText, operator);
  } catch (e) {
    /* 反馈失败不影响处置 */
  }
  rec.label = 'normal';
  rec.labeledBy = operator || 'admin';
  rec.labeledAt = new Date();
  rec.status = 'dismissed';
  rec.handledBy = rec.labeledBy;
  rec.handledAt = rec.labeledAt;
  rec.handleNote = noteText || '管理员研判为正常';
  await rec.save();

  return { dismissed: true, label: 'normal' };
}

/**
 * 标注 → 落 step_labels + 即时校准 + 升级进度缓存失效（三处动作绑在一起，
 * 避免调用方漏掉 invalidateUpgradeCache 导致界面数字不动）。
 */
async function recordFeedback(rec, label, note, operator) {
  const cheatSide = label === 'cheat' || label === 'minor';
  await acModel.recordFeedback(
    cheatSide, // 兼容第二参 isCheat（device / normal 时为 false）
    rec.modelScore != null ? rec.modelScore : (rec.score || 0) / 100,
    {
      label,
      anomalyId: rec._id,
      userId: rec.userId,
      openid: rec.openid,
      source: rec.source,
      ruleScore: rec.score || 0,
      // 特征快照：将来训练有监督模型要用。不存的话原始记录被清理，这批标注永远无法参与训练。
      features: rec.features || null,
      operator: operator || 'admin',
      note,
    }
  );
  acModel.invalidateUpgradeCache();
}

module.exports = { labelAnomaly, banAnomaly, dismissAnomaly };
