# 校园跑小程序（唐唐快跑 2.0）仓库约定

## 安全红线
- 严禁把服务器地址、数据库连接串、密钥、AppSecret 写入任何被 git 跟踪的文件。
  后端配置只在 `server/.env`，前端配置只在 `miniprogram/config/env.js`（两者均已被 .gitignore）。
- 示例文件只允许占位符：`server/.env.example`、`miniprogram/config/env.example.js`。
- 文档（README/docs）中不得出现真实域名与凭据。
- **凭据类字段绝不下发客户端**：`models/user.js::toSafeJSON()` 是 `/api/auth/me`、login/bind 的 userInfo 出口，
  必须剔除 `passwordHash` / `initialHashes` / `resetHashes`（真实账号有这些字段，dev_* 测试账号没有，
  本地联调发现不了）。新增任何「用户文档 → 客户端」的出口都要走 `toSafeJSON()` 或显式白名单。

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

## 学籍字段约定
- **年级 = 学号前 4 位（入学年份）**，如 `20230101 → "2023"`（展示为 `2023级`）。
  统一走 `server/src/services/roster.js::gradeFromStudentId()`（前端展示副本在 `account-edit.js`）：
  前 4 位不是 1900~2099 的合理年份就返回空串。存量数据 `grade` 字段普遍为空，
  查询/筛选**必须保留按学号推导的兜底**（`/api/admin/users/filters` 与列表 `grade` 条件已如此处理）。
- **班级（`className`）自动识别 = 年级后两位 + 专业**（如 `2023` + `大数据技术` →「23级大数据技术」），
  统一走 `server/src/services/roster.js::classNameFromGradeSpecialty()`（前端只做只读预览，副本在 `account-edit.js`）：
  年级或专业缺失时保留原值；原班名已是同一「年级+专业」的更细班（如「23级机电1班」）时原样保留，不丢班序号。
  管理端账户编辑页**不提交 `className`**（班级只读），由服务端在创建/编辑时推导；
  **名单导入（`importRows`）同样推导**：班级列可选，留空按「年级+专业」组合，显式写了同前缀更细班才保留；
  不要给组织树硬塞「班级」第四层，也不要再做班级候选列表接口。

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
- **权限组增删改**走 `server/src/routes/admin/permission-groups.js`（挂 `permission.manage`），规则：
  ① 内置组（`builtIn: true`，来自 `PermissionGroup.DEFAULT_GROUPS`）**只读**——每次启动都会按默认值重新播种，改了也会被覆盖；
  ② 自定义组标识 `key` 只能 `^[a-z][a-z0-9_.-]{1,31}$`，且不能包含通配 `*`（`*` 仅超级管理员组）；
  ③ 删除前必须确认没有账号在用（`user.permissionGroups` 引用检查），内置组一律不可删；
  ④ 权限项必须存在于权限目录（`assertPermsExist`）。
  管理端页面：`packageAdmin/permissions/groups`（账户编辑页与用户详情页都有「管理权限组 ›」入口）。
- 本地测试登录：后端 `DEV_LOGIN=true` + 前端 `env.js` `DEV_LOGIN: true, DEV_ROLE: 'dev-student|dev-teacher|dev-admin'`；生产必须关闭。

## 登录态与退出登录（小程序）
- 登录态 = `utils/request.js` 的 `isBound()`：**有 token 且已绑定名单账号**（游客 token 不算登录），且未被主动退出。
- 三态与处理：
  | 状态 | 判定 | 行为 |
  |---|---|---|
  | 未登录 / 游客（未绑定） | `!isBound()` | 统一 `wx.reLaunch` 到 `pages/auth-login/auth-login` |
  | 已主动退出 | `auth.isLoggedOut()`（本地 `tt_logged_out` 标记） | **不再静默重登**，必须由登录页手动登录（登录页会先 `clearLoggedOut()`） |
  | 已登录 | `isBound()` | 正常执行业务逻辑 |
- **新增业务页必须在 `onLoad`/`onShow` 首行加闸门**：`if (!getApp().requireLogin()) return;` —— 未登录时**不发起任何业务请求**（不是靠接口报错后再跳）。
- `request.js` 的 401 自动重登同样尊重「已退出」标记；游客访问业务接口由服务端 `403003` + `gotoLogin()` 兜底。
- 公开页（无需登录）：`announcements`、`changelogs`、`webview`、`banned`、`auth-login`。
- 登录页必须调 `wx.hideHomeButton()`：非 tabBar 页面且页面栈只有它一个时，微信会在胶囊旁显示「返回首页」按钮（平台行为，只能用这个官方 API 隐藏）。
- **历史登录 / 一键登录**：登录或绑定成功后服务端签发 `deviceToken`（随机 32 字节，**只存 sha256 到 `login_devices`**，30 天有效，单用户最多 5 条按最久未用淘汰）；
  小程序用 `utils/login-history.js` 存本地（最多 5 条，**绝不存密码**），登录页列表点「一键登录」调 `POST /api/auth/device-login`。
  令牌**用后即轮换**（旧令牌立刻失效，客户端需用返回值覆盖本地记录），删除记录时调 `POST /api/auth/device-revoke`。
  退出登录**不撤销** deviceToken（否则"退出后一键登回"就没意义），只有用户删除历史记录或管理员踢下线才撤销。

## 班主任与班委（班级域）
- **班主任**：教师可被分配多个班级 —— `user.homeroomClasses: [String]`（存班级名，与 `className` 同口径）。
  班主任**不需要任何管理权限**即可查看/督促自己班的学生数据。
- **班委**：学生可被设为班委 —— `user.isClassOfficer: Boolean`（同班可多人）。
  班委**只读**本班数据，没有任何写操作。
- **权限模型（重要）**：班级域接口在 `/api/class/*`（`server/src/routes/class.js`），
  **不使用 `requirePermission`**，而用成员资格校验：
  ① 班主任 = `user.homeroomClasses.includes(className)` → 可读该班全部数据；
  ② 班委 = `user.isClassOfficer === true && user.className === className` → 只读且仅限本班；
  ③ 其余一律 403。
  新增任何 `/api/class/*` 接口**都必须先校验「目标学生属于该 className」**，防止跨班越权。
- 分配入口在管理端用户详情页（需 `user.manage`）。
- `/api/auth/me` 必须暴露 `homeroomClasses` 与 `isClassOfficer`：自定义 tabBar 依赖它决定教师中间导航项
  （有管理权限 → 管理中枢；无权限但是班主任 → 班级管理；否则 → 公告）。
- 班级统计口径与首页数据概况一致；班级排名只统计 `role != 'teacher'` 的学生。

## 跑分（积分体系）
- 配置在单例 `goal_config.points`（系统配置 → 跑分设置）：完成日目标得分、完成周目标得分、
  超出部分「每 N 步加 M 分」（可设单日上限）。
- 计算**统一走 `server/src/services/points.js`**，禁止在路由或页面里各写一套公式；
  达标口径与 `services/goals.js::getEffectiveGoal` 一致，周为 **ISO 周一**起始。
- 展示位置：排行榜（支持 `metric=points`）、记录页日/周行、管理端用户详情与日周明细页、首页与我的页面。
- 跑分按**当前配置口径实时计算**（不落库快照），因此调配置会连带影响历史数值——刻意如此（学校统一衡量标准）。

## 迁移
- 旧库（1.0）只读；任何迁移通过 `server/scripts/migrate-v1-to-v2.js`，先 `--dry-run` 再正式执行。
- 启动期迁移（`services/rbac.js` 的 `seedRbac`）必须**先归一化历史角色，再保存任何用户文档**：
  旧库 `role` 是 `'user'` / `'admin'`，而新枚举只允许 `student` / `teacher`，
  一旦对这类文档执行 `save()` 就会校验失败并**直接导致后端启动崩溃**（已由 `migrateLegacyRoles()` 处理）。
- 启动期迁移必须幂等且**只在首次生效**：存量用户初始化（学号后8 的 scrypt 哈希）单次约 35ms/人，
  若查询条件永远命中，每次启动都会重算 1500+ 次（≈1 分钟）并全表重写。
