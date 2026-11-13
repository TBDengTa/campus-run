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
    drawId: { type: String, required: true },
    prizeKey: { type: String, default: '' },
    type: { type: String, enum: ['steps', 'none', 'draw'], default: 'none' },
    amount: { type: Number, default: 0 }, // steps = 步数；draw = 次数；none = 0
    roll: { type: Number, default: 0 }, // 本次随机数（0~1），留证
    index: { type: Number, default: 0 }, // 命中扇区下标（前端动画用，服务端下发）
    capped: { type: Boolean, default: false }, // 本次是否因封顶被降级（true 时 type 必为 none）

    /**
     * 本次抽奖**消耗的那一次机会来自哪里**（用户 2026-11-12「抽奖来源筛选(签到、分享、视频)」）。
     *
     * ⚠️ 这个字段不是「用户从哪里点进来的」，而是**账本归属**：
     *    次数是一个合并池（draw.total），抽奖时按固定优先级从各来源的余额里扣一笔，
     *    扣到谁就记谁。详见 services/beidou.js::pickSource 的注释。
     *
     * 取值：video / share / checkin / prize（再来一次）/ unknown（老数据或余额异常）
     */
    source: {
      type: String,
      enum: ['video', 'share', 'checkin', 'prize', 'unknown'],
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
// 管理端按来源筛选 + 日期范围（两个维度常一起用，复合索引避免全表扫）
beidouDrawSchema.index({ source: 1, date: -1 });

module.exports = mongoose.model('BeidouDraw', beidouDrawSchema, 'beidou_draws');
