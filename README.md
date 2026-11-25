# 唐唐快跑 · 校园跑小程序 2.0

> 面向高校师生的校园运动记录与班级管理平台：微信小程序（用户端 + 管理端同包）+ Node.js 后端 + MongoDB。
> **当前版本：v2.0.13** · [GitHub Release](https://github.com/TBDengTa/campus-run/releases/tag/v2.0.13)

<p>
  <img alt="platform" src="https://img.shields.io/badge/platform-WeChat%20MiniProgram-07C160">
  <img alt="backend" src="https://img.shields.io/badge/backend-Node.js%20%7C%20Express-339933">
  <img alt="database" src="https://img.shields.io/badge/database-MongoDB-47A248">
  <img alt="ui" src="https://img.shields.io/badge/UI-TDesign-0052D9">
  <img alt="version" src="https://img.shields.io/badge/version-2.0.13-FF6B00">
  <img alt="release" src="https://img.shields.io/github/v/release/TBDengTa/campus-run?label=release&color=FF6B00">
  <img alt="license" src="https://img.shields.io/github/license/TBDengTa/campus-run">
</p>

---

## 目录

- [开源与发布](#开源与发布)
- [项目简介](#项目简介)
- [核心能力](#核心能力)
- [技术架构](#技术架构)
- [内部文件架构](#内部文件架构)
- [快速开始](#快速开始)
- [权限模型](#权限模型)
- [关键数据口径](#关键数据口径)
- [部署清单](#部署清单上线前)
- [质量保障](#质量保障)
- [安全约定](#安全约定)
- [文档地图](#文档地图)
- [版本记录](#版本记录)
- [许可](#许可)

---

## 开源与发布

本项目已在 GitHub 开源：**<https://github.com/TBDengTa/campus-run>**

- 欢迎 Star、提交 Issue 与 Pull Request；
- 学校 / 团队可基于本项目自行部署与二次开发，部署步骤见 [部署清单](#部署清单上线前)；
- 小程序内「我的 → 关于我们」也提供了仓库地址（点击复制）；
- **发布记录**：<https://github.com/TBDengTa/campus-run/releases>

> **v2.0.13 是仓库的首个正式 GitHub Release**。发布内容以源码归档为主，
> **不附带**任何包含真实域名、`.env`、数据库连接串的部署产物。
> 需要 Linux 部署包时请在自己的机器上执行 `node tools/make-linux-bundle.js` 现场生成，
> 且**不要**把带 `--mongo-uri=` 预设连接串的产物上传到公开仓库。

**版本号唯一口径**：`server/package.json`、`README.md`、`miniprogram/pages/about/about.js`
三处必须一致；`/health` 的 `version` 直接读 `server/package.json`，不要在前端另写一份。

> 仓库**不包含**任何真实凭据与域名：`server/.env`、`miniprogram/config/env.js`、
> `deploy/` 均已加入 `.gitignore`。克隆后请按 `.env.example` / `env.example.js` 自行填写，
> 切勿提交真实密钥或服务器地址。

---

## 项目简介

**唐唐快跑**围绕「记录 — 达标 — 激励 — 管理」闭环设计：

- **记录**：微信运动步数同步 + GPS 实跑轨迹，双数据源入库；
- **达标**：全局默认目标与按 BMI / 性别 / 强度偏好自动匹配的个人计划；
- **激励**：跑分体系 + 成就徽章 + 班级评比（班超）+ 北斗运动（铜版经济 / 转盘 / 九宫格）；
- **管理**：管理端内置于同一个小程序，覆盖用户、组织、班级、学生会、申诉、内容、广告与系统配置。

系统面向四类使用者：

| 角色 | 典型诉求 | 系统提供 |
|---|---|---|
| **学生** | 日常运动打卡、看排名、拿徽章 | 步数同步、GPS 实跑、目标计划、排行榜、徽章、北斗运动 |
| **教师 / 班主任** | 盯本班学生、审申诉、做学生工作 | 班级台帐、班主任管本班、申诉审核、按权限组授权 |
| **学生会** | 检查录入、查宿、复核、成员管理 | 检查录入台、水印相机、复审台、名单、统计、扫码加人 |
| **管理员** | 全校数据、名单、内容与运营 | 数据看板、用户 / 组织 / 班级管理、广告与内容、Web 控制台 |

> **教师账号不参与运动记录与排名**：步数同步、GPS 实跑、激励视频加步数在服务端三层拦截，
> 避免教师数据污染榜单。教师「我的」页也不显示隐私设置与我的申诉（不参与排名、无申诉链路）。

---

## 核心能力

### 学生端

| 模块 | 说明 |
|---|---|
| 微信运动同步 | WeRun 加密数据解密入库，每日 / 每周目标与分时段进度 |
| GPS 实跑 | 地图轨迹、距离 / 配速 / 卡路里，路线留痕，支持后台定位 |
| 运动记录 | 周统计 + 月历打卡点标 + 节假日标记 + 当日 / 本月列表 |
| 排行榜 | 今日 / 本周 / 总榜 × 全校 / 本院系 / 本班，支持按跑分排序 |
| 目标计划 | BMI 身体数据 → 自动匹配计划；亦可自选 |
| 成就徽章 | 累计 / 单日 / 连续等 7 类条件，支持等级组 |
| 北斗运动 3.0 | 签到、看视频、好友分享得铜版；转盘 / 九宫格消耗铜版；服务端定价、幂等与保底 |
| 其他 | 喝水打卡、激励视频赚步数、封禁申诉、公告 / 版本日志、校内身份绑定 |

### 教师 / 班主任

| 模块 | 说明 |
|---|---|
| 我的班级 | 本班概况、名单、排名、考勤、班超联赛、班级配置 |
| 班级状态 | 全校班级状态总览：考勤 + 校园跑达标 + 班超分，支持日 / 周 / 月窗口 |
| 班主任能力 | 编辑本班学生资料、重置密码、发徽章、限制同步 / GPS、排宿舍（无需管理权限） |
| 申诉审核 | 权限组控制，通过即解封并留流水 |

### 学生会

| 模块 | 说明 |
|---|---|
| 检查录入台 | 卫生 / 晚自习 / 查宿 / 早操 / 早八，按模块字段与受检对象动态渲染 |
| 水印相机 | 拍照瞬间把「模块 · 对象 / 时间 / 部门 · 检查人」烙进照片文件 |
| 复审台 | 分数分档、检查人 / 摘要 / 图片、单条复核与批量审核 |
| 名单与统计 | 检查记录、缺勤名单、照片隐私裁剪、部门范围统计 |
| 成员与配置 | 成员管理、部门与职责模块、扫码加人（主席团 / 部长） |

### 管理端（小程序内分包，按权限渲染）

| 模块 | 说明 |
|---|---|
| 数据看板 | 用户 / 活跃 / 步数 / 广告 PV 趋势 |
| 用户管理 | 搜索、多维筛选（院校 → 系部 → 专业联动）、批量操作、重置密码、封禁 / 解封、宿舍分配 |
| 组织架构 | 学校 → 院系 → 专业三级树，账号学籍随之推导 |
| 班级台帐 | 班级名录、早操 / 早八 / 晚自习 / 校园跑开关、教室、卫生区、查宿 |
| 学生会 | 成员管理、部门与职责模块配置、检查记录复核 |
| 考核与目标 | 默认目标、计划目标、跑分设置、反作弊 |
| 申诉审核 | 申诉列表与复核（通过即解封） |
| 内容与通知 | 公告、节假日、徽章定义、版本日志 |
| 广告运营 | 赞助商 / 广告位 / 素材 / H5 落地页托管 / PV·点击统计 |
| 系统设置 | 楼名管理、文件管理、示例账户、北斗运动（铜版经济 / 转盘 / 九宫格） |

### 平台能力

- **反作弊**：步数暴增、配速异常、涨幅速度、GPS 轨迹特征；人工标注 → 模型训练 → 阶段性自升级；
- **唐跑 AI**：Isolation Forest 无监督 + 有监督逻辑回归，影子阶段分数封顶、不会单独封号；
- **Web 控制台**：`/console` 状态台与 AI 训练台，账号密码 + HttpOnly Cookie 会话，与小程序 JWT 完全隔离；
- **玻璃拟态 UI**：`--tt-glass-*` 令牌单一来源，亮 / 暗双套，`@supports not` 实底降级；
- **三端响应式**：手机单列 / iPad 双栏 / Mac·PC 三栏，断点唯一实现 `utils/screen.js`；
- **导出**：班级考勤 / 班超报表 Excel（ExcelJS 样式），小程序内预览、下载、打开与降级分享；
- **缓存防护**：`/api/*` 全局 `no-store`、`/health` `no-store`、`/uploads` `immutable`，gzip 只在 Nginx。

---

## 技术架构

```
┌──────────────────────────────────┐         ┌──────────────────────────────────┐
│ 微信小程序（原生 + TDesign）        │  HTTPS  │ Nginx（TLS / gzip / 静态 / 反代） │
│  ┌────────────┬────────────────┐ │ ──────► │              │                   │
│  │ 主包        │ packageAdmin   │ │         │              ▼                   │
│  │ 用户端 27 页 │ 管理端 33 页    │ │         │  Node.js + Express（:3010）       │
│  ├────────────┼────────────────┤ │         │  routes/（鉴权与取参）            │
│  │ packageUnion│ custom-tab-bar│ │         │  services/（业务唯一实现）         │
│  │ 学生会 7 页  │ 按角色变化      │ │         │  models/（MongoDB / Mongoose）    │
│  └────────────┴────────────────┘ │         │  public/console（Web 控制台）     │
└──────────────────────────────────┘         └──────────────────────────────────┘
```

**技术选型**

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | 微信小程序原生框架 + TDesign | 不引入重型框架，保持包体与启动速度；管理端 / 学生会走分包 |
| 后端 | Node.js + Express | 分层：`routes/`（鉴权与取参）→ `services/`（业务唯一实现）→ `models/` |
| 数据库 | MongoDB + Mongoose | 模型显式指定集合名；大集合建索引；时间用 BSON Date |
| 鉴权 | JWT + 权限项 / 权限组 | 服务端 `requirePermission` 强校验，前端只控显隐 |
| Web 控制台 | 原生 HTML/CSS/JS | 无构建链，严格 CSP，Cookie 会话与小程序 JWT 隔离 |
| 部署 | Nginx + systemd + HTTPS | 反向代理、静态上传目录、开机自启、优雅退出 |

**请求生命周期（小程序）**

```
页面 onLoad/onShow
  → utils/request.js（统一 BASE_URL、token、超时、401 自愈、封禁识别）
  → GET/POST /api/*
  → Express：/api no-store → auth（JWT + openid 一致性 + 封禁白名单）
  → routes/*（只做鉴权、取参、响应）
  → services/*（业务判定与写入唯一实现）
  → models/*（显式集合名 + 索引）
```

**设计要点**

- **业务唯一实现**：同一业务（重置密码、删除账户、宿舍分配、徽章发放、检查复核、分数计算）
  只允许有一个 service 实现，管理端与班级域 / 学生会域共用；
- **参考数据与维护权限分离**：填表要用的只读数据（楼名、组织架构）走独立只读接口，
  不要求调用方持有「维护全校配置」的权限；
- **前端只控显隐、服务端才是闸门**：每个写入口都有对应的 `requirePermission` 或成员资格校验；
  能力边界由服务端下发的 `capabilities` 决定前端画哪些按钮；
- **判定 ≠ 处置**：反作弊的「标注 / 训练」与「封禁 / 归档」是两条正交线，UI 与接口都分组表达。

更细的分层、模块地图与扩展指南见 **[docs/architecture.md](docs/architecture.md)**。

---

## 内部文件架构

```
.
├── project.config.json            # 微信开发者工具配置（miniprogramRoot → miniprogram/）
├── README.md                      # 本文件：产品 / 架构 / 启动 / 发布 / 质量
├── AGENTS.md                      # 仓库开发约定（权限、学籍、跑分、登录态等硬约束）
├── LICENSE
│
├── miniprogram/                   # 小程序前端（主包 + 2 个分包，共 67 页）
│   ├── app.js / app.json / app.wxss
│   ├── pages/                     # 用户端主包 27 页
│   ├── packageAdmin/              # 管理端分包 33 页（按权限渲染）
│   ├── packageUnion/              # 学生会分包 7 页（录入 / 水印相机 / 复核 / 名单）
│   ├── components/                # 8 个公共组件（考勤、宿舍、人员选择、广告等）
│   ├── behaviors/                 # screen（三端断点）/ skyline（渲染引擎适配）
│   ├── custom-tab-bar/            # 自定义玻璃悬浮 tabBar（按角色变化）
│   ├── utils/                     # request / nav-groups / screen / watermark / format 等 15 个
│   ├── assets/                    # 图标与首页图（控制在 200KB 级）
│   ├── config/env.example.js      # 环境配置模板（复制为 env.js，不入库）
│   └── miniprogram_npm/           # 已构建的 tdesign-miniprogram
│
├── server/                        # Node.js 后端
│   ├── src/
│   │   ├── app.js                 # createApp：中间件、静态、/api 挂载、错误处理
│   │   ├── index.js               # 启动：连库、bootstrap 播种 / 迁移、listen、优雅退出
│   │   ├── config/                # 环境变量读取与默认值
│   │   ├── middlewares/           # auth（JWT）/ admin（权限）/ error
│   │   ├── routes/                # 18 个用户端 / 班级域 / 学生会域路由
│   │   ├── routes/admin/          # 16 个管理端路由（各自 requirePermission）
│   │   ├── services/              # 48 个业务服务（唯一实现）
│   │   ├── models/                # 47 个 Mongoose 模型（显式集合名）
│   │   └── utils/                 # 响应、上传、日期等通用工具
│   ├── public/console/            # Web 控制台静态页（无构建链）
│   ├── public/beidou/             # 北斗内置图案（铜币 / 皇冠 / 星星）
│   ├── scripts/                   # 11 个迁移 / 回填 / 引导脚本（默认 dry-run）
│   ├── .env.example               # 环境变量模板（真实 .env 不入库）
│   └── uploads/                   # 运行时上传文件（不入库）
│
├── docs/                          # 设计 / 数据库 / API / 部署 / 事故复盘
├── tools/                         # 41 个 check-* + 19 个 verify-* + 生成器
├── deploy/                        # 本机部署脚本与站点配置（含真实域名，已忽略）
└── dist/                          # 本机打包产物（已忽略）
```

**高频改动位置**

| 需求 | 先看这里 | 说明 |
|---|---|---|
| 加一个页面 | `miniprogram/app.json` + `pages/` 或分包目录 | 主包已接近 2MB，新管理 / 学生会页面优先放分包 |
| 加一个接口 | `server/src/routes/` → `services/` → `models/` | 路由只鉴权取参，业务写进 service |
| 加一个权限 | `models/permission.js::DEFAULT_CATALOG` + `routes/admin/index.js` | 先加权限项，再挂路由，最后加前端 `canManage` |
| 改导航 / 工作台 | `miniprogram/utils/nav-groups.js` | 唯一数据源，首页与工作台共用，不要各写一份 |
| 改楼名 / 房号 | `server/src/services/dorms.js` + `miniprogram/utils/room-label.js` | 两端口径必须逐条一致 |
| 改姓名搜索 | `server/src/services/name-search.js` | 7 个入口共用，禁止自拼姓名正则 |
| 改组织归属 | `server/src/services/org-resolve.js` | id 优先、名字兜底、歧义 fail-closed |
| 改班级状态 / 班超 | `services/class-status-board.js` / `band-chao.js` | 看板与班超必须同源 |
| 改北斗经济 | `services/beidou*.js` + `docs/beidou-economy-plan.md` | 定价、幂等、保底、流水都在服务端 |
| 改反作弊 | `services/anticheat*.js` + `docs/edgeone-traffic.md` | 判定 ≠ 处置；自动处置有总开关 |
| 加水印相机能力 | `miniprogram/utils/watermark.js` + `packageUnion/wcamera` | 文案与版式单点，照片合成在客户端 |

---

## 快速开始

### 环境要求

| 依赖 | 版本 |
|---|---|
| Node.js | ≥ 18 |
| MongoDB | ≥ 5.0 |
| 微信开发者工具 | 最新稳定版 |
| 小程序基础库 | ≥ 2.30.0（自定义 tabBar + TDesign 3.x） |

### 后端

```bash
cd server
cp .env.example .env        # 填写 MONGO_URI / JWT_SECRET / WX_APPID / WX_APPSECRET
npm install
npm run dev                 # node --watch，默认 :3010
```

必需环境变量：

```ini
PORT=3010
HOST=127.0.0.1
MONGO_URI=mongodb://127.0.0.1:27017
MONGO_DB_NAME=campus_run
JWT_SECRET=<openssl rand -hex 48>
WX_APPID=<小程序 appid>
WX_APPSECRET=<小程序 secret，云托管/Docker 必填>
```

> `DEV_LOGIN=true` 可开启本地测试登录（`dev-student` / `dev-teacher` / `dev-admin`），**生产环境必须关闭**。
> 首次启动会自动播种权限目录、内置权限组、广告位、徽章、检查模块与全局配置（全部幂等）。

### 小程序

1. 微信开发者工具打开仓库根目录；
2. 复制 `miniprogram/config/env.example.js` 为 `env.js`，填入后端地址；
3. 本地无 AppSecret 时：`env.js` 置 `DEV_LOGIN: true`，用 `DEV_ROLE` 切换三种测试角色（后端需同样开启）；
4. 详情 → 本地设置 → 勾选「不校验合法域名」（仅开发阶段）；
5. 编译运行。

### 提交前自检

```bash
# 全部静态检查（不需要数据库）
node tools/check-miniprogram.js
node tools/check-server-contract.js
node tools/check-nav-groups.js
node tools/check-glass-ui.js

# 或一次跑完（PowerShell）
Get-ChildItem tools -Filter 'check-*.js' | ForEach-Object { node $_.FullName }

# 端到端验证（需要可连数据库；脚本自建临时数据并清理，勿对生产库执行）
node tools/verify-identity-e2e.js
node tools/verify-teacher-rebind.js
node tools/verify-class-status.js
```

### 常见问题

| 现象 | 先检查 |
|---|---|
| 启动报 `requires authentication` | `MONGO_URI` 是否带账号密码 / `authSource` 是否正确 |
| 启动报 `ECONNREFUSED` | mongod 是否启动、端口 / 云库白名单 |
| 小程序请求全失败 | `miniprogram/config/env.js` 是否存在、`BASE_URL` 是否正确、合法域名 |
| 上传 / 图片 502 | Nginx `client_max_body_size`、`/uploads` alias 路径 |
| 线上改了没生效 | `/health` 的 `build` / `version`、控制台静态资源 `?v=`、EO 是否遵循源站缓存 |
| 主包超 2MB | 新页面是否误放主包；`node tools/check-miniprogram.js` 会分别报主包 / 分包 |

---

## 权限模型

**角色只有两种：学生 / 教师。「管理员」是权限组合，不是独立角色。**

- **权限项（permission）**：细粒度能力，如 `user.view` / `user.manage` / `content.manage` / `config.manage`；
- **权限组（permission group）**：一组权限的命名集合，可整体授予用户；内置「超级管理员组」（`*` 全部权限）与「教师管理组」；
- **有效权限** = 用户直接持有的权限 ∪ 所在权限组展开的权限；`*` 为通配。

四条落地规则：

1. **管理端路由一律 `requirePermission` 挂载**，禁止只靠前端隐藏；
2. **新增能力先加权限项**（`Permission.DEFAULT_CATALOG`，启动自动播种）再挂路由；
3. **内置权限组可编辑但不可删**，改过的组写入 `customized` 标记，重启不再被默认值覆盖
   （否则改完当下生效、下次重启被静默抹掉）；「超级管理员组」例外——恒只读，避免锁死系统；
4. **只读账号不显示写入口**：每个页面用统一工具算出 `canManage`，写按钮一律按它渲染；
   服务端仍会二次校验，前端只是体验。

此外有三条**非权限项**的授权来源：

- **班主任**：`user.homeroomClasses` 命中目标班级即获得「管本班学生」的能力
  （编辑资料 / 重置密码 / 发徽章 / 限制同步·GPS / 排宿舍），**无需任何管理权限**；
  「能做什么」由服务端 `capabilities` 下发，前端照此渲染。删除账户属校级处置，默认不开放。
- **班委**：`user.isClassOfficer`，只读本班数据。
- **学生会**：成员资格 + 部门归属 + 院系范围三重校验，写操作另有模块级 `union.manage`。

两类班级身份都通过**成员资格校验**（而非 `requirePermission`）在 `/api/class/*` 生效。

---

## 关键数据口径

以下口径在服务端与前端都有严格实现，改之前先读 `AGENTS.md` 对应章节：

| 口径 | 唯一实现 | 要点 |
|---|---|---|
| 年级 | `services/roster.js::gradeFromStudentId()` | 学号前 4 位（1900~2099），展示为「2023级」 |
| 班级名 | `services/roster.js::classNameFromGradeSpecialty()` | 年级后两位 + 专业；更细班名保留班序号 |
| 组织归属 | `services/org-resolve.js` | 有 `departmentId` 只认 id；名字兜底要求唯一命中，歧义 fail-closed |
| 楼名·房号 | `services/dorms.js::parseRoomLabel` + `utils/room-label.js` | 白名单楼名最长前缀优先，房号归一且幂等 |
| 房间归属 | `services/dorms.js::roomLiveOwners()` | 按在住名单实时推导，不用建房间时的快照 |
| 姓名搜索 | `services/name-search.js::keywordOr` | ≥2 汉字才启用同音 / 错音，7 个入口共用 |
| 检查分制 | `services/check-modules.js` + `score-scale.js` | 10 分制；历史百分制由迁移换算 |
| 班超 / 班级状态 | `services/band-chao.js` / `class-status-board.js` | 同一窗口、同一份分数、同一扣分明细 |
| 反作弊涨幅 | `steps.js` + `check-sync-rate` | 间隔 < 180s 不判；分数封顶低于自动封禁线 |
| 时间 / 日期 | `utils/format.js` / 服务端 BSON Date | 展示北京时区；日历键 `YYYY-MM-DD` 字符串 |

数据库集合命名、索引与字段说明见 [docs/database-v2.md](docs/database-v2.md)。

---

## 部署清单（上线前）

| 事项 | 说明 |
|---|---|
| HTTPS 域名 | 后端部署到合法域名下，在小程序后台配置 **request 合法域名** |
| 业务域名 | 广告落地页（`/p/:slug`）所在域名需加入 **业务域名**（web-view 使用） |
| 图标字体 | TDesign 图标走 CDN（tdesign.gtimg.com），需加入 **downloadFile 合法域名** |
| 微信 AppSecret | 后端 `.env` 的 `WX_APPSECRET`（code2session / WeRun 解密必需） |
| 微信运动 | 小程序需具备「微信运动」类目权限 |
| 流量主 | 激励视频广告位 ID 在 `miniprogram/pages/reward/reward.js` 中替换 |
| 管理员 | ① `.env` 的 `ADMIN_BOOTSTRAP_OPENIDS`（登录自动授予超管）；② `npm run admin:add -- <openid>`；③ 管理端「用户详情 → 权限管理」勾选 |
| JWT_SECRET | 务必随机长字符串（`openssl rand -hex 48`） |
| DEV_LOGIN | 确认 `server/.env` 与 `miniprogram/config/env.js` **两处均为 false** |
| 版本号 | `server/package.json` / `README.md` / `miniprogram/pages/about/about.js` 三处一致 |
| 缓存 | EO / CDN 控制台必须选「遵循源站」；`/api/*`、`/health` 不可缓存 |
| 部署包 | `node tools/make-linux-bundle.js`（不加 `--mongo-uri=`），产物留在本机 `dist/` |
| 备份 | 跑数据修复脚本前会默认 dry-run；`--apply` 前先备份，脚本写库前自动落 `_backup/` |

> **发布安全红线**：`deploy/` 含真实域名与站点配置，`dist/` 可能含预设数据库连接串，
> 二者都已忽略，**绝不能**作为 GitHub Release 资产上传。公开 Release 只放源码归档。

---

## 质量保障

仓库内置 **41 个静态检查器 + 19 个端到端验证脚本**，覆盖历史踩过的坑（每一条都对应一次真实事故）。
检查器的价值是**能静态查出来的就别靠人工 review**：

| 检查器 | 守住的规则 |
|---|---|
| `check-miniprogram` | WXML / WXSS / JS 语法、事件绑定、图标、class、页面四件套、主包 / 分包体积 |
| `check-server-contract` | 业务唯一实现、429/权限契约、分数与扣分口径、参考数据与维护路径分离 |
| `check-write-guard` | 管理端写操作入口必须有权限守卫（标签栈解析，不靠缩进猜祖先） |
| `check-nav-groups` | 各角色导航矩阵、tabBar 工作台单槽、入口按真实能力判定 |
| `check-glass-ui` | 玻璃令牌单一来源、blur 规格、降级链、宽屏禁 rpx、tabBar 挂载契约 |
| `check-dark-mode` | 暗色令牌覆盖、tabBar 令牌驱动、挂载契约断言 |
| `check-room-label` | 楼名 / 房号两端逐条一致、连字符楼名不被切开、污染房号幂等 |
| `check-org-resolve` | 组织归属单一实现、id 优先、facets 计数守恒 |
| `check-name-search` | 同音 / 错音口径、≥2 汉字、搜索并发与防抖 |
| `check-union-review` | 分档边界、单一实现、队列范围、裁剪、前端接线 |
| `check-watermark-camera` | 乐观预览、降档重试、两档失败保留原图、双入口接线 |
| `check-traffic-headers` | `/api` no-store、`/health` no-store、`/uploads` immutable、gzip 只在 Nginx |
| `check-anticheat-*` | 自动处置总开关、封禁来源分类、阶段性自升级闸门与降级 |
| `check-beidou-*` / `check-banchao-report` | 铜版经济、九宫格连线、返奖率、报表聚合与导出 |

端到端脚本会真实连接数据库、自建临时数据并在结束时清理；**不要对生产库执行**。
完整列表与运行方式：

```bash
# 静态检查
Get-ChildItem tools -Filter 'check-*.js' | ForEach-Object { node $_.FullName }

# 端到端（示例）
node tools/verify-console.js
node tools/verify-class-status.js
node tools/verify-class-export.js
node tools/verify-union-review.js
node tools/verify-anticheat-upgrade.js
node tools/verify-beidou-lottery.js
```

---

## 安全约定

- 仓库**不含**服务器地址、数据库凭据、密钥：后端配置在 `server/.env`，前端在 `miniprogram/config/env.js`，
  `deploy/` 与 `dist/` 均已忽略；
- **凭据类字段绝不下发客户端**：`models/user.js::toSafeJSON()` 剔除 `passwordHash` / `initialHashes` /
  `resetHashes`，新增任何「用户文档 → 客户端」的出口都必须走它或显式白名单；
- 管理端权限在服务端二次校验（JWT + 权限项），前端隐藏入口只是第一道门；
- 小程序身份 = **当前 token 对应的账号**；JWT 与签发时的微信绑定强一致，解绑 / 换绑后旧令牌立即失效；
- 历史登录（一键登录）令牌随机 32 字节、只存 SHA-256、30 天有效、用后轮换；
- Web 控制台 Cookie 会话与小程序 JWT **完全隔离**，CSP 严格到 `script-src/style-src 'self'`，
  HTML 禁止内联 `style=` 与 `onclick`，客户端渲染一律 `textContent`；
- 检查照片按「检查人 / 主席团 / 所属部门部长 / 教师」裁剪，其余人**不下发原图 URL**；
- Release 资产只放源码归档，**不附**任何含真实域名、`.env`、数据库连接串的部署包。

---

## 文档地图

| 文档 | 内容 |
|---|---|
| **[docs/architecture.md](docs/architecture.md)** | **内部文件架构：分层、模块地图、数据流、扩展指南、发布流程** |
| [docs/database-v2.md](docs/database-v2.md) | 数据库 2.0 设计（集合、索引、字段口径） |
| [docs/api.md](docs/api.md) | 接口说明（用户端 / 班级域 / 学生会域 / 管理端） |
| [docs/ui-design.md](docs/ui-design.md) | 白橙设计系统、玻璃拟态与三端响应式规范 |
| [docs/migration.md](docs/migration.md) | 1.0 → 2.0 数据迁移指南 |
| [docs/edgeone-traffic.md](docs/edgeone-traffic.md) | EO / CDN 流量排查与缓存防护 |
| [docs/watermark-camera-plan.md](docs/watermark-camera-plan.md) | 水印相机口径与边界（D1~D10） |
| [docs/watermark-camera-round2-plan.md](docs/watermark-camera-round2-plan.md) | 成片体积预算与横屏 UI |
| [docs/student-union-plan.md](docs/student-union-plan.md) | 班超 + 学生会功能方案与验收 |
| [docs/beidou-economy-plan.md](docs/beidou-economy-plan.md) | 北斗运动 3.0：铜版经济 / 九宫格 / 好友点击归因 |
| [docs/beidou-lottery-plan.md](docs/beidou-lottery-plan.md) | 北斗运动 2.0（历史方案，冲突处以 3.0 为准） |
| [docs/beidou-lottery-ui-plan.md](docs/beidou-lottery-ui-plan.md) | 抽奖页紧凑化 / 播报 / 动效 / 音效 |
| [docs/class-org-scope-diagnosis.md](docs/class-org-scope-diagnosis.md) | 班级归属院系 / 院校筛选「暂无班级」诊断 |
| [docs/round2-tasks.md](docs/round2-tasks.md) | 班超 / 学生会第二轮改造任务书（决策记录） |
| [docs/union-ui-b-round.md](docs/union-ui-b-round.md) | 学生会页面 B 端化改造任务书 |
| [AGENTS.md](AGENTS.md) | 仓库开发约定（权限、学籍、跑分、登录态等硬约束） |

---

## 版本记录

| 版本 | 日期 | 内容 |
|---|---|---|
| **v2.0.13** | 2026-11-25 | **首个正式 GitHub Release**。汇总 2.0.7 以来的能力：北斗运动 3.0 铜版经济（签到 / 看视频 / 好友分享 / 转盘 / 九宫格 / 保底 / 流水，旧 API 全部保留）＋ 班级状态与班超同源（10 分制、日 / 周 / 月窗口、扣分明细、总标 / 每班明细 Excel 导出）＋ 班级报告与班超报表（服务端聚合 + 画布 / Excel）＋ 玻璃拟态导航与三端响应式（手机单列 / iPad 双栏 / PC 三栏）＋ 检查录入水印相机（成片体积闭环、横屏布局、乐观预览）＋ 唐跑 AI 阶段性自升级（影子辅助 / 主判、自动降级、手动锁定）＋ Web 控制台与反作弊独立权限组＋ 宿舍「楼名·房号」唯一解析与房间归属实时推导＋ 学生会成员筛选真进库＋ 缓存防护与上传限制解除。 |
| **v2.0.12** | 2026-11 | 我的班级 / 班级状态 UI 重构与导出：校园跑日期回看、班超紧凑排版、班级考勤按所选区间分组、扣分来源 targets、本周 / 本月考勤表 CSV。 |
| **v2.0.11** | 2026-11 | 班级状态与班超同源「一个窗口 + 一份分数」；检查记录筛选与卡片；解封后不再重复封禁；班级考勤「未显示记录」三层修复。 |
| **v2.0.9** | 2026-11 | 宿舍「楼名·房号」唯一解析口径；房间归属按在住名单实时推导；学生会成员列表真按筛选查库；样本量两口径；组织归属单点解析与水印相机。 |
| **v2.0.7** | 2026-11 | 唐跑 AI 阶段性自升级：三级阶梯、有监督逻辑回归、量化闸门、影子封顶、自动降级、手动锁定、两端同款阶梯卡片。 |
| **v2.0.6** | 2026-11 | 北斗运动 2.0（签到 + 转盘抽步数 + 看视频 / 分享得次数）；EO 缓存防护；暗色模式补全。 |
| **v2.0.5** | 2026-10 | 反作弊独立权限组与 Web 控制台；封禁来源分类；全校班级状态总览；「涨幅速度」误封修复。 |
| **v2.0.4** | 2026-10 | 唐跑 AI 数据模型：Isolation Forest、微信 / GPS 双模型、物理约束层、人工反馈；步数异常记录管理页。 |
| **v2.0.0** | 2026-10 | 全新重写：前后端分离、管理端内置小程序、白橙设计系统、自定义悬浮导航、班级域、班超、学生会、跑分体系、结构拆分、静态契约检查与端到端验证。 |

> 1.0 代码已遗失，2.0 基于旧 MongoDB 结构逆向重建并设计新表 + 一次性迁移方案，详见迁移文档。
> 更细的发布流程（版本号、检查、打标签、Release、部署包）见 [docs/architecture.md](docs/architecture.md#发布与版本流程)。

---

## 许可

[MIT License](LICENSE) © 2026 河北唐博科技有限公司

可自由使用、修改与分发（保留版权声明）。用于商业场景前请确认符合所在学校的数据与隐私规定。

---

<p align="center">
  由 <b>河北唐博科技有限公司</b> 设计与开发<br>
  <sub>校园运动记录与管理平台 · v2.0.13</sub>
</p>
