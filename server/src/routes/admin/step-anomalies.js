/**
 * 管理端 · 步数异常记录（用户 2026-10-27）。
 *
 * 需求原文：
 *   「反作弊系统已经有了自动封禁，还有增加手动封禁列表，
 *     对于有异常但是没到自动封禁的记录进行查看可以进行手动封禁」
 *
 * 动作与权限（用户 2026-10-29 要求独立权限组，「标注」与「封禁」刻意分离）：
 *   GET  /                              待研判列表          → anticheat.view（兼容 user.view）
 *   GET  /upgrade-status /model-status  学习引擎状态        → anticheat.view（兼容 user.view）
 *   POST /:id/label {label}             四分类标注（进训练集）→ anticheat.label
 *   POST /:id/ban  {days,note}          手动封禁            → anticheat.ban（兼容 user.manage）
 *   POST /:id/dismiss                   标记正常（=label normal，旧入口保留）→ anticheat.label
 *
 * 三条权限口径（为什么这样配）：
 * ① 读兼容 user.view：异常记录在旧版就是「用户管理」的附属页，现网教师管理组
 *    只有 user.view 也在天天看；收紧成纯 anticheat.view 会让他们的页面一夜白屏。
 *    （旧实现 GET 竟然**无任何守卫** —— 未挂权限的前缀 + 无 MANAGE，
 *     任何登录用户带 token 都能拉全员疑似作弊清单，本次一并堵上。）
 * ② 标注（label）与封禁（ban）是两个权限：标注进 AI 训练集、可改判；
 *    封禁直接处置学生。分开才能走「研判员标注 → 管理员批准」的复核流程。
 * ③ ban 兼容 user.manage：异常记录里的封禁与「用户管理页的封禁」本就是同一权力
 *    （都是 anticheat.manualBan），要求两个权限项之一即可，不算放松。
 */
const express = require('express');
const { wrap, ok } = require('../../utils/response');
const { requireAnyPermission } = require('../../middlewares/admin');
const StepAnomaly = require('../../models/step-anomaly');
const StepLabel = require('../../models/step-label');
const disposal = require('../../services/anomaly-disposal');

const router = express.Router();

const VIEW = requireAnyPermission(['anticheat.view', 'user.view']);
const LABEL = requireAnyPermission(['anticheat.label']);
const BAN = requireAnyPermission(['anticheat.ban', 'user.manage']);

// 列表：默认只看待研判（open）；也支持查已处置的（banned / dismissed / all）
router.get(
  '/',
  VIEW,
  wrap(async (req, res) => {
    const status = String(req.query.status || 'open');
    const filter = {};
    if (status !== 'all') filter.status = status;
    // 可选按日期过滤（管理端常按「今天」看）
    if (req.query.date) filter.date = String(req.query.date);
    // 按来源分流查看（用户 2026-10-27「微信同步、GPS 分开来」；2026-10-29 界面上也要分）
    if (req.query.source) filter.source = String(req.query.source);
    // 按标注类别筛选（用户 2026-10-29「标注要能分开」）：
    //   'unlabeled' = 还没人标过；其余为四类之一
    const labelQ = String(req.query.label || '');
    if (labelQ === 'unlabeled') filter.label = null;
    else if (StepLabel.LABEL_KINDS.includes(labelQ)) filter.label = labelQ;
    if (req.query.keyword) {
      const kw = String(req.query.keyword).trim();
      // ⚠️ 过滤「字面量 undefined / null」（用户 2026-10-27 报「待研判 85 条但列表空」）：
      //   小程序 GET 传 `{ keyword: undefined }` 时，微信会把它序列化成 `keyword=undefined`。
      //   那是**合法字符串**，不加判断就会被当真关键字，去匹配「姓名含 undefined」→ 结果全空，
      //   而 counted 的徽章仍显示 85，界面自相矛盾。
      //   前端已改成不传空参数；这里再兜一道，避免其它客户端（H5 / 直连 curl）踩同一个坑。
      const isNoise = /^(undefined|null|NaN)$/i.test(kw);
      if (kw && !isNoise) {
        // 正则转义：关键字里可能有 . * + 等，直接拼进 RegExp 会报错或语义错乱
        const safe = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [
          { realName: new RegExp(safe, 'i') },
          { studentId: new RegExp(safe, 'i') },
          { className: new RegExp(safe, 'i') },
        ];
      }
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    // 并发：分页总数、本页数据、四个状态计数、来源×标注矩阵（用户 2026-10-29「标注要能分开」）
    const [total, rows, nOpen, nBanned, nDismissed, nUnlabeled, matrixRows] = await Promise.all([
      StepAnomaly.countDocuments(filter),
      StepAnomaly.find(filter).sort({ score: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      StepAnomaly.countDocuments({ status: 'open' }),
      StepAnomaly.countDocuments({ status: 'banned' }),
      StepAnomaly.countDocuments({ status: 'dismissed' }),
      StepAnomaly.countDocuments({ status: 'open', label: null }),
      // 待研判里 来源×标注 的分布：界面顶部「微信 待标 12 / GPS 待标 3」据此渲染
      StepAnomaly.aggregate([
        { $match: { status: 'open' } },
        { $group: { _id: { source: '$source', label: '$label' }, n: { $sum: 1 } } },
      ]),
    ]);

    const bySourceLabel = {
      werun: { unlabeled: 0, cheat: 0, minor: 0, device: 0, normal: 0 },
      gps: { unlabeled: 0, cheat: 0, minor: 0, device: 0, normal: 0 },
    };
    for (const row of matrixRows) {
      const src = row._id && row._id.source === 'gps' ? 'gps' : 'werun';
      const key = row._id && row._id.label == null ? 'unlabeled' : row._id.label;
      if (bySourceLabel[src][key] != null) bySourceLabel[src][key] += row.n;
    }

    ok(res, {
      page,
      limit,
      total,
      hasMore: skip + rows.length < total,
      // 各状态计数：管理端顶部显示「待处理 N 条」，一眼知道有没有活
      counts: {
        open: nOpen,
        banned: nBanned,
        dismissed: nDismissed,
        // 待标注（open 且没人标过）——「标注要能分开」的入口徽章数
        unlabeled: nUnlabeled,
      },
      // 来源 × 标注 矩阵（待研判范围）
      matrix: bySourceLabel,
      // 标注类别的文案由服务端下发：前端与 Web 台、Excel 导出共用同一份，不再各写一遍
      labelKinds: StepLabel.LABEL_KINDS,
      labelText: StepLabel.LABEL_TEXT,
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
        // 四分类标注（认知线）：与 status（处置线）正交，各自独立展示
        label: r.label || null,
        labelText: r.label ? StepLabel.LABEL_TEXT[r.label] : '未标注',
        labeledBy: r.labeledBy || '',
        labeledAt: r.labeledAt || null,
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
  VIEW,
  wrap(async (req, res) => {
    const acModel = require('../../services/anticheat-model');
    const force = String(req.query.refresh || '') === '1';
    const status = await acModel.checkUpgradeReadiness(force);
    // 顺带下发类别文案：Web 台与小程序共用服务端这一份（避免前端各写一遍漂移）
    ok(res, { ...status, labelText: StepLabel.LABEL_TEXT, labelKinds: StepLabel.LABEL_KINDS });
  })
);

// 模型状态：让管理员能确认「学习引擎在正常工作」，并看到当前自校准阈值
router.get(
  '/model-status',
  VIEW,
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

// ===== 三个处置动作：鉴权 + 取参，业务在 services/anomaly-disposal.js =====
//
// ⚠️ 刻意**不在这里写实现**：Web 控制台（/console）要做同样的标注 / 封禁 / 排除，
//    两边各写一份就会漂移出「一边封禁了、另一边没进 AI 训练集」这类分裂
//    （仓库历史反复踩过：单条会恢复初始密码、批量不会）。
//
// 权限口径（用户 2026-10-29「标注和封禁要分开」）：
//   label / dismiss → anticheat.label（认知线：进训练集，可改判）
//   ban             → anticheat.ban 或 user.manage（处置线：直接限制学生）
//   分开才能走「研判员标注 → 管理员批准封禁」的复核流程（谁标谁杀 = 没有复核）。

// 四分类标注：body { label: 'cheat'|'minor'|'device'|'normal', note? }
// device（设备/网络问题）会顺带移出待研判队列，且**不进训练集**。
// 同一记录重复标注 = 改判（upsert + revision+1）。
router.post(
  '/:id/label',
  LABEL,
  wrap(async (req, res) => {
    ok(
      res,
      await disposal.labelAnomaly(req.params.id, String((req.body || {}).label || ''), {
        note: (req.body || {}).note,
        operator: (req.user && req.user.openid) || 'admin',
      })
    );
  })
);

// 手动封禁（限制微信同步 scope=sync，与自动封禁同一实现）
router.post(
  '/:id/ban',
  BAN,
  wrap(async (req, res) => {
    ok(
      res,
      await disposal.banAnomaly(req.params.id, {
        days: (req.body || {}).days,
        note: (req.body || {}).note,
        operator: (req.user && req.user.openid) || 'admin',
      })
    );
  })
);

// 标记为正常 = 标注 normal + 移出队列（误报样本对阈值校准最重要）
router.post(
  '/:id/dismiss',
  LABEL,
  wrap(async (req, res) => {
    ok(
      res,
      await disposal.dismissAnomaly(req.params.id, {
        note: (req.body || {}).note,
        operator: (req.user && req.user.openid) || 'admin',
      })
    );
  })
);

module.exports = router;
