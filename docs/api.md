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

记录来源 `source`：`werun` 微信运动 / `gps` GPS 实跑 / `beidou` 北斗（转盘抽奖与签到阶梯奖励的步数）。
前端统一用 `utils/format.js::sourceOf(source)` 取展示文案与图标（勿各页各写三元表达式）。

> **教师账号不参与运动记录**：`role=teacher` 调用 `/sync-werun`、`/gps` 一律返回 `403 + code 403003`；
> `/api/reward-video/report` 返回 `200 + {success:false}`。服务层（`services/steps.js`）同步做了二次拦截。

## 排行榜 /api/ranking

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /?range=day\|week\|total&scope=school\|department\|class | 步数榜单 |

- `range`：`today` 今日榜 · `week` 本周榜（自然周，周一起） · `total` 总榜，默认 `today`。
- `scope`：`all` 全校（默认） · `school` 本院系（校区） · `department` 本系部 · `class` 本班。
  **匹配口径 = 「id 为主、名字兜底」**（唯一实现 `services/ranking-scope.js`）：名单导入只写
  `schoolName` / `departmentName`，`schoolId` / `departmentId` 只在学生认证绑组织架构时才有，
  所以只要**任一存在**该范围就可选，过滤时两种存法都算命中（同名系部再用院校消歧）。
  该范围所需字段全都没有时返回 400（`尚未绑定系部/院系/班级…`）。
- 返回：`{ kind, range, scope, metricText, rangeText, scopeText, unit, date, excluded, excludedReason, participants, list[], me{}, scopes[] }`
  - `list[]`：个人榜 `{ rank, userOpenid, name, className, planName, steps, distanceKm, value, valueText }`，
    班级榜 `{ rank, className, value, steps, members }`，最多 50 条。
  - `me`：个人榜 `{ rank|null, value, valueText, steps, distanceKm, name, className }`；
    班级榜 `{ rank|null, className, value, valueText, steps, members }`。
  - `scopes[]`：`{ key, label, available, needText }`，前端据此置灰不可用范围，
    **不可用时的提示文案直接用 `needText`**（前端不自己拼中文）。
- **教师账号不参与排名**：`role=teacher` 不出现在任何榜单（`excluded: true`、`me.rank` 恒为 `null`），但仍可查看榜单。
- 隐私：不返回 `openid`，仅返回用户 `_id` 与展示用昵称/头像；已封禁用户不参与排名。

## 目标 /api/goal

`GET /effective` 生效目标 · `GET /plans` 预设计划 · `GET|POST /body-data` 身体数据（保存即算 BMI 并自动匹配计划） · `GET /my-plan` 我的计划

## 激励视频 /api/reward-video（**已降级**）

`GET /today` 今日次数/剩余（保留给老客户端展示） · `POST /report` **只回 `{success:false, deprecated:true}`，不再发步数**。

> 北斗运动 2.0 起，「看视频」不再直接发步数；v3 起改为发 **1 铜版**（见下方 `/api/beidou`）。
> 旧接口刻意保留而不下线：老版本小程序缓存未更新时仍会调用，直接 404 会让它们弹错误框；
> 回一句「已升级」既不会误伤，也不会被静默利用继续刷步。

## 北斗运动 /api/beidou（铜版经济 + 转盘 + 九宫格连线）

方案与口径唯一说明：`docs/beidou-economy-plan.md`（v2 旧方案见 `docs/beidou-lottery-plan.md`，冲突处以 v3 为准）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /today | 首屏一次拿全：铜版余额/今日产出、转盘（成本/次数/奖池/扇区/保底）、九宫格（成本/图案权重/单线奖/保底）、看视频/分享/签到、封顶、今日步数、最近 5 条 |
| POST | /draw | `{drawId}` → 转盘，扣铜版；返回 `{index, prize, capped, coinCapped, pity, cost, balance, coin, remaining, earned, newBadges}` |
| POST | /grid/play | `{playId}` → 九宫格，扣铜版；返回 `{board, lines, rewards, coinAmount, stepsAmount, rewardText, prize, cost, balance, capped, coinCapped, pity}` |
| POST | /video/report | `{watchId}` → +铜版（不发次数/步数）；同一 watchId 幂等 |
| POST | /checkin | 连续签到 → +铜版（不发次数/步数） |
| POST | /share/intent | 生成/复用当日分享令牌 → `{token, path, expiresAt}` |
| POST | /share/click | `{token}` → 好友点开上报；只有另一个已登录用户点开才给分享者发铜版 |
| POST | /share/report | **旧接口保留**，只回 `{success:false, deprecated:true}` |
| GET | /winners?limit=20 | 播报：`{items:[{nameMasked,prizeLabel,game,rarity,linesText,atText,isMine}], rarityText}` |

口径：

- **任务只发铜版**：看视频/签到/分享不再加抽奖次数、不写 `run_records`。分享必须好友点开（自己点、重复点、超限、过期都不发）。
- **两个玩法都扣铜版、都可能发铜版**：转盘 5/次、九宫格 6/次（可配）；`draw` 类型按本局成本返还。
- **结果只由服务端定**：转盘 `roll/index/prize`、九宫格 `board/lines/rewards` 全在服务端；前端只停位/翻牌。
- **九宫格是老虎机式随机盘面**：横/竖/斜 8 条线，每条线发该图案单线奖；可同时中多条线（含铜版+步数混合），空白成线不兑奖。
- **保底**：连续未中到阈值后下一局必中低档奖；两个玩法独立计数，中奖清零。
- **上限**：`economy.dailyGameCoinCap`（游戏铜版产出）、`draw.dailyStepsCap`（步数）、任务/分享每日上限；余额永不为负。
- **旧字段兼容**：`draw.remaining/total/used/maxPerDay/prizes/sectors`、`video.drawPerWatch`、`share.drawPerShare`、`checkin.milestones[].draw/steps` 继续下发（旧任务字段为 0，旧客户端不会多发次数）。

**管理端**（`/api/admin/config/*`，读要 `config.view`、写要 `config.manage`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | / | 返回 `beidou` 可编辑配置 + `beidouEffective`（归一概率/EV/警告） |
| PUT | / | 保存 `beidou`（`normalizeBeidouInput` 夹紧；数组整体替换） |
| POST | /beidou-preview | 用**与保存同一份**归一/EV 逻辑预览草稿 + 警告（不写库） |
| GET | /beidou-draws | 游戏流水，只读；`dateFrom/dateTo/game/source/prizeKey/type` 筛选 + 分面 |
| GET | /beidou-coin-logs | 铜版流水，只读；日期/来源/游戏/方向 + 合计 + 分面 |
| GET | /beidou-economy | 流通量、区间发放/回收、按来源、按玩法局数/消耗/产出/保底/返奖率 |
| GET | /beidou-draws/sources | 来源口径说明（v3 铜版为合并钱包，新流水 source=wallet；旧记录来源仅历史） |

> `source` 在 v3 新记录里统一为 `wallet`：铜版是**合并钱包**，无法像旧「次数池」那样归属到单一来源。
> 要看当前产出结构请用「铜版流水 / 经济概览」。旧记录仍保留 `video/share/checkin/prize/unknown`。

教师/限制账号与 `/api/reward-video` 一致：教师 → `200 + {success:false}`；限制登录 → `403 403001`；微信同步受限 → `403 403004`。

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
| 班级 | `GET /class/profiles`（台账列表） · `GET|PUT /class/:className/profile` · **`GET /class/status-board?attRange=week&quick&department&keyword`**（全校班级状态总览，见下） · **`GET /class/status-export?attRange=week|month&…`**（导出考勤 CSV，同下筛选参数） |
| 上传 | `POST /upload`（multipart，字段 file，返回图片 URL；用途 `ad/badge/beidou/other`；`POST /upload/check-photo` 检查照片**不限体积 / 张数**） |

### GET /api/admin/class/status-board（班级状态总览）

用户 2026-10-29「增加班级状态页面显示所有班级的考勤、校园跑达标(日、周)，
并且可以复制到文本如未达标班级等」；2026-10-30 加筛选「复制时复制的是筛选后的相应内容」。
权限：`class.view`（只读，不写任何数据）。

查询参数：

| 参数 | 说明 |
|---|---|
| `days` | **已废弃**（2026-11-12 起不再参与计算，传了也回退 `attRange=week`；旧的「考勤回看 N 天」口径已被用户否掉） |
| `attRange` | 考勤统计窗口：`day` 本日 / `week` 本周（缺省）/ `month` 本月。起止由服务端 `attWindow` 按所选日锚定（本周 = ISO 周一起至周日；本月 = 1 号至月末），**前端不许自算周/月起点** |
| `today` | 统计日 `YYYY-MM-DD`（默认今天） |
| `school` | 院校（**与 `department` 成对使用**：实测多校区都有「计财系」，只按系部筛会跨校区混出） |
| `department` | 系部。未传 `school` 时按同名全筛，`activeFilters` 会标注「各校区同名」如实提示 |
| `quick` | 快捷筛选：`notDaily` / `zeroToday` / `notWeek` / `attMissing`。**非法值忽略**（等于不筛）；与 `level` 互斥，同时传入时 `quick` 优先 |
| `grades` | **年级多选**（2026-11-03）：逗号分隔的 `YYYY`（如 `grades=2023,2024`），只认 4 位年份，其余丢弃；年级口径 = `class_profiles.grade` 优先、按班名「23级XX」解析兜底 |
| `level` | 达标档位：`notFull` 未达标 / `below95` 低于95%（2026-11-03 替代「低于一半」）/ `zero` 零达标。与 `metric` 组合（如「日达标零达标」）。**没有这个档位时「今日未达标」会筛出全部班级**（今日全校达标率个位数，没有班到 100%），等于没筛 |
| `metric` | 档位针对的指标：`daily`（默认）/ `weekly` |
| `keyword` | 班名 / 系部 / 院校 模糊（服务端已转义正则元字符） |
| `copy` | **复制口径**（2026-11-20 第三轮起由前端**按显示列派生**，不再由用户手选）：`all` 全部指标（默认）/ `daily` 只要日达标 / `weekly` 只要周达标 / `att` 只写班超分报告（逐行含「日均扣 / 区间合计扣 / 主因」）。收窄后 `copyText` 的标题与正文都不再出现其它指标 |
| `att` | 是否显示「班超分」列：`1`（默认）/ `0`。`0` 时 `copyText` 不写每行班超分、「考勤待补」段与考勤计算规则 —— 复制必须与屏幕上的列一致（用户 2026-11-20「去掉显示中的复制，上面的复制已经自动识别了显示内容」）。导出 CSV 不使用该参数 |

响应要点：

| 字段 | 说明 |
|---|---|
| `today` / `from` / `to` / `weekStart` / `attRange` | 统计日、考勤窗口起止（`to` 是**完整周/月窗口终点**，不是所选日）、本周起点（ISO 周一）、窗口 key |
| `totals` | **全校口径**（不随筛选变）：`classCount / studentCount / achievedToday / achievedWeek / dailyRate / weeklyRate / skippedClasses` |
| `rows[]` | 逐班：`className / schoolName / departmentName / grade / studentCount`、`run{achievedToday,dailyRate,achievedWeek,weeklyRate,enabled,avgSteps}`、`attendance{modules,ratePercent,score,deduct,deductTotal,dayCount,deductDetail[],lateCount,hasData,hasAnyCheck}`、`flags`。**有筛选时只含筛出的行**；行序 = 年级升序 → 班级名（2026-11-03，空年级排末尾）。⚠️ `attendance.score` = 班超分（与班超总评同一实现，**含卫生/查宿**）；`deduct` = 日均扣分、`deductTotal` = 窗口合计扣分（2026-11-20 第三轮「日均/合计」切换的数据源，`dayCount` = 有记录天数）；`deductDetail[]` 每项 `{key,name,deduct,totalDeduct,targets[]}`，`targets` 是「模块 × 受检类型」明细 `{name,avgDeduct,totalDeduct,count}`（如 `卫生-宿舍`），两套口径分别调平到模块的 `avgDeduct` / `deduct` |
| `hasAnyCheck` | **全量行**里是否有任意检查记录（筛选不改变它）。前端据此决定「班超分」列与「班超分范围」次级筛选是否可用 —— 曾用筛选后的行现算，导致一筛选范围行/班超分列就消失（用户 2026-11-20 报障的真因） |
| `schools[]` / `departments[]` / `grades[]` | 院校 / 系部 / 年级候选（取自实际有数据的班，不查组织架构；年级已含班名解析兜底） |
| `filtered` | **筛选后小计**（与 `rows` 同集合）；未筛选时等于 `totals` |
| `activeFilters[]` | 生效的筛选标签（如 `['北校区','计财系','日达标零达标']`）；空数组 = 未筛选 |
| `copyScope` / `withAtt` | 回显生效的复制口径与「是否写了班超分」（前端复制成功提示直接用，不自己映射） |
| `notAchieved` | `daily[] / weekly[] / attendanceMissing[]`（**已排除** 不参跑班、空班、无达标率的班，避免误报） |
| `copyText` | **服务端生成**的可直接粘贴文本。未筛选 = 全校完整报告；有筛选 = **只列筛出的行**并在标题写明筛选条件与班数，另附一行全校对照；并按 `copy` 口径只写对应指标；`att=0` 时不写班超分/考勤待补/规则 |

口径（实现 `services/class-status-board.js`，前端不做二次计算）：
① 只统计 `status==='normal'` 的班（实习/毕业班不参与考勤与校园跑）；
② 达标 = 生效目标（个人计划优先、否则全局默认）且步数 ≥ 目标；
③ 考勤按**应到人数加权**（早操/晚自习用 `shouldCount`、查宿用 `shouldStay`；早八只记迟到人数、无比率）；
④ **筛选在服务端做**（缓存存全量、筛选在内存）：文案必须服务端单点生成，
若筛选在前端、文案在服务端，两者用的是不同行集合，复制出去仍是全量报告；
⑤ **次级筛选与显示联动**（2026-11-20 第三轮）：「班超分范围」（本日/本周/本月）与「口径」（日均/合计）只在**显示班超分列**时出现，数据全部来自服务端 `attRange` 窗口与 `deductTotal/dayCount`；本日窗口下合计=日均，前端隐藏口径开关。范围行是否可用由全局 `hasAnyCheck` 决定，**不随筛选行集变化**。

### GET /api/admin/class/status-export（导出工作簿：总标 + 每班明细 / CSV / JSON 预览）

用户 2026-11-20「班级状态中增加导出考勤表格本周、本月的各班考勤详细信息(包括校园跑)」，
同日定稿改版：**「总标」总览 + 每班一张「详细数据」sheet**。
权限：`class.view`（只读，不写库）。参数与 `status-board` **完全一致**（`attRange=week|month`、
`today`、院校/系部/年级/档位/关键词等），取参共用 `boardQuery`、筛选共用 `applyBoardFilter`；
**看板数字一律读 `classStatusBoard` 行数据（导出里不重算分数/出勤率/达标率）**，
校园跑区间统计（8 列）来自 run_records/goals 的独立聚合（窗口 = `from ~ min(to, 今天)`）。

| `format` | 返回 | 用途 |
|---|---|---|
| `xlsx`（新版小程序） | 完整工作簿（**exceljs 生成带样式**：品牌橙表头、隔行浅底、细边框、冻结首行/首列、自动筛选、班超分分段上色；附件名 `class-status-<today>.xlsx`） | **`总标` + 每班 `<className>详细数据` + `字段说明`**；微信 `wx.openDocument` 可直接预览（CSV 不支持，真机报「本机无法打开/转发失败」） |
| `csv`（缺省，向后兼容） | UTF-8 BOM CSV（`text/csv`） | 旧版小程序 / 脚本：只出「总标」23 列 |
| `json&preview=1&limit=N` | `{ title, subtitle, note, columns[{title,wch}], rows(截断), total, sheets, preview }` | 小程序「导出预览」弹层：生成文件前先看总标列/示例行/班数/将导出几张 sheet（不下发明细行） |

**总标标题（2026-11-20 第五轮）**：`2026年11月16日至2026年11月22日（本周）2026级-2025级班级状态总表`
（年级段只在**有年级筛选**时出现；多选按年份降序用「级-」连接，单选就是「2026级」）。

**Sheet1「总标」23 列（顺序固定）**：序号 / 院校 / 系部 / 专业 / 年级 / 学生数 / 住宿数 /
班委数 / 学生会成员数 / 卫生累计扣分 / 晚自习累计扣分 / 查宿累计扣分 / 早操累计扣分 /
早八累计扣分 / **班超分** / 校园跑班级日目标平均达标率 / 校园跑班级周目标平均达标率 /
校园跑班级日目标达标次数 / 校园跑班级周目标达标次数 / 校园跑班级日目标达标最低值 /
校园跑班级周目标达标最低值 / 校园跑累计步数 / 校园跑人均累计步数。
- 班超分取看板 `attendance.score`（唯一公式实现算好的值，导出不重算；无检查记录写空）；
- 五模块累计扣分取看板 `attendance.deductDetail[].totalDeduct`；校园跑「日/周」按班级整体口径：
  平均达标率 = 各日/各周班级达标率均值，**达标次数 = 达标率 100% 的天/周数**，
  最低值 = 各日/各周达标率最低值；累计步数为窗口内班级步数之和、人均 = ÷学生数。
- 学生数来自看板；住宿数 = `class_counts.liveCounts().dormCount`（在住）；班委数 = `users.isClassOfficer`；
  学生会成员数 = `union_members.status='active'` 按班级计数；专业取 `class_profiles.specialty`（缺行退学籍）。

**每班 `<className>详细数据` sheet（两块）**：
1. **区间考勤明细**（14 列）：日期 / 时段 / 模块 / 受检对象 / 应到 / 实到 /
   缺勤·未归·迟到名单（**姓名(病假/事假/公假)**，早八无假别）/ 得分 / 扣分 / 检查人 / 复核人 /
   状态 / 备注 / 照片数；只含 `status ∈ COUNTED` 且 `voided≠true` 的记录。
2. **校园跑每人数据**（9 列）：姓名 / 学号 / 日目标 / 周目标 / 达标天数 / 日达标率 /
   达标周数 / 周达标率 / 区间累计步数（目标 = 个人计划优先、否则全局默认）。

**Sheet 末尾「字段说明」**：逐列含义 + 筛选口径 + 导出时间 + 上限（总标 500 行 /
班级 sheet 500 张 / 区间考勤明细 5000 条，超出截断并注明）。

小程序端走 `utils/request.js::downloadAndOpen`：downloadFile → 保存到用户目录 →
`openDocument(fileType:'xlsx')`；本机预览器仍打不开则降级 `shareFileMessage`（成功即算成功）；
两条都失败时页面弹窗给「复制表格文本」兜底。

### 班级域（用户端 `/api/class/*`）的日期回看与当日全部检查记录（2026-11-20）

- **`GET /api/class/overview|students|ranking` 接受 `?date=YYYY-MM-DD`**：把所选日当作「今日」，
  周起点取该日所在 ISO 周（本周窗口 = 周一..所选日）。白名单校验，非法/缺省回落今天。
  `/students` 前端**不传** date（名单保持今天语义）。
- **`GET /api/union/class/:className` 新增** `dayRecords`（所选区间内全部模块记录，
  `status ∈ COUNTED`、`voided≠true`，单次上限 50）、`dayRecordsTotal`（同条件总数）、
  `dayRecordsRange{from,to}`；每条 = 列表版 `presentRecord`（**不含 `details`**、照片前 3 张）+
  `moduleName` + `roster`。`recent`（最近 10 条，全时间线）语义不变。

## 其他

- `GET /health` 健康检查
- `GET /` 与 `GET /console`：Web 控制台（反作弊状态台 + AI 训练台），账号密码登录
  （内存会话 + HttpOnly Cookie，**与小程序 JWT 隔离**）；接口在 `/console/api/*`
- `GET /p/:slug` 广告落地页 HTML 直出
- `GET /uploads/*` 上传文件静态服务
