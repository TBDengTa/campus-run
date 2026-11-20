const GoalConfig = require('../models/goal-config');
const BanRecord = require('../models/ban-record');
const User = require('../models/user');
const badgesSvc = require('./badges');
// 日历键唯一口径（本地时区）：解封闸门要把 liftedAt 折成日期比线索日期，
// 自己 toISOString 取 UTC 日会把「北京早晨解封」算成前一天（见 liftedCoversClueDate）。
const dates = require('../utils/dates');

// ===== 限制的作用域 =====
//   login 限制登录（整账号，走 user.status + bannedUntil）
//   sync  限制微信同步（微信运动步数同步）
//   gps   限制 GPS 实跑
const SCOPES = ['login', 'sync', 'gps'];
const DAY_MS = 24 * 3600 * 1000;
const SCOPE_TEXT = { login: '登录', sync: '微信同步', gps: 'GPS 实跑' };

// ===== 微信运动同步的误伤护栏（用户 2026-10-26「同步的微信步数不要被封禁」）=====
// STALE_SYNC_MS：距上次同步超过这么久，就视为「攒了一段时间才同步」——
//   此时增量天然等于这段时间的累计步数，一律不按「暴增」处理（首次同步同理）。
const STALE_SYNC_MS = 30 * 60 * 1000;
// MAX_REASONABLE_DAILY_STEPS：单日步数的物理上限。真实高强度用户（长跑/巡逻）能到 3~5 万，
//   超过这个数才可能是脚本刷步；不超过它的一律视为真实步数，判违规没有意义。
const MAX_REASONABLE_DAILY_STEPS = 50000;

function normalizeScope(scope) {
  if (scope === 'manual') return 'login'; // 历史记录 banType='manual' 即整账号封禁
  return SCOPES.includes(scope) ? scope : 'login';
}

function scopeText(scope) {
  return SCOPE_TEXT[normalizeScope(scope)] || '功能';
}

/**
 * 「已有的限制是否已经覆盖本次要写入的时长」（restrict 幂等判定的唯一比较口径）。
 *
 * ⚠️ until = null 的含义是**永久**，必须单独判，不能当成 0 / Infinity 直接比大小：
 *   · 已有永久 + 本次 7 天 → 已覆盖（跳过重写，否则只多一条 ban_records 流水）
 *   · 已有 7 天 + 本次永久 → **没**覆盖（人工「永久封禁」必须能盖掉系统写的 7 天；
 *     漏了这种就是「管理员设成永久、过会儿又变回 7 天」的成因）
 *   · 已有 30 天 + 本次 7 天 → 已覆盖（否则管理员延长后又被系统短封覆盖回去）
 *   · 已有已过期 → 不覆盖（照常写；login 那边过期的由 auth 中间件自动解除）
 * 参数 existingUntil 传 null 且 existingActive=true 就表示「已有永久限制」。
 */
function coversUntil(existingActive, existingUntil, newUntil) {
  if (!existingActive) return false;
  if (!existingUntil) return true; // 已有永久：任何新的到期时间都不会比它更宽
  if (!newUntil) return false; // 本次要永久：有限的旧值盖不住
  return new Date(existingUntil) >= new Date(newUntil);
}

// 某 scope 当前是否**真的生效**（restrict 的幂等判定用，与 isRestricted 同一口径）
function activeUntilOf(user, scope) {
  const s = normalizeScope(scope);
  const now = new Date();
  if (s === 'login') {
    if (user.status !== 'banned') return { active: false, until: null };
    const u = user.bannedUntil || null;
    return { active: !u || u > now, until: u };
  }
  const r = (user.restrictions || {})[s];
  // 注意：sync/gps 的限制**没有永久形态**（isRestricted 要求 until 有值才算生效），
  // 所以这里 until 为空一律算「没有生效中的限制」，照旧写入 —— 不改变既有语义。
  if (!r || !r.until || !(r.until > now)) return { active: false, until: null };
  return { active: true, until: r.until };
}

/**
 * 该 scope 最近一次被**人工/申诉解封**的时刻（用户 2026-11-19「解封的会被重复封禁」）。
 * 没有解封过返回 null。唯一实现 —— 自动封禁前的「这批数据已被推翻」闸门只读这里，
 * 不要在 steps.js / 路由里各自去翻 restrictions.liftedAt。
 */
function lastLiftedAt(user, scope) {
  const s = normalizeScope(scope);
  if (s === 'login') return (user && user.banLiftedAt) || null;
  const r = (user && user.restrictions && user.restrictions[s]) || {};
  return r.liftedAt || null;
}

/**
 * 自动处置闸门：这批数据是否已经被人工推翻过（用户 2026-11-19「解封的会被重复封禁」）。
 *
 * 语义（与 lift 的既有产品口径一致：**解封 = 之前那次违规被推翻/勾销**）：
 *   线索所属**日期** ≤ 该 scope 最近一次解封的日期 → 这批数据人工已经判过一次，
 *   不再自动处置；线索照常落库/保留（open，等人工看），只是不自动封人。
 *   解封**次日**起的新数据 date 晚于解封日 → 照旧正常自动封禁，
 *   闸门只挡「同一天同一批」，不放松整体反作弊
 *   （与「涨幅速度封顶 0.72」「宁可漏判也不误封」是同一条边界）。
 *
 * ⚠️ 比较的是**线索日期**而不是线索 createdAt：微信 7 天回补会给历史日期补建记录
 *   （AGENTS.md「跨日补同步行」：最近 500 条 werun 里 225 条是这种）。
 *   用 createdAt 比较 = 「昨天被解封、今天回补昨天的数据」再封一次，正是用户报的现象。
 * ⚠️ 日历键一律走 utils/dates::toDateKey（本地时区，全库唯一口径）。
 *   自己 `toISOString().slice(0,10)` 取的是 UTC 日：「北京 07:00 解封」会被算成前一天，
 *   于是**解封当天早晨的正常同步又被封一次**。
 *
 * 四条自动处置路径（werun AI / GPS AI / checkStepJump / checkPace）都只过这一个函数。
 *
 * @param {object} user    用户文档
 * @param {string} scope   sync | gps
 * @param {string} dateKey 线索所属日期 YYYY-MM-DD
 * @returns {boolean} true = 应跳过本次自动处置
 */
function liftedCoversClueDate(user, scope, dateKey) {
  const liftedAt = lastLiftedAt(user, scope);
  if (!liftedAt) return false;
  if (!dateKey) return false; // 没有日期维度时不拦（宁可照常处置，也不要因为参数缺失放行作弊）
  return String(dateKey) <= dates.toDateKey(liftedAt);
}

// 某作用域当前是否生效（到期视为失效，不写库）
function isRestricted(user, scope) {
  const s = normalizeScope(scope);
  const now = new Date();
  if (s === 'login') {
    return user.status === 'banned' && (!user.bannedUntil || user.bannedUntil > now);
  }
  const r = (user.restrictions || {})[s];
  return !!(r && r.until && r.until > now);
}

// 生效中的全部限制（给接口/小程序展示与申诉用）
//
// 用户 2026-10-30「封禁用户要有分类 如人封、机封、AI封」：
// 每条限制都带 source（manual 人封 / ai AI封 / rule 机封），前端据此打标签与筛选。
// 历史记录没有 source → 按 operator 推断（见 models/ban-record.js::normalizeSource 的说明：
// 推断不到的标 legacy，**不猜**，否则「AI 误封率」这类统计会失真）。
function activeRestrictions(user) {
  const now = new Date();
  const BanRecord = require('../models/ban-record');
  // 局部归一化：优先用 model 上的唯一实现，model 不可用时退化为「有 source 用 source」。
  // （之所以容错：本文件被 run/auth 等热路径引用，绝不能因为一个 require 失败而整体崩）
  const norm = (src, operator) => {
    try {
      return BanRecord.normalizeSource({ source: src, operator });
    } catch (e) {
      return src || (operator && operator !== 'system' ? 'manual' : 'legacy');
    }
  };
  const out = [];
  // 文案也在这里出（本函数已是「给接口/小程序展示」的唯一出口）：
  // 只给 source 会逼每个消费方再映射一份中文，两份文案必然漂移。
  const textOf = (src) => {
    try {
      return BanRecord.SOURCE_TEXT[src] || '';
    } catch (e) {
      return '';
    }
  };
  if (user.status === 'banned' && (!user.bannedUntil || user.bannedUntil > now)) {
    const src = norm(user.banSource, '');
    out.push({
      scope: 'login',
      text: scopeText('login'),
      reason: user.banReason || '',
      until: user.bannedUntil || null,
      // 账号级封禁的来源存在 user.banSource 上（restrict 写入时同步落库）。
      // 历史账号没有这个字段 → norm 退化为 legacy（不猜规则/AI）。
      source: src,
      sourceText: textOf(src),
    });
  }
  for (const s of ['sync', 'gps']) {
    const r = (user.restrictions || {})[s];
    if (r && r.until && r.until > now) {
      const src = norm(r.source, r.operator);
      out.push({
        scope: s,
        text: scopeText(s),
        reason: r.reason || '',
        until: r.until,
        source: src,
        sourceText: textOf(src),
      });
    }
  }
  return out;
}

// 生效中的单项限制（供 run 路由拦截）
function activeRestriction(user, scope) {
  const s = normalizeScope(scope);
  return activeRestrictions(user).find((r) => r.scope === s) || null;
}

/**
 * 写入限制（自动反作弊与人工封禁共用）
 * @param {Object} p
 * @param {Object} p.user      用户文档（会被 save）
 * @param {String} p.scope     login | sync | gps
 * @param {String} p.reason    原因
 * @param {Number} p.days      >0 天数；<=0 永久
 * @param {String} p.operator  'system' 或管理员 openid
 * @param {Boolean} p.escalate 同类 24h 内重犯 → 升级为限制登录
 * @returns {{ scope, until, escalated }}
 *
 * ⚠️ **幂等闸门**（用户 2026-11-19「解封的会被重复封禁」的流水侧表现）：
 *   该 scope 已有**仍在生效且不早于本次**的限制时，直接返回已有结果，
 *   不再重复写 user 字段、不再重复落 ban_records、也不再重复撤销徽章。
 *   旧实现每次都写一遍：实测同一用户流水里出现相邻两条 action='ban'
 *   （「封了两次、解封要解两次」），而用户管理页按 ban_records 分类计数会翻倍。
 *   判定用 until 而不是 reason —— 同一个人当天多次同步本就该只算一次处置。
 */
async function restrict({ user, scope, reason, days = 0, operator = 'system', escalate = false, source = '' }) {
  const target = normalizeScope(scope);
  const now = new Date();
  const until = days > 0 ? new Date(now.getTime() + days * DAY_MS) : null;
  const baseReason = String(reason || '').trim() || '数据异常';

  // 判定依据（用户 2026-10-30「封禁要有分类」）：
  //   manual 人封 / ai AI封 / rule 机封。缺省按 operator 推断，
  //   保证「旧调用点忘了传 source」时不会写出空值（人工调用自动落 manual）。
  const finalSource = ['manual', 'ai', 'rule'].includes(source)
    ? source
    : operator && operator !== 'system'
      ? 'manual'
      : 'rule';

  let finalScope = target;
  if (escalate && target !== 'login') {
    const prev = (user.restrictions || {})[target] || {};
    const recent = prev.at && now.getTime() - new Date(prev.at).getTime() < DAY_MS;
    if (recent) finalScope = 'login';
  }
  const escalated = finalScope !== target;
  const finalReason = escalated
    ? `${baseReason}（同类违规 24 小时内重复，升级为限制登录）`
    : baseReason;

  // ===== 幂等：已经压得住就不要再压一次 =====
  //
  // ⚠️ 判据**不能只看 until 谁更晚**：自动封禁每次都是 `now + days`，
  //   第二次调用时 now 往后推了几毫秒，新的 until 就「比旧的更晚」→ 同一条限制
  //   永远判不成「已覆盖」，幂等形同虚设（本轮真实踩到：同一次 7 天回补同步里
  //   逐日判定会把流水写到 7 条）。正确口径按**执行主体**分：
  //   · 自动处置（operator='system'，含两条 AI 通道与两条规则通道）：
  //     该 scope 已有生效中的限制 → 跳过。人已经在封了，再封一次只多一条流水、
  //     多撤销一次徽章，对「限制学生」这件事没有任何增量作用。
  //   · 人工（管理员/申诉审核）：照常写入 —— 管理员明确改时长/改永久是**新意图**，
  //     必须能盖掉系统写的值（否则「设成永久又被系统改回 7 天」会反过来变成
  //     「设成 30 天结果被幂等吞掉」）。
  //   人工写入时仍用 coversUntil 比较：已有永久 + 本次有限 = 没有意义，跳过。
  const cur = activeUntilOf(user, finalScope);
  const isAutoDispose = !operator || operator === 'system';
  if (cur.active && (isAutoDispose || coversUntil(cur.active, cur.until, until))) {
    return { scope: finalScope, until: cur.until, escalated: false, skipped: 'already-restricted' };
  }

  if (finalScope === 'login') {
    user.status = 'banned';
    user.banReason = finalReason;
    user.banType = 'login';
    user.bannedAt = now;
    user.bannedUntil = until;
    // 账号级状态也带上来源：用户列表里「当前封禁原因」要能显示是人封还是 AI 封
    // （只存在 restrictions 里的 sync/gps 限制没有这个位置，靠 ban_records 查）
    user.banSource = finalSource;
  } else {
    const prev = (user.restrictions || {})[finalScope] || {};
    user.restrictions[finalScope] = {
      until,
      reason: finalReason,
      at: now,
      count: (prev.count || 0) + 1,
      operator,
      source: finalSource,
      // ⚠️ liftedAt 必须**保留**（不是重置为 null）：它是「人工已推翻过这批数据」的唯一凭据，
      //   新一次违规不该把它抹掉 —— 抹掉后同一天其它批次的自动判定就失去闸门了。
      liftedAt: prev.liftedAt || null,
    };
  }
  await user.save();
  await BanRecord.create({
    userId: user._id,
    openid: user.openid,
    action: 'ban',
    banType: finalScope,
    reason: finalReason,
    durationDays: days || 0,
    bannedUntil: until,
    operator,
    // 判定依据：manual 人封 / ai AI封 / rule 机封（用户 2026-10-30）
    source: finalSource,
  });
  // ===== 徽章撤销（产品口径）=====
  // 撤销触发源只有两处：① 反作弊判定成立（checkStepJump / checkPace）；② 封禁（人工 manualBan 与申诉外的限制）。
  // 两者都收敛到本函数，所以在这里删一次即可 —— **只在判定成立时执行**（restrict 不会被正常用户触发），
  // 正常的 evaluateBadges 评估不会走到这里，绝不会误删普通用户的徽章。
  // 语义：删除记录（不加 revoked 字段），解封/到期**不自动恢复**；用户以后再次满足条件会自然重新获得。
  // 幂等：deleteMany 命中 0 行也成功。清理失败绝不能影响「限制生效」这一主流程 → 只记日志。
  try {
    await badgesSvc.revokeBadgesFor(user.openid, { reason: `限制${scopeText(finalScope)}：${finalReason}` });
  } catch (e) {
    console.warn(`[anticheat] 撤销徽章失败（不影响限制生效）openid=${user.openid}: ${e.message}`);
  }
  return { scope: finalScope, until, escalated };
}

/**
 * 解除限制
 * @param {Object} p
 * @param {String} p.scope  login | sync | gps | all
 *
 * 注意（产品口径）：解封 / 限制到期**不恢复徽章** —— 撤销是删除记录，没有「恢复」动作；
 * 用户下次满足条件时由 evaluateBadges 重新发放（见 revokeBadgesFor 注释）。
 */
async function lift({ user, scope = 'all', operator, reason = '解封' }) {
  const now = new Date();
  const targets = scope === 'all' ? SCOPES : [normalizeScope(scope)];
  const lifted = [];
  for (const s of targets) {
    if (s === 'login') {
      if (user.status === 'banned' || user.bannedUntil || user.banReason) {
        user.status = 'active';
        user.banReason = '';
        user.banType = '';
        user.bannedAt = null;
        user.bannedUntil = null;
        // ⚠️ 留一笔解封时刻（用户 2026-11-19「解封的会被重复封禁」）：
        //   login 这一档不在 restrictions 里，上面几个字段又全被清空，
        //   不留 banLiftedAt 就没人知道「这批数据已经被人工推翻过」，
        //   同一天再判定一次就再封一次 —— 而自动封禁侧需要的正是这个凭据。
        user.banLiftedAt = now;
        lifted.push('login');
      }
    } else {
      const r = (user.restrictions || {})[s];
      if (r && (r.until || r.reason)) {
        // ⚠️ 解封要把 `at` 清空（用户 2026-10-28「被封禁的情况重复记录，申诉成功后不会重新封锁」）。
        //
        //   restrict() 的「24 小时内重犯 → 升级为限制登录」判据是 prev.at：
        //     const recent = prev.at && now - prev.at < DAY_MS;
        //   旧实现解封时写 `at: now`（解封时刻），于是**刚解封就处于"24 小时内已违规"状态**：
        //   学生申诉成功 → 立刻解封 → 当天正常同步再触发一次规则 → 直接升级限制登录，
        //   看起来就是"申诉成功后又被重新封锁"。
        //
        //   正确语义：解封 = 之前那次违规的记录被推翻/勾销，24 小时窗口应从**下一次**违规重新算。
        //   把 at 置空 → recent 判定为 false → 下次仍按首次（限制同步 / 限制 GPS），不再升级。
        //   count 保留（它是历史累犯次数，用于统计；升级判定只看 at，不看 count）。
        //
        //   liftedAt 是**另一个维度**（用户 2026-11-19）：at 置空解决的是「升级为封号」，
        //   但「同一天同一批数据被重新判一次就再封一次」没有解决 ——
        //   自动封禁前需要看「线索日期 ≤ liftedAt」才知道这批已被推翻，跳过处置。
        //   两个字段各管一件事，**绝不能合并成一个**（那是 2026-10-28 那次修复的反面）。
        user.restrictions[s] = {
          until: null,
          reason: '',
          at: null,
          count: r.count || 0,
          operator: operator || 'system',
          source: '',
          liftedAt: now,
        };
        lifted.push(s);
      }
    }
  }
  if (!lifted.length) return { lifted };
  await user.save();
  for (const s of lifted) {
    await BanRecord.create({
      userId: user._id,
      openid: user.openid,
      action: 'unban',
      banType: s,
      reason,
      operator: operator || 'system',
    });
  }
  return { lifted };
}

// ===== 反作弊检查 =====
/**
 * 步数暴增检测（微信运动同步）→ 限制微信同步；24h 内重犯升级为限制登录。
 *
 * ⚠️ 用户 2026-10-26：「微信运动学生账户要进入页面自动同步，同步的微信步数不要被封禁」。
 * 这条检测**原本会误伤正常人**，必须按「同步节奏」而不是「绝对增量」判断：
 *
 *   反例（修复前必然踩到）：学生白天走了 15000 步，晚上第一次进小程序（或昨天没开过），
 *   一次同步写入 15000 步 → 旧逻辑只看 `jump > maxStepJumpPerSync(13000)`
 *   → 判「单次同步暴增」→ 限制微信同步 7 天；24h 内再撞一次就**升级为限制登录**。
 *   可这完全是微信运动的真实步数，用户什么也没做错。**进页面自动同步会让这个误伤频次大增**。
 *
 * 正确口径（三个条件都要满足才算异常）：
 *   ① **不是「攒了很久才同步」** —— 距上次微信同步超过 STALE_SYNC_MS（30 分钟）时，
 *      增量天然就是「这段时间攒下的全部步数」，属于正常补同步；首次同步同理（无记录即 stale）。
 *   ② 当日累计超过 MAX_REASONABLE_DAILY_STEPS（50000）：真实高强度用户也能到 3~5 万步，
 *      旧阈值 13000 对「全天累计的首同步」过窄。
 *   ③ 同时单次增量仍超过配置阈值：短窗口内暴增这么多，才可能是脚本刷步。
 *
 * @param {object} user
 * @param {string} date 日期键 YYYY-MM-DD
 * @param {number} previousSteps 今天已记录的步数
 * @param {number} newSteps 本次同步的当日累计步数
 * @param {{lastSyncAt?: number}} [ctx] 该用户上一次微信同步的时间戳（毫秒）
 */
async function checkStepJump(user, date, previousSteps, newSteps, ctx = {}) {
  const config = await GoalConfig.getSingleton();
  if (!config.anticheat.enabled) return { violation: false };
  const jump = (newSteps || 0) - (previousSteps || 0);
  if (jump <= 0) return { violation: false };

  // ① 首次同步 / 长时间未同步后的补同步 → 增量天然是累计值，不算「暴增」
  const lastSyncAt = Number(ctx.lastSyncAt) || 0;
  const stale = lastSyncAt > 0 ? Date.now() - lastSyncAt > STALE_SYNC_MS : true;
  if (stale) return { violation: false };

  // ② 当日累计没超过物理上限 → 真实步数，不判违规
  if ((newSteps || 0) <= MAX_REASONABLE_DAILY_STEPS) return { violation: false };

  // ③ 短窗口内仍然暴增超过配置阈值 → 才认定异常
  if (jump > config.anticheat.maxStepJumpPerSync) {
    // ⚠️ ④ 人工推翻闸门（用户 2026-11-19「解封的会被重复封禁」）——
    //   规则通道与两条 AI 通道**过同一个闸门**（liftedCoversClueDate 是唯一实现）：
    //   旧版只在 AI 侧判，规则侧（这条「单次暴增」）照样能把刚解封的人再封一次，
    //   而库里实测这类流水占多数（operator=system、reason 前缀「单次同步暴增」）。
    //   闸门命中时**不写处置**：同步本身照常成功，这条数据留在待研判队列里等人工看。
    if (liftedCoversClueDate(user, 'sync', date)) {
      return { violation: false, skipped: 'lifted', message: '该日数据已被人工解封推翻，不再自动处置' };
    }
    const days = config.anticheat.banDays || 7;
    const info = await restrict({
      user,
      scope: 'sync',
      days,
      operator: 'system',
      // 判定依据 = 机封（确定性规则）：单次同步暴增超阈值，不经过 AI 模型
      source: 'rule',
      escalate: true,
      reason: `单次同步暴增${jump.toLocaleString()}步，数据异常`,
    });
    return { violation: true, ...info, message: `单次同步暴增${jump}步` };
  }
  return { violation: false };
}

// 配速异常（GPS 实跑）→ 限制 GPS；24h 内重犯升级为限制登录
//
// ⚠️ 第四个参数 ctx.dateKey（用户 2026-11-19「解封的会被重复封禁」）：
//   规则通道也要过「已被人工推翻」闸门，与两条 AI 通道同一个口径。
//   调用方（steps.saveGpsRun）一定传；缺失时**照常处置**（不因为参数没传就放行作弊）。
async function checkPace(user, distanceMeters, durationSeconds, ctx = {}) {
  const config = await GoalConfig.getSingleton();
  if (!config.anticheat.enabled) return { violation: false };
  if (distanceMeters >= 500 && durationSeconds > 0) {
    const paceSeconds = durationSeconds / (distanceMeters / 1000);
    if (paceSeconds < config.anticheat.minPaceSecondsPerKm) {
      // 人工已经推翻过这一天的数据 → 不再自动处置（线索/记录照常，只是不封人）
      if (liftedCoversClueDate(user, 'gps', ctx.dateKey)) {
        return { violation: false, skipped: 'lifted', message: '该日数据已被人工解封推翻，不再自动处置' };
      }
      const m = Math.floor(paceSeconds / 60);
      const s = Math.round(paceSeconds % 60);
      const days = config.anticheat.banDays || 7;
      const info = await restrict({
        user,
        scope: 'gps',
        days,
        operator: 'system',
        // 判定依据 = 机封（确定性规则）：配速低于阈值，不经过 AI 模型
        source: 'rule',
        escalate: true,
        reason: `配速${m}'${String(s).padStart(2, '0')}/公里，低于${Math.floor(config.anticheat.minPaceSecondsPerKm / 60)}分钟/公里，异常`,
      });
      return { violation: true, ...info, message: '配速异常' };
    }
  }
  return { violation: false };
}

// ===== 管理端（人工）=====
// scope: login 限制登录（默认，整账号）/ sync 限制微信同步 / gps 限制 GPS
async function manualBan(user, { reason, days, operator, scope = 'login' }) {
  // 显式标 manual（用户 2026-10-30「人封/机封/AI封」分类）：
  // 虽然 restrict 会按 operator 推断，但显式写更稳 ——
  // 万一将来有调用方用 operator='system' 做人工批量封禁（如运维脚本），推断会误判成机封。
  return restrict({ user, scope, reason: reason || '违反社区规范', days: days || 0, operator, source: 'manual' });
}

// scope 省略时解除全部限制
async function manualUnban(user, operator, scope = 'all') {
  return lift({ user, scope, operator, reason: '管理员解封' });
}

module.exports = {
  SCOPES,
  scopeText,
  isRestricted,
  activeRestriction,
  activeRestrictions,
  restrict,
  lift,
  // 解封留痕的唯一读取出口（steps.js 的自动封禁闸门用它，不要各自翻 restrictions.liftedAt）
  lastLiftedAt,
  liftedCoversClueDate,
  coversUntil,
  activeUntilOf,
  checkStepJump,
  checkPace,
  manualBan,
  manualUnban,
};
