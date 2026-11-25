const express = require('express');
const { wrap, ok, ApiError } = require('../../utils/response');
const { requirePermission } = require('../../middlewares/admin');
const GoalConfig = require('../../models/goal-config');
const pointsSvc = require('../../services/points');
const rewardVideoSvc = require('../../services/reward-video');
const beidouSvc = require('../../services/beidou');
const acSvc = require('../../services/anticheat-config');

const router = express.Router();

/**
 * 楼名清单规范化（用户 2026-10-21）：
 * 去掉首尾空白、丢掉空项、按原顺序去重、单个楼名截断到 20 字、每类最多 60 个。
 * 为什么要在这里统一清洗：楼名会与门牌号拼成「楼名·门牌号」落库，
 * 带空格或重复项会直接污染存量数据（「1号教学楼」与「1号教学楼 」变成两个楼）。
 */
function normalizeBuildings(input) {
  const clean = (arr) => {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(arr) ? arr : []) {
      const name = String(raw == null ? '' : raw).trim().slice(0, 20);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= 60) break;
    }
    return out;
  };
  return { teaching: clean(input && input.teaching), dorm: clean(input && input.dorm) };
}

router.get(
  '/',
  // 整份配置（含反作弊阈值 / 跑分参数 / 北斗奖励）——必须 config.view。
  // 楼名清单另走 GET /buildings（building.view），不复用本接口：
  // 前缀上不再统一挂权限，所以这里必须显式声明，否则会变成「无权限也能读全局配置」。
  requirePermission('config.view'),
  wrap(async (req, res) => {
    const doc = await GoalConfig.getSingleton();
    const out = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    // 跑分：老配置文档缺少 extraPercent（日）/ weeklyExtraPercent（周）时，这里显式告诉管理端
    // 「旧口径等价于多少百分比」，避免档位从固定步数改成百分比后出现静默变更
    // （读取即派生，不写库；管理员在「跑分设置」保存时才落库，幂等）
    // perStep 现已**完全弃用**（日、周公式都不再读取），提示里给出日/周两个等价百分比仅供参考
    const raw = await GoalConfig.collection.findOne(
      { key: 'default' },
      {
        projection: {
          'points.perStep': 1,
          'points.extraPercent': 1,
          'points.weeklyExtraPercent': 1,
          'daily.steps': 1,
          'weekly.steps': 1,
        },
      }
    );
    const rawPoints = (raw && raw.points) || {};
    const globalDailySteps = Number(raw && raw.daily && raw.daily.steps) || 0;
    const globalWeeklySteps = Number(raw && raw.weekly && raw.weekly.steps) || 0;
    const extraPercentMissing = rawPoints.extraPercent == null;
    const weeklyExtraPercentMissing = rawPoints.weeklyExtraPercent == null;
    out.pointsLegacy =
      extraPercentMissing || weeklyExtraPercentMissing
        ? {
            extraPercentMissing,
            weeklyExtraPercentMissing,
            perStep: rawPoints.perStep != null ? rawPoints.perStep : null,
            globalDailySteps: globalDailySteps || null,
            globalWeeklySteps: globalWeeklySteps || null,
            // 与旧口径等价的百分比：日 = perStep ÷ 全局日目标，周 = perStep ÷ 全局周目标
            legacyPercent: pointsSvc.equivalentPercent(rawPoints.perStep, globalDailySteps),
            legacyWeeklyPercent: pointsSvc.equivalentPercent(rawPoints.perStep, globalWeeklySteps),
            extraPercent: pointsSvc.normalizeConfig(out.points).extraPercent,
            weeklyExtraPercent: pointsSvc.normalizeConfig(out.points).weeklyExtraPercent,
          }
        : null;
    // 北斗运动四项奖励的**生效值**：距离/卡路里/时长未单独配置（null）时按步数换算派生，
    // derived 标记告诉管理端哪几项正在走派生（页面会在输入框下给出提示，避免误解为已配置）
    out.rewardVideoEffective = rewardVideoSvc.resolvePerWatch(out.rewardVideo);
    // 北斗 2.0：归一后的奖池（含公示百分比）、8 格扇区表、生效封顶值。
    // 奖池每次实时读配置、不需要缓存清理，保存后立即生效。
    out.beidouEffective = await beidouSvc.loadConfig();
    // 编辑态配置：补全新字段默认值（老配置文档缺 grid/economy 时管理端不会出现 undefined）
    out.beidou = beidouSvc.toEditableConfig(doc.beidou);
    ok(res, out);
  })
);

router.put(
  '/',
  // 楼名管理页只回传 buildings，宿管/学生处持 building.manage 就该能保存；
  // 其余字段（反作弊/跑分/北斗）仍要 config.manage，见下方的分字段守卫。
  requirePermission('config.manage', 'building.manage'),
  wrap(async (req, res) => {
    const doc = await GoalConfig.getSingleton();
    // 默认目标（daily/weekly）已移交 /api/admin/assessment/defaults
    const { anticheat, rewardVideo, beidou, points, buildings } = req.body || {};
    // 分字段守卫：只有 building.manage 的账号（如宿管老师）**只能**改楼名，
    // 不能顺手带上 points/anticheat 把计分口径也改掉。
    const perms = req.userPermissions || [];
    const canConfig = perms.includes('*') || perms.includes('config.manage');
    const wantsOthers = !!(anticheat || rewardVideo || beidou || points);
    if (wantsOthers && !canConfig) {
      throw new ApiError(403, 403002, '无权限修改计分/反作弊/北斗配置（需要 config.manage）');
    }
    if (anticheat) {
      // ===== AI 严谨度与阈值（用户 2026-10-28「可以调整 AI 封禁的严谨程度」）=====
      // 口径唯一实现：services/anticheat-config.js::applyAnticheatInput
      // （Web 控制台 PUT /console/model-config 走同一份 —— 两处各写一套钳位，
      //   就会漂移出「页面预览 0.78、实际生效 0.70」，管理员按预览理解系统行为）。
      // 包含：档位名白名单（非法回落 balanced）、自定义阈值 0.3~0.95 / 0.4~0.99 夹紧、
      // 以及「自动封禁线 ≥ 待研判线 + 0.02」（否则一到可疑就封，等于取消人工研判档）。
      acSvc.applyAnticheatInput(doc, anticheat);
    }
    if (rewardVideo) {
      doc.rewardVideo.enabled = rewardVideo.enabled !== false;
      // 四项奖励（步数/距离米/卡路里/时长秒）：只处理显式回传的键，越界一律夹紧，
      // 显式 null/空串 = 回到「按步数换算」（services/reward-video.js）
      const per = rewardVideoSvc.normalizePerWatchInput(rewardVideo);
      for (const key of Object.keys(per)) doc.rewardVideo[key] = per[key];
      // 广告位 ID（客户端公开标识，可留空 = 用用户端代码里的默认广告位）
      if (rewardVideo.adUnitId !== undefined) {
        doc.rewardVideo.adUnitId = String(rewardVideo.adUnitId || '').trim().slice(0, 64);
      }
    }
    // 北斗运动 v3（铜版经济 / 转盘 / 九宫格 / 任务 / 分享）：只处理显式回传的键，越界一律夹紧。
    // 归一化唯一实现在 services/beidou-config.js::normalizeBeidouInput（管理与工具共用一份，
    // 两处各写一套钳位就会出现「管理端显示 3000、实际生效 300」）。
    if (beidou) {
      const norm = beidouSvc.normalizeBeidouInput(beidou);
      for (const key of Object.keys(norm)) {
        // 标量字段
        if (['enabled', 'sfxEnabled', 'coinName', 'welcomeCoins'].includes(key)) {
          doc.beidou[key] = norm[key];
          continue;
        }
        // 组字段：整体替换数组（prizes / grid.symbols / grid.outcomes / checkin.milestones），
        // 其余标量逐项写入。不能把数组当普通对象遍历，否则会把数组拆成 {0:…,1:…}。
        if (key === 'prizes') {
          doc.beidou.prizes = norm.prizes;
          continue;
        }
        if (doc.beidou[key] === undefined || doc.beidou[key] === null) {
          doc.beidou[key] = norm[key];
          continue;
        }
        if (typeof norm[key] !== 'object' || Array.isArray(norm[key])) {
          doc.beidou[key] = norm[key];
          continue;
        }
        for (const sub of Object.keys(norm[key])) {
          if (sub === 'symbols' || sub === 'outcomes' || sub === 'milestones') {
            doc.beidou[key][sub] = norm[key][sub];
          } else if (norm[key][sub] && typeof norm[key][sub] === 'object' && !Array.isArray(norm[key][sub])) {
            if (!doc.beidou[key][sub]) doc.beidou[key][sub] = {};
            for (const subKey of Object.keys(norm[key][sub])) doc.beidou[key][sub][subKey] = norm[key][sub][subKey];
          } else {
            doc.beidou[key][sub] = norm[key][sub];
          }
        }
      }
    }
    // 跑分设置（config/points 子页只回传本组，未提供的键不动）
    if (points) {
      doc.points.enabled = points.enabled !== false;
      const num = (v, min, max) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        return Math.min(max, Math.max(min, Math.round(n)));
      };
      const dailyGoal = points.dailyGoal != null ? num(points.dailyGoal, 0, 1000) : null;
      const weeklyGoal = points.weeklyGoal != null ? num(points.weeklyGoal, 0, 5000) : null;
      // 日超出档位：个人日目标的百分比，整数 1~100（越界一律夹紧，不写非法值）
      const extraPercent = points.extraPercent != null ? num(points.extraPercent, pointsSvc.EXTRA_PERCENT_MIN, pointsSvc.EXTRA_PERCENT_MAX) : null;
      // 周超出档位：个人周目标的百分比，整数 1~100（同一套区间常量）
      const weeklyExtraPercent =
        points.weeklyExtraPercent != null
          ? num(points.weeklyExtraPercent, pointsSvc.EXTRA_PERCENT_MIN, pointsSvc.EXTRA_PERCENT_MAX)
          : null;
      // 【已完全弃用】perStep：日、周公式都不再读取；仍接受回传只为兼容老客户端表单（值原样保存，不影响分数）
      const perStep = points.perStep != null ? num(points.perStep, 1, 1000000) : null;
      const perStepScore = points.perStepScore != null ? num(points.perStepScore, 0, 1000) : null;
      const dailyExtraCap = points.dailyExtraCap != null ? num(points.dailyExtraCap, 0, 1000) : null;
      // 单周超出加分上限：0 = 不封顶（与单日上限的 0 = 超出不加分**语义不同**，管理端已标注）
      const weeklyExtraCap = points.weeklyExtraCap != null ? num(points.weeklyExtraCap, 0, 1000) : null;
      if (dailyGoal != null) doc.points.dailyGoal = dailyGoal;
      if (weeklyGoal != null) doc.points.weeklyGoal = weeklyGoal;
      if (extraPercent != null) doc.points.extraPercent = extraPercent;
      if (weeklyExtraPercent != null) doc.points.weeklyExtraPercent = weeklyExtraPercent;
      if (perStep != null) doc.points.perStep = perStep;
      if (perStepScore != null) doc.points.perStepScore = perStepScore;
      if (dailyExtraCap != null) doc.points.dailyExtraCap = dailyExtraCap;
      if (weeklyExtraCap != null) doc.points.weeklyExtraCap = weeklyExtraCap;
    }
    // 楼名白名单（用户 2026-10-21）：两份清单分别维护，整体覆盖（不按项增删，避免前后端顺序打架）
    if (buildings) {
      const normalized = normalizeBuildings(buildings);
      doc.buildings = { teaching: normalized.teaching, dorm: normalized.dorm };
    }
    await doc.save();
    // AI 严谨度改动要**立即生效**（用户 2026-10-28）：
    // anticheat-model 的阈值有 30s 进程内缓存，不清的话管理员改完还得等半分钟，
    // 容易误以为「改了没生效」。这里直接失效缓存，下次判定就按新档位。
    try {
      require('../../services/anticheat-model').clearThresholdCache();
    } catch (e) {
      /* 缓存清理是可选能力，失败不影响保存 */
    }
    const out = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    out.pointsLegacy = null; // 保存即完成迁移：不再提示旧字段换算
    out.rewardVideoEffective = rewardVideoSvc.resolvePerWatch(out.rewardVideo);
    out.beidouEffective = await beidouSvc.loadConfig();
    out.beidou = beidouSvc.toEditableConfig(doc.beidou);
    ok(res, out);
  })
);

// ===== 北斗运动 v3 配置预览（只读）=====
//
// 后台改权重/成本时实时预览「归一概率 + 期望返还 + 警告」。
// 必须与保存走**同一份**归一/EV 逻辑（services/beidou-config.js），否则会出现
// 「后台预览 30%、用户端公示 25%」这种查不出来的漂移。
router.post(
  '/beidou-preview',
  requirePermission('config.view'),
  wrap(async (req, res) => {
    const input = (req.body || {}).beidou || {};
    const norm = beidouSvc.normalizeBeidouInput(input);
    const effective = beidouSvc.buildEffective(norm);
    ok(res, { effective, warnings: effective.warnings || [] });
  })
);

// ===== 北斗运动 2.0 中奖记录（只读 + 筛选）=====
//
// 为什么只读：抽奖流水是概率公示与学生对账的唯一凭据。
// 允许后台补发/撤销会让「公示概率」与实际发放对不上 —— 那是这类活动最容易被投诉的点，
// 也是审计时说不清的地方。真要补偿学生，走「人工发徽章」那套独立链路，别动这张表。
//
// 三个筛选维度（用户 2026-11-12「日期筛选、抽奖来源筛选(签到、分享、视频)」）：
//   · dateFrom / dateTo —— 日历键范围（YYYY-MM-DD，闭区间）；
//   · source —— 本次消耗的机会来源（video/share/checkin/prize/unknown）；
//   · prizeKey / type —— 奖品与结果类型。
// 口径注意：`source` 是**账本归属**（这次扣的是谁给的次数），不是「用户从哪个页面点进来的」。
router.get(
  '/beidou-draws',
  requirePermission('config.view'),
  wrap(async (req, res) => {
    const BeidouDraw = require('../../models/beidou-draw');
    const { parsePagination } = require('../../utils/response');
    const { isValidDateKey } = require('../../utils/dates');
    const { page, limit, skip } = parsePagination(req.query, { page: 1, limit: 20 });

    const cond = {};
    // 日期范围：非法值一律忽略（不能骗管理员「筛了但其实没筛」），且自动纠正倒序
    let from = isValidDateKey(req.query.dateFrom) ? String(req.query.dateFrom) : '';
    let to = isValidDateKey(req.query.dateTo) ? String(req.query.dateTo) : '';
    if (from && to && from > to) [from, to] = [to, from];
    if (from || to) {
      cond.date = {};
      if (from) cond.date.$gte = from;
      if (to) cond.date.$lte = to;
    }
    if (req.query.source) {
      const s = String(req.query.source);
      if (['video', 'share', 'checkin', 'prize', 'wallet', 'unknown'].includes(s)) cond.source = s;
    }
    if (req.query.game && ['wheel', 'grid'].includes(String(req.query.game))) {
      cond.game = String(req.query.game);
    }
    if (req.query.prizeKey) cond.prizeKey = String(req.query.prizeKey);
    if (req.query.type && ['steps', 'coin', 'mixed', 'none', 'draw'].includes(req.query.type)) cond.type = req.query.type;

    const [rows, total, byType] = await Promise.all([
      BeidouDraw.find(cond).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      BeidouDraw.countDocuments(cond),
      BeidouDraw.aggregate([{ $match: cond }, { $group: { _id: '$type', n: { $sum: 1 } } }]),
    ]);
    // 分面必须按「除了自己以外的条件」统计，否则选了某一项就只剩那一项有数
    const facetBase = Object.assign({}, cond);
    delete facetBase.source;
    delete facetBase.game;
    const [sourceFacet, gameFacet] = await Promise.all([
      BeidouDraw.aggregate([{ $match: facetBase }, { $group: { _id: '$source', n: { $sum: 1 } } }]),
      BeidouDraw.aggregate([{ $match: facetBase }, { $group: { _id: '$game', n: { $sum: 1 } } }]),
    ]);

    const sourceCount = {};
    for (const s of sourceFacet) sourceCount[s._id || 'unknown'] = s.n;
    const gameCount = {};
    for (const g of gameFacet) gameCount[g._id || 'wheel'] = g.n;
    const typeCount = {};
    for (const t of byType) typeCount[t._id || 'none'] = t.n;

    const userIds = [...new Set(rows.map((r) => r.openid).filter(Boolean))];
    const User = require('../../models/user');
    const users = userIds.length
      ? await User.find({ openid: { $in: userIds } }).select('openid realName studentId className').lean()
      : [];
    const nameOf = new Map(users.map((u) => [u.openid, u]));
    // 奖品名：v3 流水优先用落库快照 `prizeLabel`（管理员改奖池后历史记录不变）；
    // 老记录没有快照时再回退到当前配置/金额拼接。
    const cfgSvc = require('../../services/beidou');
    const cfg = await cfgSvc.loadConfig();
    const prizeOf = new Map((cfg.prizes || []).map((p) => [p.key, p]));
    const outcomeOf = new Map((cfg.grid.outcomes || []).map((o) => [o.key, o]));

    // ⚠️ 来源文案**不在路由里另写一份**：它是唯一定义在 services/beidou.js::SOURCE_TEXT。
    const { SOURCE_TEXT, GAME_TEXT } = cfgSvc;
    const TYPE_TEXT = { steps: '步数', coin: '铜版', none: '谢谢参与', draw: '再来一次', mixed: '混合奖励' };

    const list = rows.map((r) => {
      const u = nameOf.get(r.openid) || {};
      const p = prizeOf.get(r.prizeKey) || outcomeOf.get(r.prizeKey) || {};
      const src = r.source || 'unknown';
      const game = r.game || 'wheel';
      const lines = Array.isArray(r.lines) ? r.lines : [];
      const prizeLabel = r.prizeLabel
        || p.label
        || (r.type === 'steps' ? `${r.amount} 步` : r.type === 'coin' ? `${r.amount} ${cfg.coinName}` : TYPE_TEXT[r.type] || '');
      return {
        _id: r._id,
        date: r.date,
        createdAt: r.createdAt,
        realName: u.realName || '',
        studentId: u.studentId || '',
        className: u.className || '',
        game,
        gameText: GAME_TEXT[game] || game,
        prizeKey: r.prizeKey,
        prizeLabel,
        type: r.type,
        typeText: TYPE_TEXT[r.type] || r.type,
        amount: r.amount,
        coinAmount: r.coinAmount || 0,
        stepsAmount: r.stepsAmount || 0,
        cost: r.cost || 0,
        capped: !!r.capped,
        coinCapped: !!r.coinCapped,
        pity: !!r.pity,
        balanceAfter: r.balanceAfter || 0,
        // 来源（账本归属）+ 中文文案由**服务端**下发
        source: src,
        sourceText: SOURCE_TEXT[src] || '未记录',
        // 九宫格中奖线文案（转盘为空）
        linesText: lines.map((l) => l.label).filter(Boolean).join(' + '),
        // 留证字段
        roll: r.roll,
        index: r.index,
      };
    });

    const prizeOptions = [
      ...(cfg.prizes || []).map((p) => ({ key: p.key, label: p.label, game: 'wheel' })),
      ...(cfg.grid.symbols || []).filter((s) => s.type !== 'none').map((s) => ({ key: s.key, label: s.label, game: 'grid' })),
      // 旧九宫格结果（历史流水的 prizeKey）
      ...(cfg.grid.outcomes || [])
        .filter((o) => o.lines > 0)
        .map((o) => ({ key: o.key, label: o.label, game: 'grid-legacy' })),
    ];

    ok(res, {
      list,
      total,
      page,
      limit,
      sourceNote: cfgSvc.sourceNote(),
      filters: {
        dateFrom: from,
        dateTo: to,
        source: req.query.source || '',
        game: ['wheel', 'grid'].includes(String(req.query.game)) ? String(req.query.game) : '',
        prizeKey: req.query.prizeKey || '',
        type: req.query.type || '',
      },
      facets: {
        game: [
          { key: 'wheel', label: GAME_TEXT.wheel, count: gameCount.wheel || 0 },
          { key: 'grid', label: GAME_TEXT.grid, count: gameCount.grid || 0 },
        ],
        source: [
          { key: 'wallet', label: SOURCE_TEXT.wallet, count: sourceCount.wallet || 0 },
          { key: 'video', label: SOURCE_TEXT.video, count: sourceCount.video || 0 },
          { key: 'share', label: SOURCE_TEXT.share, count: sourceCount.share || 0 },
          { key: 'checkin', label: SOURCE_TEXT.checkin, count: sourceCount.checkin || 0 },
          { key: 'prize', label: SOURCE_TEXT.prize, count: sourceCount.prize || 0 },
          { key: 'unknown', label: SOURCE_TEXT.unknown, count: sourceCount.unknown || 0 },
        ],
        type: [
          { key: 'coin', label: TYPE_TEXT.coin, count: typeCount.coin || 0 },
          { key: 'steps', label: TYPE_TEXT.steps, count: typeCount.steps || 0 },
          { key: 'mixed', label: TYPE_TEXT.mixed, count: typeCount.mixed || 0 },
          { key: 'none', label: TYPE_TEXT.none, count: typeCount.none || 0 },
          { key: 'draw', label: TYPE_TEXT.draw, count: typeCount.draw || 0 },
        ],
        // 奖池候选（转盘奖池 + 九宫格中奖结果）
        prizes: prizeOptions,
      },
    });
  })
);

// ===== 北斗运动 v3 铜版流水（只读）=====
router.get(
  '/beidou-coin-logs',
  requirePermission('config.view'),
  wrap(async (req, res) => {
    const BeidouCoinLog = require('../../models/beidou-coin-log');
    const User = require('../../models/user');
    const { parsePagination } = require('../../utils/response');
    const { isValidDateKey, todayKey, addDays } = require('../../utils/dates');
    const { page, limit, skip } = parsePagination(req.query, { page: 1, limit: 20 });

    const cond = {};
    let from = isValidDateKey(req.query.dateFrom) ? String(req.query.dateFrom) : '';
    let to = isValidDateKey(req.query.dateTo) ? String(req.query.dateTo) : '';
    if (from && to && from > to) [from, to] = [to, from];
    if (from || to) {
      cond.date = {};
      if (from) cond.date.$gte = from;
      if (to) cond.date.$lte = to;
    }
    if (req.query.source) {
      const s = String(req.query.source);
      if (['welcome', 'video', 'checkin', 'share', 'wheel', 'grid', 'refund'].includes(s)) cond.source = s;
    }
    if (req.query.game && ['wheel', 'grid'].includes(String(req.query.game))) cond.game = String(req.query.game);
    const direction = String(req.query.direction || '');
    if (direction === 'earn') cond.delta = { $gt: 0 };
    if (direction === 'spend') cond.delta = { $lt: 0 };

    const [rows, total, sumAgg] = await Promise.all([
      BeidouCoinLog.find(cond).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      BeidouCoinLog.countDocuments(cond),
      BeidouCoinLog.aggregate([{ $match: cond }, { $group: { _id: null, earned: { $sum: { $cond: [{ $gt: ['$delta', 0] }, '$delta', 0] } }, spent: { $sum: { $cond: [{ $lt: ['$delta', 0] }, { $abs: '$delta' }, 0] } } } }]),
    ]);
    // 分面：排除自身维度后再统计
    const sourceBase = Object.assign({}, cond);
    delete sourceBase.source;
    const gameBase = Object.assign({}, cond);
    delete gameBase.game;
    const [sourceFacet, gameFacet] = await Promise.all([
      BeidouCoinLog.aggregate([{ $match: sourceBase }, { $group: { _id: '$source', n: { $sum: 1 }, amount: { $sum: '$delta' } } }]),
      BeidouCoinLog.aggregate([{ $match: gameBase }, { $group: { _id: '$game', n: { $sum: 1 }, amount: { $sum: '$delta' } } }]),
    ]);
    const sourceCount = {};
    for (const s of sourceFacet) sourceCount[s._id || ''] = s.n;
    const gameCount = {};
    for (const g of gameFacet) gameCount[g._id || ''] = g.n;

    const openids = [...new Set(rows.map((r) => r.openid).filter(Boolean))];
    const users = openids.length
      ? await User.find({ openid: { $in: openids } }).select('openid realName studentId className').lean()
      : [];
    const nameOf = new Map(users.map((u) => [u.openid, u]));
    const svc = require('../../services/beidou');
    const { COIN_SOURCE_TEXT, GAME_TEXT } = svc;

    const list = rows.map((r) => {
      const u = nameOf.get(r.openid) || {};
      return {
        _id: r._id,
        date: r.date,
        createdAt: r.createdAt,
        realName: u.realName || '',
        studentId: u.studentId || '',
        className: u.className || '',
        delta: r.delta,
        direction: r.delta > 0 ? 'earn' : 'spend',
        source: r.source,
        sourceText: COIN_SOURCE_TEXT[r.source] || r.source,
        game: r.game || '',
        gameText: GAME_TEXT[r.game] || '',
        balanceAfter: r.balanceAfter || 0,
        note: r.note || '',
      };
    });

    const sum = (sumAgg && sumAgg[0]) || {};
    ok(res, {
      list,
      total,
      page,
      limit,
      totals: { earned: Math.max(0, sum.earned || 0), spent: Math.max(0, sum.spent || 0) },
      filters: {
        dateFrom: from || addDays(todayKey(), -6),
        dateTo: to || todayKey(),
        source: req.query.source || '',
        game: req.query.game || '',
        direction,
      },
      facets: {
        source: Object.keys(COIN_SOURCE_TEXT).map((key) => ({ key, label: COIN_SOURCE_TEXT[key], count: sourceCount[key] || 0 })),
        game: [
          { key: 'wheel', label: GAME_TEXT.wheel, count: gameCount.wheel || 0 },
          { key: 'grid', label: GAME_TEXT.grid, count: gameCount.grid || 0 },
        ],
      },
    });
  })
);

// ===== 北斗运动 v3 经济概览（只读）=====
//
// 用户 2026-11-22「收益策略」：后台要能看到铜版发了多少、回收多少、按来源/游戏分布，
// 以及游戏局的铜版返奖率。只读聚合，不允许在这里改余额。
router.get(
  '/beidou-economy',
  requirePermission('config.view'),
  wrap(async (req, res) => {
    const BeidouCoinLog = require('../../models/beidou-coin-log');
    const BeidouWallet = require('../../models/beidou-wallet');
    const BeidouDraw = require('../../models/beidou-draw');
    const { todayKey, addDays } = require('../../utils/dates');
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const to = todayKey();
    const from = addDays(to, -(days - 1));

    const [rangeAgg, sourceAgg, gameLogAgg, drawAgg, walletAgg] = await Promise.all([
      BeidouCoinLog.aggregate([
        { $match: { date: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: null,
            earned: { $sum: { $cond: [{ $gt: ['$delta', 0] }, '$delta', 0] } },
            spent: { $sum: { $cond: [{ $lt: ['$delta', 0] }, { $abs: '$delta' }, 0] } },
          },
        },
      ]),
      BeidouCoinLog.aggregate([
        { $match: { date: { $gte: from, $lte: to }, delta: { $gt: 0 } } },
        { $group: { _id: '$source', amount: { $sum: '$delta' }, n: { $sum: 1 } } },
        { $sort: { amount: -1 } },
      ]),
      BeidouCoinLog.aggregate([
        { $match: { date: { $gte: from, $lte: to }, delta: { $lt: 0 } } },
        { $group: { _id: '$game', amount: { $sum: { $abs: '$delta' } }, n: { $sum: 1 } } },
      ]),
      BeidouDraw.aggregate([
        {
          $match: {
            date: { $gte: from, $lte: to },
            $or: [{ status: 'settled' }, { status: { $exists: false } }],
          },
        },
        {
          $group: {
            _id: '$game',
            plays: { $sum: 1 },
            cost: { $sum: { $cond: [{ $gt: ['$cost', 0] }, '$cost', 0] } },
            coinOut: {
              $sum: {
                $cond: [
                  { $gt: ['$coinAmount', 0] },
                  '$coinAmount',
                  { $cond: [{ $eq: ['$type', 'coin'] }, '$amount', 0] },
                ],
              },
            },
            stepsOut: {
              $sum: {
                $cond: [
                  { $gt: ['$stepsAmount', 0] },
                  '$stepsAmount',
                  { $cond: [{ $eq: ['$type', 'steps'] }, '$amount', 0] },
                ],
              },
            },
            pity: { $sum: { $cond: ['$pity', 1, 0] } },
            capped: { $sum: { $cond: ['$capped', 1, 0] } },
            coinCapped: { $sum: { $cond: ['$coinCapped', 1, 0] } },
          },
        },
      ]),
      BeidouWallet.aggregate([{ $group: { _id: null, circulation: { $sum: '$balance' }, wallets: { $sum: 1 } } }]),
    ]);

    const svc = require('../../services/beidou');
    const { COIN_SOURCE_TEXT, GAME_TEXT } = svc;
    const sum = (rangeAgg && rangeAgg[0]) || {};
    const wallet = (walletAgg && walletAgg[0]) || {};
    const bySource = (sourceAgg || []).map((s) => ({
      key: s._id,
      label: COIN_SOURCE_TEXT[s._id] || s._id,
      amount: s.amount || 0,
      count: s.n || 0,
    }));
    const spendByGame = {};
    for (const g of gameLogAgg || []) spendByGame[g._id || ''] = g.amount || 0;
    const byGame = ['wheel', 'grid'].map((game) => {
      const row = (drawAgg || []).find((x) => (x._id || 'wheel') === game) || {};
      const cost = row.cost || 0;
      const coinOut = row.coinOut || 0;
      return {
        game,
        gameText: GAME_TEXT[game],
        plays: row.plays || 0,
        cost,
        coinOut,
        stepsOut: row.stepsOut || 0,
        spend: spendByGame[game] || 0,
        pity: row.pity || 0,
        capped: row.capped || 0,
        coinCapped: row.coinCapped || 0,
        returnRate: cost > 0 ? Math.round((coinOut / cost) * 10000) / 100 : 0,
      };
    });

    ok(res, {
      range: { from, to, days },
      circulation: wallet.circulation || 0,
      wallets: wallet.wallets || 0,
      rangeTotals: { earned: Math.max(0, sum.earned || 0), spent: Math.max(0, sum.spent || 0) },
      bySource,
      byGame,
    });
  })
);

// 来源口径说明（只读，给管理端页面显示「什么是抽奖来源」）
router.get(
  '/beidou-draws/sources',
  requirePermission('config.view'),
  wrap(async (req, res) => {
    const svc = require('../../services/beidou');
    ok(res, {
      // 扣减优先级：管理端要能解释「为什么签到来源的记录这么少」
      order: svc.SOURCE_ORDER,
      // 短文案（列表标签）与长文案（解释口径）都来自 service 的唯一定义
      text: svc.SOURCE_TEXT,
      textLong: svc.SOURCE_TEXT_LONG,
      note: svc.sourceNote(),
    });
  })
);

/**
 * 楼名清单（只读，给「填教室 / 填宿舍」的选择器用）。
 *
 * 权限用 **building.view**（用户 2026-10-22 要求独立权限项），不再用 config.view：
 * config.view 覆盖反作弊阈值、跑分参数等全局计分口径，
 * 而班委/宿管只需要「选楼名」，不该因此获得看那些配置的权力。
 * 写（PUT /）仍走 config.manage 或 building.manage（见下方守卫）。
 */
router.get(
  '/buildings',
  // 「能管理就必须能查看」：building.manage 也要放行读，否则会出现
  // 「保存成功但列表刷不出来」——宿管改完楼名，页面却 403 空着，比不能改更糟。
  requirePermission('building.view', 'building.manage', 'config.view'),
  wrap(async (req, res) => {
    const doc = await GoalConfig.getSingleton();
    const b = (doc && doc.buildings) || {};
    ok(res, {
      teaching: Array.isArray(b.teaching) ? b.teaching : [],
      dorm: Array.isArray(b.dorm) ? b.dorm : [],
    });
  })
);

module.exports = router;
