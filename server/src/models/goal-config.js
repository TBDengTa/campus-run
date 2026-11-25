const mongoose = require('mongoose');

// 全局配置单例：目标 / 反作弊 / 激励视频 / 跑分
const goalConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true },
    daily: {
      steps: { type: Number, default: 5000 },
      distance: { type: Number, default: 3000 }, // 米
      calories: { type: Number, default: 250 },
    },
    weekly: {
      steps: { type: Number, default: 35000 },
      distance: { type: Number, default: 21000 },
      calories: { type: Number, default: 1750 },
    },
    // 跑分：学校使用的衡量标准（达标基础分 + 超出目标的加分）
    // 计算公式见 services/points.js 文件头注释（与用户端 /api/points 完全一致）
    points: {
      enabled: { type: Boolean, default: true }, // 关闭后跑分一律为 0（不展示、不上榜）
      dailyGoal: { type: Number, default: 5 }, // 完成日目标得分
      weeklyGoal: { type: Number, default: 20 }, // 完成周目标得分
      // 日超出档位：超出日目标后，每再多达成「个人日目标 × extraPercent%」的步数，得 perStepScore 分
      // （百分比而非固定步数：档位随个人目标等比放大，相对努力等值）
      extraPercent: { type: Number, default: 10 }, // 百分比，范围 1~100
      // 周超出档位：超出周目标后，每再多达成「个人周目标 × weeklyExtraPercent%」的步数，得 perStepScore 分
      weeklyExtraPercent: { type: Number, default: 10 }, // 百分比，范围 1~100
      // 【已完全弃用】固定步数档位：日、周公式都不再读取（保留字段仅为兼容存量配置文档）
      perStep: { type: Number, default: 1000 },
      perStepScore: { type: Number, default: 1 }, // 每达成一档加多少分（日/周共用）
      dailyExtraCap: { type: Number, default: 10 }, // 单日超出加分上限（只封顶超出部分，不封顶达标基础分）
      // 单周超出加分上限：**0 = 不封顶**（默认 0，与改造前的「周无上限」一致）；> 0 才封顶超出部分
      weeklyExtraCap: { type: Number, default: 0 },
    },
    anticheat: {
      // 单次同步步数暴增阈值。**2026-10-26 由 13000 提到 30000**（用户：「同步的微信步数不要被封禁」）：
      // 旧值 13000 对「白天走够了、晚上第一次进小程序」的人太窄 —— 一次首同步 15000 步就被
      // 判暴增、限制微信同步 7 天，24h 内再撞一次升级为限制登录，而那全是真实步数。
      // 配合 services/anticheat.js::checkStepJump 的「攒久了才同步不判违规」与 50000 单日上限，
      // 真实用户（含跑马拉松的）不会被误伤；真刷步的短时暴增仍会被抓。
      maxStepJumpPerSync: { type: Number, default: 30000 },
      minPaceSecondsPerKm: { type: Number, default: 120 }, // 配速低于该值(秒/公里)视为异常
      banDays: { type: Number, default: 7 },
      enabled: { type: Boolean, default: true },
      // ===== AI 模型严谨度（用户 2026-10-28「在反作弊中可以调整 AI 封禁的严谨程度」）=====
      //
      // 三档预设，对应 services/anticheat-model.js::STRICTNESS_PRESETS：
      //   loose 宽松 / balanced 平衡（默认）/ strict 严格 / custom 自定义（手调两个阈值）
      //
      // 为什么要做成档位而不是直接暴露两个小数：
      //   0.62 / 0.78 这种数字对管理员没有直觉 —— 「调到多少才不会误伤真实学生」没人答得上来。
      //   档位把「误伤风险」翻译成可理解的话（宽松 = 只封明显的，可能漏掉一些）。
      //
      // 阈值本身仍会被历史标注**自动微调**（见 anticheat-model 的在线校准），
      // 档位是「基线」，校准在基线上小幅浮动（±0.06 封顶），admin 调档立即生效且不会被校准吃掉。
      aiStrictness: { type: String, enum: ['loose', 'balanced', 'strict', 'custom'], default: 'balanced' },
      // custom 档才读这两个；其它档位忽略（避免"改了但没生效"的困惑）
      aiSuspiciousThreshold: { type: Number, default: 0.62 }, // 达到它 = 记一条「待研判」异常
      aiAutoBanThreshold: { type: Number, default: 0.78 }, // 达到它 = 自动限制

      // ===== 阶段性自升级开关（用户 2026-11-12「请增加阶段性自升级」）=====
      // 有监督模型分三级：0 无监督 → 1 影子辅助（只进待研判）→ 2 有监督主判（可封号）。
      // 两个开关只控制**定时评估能不能自动动阶段**；关掉后评估照跑、指标照更新，
      // 管理端仍能看到「已达闸门」并手动升（手动动阶段不受这两个开关影响）。
      // 为什么不设「自动升级必须人工再点一次确认」：影子阶段本身就是那道确认 ——
      // 它没有封号权力，最多把记录推进待研判队列，误判的代价只是多几条待看记录。
      autoUpgrade: { type: Boolean, default: true },
      // 自动降级：模型过时（作弊手法变了）时自动退一级。**默认开**——
      // 「只会升级不会降级」的模型是单向棘轮，只会越来越松。
      autoDemote: { type: Boolean, default: true },
    },
    rewardVideo: {
      dailyLimit: { type: Number, default: 10 }, // 每日观看上限
      stepsPerWatch: { type: Number, default: 1000 }, // 每次奖励步数
      // 每次奖励的另外三项：null = 未配置，按 stepsPerWatch 走
      // services/wechat.js::estimateFromSteps（0.7 米/步、0.04 千卡/步、0.5 秒/步）派生。
      // 单位与全库口径一致：距离米、时长秒；解析统一走 services/reward-video.js::resolvePerWatch
      distancePerWatch: { type: Number, default: null }, // 米，允许一位小数
      caloriesPerWatch: { type: Number, default: null }, // 千卡
      durationPerWatch: { type: Number, default: null }, // 秒
      // 激励视频广告位 ID（客户端公开标识，非密钥）：空 = 用户端用代码里的默认广告位。
      // 由管理端「北斗运动」配置下发，用户端从 /api/reward-video/today 读取。
      adUnitId: { type: String, default: '' },
      enabled: { type: Boolean, default: true },
    },
    /**
     * ===== 北斗运动 2.0（签到 + 转盘抽步数 + 看视频/分享得次数）=====
     * 方案与口径的唯一说明见 docs/beidou-lottery-plan.md，改这里之前先读它。
     *
     * 与旧 rewardVideo 段的关系：**旧段原样保留**（存量记录、历史统计、老客户端都还要用），
     * 本段是新增的独立配置，两者互不覆盖。旧段里「看一次视频直发步数」的能力由
     * routes/reward-video.js 降级为只回 success:false（D9），不再产生步数。
     *
     * 三个必须记住的口径：
     *   ① 抽奖结果**只由服务端定**，概率按 weight 归一（不是按扇区个数平均分）；
     *   ② 扇区只是视觉，sectors 由服务端下发，前端不得自己排顺序（否则停位与结果对不上）；
     *   ③ draw.dailyStepsCap 是**唯一成本闸门**（用户 2026-11-11 定了「次数不限 + 点分享即给」，
     *      这两条本身没有成本上限，全靠这个封顶兜住排行榜与跑分）。
     */
    beidou: {
      // 配置版本：v2（抽奖次数）→ v3（铜版经济）→ v4（九宫格随机盘面/图标）。
      version: { type: Number, default: 4 },
      enabled: { type: Boolean, default: true },
      // 音效总开关（用户 2026-11-12「增加点音效」）：关掉后用户端连 WAV 都不合成。
      // 音效是运行时**代码合成**的（主包已超限，不放 mp3），见 utils/sfx.js。
      sfxEnabled: { type: Boolean, default: true },
      // 虚拟积分展示名。用户原文用「铜版」，后台可改名（如「铜板」）。
      coinName: { type: String, default: '铜版' },
      // 铜版图标（管理员上传；空 = 用户端回退「铜」字徽章）
      coinIconUrl: { type: String, default: '' },
      // 首次进入活动一次性赠送（0 = 不送）
      welcomeCoins: { type: Number, default: 10 },

      /**
       * ===== 经济与产出策略（v3）=====
       * 任务只发固定铜版、不直接发奖；高价值奖低权重。
       * 返奖率只做后台预警（payoutWarnPercent），真正硬约束是下面两个上限。
       */
      economy: {
        // 游戏内铜版产出上限（转盘 + 九宫格共用；0 = 不限）
        dailyGameCoinCap: { type: Number, default: 200 },
        // 后台预览预警：铜版期望返还 / 单局成本 ≥ 该百分比时提示（不硬拦保存）
        payoutWarnPercent: { type: Number, default: 100 },
        // 后台预览预警：高价值奖权重占比 > 该百分比时提示
        highTierWarnPercent: { type: Number, default: 10 },
      },

      // 转盘（v3）：消耗 / 每日局数 / 保底
      wheel: {
        enabled: { type: Boolean, default: true },
        cost: { type: Number, default: 5 },
        maxPerDay: { type: Number, default: 0 }, // 0 = 不限
        pity: {
          afterLosses: { type: Number, default: 5 }, // 0 = 关闭保底
          prizeKey: { type: String, default: 'coin_2' }, // 空 = 自动挑最低档
        },
      },

      // 看视频：+铜版（不再发次数/步数）。旧 drawPerWatch 保留但不再使用。
      video: {
        enabled: { type: Boolean, default: true },
        coinPerWatch: { type: Number, default: 1 },
        drawPerWatch: { type: Number, default: 0 }, // 【已废弃】仅兼容旧配置/旧客户端展示
        dailyLimit: { type: Number, default: 10 },
        adUnitId: { type: String, default: '' },
      },

      // 分享：好友点开才给铜版（不再点一下就发次数）。旧字段保留但不再使用。
      share: {
        enabled: { type: Boolean, default: true },
        coinPerClick: { type: Number, default: 1 },
        dailyLimit: { type: Number, default: 3 }, // 分享者每天最多拿几次（0 = 不限）
        tokenExpireDays: { type: Number, default: 7 },
        drawPerShare: { type: Number, default: 0 }, // 【已废弃】
        minIntervalSec: { type: Number, default: 0 }, // 【已废弃】
      },

      // 签到：连续 7 天阶梯，断签重置；只发铜版（旧 draw/steps 保留但不再生效）
      checkin: {
        enabled: { type: Boolean, default: true },
        milestones: {
          type: [
            new mongoose.Schema(
              {
                coin: { type: Number, default: 1 },
                draw: { type: Number, default: 0 },
                steps: { type: Number, default: 0 },
              },
              { _id: false }
            ),
          ],
          default: () => [
            { coin: 1, draw: 0, steps: 0 },
            { coin: 1, draw: 0, steps: 0 },
            { coin: 1, draw: 0, steps: 0 },
            { coin: 1, draw: 0, steps: 0 },
            { coin: 1, draw: 0, steps: 0 },
            { coin: 1, draw: 0, steps: 0 },
            { coin: 1, draw: 0, steps: 0 },
          ],
        },
        loopAfter: { type: Boolean, default: true },
      },

      // 九宫格连线（v4）：老虎机式随机盘面，横/竖/斜多线分别计奖
      grid: {
        enabled: { type: Boolean, default: true },
        cost: { type: Number, default: 6 },
        maxPerDay: { type: Number, default: 0 },
        pity: {
          afterLosses: { type: Number, default: 5 },
          // 保底图案（空 = 自动挑最低单线奖的奖品图案）
          symbolKey: { type: String, default: 'star' },
          // 【已废弃】v3 的保底结果 key；迁移时映射到 symbolKey
          outcomeKey: { type: String, default: '' },
        },
        symbols: {
          type: [
            new mongoose.Schema(
              {
                key: { type: String, required: true },
                label: { type: String, default: '' },
                icon: { type: String, default: '' }, // emoji 兜底
                iconUrl: { type: String, default: '' }, // 管理员上传的图片
                type: { type: String, enum: ['coin', 'steps', 'none'], default: 'none' },
                amount: { type: Number, default: 0 }, // 每条线的奖励（不是整局总额）
                weight: { type: Number, default: 10 }, // 单格出现权重
                // 目标单局获奖概率%（管理端填概率反解权重，用户 2026-11-25）；空串=权重模式
                winTarget: { type: String, default: '' },
                tier: { type: String, enum: ['low', 'mid', 'high', 'none'], default: 'low' },
              },
              { _id: false }
            ),
          ],
          default: () => [
            { key: 'star', label: '星星', icon: '⭐', type: 'coin', amount: 5, weight: 30, tier: 'low' },
            { key: 'medal', label: '奖牌', icon: '🏅', type: 'coin', amount: 10, weight: 15, tier: 'mid' },
            { key: 'foot', label: '足迹', icon: '👣', type: 'steps', amount: 100, weight: 15, tier: 'mid' },
            { key: 'crown', label: '皇冠', icon: '👑', type: 'coin', amount: 1, weight: 10, tier: 'high' },
            { key: 'blank', label: '空白', icon: '▫', type: 'none', amount: 0, weight: 30, tier: 'none' },
          ],
        },
        // 【已废弃】v3 的「0/1/2 线结果表」：保留字段但不参与生成/发奖，后台不再展示
        outcomes: {
          type: [
            new mongoose.Schema(
              {
                key: { type: String, required: true },
                label: { type: String, default: '' },
                lines: { type: Number, default: 0 }, // 0 / 1 / 2
                symbolKey: { type: String, default: '' },
                weight: { type: Number, default: 0 },
              },
              { _id: false }
            ),
          ],
          default: () => [
            { key: 'none', label: '没有连线', lines: 0, symbolKey: '', weight: 60 },
            { key: 'line_star', label: '星星连线', lines: 1, symbolKey: 'star', weight: 22 },
            { key: 'line_medal', label: '奖牌连线', lines: 1, symbolKey: 'medal', weight: 10 },
            { key: 'line_foot', label: '足迹连线', lines: 1, symbolKey: 'foot', weight: 5 },
            { key: 'line_crown', label: '皇冠连线', lines: 1, symbolKey: 'crown', weight: 2 },
            { key: 'line_double_star', label: '星星双线', lines: 2, symbolKey: 'star', weight: 0.9 },
            { key: 'line_double_crown', label: '皇冠双线', lines: 2, symbolKey: 'crown', weight: 0.1 },
          ],
        },
      },

      // 旧段保留：dailyStepsCap 仍是步数封顶唯一依据；maxPerDay 作为 wheel.maxPerDay 的迁移来源
      draw: {
        maxPerDay: { type: Number, default: 0 },
        dailyStepsCap: { type: Number, default: 3000 },
      },

      // 转盘奖池：type 增加 coin（v3）；tier 用于后台高价值奖占比预警
      prizes: {
        type: [
          new mongoose.Schema(
            {
              key: { type: String, required: true },
              label: { type: String, default: '' },
              type: { type: String, enum: ['steps', 'coin', 'none', 'draw'], default: 'none' },
              amount: { type: Number, default: 0 },
              weight: { type: Number, default: 1 },
              tier: { type: String, enum: ['low', 'mid', 'high', 'none'], default: 'low' },
            },
            { _id: false }
          ),
        ],
        default: () => [
          { key: 'coin_2', label: '2 铜版', type: 'coin', amount: 2, weight: 30, tier: 'low' },
          { key: 'coin_5', label: '5 铜版', type: 'coin', amount: 5, weight: 14, tier: 'mid' },
          { key: 'steps_100', label: '100 步', type: 'steps', amount: 100, weight: 20, tier: 'low' },
          { key: 'steps_300', label: '300 步', type: 'steps', amount: 300, weight: 10, tier: 'mid' },
          { key: 'steps_800', label: '800 步', type: 'steps', amount: 800, weight: 4, tier: 'high' },
          { key: 'coin_20', label: '20 铜版', type: 'coin', amount: 20, weight: 2, tier: 'high' },
          { key: 'again', label: '再来一次', type: 'draw', amount: 1, weight: 6, tier: 'none' },
          { key: 'none', label: '谢谢参与', type: 'none', amount: 0, weight: 14, tier: 'none' },
        ],
      },
    },

    /**
     * 楼名白名单（用户 2026-10-21）：
     * 「为了防止教室、宿舍被学生不统一填写，请在系统设置中增加教学用楼的楼名列表与
     *   宿舍用楼的楼名列表，这样学生先选择楼名自己再去填写门牌号(纯数字)这样就统一了。」
     *
     * 为什么要白名单而不是继续自由填：同一个教室会被写成「1号教学楼201 / 一教201 / 1-201」，
     * 后面按楼栋统计、按房间查人都对不上。这里只约束**楼名**，门牌号仍由人填（纯数字校验）。
     * 两份清单分别对应教学用楼（教室）与宿舍用楼（查宿），不要合并成一份 ——
     * 教学楼不会出现在查宿名单里，混在一起会让人选错。
     */
    buildings: {
      teaching: { type: [String], default: [] }, // 教学用楼楼名，如「1号教学楼」
      dorm: { type: [String], default: [] }, // 宿舍用楼楼名，如「1号宿舍楼」
    },

  },
  { timestamps: true }
);

goalConfigSchema.statics.getSingleton = async function () {
  let doc = await this.findOne({ key: 'default' });
  if (!doc) doc = await this.create({ key: 'default' });
  return doc;
};

module.exports = mongoose.model('GoalConfig', goalConfigSchema, 'goal_config');
