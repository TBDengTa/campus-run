const RunRecord = require('../models/run-record');
const RewardVideoRecord = require('../models/reward-video-record');
const GoalConfig = require('../models/goal-config');
const wechat = require('./wechat');
const anticheat = require('./anticheat');
const badgesSvc = require('./badges');
const rewardVideoSvc = require('./reward-video');
const { todayKey } = require('../utils/dates');

function withPace(doc) {
  doc.pace = wechat.formatPace(doc.durationSeconds, doc.distance);
  if (!doc.steps) doc.goalAchieved = false;
  return doc;
}

// 教师账号不参与运动记录（步数同步 / GPS 实跑 / 激励视频加步数）
const TEACHER_BLOCK_MESSAGE = '教师账号不参与运动记录';

function isTeacher(user) {
  return !!user && user.role === 'teacher';
}

function teacherBlock(user) {
  return isTeacher(user) ? { blocked: true, reason: TEACHER_BLOCK_MESSAGE } : null;
}

// 同步窗口：1 小时内的多次微信同步合并为同一条记录；超过 1 小时则新建当日的下一条记录
const SYNC_WINDOW_MS = 60 * 60 * 1000;

/**
 * 统计「今天有多少次同步步数与本次完全相同」。
 *
 * 用途：识别脚本空转 / 刷步工具心跳（步数一动不动却反复上报）。
 * 只取最近 20 条，避免全表扫描；同日同人记录量本来就不大。
 */
async function countSameValueSyncs(user, dateKey, cumulativeSteps) {
  try {
    const recent = await RunRecord.find({ openid: user.openid, date: dateKey, source: 'werun' })
      .sort({ createdAt: -1 })
      .limit(20)
      .select('steps')
      .lean();
    const total = recent.reduce((s, r) => s + (r.steps || 0), 0);
    // 「步数完全没变」在库里表现为：本次上报值与已经累计的总量相同（增量 0）。
    // 这里用记录条数近似：连续多条 steps=0 说明一直没动。
    const zeros = recent.filter((r) => (r.steps || 0) === 0).length;
    return Number(cumulativeSteps) === total ? zeros + 1 : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * 可疑步数研判 + 落「异常记录」（用户 2026-10-27）。
 *
 * 与 anticheat 的分工：
 *   · 本函数只**打分并记录线索**，不直接封禁；
 *   · autoBan 由调用方（syncWerunDay）拿去走 anticheat.restrict，保持「限制只有一处实现」。
 *
 * 幂等：同一人同一天只有一条 open 记录 —— 重复同步刷屏没有意义，
 *   用 upsert 更新分数与原因即可（分数取历史最大值，避免后期正常同步把分数刷低、
 *   让早先那条明显的异常线索凭空消失）。
 *
 * @returns {Promise<{score:number, level:string, reasons:string[], autoBan:boolean, shouldRecord:boolean}|null>}
 */
async function recordStepAnomaly(user, { dateKey, cumulativeSteps, deltaSteps, elapsedMs, sameValueCount }) {
  const anomalySvc = require('./step-anomaly');
  const StepAnomaly = require('../models/step-anomaly');

  const result = anomalySvc.scoreSync({
    cumulativeSteps,
    deltaSteps,
    elapsedMs,
    sameValueCount,
  });

  // ===== 学习模型（用户 2026-10-27「融入大数据或推理模型，自己学习规则与模式」）=====
  // 硬规则（重复数字 / 整数化 / 增速 / 单日上限）只能抓**已知形态**；
  // 这里再叠加一层从历史数据学出来的异常分，抓「组合上不协调」的软异常。
  // 两者独立：硬规则命中必定记录，模型命中也可能记录（取并集），
  // 最终分数取较大值，理由合并去重，管理员能看到是谁判的。
  let modelResult = null;
  try {
    const acModel = require('./anticheat-model');
    // 该用户的历史基线（中位数 / MAD）：让模型知道「对**这个人**来说这算不算异常」，
    // 而不是只看全体分布 —— 有人天生步数高，不该因为步数多就被判可疑。
    const history = await buildUserBaseline(user);
    modelResult = await acModel.evaluate(
      'werun',
      { steps: cumulativeSteps, deltaSteps, elapsedMs },
      history
    );
  } catch (e) {
    // 模型不可用（首次启动未训练 / 异常）时完全退回硬规则，不影响同步
  }

  const merged = mergeAnomaly(result, modelResult);
  if (!merged.shouldRecord) return merged;

  const existing = await StepAnomaly.findOne({ userId: user._id, date: dateKey, status: 'open' }).lean();
  if (existing) {
    // 已有一条待研判记录：只在本次分数更高时更新（保留最强线索）
    if (merged.score > (existing.score || 0)) {
      await StepAnomaly.updateOne(
        { _id: existing._id },
        {
          $set: {
            score: merged.score,
            reasons: merged.reasons,
            cumulativeSteps: Number(cumulativeSteps) || 0,
            deltaSteps: Number(deltaSteps) || 0,
            // 记录判定来源，便于事后复核「这条是模型判的还是规则判的」
            modelScore: modelResult ? Number(modelResult.score) : null,
            modelLevel: modelResult ? modelResult.level : '',
          },
        }
      );
    }
  } else {
    await StepAnomaly.create({
      userId: user._id,
      openid: user.openid || '',
      realName: user.realName || user.nickname || user.account || '',
      className: user.className || '',
      studentId: user.studentId || '',
      date: dateKey,
      cumulativeSteps: Number(cumulativeSteps) || 0,
      deltaSteps: Number(deltaSteps) || 0,
      score: merged.score,
      reasons: merged.reasons,
      status: 'open',
      modelScore: modelResult ? Number(modelResult.score) : null,
      modelLevel: modelResult ? modelResult.level : '',
      // 特征快照：管理员处置后这条记录会连同特征进入 step_labels 训练集，
      // 所以特征必须在**判定当下**存下来（原始数据将来可能被清理）
      features: modelResult && modelResult.features ? modelResult.features : null,
    });
  }
  return merged;
}

/**
 * 合并「硬规则」与「AI 判定」。
 *
 * ===== 用户 2026-10-29 决定：「自动检测也变成 AI」（P2）=====
 * 旧口径是 `finalScore = max(规则分, 模型分×250映射)` + 两份理由正则去重 ——
 * 两条通道各打各的分，「规则 55 分」和「模型 0.8」在量纲上根本不可比，
 * 合并只能靠拍系数与取大，管理员看到的分数说不清是谁给的。
 *
 * 新口径：**分数与理由都以 AI 为准**。硬规则已作为特征（ruleHits/ruleMax）
 * 喂进森林（见 anticheat-model::werunFeatures），规则信号仍在决定分数，
 * 只是从「并行打分」变成「输入」；物理不可能值（配速快于世界纪录、单日>10万步）
 * 由 evaluate 内部的 physicalScore 兜底取 max，不依赖样本分布。
 *
 * 唯一保留的规则独立路径：**模型不可用时**（首次启动还没训练 / 训练异常）
 * 完全退回硬规则 —— 同步链路不能因为模型没热起来就裸奔，
 * 没有反作弊的窗口期比误判更危险。
 */
function mergeAnomaly(rule, model) {
  if (!model) return rule; // 模型未就绪：退回硬规则（fallback，不是并行通道）
  // AI 分（0~1）→ 管理端百分制：0.62（可疑线）→ 30，0.78（封禁线）→ 70，≥0.9 → 100
  const score = Math.max(0, Math.min(100, Math.round((model.score - 0.5) * 250)));
  const level =
    model.level === 'autoBan' ? 'autoBan' : model.level === 'suspicious' ? 'suspicious' : 'ok';
  // 理由以 AI 输出为准（physicalScore 命中的硬理由在前，模型解释在后，已在 evaluate 内去重）。
  // 规则命中的中文理由也带上：不是为了让它「参与打分」（分数已经通过特征体现），
  // 而是管理员要看懂「重复数字 66666」这种直白证据 —— 比「roundness=4」好懂得多。
  const reasons = require('./anticheat-model').dedupeReasons([
    ...(model.reasons || []),
    ...(rule.reasons || []),
  ]);
  return {
    ...rule,
    score,
    level,
    reasons,
    autoBan: level === 'autoBan',
    shouldRecord: level === 'suspicious' || level === 'autoBan',
    modelScore: model.score,
    // 判定来源标注：管理端列表据此显示「AI 判定」徽标（fallback 时显示「规则判定」）
    judgedBy: 'ai',
  };
}

/**
 * 该用户的历史基线：用于「与本人比」而不是「与全校比」。
 * 用中位数 + MAD（稳健统计），避免被自己的极端日带偏。
 */
async function buildUserBaseline(user) {
  try {
    const rows = await RunRecord.find({ openid: user.openid, source: 'werun', steps: { $gt: 0 } })
      .sort({ createdAt: -1 })
      .limit(30)
      .select('steps')
      .lean();
    const vals = rows.map((r) => Number(r.steps) || 0).filter((v) => v > 0);
    if (vals.length < 5) return {};
    const sorted = [...vals].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const mad = sorted.length
      ? Math.max(
          1,
          sorted.reduce((s, v) => s + Math.abs(v - med), 0) / sorted.length
        )
      : 1;
    return { medianSteps: med, madSteps: mad, syncCountToday: vals.length };
  } catch (e) {
    return {};
  }
}

/**
 * 同步微信运动某日步数（werun 数据 30 天内逐日同步）
 *
 * 记录规则（每次同步都独立留痕，便于记录页看清"什么时候同步了多少"）：
 * - 该日已有 werun 记录且最后一条在 1 小时内 → **合并更新该条**（steps = 微信累计 − 该条之前的累计）
 * - 超过 1 小时（或当日还没有记录）→ **新建一条**，steps = 微信累计 − 该日已记录总量（增量）
 * - 没有增量时不建空记录
 * 因此「该日总量 = 各条 werun 记录 steps 之和」，与 beidou / gps 记录一起聚合即当日总计。
 */
async function syncWerunDay(user, dateKey, cumulativeSteps, { checkJump = true } = {}) {
  const blocked = teacherBlock(user);
  if (blocked) return blocked;

  const existing = await RunRecord.find({ openid: user.openid, date: dateKey, source: 'werun' }).sort({ createdAt: 1 });
  const recordedTotal = existing.reduce((sum, r) => sum + (r.steps || 0), 0);
  const last = existing.length ? existing[existing.length - 1] : null;

  if (checkJump) {
    // 反作弊按「当日累计」比对本次同步带来的新增量。
    //
    // ⚠️ 必须把「上一次同步时间」一起传进去（用户 2026-10-26「同步的微信步数不要被封禁」）：
    //   只看增量会把「白天走够了、晚上第一次进小程序」当成暴增（15000 > 13000 阈值）
    //   → 限制微信同步 7 天，24h 内再撞一次升级为限制登录 —— 可那全是真实步数。
    //   checkStepJump 用 lastSyncAt 判断「是不是攒了一段时间才同步」，是的话不判违规。
    // 取「当天最新一条 werun 记录的 createdAt」作为上次同步时间；没有记录 = 首次同步（同样不判）。
    const lastSyncAt = last && last.createdAt ? new Date(last.createdAt).getTime() : 0;
    const result = await anticheat.checkStepJump(user, dateKey, recordedTotal, cumulativeSteps || 0, {
      lastSyncAt,
    });
    // 违规时返回限制信息：scope=sync 限制微信同步 / scope=login 升级为限制登录
    if (result.violation) return { restricted: result };
  }

  const now = Date.now();
  const lastAt = last && last.createdAt ? new Date(last.createdAt).getTime() : 0;
  const merge = !!last && now - lastAt < SYNC_WINDOW_MS;

  // 本条记录应承载的步数（合并时不算该条自身已记的部分，避免重复累加）
  const base = merge ? recordedTotal - (last.steps || 0) : recordedTotal;
  const steps = Math.max(0, (cumulativeSteps || 0) - base);

  if (!merge && steps <= 0) return { record: null, skipped: true };

  // ===== 可疑步数研判（用户 2026-10-27）=====
  // 在写入前打分：命中特征（整数步数 / 66666 这类重复数字 / 增速超人类极限 / 单日超限）
  //   · score >= AUTO_BAN_SCORE → 自动限制（与 checkStepJump 同一套 restrict）
  //   · 未达阈值但 >= SUSPICIOUS_SCORE → 落一条「异常记录」，等管理员手动处置
  // 这一步**不改变正常记录的写入**：只有 shouldRecord 或 autoBan 才有副作用。
  let anomaly = null;
  if (checkJump) {
    try {
      anomaly = await recordStepAnomaly(user, {
        dateKey,
        cumulativeSteps: cumulativeSteps || 0,
        deltaSteps: steps,
        elapsedMs: lastAt ? now - lastAt : 0,
        sameValueCount: await countSameValueSyncs(user, dateKey, cumulativeSteps || 0),
      });
      if (anomaly && anomaly.autoBan) {
        const info = await anticheat.restrict({
          user,
          scope: 'sync',
          days: 7,
          operator: 'system',
          escalate: true,
          reason: `步数异常（${(anomaly.reasons || []).join('、') || '可疑'}）`,
        });
        return { restricted: { violation: true, ...info, message: '步数异常' } };
      }
    } catch (e) {
      // 研判失败绝不能阻塞正常同步（宁可漏判，也不能让用户同步不了）
    }
  }

  const est = wechat.estimateFromSteps(steps);
  const payload = {
    steps,
    distance: est.distance,
    calories: est.calories,
    durationSeconds: est.durationSeconds,
    goalAchieved: false,
  };
  const doc = merge
    ? await RunRecord.findByIdAndUpdate(last._id, { $set: payload }, { new: true })
    : await RunRecord.create({ openid: user.openid, date: dateKey, source: 'werun', ...payload });
  return { record: withPace(doc), merged: merge };
}

// 记录一次 GPS 实跑
async function saveGpsRun(user, { date, distance, durationSeconds, calories, steps, startTime, endTime, routePoints, location }) {
  const blocked = teacherBlock(user);
  if (blocked) return blocked;

  const dateKey = date || todayKey();

  // ===== GPS 的学习模型判定（用户 2026-10-27「针对不同的跑步类型分开来」）=====
  //
  // ⚠️ 顺序很关键：模型判定必须在**规则拦截之前**跑。
  //   否则「配速 1.5 分/公里」这种最典型的作弊会被 checkPace 先拦掉，
  //   异常记录一条都不落 —— 管理员事后完全看不出「这个人为什么被封」，
  //   也不知道模型判了没有（这正是自测时发现的问题）。
  //   现在：先落线索（不论最终封不封），再由规则决定是否封禁。
  //
  // GPS 与微信同步用**两套完全独立的模型与特征**（见 services/anticheat-model.js）：
  //   微信同步看步数/整数化/同步节奏；GPS 看配速/轨迹点/平滑度/距离时长组合。
  // 绝不给 GPS 跑「步数特征」—— 那会让配速异常的人因为步数正常而漏判。
  let anomaly = null;
  try {
    const acModel = require('./anticheat-model');
    const modelResult = await acModel.evaluate('gps', { distance, durationSeconds, routePoints });
    if (modelResult) {
      const score = Math.max(0, Math.min(100, Math.round((modelResult.score - 0.5) * 250)));
      anomaly = { ...modelResult, score };
      if (modelResult.level === 'suspicious' || modelResult.level === 'autoBan') {
        const StepAnomaly = require('../models/step-anomaly');
        await StepAnomaly.create({
          userId: user._id,
          openid: user.openid || '',
          realName: user.realName || user.nickname || user.account || '',
          className: user.className || '',
          studentId: user.studentId || '',
          date: dateKey,
          // GPS 没有「步数」：cumulativeSteps/deltaSteps 留 0（列表语义不混乱），
          // 用 reasons 说明异常（管理端已按 reasons 展示）
          cumulativeSteps: 0,
          deltaSteps: 0,
          score,
          reasons: modelResult.reasons || [],
          status: 'open',
          source: 'gps', // 来源分流：列表里可区分是哪种跑步被判定
          modelScore: Number(modelResult.score),
          modelLevel: modelResult.level,
          features: modelResult.features || null,
        });
      }
    }
  } catch (e) {
    // 模型不可用不影响正常保存（规则校验仍在下方执行）
  }

  // 规则校验（配速 / 升级为限制登录）：仍然生效，且拦截时不丢上面的线索记录
  const result = await anticheat.checkPace(user, distance, durationSeconds);
  if (result.violation) return { restricted: result, anomaly };

  if (anomaly && anomaly.level === 'autoBan') {
    // GPS 自动封禁只限 scope=gps（不影响微信同步），与 checkPace 一致
    const info = await anticheat.restrict({
      user,
      scope: 'gps',
      days: 7,
      operator: 'system',
      escalate: true,
      reason: `GPS 轨迹异常（${(anomaly.reasons || []).join('、') || '可疑'}）`,
    });
    return { restricted: { violation: true, ...info, message: 'GPS 轨迹异常' }, anomaly };
  }

  // ===== 步数与卡路里换算（用户 2026-10-27「你看这个没有步数的换算啊」）=====
  //
  // 问题：GPS 记录原来把 `steps: 0` / `calories: calories || 0` 直接写库，
  //   而小程序提交 GPS 时**只传 distance + durationSeconds**（它没有计步能力，
  //   wx.getLocation 回调里也没有步数），于是详情页永远显示「0 步 / 0 千卡」。
  //
  // 修复：按**距离反算步数**，与微信同步用同一套换算口径（services/wechat.js）：
  //   · 0.7 米/步 → steps = distance / 0.7
  //   · 卡路里 = steps × 0.04（与 estimateFromSteps 一致）
  // 若客户端将来开始传步数（手环/系统计步），优先用它传的值 —— 真实计步永远优于估算。
  const distMeters = Math.max(0, Math.round(Number(distance) || 0));
  const clientSteps = Math.max(0, Math.round(Number(steps) || 0));
  const stepsFromDist = Math.round(distMeters / 0.7); // 与 estimateFromSteps 的 0.7 米/步 同口径
  const finalSteps = clientSteps > 0 ? clientSteps : stepsFromDist;
  // 卡路里：客户端给了就用它，否则按步数折算（0.04 千卡/步，与微信同步一致）
  const finalCalories =
    Number(calories) > 0 ? Math.round(Number(calories)) : Math.round(finalSteps * 0.04);

  const doc = await RunRecord.create({
    openid: user.openid,
    source: 'gps',
    date: dateKey,
    steps: finalSteps,
    distance: distMeters,
    calories: finalCalories,
    durationSeconds: Math.round(durationSeconds || 0),
    startTime,
    endTime,
    routePoints: Array.isArray(routePoints) ? routePoints.slice(0, 5000) : [],
    location: location || '',
  });
  return { record: withPace(doc), anomaly };
}

// 激励视频上报：校验每日上限 → 按配置一次性入账四项（步数/距离/卡路里/时长）→ 记录
// 幂等：客户端每次观看生成一个 watchId，同一个 watchId 重复提交只入账一次（返回上一次结果）
async function reportRewardVideo(user, { watchId } = {}) {
  if (isTeacher(user)) return { error: TEACHER_BLOCK_MESSAGE };

  const config = await GoalConfig.getSingleton();
  if (!config.rewardVideo.enabled) {
    return { error: '激励视频活动未开启' };
  }
  const date = todayKey();
  const limit = config.rewardVideo.dailyLimit;
  // 每次入账的四项：以 goal_config.rewardVideo 为唯一真源；距离/卡路里/时长未单独配置时
  // 按既有的步数换算（wechat.estimateFromSteps）派生（见 services/reward-video.js）
  const per = rewardVideoSvc.resolvePerWatch(config.rewardVideo);
  const nonce = String(watchId || '').trim().slice(0, 64);

  let rec = await RewardVideoRecord.findOne({ openid: user.openid, date });
  if (!rec) {
    rec = await RewardVideoRecord.create({ openid: user.openid, date, watchCount: 0, stepsEarned: 0, watchIds: [] });
  }
  // 同一次观看重复上报（网络重试/重复点击）：不再入账、不再消耗次数，原样返回上一次结果
  if (nonce && (rec.watchIds || []).includes(nonce)) {
    return {
      watchCount: rec.watchCount,
      stepsEarned: rec.stepsEarned,
      awarded: per,
      remaining: Math.max(0, limit - rec.watchCount),
      limit,
      duplicated: true,
    };
  }
  if (rec.watchCount >= limit) {
    return { error: `今日观看已达上限（${limit} 次）`, limit, watchCount: rec.watchCount, stepsEarned: rec.stepsEarned };
  }

  // 原子领取：以 watchCount 作版本号做一次 CAS，并发/重放都不会重复计数或重复入账
  const claimed = await RewardVideoRecord.findOneAndUpdate(
    {
      _id: rec._id,
      watchCount: rec.watchCount,
      ...(nonce ? { watchIds: { $ne: nonce } } : {}),
    },
    {
      $inc: { watchCount: 1, stepsEarned: per.steps },
      ...(nonce ? { $push: { watchIds: { $each: [nonce], $slice: -50 } } } : {}),
    },
    { new: true }
  );
  if (!claimed) {
    const latest = await RewardVideoRecord.findOne({ openid: user.openid, date });
    if (nonce && latest && (latest.watchIds || []).includes(nonce)) {
      return {
        watchCount: latest.watchCount,
        stepsEarned: latest.stepsEarned,
        awarded: per,
        remaining: Math.max(0, limit - latest.watchCount),
        limit,
        duplicated: true,
      };
    }
    return { error: '上报过于频繁，请稍后重试' };
  }

  // 北斗记录：一次观看的四项奖励合并进当日同一条 source='beidou' 记录
  // （单列一种来源，不混进微信运动记录，这样下一次微信同步不会把奖励数据覆盖掉）。
  // 记录页 / 排行榜 / 跑分 / 徽章 / 首页统计都是聚合 run_records，
  // 因此四项与既有统计口径完全一致，不存在「页面看得见、统计看不见」。
  await RunRecord.findOneAndUpdate(
    { openid: user.openid, date, source: 'beidou' },
    {
      $inc: {
        steps: per.steps,
        distance: per.distance,
        calories: per.calories,
        durationSeconds: per.durationSeconds,
      },
      $setOnInsert: { openid: user.openid, date, source: 'beidou' },
    },
    { upsert: true }
  );
  return {
    watchCount: claimed.watchCount,
    stepsEarned: claimed.stepsEarned,
    awarded: per,
    stepsAwarded: per.steps, // 兼容老客户端字段
    remaining: Math.max(0, limit - claimed.watchCount),
    limit,
  };
}

// 同步后统一刷新：目标达成标记 + 用户汇总 + 徽章
// 目标达成按「当日总量」判定（同步可能被拆成多条记录，不能再按单条记录比）
async function postSyncRefresh(user, dateKeys = []) {
  const goalsSvc = require('./goals');
  const goal = await goalsSvc.getEffectiveGoal(user.openid);
  for (const date of dateKeys) {
    const agg = await RunRecord.aggregate([
      { $match: { openid: user.openid, date } },
      { $group: { _id: null, steps: { $sum: '$steps' } } },
    ]);
    const total = agg.length ? agg[0].steps || 0 : 0;
    const achieved = total >= (goal.daily.steps || Infinity);
    if (achieved) {
      // 达标：该日微信运动记录统一标记（未达标时不改，保留既有的历史达标状态）
      await RunRecord.updateMany(
        { openid: user.openid, date, source: 'werun' },
        { $set: { goalAchieved: true } }
      );
    }
  }
  await badgesSvc.refreshUserStats(user);
  const newBadges = await badgesSvc.evaluateBadges(user.openid);
  return { newBadges };
}

// 某日总量（步数/距离/卡路里/时长）—— 聚合当日所有来源的记录
async function dayTotals(openid, date) {
  const agg = await RunRecord.aggregate([
    { $match: { openid, date } },
    {
      $group: {
        _id: null,
        steps: { $sum: '$steps' },
        distance: { $sum: '$distance' },
        calories: { $sum: '$calories' },
        durationSeconds: { $sum: '$durationSeconds' },
        recordCount: { $sum: 1 },
      },
    },
  ]);
  const t = agg[0] || { steps: 0, distance: 0, calories: 0, durationSeconds: 0, recordCount: 0 };
  return {
    steps: t.steps || 0,
    distance: t.distance || 0,
    calories: t.calories || 0,
    durationSeconds: t.durationSeconds || 0,
    recordCount: t.recordCount || 0,
  };
}

module.exports = {
  syncWerunDay,
  saveGpsRun,
  reportRewardVideo,
  postSyncRefresh,
  dayTotals,
  withPace,
  isTeacher,
  TEACHER_BLOCK_MESSAGE,
  SYNC_WINDOW_MS,
};
