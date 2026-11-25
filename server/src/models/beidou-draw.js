const mongoose = require('mongoose');

/**
 * 北斗运动抽奖流水（每次抽奖一条）。
 *
 * 为什么独立成表、而不是塞进 beidou_day 的数组：
 *   ① 中奖流水要能被管理端翻页查询、按奖品筛选、做中奖公告；
 *   ② 塞进日文档数组会随次数增长越来越胖（次数上限一改就爆），且无法按奖池项做统计；
 *   ③ 学生申诉对账时的唯一凭据就是这张表（含 roll 随机数留证）。
 *
 * `drawId` 由客户端生成并建唯一索引：弱网重试/连点重复提交时，第二次会撞唯一键，
 * 服务端据此返回**上一次的结果**（含 index），不再消耗次数、不再发步数。
 * 这一条漏了就是「点一次抽两次」，而它在弱网下每天都在发生。
 *
 * 管理端**只读**（不允许补发/撤销）：改流水会让概率公示失真。
 */
const beidouDrawSchema = new mongoose.Schema(
  {
    openid: { type: String, required: true },
    date: { type: String, required: true },
    // 幂等键：转盘的 drawId / 九宫格的 playId 都写这里（唯一索引按人隔离）
    drawId: { type: String, required: true },
    // 玩法：v3 起同一张流水表同时记转盘与九宫格；旧记录缺字段按 wheel 处理
    game: { type: String, enum: ['wheel', 'grid'], default: 'wheel' },
    prizeKey: { type: String, default: '' },
    type: { type: String, enum: ['steps', 'coin', 'none', 'draw', 'mixed'], default: 'none' },
    amount: { type: Number, default: 0 }, // steps=步数；coin=铜版；draw=返还；mixed=主奖励合计；none=0
    // v4 九宫格：同一局可同时有铜版和步数，分别记合计
    coinAmount: { type: Number, default: 0 },
    stepsAmount: { type: Number, default: 0 },
    roll: { type: Number, default: 0 }, // 本次随机数（0~1），留证
    index: { type: Number, default: 0 }, // 转盘扇区下标（九宫格恒 0）
    capped: { type: Boolean, default: false }, // 是否因步数封顶被降级
    coinCapped: { type: Boolean, default: false }, // 是否因游戏铜版上限被降级/部分扣减
    pity: { type: Boolean, default: false }, // 本次是否由保底强制中奖

    // 本局成本（铜版），对账用；旧记录为 0
    cost: { type: Number, default: 0 },
    // 结果快照：管理员改奖池后历史记录仍能显示当时的奖品名/概率/档位/稀有度
    prizeLabel: { type: String, default: '' },
    prizePercent: { type: Number, default: 0 },
    tier: { type: String, enum: ['low', 'mid', 'high', 'none'], default: 'none' },
    rarity: { type: String, enum: ['none', 'normal', 'rare', 'rarest'], default: 'none' },

    // 九宫格：9 个符号 key + 中奖线（cells 是 0~8 的下标）
    board: { type: [String], default: [] },
    // v4：按图案分组的整局奖励（老虎机多线）
    rewards: {
      type: [
        new mongoose.Schema(
          {
            symbolKey: { type: String, default: '' },
            label: { type: String, default: '' },
            type: { type: String, enum: ['coin', 'steps', 'none'], default: 'none' },
            lines: { type: Number, default: 0 },
            singleAmount: { type: Number, default: 0 },
            amount: { type: Number, default: 0 },
            tier: { type: String, enum: ['low', 'mid', 'high', 'none'], default: 'none' },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    lines: {
      type: [
        new mongoose.Schema(
          {
            key: { type: String, default: '' },
            label: { type: String, default: '' },
            symbolKey: { type: String, default: '' },
            symbolLabel: { type: String, default: '' },
            type: { type: String, enum: ['coin', 'steps', 'none'], default: 'none' },
            amount: { type: Number, default: 0 },
            cells: { type: [Number], default: [] },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    /**
     * 可恢复的结算状态（不引入 Mongo 事务）：
     *   pending → 已建流水、尚未扣款
     *   debited → 已扣款、尚未发奖
     *   settled → 已结算（正常终态）
     *   failed  → 扣款失败（余额不足等；不再重试同一 playId）
     * 同一 playId 重放时按状态续跑，钱只扣一次。
     */
    status: {
      type: String,
      enum: ['pending', 'debited', 'settled', 'failed'],
      default: 'settled', // 旧记录没有状态，视为已结算
    },
    failReason: { type: String, default: '' },
    // 步数是否已写入 run_records（崩溃恢复时避免重复 $inc）
    stepsSettled: { type: Boolean, default: false },
    balanceAfter: { type: Number, default: 0 },

    /**
     * 本次抽奖**消耗的那一次机会来自哪里**（用户 2026-11-12「抽奖来源筛选(签到、分享、视频)」）。
     *
     * ⚠️ 这个字段不是「用户从哪里点进来的」，而是**账本归属**：
     *    次数是一个合并池（draw.total），抽奖时按固定优先级从各来源的余额里扣一笔，
     *    扣到谁就记谁。详见 services/beidou.js::pickSource 的注释。
     *
     * v3 起铜版是合并钱包，无法归属到某一来源，新记录统一记 wallet；
     * 旧记录的 video/share/checkin/prize/unknown 保留作历史统计。
     */
    source: {
      type: String,
      enum: ['video', 'share', 'checkin', 'prize', 'wallet', 'unknown'],
      default: 'unknown',
    },
  },
  { timestamps: true }
);

beidouDrawSchema.index({ openid: 1, date: 1 });
// ⚠️ 幂等凭据的唯一性必须**按人隔离**（openid + drawId），不能全局唯一：
//    客户端的 drawId 是「时间戳36进制-随机8位」，理论上会撞（同一毫秒两台手机各掷出同一随机串）。
//    全局唯一时后来者会撞上别人的记录 → 被判成「重复提交」→ 拿到**别人的奖品与 index**，
//    自己既不扣次数也不发步数，而接口还返回 success:true，日志里完全看不出来。
//    幂等本来就是「同一个人同一笔」的语义，跨用户去重没有任何业务含义。
beidouDrawSchema.index({ openid: 1, drawId: 1 }, { unique: true });
// 管理端「中奖记录」按奖品筛选 + 倒序翻页
beidouDrawSchema.index({ date: -1, prizeKey: 1 });
// 管理端按玩法筛选 + 日期范围（转盘/九宫格）
beidouDrawSchema.index({ game: 1, date: -1 });
// 管理端按来源筛选 + 日期范围（两个维度常一起用，复合索引避免全表扫）
beidouDrawSchema.index({ source: 1, date: -1 });

module.exports = mongoose.model('BeidouDraw', beidouDrawSchema, 'beidou_draws');
