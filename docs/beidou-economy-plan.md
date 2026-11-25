# 北斗运动 3.0：铜版经济 + 九宫格连线 + 好友点击归因

> **状态：口径定稿（用户 2026-11-22）。本文件是 v3 的权威说明。**
> 旧 `docs/beidou-lottery-plan.md`（v2：做任务换抽奖次数）中与本文冲突的 D4/D11/§7/§8 **已废弃**，以本文为准。
> 改代码前同时读 `AGENTS.md`「北斗运动」与 `docs/ui-design.md`。

## 0. 一句话目标

把「任务换次数 → 转盘发步数」升级为**统一铜版经济**：任务只发铜版；分享必须好友点开才发；新增九宫格连线；两个玩法都消耗/产出铜版；都有保底与产出上限；旧后端 API 全部保留。

## 1. 定稿口径

| # | 议题 | 定稿 |
|---|---|---|
| D1 | 货币 | 内部 `coin`，展示名 `coinName` 默认「铜版」；虚拟积分，不可提现 |
| D2 | 看视频 | +1 铜版，每日上限 10；不发次数/步数 |
| D3 | 签到 | 每天 +1 铜版；保留 7 天连续/断签重置；不发次数/步数 |
| D4 | 分享 | 页面预生成令牌，卡片路径带 `bdshare`；**另一个已登录用户点开**后分享者 +1 铜版；自己/重复/超限不发 |
| D5 | 分享上限 | 同一好友每天 1 次；分享者每天 3 次；令牌 7 天 |
| D6 | 转盘 | 每次 5 铜版；8 扇区；奖池 `steps/coin/draw/none` |
| D7 | 九宫格 | 每次 6 铜版；3×3；横/竖/斜共 8 条线；**老虎机式随机盘面**；每条线按该图案单线奖发一次；可同时中多条线；空白成线不兑奖 |
| D8 | 保底 | 两个玩法各自独立：连续 5 局未中后下一局必中低档奖；中奖清零；跨天保留 |
| D9 | 收益策略 | 任务只发固定铜版、不直接发奖；高价值奖低权重；每日游戏铜版上限 200；步数上限 3000；后台显示返奖率/高价值占比预警 |
| D10 | 新手铜版 | 首次进入一次性赠送 10 |
| D11 | 旧 API | `/today`、`/draw`、`/video/report`、`/checkin`、`/share/report`、`/winners`、`/api/reward-video/*` 全部保留；旧字段继续下发 |
| D12 | 入口 | 不变：我的 → 累计数据连点 5 次；不加页面/tab/二进制资源 |

## 2. 数据模型

### 2.1 配置 `goal_config.beidou`（旧字段保留）

- `version: 3`（启动期 `migrateBeidouConfig` 幂等回填）
- `coinName / welcomeCoins`
- `economy: { dailyGameCoinCap, payoutWarnPercent, highTierWarnPercent }`
- `wheel: { enabled, cost, maxPerDay, pity:{afterLosses,prizeKey} }`
- `coinIconUrl`（管理员上传的铜版图标）
- `grid: { enabled, cost, maxPerDay, pity:{afterLosses,symbolKey}, symbols:[{key,label,icon,iconUrl,type,amount,weight,tier}] }`
  - `amount` 是**每条线**的奖励；`weight` 是单格出现权重；
  - 旧 `outcomes[]` 保留但不再参与生成/发奖（后台不再展示）。
- `video: { enabled, coinPerWatch, dailyLimit, adUnitId }`（旧 `drawPerWatch` 保留但为 0）
- `share: { enabled, coinPerClick, dailyLimit, tokenExpireDays }`（旧 `drawPerShare/minIntervalSec` 保留但为 0）
- `checkin: { enabled, loopAfter, milestones:[{coin}] }`（旧 `draw/steps` 保留但归零）
- `draw: { maxPerDay, dailyStepsCap }`（旧段；步数封顶唯一依据）
- `prizes[]`：`type` 增加 `coin`，新增 `tier`

### 2.2 新集合

| 集合 | 说明 |
|---|---|
| `beidou_wallet` | 每个 openid 一份：`balance/totalEarned/totalSpent/taskEarned/gameEarned/refunded/luck.{wheel,grid}Losses` |
| `beidou_coin_logs` | 铜版流水：`delta/balanceAfter/source/game/refId/idemKey`；`(openid,idemKey)` 唯一 |
| `beidou_share_links` | 分享令牌：`token` 唯一、`ownerOpenid+date` 唯一、`expiresAt` |
| `beidou_share_clicks` | 好友点击：`(ownerOpenid,visitorOpenid,date)` 唯一 |

### 2.3 旧集合扩展

- `beidou_day`：增加 `coin.*`、`wheel.plays`、`grid.plays`、`video.coin`、`share.clicks/rewarded/coin`、`checkin.award.coin`；旧字段保留。
- `beidou_draws`：增加 `game/cost/prizeLabel/prizePercent/tier/rarity/board/lines/rewards/coinAmount/stepsAmount/pity/status/stepsSettled/balanceAfter`；`type` 增加 `coin/mixed`，`source` 增加 `wallet`；`(openid,drawId)` 唯一不变。

## 3. API

### 用户端

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/beidou/today` | 余额/转盘/九宫格/任务/签到/封顶/最近记录；旧 `draw.*` 字段保留 |
| POST | `/api/beidou/draw` | 转盘，扣铜版；`{drawId}` 幂等 |
| POST | `/api/beidou/grid/play` | 九宫格，扣铜版；`{playId}` 幂等 |
| POST | `/api/beidou/video/report` | 看视频 +铜版；`{watchId}` 幂等 |
| POST | `/api/beidou/checkin` | 签到 +铜版 |
| POST | `/api/beidou/share/intent` | 预生成/复用分享令牌 |
| POST | `/api/beidou/share/click` | 好友点开上报；成功才给分享者发铜版 |
| POST | `/api/beidou/share/report` | 旧接口保留，只回 `success:false + deprecated` |
| GET | `/api/beidou/winners` | 播报（脱敏/稀有度/游戏标签） |

### 管理端（`config.view` 读、`config.manage` 写）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | `/api/admin/config` | `beidou` 可编辑配置 + `beidouEffective` |
| POST | `/api/admin/config/beidou-preview` | 与保存同一份归一/EV 逻辑的预览 + 警告 |
| GET | `/api/admin/config/beidou-draws` | 游戏流水；`dateFrom/dateTo/game/source/prizeKey/type` |
| GET | `/api/admin/config/beidou-coin-logs` | 铜版流水；日期/来源/游戏/方向 |
| GET | `/api/admin/config/beidou-economy` | 流通/发放/回收/按玩法返奖率 |

## 4. 核心算法

### 4.1 钱包与幂等

- 余额只经 `services/beidou-wallet.js` 增减；任何路由/页面/脚本不得直接改 `balance`。
- 发币：先写幂等流水（`openid+idemKey` 唯一）→ `$inc` 钱包 → 回写 `balanceAfter`；失败删流水。
- 扣币：钱包 CAS（`balance >= cost`）→ 写负流水；失败退款。
- 游戏扣款把**保底进度**和余额放在同一次 CAS，避免并发写乱。
- 不引入 Mongo 事务；`beidou_draws.status`（pending/debited/settled/failed）支持同一 `playId` 续跑；verify 脚本对账。

### 4.2 转盘

- 默认成本 5；奖池权重归一；`crypto.randomInt` 定结果；8 扇区由服务端下发。
- `coin` 奖受 `dailyGameCoinCap`：不足按剩余额度部分发放，0 时降级 `none`。
- `steps` 奖受 `dailyStepsCap`：超限整体降级 `none`。
- `draw`：按本局成本返还铜版（流水 `refund`），不占游戏产出额度。

### 4.3 九宫格

- 默认成本 6；**老虎机式随机盘面**：9 格按每个图案的 `weight` 独立抽取。
- 8 条线（3 行 + 3 列 + 2 对角线）；每条 3 个相同**奖品图案**的线发一次该图案 `amount`。
- 一局可以同时中多条线（最多 8 条），同图案按 `amount × 线数`，不同图案分别累计；允许同一局同时发铜版和步数。
- 例：皇冠单线奖 1 铜版 → 1 线 = 1，2 线 = 2；1 线皇冠 + 2 线星星 = 皇冠 1 + 星星 2×单线奖。
- 保底：连续未中达到次数后，随机选一条线强制为保底图案，其余 6 格仍随机；额外线照常发奖。
- 默认图案：星星/奖牌/足迹/皇冠/空白；权重见 `beidou-config.js::DEFAULT_GRID_SYMBOLS`；皇冠单线默认 1 铜版。
- 概率：单格出现率 `p_i = weight_i/Σweight`；期望线数 `8 × p_i³`；EV 由 `gridEv()` 统一计算。
- 前端只做卷轴展示/按 `lines.cells` 高亮（老虎机式 3 列滚动、逐列停轴，停位严格 = 服务端 board，
  装饰帧纯视觉不参与判奖，见 `beidou-lottery-ui-plan.md` §13）；图标从 `iconUrl` 显示，缺失回退 emoji。

### 4.4 保底

- 最终结果 `none` 才累计未中；达到 `afterLosses` 后下一局强制配置的低档奖/1 线。
- 中奖（含 `draw` 返还、coin 部分发放）后清零；`afterLosses=0` 关闭。
- 保底局正常扣费、正常受每日上限约束。

### 4.5 收益预警

- 后台计算 `coinReturn / cost`、`stepReturn`、`highTierPercent`。
- 预警（不硬拦保存）：返奖率 ≥ 预警线、高价值占比超线、无铜版奖、成本 0、无保底、每日上限 0、分享上限 0。
- 硬约束：每日游戏铜版上限、每日步数上限、任务/分享次数、余额非负。

### 4.6 分享归因

1. `/today`/`/share/intent` 生成令牌，卡片路径 `/pages/splash/splash?bdshare=<token>`。
2. 接收方 app/splash 捕获令牌存本地；登录后 home/app `flush` → `/share/click`。
3. 服务端校验：令牌有效、非本人、分享者/点击者正常学生、同一好友每天一次、分享者每日上限。
4. 成功给分享者 +`coinPerClick`；点击者不获得铜版、不暴露分享者身份。

## 5. 前端

- 用户页：播报 → 铜版余额卡 → 转盘/九宫格切换 → 转盘（成本/保底/扇区）或九宫格（3×3 卷轴/连线/成本/保底）→ 签到 → 任务（看视频/邀请）→ 今日入账 → 最近记录 → 规则（双玩法概率/上限/保底/分享/虚拟积分声明）→ 中奖弹层。
- 结果/board/lines/percent/rarity/pity 文案全部服务端下发；前端不随机、不连线、不排扇区。
- 分享按钮只把预取 `share.path` 交给 `onShareAppMessage`；`utils/beidou-share.js` 负责 capture/flush。
- 后台页：概览 + 五个 Tab（基础/转盘/九宫格/任务/流水）+ 固定保存栏；输入防抖调预览；只读账号全禁用；全部 `--tt-*` 令牌。
  **紧凑排版**：字段两列、Tab 吸顶、卡片/输入框密度收紧；**保底奖品/保底图案用选择器**（首项「自动」+ 可读名称），
  管理员不再手填内部 key；九宫格图案/铜版图标走上传（用途 `beidou`，`config.manage`）。
  后台九宫格页写清「横/竖/斜 8 条线，每条线各发一次单线奖，可同时中多条线」。
- 不新增页面/tab/音视频资源；音效复用 `utils/sfx.js`。

## 6. 兼容/迁移/回滚

- 启动期 `migrateBeidouConfig`：按原始文档 `version < 3` 回填新字段、追加铜版奖裁到 8、签到阶梯归零旧次数/步数；幂等，不覆盖管理员已调权重。
- 旧 `beidou_day/beidou_draws` 缺字段按默认值读取；旧客户端仍可调旧路径（`draw.remaining` 按铜版可玩局数计算）。
- 旧未使用抽奖次数不折算铜版；新手赠送 10 作为过渡。
- 回滚：`beidou.enabled=false` 整页只读；新集合/字段不删；旧代码可继续跑。

## 7. 边界

- 分享只能证明「另一个 openid 点开了卡片」，不能证明一定发到了群里（微信无分享成功回调）。
- 自己点/重复点/过期/超限/教师/封禁/限制登录全部拒绝。
- 并发同一 `playId` 只扣一次；并发不同 `playId` 余额只够一次时只有一个成功。
- 扣款后进程崩溃：记录停留 pending/debited，重试同 id 续跑；verify 对账。
- 配置全非法回退默认；九宫格生成有兜底；卷轴滚动中隐藏/卸载直接展示终态。
- 旧客户端可能显示旧文案（「+1 次」），但服务端不会多发。

## 8. 验收

- `tools/check-beidou-lottery.js`（静态契约）+ `tools/check-beidou-grid.js`（盘面纯函数）
- `tools/verify-beidou-lottery.js`（真连库：迁移/新手/任务/分享/双玩法/保底/封顶/钱包对账/旧 API/管理端）
- `tools/check-page-runtime.js`（用户页/后台页行为）
- `node tools/run-all.js`
