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
- **封禁来源分类（用户 2026-10-30「用户管理列表中的封禁用户要有分类 如人封、机封、AI封」）**：
  `source` 与 `operator` **正交**——operator 记「谁执行」（追责用），source 记「凭什么判定」（分类用），
  不可混用一个字段（历史数据里 operator='system' 已把规则判定与模型判定揉成一团，无法还原）。
  取值 `manual 人封 / ai AI封 / rule 机封 / legacy 早期`（+ 解封用 appeal）。
  ① 文案**唯一定义在 `models/ban-record.js::SOURCE_TEXT`**，由接口下发 `sourceText`，
     前端只 `r.sourceText || 本地兜底`（与仓库既有 `classStatusText || CLASS_STATUS_TEXT` 同一模式）；
     前端自己映射一份中文必然与服务端漂移。legacy 用短词「早期」：chip 有宽度预算，
     长文案会把同排其它标签挤成 +N 折叠。
  ② **source 只在写入时定**（`anticheat.restrict({source})`：steps.js 两处自动处置标 `ai`、
     checkStepJump / checkPace 标 `rule`、manualBan 显式标 `manual`），读取时不重新判定；
     历史记录按 operator 保守推断（非 system→manual，system→legacy）——**绝不猜规则还是 AI**，
     否则「AI 误封率」这类统计直接失真。
  ③ legacy 必须**单列成一个筛选项**而不是藏掉：否则管理员会觉得
     「明明封了 N 人，分类加起来对不上」，反而怀疑筛选坏了。
  ④ 「封禁类型」是第 9 个筛选维度，与 status 是「与」关系；选项计数、分面、列表筛选
     **共用 `banSourceCond` 一份条件**。加维度时 `FILTER_LABELS / FILTER_OPTION_KEYS /
     buildQuery 维度数组 / clearFilters / filterBase / WXML 下拉项`六处都要补，漏一处就是
     「能选但没反应」的静默失效（有契约检查器逐项盯）。
  ⑤ 详情页流水不能再只看 `operator === 'system'`（那正是用户抱怨的「系统自动」四个字）；
     两条读路径（管理端详情 / 班级域 manage）都要给 banSourceLabel，只给一边班主任看不到。
  回归：`tools/check-ban-source.js`（分类齐全、文案单点、六处接线、条件单一口径、
  WXML 引用的字段 JS 必须产出）+ `tools/verify-console.js` / 真实库链路实测。
- **首页封禁公告条（用户 2026-11-02「如果用户被封禁应该在首页中的公告栏中显示，
  并闪烁红色警告状态，点击可以进入详细并申诉等」）**：
  ① 位置在**普通公告条之前**（账号级状态优先级高于公告），`wx:if="{{banned}}"`，
     红色 `ban-pulse` 闪烁**只动 box-shadow / 背景、不动 opacity**（动 opacity 会让白字一起闪淡）；
  ② 文案整句在 `home.js::buildBanNotice` 拼好再下发（`banTitle/banSub/banActionText`），
     WXML 不写三元拼接 —— 字段为空时会留下「到期：；」这种断句；
  ③ 封禁分类（人封 / AI封 / 机封）**只用服务端 `sourceText`**（`/api/appeals/restrictions`），
     接口失败就不显示这一截，绝不前端猜；已提交待审核的申诉要显式写「申诉已提交」，
     否则用户会反复点申诉再被「已有待审核申诉」拒一次；
  ④ 两个读接口（restrictions / mine）只在**封禁态**才拉（未封禁用户白拉两次拖慢首屏），
     且 `Promise.allSettled` —— 封禁页数据绝不能拖垮首页渲染；
  ⑤ 详情页（`pages/banned`）列出**全部生效限制**（login / sync / gps）、分类、到期、最近一条申诉进度；
     有待审核申诉时主按钮改「查看进度」，避免两个按钮同一跳转。
  回归：`tools/check-ban-banner.js`。
- **学生会复审台（用户 2026-11-02「在学生会检查中的复审中，支持分数分类，并对每块显示
  检查人、检查信息(简化)、检查图片，并增加批量审核功能」）**：
  页面 `packageUnion/review/review`（接口 `/api/union/review/queue`、`/api/union/review/batch`），
  **实现全部在 `server/src/services/union-review.js`，路由只做鉴权与取参**。五条硬约束：
  ① **单条复核 / 队列 / 批量共用一份判定与写入**（`reviewableOf` / `reviewOne`）：
     单条 `POST /records/:id/review` 已改成走它。历史踩点：批量接口自己写一套判定 →
     能批量通过「自己提交的记录」，绕过自审禁令；批量不复用写入 → 单条写 history、批量不写，留痕断档。
  ② **分数分档按 `record.deduct`（扣分）** 而不是 score：deduct 是**所有模块都有**的落库字段，
     score 只在 percent 模式有意义（rate/deduct 模块恒为 0，用它分档会把「出勤率 60%」归进 0 分档）。
     四档 `full ≤0 / low ≤2 / mid ≤5 / high >5`，闭区间、逐档递减；
     `SCORE_BANDS`/`bandOf`/`bandCond` 是唯一实现，前端只搬 key（自己写区间一定与徽标对不上）。
     「满分档」用 `$not: {$gt: 0}` 而不是 `deduct: 0`：历史记录有没写 deduct 的，等值会漏掉它们。
  ③ 队列**必须带 `scopeFilter`**（分院部长读不到全校）+ `cropPhotos`（宿舍照片原图不下发），
     每条下发 `canReview / reviewBlockReason`（自审禁令在客户端无法可靠判定）。
  ④ 批量**逐条**走 `reviewOne`：一条失败只记进 results 反馈（不整批回滚），单次上限 50。
  ⑤ 简化检查信息由服务端 `summarizeRecord` 拼（评价 + `bandChao.metricText` + 备注摘要 24 字），
     明细里的**名单**刻意不进摘要（可能上百人，会把一屏撑爆）。
  回归：`tools/check-union-review.js`（分档边界逐例 + 单一实现 + 队列范围/裁剪 + 前端接线）
  + `tools/verify-union-review.js`（真连库跑完整链路，含自审禁令、批量留痕、权限闸门、清理核对）。
- **检查录入台：受检类型兼容 + 批量「无缺勤」**（用户 2026-11-04「晚自习考勤出现了不支持这种
  受检类型」「缺勤名单中没有显示本班级或本宿舍的名称」「检查录入增加批量录入无缺勤」）：
  ① **resolveTarget 必须兼容旧 targetType**：晚自习 v5 起 targetTypes 由 'class' 改成
     'classroom'（targetId 两种类型下都是班级名）——库里 targetType='class' 的存量晚自习记录
     在修改 / 复核时按旧类型解析会 400「不支持这种受检对象」。规则：type='class' 但模块只认
     'classroom' 时按 classroom 解析（routes/union.js::resolveTarget 单点兼容）。
  ② **`/api/union/entry/students` 的 className 分支不许硬编码 targetType**：曾写死 'class'，
     晚自习一点开缺勤名单就 400。按模块 targetTypes 解析（认 class 用 class，否则 classroom）。
  ③ **名单必须带范围**：person-picker 顶部显示「名单范围」（晚自习=教室·班级、查宿=楼栋房间、
     早八=全校），查宿行内显示学生班级（混宿房间要核对归属）；重置搜索时**先清空旧列表**——
     切换对象后请求失败时，残留的上一对象名单会被当成当前对象的名录勾走（脏数据不可回滚）。
  ④ **批量录入「无缺勤」逐条复用单条接口**：录入台批量模式（晚自习/早操/查宿；早八
     optionalWhenMissing「无记录=无迟到」刻意排除）逐条 POST `/api/union/records`，
     details=名单空数组+统一评价（评价必填的模块先选）、photos 空——批量绝不另写校验/写入
     （union-review 的教训：批量自写判定就能绕过单条护栏）。只允许选「未录/已取消/被退回」
     的对象（已提交/已复核会撞 409），单次上限 100，409 计「跳过」并逐条汇总结果。

- **「涨幅速度」的误封边界（用户 2026-10-29「同步增速这个有点假很容易误封锁」，必读）**：
  这个指标 = 本次新增步数 ÷ 距上次同步时长，**分母是用户点同步的时机，不是运动时长** ——
  它是全库唯一一个「会随用户操作习惯变化而误判」的特征（其他特征反映数据本身长什么样）。
  实测真人会踩到的场景（旧口径全部命中，且物理层 >15 步/秒给 0.9 → 高于封禁线 0.78 → **直接封号**）：
  · 走 30 秒 600 步后同步 = 20 步/秒；· 快走 60 秒 1000 步 = 16.67 步/秒；
  · 连点两次刷新（间隔 5 秒补 500 步）= 100 步/秒。
  现行三条硬约束（改这些之前先读 `tools/check-sync-rate.js`，它已钉死这四条）：
  ① `MIN_WINDOW_SEC = 180`：**间隔 < 3 分钟一律不判**（分母不可信：微信步数本身有分钟级聚合延迟）；
  ② 硬规则门槛提到 **15 / 20 步/秒**（旧 8 / 12 对真人太松），文案统一叫「涨幅速度」；
  ③ 物理约束层给涨幅速度的分数**封顶 0.72，刻意低于自动封禁线 0.78** ——
     增速只是「疑似」，单独绝不足以封号，只能把记录推进待研判队列等人工看。
  真刷步仍能抓：**单日总量爆炸**（>7 万 / >10 万步）与**固定数字模式**（66666 / 整数化）
  不依赖同步间隔，照旧会封。宁可漏判（有人工复核兜底），也不误封（误封只能靠学生申诉才发现）。
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
  ⚠️ **`caps` 只有一份定义（模块级 `capsOf`），/login 与 /me 都读它**：
  早前 `/login` 不返回 `caps`、页面又直接拿登录返回值当 me 用 → `caps` 恒 undefined →
  前端退回 `{view:false}` → **任何账号（含超级管理员 `'*'`）都被判「没有任何反作弊查看权限」**
  （用户 2026-10-30 报「我有全部权限啊」）。两个出口给同一份，页面也不再假设登录响应就是 me
  （`doLogin` 成功后统一再取一次 `/me`）。回归断言：登录响应含 caps、与 /me 逐字段一致。
  ⚠️ **控制台静态资源引用必须带 `?v=<buildTag>`**：线上曾给 `app.js` 发 `max-age=259200`（3 天），
  于是「后端已改、文件已换」时浏览器仍跑旧版，用户看到的报错与实际代码不同步 ——
  排查会被彻底带偏（2026-10-30 真实踩过：修好了但线上看到的还是旧行为）。
  `buildTag` = `server/src/index.js` 的 mtime，一部署就变 → URL 必变 → 必然重新拉取。
  回归断言：页面里 `app.js`/`app.css` 都带版本参数，且带参数的 URL 仍 200（query 不影响静态解析）。
  ⚠️ **自动处置总开关必须覆盖全部自动封禁路径**（用户 2026-11-03「自动处置关闭了依旧没有效果
  依然会主动封禁」）：`goal_config.anticheat.enabled` 早前只在两条规则路径（checkStepJump /
  checkPace）检查，两条 **AI 路径**（steps.js 微信同步 / GPS）不读开关、score 达线照封 ——
  开关是假的。现在统一闸门在 `services/steps.js::autoDisposeEnabled()`，AI 两处 restrict 前
  必须过它；关闭时线索照常落库（open 等人工研判），只是不自动限制学生。**自动封禁执行后必须
  回写线索**（`steps.js::markAutoBanned`：status='banned' + autoBanned=true）—— 此前 autoBanned
  全库无写入点，「已封禁」筛选与「系统自动封禁」标签形同虚设。dashboard 下发 `autoDispose`，
  状态台顶栏显示开关状态。回归：`tools/check-anticheat-disposal.js`（静态）+
  `tools/verify-console.js` 第 8b 节（打桩模型恒 autoBan，真连库验开关两态）。
  ⚠️ **GPS 线索必须带轨迹快照**：`step_anomalies.route`（判定时降采样 ≤400 点 `{lat,lng,t}`，
  走 `gps-metrics.js::downsamplePoints`）+ `runRecordId`（run_records 落库后回填）。自动封禁的
  GPS 跑**不落 run_records**（拦截时直接 return），快照是它唯一的轨迹。控制台轨迹详情接口
  `GET /console/api/anomalies/:id/gps`（挂 anticheat.view）的数据源优先级：runRecordId →
  route 快照 → 旧记录按 openid+日期就近匹配。**快照优先于日期匹配**：快照与线索精确绑定，
  同日多条跑时日期匹配可能选错别人的轨迹。指标一律走 `withGpsMetrics`（与小程序三条读路径同源），
  轨迹图是前端内联 SVG（createElementNS，CSP 兼容）。
- **判定 ≠ 处置，控制台 UI 分两组表达**（用户 2026-11-03「标记为轻微违规并没有处置，
  处置和标记是两码事，UI 理解不了」）：训练台动作区分「① 判定·喂 AI 训练（不动学生）」与
  「② 处置·处理这条线索（对学生生效）」。标注 cheat/minor 后记录**留在队列**（状态徽标
  「已判定 · 待处置」），直到封禁或归档 —— 这不是 bug，是「研判员标注 → 管理员批准」
  复核流程的刻意设计，不要改成标注即出队。**归档（archive）是处置线第三个动作**
  （`anomaly-disposal.js::archiveAnomaly`，与封禁/排除同在唯一实现里，console 与 admin
  两路由只取参）：= 记录违规但不封禁、移出队列；未标注默认 minor，已标 cheat/minor 的
  保留原判定（归档是处置线，不能替管理员改认知线）。轻微违规的处置去向就是归档。
- **训练台默认展开 + 同步时间/历史增速**（用户 2026-11-03「不用非得折叠，默认展开方便快捷操作」
  「增加记录时的同步时间」「同步增速这种我要看历史增速的判断」）：控制台详情面板
  **默认全部展开**（`collapsed` 记录被手动收起的行，点击行切换），默认页大小 15；
  列表接口下发 `createdAt`（= 同步被判定时刻）。微信同步线索的「当日同步历史」唯一实现在
  `services/sync-rate-history.js`（Web `/console/api/anomalies/:id/sync-history` 与小程序
  `/api/admin/step-anomalies/:id/sync-history` 两路由只鉴权取参）：从 run_records 按
  openid+date 逐条重算 间隔/增速，**与判定口径同源**（判定的 elapsedMs 就是「本次
  createdAt − 上一条 createdAt」）—— 不要另写一套历史计算或在两端各算一份；
  间隔 < 180s（MIN_WINDOW_SEC）标「窗口短」不给增速数字，与 check-sync-rate 钉死的
  判定窗口一致；跨天首条用前一天末条做参照（addDays -1）。1 小时内的多次同步本就合并为
  一条记录（createdAt 是窗口起点），历史表与判定看到的窗口相同，不要试图还原中间时刻。
  ⚠️ **跨日补同步行必须带日期标注**（用户 2026-11-04「最后一个记录是16:43:36 这时间还能倒退了」）：
  run_records 按 `date`（步数所属日）归组，学生次日打开小程序触发微信 7 天回补，会给历史日
  补建 `createdAt` 在次日的记录（19:40:06 + 距上次 21:03:30 = 次日 16:43:36，数据本身没错，
  最近 500 条 werun 记录里 225 条是这类补同步）——历史表于是出现「时间倒退」的行。
  修复在展示层：`sync-rate-history.js` 每行下发 `dayText`（`toDateKey(at) ≠ rec.date` 时给
  MM-DD，否则空串）+ `summary.crossDayText`（整句文案服务端拼），两端前端渲染成
  「MM-DD hh:mm:ss」并追加说明。**不要**改按 date 归组的查询，也**不要**在前端自己算跨日。
- **训练台列表按数据量排序/筛选**（用户 2026-11-04「列表可以筛选违规步数，可以先优先步数或距离大的
  优先处理」）：`GET /console/api/anomalies` 新增 `sort=size`（数据量降序：werun→当日步数
  `cumulativeSteps`、gps→`features.distance`，同一 sort key 让两种来源按各自量级混排）、
  `minSteps`（werun 当日步数下限）、`minDistance`（gps 距离下限，米）。三条口径约束：
  ① 步数口径用**当日步数**（当天累计作弊总量）不是本次新增；② 筛选按来源分支——全来源时只
  约束设了阈值的来源（筛「步数≥3000」不能把 GPS 记录从列表筛没），关键词 `$or` 与数据量
  `$or` 共存时必须合并进 `$and`（直接覆盖 $or 是静默丢筛选的 bug）；③ 跨字段条件排序
  find+sort 表达不了，只有 sort=size 走 aggregate（$addFields _size → $sort），默认排序
  `{score:-1, createdAt:-1}` 不动。列表新增「步数/距离」列——排序依据必须看得见。
  小程序管理端列表刻意不跟进（用户指定的是 WEB 控制台）。
- **小程序异常记录页与 Web 同一动作分组**（用户 2026-11-03「小程序并没有适配」）：
  `packageAdmin/config/anomalies` 同样分「① 判定 / ② 处置（封禁/归档）」两组，状态徽标
  「已判定 · 待处置」同文案。按钮显隐读**服务端列表接口下发的 caps**
  （`caps: res.caps || { label:false, ban:false }`，fail-closed；ban 兼容 user.manage 与
  BAN 中间件同口径；鉴权仍在各写路由）—— check-write-guard 认可 `caps.*` 守卫并校验其
  来源；不要在小程序里按本地权限缓存自算一份。只读账号（user.view）仍可展开
  「当日同步历史」（toggleHist 是纯读 UI，在检查器 UI_ONLY 白名单里）。
- **小程序反作弊详情与 Web 完全对齐**（用户 2026-11-03「标注数据中没有跟 WEB 一样显示
  详细信息」）：admin 列表下发 `features` 快照，前端 `decorate()` 预计算 `metrics[]`
  两列网格渲染（GPS：峰值/平均速度、配速、距离、时长、轨迹点、点间隔/平滑度；
  werun：当日/新增、同步时间；通用：可疑分/模型分/判定/处置备注 handleNote）。
  **GPS 轨迹图的数据拼装唯一实现在 `services/anomaly-gps-detail.js`**（数据源优先级
  runRecordId → route 快照 → openid+日期就近匹配；指标走 withGpsMetrics）——
  console 的 `/anomalies/:id/gps` 与 admin 的 `/:id/gps` 都只鉴权取参，禁止任何一边
  另写一份。小程序端「查看轨迹」开全页共用一个 `<map>` 实例的半屏弹层
  （polyline/起终点 marker 写法同 `pages/run/detail`）。指标格式化统一走
  `utils/format.js`（kmh/paceText/num2，与 Web 控制台同口径）；时间展示用
  `formatDateTime`（北京时区），**绝不从 ISO 串切片**。
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
- **本班前三：本周不足回退本日**（用户 2026-11-04「本班信息中的本周前三为什么没有显示，
  如果本周不够的话直接显示本日前三」）：`/api/class/ranking` 每行同时下发 `weekSteps/todaySteps`，
  前三在**两处前端**各自落地（`packageAdmin/class` 班级页 `loadRanking` 与首页 `class-board`
  组件 `buildCard`），规则必须一致：本周有效（weekSteps>0）人数 < 3 且今日有效人数更多时，
  改按 `todaySteps` 降序显示「本日前三」（本地重排 + rank 用 index+1，class-board 角标文案
  `topTip` 动态变「今日步数」）；否则显示本周（有几个显示几个——旧实现的
  `filter(weekSteps>0).slice(0,3)` 周初全班 0 步时筛出空列表只剩空态文案，首页卡片则会摆
  3 个 0 步的名字）。两处都空才显示空态，文案覆盖双口径（「今日与本周都还没有人产生运动记录」）。
  回退说明句整句 JS 预计算（「本周数据还少，先按今日步数排名」），模板不写三元拼接。
- **班级状态总览**（用户 2026-10-29「增加班级状态页面显示所有班级的考勤、校园跑达标(日、周)，
  并且可以复制到文本如未达标班级等」）：页面 `/packageAdmin/class-status/class-status`，
  接口 `GET /api/admin/class/status-board`（前缀已挂 `class.view`，**不新开权限项** ——
  新开会让现网只有 class.view 的学生处/年级组长突然失去入口）。
  口径全在 `services/class-status-board.js`，前端**不做任何二次计算**（否则会出现
  「列表 87%、复制文案 88%」这种发到群里被问住的不一致）：
  · 班级范围只含 `status==='normal'`（`ClassProfile.joinsBandChao`）：实习/毕业班不参与考勤与校园跑，
    算进来会把「本来就没考勤」误报成「未达标」；
  · 达标 = 生效目标（个人计划优先、否则全局）且步数 ≥ 目标，周起点为 ISO 周一；
  · 考勤按**应到人数加权**（不是简单平均），早八只记迟到人数、不产生比率；
  · 可复制文案由**服务端生成**（`buildCopyText`），前端只搬运。
  · **筛选也在服务端**（`applyBoardFilter`，参数 `quick|department|keyword`）——
    用户 2026-10-30「支持筛选，复制时复制的是筛选后的相应内容」。
    为什么不能放前端：文案必须服务端单点生成，若筛选在前端、文案在服务端，
    两者用的是**不同行集合**，复制出去仍是全量报告（正是用户指出的问题）。
    缓存存全量、筛选在内存做 → 切筛选不重算聚合（3 秒），且筛选前后是同一批数据。
    未筛选 `copyText`=完整报告；有筛选=只列筛出的行，**标题必须写明筛选条件与班数**
    （否则粘出 5 个班却顶着「全校 43 个班」，群里会把「没列出来」读成「那些班没问题」），
    并保留一行全校对照。`quick` 非法值/空参数必须等于全量（不能让拼错的参数悄悄筛空）。
    未达标判定统一走 `QUICK_FILTERS`（一份定义）：之前 buildResult 与 buildCopyText
    各写一遍条件，改一处忘另一处就会出现「页面 41 个、复制出来 43 个」。
  · **加载失败必须显式呈现**（`errorText` + 重试，且清空 metrics/copyText 等全部派生字段）：
    上一版失败只弹 toast 后留空列表，于是「后端没部署」与「今天真没数据」在页面上
    长得一模一样（用户截图的空白页就是这个，还以为是排版问题）。
    失败后不清 copyText 更危险：复制按钮会吐出**上一次的旧数据**并被当成最新发到群里。
  · 展示字段一律 JS 预计算（`copyLabel/hasFilter/emptyTitle/footerText/metrics/copyScopeLabel`），
    模板里不写三元拼接 —— 含变量的整句（如「本周起点 {{weekStart}}」）尤其要在 JS 拼，
    否则字段为空时留下「本周起点 ；」这种断句。
  · **第二轮（用户 2026-10-30「这太难看了…可以查看显示内容与复制内容，如只需要日达标这种的，
    而且考勤回看是什么，并且没有院系筛选」）**四条，改这块前必读：
    ① **院校 + 系部两级筛选**，且必须成对：实测北校区与洋河校区**都有「计财系」**，
       只给系部下拉会把两校混着筛出来（看着能筛、结果是错的）。给了 `school` 才校内消歧；
       只给 `department` 时按同名全筛并在标签写明「各校区同名」，让结果自己说明口径。
    ② **档位筛选 `level × metric`**：`notFull/below95/zero`（2026-11-03 用户指定「低于95%」
       替代「低于一半」），指标 `daily/weekly`。
       没有它就是「今日未达标筛出全部 43 个班」——今日全校达标率个位数，
       没有任何班到 100%，那个 chip 等于没筛（用户截图里就是这个）。
       档位与快捷 chip **互斥**（前端选一个清另一个），服务端同时收到时 quick 优先。
    ③ **「考勤统计 N 天」只在真有考勤数据时出现**（`rows` 任一 `attendance.hasData`）。
       实测 `check_records` 全库仅 4 条且 `moduleKey` 只有 `hygiene`（卫生区），
       而考勤统计的是早操/早八/晚自习/查宿——**一条都不匹配**，那列永远是「—」。
       一个永远为空的控件摆在筛选区最显眼处，是这页"难看"的主要来源。
       有数据时才出现，并把说明写清（早操/早八/晚自习/查宿）。
    ④ **「显示内容」与「复制内容」是两个独立开关**：
       前者控制列表列显隐（日/周/考勤，纯前端，不重新请求）；
       后者控制 `copyText` 强调哪个指标（`copy=all|daily|weekly`，传服务端生成文案）。
       刻意不从列显隐推导复制口径：可以列表看着三列、复制时只要日达标那份名单。
       收窄后文案的标题与正文都不再出现另一指标（复制「只要日达标」却附一句本周是噪音）。
  ⚠️ 两个 MongoDB 聚合陷阱（都真实踩过，改这段聚合前必读）：
  ① **同一个 `$addFields` 内不能引用本阶段刚加的字段**（并行求值）——
     `$gte:['$todaySteps',...]` 拿到旧值 → 达标数恒为 0，全表 2285 人算出「今日 0 人达标」；
     必须拆成两个 `$addFields`。
  ② **目标取值不能写 `$toDouble:'$g.daily.steps'`**（先拿对象再取路径）——
     `g` 为 null 时 `$toDouble` 报错，MongoDB **静默丢弃该文档** → 总数少几个人（819 vs 829，
     差的正是 10 个没有个人计划的学生）。要写 `$toDouble:{ $arrayElemAt:['$goal.daily.steps',0] }`（先取后转）。
  性能：聚合全部**下推 Mongo**（网络只传最终 43 行）+ 60 秒缓存。
  第一版在 Node 侧聚合（`User.find` 2274 个 openid 再 `$in` 查两张表）实测 **17 秒**，不可接受。
  回归：`tools/verify-class-status.js`（用**独立算法**交叉核对人数，专抓「数字看着正常但算错」；
  第 10 节会**造临时考勤数据**咬合应到加权断言——曾因全库无考勤记录，字段读错的 bug
  一直测不出来）+ `tools/check-nav-groups.js`（入口按 `class.view` 判定，且对无该权限的账号必须不可见）。
- **考勤字段路径（2026-11-03 修复「考勤一直是 —」，改聚合前必读）**：
  应到/实到数字存在 check_records 的 **`details`**（shouldCount/actualCount/shouldStay/
  lateCount，写入端 `routes/union.js::fillDerived`）；`metrics` 只装 `ratios`/`values` 两层
  （`metrics.ratios.rate` 是记录级比率）。看板聚合曾读成 metrics 层的 shouldCount →
  应到恒 0 → ratePercent 恒 null → 考勤列恒「—」。`tools/check-server-contract.js` 钉死
  「不再出现 metrics 层的 shouldCount/actualCount/shouldStay」。
- **日期选择多级联动（用户 2026-11-03「增加日期选择，考勤应该没有周的选择」）**：
  前端 `selectedDate`（空=今天，picker 上界=今天）一次联动三处：日达标列=所选当天、
  周达标列=所选日所在 ISO 周（周一至该日）、**考勤窗口=所选日往前 N 天**（N 由
  「考勤统计」chips 控制——考勤按天回看，**永远没有「周」语义**，不随指标日/周切换）。
  选了非今天的日期：快捷 chip 文案 今日→当日 / 本周→当周（`chipsFor()`），指标条同理；
  非今天才传 `today` 参数（缓存友好），服务端 `isValidDateKey` 校验非法值回退今天。
  回归：`verify-class-status.js` 第 11 节（today 覆盖/周起点重算/考勤区间锚定/非法回退）。
- **第三轮（用户 2026-11-03「多选年级筛选 / 生成图片转发 / 低于95% / 按年级与名称排序」）**：
  ① **年级多选**走服务端 `filterBoard` 的 `grades` 参数（与复制文案同源，标签按选中升序拼
  「2023+2024级」自动进 copyText 标题）；行的年级口径 = `class_profiles.grade` 优先、
  `roster.gradeFromClassName(className)` 兜底（存量 grade 大量为空）；路由只认 4 位年份、
  其余丢弃（防注入），响应下发升序 `grades` 候选，前端画多选 chips。
  ② **行排序 = 年级升序 → 班级名**（空年级排末尾，替换旧的「未达标优先」桶排序——
  要看缺口用档位筛选，列表本身要稳定顺序便于对照与生成图片）。
  ③ **生成图片转发**（canvas 2d，全仓首例）：画「当前筛选后的展示行表格」（所见即所转），
  标题带服务端 `activeFilters` 标签与班数，数值颜色与列表同一套 level 口径；行数上限 45、
  超出注明；`wx.showShareImageMenu` 优先（直接发聊天），低版本回退 `saveImageToPhotosAlbum`。
  画布 CSS 用「移出屏幕」而非 `display:none`（部分机型拿不到节点）。
  回归：`verify-class-status.js` 8c/8d 节（排序有序性、年级单选/多选并集与标签进文案）+
  `check-server-contract.js`（below95 替换 belowHalf、grades 接线、canvas 接线）。

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
