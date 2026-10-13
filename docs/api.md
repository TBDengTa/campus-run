# API 说明

统一响应：`{ code: 0, message: "ok", data }`；错误时 HTTP 状态码 + `{ code, message }`。
鉴权：`Authorization: Bearer <JWT>`。401 未登录/过期；403 + code 403001 账号封禁、403002 非管理员 / 无权限、403003 教师账号不参与运动记录。

## 认证 /api/auth

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /login | `{code}` → code2session。已绑定 → `{token, deviceToken, bound:true, mustChangePassword, userInfo}`；未绑定 → `{token, bound:false}`（游客 token，仅可访问 `/api/auth/*`） |
| POST | /bind | 游客 token + `{account, password}` → 绑定当前微信并返回正式 token（含 `deviceToken`）。一个账号只认第一个绑定的微信，重复绑定返回 `403 403004` |
| POST | /device-login | `{deviceToken}` → 一键登录。令牌用后轮换（返回新的 `deviceToken`，旧令牌立即失效）；失效返回 `401 401001` |
| POST | /device-revoke | `{deviceToken}` → 撤销该设备令牌（登录页删除历史登录记录时调用） |
| GET | /me | 当前用户（含 isClassMonitor） |
| PUT | /profile | 更新 `nickname/avatarUrl/gender/birthdate`；**学籍字段（realName/studentId/院系/专业/班级/年级）来自名单，提交即 `403 403005`** |
| PUT | /school | 绑定 `{schoolId, departmentId, className}`；**学生调用返回 `403 403005`** |

## 跑步 /api/run

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /today | 今日记录 + 生效目标 + 分时段应达百分比 |
| GET | /calendar?month=YYYY-MM | 月度记录 + 节假日 |
| GET | /week | 近 7 天记录 |
| POST | /sync-werun | `{encryptedData, iv}` → 解密微信运动并逐日 upsert（反作弊步数暴增检测） |
| POST | /gps | 提交 GPS 实跑（反作弊配速检测） |
| GET | /detail/:id | 记录详情（含轨迹） |

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

## 管理端 /api/admin（JWT + role=admin）

| 模块 | 路径 |
|---|---|
| 看板 | `GET /dashboard/overview` · `GET /dashboard/trend?days=30` |
| 用户 | `GET /users?keyword&status&page` · `GET /users/:id`（含流水） · `POST /users/:id/ban {reason,days}` · `POST /users/:id/unban` |
| 申诉 | `GET /appeals?status` · `POST /appeals/:id/review {approve, reply}`（通过即解封） |
| 广告 | `/ads/sponsors | /ads/slots | /ads/contents | /ads/pages` 的增删改查；`GET /ads/stats?contentId&sponsorId&start&end`；`GET /ads/pages-link/:id` |
| 内容 | `/content/announcements | /content/changelogs | /content/holidays | /content/organizations | /content/badges` 的增删改查 |
| 配置 | `GET|PUT /config`（目标/分时段/反作弊/激励视频） |
| 上传 | `POST /upload`（multipart，字段 file，返回图片 URL） |

## 其他

- `GET /health` 健康检查
- `GET /p/:slug` 广告落地页 HTML 直出
- `GET /uploads/*` 上传文件静态服务
