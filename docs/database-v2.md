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
| source | `werun` 微信运动同步 / `gps` GPS 实跑 / `beidou` 北斗（激励视频奖励步数） |
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

**beidou 记录**：激励视频每看一次 `$inc` 一次（当日一条累加）。单独成条的目的就是
**让下一次微信同步不会把奖励步数覆盖掉**（旧实现把奖励 `$inc` 进 werun 记录，当日同步 `$set` 时会清掉）。

索引：`(openid, date)`、`(date)`

### goal_config（单例）
全局默认目标（daily/weekly 的 steps/distance/calories）、反作弊阈值 `anticheat`、激励视频规则 `rewardVideo`、
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

### reward_video_records
`openid + date`（唯一）→ `watchCount / stepsEarned`，服务端校验每日上限。

### ban_records
封禁/解封流水：`userId / openid / action(ban|unban) / banType / reason / durationDays / bannedUntil / operator`。

### appeals
申诉：`openid / banRecordId / content / status(pending|approved|rejected) / reply / reviewedBy / reviewedAt`。
同一用户同时仅允许一条 pending。

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
