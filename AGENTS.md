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
- **`tools/` 下只放可重复运行的东西**：`check-*`（静态检查）、`verify-*`（端到端验证）、生成器（`gen-*` / `make-*`）。
  一次性调试脚本一律命名 `_tmp-*.js` / `_probe*.js` 并**跑完即删**；它们已被 `.gitignore` 忽略，
  但请仍删掉本机副本 —— 留着会让后来者把无用脚本当成工具误用。

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
- **教师账号不限制微信绑定**（用户 2026-10-22「教师账户不限制微信绑定的登录」）：
  `POST /api/auth/bind` 里 `role === 'teacher'` 的账号**允许换绑**（换手机/换微信都能登进来，`user.openid` 随之更新、
  `openidBoundAt` 记新绑定时间）；**学生仍然一账号一微信**（防止代跑代签）。
  同一个微信只能登一个账号，所以绑定前必须查「这个微信现在绑在谁身上」：
  - 绑在**另一个教师**账号 → 允许**顶替换绑**（先 `$unset` 原账号的 openid，否则会撞 openid 唯一索引；
    **不要**吊销原账号的设备令牌）。这是登录页「用「X」登录」走的路径（截图场景：同一微信从刘恩琦切到陈宇航）。
  - 绑在**学生**账号 → 一律 `403 403004`（学生微信不能被任何账号顶掉，含「学生账号自己还没绑过」的情形）。
  登录页遇到「当前微信已绑 A、输入的是 B」时用 `wx.showActionSheet` 给三个选择
  （用「B」登录 / 继续进入「A」/ 返回），**不要**退回 `showModal` 的两按钮 —— 那是死胡同。
  副作用（刻意如此）：换绑后原账号在**这台设备**上的 JWT 因 `openid` 不一致被判 401，等于本机退出登录；
  **但不得吊销原账号的 deviceToken**（别的设备的一键登录仍然合法，见「登录态」第 ④ 条）。
  回归：`tools/verify-teacher-rebind.js`（含教师顶替、学生拒绝、旧令牌失效、原账号仍可一键登录）。
- 教师「我的」页**不显示**「隐私设置」与「我的申诉」：教师不参与排名（隐私设置调的是排行榜展示项），
  也没有申诉链路。前端用 `roleReady && !isTeacher` 控制（`roleReady` 防止首帧按默认 `isTeacher:false`
  误闪一下学生菜单）。

## 角色与权限（RBAC）
- 用户角色只有 `student` / `teacher`；"管理员"= 持有 `superadmin` 权限组（permissions 含 `'*'`）。
- 权限 = 独立权限项（permissions 集合目录）+ 权限组（permission_groups 集合）；用户有效权限 = `user.permissions` ∪ 所在组展开，`'*'` 通配。
- 管理端路由一律用 `requirePermission('xxx')` 挂载（见 `src/routes/admin/index.js`），禁止只靠前端隐藏入口。
- 新增管理能力时：先在 `Permission.DEFAULT_CATALOG` 加权限项（启动自动播种），再挂到对应路由。
- **权限组增删改**走 `server/src/routes/admin/permission-groups.js`（挂 `permission.manage`），规则：
  ① 内置组（`builtIn: true`，来自 `PermissionGroup.DEFAULT_GROUPS`）**可编辑但不可删**（用户 2026-10-20 修订，旧规则是"只读、每次启动覆盖"）：
     保存时写入 `customized: true`，`services/rbac.js::seedPermissions()` 见到该标记就**跳过播种不再覆盖**——
     否则管理员改完当下生效、下次重启被静默抹掉（假生效，比不能改更糟）。**superadmin 组例外，恒只读**（唯一持 `'*'`，改坏等于锁死自己）；
  ② 自定义组标识 `key` 只能 `^[a-z][a-z0-9_.-]{1,31}$`，且不能包含通配 `*`（`*` 仅超级管理员组）；
  ③ 删除前必须确认没有账号在用（`user.permissionGroups` 引用检查），内置组一律不可删；
  ④ 权限项必须存在于权限目录（`assertPermsExist`）。
  管理端页面：`packageAdmin/permissions/groups`（账户编辑页与用户详情页都有「管理权限组 ›」入口）。
- **反作弊独立权限组**（用户 2026-10-29「需要独立权限组」）：权限项 `anticheat.view/label/manage/ban` 四项，
  内置两个组 `anticheat_analyst`（view+label）与 `anticheat_admin`（四项全）。**刻意不并进教师管理组**——
  反作弊能封号、能喂训练集，默认给所有教师等于每个老师都能处置学生。
  蕴含关系（`Permission.PERM_IMPLIES`）：label / manage / ban 都蕴含 view（给了处置权必须能打开列表，
  否则只能靠猜 ID 调接口）。**标注（label）与封禁（ban）是两个权限、两条正交线**：
  标注进 AI 训练集（可改判），封禁直接限制学生；分开才能走「研判员标注 → 管理员批准」的复核流程。
  旧实现 GET 列表**无任何守卫**（前缀未挂权限 + 路由无 MANAGE），任何登录用户带 token 都能拉
  全员疑似作弊清单——本次一并堵（读接口 `anticheat.view` 兼容 `user.view`，不让现网教师一夜白屏）。
- **Web 控制台 `/console`**（用户 2026-10-29「后端状态台支持登录，进入后有状态台与 AI 训练台」）：
  账号密码登录 → 内存会话（`services/console-session.js`）→ HttpOnly + SameSite=Strict Cookie。
  **与小程序 JWT 完全隔离**（`/console/api/*` 只认 Cookie，`/api/*` 只认 JWT）：
  浏览器的凭证绝不能调小程序接口（XSS 偷到的会话若也能改步数/发徽章，爆炸半径大一个量级）。
  登录三道门（缺一不可）：密码正确 → 有 `anticheat.*` 权限 → **提交口令不是本人的初始密码**
  （教师 123456 / 学生学号后 8 —— 这两个值不是秘密，只校密码等于把门牌写成「知道学号就能进」）。
  ⚠️ 控制台失败计数**单独记内存**，绝不写 `user.failedLogins`：否则有人在浏览器里狂试他人密码，
  会把那个人**小程序**也锁死（用管理端入口把学生锁在门外）。
  页面是 `server/public/console/{index.html,app.css,app.js}` **静态文件**（无构建链），
  根路径 `/` 即登录页；CSP 严格到 `script-src/style-src 'self'`，因此
  **HTML 禁止内联 `style=` 与 `onclick`**（一律 class + addEventListener），
  客户端渲染一律 `textContent`（绝不 innerHTML 拼服务端字段：列表里有学生姓名与备注）。
  根路径**不公开**反作弊参数（待研判数 / AI 阈值只在登录后的 `/dashboard`）；
  `/console/api/public-status` 只给运行指标（部署自检要用）。
  回归：`tools/verify-console.js`（真实起 app 走完整 Cookie 链路，含清理与配置恢复）。
- **只读账号不显示写入口**（用户 2026-10-22「只有查看权限时应该不显示操作功能按钮，而不是点击后被后端拒绝掉」）：
  ① 每个管理端页面在 `onShow`/`load` 里调 `utils/admin-perm.js::applyManage(this, '<模块>.manage')`
     得到 `data.canManage`（`*` 或该项），写入口一律 `wx:if="{{canManage}}"`，输入框 `disabled="{{!canManage}}"`；
     页面自己有更细的写权限就多算几个（如用户管理：`canManage`=user.manage / `canPerms`=permission.manage / `canImport`=user.import）；
  ② 前端只控显隐，**鉴权仍在服务端**；取不到权限时**按只读渲染**（fail-closed）；
  ③ 回归：`tools/check-write-guard.js` 扫描**整个 packageAdmin**（bind:tap、catch:tap、bind:confirm），
     写动作必须有权限条件守卫；只有「整页都需要写权限」的页面（目前仅 `permissions/groups`）在
     `WRITE_ONLY_PAGES` 白名单里，新增白名单必须写清理由。
- **导航条目要按「真实能力」而不是「能看一眼」判定**（用户 2026-10-22）：
  `北斗运动` = `config.view`（旧实现有任意管理权限就显示，普通教师也能看到假入口）；
  `扫码加人` = `only:'unionManager'`（主席团 / 部长 / 副部长 / 学生会总管，与 `assertMemberManager` 同口径）；
  `检查记录` = `only:'unionRecords'`（学生会成员，或 `union.steward` 总管；纯 union.view 不放行）。
  首页与中枢共用 `utils/nav-groups.js::navCtx(user)` 生成上下文（含 `canUnionScanJoin`），
  **不要在 hub.js / home.js 各写一份 ctx** —— 新增身份维度时只改 navCtx。回归：`tools/check-nav-groups.js` 的角色矩阵。

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
- **身份 = 令牌对应的账号；旧令牌由服务端判死**（2026-10-22 事故：登录刘恩琦后进去还是陈宇航；
  2026-10-23 事故：一键登录的历史记录莫名失效）。三条硬约束：
  ① **服务端**：JWT 只在签发时的那个绑定下有效 —— `middlewares/auth.js` 比对令牌里的 `openid` 与
     `user.openid`，不一致（含解绑后为空）一律 `401`。这是「旧令牌不能继续用」的**唯一**防线；
  ② **小程序**：`app.ensureLogin()` 每个启动周期确认一次身份，走 **`refreshUser()`（`/api/auth/me`，按 token 校验）**。
     **不要**改成按 openid 重新登录（曾经的 `auth.login({silent:true})`）——那会在教师「一键登录 A 账号、
     而当前微信绑在 B」时把身份静默切回 B，正是一键登录失效的成因。旧令牌失效时 `request()` 会自动重登，
     自愈不需要靠启动覆盖。
  ③ `logout()` 必须清掉所有账号级缓存（`userInfo/today/stats/unionIdentity/points`）并重置
     `app._roleProbe`、`app._identityChecked` —— 只清一半会让页面半新半旧，现象无法复现。
  ④ **换绑不得吊销原账号的设备令牌**：`login_devices` 按账号签发、与微信无关，
     原账号在其它手机上的「一键登录」仍然合法。客户端 `quickLogin` 只在服务端明确回 `401001`
     时删本地记录，网络/5xx 一律保留（否则用户的历史记录会被误删且不可恢复）。
  回归：`tools/check-identity-binding.js`（静态，含反向断言）+ `tools/verify-identity-e2e.js`
  + `tools/verify-teacher-rebind.js`（含「换绑后原账号仍能一键登录」）。

## 班主任与班委（班级域）
- **班主任**：教师可被分配多个班级 —— `user.homeroomClasses: [String]`（存班级名，与 `className` 同口径）。
  班主任**不需要任何管理权限**即可查看/督促自己班的学生数据。
- **班委**：学生可被设为班委 —— `user.isClassOfficer: Boolean`（同班可多人）。
  **班委可写：本班学生宿舍 + 本班卫生区 + 本班教室**（用户 2026-10-23 两轮修订：
  「班委有本班的教师、学生宿舍、卫生区的管理权限」→「班委目前没有操作教室的权限…需要完善」）；
  其余一律只读 —— 不能编辑资料 / 重置密码 / 限制 / 解绑微信 / 发徽章 / 改其它班级配置 / 删号。
  ⚠️ 「教师宿舍」系统里**不存在**：宿舍台账只有「学生 ↔ 房间」，班委管的是「本班学生住哪间」。
  · 教室走**独立端点** `PUT /api/class/classroom`（只接受 `classroom` 一个字段，其它字段明确 400），
    不放宽 `PUT /profile` —— 那个端点的白名单里还有早操/晚自习/校园跑开关与备注，放开等于全给了。
  · 卫生区的「新建全校区域」也仅班主任（班委只能在已有区域里勾选本班归属，传 `newAreas` → 403）。
  · `GET /api/class/mine` 的 `readonly` **不再等于「班委只读」**（它现在只表示「不能改班级配置」）；
    前端要按 `capabilities` 逐项判断，别拿一个布尔值关掉整页。
  · 用户详情页的班级域分支必须调 `GET /api/class/student/:id/overview`（班主任与班委都通，
    带宿舍面板），**不能只调 `/manage`**（仅班主任，班委 403 → 宿舍入口整块不渲染，
    这正是用户 2026-10-23 报的「班委在用户详情页没办法更改宿舍」）。
- **权限模型（重要）**：班级域接口在 `/api/class/*`（`server/src/routes/class.js`），
  **不使用 `requirePermission`**，而用成员资格校验：
  ① 班主任 = `user.homeroomClasses.includes(className)` → 可读该班全部数据；
  ② 班委 = `user.isClassOfficer === true && user.className === className` → 读本班 + 写**宿舍/卫生区/教室**；
  ③ 其余一律 403。
  两个 loader，别混用（混用就会「班委改不了宿舍」或「班委能重置密码」）：
  · `loadHomeroomTarget` —— **学生账号操作**（编辑/重置/限制/解绑/徽章/删号），仅班主任，
    且目标不得持有任何管理权限；
  · `loadClassStudentTarget` —— **宿舍**，班主任与班委都放行（不查目标权限：不碰账号与权限）。
  新增任何 `/api/class/*` 接口**都必须先校验「目标学生属于该 className」**，防止跨班越权。
- 分配入口在管理端用户详情页（需 `user.manage`）。
- **班主任可以管理本班学生（不需要任何管理权限，用户 2026-10-22 / 2026-10-23 修订）**：
  编辑资料 / 重置密码 / 发放徽章 / 限制功能（**含限制登录**）/ 解绑微信 / 排宿舍；
  **删除账户不给班主任**（用户 2026-10-23）。
  三个硬约束，改这里之前先读 `services/student-scope.js`：
  ① 只有**班主任**能写这些账号操作（`role === 'teacher'` 且目标 `className` 在其 `homeroomClasses` 里），**班委一律只读**；
  ② 目标必须是**普通学生**：持任何管理权限的学生交管理员处理（否则班主任能重置/删除一个学生身份的管理员）；
  ③ 编辑资料只允许 姓名/性别/出生日期（学籍字段 `403 403005`）；
     限制功能 `login`/`sync`/`gps` **三类都允许**（2026-10-23 用户明确「都要」，此前只给 sync/gps）——
     唯一护栏是「超级管理员不可被限制」，在 `services/user-account-admin.js::banUser` 里。
  **「能做什么」由服务端下发能力表**（`GET /api/class/student/:id/manage` 的 `capabilities`，
  开关在 `routes/class.js::HOMEROOM_CAN_DELETE`）：前端 `user-detail.wxml` 只读 `caps.*` 画按钮，
  **不要**在模板里各写一遍 `canManagePerms || canManageStudent` 之类的组合 ——
  用户 2026-10-23 报的「删除账户他没有这个权限请你不要显示」就是两处判断漂移的产物。
  关闭的能力必须**同时**在服务端 403（不能只隐藏按钮）。
  **实现必须与管理端共用同一份 service**（`services/user-account-admin.js`、`services/user-badges-manual.js`、
  `services/student-dorm.js`）：
  班级域 `/api/class/student/*` 只做鉴权与取参，禁止另写一套删除/重置/发徽章/排宿舍逻辑
  （历史踩点：单条会恢复 `initialHashes`、批量不会；删除漏吊销设备令牌）。
  前端：`packageAdmin/user-detail`（`canManageStudent` 决定按钮，管理端详情与班级域两条读路径都要给）
  + `account-edit?scope=class`（只读学籍 + 只提交三个字段）。
  回归：`tools/check-server-contract.js`（单一实现）+ `tools/verify-homeroom-scope.js`（端到端，含清理核对）。
- **班主任与班委都能给本班学生安排宿舍**（班主任 2026-10-22 / 班委 2026-10-23）：
  班级域 `/api/class/student/:id/dorm`（GET/PUT/DELETE，成员资格校验 + `services/student-dorm.js`，
  走 `loadClassStudentTarget`），与管理端 `/api/admin/users/:id/dorm`（`user.manage`）**共用同一份实现**。
  前端入口两处：班级页「学生宿舍 → 宿舍绑定」（`?scope=class`，班主任/班委都可用）、
  管理端「班级管理 → 宿舍」（`class.manage`）。
- **楼名清单不是权限**（用户 2026-10-22「为什么教师权限组无法获取楼名」）：
  填教室 / 宿舍需要「先选楼」，但 `GET /api/admin/config/buildings` 挂在
  `building.view|building.manage|config.view` 下 —— 那是**宿管维护楼名清单**的权限，
  发给所有教师就等于让他们能改全校配置。所以：
  ① 只读楼名走 `GET /api/class/buildings`（登录即可读，只回 `{teaching,dorm}` 字符串）；
  ② 宿舍面板（`/student/:id/manage` 与 `/student/:id/dorm`）**自带楼名**（配置 ∪ 历史），
     前端不再单独请求 `/api/admin/config/buildings`；
  ③ 楼名的增删改仍然只走 `PUT /api/admin/config` + `building.manage`，两者刻意分开。
  这条规律适用于所有「参考数据」：**读取（填表要用）与维护（改全校配置）必须拆成两条路径**。
- `/api/auth/me` 必须暴露 `homeroomClasses` 与 `isClassOfficer`：自定义 tabBar 依赖它决定教师中间导航项
  （有管理权限 → 管理中枢；无权限但是班主任 → 班级管理；否则 → 公告）。
- 班级统计口径与首页数据概况一致；班级排名只统计 `role != 'teacher'` 的学生。

## 跑分（积分体系）
- 配置在单例 `goal_config.points`（系统配置 → 跑分设置）：完成日目标得分、完成周目标得分、
  超出日目标后「**每再多达成个人日目标的 `extraPercent`%（默认 10，范围 1~100）加 `perStepScore` 分**」、
  超出周目标后「**每再多达成个人周目标的 `weeklyExtraPercent`%（默认 10，范围 1~100）加 `perStepScore` 分**」
  （`dailyExtraCap` 单日上限、`weeklyExtraCap` 单周上限，**上限只封顶超出部分，不封顶达标基础分**；
  `weeklyExtraCap` **0 = 不封顶**（默认，与改造前的周口径一致），注意它与 `dailyExtraCap` 的 0（超出不加分）语义不同）。
- **日/周超出档位都按「个人目标的百分比」算**（`max(1, 目标 × 百分比 / 100)` 步一档），不是固定步数：
  档位随个人目标等比放大（周目标 15000 → 1500 步一档、40000 → 4000 步一档），相对努力等值。
  `perStep`（固定步数档位）**已完全弃用**——日、周公式都不再读取，字段仍保留以兼容存量配置
  （schema 与 normalizeConfig 保留该字段，管理端「跑分设置」只展示「已完全弃用」说明、不再提供输入框）；
  老配置缺失百分比字段时按默认 10 生效，管理端会显式提示与旧口径等价的百分比
  （日 `perStep ÷ 全局日目标`、周 `perStep ÷ 全局周目标`），不做静默变更。
- 计算**统一走 `server/src/services/points.js`**，禁止在路由或页面里各写一套公式；
  JS 纯函数（`pointsForDay` / `pointsForWeek`）与聚合表达式（`dailyPointsExpr` / `weeklyPointsExpr`，
  以及 `dailyStagePrefix` / `weeklyStagePrefix` 里的目标注入与 `$lookup`）**必须逐例一致**——
  历史踩坑点：`$lookup.localField` 必须用 `$group` 之后的路径、全局目标必须用 `$literal` 在 `$group` 之后注入、
  cap 只能作用在「超出部分」上。达标口径与 `services/goals.js::getEffectiveGoal` 一致，周为 **ISO 周一**起始。
- 展示位置：排行榜（支持 `metric=points`）、记录页日/周行、管理端用户详情与日周明细页、首页与我的页面。
- 跑分按**当前配置口径实时计算**（不落库快照），因此调配置会连带影响历史数值——刻意如此（学校统一衡量标准）；
  周档位从固定 1000 步改成百分比后历史周分值同样按新口径重算（新旧基线对照见 `services/points.js` 文件头）。

## 迁移
- 旧库（1.0）只读；任何迁移通过 `server/scripts/migrate-v1-to-v2.js`，先 `--dry-run` 再正式执行。
- 启动期迁移（`services/rbac.js` 的 `seedRbac`）必须**先归一化历史角色，再保存任何用户文档**：
  旧库 `role` 是 `'user'` / `'admin'`，而新枚举只允许 `student` / `teacher`，
  一旦对这类文档执行 `save()` 就会校验失败并**直接导致后端启动崩溃**（已由 `migrateLegacyRoles()` 处理）。
- 启动期迁移必须幂等且**只在首次生效**：存量用户初始化（学号后8 的 scrypt 哈希）单次约 35ms/人，
  若查询条件永远命中，每次启动都会重算 1500+ 次（≈1 分钟）并全表重写。
