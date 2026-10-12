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
| gender / birthdate | Number / Date | 0 未知 1 男 2 女 |
| role | String | `user` / `admin` |
| status | String | `active` / `banned` |
| banReason / banType / bannedUntil / bannedAt | — | 封禁信息（banType: sync 系统检测 / manual 人工） |
| totalSteps / totalDistance / totalDays | Number | 汇总缓存（同步后刷新） |

### wx_sessions
`openid`(unique) + `sessionKey` —— 用于解密微信运动数据，登录时更新。

## 跑步与目标

### run_records
| 字段 | 说明 |
|---|---|
| openid + date | 复合索引；date 为 YYYY-MM-DD |
| source | `werun`（当日微信运动汇总）/ `gps`（单次实跑） |
| steps / distance(m) / calories / durationSeconds / pace | 指标 |
| goalAchieved | 当日步数是否达标 |
| routePoints | GPS 轨迹 `[{latitude, longitude, timestamp}]`（上限 5000 点） |

索引：`(openid, date)`、`(date)`

### goal_config（单例）
全局默认目标（daily/weekly 的 steps/distance/calories）、分时段目标
`graded: [{time: "10:00", percent: 40}]`、反作弊阈值 `anticheat`、激励视频规则 `rewardVideo`。

### goal_plans / body_data / user_goals
BMI 预设计划（bmiMin~bmiMax × 强度偏好匹配）；用户身体数据（height/weight/bmi/bmiLevel）；
用户当前生效计划（autoMatched 标记）。

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
| ad_slots | 广告位（key 唯一，type: banner/card/splash，maxSponsors/exclusive/enabled） |
| ad_contents | 素材（slotKey + sponsorId，投期 startDate~endDate，weight 排序，totalPv/totalClick 冗余计数） |
| ad_stats | PV/点击明细大表。**必带索引**：`(contentId,date)` `(slotKey,date)` `(date)` `(sponsorId,date)` |
| ad_pages | 落地页 HTML（slug 唯一），后端 `/p/:slug` 直出 |

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
