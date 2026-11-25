# 唐唐快跑 2.0 · 内部文件架构

> 本文回答三个问题：**代码放在哪、为什么这么分、改动应该落在哪一层。**
> 产品介绍、启动步骤与版本记录见根目录 [README.md](../README.md)；
> 权限 / 学籍 / 跑分 / 登录态等硬约束见 [AGENTS.md](../AGENTS.md)。
>
> 约定：本文只写**结构性事实**。涉及具体业务口径时，以对应 service 与 `AGENTS.md` 为准，
> 不在文档里复制第二份实现细节，避免两处漂移。

---

## 1. 运行时拓扑

```
微信小程序（原生 + TDesign）
  ├── 主包：用户端页面、公共组件、utils、自定义 tabBar
  ├── packageAdmin：管理端页面（按权限渲染）
  └── packageUnion：学生会页面（录入 / 水印相机 / 复核 / 名单）
            │
            │ HTTPS + JWT（Authorization: Bearer）
            ▼
Nginx（TLS、gzip、/uploads 静态、/api 反代）
            │
            ▼
Node.js + Express（默认 127.0.0.1:3010）
  ├── /api/*        小程序 API（JWT）
  ├── /console       Web 控制台（账号密码 + HttpOnly Cookie）
  ├── /p/:slug       广告 H5 落地页
  ├── /uploads/*     上传文件静态服务
  └── /health        探活（build / version）
            │
            ▼
MongoDB（Mongoose，显式集合名）
```

两条鉴权链路**刻意隔离**：

| 入口 | 凭证 | 中间件 | 能做什么 |
|---|---|---|---|
| `/api/*` | 小程序 JWT | `middlewares/auth.js` | 用户端 / 班级域 / 学生会域 / 管理端 |
| `/console/api/*` | HttpOnly Cookie | `routes/console.js` + `console-session` | 只读状态台、AI 训练台、反作弊处置 |

浏览器里拿到的 Cookie **不能**调用小程序 API；小程序 JWT 也**不能**进控制台。
这不是洁癖：XSS 偷到的控制台会话若同时能改步数 / 发徽章，爆炸半径会大一个量级。

---

## 2. 分层与依赖方向

### 2.1 后端

```
routes/            只做：鉴权、取参、校验请求形状、调用 service、返回统一响应
  │
  ▼
services/          业务判定与写入的唯一实现（可被多个路由复用）
  │
  ▼
models/            Mongoose 模型 + 索引 + 少量文档方法（如 toSafeJSON）
  │
  ▼
MongoDB
```

硬规则：

- **路由不写业务**：同一业务出现第二份判定，就是「单条会、批量不会」的起点；
- **服务不读 `req` / `res`**：service 接收普通参数，返回普通对象，便于脚本与测试复用；
- **模型显式集合名**：`mongoose.model('X', schema, 'collection')`，不依赖自动复数；
- **大集合必须有索引**：查询条件与排序字段要能落到索引，参考 `docs/database-v2.md`；
- **时间用 BSON Date**：日历键用 `YYYY-MM-DD` 字符串；距离米、时长秒。

### 2.2 前端

```
app.js              全局登录态、缓存、角色探测、启动流程
  │
pages / package*    页面：只做展示与交互，数据来自 utils/request.js
  │
components/         可复用 UI（不直接发请求，事件抛给页面）
  │
utils/              请求、权限、导航、格式化、水印、断点等横切能力
  │
app.wxss            设计令牌（--tt-* / --tt-glass-*）唯一来源
```

硬规则：

- **请求单一出口**：所有 HTTP 走 `utils/request.js`，页面不直接 `wx.request`；
- **导航单一数据源**：首页 / 工作台 / tabBar 的入口都来自 `utils/nav-groups.js`；
- **颜色 / 圆角 / 间距走令牌**：页面禁止硬编码品牌色；
- **服务端才是闸门**：前端只按服务端下发的权限 / `capabilities` 控制显隐。

---

## 3. 前端文件架构

### 3.1 顶层目录

| 路径 | 职责 | 关键约束 |
|---|---|---|
| `miniprogram/app.js` | 启动、静默登录、全局缓存、角色探测 | 登录态以服务端 `/api/auth/me` 为准 |
| `miniprogram/app.json` | 页面 / 分包 / tabBar / 权限声明 | `resizable: true` 必开，否则三端断点不生效 |
| `miniprogram/app.wxss` | 白橙设计系统 + 玻璃令牌 | `--tt-*` / `--tt-glass-*` 唯一来源 |
| `miniprogram/pages/` | 用户端主包 27 页 | 新页面优先评估是否该进分包 |
| `miniprogram/packageAdmin/` | 管理端分包 33 页 | 写入口必须有 `canManage` 守卫 |
| `miniprogram/packageUnion/` | 学生会分包 7 页 | 成员资格 + 部门 + 院系范围由服务端判定 |
| `miniprogram/components/` | 8 个公共组件 | 组件不发请求；用公共类需 `styleIsolation: apply-shared` |
| `miniprogram/behaviors/` | `screen`（三端断点）/ `skyline`（渲染适配） | 页面用 `behaviors: [screen]` 接断点 |
| `miniprogram/custom-tab-bar/` | 自定义玻璃悬浮导航 | 根节点挂 `page` 类 + `apply-shared`，否则令牌全失效 |
| `miniprogram/utils/` | 15 个横切工具 | `request` / `nav-groups` / `screen` / `watermark` / `format` 等 |
| `miniprogram/config/` | `env.example.js` | 真实 `env.js` 已忽略，严禁入库 |
| `miniprogram/assets/` | 图标与首页图 | 主包体积敏感，新增大图先评估分包 / CDN |
| `miniprogram_npm/` | 已构建 TDesign | 不手改；升级走 npm 构建流程 |

### 3.2 页面地图

**主包（用户端）**

| 域 | 页面 |
|---|---|
| 启动 / 首页 | `splash`、`home`、`hub` |
| 运动 | `run/index`、`run/detail`、`records`、`records/day`、`records/week`、`ranking` |
| 目标 / 激励 | `goal-plan`、`body-data`、`badges`、`reward`、`water` |
| 账号 / 身份 | `auth-login`、`org/bind`、`password/change`、`profile`、`privacy` |
| 内容 / 申诉 | `announcements`、`changelogs`、`appeal/submit`、`appeal/list`、`banned` |
| 通用 | `webview`、`about`、`union/union`（工作台入口） |

**管理端分包（`packageAdmin`）**

| 域 | 页面 |
|---|---|
| 数据看板 | `dashboard`（由 `pages/hub` / 管理入口进入） |
| 用户 | `users/users`、`users/import`、`users/account-edit`、`user-detail/*` |
| 组织 | `content/organizations` |
| 班级 | `class-manage/class-manage`、`class-manage/dorms`、`class/class`、`class-status/class-status` |
| 学生会 | `union/members`、`union/config`、`union/scan-join`、`appeals/appeals` |
| 考核 | `assessment/goals`、`assessment/plans`、`config/points` |
| 反作弊 | `config/anticheat`、`config/anomalies` |
| 内容 | `content/announcements`、`content/badges`、`content/changelogs`、`content/holidays` |
| 广告 | `ads/sponsors`、`ads/slots`、`ads/contents`、`ads/pages`、`ads/stats` |
| 系统 | `config/buildings`、`config/reward-video`、`config/demo`、`files`、`permissions/groups` |

**学生会分包（`packageUnion`）**

| 页面 | 职责 |
|---|---|
| `entry/entry` | 检查录入台：对象选择、模块字段、名单、批量「无缺勤」 |
| `wcamera/wcamera` | 水印相机：实时浮层、拍照合成、托盘、横屏布局 |
| `records/records` | 检查记录列表 / 筛选 |
| `record/record` | 检查记录详情、照片、复核入口 |
| `review/review` | 复审台：分档、批量审核 |
| `roster/roster` | 名单查询 |
| `stats/stats` | 部门 / 院系统计 |

### 3.3 导航与工作台

`utils/nav-groups.js` 是**唯一数据源**：

- `NAV_GROUPS`：入口分组与能力条件；
- `navCtx(user)`：首页与工作台共用的身份上下文（`canManage` / `isTeacher` / `isClassOfficer` /
  `isUnionMember` / `canUnionScanJoin` 等）；
- `WORKBENCH_TAB`：动态 tab 只有 1 个「工作台」，学生按身份插入，6 项封顶；
- `entryVisible()`：入口按**真实能力**判定，不按「能看一眼」判定。

改导航时只改 `nav-groups.js` + `check-nav-groups.js`，不要在 `home.js` / `hub.js` 各写一份 `ctx`。

### 3.4 请求与登录态

`utils/request.js` 统一处理：

1. 从 `config/env.js` 取 `BASE_URL`（缺失时回退 `env.example.js` 并告警）；
2. 自动带 `Authorization: Bearer <token>`；
3. 401 → 清 token / 静默重登（用户主动退出后不重登）；
4. 封禁态（403001 / 403002 等）→ 返回可识别结构，页面渲染封禁条 / 申诉入口；
5. 超时、网络错误、业务错误统一成 `{ code, message, data }`。

登录态存储键：`tt_token` / `tt_user` / `tt_uid` / `tt_bound` / `tt_logged_out`。
退出登录必须清**所有账号相关缓存**（含 `globalData` 与页面级 `canManage`），否则会出现
「换号后还带着上一个人的身份」。

### 3.5 UI 系统

| 能力 | 实现 | 约束 |
|---|---|---|
| 白橙设计令牌 | `app.wxss` 的 `--tt-*` | 页面禁止硬编码品牌色 / 旧蓝色 |
| 玻璃拟态 | `--tt-glass-*` + `.tt-glass` / `.tt-glass-press` / `.tt-glass-hover` | 令牌只此一份；必须带 `-webkit-backdrop-filter` + `@supports not` 实底降级 |
| 三端断点 | `utils/screen.js` + `behaviors/screen.js` | `compact <600px` / `regular 600~900px` / `wide >900px`；宽屏块内一律 px 禁 rpx |
| 数字格式 | `utils/format.js` | 大数字 `.num-font`；时间北京时区 |
| 水印版式 | `utils/watermark.js` | 实时浮层与 canvas 烙图共用一份文案 / 布局 |
| 音效 | `utils/sfx.js` | 抽奖等交互音效统一出口 |

### 3.6 分包与体积

- 主包 = 根目录文件 + `miniprogram_npm`，上限 2MB；
- 每个分包各自上限 2MB；
- `tools/check-miniprogram.js` **分别**统计主包与各分包，不再把所有页面混算；
- 新增管理 / 学生会页面默认进分包；新增首页大图先压缩或走 CDN。

---

## 4. 后端文件架构

### 4.1 启动流程

`server/src/index.js`：

```
main()
  ├── 校验 JWT_SECRET
  ├── 连接 MongoDB（错误翻译成可操作提示）
  ├── bootstrap()
  │     ├── seedRbac()                 权限目录 / 内置权限组
  │     ├── seedAdSlots()              内置广告位
  │     ├── seedBadges()               徽章定义
  │     ├── GoalConfig.getSingleton()  全局配置
  │     ├── seedUnionDepartments()     学生会部门
  │     ├── seedCheckModules()         检查模块
  │     ├── migrateToTenPoint()        历史检查分制换算
  │     ├── migrateSlotIndex()         宿舍槽位索引
  │     ├── migrateMemberUniqueIndex() 学生会成员唯一索引
  │     ├── migrateDrawIdIndex()       北斗流水索引
  │     ├── migrateBeidouConfig()      北斗 v3 → v4 配置
  │     ├── seedBeidouBuiltinIcons()   北斗内置图标
  │     └── syncClassProfiles()        班级台账首次生成
  ├── listen()                         监听 + 自升级定时器 + 优雅退出
  └── 启动失败 → 打印可操作提示并退出
```

> 启动期迁移必须**幂等**、只补不覆盖；耗时训练只在 `listen()` 之后启动，且 `NODE_ENV=test` 不启动。

### 4.2 中间件链

`server/src/app.js` 注册顺序（Express 按注册顺序执行，顺序本身就是契约）：

1. `trust proxy`（只信一层，避免伪造 `X-Forwarded-For`）；
2. `express.json({ limit: '2mb' })`；
3. 请求计数 / 计时；
4. `/health`（`no-store`，返回 `build` / `version`）；
5. `/`、`/console` 控制台页面（CSP / X-Frame-Options / no-store / 资源 `?v=mtime`）；
6. `/console` 静态资源；
7. `/console/api`（Cookie 会话）；
8. `/p/:slug` 广告落地页（`public, max-age=60`）；
9. `/uploads` 静态（`immutable`）；
10. `/beidou` 内置图案（`max-age=1h`）；
11. `/api` 全局 `no-store`（**必须挂在所有 API 路由之前**）；
12. 各 `/api/*` 路由；
13. `notFound` → `errorHandler`。

### 4.3 路由地图

**用户端 / 班级域 / 学生会域（18）**

| 前缀 | 文件 | 说明 |
|---|---|---|
| `/api/auth` | `routes/auth.js` | 微信登录、绑定、一键登录、示例账号解绑 |
| `/api/roster` | `routes/roster.js` | 学籍 / 名单查询 |
| `/api/run` | `routes/run.js` | 步数同步、GPS 实跑、运动记录 |
| `/api/ranking` | `routes/ranking.js` | 排行榜（全校 / 院系 / 班级） |
| `/api/points` | `routes/points.js` | 跑分 |
| `/api/goal` | `routes/goal.js` | 目标 / 计划 / 身体数据 |
| `/api/reward-video` | `routes/reward-video.js` | 激励视频 |
| `/api/beidou` | `routes/beidou.js` | 北斗运动：签到 / 转盘 / 九宫格 / 分享 / 播报 |
| `/api/water` | `routes/water.js` | 喝水打卡 |
| `/api/badges` | `routes/badge.js` | 徽章 |
| `/api/appeals` | `routes/appeal.js` | 申诉 |
| `/api/ads` | `routes/ad.js` | 广告曝光 / 点击 |
| `/api/org` | `routes/org.js` | 组织架构只读 |
| `/api/class` | `routes/class.js` | 班级域（班主任 / 班委成员资格） |
| `/api/union` | `routes/union.js` | 学生会域（录入 / 复核 / 名单 / 统计） |
| `/api/content` | `routes/content.js` | 公告 / 节假日 / 版本日志 |
| `/api/upload` | `routes/upload.js` | 头像 / 检查照片 / 广告素材 |
| `/api/admin` | `routes/admin/index.js` | 管理端总入口 |

**管理端（16）**

| 子前缀 | 文件 | 权限（前缀级） |
|---|---|---|
| `/dashboard` | `dashboard.js` | `dashboard.view` |
| `/users` | `user-badges.js` + `users.js` | `badge.manage`（徽章）/ `user.view`（其余） |
| `/step-anomalies` | `step-anomalies.js` | 内部 `anticheat.*` |
| `/appeals` | `appeals.js` | `appeal.view` |
| `/ads` | `ads.js` | `ad.view` |
| `/content` | `content.js` | `content.view` |
| `/config` | `config.js` | 内部 `config.*` / `building.*` |
| `/assessment` | `assessment.js` | `assessment.view` |
| `/union` | `union.js` | `union.view`（写操作内部 `union.manage`） |
| `/class` | `class-profile.js` | `class.view`（写 `class.manage`） |
| `/files` | `files.js` | `file.view` |
| `/upload` | `upload.js` | `ad.manage` / `file.manage` / `content.manage` / `config.manage` 任一 |
| `/permission-groups` | `permission-groups.js` | `permission.manage` |
| `/demo` | `demo.js` | 内部 `config.view` / `config.manage` |
| `/permissions` | `index.js` 内联 | `permission.manage` |
| `/users/:id/badges` | `user-badges.js` | `badge.manage` |

> 管理端路由一律 `requirePermission`（或内部等价守卫），禁止只靠前端隐藏。

### 4.4 服务地图（48 个）

按域分组，改业务先找对应 service，不要在路由里重写：

| 域 | 服务 |
|---|---|
| 身份 / 账号 | `password`、`login-device`、`wechat`、`rbac`、`user-account-admin`、`demo-accounts`、`console-session` |
| 学籍 / 组织 | `roster`、`org-resolve`、`class-profiles`、`class-roles`、`student-scope`、`name-search`、`name-mask` |
| 运动 / 目标 | `steps`、`gps-metrics`、`goals`、`points`、`score-scale`、`ranking-scope`、`formula` |
| 反作弊 | `anticheat`、`anticheat-config`、`anticheat-model`、`anticheat-supervised`、`anticheat-upgrade`、`anomaly-disposal`、`anomaly-gps-detail`、`step-anomaly`、`sync-rate-history` |
| 检查 / 班超 | `check-modules`、`union`、`union-review`、`band-chao`、`class-status-board`、`class-counts`、`dorms`、`student-dorm` |
| 班级报表 | `class-report-export`、`class-status-export` |
| 北斗 | `beidou`、`beidou-config`、`beidou-wallet`、`beidou-grid` |
| 激励 / 内容 | `badges`、`user-badges-manual`、`reward-video`、`ads` |
| 文件 | `utils/uploader`（路由层调用） |

> 同一业务只能有一个 service 实现；`check-server-contract` 会对关键唯一实现做反向断言。

### 4.5 模型地图（47 个）

| 域 | 模型 |
|---|---|
| 用户 / 身份 | `user`、`wx-session`、`login-device`、`permission`、`permission-group` |
| 运动 / 目标 | `run-record`、`goal-config`、`goal-plan`、`user-goal`、`body-data`、`water-record`、`reward-video-record` |
| 反作弊 | `step-anomaly`、`step-label`、`ban-record`、`anticheat-model-state`、`appeal` |
| 组织 / 班级 | `organization`、`class-profile`、`class-monitor`、`dorm-room`、`dorm-assignment`、`sanitary-area`、`check-module`、`check-record` |
| 学生会 | `union-department`、`union-member`、`union-invite` |
| 北斗 | `beidou-day`、`beidou-draw`、`beidou-wallet`、`beidou-coin-log`、`beidou-share-link`、`beidou-share-click` |
| 内容 / 广告 | `announcement`、`holiday`、`changelog`、`badge`、`user-badge`、`ad-sponsor`、`ad-slot`、`ad-content`、`ad-stat`、`ad-page` |
| 文件 / 迁移 | `file-object`、`migration-flag` |
| 汇总 | `models/index.js` |

### 4.6 脚本（`server/scripts/`，11 个）

- 迁移：`migrate-v1-to-v2.js`（1.0 → 2.0，支持 dry-run）；
- 引导：`admin-add.js`、`test-auth-flow.js`；
- 回填：`backfill-org-ids.js`、`backfill-user-profile.js`、`backfill-badge-level.js`；
- 修复：`fix-dorm-room-dup-prefix.js`、`fix-class-names.js`、`fix-union-role-dept.js`、`dedupe-badge-definitions.js`。

> 数据修复脚本默认 **dry-run**，`--apply` 才写；写库前自动备份到 `_backup/`，备份失败直接中止。
> 一次性调试脚本命名 `_tmp-*` / `_probe*`，跑完即删，不入库。

---

## 5. 关键数据流

### 5.1 微信登录 / 绑定

```
小程序 wx.login → POST /api/auth/login { code }
  → services/wechat.js::code2session
  → 查 wx_sessions / users
  → 未绑定：签发游客 JWT（只允许 /api/auth/*）
  → 已绑定：签发正式 JWT（payload 含 uid + openid）
  → 前端存储 token / userInfo
```

绑定规则：

- 学生：一账号一微信；学生微信不能被任何账号顶掉；
- 教师：允许换绑；同一微信只能登一个账号，换绑时先 `$unset` 原账号 openid；
- JWT 的 `openid` 与当前 `user.openid` 不一致 → 401，前端自动重新 `wx.login` 自愈；
- 换绑**不得**吊销原账号的 `deviceToken`（别的设备的一键登录仍合法）。

### 5.2 微信步数同步 / 反作弊

```
小程序 wx.getWeRunData → POST /api/run/sync
  → services/steps.js 解密 / 合并当日步数
  → 写 run_records
  → 特征提取（单日总量、增量、涨幅速度、固定数字模式……）
  → services/anticheat.js 评分
  → 达线且自动处置开启 → 限制登录 / 同步 / GPS，写 step_anomalies + ban_records
```

关键边界：

- 涨幅速度 = 本次新增 ÷ 距上次同步时长，分母不可信：间隔 < 180s 不判；
- 物理约束层给涨幅速度的分数**封顶低于自动封禁线**，只能进待研判；
- 自动处置总开关 `goal_config.anticheat.enabled` 覆盖**全部**自动封禁路径；
- 自动封禁后必须回写线索（`status='banned'` + `autoBanned=true`）。

### 5.3 GPS 实跑

```
wx.startLocationUpdateBackground → 前端采样
  → POST /api/run/gps（轨迹点）
  → services/gps-metrics.js 计算距离 / 配速 / 平滑度
  → 落 run_records
  → 反作弊特征（峰值速度、配速、点间隔）
```

GPS 线索必须带轨迹快照（降采样 ≤400 点）与 `runRecordId`；自动封禁的 GPS 跑不落 `run_records`，
快照是唯一轨迹来源。

### 5.4 检查录入 / 复核

```
packageUnion/entry
  → GET /api/union/entry/targets（受检对象，按身份范围）
  → GET /api/union/entry/students?targetType=&targetId=（名单 + 范围）
  → POST /api/union/records（单条）或逐条复用（批量「无缺勤」）
  → services/union.js 校验模块 / 对象 / 范围 / 字段
  → 写 check_records
```

复核：

```
packageUnion/review
  → GET /api/union/review/queue（scopeFilter + 照片裁剪 + canReview）
  → POST /api/union/records/:id/review（单条）
  → POST /api/union/review/batch（逐条走 reviewOne，单次上限 50）
```

硬约束：

- 单条 / 队列 / 批量共用 `reviewableOf` + `reviewOne`；
- 禁止自审（提交人不能复核自己的记录）；
- 分数分档按 `record.deduct`（所有模块都有），不是 `score`；
- 宿舍照片只对检查人 / 主席团 / 所属部门部长 / 教师下发原图 URL。

### 5.5 班级状态 / 班超

```
GET /api/admin/class-status（管理端）
  → services/class-status-board.js
      ├── 取班级台账 + 检查记录 + 校园跑
      ├── 按日 / 周 / 月窗口聚合
      ├── services/band-chao.js 计算扣分 / 达标
      └── 输出看板 + 明细 + copyText + Excel 数据
```

口径：

- 看板与班超**同一窗口、同一份分数**；
- 扣分来源 `targets` 的中文映射唯一，Σ 与模块日均严格对平；
- 导出取与看板同源的聚合结果，不重算。

### 5.6 北斗铜版经济

```
GET /api/beidou/today          → 余额 / 转盘 / 九宫格 / 任务 / 签到 / 封顶 / 记录
POST /api/beidou/draw          → 转盘（{drawId} 幂等，扣铜版）
POST /api/beidou/grid/play     → 九宫格（{playId} 幂等，扣铜版）
POST /api/beidou/video/report  → 看视频 +铜版（{watchId} 幂等）
POST /api/beidou/checkin       → 签到 +铜版
POST /api/beidou/share/intent  → 预生成 / 复用分享令牌
POST /api/beidou/share/click   → 好友点击上报，成功才给分享者发铜版
```

硬约束：

- **结果只由服务端定**：客户端只提交幂等 id，不提交奖品；
- `(openid, idemKey)` / `(openid, drawId)` / `(openid, playId)` 唯一索引保幂等；
- 每日游戏铜版上限、步数上限、分享上限是成本闸门；
- 旧 API / 旧字段全部保留，前端按新字段渐进。

### 5.7 导出

```
管理端点击导出
  → GET /api/admin/class/:className/export?...（或班超报表接口）
  → services/class-report-export.js / class-status-export.js
  → ExcelJS 生成 xlsx（样式、合并、列宽、口径说明）
  → 返回 buffer / 下载 URL
  → 小程序 downloadFile → 用户目录 → openDocument → 失败降级分享
```

导出**不重算**：取看板 / 筛选同源结果；导出前先预览（避免 CSV 在微信打不开）。

### 5.8 Web 控制台

```
GET /console                 登录页（静态 HTML，无业务数据）
POST /console/api/login      账号密码 → 检查 anticheat.* 权限 → 非初始密码
  → 内存会话 + HttpOnly + SameSite=Strict Cookie
GET /console/api/dashboard   状态台
GET /console/api/anomalies   AI 训练台（列表 / 详情 / 同步历史 / GPS 轨迹）
POST /console/api/anomalies/:id/...  判定 / 封禁 / 归档
```

控制台失败计数单独记内存，**不写** `user.failedLogins`，避免浏览器狂试把学生小程序锁死。

---

## 6. 单点口径速查

| 口径 | 唯一实现 | 回归 |
|---|---|---|
| 楼名·房号 | `services/dorms.js::parseRoomLabel` + `utils/room-label.js` | `check-room-label` |
| 房间归属 | `services/dorms.js::roomLiveOwners` / `roomCurrentClass` | `verify-union-member-filter` |
| 组织归属 | `services/org-resolve.js` | `check-org-resolve` + `verify-org-scope` |
| 姓名搜索 | `services/name-search.js::keywordOr` | `check-name-search` + `verify-name-search` |
| 学籍年级 / 班级 | `services/roster.js` | `check-server-contract` |
| 检查分制 | `services/check-modules.js` + `score-scale` | `verify-class-status` |
| 班超 / 看板 | `services/band-chao.js` + `class-status-board.js` | `verify-class-status` |
| 复核判定 | `services/union-review.js` | `check-union-review` + `verify-union-review` |
| 导航 / 工作台 | `utils/nav-groups.js` | `check-nav-groups` |
| 玻璃 UI | `app.wxss` + `check-glass-ui` | `check-dark-mode` |
| 水印文案 / 版式 | `utils/watermark.js` | `check-watermark-camera` |
| 反作弊评分 | `services/anticheat*.js` | `check-anticheat-*` + `verify-console` |

原则：**同一口径只允许一个实现**。发现第二份时，先合并，再改行为。

---

## 7. 扩展指南

### 7.1 新增一个用户端页面

1. 在 `miniprogram/pages/` 建四件套（`.js/.json/.wxml/.wxss`）；
2. 在 `app.json` 的 `pages` 注册；
3. 业务页在 `onLoad` 加 `if (!getApp().requireLogin()) return;`；
4. 页面根节点加 `.tt-page-tab`（tab 页）并按需接 `behaviors/screen`；
5. 入口加到 `utils/nav-groups.js`，同步改 `check-nav-groups` 的期望矩阵；
6. 跑 `check-miniprogram` / `check-page-data-keys` / `check-css-vars`。

> 主包已接近 2MB：管理端 / 学生会页面一律进分包。

### 7.2 新增一个接口

1. `models/` 加模型（显式集合名 + 索引）；
2. `services/` 写业务（唯一实现，接收普通参数）；
3. `routes/` 只做鉴权、取参、调用、返回；
4. 管理端接口挂到 `routes/admin/index.js` 并加 `requirePermission`；
5. 在 `docs/api.md` 补接口；
6. 加静态契约断言 / 端到端验证。

### 7.3 新增一个权限

1. `models/permission.js::DEFAULT_CATALOG` 加权限项；
2. `services/rbac.js` 的播种 / 蕴含关系按需补；
3. 路由挂 `requirePermission('xxx')`；
4. 前端页面用 `admin-perm.js::applyManage` 算 `canManage`；
5. 回归 `check-write-guard` / `check-admin-nav-coverage`。

### 7.4 新增一个检查器

`tools/` 下只放可重复运行的东西：

- `check-*`：静态检查，不需要数据库；
- `verify-*`：端到端，自建临时数据并清理；
- `gen-*` / `make-*`：生成器；
- 一次性脚本：`_tmp-*` / `_probe*`，跑完即删。

检查器要**输出可定位的失败信息**（文件 + 行号 + 期望 / 实际），并在文件头写清「守的是什么事故」。

---

## 8. 发布与版本流程

### 8.1 版本号

三处必须一致：

1. `server/package.json` 的 `version`；
2. `README.md` 顶部「当前版本」与徽章；
3. `miniprogram/pages/about/about.js` 的 `version`。

`server/src/app.js` 的 `/health` 与状态页直接读 `package.json`，不要在前端另写一份。

### 8.2 发布前检查

```bash
# 1. 静态检查全绿
Get-ChildItem tools -Filter 'check-*.js' | ForEach-Object { node $_.FullName }

# 2. 关键端到端（需要测试库，勿对生产库执行）
node tools/verify-identity-e2e.js
node tools/verify-class-status.js
node tools/verify-class-export.js
node tools/verify-union-review.js
node tools/verify-beidou-lottery.js

# 3. 打包（产物留在本机 dist/，不入库）
node tools/make-linux-bundle.js
```

### 8.3 打标签 / 发布

```bash
git add -A
git commit -m "chore(release): v2.0.13"
git push origin main
git tag -a v2.0.13 -m "v2.0.13"
git push origin v2.0.13
```

GitHub Release 正文至少包含：

- 版本号与日期；
- 主要能力 / 修复；
- 升级注意事项（环境变量、迁移脚本、破坏性变更）；
- **不附**含真实域名 / `.env` / 数据库连接串的产物。

### 8.4 部署包安全

`tools/make-linux-bundle.js` 已做：

- 排除 `server/.env`、`node_modules`、`uploads`、`tmp`、调试脚本；
- 扫描 `JWT_SECRET` / `WX_APPSECRET` / 真实 MongoDB 连接串；
- `.sh` 带可执行位、文本转 LF。

但 `deploy/nginx/*.conf` 与 `deploy/DEPLOY.md` 含真实域名，**不要**把它们放进公开 Release。
公开 Release 只放 GitHub 自动生成的源码归档即可。

---

## 9. 质量门禁

发布前必须满足：

- `check-miniprogram`：主包 / 各分包体积、语法、引用、登录闸门；
- `check-server-contract`：业务唯一实现、权限契约、分数口径；
- `check-write-guard`：管理端写入口权限守卫；
- `check-nav-groups` / `check-glass-ui` / `check-dark-mode`：导航与 UI 契约；
- 关键 `verify-*`：身份、班级状态、导出、复核、北斗。

检查失败时**先修代码，不要放宽断言**；确需调整口径时，同时改实现、文档与检查器，
并在 `AGENTS.md` 写清事故背景与回归方式。

---

## 10. 文档索引

| 文档 | 用途 |
|---|---|
| [README.md](../README.md) | 产品介绍、快速开始、发布、部署 |
| [AGENTS.md](../AGENTS.md) | 开发硬约束与历史事故复盘 |
| [database-v2.md](database-v2.md) | 集合、索引、字段口径 |
| [api.md](api.md) | 接口清单与请求 / 响应 |
| [ui-design.md](ui-design.md) | 设计令牌、玻璃拟态、三端规范 |
| [migration.md](migration.md) | 1.0 → 2.0 迁移 |
| [edgeone-traffic.md](edgeone-traffic.md) | EO / CDN 缓存与流量 |
| [watermark-camera-plan.md](watermark-camera-plan.md) | 水印相机口径 |
| [watermark-camera-round2-plan.md](watermark-camera-round2-plan.md) | 成片体积 / 横屏 UI |
| [student-union-plan.md](student-union-plan.md) | 班超 / 学生会方案 |
| [beidou-economy-plan.md](beidou-economy-plan.md) | 北斗 3.0 铜版经济 |
| [beidou-lottery-plan.md](beidou-lottery-plan.md) | 北斗 2.0 历史方案 |
| [beidou-lottery-ui-plan.md](beidou-lottery-ui-plan.md) | 抽奖页 UI |
| [class-org-scope-diagnosis.md](class-org-scope-diagnosis.md) | 班级归属诊断 |
| [round2-tasks.md](round2-tasks.md) | 第二轮任务书 |
| [union-ui-b-round.md](union-ui-b-round.md) | 学生会 B 端化任务书 |
