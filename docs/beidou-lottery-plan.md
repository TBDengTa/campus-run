# 北斗运动 2.0 改造方案（签到 + 转盘抽步数 + 看视频得次数 + 分享得次数）

> **状态：口径已定稿（2026-11-11 用户裁决完毕），可以开工。**
> 本文件是**口径与边界的权威说明**，实施时以它为准；与 `AGENTS.md` 冲突时以 `AGENTS.md` 为准。
> 开工前必读：`AGENTS.md`（UI 令牌 / 登录闸门 / 教师拦截 / 反作弊红线）、`docs/ui-design.md` §8.1（广告位与插屏节流）。

## 0. 一句话目标

把现在「看一次广告 → 直接 +1000 步」的单点功能，改成**有签到、有转盘抽步数、看视频加抽奖次数、分享加抽奖次数的活动页**，
步数出口收敛到「转盘」，签到阶梯是唯一例外。

## 1. 已定口径（用户 2026-11-11 两轮回答，已裁决冲突）

| # | 议题 | 定稿 | 影响 |
|---|---|---|---|
| D1 | 看视频的产出 | **只给抽奖次数，不再直接发步数** | `rewardVideo.stepsPerWatch` 退化为历史字段 |
| D2 | 免费次数 | **没有免费次数**，全靠看视频 / 签到 / 分享 | 新用户进页看到「去赚次数」，不做保底 |
| D3 | 转盘奖池 | 步数（多档）+ 谢谢参与 + 再来一次 | **不发跑分 / 徽章 / 实物** |
| D4 | 分享计次 | **点分享即给次数，不要好友打开、不要绑定** | 放弃归因链路；见 §2 R2 的红旗 |
| D5 | 签到 | **连续 7 天阶梯：次数 + 步数，断签重置** | 唯一「不经过转盘就出步数」的通道 |
| D6 | 页面形态 | **改造现有「北斗运动」页** | 复用 `pages/reward/reward`，不新建主包页 |
| D7 | 签到步数 | **A 案：第 3/7 天直发步数，带封顶** | 不引入「抽奖券」二次抽 |
| D8 | 榜单口径 | **抽奖/签到步数照常计入排行榜与跑分 + 每日封顶** | 封顶从「建议」升级为**必需项** |
| D9 | 旧接口 | **`/api/reward-video/report` 保留，只回 `success:false` +「已升级」** | 老版本客户端不会静默刷步 |
| D10 | 入口 | **保持「我的 → 累计数据」连点 5 次彩蛋，不加正常菜单项** | 不加 `nav-groups` 条目，不动首页 |
| D11 | 每日抽奖次数 | **不限制**（可配，默认 0 = 不限） | 必须靠 D8 的步数封顶兜住成本 |

## 2. 三条必须写进代码注释的红线

### R1 ✅ 已化解：D7 与 D1 的冲突

D1「步数只能靠转盘」与 D5「签到给步数」原本互斥。**D7 选 A** 后定为：
**签到第 3/7 天是唯一不经过转盘的步数出口**，它同样写 `run_records.source='beidou'`、同样受 `dailyStepsCap` 约束。
代码里只允许两处写「步数」：`drawRound()` 与 `grantCheckin()`，两处都在 `services/beidou.js` 内，且都过 `capRemaining()`。

### R2 🚩 红旗：D4「点分享即给」+ D11「次数不限」是无限步数通道

这是**本方案唯一的高危项**，必须让管理员知情：

1. **微信没有分享成功回调。** `onShareAppMessage` 在**分享面板弹出时**触发，用户点「取消」也照样触发。
   2021 年后 `shareTicket` 只在**群分享**场景返回，一对一分享拿不到 `shareTicket`，`wx.getShareInfo` 也解不出东西。
   所以「按分享就给次数」在技术上**只能做到「点了分享按钮就给」**，无论他是否真的发出去。
2. **D11 不限制次数** → 连点分享 → 无限次数 → 无限抽奖。
3. **D8 计入排行榜** → 脚本用户恒占榜首。

三条同时成立时，**唯一的成本闸门是 `draw.stepsAwarded` 的每日封顶**（D8）。所以它的实现质量是本方案第一优先级：

| 护栏 | 性质 | 说明 |
|---|---|---|
| `draw.dailyStepsCap`（默认 **3000**） | **必需** | 达到后，奖池里所有 `type:'steps'` 自动降级为「谢谢参与」，响应带 `capped: true`。**不是报错**，抽奖照常进行，只是不出发步数 |
| 分享计次服务端最小间隔（默认 **5 秒**） | **必需** | 纯技术防连点（同 openid 5 秒内重复上报只记一次）。它不算「次数限制」，但不加就是一次连点刷满 |
| `share.dailyLimit`（默认 **0 = 不限**） | 可配 | 遵 D11 默认不限；管理员随时可在管理端收紧。**建议值 3**，写进页面配置说明 |
| `draw.maxPerDay`（默认 **0 = 不限**） | 可配 | 同上，遵 D11 |
| 邀请归因链路 | **不做** | D4 改为点分享即给，原设计的 `beidou_invites` 集合与 `/invite/claim` 接口**本版不实现**（见 §8） |

> **给管理员的一句话**：如果哪天发现榜单头部全是抽奖/分享刷出来的，把 `dailyStepsCap` 调低即可，
> **不要**去封学生账号（那是产品口径问题，不是作弊；反作弊系统也不该为它背锅）。

### R3 ✅ 已确认：D8 计入榜单

抽奖/签到步数照常进排行榜、跑分、徽章、日周目标。**不**给 `run_records` 加 `excludeFromRanking` 标记
（那要改排行榜 + 跑分日/周 + 班级榜四处聚合，漏一处就是「页面看得见、榜单看不见」的静默错）。
代价是榜单会反映「活动参与度」，由 R2 的封顶控制量级。

## 3. 现有实现盘点（改造前的事实，别凭印象）

| 位置 | 现状 |
|---|---|
| `pages/reward/reward.js` | 激励视频单例 + 插屏单例；看完 `isEnded===true` 才 `POST /api/reward-video/report`；上限 `rewardVideo.dailyLimit`（默认 10） |
| `pages/reward/reward.wxml` | 教师拦截整页 `wx:if="{{!blocked}}"`；四宫格「每次可获得 / 今日已入账」；规则说明三行 |
| `server/src/routes/reward-video.js` | `GET /today`、`POST /report`；教师 200+success:false；`sync` 限制 403004 |
| `server/src/services/steps.js::reportRewardVideo` | CAS 领取次数（`watchCount` 作版本号）→ `run_records` 当日一条 `source='beidou'` 累加四项 → `postSyncRefresh` |
| `server/src/services/reward-video.js` | `resolvePerWatch` / `normalizePerWatchInput` / `earnedToday` |
| `server/src/models/reward-video-record.js` | `openid+date` 唯一，`watchCount / stepsEarned / watchIds[≤50]` |
| 管理端 | `packageAdmin/config/reward-video`（走 `section.js`：`config.view` 读、`config.manage` 写） |
| 入口 | 「我的 → 累计数据」**连点 5 次**（`profile.js::onStatsTap`，教师第一道拦截）—— **D10 保持不变** |
| 全仓库 | **没有**签到、抽奖、`onShareAppMessage`、`getLaunchOptionsSync` 的任何代码 |

结论：签到 / 转盘 / 分享三条链路**全是新增**；`reportRewardVideo` 的幂等写法与教师拦截可以直接沿用。

## 4. 数据模型（2 个新集合；`beidou_invites` 因 D4 取消，不建）

### 4.1 `beidou_day`（每人每天一份状态，`openid+date` 唯一）

抽奖次数、签到、视频/分享额度、当日产出**只认这一份**，不在别处再算一遍。

```js
{
  openid: String,
  date:   String,            // YYYY-MM-DD（本地日历键，与全库一致）
  draw: {
    total:        Number,    // 今日获得的总次数（各来源之和）
    used:         Number,    // 今日已抽次数（CAS 版本号）
    fromVideo:    Number,
    fromShare:    Number,
    fromCheckin:  Number,
    fromPrize:    Number,    // 「再来一次」产生
    stepsAwarded: Number,    // 今日抽奖+签到累计发出的步数（**封顶判定唯一依据**）
    capped:       Boolean,   // 今日是否已触及步数封顶
  },
  video:   { count: Number, watchIds: [String] },   // watchIds ≤50，同现有 $slice 写法
  share:   { count: Number, lastAt: Date },         // lastAt 用于服务端最小间隔
  checkin: { done: Boolean, at: Date, streak: Number, award: { draw: Number, steps: Number } },
}
```

### 4.2 `beidou_draws`（每次抽奖一条：审计 / 概率公示核对 / 客服对账的真源）

```js
{
  openid, date, drawId,          // drawId 客户端生成
  prizeKey: String,              // 命中的奖池项 key
  type: String,                  // steps | none | draw
  amount: Number,                // steps 的步数 / draw 的次数 / none 为 0
  roll: Number,                  // 本次随机数（0~1），留证
  index: Number,                 // 命中扇区下标（前端动画用，**服务端下发**）
  capped: Boolean,               // 本次是否因封顶被降级（为 true 时 type 必为 none）
  createdAt
}
// 索引：{ openid:1, date:1 }；{ drawId:1 } unique sparse
```

> 为什么独立成表：中奖流水要能被管理端翻页、能做「中奖公告」、能被学生申诉时对账；
> 塞进日文档数组会越滚越大（次数上限一改就爆），也无法按奖池项统计。

## 5. 转盘抽奖（服务端定结果，前端只播动画）

### 5.1 奖池配置（`goal_config.beidou.prizes[]`，默认）

```js
prizes: [
  { key:'steps_100',  type:'steps', amount:100,  weight:30, label:'100 步' },
  { key:'steps_300',  type:'steps', amount:300,  weight:16, label:'300 步' },
  { key:'steps_800',  type:'steps', amount:800,  weight:6,  label:'800 步' },
  { key:'steps_1500', type:'steps', amount:1500, weight:2,  label:'1500 步' },
  { key:'again',      type:'draw',  amount:1,    weight:8,  label:'再来一次' },
  { key:'none',       type:'none',  amount:0,    weight:38, label:'谢谢参与' },
]
```

**七条硬约束**：

1. **扇区固定 8 格**（前端视觉），奖池项 ≤8；不足 8 个时服务端按权重**复制项填充**到 8 格，
   并下发 `sectors: [prizeKey…]`（长度 8）。**前端不得自己排扇区顺序**，否则停位与真实结果对不上。
2. **结果只由服务端定**：下发的 `index` 是最终停住的扇区下标；前端圈数只影响观感。
3. **权重归一**：`normalizePrizes()` 剔除 `weight ≤ 0`、总和归一到 1；非法/空奖池**回退默认奖池**
   （不能因为管理员填了 0 就全员抽不中）。
4. **概率公示**：`GET /api/beidou/config` 下发每项**折算百分比**（两位小数），页面「规则说明」必须列出。
   公示值由服务端算、前端只展示 —— 管理端改权重后公示自动同步。
5. **并发安全**：CAS 用 `beidou_day.draw.used` 作版本号（与 `reportRewardVideo` 现有写法同套）。
   CAS 失败 → `success:false「操作过于频繁」`，**不重试、不补发**。
6. **幂等**：`drawId` 唯一索引，重复提交返回**上一次结果**（含 index），不再消耗次数、不再发步数。
   弱网下每天都在发生，漏了就是「点一次抽两次」。
7. **封顶降级（R2 的生命线）**：`draw.stepsAwarded >= dailyStepsCap` 时，
   抽出的步数奖**当场降级为「谢谢参与」**并记 `capped: true`；「再来一次」不受影响（它不产生步数）。

### 5.2 一次抽奖的服务端流程（顺序不能换）

```
① 教师拦截 → 200 + success:false（沿用现有口径；不能用 403003，客户端会当未登录跳登录页）
② 封禁 / sync 限制 → 403001 / 403004（复用 routes/reward-video.js::restrictedError）
③ 读 goal_config.beidou → enabled
④ drawId 幂等命中 → 返回上次结果（含 index）
⑤ CAS 占用一次 draw.used（draw.maxPerDay>0 且用尽 → success:false「次数不足」）
⑥ crypto.randomInt 生成 roll → 按权重求 index / prize
⑦ 封顶判定：steps 且余额不足 → 降级 none + capped:true
⑧ 写 beidou_draws 一条 + beidou_day 累加（stepsAwarded / fromPrize / capped）
⑨ type==='steps' → run_records 当日 source='beidou' 累加四项（沿用 wechat.estimateFromSteps）
⑩ type==='draw'  → draw.total += 1（「再来一次」；计入 used 但不再消耗次数）
⑪ postSyncRefresh（目标达成 / 徽章）+ earnedToday 重新聚合
⑫ 返回 { success, index, prize, capped, remaining, earned, newBadges }
```

**⑧⑨ 必须同进同退**：先写流水，再写 `run_records`；任何一步失败都不能出现「步数发了但流水没记」。
仓库现有代码没用 Mongo 事务，本方案也**不引入事务**，改为：
- `beidou_draws` 的 `drawId` 唯一索引保证「不会重复入账」；
- 新增 `tools/verify-beidou-lottery.js` 第 ⑦ 节做**流水与 run_records 对账**（按日聚合比对步数差），
  发现不一致时打印待修复清单（可重放补写，靠 `drawId` 幂等，不会双发）。

## 6. 签到（7 天阶梯，断签重置）

- 判定键 `beidou_day.checkin.done`；`openid+date` 唯一索引天然防重复签到。
- **连续天数**：`streak = 昨天有签到 ? 昨天.streak + 1 : 1`。
  **不能**用「累计签到天数」，否则断签也发第 7 天大奖。
- 阶梯（`goal_config.beidou.checkin.milestones`，默认）：

  | 连续第 N 天 | 抽奖次数 | 步数 |
  |---|---|---|
  | 1~2 | +1 | 0 |
  | 3 | +2 | +200 |
  | 4~6 | +1 | 0 |
  | 7 | +3 | +500 |

  第 7 天之后**重置回第 1 天**；要「8 天起按第 7 天循环」改 `loopAfter`。
- 签到步数同样过 `capRemaining()`（与抽奖共用一个封顶池，**不另开额度**）。
- 签到不消耗次数、不需要广告，是 D2「没有免费次数」下唯一不花钱的入口。

## 7. 看视频得次数（沿用现有单例，只改产出）

- 复用 `pages/reward/reward.js` 现有模块级单例（`ensureVideoAd` / `waitForClose` / 插屏节流），**不新建实例**。
- 只改语义：`isEnded === true` → `POST /api/beidou/video/report { watchId }`，
  服务端 `draw.total += video.drawPerWatch`（默认 1），**不写 run_records**。
- `watchId` 幂等保留（现有 `watchIds` + `$slice:-50` 写法）。
- **旧接口 `POST /api/reward-video/report`（D9）**：路由保留，直接返回
  `ok(res, { success:false, message:'北斗运动已升级，请更新小程序后重新进入' })`；
  **删除其对 `run_records` 的写入**（`steps.js::reportRewardVideo` 保留导出但标注 deprecated，仅供 verify 工具调用）。
  这样老版本客户端（缓存未更新）不会再直发步数。
- 插屏时机不变（进页面首屏加载后 1 次，会话最多 3 次）。

## 8. 分享得次数（D4 定稿：点分享即给）

**本版不实现邀请归因**（原 `beidou_invites` + `/invite/claim` 取消）。实现只有一条链路：

```js
// pages/reward/reward.js —— 页面上「分享给同学」按钮
onShareTap() {
  // ① 先在本机防连点（服务端还有 5 秒最小间隔）
  // ② 调 POST /api/beidou/share/report { shareId }，服务端加次并返回最新剩余
  // ③ 再触发分享（open-type="share" 按钮由 onShareAppMessage 返回卡片）
}
onShareAppMessage() {
  return { title: '一起用北斗运动攒步数', path: '/pages/splash/splash' };
}
```

四条护栏：
1. **服务端最小间隔**（`share.minIntervalSec`，默认 5）：同 openid 间隔不足只记一次，返回 `duplicated:true`。
   这是纯技术防连点，不是次数上限；
2. `share.dailyLimit`（默认 **0 = 不限**，遵 D11）：管理员可随时收紧，**建议 3**；
3. **分享不计入教师账号**（`isTeacher` → `success:false`，与看视频同一口径）；
4. **卡片路径不带任何标识**：不拼 `ref`（没有归因需求了），避免把内部标识传播出去。

> 文案红线：页面写「**邀请同学一起跑**」，不写「分享得次数」。这是同一件事的两种说法，
> 后者是平台规则里的典型诱导分享表述，前者风险低得多（改动只在文案层，随时可调）。

## 9. 前端页面结构（改写 `pages/reward/reward`，不新建页面）

保留：教师三道拦截、`blocked` 整页 `wx:if`、插屏节流、登录闸门、`--tt-*` 白橙令牌、四宫格「今日已入账」。

新增（从上到下）：

| 区块 | 内容 | 关键点 |
|---|---|---|
| Hero | 「北斗运动」+ 今日剩余次数（`draw.maxPerDay=0` 时显示「不限」） | `.num-font`；不再写「每次 +N 步」 |
| 转盘 | **8 扇区 CSS 转盘** | 见 §9.1 |
| 抽奖按钮 | 剩余次数 / 次数不足置灰 +「去赚次数」 | 抽奖中禁用防连点 |
| 签到条 | 7 天格子（已签 ✓ / 今天 / 未来） | 断签重置后格子归零，文案说清 |
| 任务列表 | 看视频 +1 次（x/y）、邀请同学 +1 次（x/y） | 各自显示今日已得；上限 0 显示「不限」 |
| 中奖记录 | 最近 5 条（时间 + 奖品） | 服务端下发，前端不自己攒 |
| 规则说明 | 概率公示 + 签到规则 + 封顶说明 + 反作弊 | **封顶说明必须有**：「今日步数奖励已达上限」要在用户抽到空奖前就能看到 |

### 9.1 转盘实现要点（这块最容易做错）

- **不用 canvas**：8 个扇区用 `<view>` + `conic-gradient` 或预切 8 张图定位旋转；
  但**扇区顺序必须来自服务端 `sectors`**，前端只负责「把第 index 个扇区转到指针下」。
- 旋转角度：`targetDeg = 360 * 5 + (360 - index * 45) - 22.5`。
  停位误差 >11° 就「停在 A 却发 B」，回归工具要断言**整格校验**。
- **动画结束（`transitionend`）后才允许下一次抽奖**；不要用 `setTimeout`（低端机 transition 更慢，会错位）。
- 结果展示用**服务端下发的 prize**，不用「停住位置对应的前端数组项」。

## 10. 管理端（扩 `packageAdmin/config/reward-video` 为三段）

1. **基础**：`enabled`、`draw.maxPerDay`（默认 0=不限）、`draw.dailyStepsCap`（默认 3000）、广告位 ID（沿用）。
2. **奖池**：可增删改列表（key/label/type/amount/weight），实时显示**归一后概率**；
   校验：权重和 >0、步数 ≤ 上限、扇区数 ≤8、`type` 白名单。奖池每次实时读配置，保存即生效。
3. **签到 / 分享**：7 天阶梯（次数/步数）、`share.dailyLimit`（默认 0）、`share.minIntervalSec`（默认 5）。
4. **中奖记录**：分页列表（时间 / 学生 / 奖品 / 类型 / 是否封顶），按奖品筛选；**只读**。
   不允许后台补发或撤销抽奖结果 —— 改流水会让概率公示失真；要补发走「人工发徽章」那套。

权限：沿用 `config.view` / `config.manage`，**不新增权限项**（新增会让现网只有 `config.view` 的管理员突然看不到入口）。

## 11. 反作弊 / 上限 / 迁移

- **教师**：签到 / 抽奖 / 视频 / 分享四处都要 `stepsSvc.isTeacher` 拦截（与现有两道一致），返回 `200 + success:false`。
- **封禁 / sync 限制**：抽奖与签到在**发放步数前**必须过 `anticheat.activeRestriction(user,'sync')`。
- **每日步数封顶（R2 生命线）**：`draw.stepsAwarded` 累计，超 `dailyStepsCap` 时步数奖降级为空奖并记 `capped:true`。
- **单日物理上限**：`anticheat.MAX_REASONABLE_DAILY_STEPS = 50000` 仍是硬红线。
  注意：抽奖写入 `beidou` 记录**不经过** `checkStepJump` / `recordStepAnomaly`（它们只在 werun 同步路径触发），
  所以不会自动封号 —— 这正是能用 R2 的封顶而非封号来控量的原因。
- **迁移**：`rewardVideo.stepsPerWatch` 等四项**字段保留不动**（存量记录、历史 `earnedToday` 统计还要用）；
  新增 `goal_config.beidou` 顶层配置段，`GET /api/admin/config` 增加 `out.beidouEffective`（归一后奖池 + 公示概率 + 生效封顶）。
- **回滚**：`beidou.enabled=false` → 活动页回到「只读展示 + 全部按钮置灰」；旧 `/api/reward-video/*` 仍可用（D9）。

## 12. 验收工具（按仓库约定新增）

| 工具 | 类型 | 盯什么 |
|---|---|---|
| `tools/check-beidou-lottery.js` | 静态 | 奖池权重归一与默认回退、扇区数=8、概率公示由服务端算、CAS+drawId 幂等、教师四处拦截、**封顶降级**、转盘角度整格校验 |
| `tools/check-page-data-keys.js` | 既有 | 新 WXML 引用的字段 JS 必须产出（`sectors` / `currentIndex` 最易漏） |
| `tools/check-write-guard.js` | 既有 | 管理端奖池编辑按钮必须有 `canManage` 守卫 |
| `tools/verify-beidou-lottery.js` | 端到端（真连库） | ①签到断签重置 ②同 drawId 只入账一次 ③次数用尽拒绝 ④**封顶后步数奖降级为空奖** ⑤教师四处拦截 ⑥分享最小间隔去重 ⑦抽奖流水与 run_records 步数对账 ⑧清理核对 |

## 13. 实施顺序

| 阶段 | 内容 | 依赖 |
|---|---|---|
| S1 | `goal_config.beidou` schema + `normalizeBeidouInput` + 管理端配置页三段 | 无 |
| S2 | `beidou_day` / `beidou_draws` 模型 + 索引 | S1 |
| S3 | `services/beidou.js`（发次 / 抽奖 / 签到 / 视频 / 分享 / 封顶 / 幂等）——**唯一实现，路由只取参** | S2 |
| S4 | `routes/beidou.js`（config / today / draw / checkin / video / share）+ 挂载 `/api/beidou`；`/api/reward-video/report` 改为只回 success:false | S3 |
| S5 | 前端转盘页改写（WXML/WXSS/JS）+ 签到条 + 任务列表 + `onShareAppMessage` | S4（可 mock 并行） |
| S6 | 回归工具 + `docs/api.md` / `docs/database-v2.md` / `docs/ui-design.md` §8.1 同步 | 全部 |

## 14. 上线前必须确认的两件事

1. **`dailyStepsCap` 的初值**。默认取 3000（约等于「每天最多再多走 3 公里」的量级）。
   在 D11「次数不限」+ D4「点分享即给」的前提下，**这是唯一挡在刷步前面的东西**。
   建议上线首周每天看一眼排行榜头部步数，异常就把这个值往下调。
2. **`share.dailyLimit` 要不要从 0 改成 3**。你把 D11 定成不限制，我按 0=不限实现了；
   但分享是这个系统里**成本最低的产出途径**（一次点击 = 一次抽奖），只要排行榜开始难看，
   第一个该动的就是它 —— 它已经做成配置项，改一个数字即可，不用发版。
