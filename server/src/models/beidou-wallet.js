const mongoose = require('mongoose');

/**
 * 北斗运动 3.0 铜版钱包（每个 openid 一份）。
 *
 * 为什么必须独立成文档、而不是把余额塞进 `beidou_day`：
 *   ① 铜版是**跨天钱包**，`beidou_day` 是每人每天一份（0 点换文档），余额放进去第二天就归零；
 *   ② 扣款要 CAS（`balance` 做版本号），钱包是唯一能保证「并发下只扣一次」的文档；
 *   ③ 保底计数（连续未中局数）也必须跨天保留，和余额同一份文档最省一次查询。
 *
 * 余额只允许经 services/beidou-wallet.js 增减（任何路由/脚本不得直接 $inc balance）。
 * 方案见 docs/beidou-economy-plan.md。
 */
const beidouWalletSchema = new mongoose.Schema(
  {
    openid: { type: String, required: true, unique: true },
    // 当前铜版余额（整数，永不为负）
    balance: { type: Number, default: 0 },
    // 累计获得 / 累计消耗（对账用；不等同于余额）
    totalEarned: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 },
    // 其中：任务来源（看视频/签到/分享）与游戏来源（转盘/九宫格铜版奖）
    taskEarned: { type: Number, default: 0 },
    gameEarned: { type: Number, default: 0 },
    // 「再来一次」按本局成本返还的钱，单独记，不算游戏产出
    refunded: { type: Number, default: 0 },
    // 新手赠送是否已发（只发一次）
    welcomeGranted: { type: Boolean, default: false },

    /**
     * 保底状态（两个玩法各自独立；跨天保留）。
     *
     * `losses` = 连续未中局数（最终结果为 none 才 +1，封顶降级也算未中）。
     * 达到配置的 afterLosses 后下一局强制低档奖；中奖后清零。
     */
    luck: {
      wheelLosses: { type: Number, default: 0 },
      gridLosses: { type: Number, default: 0 },
      // 累计触发保底次数（后台统计用）
      wheelPityCount: { type: Number, default: 0 },
      gridPityCount: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BeidouWallet', beidouWalletSchema, 'beidou_wallet');
