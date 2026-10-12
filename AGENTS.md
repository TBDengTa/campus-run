# 校园跑小程序（唐唐快跑 2.0）仓库约定

## 安全红线
- 严禁把服务器地址、数据库连接串、密钥、AppSecret 写入任何被 git 跟踪的文件。
  后端配置只在 `server/.env`，前端配置只在 `miniprogram/config/env.js`（两者均已被 .gitignore）。
- 示例文件只允许占位符：`server/.env.example`、`miniprogram/config/env.example.js`。
- 文档（README/docs）中不得出现真实域名与凭据。

## 技术约定
- 后端：Node.js + Express + Mongoose，模型必须显式指定集合名（`mongoose.model('X', schema, 'collection')`）。
- 数据库命名：`openid` 统一；`createdAt/updatedAt` 用 timestamps；时间用 BSON Date，日历键用 `YYYY-MM-DD` 字符串；距离单位米、时长单位秒。
- 大集合必须有查询索引（参考 `docs/database-v2.md`）。
- 小程序：TDesign 组件库（miniprogram_npm 已构建）；管理端在 `packageAdmin` 分包，权限以服务端校验为准。
- 管理端/用户端接口分离：用户端 `/api/*`，管理端 `/api/admin/*`。

## UI 约定（白橙设计系统）
- 配色/圆角/间距一律使用 `app.wxss` 中的 `--tt-*` 令牌与 `.tt-*` 公共类，禁止在页面里硬编码品牌色或旧蓝色（`#0052d9`）。
- 底部导航为**自定义 tabBar**（`custom-tab-bar/`，`app.json` 中 `tabBar.custom = true`）：
  白橙悬浮胶囊 + 中间凸起圆钮，按角色变化（学生 5 项；教师 3 项）。
  **新增/改名的 tab 页必须在 `onShow` 里调 `this.getTabBar().setActive('<路径>')`，页面根节点加 `.tt-page-tab`。**
- 详细规范见 `docs/ui-design.md`（新增页面必须遵守）。
- 大数字用 `.num-font`，格式化统一走 `utils/format.js`。

## 教师账号规则
- 教师（`role === 'teacher'`）**不参与运动记录与排名**：步数同步 / GPS 实跑 / 激励视频加步数在
  `routes/run.js`、`routes/reward-video.js` 与 `services/steps.js` 三层拦截（`403 + code 403003`）；
  排行榜 `$lookup users` 后按 `role != 'teacher'` 过滤。
- 新增任何写入 `run_records` 的能力时，必须同步加教师判定，避免教师账号产生运动数据。

## 角色与权限（RBAC）
- 用户角色只有 `student` / `teacher`；"管理员"= 持有 `superadmin` 权限组（permissions 含 `'*'`）。
- 权限 = 独立权限项（permissions 集合目录）+ 权限组（permission_groups 集合）；用户有效权限 = `user.permissions` ∪ 所在组展开，`'*'` 通配。
- 管理端路由一律用 `requirePermission('xxx')` 挂载（见 `src/routes/admin/index.js`），禁止只靠前端隐藏入口。
- 新增管理能力时：先在 `Permission.DEFAULT_CATALOG` 加权限项（启动自动播种），再挂到对应路由。
- 本地测试登录：后端 `DEV_LOGIN=true` + 前端 `env.js` `DEV_LOGIN: true, DEV_ROLE: 'dev-student|dev-teacher|dev-admin'`；生产必须关闭。

## 迁移
- 旧库（1.0）只读；任何迁移通过 `server/scripts/migrate-v1-to-v2.js`，先 `--dry-run` 再正式执行。
- 启动期迁移（`services/rbac.js` 的 `seedRbac`）必须**先归一化历史角色，再保存任何用户文档**：
  旧库 `role` 是 `'user'` / `'admin'`，而新枚举只允许 `student` / `teacher`，
  一旦对这类文档执行 `save()` 就会校验失败并**直接导致后端启动崩溃**（已由 `migrateLegacyRoles()` 处理）。
- 启动期迁移必须幂等且**只在首次生效**：存量用户初始化（学号后8 的 scrypt 哈希）单次约 35ms/人，
  若查询条件永远命中，每次启动都会重算 1500+ 次（≈1 分钟）并全表重写。
