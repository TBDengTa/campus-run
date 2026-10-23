# 唐唐快跑 · 校园跑小程序 2.0

> 面向高校的校园运动记录与管理平台。微信小程序端（用户端 + 管理端同包）+ Node.js 后端。
> **当前版本：v2.0.0**

<p>
  <img alt="platform" src="https://img.shields.io/badge/platform-WeChat%20MiniProgram-07C160">
  <img alt="backend" src="https://img.shields.io/badge/backend-Node.js%20%7C%20Express-339933">
  <img alt="database" src="https://img.shields.io/badge/database-MongoDB-47A248">
  <img alt="ui" src="https://img.shields.io/badge/UI-TDesign-0052D9">
  <img alt="version" src="https://img.shields.io/badge/version-2.0.0-FF6B00">
</p>

---

## 目录

- [开源](#开源)
- [项目简介](#项目简介)
- [核心能力](#核心能力)
- [技术架构](#技术架构)
- [目录结构](#目录结构)
- [快速开始](#快速开始)
- [权限模型](#权限模型)
- [部署清单](#部署清单上线前)
- [质量保障](#质量保障)
- [安全约定](#安全约定)
- [文档](#文档)
- [版本记录](#版本记录)

---

## 开源

本项目已在 GitHub 开源：**<https://github.com/TBDengTa/campus-run>**

- 欢迎 Star、提交 Issue 与 Pull Request
- 学校 / 团队可基于本项目自行部署与二次开发，部署步骤见 [部署清单](#部署清单上线前)
- 小程序内「我的 → 关于我们」也提供了仓库地址（点击复制）

> 仓库**不包含**任何真实凭据与域名：`server/.env`、`miniprogram/config/env.js` 均已被忽略。
> 克隆后请按 `.env.example` / `env.example.js` 自行填写，切勿提交真实密钥。

---

## 项目简介

**唐唐快跑**是一个面向校园师生的运动健康小程序，围绕「记录 — 达标 — 激励 — 管理」闭环设计：

- **记录**：微信运动步数同步 + GPS 实跑轨迹，双数据源入库；
- **达标**：支持全局默认目标与按 BMI / 性别 / 强度偏好自动匹配的个人计划；
- **激励**：跑分体系 + 成就徽章 + 班级评比（班超），形成正向反馈；
- **管理**：管理端内置于同一个小程序，覆盖用户、院系架构、学生会、申诉、内容、广告与系统配置。

系统面向三类使用者：

| 角色 | 典型诉求 | 系统提供 |
|---|---|---|
| **学生** | 日常运动打卡、看排名、拿徽章 | 步数同步、GPS 实跑、目标计划、排行榜、徽章 |
| **教师** | 盯本班学生、审申诉、做学生工作 | 班级台帐、班主任管本班、申诉审核、权限按组授予 |
| **管理员** | 全校数据、名单、内容与运营 | 数据看板、用户/组织管理、广告与内容、系统配置 |

> **教师账号不参与运动记录与排名**：步数同步、GPS 实跑、激励视频加步数在服务端三层拦截，避免教师数据污染榜单。

---

## 核心能力

### 用户端

| 模块 | 说明 |
|---|---|
| 微信运动同步 | WeRun 加密数据解密入库，每日 / 每周目标与分时段进度 |
| GPS 实跑 | 地图轨迹、距离 / 配速 / 卡路里，路线留痕 |
| 运动记录 | 周统计 + 月历打卡点标 + 节假日标记 + 当日 / 本月列表 |
| 排行榜 | 今日 / 本周 / 总榜 × 全校 / 本院系 / 本班，支持按跑分排序 |
| 目标计划 | BMI 身体数据 → 自动匹配计划；亦可自选 |
| 成就徽章 | 累计 / 单日 / 连续等 7 类条件，支持等级组 |
| 学生会 | 检查录入工作台、部门归属、扫码加人（主席团 / 部长） |
| 班级（班超） | 班主任 / 班委查看本班概况、名单、排名与考勤 |
| 其他 | 喝水打卡、激励视频赚步数、封禁申诉、公告 / 版本日志 |

### 管理端（小程序内分包，按权限渲染）

| 模块 | 说明 |
|---|---|
| 数据看板 | 用户 / 活跃 / 步数 / 广告 PV 趋势 |
| 用户管理 | 搜索、多维筛选（院校→系部→专业联动）、批量操作、重置密码、封禁 / 解封、宿舍分配 |
| 组织架构 | 学校 → 院系 → 专业三级树，账号学籍随之推导 |
| 班级台帐 | 班级名录、早操 / 早八 / 晚自习 / 校园跑开关、教室、卫生区、查宿 |
| 学生会 | 成员管理、部门与职责模块配置、检查记录复核 |
| 考核与目标 | 默认目标、计划目标、跑分设置、反作弊 |
| 申诉审核 | 申诉列表与复核（通过即解封） |
| 内容与通知 | 公告、节假日、徽章定义、版本日志 |
| 广告运营 | 赞助商 / 广告位 / 素材 / H5 落地页托管 / PV·点击统计 |
| 系统设置 | 楼名管理、文件管理、北斗运动（激励视频规则） |

### 反作弊

步数暴增检测、配速异常检测；命中后按类型限制（登录 / 微信同步 / GPS）并留流水，支持申诉解封。

---

## 技术架构

```
┌─────────────────────────────┐        ┌──────────────────────────┐
│   微信小程序（原生 + TDesign）  │  HTTPS │  Node.js + Express 后端   │
│  ┌──────────┬─────────────┐  │ ─────► │  ┌─────────────────────┐ │
│  │ 用户端    │ 管理端分包    │  │  JWT   │  │ routes/  users/class │ │
│  │ pages/   │ packageAdmin│  │        │  │   admin/  union/...  │ │
│  └──────────┴─────────────┘  │        │  ├─────────────────────┤ │
│  自定义 tabBar（按角色变化）    │ ◄───── │  │ services/ 业务唯一实现 │ │
└─────────────────────────────┘        │  ├─────────────────────┤ │
                                        │  │ models/  MongoDB      │ │
                                        │  └─────────────────────┘ │
                                        └──────────────────────────┘
```

**技术选型**

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | 微信小程序原生框架 + TDesign | 不引入重型框架，保持包体与启动速度；管理端走分包 |
| 后端 | Node.js + Express | 分层：`routes/`（鉴权与取参）→ `services/`（业务唯一实现）→ `models/` |
| 数据库 | MongoDB + Mongoose | 模型显式指定集合名；大集合建索引 |
| 鉴权 | JWT + 权限项 / 权限组 | 服务端 `requirePermission` 强校验，前端只控显隐 |
| 部署 | Nginx + systemd + HTTPS | 反向代理、静态上传目录、开机自启 |

**设计要点**

- **业务唯一实现**：同一业务（重置密码、删除账户、宿舍分配、徽章发放）只允许有一个 service 实现，
  管理端与班级域共用，杜绝「单条会、批量不会」这类分裂。
- **参考数据与维护权限分离**：填表要用的只读数据（楼名、组织架构）走独立只读接口，
  不要求调用方持有「维护全校配置」的权限。
- **前端只控显隐、服务端才是闸门**：每个写入口都有对应的 `requirePermission` 或成员资格校验；
  能力边界由服务端下发的 `capabilities` 决定前端画哪些按钮。

---

## 目录结构

```
├── project.config.json          # 微信开发者工具配置（miniprogramRoot → miniprogram/）
├── miniprogram/                 # 小程序前端
│   ├── pages/                   # 用户端页面（27 页）
│   ├── packageAdmin/            # 管理端分包（30 页）
│   ├── packageUnion/            # 学生会分包（6 页）
│   ├── components/              # 公共组件（抽屉 / 卡片 / 选择器）
│   ├── behaviors/               # 共享 behavior（导航浮层等）
│   ├── custom-tab-bar/          # 自定义底部导航（按角色变化）
│   ├── utils/                   # 请求封装、权限、格式化、业务小工具
│   ├── config/env.example.js    # 环境配置模板（复制为 env.js，不入库）
│   └── miniprogram_npm/         # 已构建的 tdesign-miniprogram
├── server/                      # Node.js 后端
│   ├── src/routes/              # 用户端路由（16）+ 管理端路由 admin/（14）
│   ├── src/services/            # 业务服务（23）
│   ├── src/models/              # Mongoose 模型
│   ├── src/middlewares/         # 鉴权 / 权限中间件
│   ├── scripts/                 # 数据迁移、管理员引导
│   └── .env.example             # 环境变量模板（真实 .env 不入库）
├── docs/                        # 数据库 / API / UI / 迁移文档
└── tools/                       # 静态检查器与验证脚本（19 个 check-*）
```

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

### 小程序

1. 微信开发者工具打开仓库根目录
2. 复制 `miniprogram/config/env.example.js` 为 `env.js`，填入后端地址
3. 本地无 AppSecret 时：`env.js` 置 `DEV_LOGIN: true`，用 `DEV_ROLE` 切换三种测试角色（后端需同样开启）
4. 详情 → 本地设置 → 勾选「不校验合法域名」（仅开发阶段）
5. 编译运行

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
   （否则改完当下生效、下次重启被静默抹掉）；「超级管理员组」例外 —— 恒只读，避免锁死系统；
4. **只读账号不显示写入口**：每个页面用统一工具算出 `canManage`，写按钮一律按它渲染；
   服务端仍会二次校验，前端只是体验。

此外有两条**非权限项**的授权来源：

- **班主任**：`user.homeroomClasses` 命中目标班级即获得「管本班学生」的能力
  （编辑资料 / 重置密码 / 发徽章 / 限制同步·GPS / 排宿舍），**无需任何管理权限**；
  「能做什么」由服务端 `capabilities` 下发，前端照此渲染。删除账户属校级处置，默认不开放。
- **班委**：`user.isClassOfficer`，只读本班数据。

两类身份都通过**成员资格校验**（而非 `requirePermission`）在 `/api/class/*` 生效。

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

---

## 质量保障

仓库内置 19 个静态检查器与 3 个端到端验证脚本，覆盖历史踩过的坑（每一条都对应一次真实事故）：

```bash
# 全部静态检查
Get-ChildItem tools -Filter 'check-*.js' | ForEach-Object { node $_.FullName }

# 端到端（需可连数据库，自建临时数据并清理）
node tools/verify-homeroom-scope.js     # 班主任管本班（含不能删号）
node tools/verify-teacher-rebind.js     # 教师换绑微信、学生仍受限、一键登录不失效
node tools/verify-identity-e2e.js       # 旧令牌 401 自愈、一键登录身份不被覆盖
```

风格是**能静态查出来的就别靠人工 review**，例如：

| 检查器 | 守住的规则 |
|---|---|
| `check-write-guard` | 管理端写操作入口必须有权限守卫（标签栈解析，不靠缩进猜祖先） |
| `check-server-contract` | 业务唯一实现、429/权限契约、参考数据与维护路径分离 |
| `check-identity-binding` | 身份一致性（含「换绑不得吊销其它设备令牌」这类反向断言） |
| `check-css-vars` / `check-component-styles` | 不存在的 CSS 令牌、组件缺 `styleIsolation` |
| `check-mini-refs` / `check-wxss-imports` | 悬空 `require` / `@import` / `usingComponents` |
| `check-nav-groups` | 各角色导航矩阵、入口按真实能力判定、关于页版本号一致 |

---

## 安全约定

- 仓库**不含**服务器地址、数据库凭据、密钥：后端配置在 `server/.env`，前端在 `miniprogram/config/env.js`，两者均已忽略；
- **凭据类字段绝不下发客户端**：`user.toSafeJSON()` 剔除 `passwordHash` / `initialHashes` / `resetHashes`，
  新增任何「用户文档 → 客户端」的出口都必须走它或显式白名单；
- 管理端权限在服务端二次校验（JWT + 权限项），前端隐藏入口只是第一道门；
- 小程序身份 = **当前 token 对应的账号**；JWT 与签发时的微信绑定强一致，解绑 / 换绑后旧令牌立即失效；
- 历史登录（一键登录）令牌随机 32 字节、只存 SHA-256、30 天有效、用后轮换。

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/database-v2.md](docs/database-v2.md) | 数据库 2.0 设计（集合、索引、字段口径） |
| [docs/api.md](docs/api.md) | 接口说明（用户端 / 班级域 / 管理端） |
| [docs/ui-design.md](docs/ui-design.md) | 白橙设计系统与页面规范 |
| [docs/migration.md](docs/migration.md) | 1.0 → 2.0 数据迁移指南 |
| [AGENTS.md](AGENTS.md) | 仓库开发约定（权限、学籍、跑分、登录态等硬约束） |

---

## 版本记录

| 版本 | 日期 | 内容 |
|---|---|---|
| **v2.0.0** | 2026-10 | 全新重写：前后端分离、管理端内置小程序、白橙设计系统、自定义悬浮导航、班级域（班主任 / 班委）、班超评比、学生会管理、跑分体系、结构拆分（`packageAdmin` / `packageUnion`）、内置 19 项静态检查与端到端验证 |

> 1.0 代码已遗失，2.0 基于旧 MongoDB 结构逆向重建并设计新表 + 一次性迁移方案，详见迁移文档。

---

## 许可

[MIT License](LICENSE) © 2026 河北唐博科技有限公司

可自由使用、修改与分发（保留版权声明）。用于商业场景前请确认符合所在学校的数据与隐私规定。

---

<p align="center">
  由 <b>河北唐博科技有限公司</b> 设计与开发<br>
  <sub>校园运动记录与管理平台 · v2.0.0</sub>
</p>
