# API 说明

统一响应：`{ code: 0, message: "ok", data }`；错误时 HTTP 状态码 + `{ code, message }`。
鉴权：`Authorization: Bearer <JWT>`。401 未登录/过期；403 + code 403001 账号封禁、403002 非管理员 / 无权限、403003 教师账号不参与运动记录。

## 认证 /api/auth

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /login | `{code, silent?}` → code2session。已绑定 → `{token, deviceToken, bound:true, mustChangePassword, userInfo}`；未绑定 → `{token, bound:false}`（游客 token，仅可访问 `/api/auth/*`）。`silent:true` = 启动时的「身份确认」调用：照常返回 `token/userInfo`，但**不签发 `deviceToken`**（否则每次启动都占用 `login_devices`，把历史登录一键登录的记录挤掉） |
| POST | /bind | `{account, password, studentId?}` → 把**当前微信**绑定到该账号并返回正式 token（含 `deviceToken`）。当前微信来源：游客令牌（首次绑定）或**已登录账号的令牌**（登录页「用另一个账号登录」）。规则：学生账号自己的微信不可更换；教师账号可换绑；**这个微信当前绑在谁身上**：绑在另一个教师 → 允许顶替（原账号解绑 + 吊销设备令牌），绑在学生 → `403 403004` |
| POST | /device-login | `{deviceToken}` → 一键登录。令牌用后轮换（返回新的 `deviceToken`，旧令牌立即失效）；失效返回 `401 401001` |
| POST | /device-revoke | `{deviceToken}` → 撤销该设备令牌（登录页删除历史登录记录时调用） |
| GET | /me | 当前用户（含 isClassMonitor） |
| PUT | /profile | 更新 `nickname/avatarUrl/gender/birthdate`；**学籍字段（realName/studentId/院系/专业/班级/年级）来自名单，提交即 `403 403005`** |
| PUT | /school | 绑定 `{schoolId, departmentId, className}`；**学生调用返回 `403 403005`** |

### 身份一致性（JWT ←→ 微信绑定）

**规则：JWT 只在它签发时的那个微信绑定下有效。** 服务端会比对令牌里的 `openid` 与 `user.openid`，
不一致就返回 `401`（`middlewares/auth.js`）。触发场景：

- 管理员在用户详情里「取消绑定微信」（`user.openid` 被清空）→ 该账号**所有旧令牌立刻失效**；
- 账号换绑到另一个微信 → 旧令牌失效。

为什么要这样（2026-10-22 实测事故）：JWT 有效期 30 天，而解绑只清了 `user.openid`。
于是设备继续带着旧令牌请求，`/api/auth/me` 按 `uid` 查出来还是**上一个账号**
（超级管理员界面、权限组、系统设置全在），用户在登录页重新输入另一个姓名也没用 ——
现象就是「我登录刘恩琦，进去还是陈宇航」。更严重的面：账号已解绑，旧设备仍能进后台。

配套的小程序行为：

- 每个启动周期 `app.ensureLogin()` 会用 `POST /api/auth/login {silent:true}` 重新确认一次身份
  —— **身份的唯一权威来源是「当前微信的 openid」**，不是本地 token；
- 任何接口 401 时 `request()` 会自动重登一次再重试（游客/已主动退出除外）；
- `logout()` 会清掉 `userInfo/today/stats/unionIdentity/points` 并重置身份缓存，
  换号后不会残留上一个人的权限结论。

历史令牌（早期版本签发、没有 `openid` 声明）不做绑定比对，避免一次性把所有人踢下线。

## 跑步 /api/run

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /today | **当日聚合**（该日所有来源记录求和）+ 生效目标 + 分时段应达百分比；另返回 `record.syncCount / gpsRunCount / recordCount / sources` |
| GET | /calendar?month=YYYY-MM | 月度记录 + 节假日 |
| GET | /week | 近 7 天记录（明细，前端按 date 求和） |
| POST | /sync-werun | `{encryptedData, iv}` → 解密微信运动，取最近 7 天逐日写入。**1 小时内的多次同步合并为一条记录，超过 1 小时新建当日下一条且只记增量**（反作弊按当日累计做步数暴增检测） |
| POST | /gps | 提交 GPS 实跑（反作弊配速检测），每次一条记录 |
| GET | /day/:date | 单日详情：当日汇总 + 记录明细（多条） |
| GET | /days?page&limit | 按天聚合分页（`$sum` 各来源） |
| GET | /detail/:id | 记录详情（含轨迹） |

记录来源 `source`：`werun` 微信运动 / `gps` GPS 实跑 / `beidou` 北斗（激励视频奖励步数）。
前端统一用 `utils/format.js::sourceOf(source)` 取展示文案与图标（勿各页各写三元表达式）。

> **教师账号不参与运动记录**：`role=teacher` 调用 `/sync-werun`、`/gps` 一律返回 `403 + code 403003`；
> `/api/reward-video/report` 返回 `200 + {success:false}`。服务层（`services/steps.js`）同步做了二次拦截。

## 排行榜 /api/ranking

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /?range=day\|week\|total&scope=school\|department\|class | 步数榜单 |

- `range`：`day` 今日榜 · `week` 本周榜（自然周，周一起） · `total` 总榜（读用户累计缓存），默认 `day`。
- `scope`：`school` 全校 · `department` 本院系 · `class` 本班，默认 `school`；未绑定院系/班级时返回 400。
- 返回：`{ range, scope, rangeText, scopeText, date, excluded, excludedReason, participants, list[], me{}, scopes[] }`
  - `list[]`：`{ rank, userId, nickname, avatarUrl, steps, distance, isMe }`，最多 50 条，按步数倒序。
  - `me`：`{ rank|null, steps, distance, nickname, avatarUrl }`，未上榜时 `rank` 为 `null`。
  - `scopes[]`：`{ key, label, available }`，前端据此置灰不可用范围。
- **教师账号不参与排名**：`role=teacher` 不出现在任何榜单（`excluded: true`、`me.rank` 恒为 `null`），但仍可查看榜单。
- 隐私：不返回 `openid`，仅返回用户 `_id` 与展示用昵称/头像；已封禁用户不参与排名。

## 目标 /api/goal

`GET /effective` 生效目标 · `GET /plans` 预设计划 · `GET|POST /body-data` 身体数据（保存即算 BMI 并自动匹配计划） · `GET /my-plan` 我的计划

## 激励视频 /api/reward-video

`GET /today` 今日次数/剩余 · `POST /report` 观看完成上报（服务端校验每日上限并加步数）

## 喝水 /api/water

`GET /today` · `POST /record {amount, type}` · `PUT /target {target}`

## 徽章 /api/badges

`GET /` 全部定义 + 我的获得状态

## 申诉 /api/appeals

`POST / {content}` 提交（封禁用户可用） · `GET /mine` 我的申诉

## 广告 /api/ads

`GET /slot/:key` 拉取广告位素材 · `POST /:contentId/pv` 曝光上报 · `POST /:contentId/click` 点击上报（返回跳转目标） · `GET /pages/:slug` 落地页信息

## 组织 / 内容

- `GET /api/org/tree` 学校→院系→专业树；`POST /api/org/monitor/bind` 班长绑定；`GET /api/org/monitor/me`
- `GET /api/content/announcements | /changelogs | /holidays?year=`

## 班级域 /api/class（班主任 / 班委，成员资格校验）

**不使用 `requirePermission`**：权限来源是班级身份（`user.homeroomClasses` / `isClassOfficer`），
见 `AGENTS.md`「班主任与班委」。班委一律只读；**班主任可以管理本班学生**（用户 2026-10-22）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /mine | 我的班级身份与候选班级（`role: homeroom \| officer`） |
| GET | /buildings | **只读**楼名清单 `{ teaching: [], dorm: [] }`（来自系统设置）。填教室 / 宿舍要先选楼，但**不需要 `building.view`**（那是维护楼名清单的权限）；增删改仍走 `PUT /api/admin/config` + `building.manage` |
| GET | /students?className&page&keyword | 本班学生名单（含今日/本周达标、宿舍、学生会身份）。响应带 `canManage`（班主任 true / 班委 false） |
| GET | /student/:id/manage?className | **班主任专属**：`capabilities`（能做什么，见下）+ 可编辑资料 + 已获徽章 + 生效限制 + 宿舍面板 + `banScopes:['login','sync','gps']`。班委调用返回 `403 403002`（学生账号操作仅班主任） |
| GET | /student/:id/overview?className | **班主任与班委都通**：宿舍面板 + 逐项 `capabilities` + 学生基础资料。用户详情页的班级域分支用这一条判断「宿舍入口要不要画」（班委调 `/manage` 会 403，旧实现因此连宿舍都看不到） |
| PUT | /classroom | 改本班教室：**只接受 `className` + `classroom`**，其它字段 → `400`（早操/晚自习/校园跑/备注仍只归班主任）。**班主任与班委都可写**。`classroom` 按**文本**保存（可为「阶梯教室」「报告厅」「A301」这类无门牌的场所名）；与解析冲突的分隔符（`- — / 、 ,`）归一化成空格，但楼名分隔符 `·` **保留**（实现：`normalizeClassroom`，与 `PUT /profile` 共用） |
| PUT | /student/:id/profile | 编辑资料：**只接受 姓名 / 性别 / 出生日期**；提交学号/院校/系部/专业/班级 → `403 403005`（学籍由名单同步） |
| GET | /student/:id/dorm | 宿舍面板：当前在住 + **楼名清单** + 本班已住房间 + `wechatBound`（班主任**与班委**都可读） |
| PUT | /student/:id/dorm | 安排/换房：`{ roomLabel: '1号楼·201' }` 或 `{ roomId }` + 可选 `bedNo`；房间不存在自动建档，换房旧记录置「已换房」（**班主任与班委都可写**） |
| DELETE | /student/:id/dorm | 退宿（在住记录置 `checked_out`，历史保留） |
| POST | /student/:id/reset-password | 重置为该生初始密码（无初始数据时生成随机码，`message` 里返回） |
| POST | /student/:id/ban | 限制功能：`login` / `sync` / `gps` **三类都允许**（用户 2026-10-23「都要」）；超级管理员仍不可限制 |
| POST | /student/:id/unban | 解除限制：`login` / `sync` / `gps` / `all` |
| POST | /student/:id/unbind-wechat | **解绑微信**（用户 2026-10-23 新增）：清 openid / wx_sessions / deviceToken，运动等业务数据保留；未绑定 → `400` |
| GET | /student/:id/badges | 徽章抽屉数据源（已获得 + 全部启用中的定义） |
| POST | /student/:id/badges | 发放徽章（幂等；教师账号与未绑微信的账号会被拒绝） |
| DELETE | /student/:id/badges/:key | 回收徽章（幂等） |
| PUT | /sanitary | 本班卫生区归属：**班主任与班委都能勾选已有区域**；`newAreas`（就地新建全校区域）仅班主任，班委传 → `403 403002` |
| DELETE | /student/:id | 删除账户及其全部运动/饮水/徽章/住宿数据（不可恢复）。**班主任默认 `403 403002`**（见 `HOMEROOM_CAN_DELETE`）：级联删除属校级处置，班主任应改用「转移」把学生调出本班 |

### 班主任 / 班委的权限分界（用户 2026-10-23）

| 能力 | 班主任 | 班委 |
|---|---|---|
| 编辑资料（基础信息） | ✅ | ❌ |
| 重置密码 / 解绑微信 / 限制·解除 | ✅（含限制登录） | ❌ |
| 发放 / 回收徽章 | ✅ | ❌ |
| 学生宿舍（安排 / 换房 / 退宿） | ✅ | ✅ |
| 卫生区（勾选本班归属） | ✅ | ✅ |
| 卫生区（就地新建全校区域） | ✅ | ❌ |
| 教室 | ✅ | ✅ |
| 班级配置（早操/早八/晚自习/备注） | ✅ | ❌ |
| 删除账户 | ❌（校级处置） | ❌ |

判定实现：学生账号操作走 `loadHomeroomTarget`（班主任专属 + 目标不得持管理权限）；
宿舍走 `loadClassStudentTarget`（班主任与班委都放行，不检查目标权限 —— 只写宿舍，不碰账号与权限）；
卫生区与教室走 `resolveScope`（本班即可，但教室端点只接受 classroom 一个字段）。

约束（实现：`services/student-scope.js`，路由与判定都只有一份）：
① **学生账号操作**只有班主任能写，班委 `403`；宿舍与卫生区班委也可以（见上表）；
② 目标必须是**普通学生** —— 持任何管理权限的学生由管理员处置（否则班主任可重置/删除一个学生身份的管理员）；
③ 目标班级必须在 `homeroomClasses` / 班委自己的班里，跨班 `403`；
④ 实现与管理端**共用同一份 service**（`user-account-admin` / `user-badges-manual` / `student-dorm`），
   不允许在班级域另写一套（否则会出现「管理端吊销设备令牌、班级域不吊销」这类分裂）。
⑤ **楼名不是权限**：班主任/教务处填教室与宿舍只需要 `class.view` 或班级身份，
   楼名清单由 `GET /class/buildings`（登录即可读）与宿舍面板一起提供；
   楼名的增删改仍然只属于 `building.manage`（宿管），两者刻意分开。
⑥ **能力表 `capabilities`**（`GET /student/:id/manage` 下发，前端只照着画按钮，
   不要在前端再各判一遍 —— 用户 2026-10-23「删除账户他没有这个权限请你不要显示」）：

   | 字段 | 默认 | 说明 |
   |---|---|---|
   | `editProfile` | ✅ | 姓名 / 性别 / 生日（学籍字段仍归管理员） |
   | `resetPassword` | ✅ | 重置为该生初始密码 |
   | `badges` | ✅ | 发放 / 回收 |
   | `ban` / `unban` | ✅ | 限制 / 解除（`login` / `sync` / `gps` 全部） |
   | `dorm` | ✅ | 安排 / 退宿 |
   | `unbindWechat` | ✅ | 解绑本班学生的微信（用户 2026-10-23 新增） |
   | `deleteAccount` | ❌ | **开关 `HOMEROOM_CAN_DELETE`**；关闭时服务端真的回 `403`，前端也不画按钮 |

   改开关一处即可，路由与前端都跟着变（前端读同一份 capabilities）。
   宿舍与卫生区不走 `capabilities`（班委也有），由前端 `canManageDorms` / `canManageAreas` 控制，
   服务端分别用 `loadClassStudentTarget` 与「`newAreas` 仅班主任」两道校验对应。


## 管理端 /api/admin（JWT + role=admin）

| 模块 | 路径 |
|---|---|
| 看板 | `GET /dashboard/overview` · `GET /dashboard/trend?days=30` |
| 用户 | `GET /users?keyword&status&page&banSource` · `GET /users/:id`（含流水） · `POST /users/:id/ban {reason,days}` · `POST /users/:id/unban` |

##### 封禁来源分类（用户 2026-10-30「封禁用户要有分类 如人封、机封、AI封」）

`source` 与 `operator` **正交**：operator 记「谁执行」（追责），source 记「凭什么判定」（分类）。
历史数据里 operator 只有 `system` / 管理员 openid 两种，已无法还原规则判定与模型判定，故必须新增字段。

| 值 | 文案 | 触发者 |
|---|---|---|
| `manual` | 人封 | 管理员 / 班主任手动处置 |
| `ai` | AI封 | AI 模型判定达到自动封禁线 |
| `rule` | 机封 | 确定性规则（单次暴增超阈值 / 配速低于阈值） |
| `legacy` | 早期 | 老记录 source 缺失且 operator=system，**无法还原规则还是 AI**（不猜，单列一项） |

· 筛选 `?banSource=manual|ai|rule|legacy`（与 `status=banned` 是「与」关系，可叠加）
· 每行带 `banInfo = { source, sourceText, sources[{scope,source,sourceText}], mixed, reason, until }`
· `GET /users/filters` 返回 `banSources[]`（选项 + 全库计数）；列表带 `withFacets=1` 时
  `facets.banSource = {manual,ai,rule,legacy}` 随其它筛选实时变化（三者共用一份条件）
· 文案由服务端 `models/ban-record.js::SOURCE_TEXT` 单点定义并随接口下发 `sourceText`，
  前端只 `sourceText || 本地兜底` —— 前端各映射一份中文必然与服务端漂移
| 申诉 | `GET /appeals?status` · `POST /appeals/:id/review {approve, reply}`（通过即解封） |
| 广告 | `/ads/sponsors | /ads/slots | /ads/contents | /ads/pages` 的增删改查；`GET /ads/stats?contentId&sponsorId&start&end`；`GET /ads/pages-link/:id` |
| 内容 | `/content/announcements | /content/changelogs | /content/holidays | /content/organizations | /content/badges` 的增删改查 |
| 配置 | `GET|PUT /config`（目标/分时段/反作弊/激励视频） |
| 班级 | `GET /class/profiles`（台账列表） · `GET|PUT /class/:className/profile` · **`GET /class/status-board?days=7&quick&department&keyword`**（全校班级状态总览，见下） |
| 上传 | `POST /upload`（multipart，字段 file，返回图片 URL） |

### GET /api/admin/class/status-board（班级状态总览）

用户 2026-10-29「增加班级状态页面显示所有班级的考勤、校园跑达标(日、周)，
并且可以复制到文本如未达标班级等」；2026-10-30 加筛选「复制时复制的是筛选后的相应内容」。
权限：`class.view`（只读，不写任何数据）。

查询参数：

| 参数 | 说明 |
|---|---|
| `days` | 考勤回看天数（默认 7） |
| `today` | 统计日 `YYYY-MM-DD`（默认今天） |
| `quick` | 快捷筛选：`notDaily` 今日未达标 / `zeroToday` 今日零达标 / `notWeek` 本周未达标 / `attMissing` 考勤待补。**非法值忽略**（等于不筛） |
| `department` | 系部精确匹配 |
| `keyword` | 班名 / 系部 模糊（服务端已转义正则元字符） |

响应要点：

| 字段 | 说明 |
|---|---|
| `today` / `from` / `weekStart` / `days` | 统计日、考勤回看区间、本周起点（ISO 周一）、区间天数 |
| `totals` | **全校口径**（不随筛选变）：`classCount / studentCount / achievedToday / achievedWeek / dailyRate / weeklyRate / skippedClasses` |
| `rows[]` | 逐班：`run{achievedToday,dailyRate,achievedWeek,weeklyRate,enabled,stepsToday}`、`attendance{modules,ratePercent,hasData}`、`flags`。**有筛选时只含筛出的行** |
| `departments[]` | 系部候选（取自实际有数据的班，不查组织架构） |
| `filtered` | **筛选后小计**（与 `rows` 同集合）；未筛选时等于 `totals` |
| `activeFilters[]` | 生效的筛选标签（如 `['今日未达标','机电建工系']`）；空数组 = 未筛选 |
| `notAchieved` | `daily[] / weekly[] / attendanceMissing[]`（**已排除** 不参跑班、空班、无达标率的班，避免误报） |
| `copyText` | **服务端生成**的可直接粘贴文本。未筛选 = 全校完整报告；有筛选 = **只列筛出的行**并在标题写明筛选条件与班数，另附一行全校对照 |

口径（实现 `services/class-status-board.js`，前端不做二次计算）：
① 只统计 `status==='normal'` 的班（实习/毕业班不参与考勤与校园跑）；
② 达标 = 生效目标（个人计划优先、否则全局默认）且步数 ≥ 目标；
③ 考勤按**应到人数加权**（早操/晚自习用 `shouldCount`、查宿用 `shouldStay`；早八只记迟到人数、无比率）；
④ **筛选在服务端做**（缓存存全量、筛选在内存）：文案必须服务端单点生成，
若筛选在前端、文案在服务端，两者用的是不同行集合，复制出去仍是全量报告。

## 其他

- `GET /health` 健康检查
- `GET /` 与 `GET /console`：Web 控制台（反作弊状态台 + AI 训练台），账号密码登录
  （内存会话 + HttpOnly Cookie，**与小程序 JWT 隔离**）；接口在 `/console/api/*`
- `GET /p/:slug` 广告落地页 HTML 直出
- `GET /uploads/*` 上传文件静态服务
