/**
 * 学生会「复审台」：分数分类 + 批量审核的**唯一实现**
 *
 * ===== 为什么单开一个 service（用户 2026-11-02 需求二）=====
 *   「在学生会检查中的复审中，支持分数分类，并对每块显示检查人、检查信息(简化)、检查图片，
 *    并增加批量审核功能。」
 *
 * 三件事必须只有一份实现，否则一定会漂移（本仓库已踩过多次「单条有、批量没有」）：
 *   ① **能不能复核某条记录**（reviewableOf）：单条复核 `/records/:id/review`、
 *      复审队列 `/review/queue`、批量审核 `/review/batch` 三处共用；
 *      历史踩点：批量接口自己写一套判定 → 能批量通过「自己提交的记录」，绕过自审禁令。
 *   ② **复核的写入形态**（reviewOne）：状态、rejectReason、reviewedBy/At、revision、history
 *      必须与单条逐字一致。历史踩点：单条会 push history、批量不会 → 留痕断档，查不出谁改的。
 *   ③ **分数分档**（SCORE_BANDS / bandOf）：队列分组与前端标题、文案都从服务端下发
 *      （前端自己映射一份中文，改档位就会两边不一致）。
 *
 * 权限口径（**刻意不加任何新权限项**）：
 *   与既有的复核权完全一致 —— `services/union.js::canReview(identity, departmentId,
 *   inspectorDeptKey, moduleDef.entryDeptKeys)`（部门部长 / 副主席团）+ 自审禁令
 *   `canSelfReview`（仅主席团可自审）。复审台只是把这些「已经能复核的记录」按分数聚起来，
 *   不扩大任何人的可见范围；队列查询一律再加 `scopeFilter`，越权读不出去。
 */
const CheckRecord = require('../models/check-record');
const checkModules = require('./check-modules');
const bandChao = require('./band-chao');
const unionSvc = require('./union');
const { ApiError } = require('../utils/response');

// ===== 分数分档（用户 2026-11-02「支持分数分类」）=====
// 依据是**本条的扣分**（`record.deduct`，班级总评直接求和的那个数）：
//   · 满分       deduct = 0          —— 大多数记录都在这一档，是最该被批量通过的一批
//   · 轻微扣分   0 < deduct ≤ 0.5
//   · 中等扣分   0.5 < deduct ≤ 1
//   · 较重扣分   deduct > 1          —— 需要逐条看照片与名单再决定
//
// 为什么用扣分而不是「得分 / 评价」：
//   ① `deduct` 是**所有模块都有**的落库字段（hygiene 是 满分−得分，rate 类是 (1−出勤率)×满分，
//      deduct 类是人数折算），而 `score` 只在 percent 模式的模块里有意义（rate/deduct 模块恒为 0）；
//      用 score 分档会把「出勤率 60%」和「扣 0 分」全归到 0 分档，分档直接失真。
//   ② 复审的人真正关心的是「这条要扣多少」，不是「满分制下打了几分」。
//
// ⚠️ 10 分制（用户 2026-11-12）：边界是百分制时代（0/2/5）的**等比 ÷10**，不是重新定severity ——
//   换刻度后「同一条记录落在同一档」是硬要求，否则管理员会看到「昨天还是中等、今天变轻微」，
//   而数据一条都没改。改档位必须同时改 check-union-review.js 的边界逐例断言。
// 边界是闭区间（≤），且**逐档递减判定**：0.5 落「轻微」、0.6 落「中等」、1.0 仍落「中等」。
// 文案（label / hint）随分档一起下发，前端不许自己再写一份中文。
const SCORE_BANDS = [
  { key: 'full', label: '满分', hint: '无扣分', max: 0 },
  { key: 'low', label: '轻微扣分', hint: '0 ~ 0.5 分', max: 0.5 },
  { key: 'mid', label: '中等扣分', hint: '0.5 ~ 1 分', max: 1 },
  { key: 'high', label: '较重扣分', hint: '1 分以上', max: Infinity },
];

/**
 * 扣分 → 分档（**唯一入口**，队列分组与前端展示都用它的结果）
 * @param {number} deduct 记录扣分（可能为 undefined / 负数 / 字符串）
 */
function bandOf(deduct) {
  const n = Number(deduct);
  // 脏数据（undefined / NaN / 负数）一律按「无扣分」处理：比归到「较重」更安全 ——
  // 分档只负责分组展示，真正的判定仍是逐条 canReview，不会因为归档而放宽权限。
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  for (const b of SCORE_BANDS) if (v <= b.max) return b;
  return SCORE_BANDS[SCORE_BANDS.length - 1];
}

/**
 * 检查信息「简化」成一行（用户要求「检查信息(简化)」）
 *
 * 复审时要在一屏里扫几十条，所以只留**最能判断对错**的三样：
 *   · 评价（hygiene 的 优/良/差、晚自习的 网课）—— 一眼能看出录入人对不对
 *   · 关键指标（复用 bandChao.metricText：出勤率 98.5% / 迟到 2 人 / 得分 8 分）
 *   · 备注（截断到 24 字，长备注在详情页看全文）
 * 明细里的**名单**（缺勤/未归/迟到名单）刻意不进摘要 —— 它可能上百人，放进来会把一屏撑爆；
 * 复审员要看名单就点进详情（那里有完整明细）。
 *
 * @param {Object} record check_record（lean 或 doc）
 * @param {Object} moduleDef 模块定义（用于 metricText）
 */
function summarizeRecord(record, moduleDef) {
  const r = record || {};
  const d = r.details || {};
  const parts = [];
  const grade = Array.isArray(d.grade) ? d.grade.filter(Boolean).join('、') : d.grade;
  if (grade) parts.push(`评价 ${grade}`);
  if (moduleDef) {
    const text = bandChao.metricText(moduleDef, [r.metrics || {}], 1);
    if (text) parts.push(text);
  }
  const remark = String(r.remark || '').replace(/\s+/g, ' ').trim();
  if (remark) parts.push(remark.length > 24 ? `${remark.slice(0, 24)}…` : remark);
  return parts.join(' · ');
}

/**
 * 此人能否复核这条记录 —— **唯一判定**（单条 / 队列 / 批量三处共用）
 *
 * @param {Object} record    check_record（lean 或 doc）
 * @param {Object} p
 * @param {Object} p.identity  resolveIdentity 的结果
 * @param {string} p.openid    调用者的 openid（用于自审判定）
 * @param {Object} p.moduleDef 该记录所属模块定义（可缺省：缺省时只用 inspectorDeptKey 判定）
 * @returns {{ ok: boolean, reason: string }}
 */
function reviewableOf(record, { identity, openid, moduleDef } = {}) {
  if (!record) return { ok: false, reason: '记录不存在' };
  if (record.voided) return { ok: false, reason: '记录已作废' };
  if (record.status !== 'submitted') {
    return { ok: false, reason: record.status === 'approved' ? '该记录已复核' : '该记录不在待复核状态' };
  }
  const dep = record.departmentId ? String(record.departmentId) : '';
  const okPerm = unionSvc.canReview(
    identity,
    dep,
    record.inspectorDeptKey,
    (moduleDef && moduleDef.entryDeptKeys) || []
  );
  if (!okPerm) return { ok: false, reason: '只有部门部长或主席团可以复核记录' };
  // 禁止自审：**仅对非主席团**生效（与单条复核逐字同一口径，见 services/union.js::canSelfReview）
  if (record.inspectorOpenid && record.inspectorOpenid === openid && !unionSvc.canSelfReview(identity)) {
    return { ok: false, reason: '不能复核自己提交的记录' };
  }
  return { ok: true, reason: '' };
}

/**
 * 写入复核结果（**唯一写入口**）—— 单条复核与批量复核都必须走这里
 *
 * 与旧单条实现逐字一致（见 routes/union.js 历史实现），四样留痕一个都不能少：
 *   status / rejectReason / reviewedBy + reviewedByName + reviewedAt / revision+history。
 *
 * @param {Object} p
 * @param {Object} p.record     mongoose 文档（**不是 lean**，需要 save）
 * @param {Object} p.user       当前用户（req.user）
 * @param {Object} p.identity   学生会身份
 * @param {Object} p.moduleDef  该记录的模块定义
 * @param {boolean} p.approve   true 通过 / false 退回
 * @param {string} p.reason     退回原因（≥2 字，由调用方先校验文案）
 * @returns {Object} record（已保存）
 */
async function reviewOne({ record, user, identity, moduleDef, approve, reason }) {
  const openid = (user && user.openid) || '';
  const check = reviewableOf(record, { identity, openid, moduleDef });
  if (!check.ok) {
    // 403 + 403002：与既有复核接口保持同一个业务码（客户端据此区分「没权限」与「参数错」）
    throw new ApiError(check.reason === '记录不存在' ? 404 : 403, check.reason === '记录不存在' ? 404 : 403002, check.reason);
  }
  const fromStatus = record.status;
  record.status = approve ? 'approved' : 'rejected';
  record.rejectReason = approve ? '' : String(reason || '').slice(0, 200);
  record.reviewedBy = openid;
  record.reviewedByName = (user && (user.realName || user.nickname)) || '';
  record.reviewedAt = new Date();
  record.revision = (record.revision || 1) + 1;
  record.history = [
    ...(record.history || []).slice(-19),
    {
      revision: record.revision,
      at: new Date(),
      by: openid,
      byName: record.reviewedByName,
      changes: { status: { from: fromStatus, to: record.status }, rejectReason: { to: record.rejectReason } },
    },
  ];
  await record.save();
  return record;
}

/**
 * 批量复核（**逐条**走 reviewOne，不做任何「跳过校验」的捷径）
 *
 * 为什么要逐条而不是 bulkWrite：
 *   ① 每条记录的可见/可复核范围不同（部门、院系、自审），批量写会绕开判定；
 *   ② 一条失败不能让整批回滚 —— 用户点了 10 条，其中 3 条是「自己提交的」，
 *      正确行为是「通过 7 条 + 明确告诉他那 3 条为什么没通过」，而不是整批报错。
 *
 * @param {Object} p
 * @param {string[]} p.ids
 * @param {Object} p.user / p.identity
 * @param {boolean} p.approve
 * @param {string} p.reason
 * @param {number} [p.limit=50] 单次上限（防止一次点全库）
 * @returns {{ results: Array, success: number, failed: number }}
 */
async function reviewBatch({ ids, user, identity, approve, reason, limit = 50 }) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x || '')).filter(Boolean))].slice(
    0,
    limit
  );
  if (!wanted.length) throw new ApiError(400, 400, '请选择要审核的记录');
  const valid = wanted.filter((id) => /^[0-9a-fA-F]{24}$/.test(id));
  const invalid = wanted.filter((id) => !/^[0-9a-fA-F]{24}$/.test(id));

  const modules = await checkModules.listModules();
  const byKey = new Map(modules.map((m) => [m.key, m]));

  const docs = valid.length ? await CheckRecord.find({ _id: { $in: valid }, voided: { $ne: true } }) : [];
  const found = new Map(docs.map((d) => [String(d._id), d]));
  const results = [];
  for (const id of invalid) results.push({ id, ok: false, message: '记录标识不合法' });

  for (const id of wanted) {
    if (invalid.includes(id)) continue;
    const doc = found.get(id);
    if (!doc) {
      results.push({ id, ok: false, message: '记录不存在或已被删除' });
      continue;
    }
    try {
      await reviewOne({ record: doc, user, identity, moduleDef: byKey.get(doc.moduleKey), approve, reason });
      results.push({ id, ok: true, message: approve ? '已复核' : '已退回' });
    } catch (e) {
      results.push({ id, ok: false, message: e.message || '操作失败', code: e.code });
    }
  }
  const success = results.filter((r) => r.ok).length;
  return { results, success, failed: results.length - success };
}

/**
 * 某个分档的 Mongo 查询条件（**唯一实现**）
 *
 * 复审队列的「点分档看这一档」必须与 SCORE_BANDS 同源：前端只传 band key，
 * 区间一律由这里拼 —— 否则改档位边界时，队列条件不会跟着动（能选、但筛出来的还是旧区间）。
 *
 * 注意「满分档」用 `$not: { $gt: 0 }` 而不是 `deduct: 0`：历史记录里有没写 deduct 的
 * （早期记录 / 部分模块），它们事实上就是「无扣分」，用等值会把这批人从"满分"里漏掉。
 *
 * @param {string} key full | low | mid | high（非法 / 空 → null = 不筛）
 */
function bandCond(key) {
  const band = SCORE_BANDS.find((b) => b.key === String(key || ''));
  if (!band) return null;
  if (band.key === 'full') return { deduct: { $not: { $gt: 0 } } };
  const prev = SCORE_BANDS[SCORE_BANDS.indexOf(band) - 1];
  const cond = { $gt: prev.max };
  if (band.max !== Infinity) cond.$lte = band.max;
  return { deduct: cond };
}

module.exports = {
  SCORE_BANDS,
  bandOf,
  bandCond,
  summarizeRecord,
  reviewableOf,
  reviewOne,
  reviewBatch,
};
