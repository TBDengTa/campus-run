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

## 角色与权限（RBAC）
- 用户角色只有 `student` / `teacher`；"管理员"= 持有 `superadmin` 权限组（permissions 含 `'*'`）。
- 权限 = 独立权限项（permissions 集合目录）+ 权限组（permission_groups 集合）；用户有效权限 = `user.permissions` ∪ 所在组展开，`'*'` 通配。
- 管理端路由一律用 `requirePermission('xxx')` 挂载（见 `src/routes/admin/index.js`），禁止只靠前端隐藏入口。
- 新增管理能力时：先在 `Permission.DEFAULT_CATALOG` 加权限项（启动自动播种），再挂到对应路由。
- 本地测试登录：后端 `DEV_LOGIN=true` + 前端 `env.js` `DEV_LOGIN: true, DEV_ROLE: 'dev-student|dev-teacher|dev-admin'`；生产必须关闭。

## 迁移
- 旧库（1.0）只读；任何迁移通过 `server/scripts/migrate-v1-to-v2.js`，先 `--dry-run` 再正式执行。
