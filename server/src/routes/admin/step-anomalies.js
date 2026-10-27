/**
 * 管理端 · 步数异常记录（用户 2026-10-27）。
 *
 * 需求原文：
 *   「反作弊系统已经有了自动封禁，还有增加手动封禁列表，
 *     对于有异常但是没到自动封禁的记录进行查看可以进行手动封禁」
 *
 * 三个动作：
 *   GET  /api/admin/step-anomalies          → 待研判列表（默认只看 open）
 *   POST /api/admin/step-anomalies/:id/ban  → 手动封禁（限制微信同步 N 天）
 *   POST /api/admin/step-anomalies/:id/dismiss → 标记为「正常」（不再出现）
 *
 * 权限：挂 `user.manage`（与用户列表同一档 —— 这是「处置账号」的动作，
 * 不是只读查看，所以不给 user.view）。
 */
const express = require('express');
const { wrap, ok, ApiError } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const StepAnomaly = require('../../models/step-anomaly');
const User = require('../../models/user');
const anticheat = require('../../services/anticheat');

const router = express.Router();

const MANAGE = requirePermission('user.manage');

// 列表：默认只看待研判（open）；也支持查已处置的（banned / dismissed / all）
router.get(
  '/',
  wrap(async (req, res) => {
    const status = String(req.query.status || 'open');
    const filter = {};
    if (status !== 'all') filter.status = status;
    // 可选按日期过滤（管理端常按「今天」看）
    if (req.query.date) filter.date = String(req.query.date);
    // 按来源分流查看（用户 2026-10-27「微信同步、GPS 分开来」）
    if (req.query.source) filter.source = String(req.query.source);
    if (req.query.keyword) {
      const kw = String(req.query.keyword).trim();
      if (kw) {
        filter.$or = [
          { realName: new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
          { studentId: new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
          { className: new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        ];
      }
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    const [total, rows] = await Promise.all([
      StepAnomaly.countDocuments(filter),
      StepAnomaly.find(filter).sort({ score: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);

    ok(res, {
      page,
      limit,
      total,
      hasMore: skip + rows.length < total,
      // 各状态计数：管理端顶部显示「待处理 N 条」，一眼知道有没有活
      counts: {
        open: await StepAnomaly.countDocuments({ status: 'open' }),
        banned: await StepAnomaly.countDocuments({ status: 'banned' }),
        dismissed: await StepAnomaly.countDocuments({ status: 'dismissed' }),
      },
      list: rows.map((r) => ({
        id: String(r._id),
        userId: String(r.userId),
        realName: r.realName || '未命名',
        className: r.className || '',
        studentId: r.studentId || '',
        date: r.date || '',
        // 来源分流：列表里直接标明这是「微信同步」还是「GPS 实跑」被判定
        source: r.source || 'werun',
        sourceText: r.source === 'gps' ? 'GPS 实跑' : '微信同步',
        cumulativeSteps: r.cumulativeSteps || 0,
        deltaSteps: r.deltaSteps || 0,
        score: r.score || 0,
        // 模型分（0~1）：0.5 是正常基准线，越高越异常。留档便于复核「是规则判的还是模型判的」
        modelScore: r.modelScore == null ? null : Number(r.modelScore),
        modelLevel: r.modelLevel || '',
        reasons: r.reasons || [],
        status: r.status,
        autoBanned: !!r.autoBanned,
        handledAt: r.handledAt || null,
        handleNote: r.handleNote || '',
        createdAt: r.createdAt,
      })),
    });
  })
);

// 升级进度：标注攒够没有（用户 2026-10-27「标注积累到阈值后自动提示升级」）
//
// 前端「步数异常记录」页顶部据此显示进度条与提示文案。
// 单独的接口而不是塞进列表响应：列表是高频刷新的大响应，升级进度变化慢，
// 没必要每次翻页都重算聚合。
router.get(
  '/upgrade-status',
  wrap(async (req, res) => {
    const acModel = require('../../services/anticheat-model');
    const force = String(req.query.refresh || '') === '1';
    const status = await acModel.checkUpgradeReadiness(force);
    ok(res, status);
  })
);

// 模型状态：让管理员能确认「学习引擎在正常工作」，并看到当前自校准阈值
router.get(
  '/model-status',
  wrap(async (req, res) => {
    const acModel = require('../../services/anticheat-model');
    // ⚠️ 不能在这里等待训练（实测：GPS 训练 3 秒、修复前 30 秒，管理端会超时）。
    //   只读缓存；没有缓存就返回 ready=false 并**在后台异步预热**，
    //   下一次刷新就能看到状态。这与「同步链路上的懒加载」互不影响。
    const out = { threshold: acModel.currentThreshold(), models: {} };
    for (const source of ['werun', 'gps']) {
      try {
        const cached = acModel.peekModel(source);
        if (cached) {
          out.models[source] = {
            ready: true,
            trees: cached.forest.length,
            rows: cached.rows,
            trainedAt: new Date(cached.trainedAt),
          };
        } else {
          out.models[source] = { ready: false, trees: 0, rows: 0, trainedAt: null, warming: true };
          // 后台预热，不阻塞本次响应
          acModel.getModel(source).catch(() => {});
        }
      } catch (e) {
        out.models[source] = { ready: false, trees: 0, rows: 0, trainedAt: null };
      }
    }
    ok(res, out);
  })
);

// 手动封禁：限制微信同步（scope=sync），与自动封禁同一实现
router.post(
  '/:id/ban',
  MANAGE,
  wrap(async (req, res) => {
    const rec = await StepAnomaly.findById(req.params.id);
    if (!rec) throw new ApiError(404, 404, '异常记录不存在');
    if (rec.status === 'banned') throw new ApiError(400, 400, '该记录已封禁');

    const user = await User.findById(rec.userId);
    if (!user) throw new ApiError(404, 404, '该用户已不存在');

    const days = Math.min(Math.max(Number((req.body || {}).days) || 7, 1), 365);
    const note = String((req.body || {}).note || '').slice(0, 200);
    const reason =
      `步数异常（${(rec.reasons || []).join('、') || '人工研判'}）` + (note ? ` · ${note}` : '');

    // 走 anticheat（唯一实现）：人工封禁不 escalate（避免一次操作直接封号）
    await anticheat.manualBan(user, {
      scope: 'sync',
      days,
      reason,
      operator: (req.user && req.user.openid) || 'admin',
    });

    // ===== 反馈学习（用户 2026-10-27「自己学习规则与模式」）=====
    // 管理员点「封禁」= 标注「这条确实是作弊」。这条标注会**落库长期积累**
    // （step_labels 集合），既用于即时校准阈值，也是将来升级有监督模型的训练集。
    // 这是系统里**唯一的人工监督信号**，丢了就再也补不回来（所以必须持久化）。
    try {
      const acModel = require('../../services/anticheat-model');
      await acModel.recordFeedback(
        true,
        rec.modelScore != null ? rec.modelScore : (rec.score || 0) / 100,
        {
          anomalyId: rec._id,
          userId: rec.userId,
          openid: rec.openid,
          source: rec.source,
          ruleScore: rec.score || 0,
          // 特征快照：将来训练有监督模型要用。不存的话，一旦原始记录被删，
          // 这批标注就永远无法参与训练（做 ML 数据集最常踩的坑）。
          features: rec.features || null,
          operator: (req.user && req.user.openid) || 'admin',
          note,
        }
      );
      acModel.invalidateUpgradeCache(); // 让「升级进度」立刻刷新
    } catch (e) {
      /* 反馈失败不影响封禁本身 */
    }

    rec.status = 'banned';
    rec.handledBy = (req.user && req.user.openid) || 'admin';
    rec.handledAt = new Date();
    rec.handleNote = note || '管理员手动封禁';
    await rec.save();

    ok(res, { banned: true, days, reason });
  })
);

// 标记为正常：管理员研判后认为不是异常，从待处理列表移除
router.post(
  '/:id/dismiss',
  MANAGE,
  wrap(async (req, res) => {
    const rec = await StepAnomaly.findById(req.params.id);
    if (!rec) throw new ApiError(404, 404, '异常记录不存在');
    if (rec.status !== 'open') throw new ApiError(400, 400, '该记录已处理');

    rec.status = 'dismissed';
    // 反馈学习：管理员点「标记正常」= 标注「这不是作弊」（模型误报）。
    // 误报样本对校准**更重要** —— 它直接决定阈值会不会把正常人推进黑名单。
    // 同样落库长期保存（step_labels），与「封禁」的标注一起构成训练集的两类。
    try {
      const acModel = require('../../services/anticheat-model');
      await acModel.recordFeedback(
        false,
        rec.modelScore != null ? rec.modelScore : (rec.score || 0) / 100,
        {
          anomalyId: rec._id,
          userId: rec.userId,
          openid: rec.openid,
          source: rec.source,
          ruleScore: rec.score || 0,
          features: rec.features || null,
          operator: (req.user && req.user.openid) || 'admin',
          note: String((req.body || {}).note || '').slice(0, 200),
        }
      );
      acModel.invalidateUpgradeCache();
    } catch (e) {
      /* 反馈失败不影响处置 */
    }
    rec.handledBy = (req.user && req.user.openid) || 'admin';
    rec.handledAt = new Date();
    rec.handleNote = String((req.body || {}).note || '管理员研判为正常').slice(0, 200);
    await rec.save();

    ok(res, { dismissed: true });
  })
);

module.exports = router;
