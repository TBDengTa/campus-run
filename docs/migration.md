# 1.0 → 2.0 迁移指南

迁移脚本：`server/scripts/migrate-v1-to-v2.js`（只读旧库，写入新库，旧库零改动）。

```bash
cd server
cp .env.example .env    # 配置 LEGACY_MONGO_URI / LEGACY_MONGO_DB_NAME（旧库）与 MONGO_URI / MONGO_DB_NAME（新库）
npm run migrate:dry     # ① 先试运行：打印旧库概览、role 分布、对账报告，不写入
npm run migrate         # ② 正式迁移
```

## 迁移内容

| 旧集合 | 新集合 | 处理 |
|---|---|---|
| users | users | `_openid/boundOpenid`→`openid` 去重；`nickName`→`nickname`；dataURI 头像清空；banned→status；role≠user→admin；220 个未关联微信的档案跳过 |
| session_keys + users.sessionKey | wx_sessions | 合并去重 |
| run_records | run_records | 距离 km→m，duration "mm:ss"→秒，source `run`→`gps` |
| beidouRecords | reward_video_records | 按 openid+date 聚合求和 |
| ban_history | ban_records | userId 重映射为新 ObjectId，回填 openid |
| appeals | appeals | status 校验映射 |
| body_data / goal_plans / user_plans | body_data / goal_plans / user_goals | 字段规范化，距离 km→m |
| water_intakes | water_records | total 重算，`created_at`→`createdAt` |
| badges + user_badges | badges + user_badges | `conditionType`→`type`（login_days→total_days，achievement_count→goal_days），`imageUrl`→`icon`；引用已删除徽章的记录跳过并告警 |
| organizations | organizations | 支持 school/department/**specialty** 三级 |
| class_monitors / holidays / announcements / changelogs | 同名 | 字段规范化 |
| ad_sponsors / ad_slots / ad_contents / ad_pages / ad_stats | 同名 | ObjectId 重生成 + 引用重映射（sponsorId/pageId/contentId）；孤儿 ad_stats 丢弃 |
| goals + graded_goals | goal_config（单例） | 合并为全局配置，距离 km→m |
| pay_orders / plan_config / beidou_plans | — | **不迁移**（2.0 未选做付费套餐） |
| classes / schools / departments / ads / banned_users_records / goal_rules | — | 旧库空表，跳过 |

## 关键机制

- **_id 重生成**：旧库 `_id` 是自造 32 位 hex 字符串，与新 schema 的 ObjectId 不兼容。迁移时全部重新生成，
  通过内存映射重写所有引用字段（ban_history.userId、appeals.banRecordId、user_plans.planId、
  organizations.parentId、users.schoolId/departmentId、ad_* 互引）。
- **索引**：迁移完成后自动创建全部索引（含 ad_stats 大表 4 组复合索引）。
- **告警**：对账报告列出所有跳过的文档及原因（孤儿引用、字段缺失等），可据此人工复核。
- **可重复性**：迁移向**空库**执行；如需重跑，先清空新库。

## 1.0 实测对账（2026-10 迁移）

users 1537/1537（跳过 220 个匿名档案）· run_records 110302 · reward_video_records 3523 ·
badges 10/10 · user_badges 905（99 条引用已删除徽章定义，跳过）· organizations 28（含 21 个专业）·
ad_stats 1598901（丢弃 42.8 万条孤儿明细）· 其余全量一致。
