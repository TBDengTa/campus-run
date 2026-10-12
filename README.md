# 校园跑小程序（唐唐快跑 2.0）

> 2.0 全新重写版：校园跑步打卡微信小程序（小程序端 + Node.js 后端，管理端内置于小程序）。
> 1.0 代码已遗失，2.0 基于旧 MongoDB 数据库结构逆向重建，并设计新表 + 一次性迁移方案。

## 功能总览

**用户端**
- 微信运动步数同步（WeRun 解密）+ 每日/每周目标 + 分时段目标进度
- GPS 实跑（地图轨迹、距离/配速/卡路里）
- 跑步日历（打卡点标、节假日标记、周统计）
- 看激励视频赚步数（每日限次）
- BMI 身体数据 → 自动匹配目标计划
- 喝水打卡
- 成就徽章（累计/单日/连续等 7 类条件）
- 学生认证（学校 → 院系 → 专业三级选择 + 学号实名）
- 封禁申诉
- 公告 / 版本日志

**管理端（小程序内独立分包，仅管理员可见）**
- 数据看板（用户/活跃/步数/广告 PV 趋势）
- 用户管理（搜索/封禁/解封/流水）
- 申诉审核
- 广告系统（赞助商 / 广告位 / 素材 / H5 落地页托管 / PV·点击统计）
- 内容管理（公告 / 版本日志 / 节假日 / 组织架构 / 徽章定义）
- 系统配置（目标 / 反作弊阈值 / 激励视频规则）

**反作弊**：步数暴增检测、配速异常检测，命中自动封禁 N 天，支持申诉解封。

## 目录结构

```
├── project.config.json    # 微信开发者工具配置（miniprogramRoot 指向 miniprogram/）
├── miniprogram/           # 小程序前端（TDesign 组件库）
│   ├── pages/             # 用户端页面
│   ├── packageAdmin/      # 管理端分包
│   ├── config/env.example.js  # 环境配置模板（复制为 env.js，不入库）
│   └── miniprogram_npm/   # 已构建的 tdesign-miniprogram
├── server/                # Node.js + Express 后端
│   ├── src/               # 路由 / 服务 / 模型 / 中间件
│   ├── scripts/           # 数据迁移、管理员引导
│   └── .env.example       # 环境变量模板（真实 .env 不入库）
├── docs/                  # 数据库设计 / API / 迁移说明
└── tools/                 # TabBar 图标生成器
```

## 快速开始

### 后端

```bash
cd server
npm install
cp .env.example .env      # 填写数据库连接、JWT 密钥、微信 AppSecret
npm start                 # 默认 :3000
```

从 1.0 旧库迁移数据（可选）：

```bash
npm run migrate:dry       # 试运行，只出对账报告不写入
npm run migrate           # 正式迁移到新库
```

### 小程序

1. 微信开发者工具打开仓库根目录
2. 复制 `miniprogram/config/env.example.js` 为 `env.js`，填入后端地址
3. 详情 → 本地设置 → 勾选「不校验合法域名」（开发阶段）
4. 编译运行

## 部署清单（上线前）

| 事项 | 说明 |
|---|---|
| HTTPS 域名 | 后端部署到合法域名下，在小程序后台配置 **request 合法域名** |
| 业务域名 | 广告落地页（`/p/:slug`）所在域名需加入 **业务域名**（web-view 使用） |
| 图标字体 | TDesign 图标走 CDN（tdesign.gtimg.com），需加入 **downloadFile 合法域名** |
| 微信 AppSecret | 后端 `.env` 的 `WX_APPSECRET`（code2session / WeRun 解密必需） |
| 微信运动 | 小程序需具备「微信运动」类目权限（沿用 1.0 appid 则已有） |
| 流量主 | 激励视频广告位 ID 在 `miniprogram/pages/reward/reward.js` 中替换 |
| 管理员 | 方式一：`.env` 的 `ADMIN_BOOTSTRAP_OPENIDS`（登录自动授权）；方式二：`npm run admin:add -- <openid>` |
| JWT_SECRET | 务必设置为随机长字符串 |

## 安全约定

- 仓库不含任何服务器地址、数据库凭据与密钥：后端配置在 `server/.env`（已 ignore），前端配置在 `miniprogram/config/env.js`（已 ignore）
- 管理端权限在服务端二次校验（JWT + role），前端入口隐藏只是第一道门

## 文档

- [数据库 2.0 设计](docs/database-v2.md)
- [API 说明](docs/api.md)
- [1.0 → 2.0 迁移指南](docs/migration.md)

## 版本

- **v2.0.0** —— 全新重写：前后端分离、管理端内置小程序、新表结构 + 旧数据迁移
