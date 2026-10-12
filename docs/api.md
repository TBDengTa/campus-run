# API 说明

统一响应：`{ code: 0, message: "ok", data }`；错误时 HTTP 状态码 + `{ code, message }`。
鉴权：`Authorization: Bearer <JWT>`。401 未登录/过期；403 + code 403001 账号封禁、403002 非管理员。

## 认证 /api/auth

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /login | `{code}` → code2session，返回 `{token, isNew, userInfo}` |
| GET | /me | 当前用户（含 isClassMonitor） |
| PUT | /profile | 更新 nickname/avatarUrl/realName/studentId/className/specialty/gender/birthdate |
| PUT | /school | 绑定 `{schoolId, departmentId, className}` |

## 跑步 /api/run

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /today | 今日记录 + 生效目标 + 分时段应达百分比 |
| GET | /calendar?month=YYYY-MM | 月度记录 + 节假日 |
| GET | /week | 近 7 天记录 |
| POST | /sync-werun | `{encryptedData, iv}` → 解密微信运动并逐日 upsert（反作弊步数暴增检测） |
| POST | /gps | 提交 GPS 实跑（反作弊配速检测） |
| GET | /detail/:id | 记录详情（含轨迹） |

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
