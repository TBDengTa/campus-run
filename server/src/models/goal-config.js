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
      enabled: { type: Boolean, default: true },
      // 音效总开关（用户 2026-11-12「增加点音效」）：关掉后用户端连 WAV 都不合成。
      // 音效是运行时**代码合成**的（主包已超限，不放 mp3），见 utils/sfx.js。
      sfxEnabled: { type: Boolean, default: true },
      // 看视频：看完给几次抽奖机会（**不再发步数**）
      video: {
        drawPerWatch: { type: Number, default: 1 },
        dailyLimit: { type: Number, default: 10 }, // 每日可看次数上限
        adUnitId: { type: String, default: '' }, // 空 = 用客户端内置默认广告位
      },
      // 分享：点分享即给次数（微信没有分享成功回调，见方案 §2 R2）
      share: {
        drawPerShare: { type: Number, default: 1 },
        dailyLimit: { type: Number, default: 0 }, // 0 = 不限（遵 D11）
        minIntervalSec: { type: Number, default: 5 }, // 服务端最小间隔，纯技术防连点
      },
      // 签到：连续 7 天阶梯，断签重置
      checkin: {
        enabled: { type: Boolean, default: true },
        // 数组下标 0 = 连续第 1 天；长度即周期长度
        milestones: {
          type: [
            new mongoose.Schema(
              {
                draw: { type: Number, default: 1 },
                steps: { type: Number, default: 0 },
              },
              { _id: false }
            ),
          ],
          default: () => [
            { draw: 1, steps: 0 },
            { draw: 1, steps: 0 },
            { draw: 2, steps: 200 },
            { draw: 1, steps: 0 },
            { draw: 1, steps: 0 },
            { draw: 1, steps: 0 },
            { draw: 3, steps: 500 },
          ],
        },
        // 超过周期后：true = 回到第 1 天重来；false = 一直按周期最后一天发
        loopAfter: { type: Boolean, default: true },
      },
      draw: {
        maxPerDay: { type: Number, default: 0 }, // 0 = 不限（遵 D11）
        dailyStepsCap: { type: Number, default: 3000 }, // 每日抽奖/签到累计发步数上限（必需）
      },
      // 奖池：type 只有 steps / none / draw 三种（用户 2026-11-11 确认，不发跑分/徽章/实物）
      prizes: {
        type: [
          new mongoose.Schema(
            {
              key: { type: String, required: true },
              label: { type: String, default: '' },
              type: { type: String, enum: ['steps', 'none', 'draw'], default: 'none' },
              amount: { type: Number, default: 0 }, // steps = 步数；draw = 次数；none = 0
              weight: { type: Number, default: 1 },
            },
            { _id: false }
          ),
        ],
        default: () => [
          { key: 'steps_100', label: '100 步', type: 'steps', amount: 100, weight: 30 },
          { key: 'steps_300', label: '300 步', type: 'steps', amount: 300, weight: 16 },
          { key: 'steps_800', label: '800 步', type: 'steps', amount: 800, weight: 6 },
          { key: 'steps_1500', label: '1500 步', type: 'steps', amount: 1500, weight: 2 },
          { key: 'again', label: '再来一次', type: 'draw', amount: 1, weight: 8 },
          { key: 'none', label: '谢谢参与', type: 'none', amount: 0, weight: 38 },
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
