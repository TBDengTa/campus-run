# 数据库 2.0 设计（campus_run）

> MongoDB 集合设计。命名约定：`openid` 全线统一；`createdAt/updatedAt` 由时间戳维护；
> 业务时间用 BSON Date，日历键用 `YYYY-MM-DD` 字符串；距离统一为**米**，时长统一为**秒**。

## 用户与认证

### users
| 字段 | 类型 | 说明 |
|---|---|---|
| openid | String, unique | 微信 openid，主键关联 |
| nickname / avatarUrl | String | 微信资料（头像不再存内联 base64） |
| realName / studentId | String | 实名（studentId 唯一稀疏索引） |
| schoolId / departmentId | ObjectId → organizations | 组织归属（冗余 schoolName/departmentName 便于展示） |
| className / specialty | String | 班级 / 专业 |
| grade | String | 年级（如 `2024`，展示为 2024级）；名单未提供时前端按学号前 4 位推导 |
| gender / birthdate | Number / Date | 0 未知 1 男 2 女 |
| role | String | `student` / `teacher`（管理员 = 持有 `superadmin` 权限组） |
| status | String | `active` / `banned` |
| banReason / banType / bannedUntil / bannedAt | — | 封禁信息（banType: sync 系统检测 / manual 人工） |
| totalSteps / totalDistance / totalDays | Number | 汇总缓存（同步后刷新，供徽章与个人主页展示） |

### wx_sessions
`openid`(unique) + `sessionKey` —— 用于解密微信运动数据，登录时更新。

### login_devices
设备登录令牌（历史登录「一键登录」）：`userId`(index) + `account`/`studentId`(冗余便于排查) + `tokenHash`(unique，**只存 sha256**) +
`label`(UA 截断) + `lastUsedAt` + `expiresAt`(30 天) + `revoked`。
索引：`userId_1`、`tokenHash_1`(unique)、`expiresAt_1`、`userId_1_revoked_1_lastUsedAt_-1`（按最久未用淘汰，单用户最多 5 条）。
明文令牌只在签发时返回给客户端一次；**用后即轮换**（旧记录撤销并新增一条）。

## 跑步与目标

### run_records
**同一天会有多条记录**：三种来源各自独立成条，当日指标 = 该日所有记录之和（不要再用 `findOne({date})` 取当日数据）。

| 字段 | 说明 |
|---|---|
| openid + date | 复合索引；date 为 YYYY-MM-DD |
| source | `werun` 微信运动同步 / `gps` GPS 实跑 / `beidou` 北斗（转盘抽奖与签到阶梯奖励的步数） |
| steps / distance(m) / calories / durationSeconds / pace | 指标 |
| goalAchieved | 当日总量是否达标（在最后一条 werun 记录上标记，判定必须用当日总量） |
| routePoints | GPS 轨迹 `[{latitude, longitude, timestamp}]`（上限 5000 点） |

**werun 记录的窗口规则**（`services/steps.js::syncWerunDay`，常量 `SYNC_WINDOW_MS = 1 小时`）：
- 该日最后一条 werun 记录在 1 小时内 → **合并更新该条**；超过 1 小时 → **新建当日下一条**
- 每条记录只存**增量**：`steps = 微信累计 − 该条之前的当日已记录总量`（所以当日总量是各条之和）
- 没有增量时不建空记录（返回 `skipped`）
- 反作弊 `checkStepJump` 按「当日累计 vs 本次微信累计」比对，不再是单条记录比对
- 注意：schema 开了 `timestamps`，`createdAt` 在 Mongoose 里是 **immutable**，
  测试/脚本要回拨时间必须用原生驱动（`db.collection('run_records').updateMany({$set:{createdAt}})`）

**beidou 记录**：北斗运动 2.0 起由**转盘抽奖**与**签到阶梯**写入（每次 `$inc`，当日一条累加）。
单独成条的目的就是**让下一次微信同步不会把奖励步数覆盖掉**（旧实现把奖励 `$inc` 进 werun 记录，当日同步 `$set` 时会清掉）。
2.0 之后**看视频与分享不再写本表**（它们只加抽奖次数），见下方 `beidou_day`。

索引：`(openid, date)`、`(date)`

### goal_config（单例）
全局默认目标（daily/weekly 的 steps/distance/calories）、反作弊阈值 `anticheat`、激励视频规则 `rewardVideo`、
北斗运动 2.0 配置 `beidou`（见下）、
跑分规则 `points`（`dailyGoal` / `weeklyGoal` /
`extraPercent`（日超出档位 = 个人日目标的百分比，默认 10，1~100）/
`weeklyExtraPercent`（周超出档位 = 个人周目标的百分比，默认 10，1~100）/
`perStepScore` / `dailyExtraCap`（单日上限）/ `weeklyExtraCap`（单周上限，**0 = 不封顶**，默认 0）；
`perStep`（固定步数档位）**已完全弃用**：日、周公式都不再读取，字段仅为兼容存量配置而保留）。
（分时段目标 `graded` 已废弃移除；默认目标的管理入口在「运动考核」模块 `/api/admin/assessment/defaults`，
跑分设置入口在「系统配置 → 跑分设置」`packageAdmin/config/points`；跑分按当前配置实时计算、不落库快照。）

### goal_plans / body_data / user_goals
BMI 预设计划（bmiMin~bmiMax × 强度偏好匹配，`isDefault` 全局唯一兜底，管理入口 `/api/admin/assessment/plans`；
被 user_goals 引用中的计划禁止硬删，只能停用）；用户身体数据（height/weight/bmi/bmiLevel）；
用户当前生效计划（autoMatched 标记，**快照式**：修改计划不回填已应用用户）。

## 北斗运动 2.0（签到 + 转盘抽步数 + 做任务赚次数）

方案与口径：`docs/beidou-lottery-plan.md`。旧 `goal_config.rewardVideo` 段**原样保留**（存量记录与历史统计仍用），
本节的 `beidou` 段是新增的独立配置，两者互不覆盖。

### goal_config.beidou（配置段，不是独立集合）
| 字段 | 说明 |
|---|---|
| enabled | 总开关；关闭后用户端整页只读 |
| video.drawPerWatch / dailyLimit / adUnitId | 看视频每次给几次、每日可看次数（0=不限）、广告位 |
| share.drawPerShare / dailyLimit / minIntervalSec | 邀请每次给几次、每日上限（0=不限）、**服务端最小间隔（防连点，非次数上限）** |
| checkin.enabled / milestones[] / loopAfter | 签到开关、7 天阶梯（`{draw, steps}`）、满一轮后是否重来 |
| draw.maxPerDay | 每日抽奖次数上限（**0 = 不限**，用户 2026-11-11 定） |
| draw.dailyStepsCap | **每日步数奖励上限（默认 3000，唯一成本闸门）**：达标后步数奖降级为空奖 |
| prizes[] | `{key, label, type: steps\|none\|draw, amount, weight}`，≤8 项 |

### beidou_day（每人每天一份，`openid+date` 唯一）
所有计数收敛到这一份文档，抽奖并发安全用 `draw.used` 做 CAS 版本号。

| 字段 | 说明 |
|---|---|
| openid + date | 复合唯一索引（重复签到/重复建档的硬拦截） |
| draw.total / used | 今日**获得**总次数 / 今日**已抽**次数（后者是 CAS 版本号） |
| draw.fromVideo / fromShare / fromCheckin / fromPrize | 各来源计数（排查「次数哪来的」用） |
| draw.stepsAwarded | **今日抽奖+签到累计发出的步数**（封顶判定唯一依据，新增发步数路径必须累加） |
| draw.capped | 今日是否已触及封顶（前端常驻提示用） |
| video.count / watchIds[≤50] | 看视频计数与幂等凭据 |
| share.count / lastAt | 分享计数与最小间隔时间戳 |
| checkin.done / at / streak / award | 签到状态；`streak` = 当日签到**后**的连续天数 |

索引：`(openid, date)` unique

### beidou_draws（抽奖流水，审计与概率公示核对）
每次抽奖一条：`openid` / `date` / `drawId` / `prizeKey` / `type` / `amount` / `roll`（随机数留证）/
`index`（命中扇区）/ `capped`（是否因封顶被降级）/ `source`（本笔机会的来源）。

- `source` 取值 `video 看视频 / share 邀请 / checkin 签到 / prize 再来一次 / unknown 老数据`。
  ⚠️ 它是**账本归属**而不是「用户从哪个页面点进来」：次数是一个合并池（`beidou_day.draw.total`），
  抽奖时按固定优先级 `prize → checkin → video → share` 从各来源余额里扣一笔，扣到谁就记谁
  （唯一实现 `services/beidou.js::pickSource`；优先级写死在代码里不进配置 —— 调松等于全员稀有/统计口径漂移）。
  配对字段是 `beidou_day.draw.usedVideo/usedShare/usedCheckin/usedPrize`，
  不变量：**∑used\* == draw.used**，且每个 `used* <= from*`。
- 索引：`(openid, date)`、`(openid, drawId)` **unique**、`(date:-1, prizeKey)`、`(source, date:-1)`（管理端按来源+日期筛）
- ⚠️ **幂等索引必须含 `openid`，不能是 `drawId` 全局唯一**：
  客户端 drawId 是「时间戳+随机串」，跨用户理论上会撞。全局唯一时后来者撞上别人的记录 →
  被幂等分支当成「重复提交」→ 返回**别人的奖品与 index**，自己次数不扣、步数不发，
  而接口回 `success:true`，日志毫无痕迹。幂等语义从来是「同一个人同一笔」。
  旧库的 `drawId_1 unique` 由启动迁移 `services/beidou.js::migrateDrawIdIndex()` 显式删除
  （Mongoose 只新建缺失索引、不会替换已存在的旧索引，与 `dorms.js::migrateSlotIndex` 同一类陷阱）。
- **管理端只读**（`GET /api/admin/config/beidou-draws`，支持 `dateFrom/dateTo/source/prizeKey` 筛选 + 分面计数）：
  不允许补发或撤销 —— 改流水会让概率公示与实际发放对不上；要补偿走「人工发徽章」等独立链路。

## 排行榜

榜单不新增集合，全部由 `run_records` 实时聚合（接口 `GET /api/ranking`），只用既有索引：

| 维度 | 管道 | 说明 |
|---|---|---|
| 日榜 `/range=day` | `$match {date: 今天, steps>0}` → `$group by openid` | 走 `(date)` 索引 |
| 周榜 `/range=week` | `$match {date: 本周一~今天}` → `$group by openid` | 同上 |
| 总榜 `/range=total` | `$match {steps>0}` → `$group by openid` | 走 `(openid)` 索引；110k 文档实测约 0.2s |

- 组织范围过滤在 `$lookup users` 之后按 `schoolId / departmentId / className` 匹配，并剔除 `status='banned'`。
- 聚合结果按步数倒序，内部最多扫描 2000 名、对外返回前 50 名；`openid` 不外泄。
- 服务端对聚合结果做 60s 进程内缓存，避免大集合被高频重复聚合。
- 不依赖 `users.totalSteps` 缓存（该字段仅由同步刷新，新迁移数据可能为 0，会造成总榜空榜）。

## 赚步数与反作弊

### reward_video_records（**2.0 起只读历史**）
`openid + date`（唯一）→ `watchCount / stepsEarned / watchIds[]`。
北斗运动 2.0 起不再写入（看视频改为加抽奖次数，落在 `beidou_day.video`），本表保留存量数据供历史统计与对账。

### ban_records
封禁/解封流水：`userId / openid / action(ban|unban) / banType / reason / durationDays / bannedUntil / operator`。

### appeals
申诉：`openid / banRecordId / content / status(pending|approved|rejected) / reply / reviewedBy / reviewedAt`。
同一用户同时仅允许一条 pending。

### anticheat_model_states（唐跑AI数据模型的**阶段状态**，每来源一份）
用户 2026-11-12「阶段性自升级」。上一版只有「标注攒够了可以升级」的提示、没有升级动作，
本集合记录模型实际处在哪一级、凭什么升的、谁批的。

| 字段 | 说明 |
|---|---|
| source | `werun` / `gps`，**unique**（两套特征与模型，状态必须分开） |
| stage / stageKey | `0 unsupervised` 无监督 / `1 assist` 影子辅助 / `2 primary` 有监督主判 |
| mode | `auto`（默认，评估可自动动阶段）/ `manual`（管理员手动指定过；自动评估**只写建议**） |
| stateVersion | CAS 版本号，多进程同时评估时**抢输的进程放弃写入**（不互相覆盖） |
| model | 有监督逻辑回归：`features[]`（训练时按覆盖率挑定的特征清单，推理只按它取维度）/ `bias` / `weights[]` / `means[]` / `stds[]` / `operating{pSuspicious,pAutoBan}` |
| metrics | `auc`（分层 K 折均值）/ `aucStd`（折间波动，稳定性闸门看它）/ `aucFolds[]` / `precisionAtSuspicious` / `precisionAtAutoBan` / `recallAtAutoBan` / `samples` |
| coverage | 各特征的样本覆盖率（解释「为什么某个维度没进模型」：老标注缺 2026-10-29 才加的 ruleHits） |
| stagedAt | 进入当前阶段的时刻（主判要求影子阶段驻留 ≥3 天；降级要求满 24 小时） |
| history[] | `{at, from, to, reason, operator, metrics}`，最近 50 条，可追责 |

`stage` 的语义与护栏（改这块先读 `services/anticheat-upgrade.js` 文件头）：
- **影子辅助阶段分数封顶在自动封禁线以下**（取当前生效阈值 −0.02，不写死 0.78），只能进待研判；
- 升级闸门是量化的（样本量 / 类别平衡 / 交叉验证 AUC ± 波动 / 精度 / 影子实测精度），缺什么用中文下发；
- **降级能自动发生**（线上实测精度 <60% 或 AUC <0.6 → 退一级）；只会升不会降的模型是单向棘轮。

### step_labels / step_anomalies 的有监督字段（2026-11-12 增）
两张表各增三项，构成「影子证据」的完整通路（少写一层就永远升不到主判）：

| 字段 | 说明 |
|---|---|
| modelStage | 判定/标注当时有监督模型处在第几阶段（旧数据为 0，**一律不算影子证据**，不猜） |
| supervisedProb | 当时的作弊概率（0~1，逻辑回归输出） |
| supervisedScore | 映射后的风险分（与无监督分同一量纲，锚定当前生效阈值） |

`step_anomalies` 侧由 `services/steps.js` 在写线索时落库；`step_labels` 侧由
`services/anomaly-disposal.js::recordFeedback` 在人工标注时带入 —— 「影子实测精度」
= 只看 `modelStage >= 1` 的标注里，被判为可疑的那些有多少比例人工确认是作弊。

## 健康模块

- **water_records**：`openid + date`（唯一）→ `target / total / logs[{time, amount, type}]`
- **badges**：徽章定义，条件类型 `total_steps / total_distance / total_days / goal_days / single_steps / single_distance / streak_days` + `target` 阈值；tier 阶梯（组/级/色）
- **user_badges**：`openid + badgeKey`（唯一）获得记录

## 广告系统

| 集合 | 说明 |
|---|---|
| ad_sponsors | 广告主（名称/联系人/电话/邮箱/logo/active） |
| ad_slots | 广告位（key 唯一，type: banner/card/splash，maxSponsors/exclusive/enabled/builtIn） |
| ad_contents | 素材（slotKey + sponsorId，投期 startDate~endDate，weight 排序，totalPv/totalClick 冗余计数） |
| ad_stats | PV/点击明细大表。**必带索引**：`(contentId,date)` `(slotKey,date)` `(date)` `(sponsorId,date)` |
| ad_pages | 落地页 HTML（slug 唯一），后端 `/p/:slug` 直出 |

内置广告位（`builtIn: true`，启动时由 `services/ads.js::seedAdSlots()` 按 key 幂等播种，
**不可删除、key 不可修改**，名称/类型/展示规则/开关可由运营改）：

| key | 名称 | type | 所在页面 |
|---|---|---|---|
| home_banner | 首页轮播 | banner | 首页 |
| startup_banner | 开屏（启动页广告） | splash | 启动页 |
| record_card | 记录页卡片 | card | 运动记录 |
| ranking_card | 排行榜卡片 | card | 排行榜 |

> 开屏位沿用旧库已有的 `startup_banner`（旧名「启动页轮播」即启动页广告），不另造 key；
> 该位在库里是**独占位**（`exclusive: true`，只下发权重最高 1 条）。

下发口径（`services/ads.js::pickAdsForSlot`）：广告位停用 → 不下发；`exclusive` → 只下发权重最高 1 条；
`maxSponsors` → 按广告主去重后限量（同一广告主只取权重最高的一条）。

## 基础内容

- **organizations**：三级树 `school → department → specialty`，`parentId` 自关联
- **class_monitors**：班长绑定（openid 唯一，className 索引）
- **holidays**：`date` 唯一 + `year` 索引
- **announcements**：`priority` 排序 + `startAt/endAt` 投放窗口
- **changelogs**：`version` 倒序索引

## 与 1.0 的差异

| 项 | 1.0 | 2.0 |
|---|---|---|
| openid | `_openid` / `openid` / `userId` 混用 | 统一 `openid` |
| 距离 | km / m 混用 | 统一米 |
| 时间 | Date 与 ISO 字符串混用 | 统一 BSON Date（日历键除外） |
| 大表索引 | ad_stats 202 万条无索引 | 全部补齐 |
| 头像 | 内联 dataURI（单条 11KB） | 只存 URL |
| 付费套餐 | pay_orders / plan_config / beidou_plans | 2.0 移除（未选做） |
