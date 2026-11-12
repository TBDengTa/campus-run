# EO（边缘加速）流量排查与防护说明

> 背景：2026-11-09 用户「严重怀疑会时不时上传数据，因为有腾讯云的 EO」。
> 对服务端 / 小程序全量代码做了一次外呼排查，结论与防护措施都记录在这里。
> 改 EO 链路相关代码（缓存头 / gzip / 上传）前先读本文。

## 一、排查结论：代码里没有任何「隐匿 / 定时上传数据」的行为

| 排查面 | 结论 |
|---|---|
| 服务端出站调用 | **仅 1 处**：`server/src/services/wechat.js` 登录时调微信官方 `jscode2session`（请求驱动，换 openid，非定时）。无 axios / COS / 腾讯云 SDK，`server/package.json` 仅 8 个干净依赖，无任何自带遥测的包 |
| 服务端定时任务 | 无 `setInterval`、无 node-cron、systemd 无 Timer。唯一 30 秒轮询是 Web 控制台页面刷新**自己的**同源接口（浏览器 → 源站） |
| 小程序外呼 | 所有 `wx.request` / `wx.uploadFile` 收敛在 `utils/request.js` 单一出口、单一业务域名；无统计 SDK、无插件、无心跳轮询（仅有的 2 个 `setInterval` 是跑步计时与开屏倒计时，纯 UI） |
| 小程序自动上传 | 唯一一处 = 进首页自动同步微信步数（`pages/home/home.js`，约 1-2KB 密文，5 分钟间隔 + 页面存活期 1 次双重护栏）。GPS 轨迹只在用户点「完成」时一次上传，跑步中（含锁屏后台）只本地累积不上网 |

EO 上看到的流量方向是**入站**，全部能对应到真实业务请求。若发现
「EO → 源站」方向出现无法解释的持续外发流量，先怀疑部署环境被动了手脚
（比对 `deploy/nginx/*.conf` 与线上实际配置），不要在业务代码里找。

## 二、流量构成（谁在产生流量/请求数）

| 请求 | 时机 | 量级 | 说明 |
|---|---|---|---|
| 首页 onShow 全量刷新（6 GET + 1 POST） | 每次进首页（含切 tab 来回） | 小 JSON × 7 | 已加 30 秒节流（`HOME_REFRESH_MIN_GAP`），这是**请求数**的最大来源 |
| `POST /api/run/sync-werun` | 进首页自动同步步数 | 1-2KB 密文 | 业务必需，已有双重护栏 |
| `POST /api/upload/check-photo` 等上传 | 学生会检查拍照等用户操作 | **单张可达 100MB** | 上行/回源流量的最大来源；上限是 2026-10-28 用户明确要求保留的，不要顺手调小 |
| `GET /uploads/*`（头像 / 检查照片 / 广告图） | 页面渲染 | 图片大小 | nginx 直出 + 7 天缓存 + immutable，EO 命中后不回源 |
| `POST /api/ads/:id/pv` | 广告素材曝光 | 极小 | 静默埋点 |
| Excel 名单导入 / 头像 / 广告素材上传 | 管理端操作 | 中 | 用户主动触发 |

## 三、已落地的防护（2026-11-09）

1. **`/api/*` 全局 `Cache-Control: no-store`**（`server/src/app.js`，挂在 API 路由挂载前）：
   之前 20 组 API 路由没有任何缓存头，「会不会被边缘缓存」全听 EO 默认规则 ——
   一旦缓存了 GET 响应，学生拿到旧榜单/旧公告（脏数据），源站还被白扣回源流量。
   `/health` 同步加了 no-store（探活必须打源站，缓存了 200 等于没探）。
2. **`/p/:slug` 落地页 `public, max-age=60`**：管理端可改的内容给 1 分钟短缓存，
   平衡「改完生效」与「不每次回源」。曝光统计走 `/api/ads/*`（no-store 域）不受影响。
3. **nginx 全链路 gzip**（`deploy/nginx/*.conf`）：`gzip_proxied any` 让反代到 Node 的
   JSON 响应也压缩，EO 回源同样吃到压缩（JSON 压缩比通常 5~10 倍）。
   刻意**不在 Node 端加 compression 依赖**：nginx 统一压，零新依赖、不会双重压缩。
   图片不在 `gzip_types` 里（JPEG/PNG 本身已压缩，再压白费 CPU）。
4. **`/uploads` 追加 `immutable`**：文件名是内容 SHA，内容永不变，边缘整个缓存期内
   不必回源校验；头像换新 = 新 SHA = 新 URL，不存在「改了内容缓存没刷」。
5. **首页 30 秒节流**（`miniprogram/pages/home/home.js::HOME_REFRESH_MIN_GAP`）：
   节流只挂在 onShow 入口；下拉刷新、步数同步触发的 `refresh()` 不受限；
   时间戳记在 refresh() 成功路径末尾，失败不占坑。

## 四、EO 控制台自查清单（人工核对，代码侧管不到）

1. **缓存模式必须是「遵循源站」**：源站已对 `/api/*` 发 `no-store`、对 `/uploads/*` 发
   `max-age=604800, immutable`。若 EO 配了「强制缓存 / 忽略源站头」，源站头会被无视 ——
   强制缓存规则只应对 `/uploads` 这类静态路径，绝不能对 `/api/*` 与 `/p/` 开。
2. **按「加速流量 vs 回源流量 × 路径」拆分看流量**：回源流量应与 nginx access log 对得上；
   「EO → 源站」方向（若可见）不应有任何主动外发。
3. **上行流量对应上传接口**：检查照片单张上限 100MB（`.env` 的 `CHECK_PHOTO_MAX_MB`
   可调，三层对齐：前端 `PHOTO_SAFE_BYTES` / multer / nginx `client_max_body_size 128m`），
   调整时三层必须同时改，否则报错不可读（见 `server/src/routes/upload.js` 文件头）。

## 五、服务器侧排查命令

```bash
# top 请求路径（按次数）—— 与 EO 请求数对账
awk '{print $7}' /var/log/nginx/campus-run.access.log | sort | uniq -c | sort -rn | head -30

# 上传接口（上行流量大头）最近 1000 行
grep -E 'POST /api/upload|POST /api/admin/upload' /var/log/nginx/campus-run.access.log | tail -1000

# 部署后验证 gzip 生效（应看到 content-encoding: gzip）
curl -sI -H 'Accept-Encoding: gzip' https://<业务域名>/api/content/announcements | grep -i 'content-encoding\|cache-control'

# 验证探活缓存头（应看到 cache-control: no-store）
curl -sI https://<业务域名>/health | grep -i cache-control
```

> 红线提醒：本文与所有文档一样**不出现真实域名与凭据**；示例 URL 一律用 `<业务域名>` 占位。
