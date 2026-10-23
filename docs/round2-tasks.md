# 班超 / 学生会 第二轮改造任务书（并行执行用）

> **状态：已全部完成（A–E 收工）**。本文件保留为**决策记录**：执行时哪些边界是刻意的、
> 哪些口径必须一致、以及最后如何验收。实现结论与验收清单见 `docs/student-union-plan.md` 的
> 「第二轮改造（已落地）」与「验收工具」两节。
>
> 本文件是**任务边界与口径的权威说明**，供多个 AI 智能体并行改造时对齐。
> 冲突原则：**只改「你的范围」里列出的文件；「禁止触碰」里的文件一律不改**，需要改动就在报告里提出。
> 通用约定见仓库根 `AGENTS.md`（白橙 `--tt-*` 令牌、登录闸门、`toSafeJSON()` 白名单、服务端判权为主）。

## 执行结果（用于复盘，勿删）

| Agent | 交付 | 过程中发现的问题 |
|---|---|---|
| A | members/config 三个抽屉改可滚动 | 指出 entry 的嵌套滚动根因在 person-picker（无权改，已上报） |
| B | `derived` 口径 + 班级配置双接口 + `/api/class/attendance` + `hasMorningRun` + 权限项 | 申请并获批一处越界（`models/check-module.js` 加 `derived`，否则 strict 模式四条写入路径都丢字段） |
| C | 录入台派生字段只读 + 考勤组件 | 自查出 `moduleFields()` 丢掉率字段的真 bug |
| D | 命名统一 + 管理中枢/首页分类 | 指出首页快捷操作挂在 `isManager` 下会对班主任/班委整组消失 |
| E | 班级管理四 tab + 配置双路径 | 指出 `pages` 里放 `"component": true` 的组件不规范 → 促成检查器规则修正 |

## 第三轮任务书（用户反馈驱动，3 个并行智能体）

> 触发原因：用户在实际使用中报了三个问题 —— ① 班级管理「院校」下拉只有「北校区」；
> ② 我的班级「班级配置」无法配置教室与卫生区；③ 用户详情的宿舍弹窗与班级宿舍弹窗形态不一致。

| 需求 | 范围（独占文件） | 关键口径 |
|---|---|---|
| ① 院校三源合并 | `server/src/routes/admin/class-profile.js`、`services/class-profiles.js`、`packageAdmin/class-manage/class-manage.{js,wxml,wxss}` | `facets.schools` = `organizations(type=school)` ∪ 台账 ∪ `User.distinct('schoolName')`；已配置但暂无班级的院校也要出现（否则"配了却看不到"= 本次报障）。`aggregateRoster` 的 `$first` 要改成**稳定取多数值**，并对同名班多校区冲突显式上报（不许静默） |
| ② 教师侧教室 + 卫生区 | `server/src/routes/class.js`、`packageAdmin/class/class.{js,wxml,wxss,json}` | 教室走 `PUT /profile`（已有 `classroom`）；卫生区新增班级域 `GET/PUT /sanitary`，**权限 = 班主任可写、班委只读、外人 403**（班级域不用 requirePermission）；只动本班在 `classNames`/`weights` 里的存在，**不动别的班**；支持就地新建区域 |
| ③ 宿舍弹窗统一 | 主包 `components/dorm-sheet/**`（新建）、`class-manage/dorms/**`、`user-detail/**` | 抽**主包**公共组件（既有 8 个组件都在主包，`class.json` 用绝对路径 `/components/attendance/...`；`lazyCodeLoading: requiredComponents`）；统一为「楼号·门号主输入 + 可选床位号 + 楼栋/本班常用房间 chips + 退宿/保存」，班级侧补上原本缺的床位号；**组件不发请求**，只抛事件 |

三条硬约束（与第二轮相同）：只改自己范围内的文件；共享的 `services/dorms.js`、`models/dorm-*` 只读复用；
组件不得放进分包新增目录（无先例），一律主包 + 绝对路径注册。

## 第四轮任务书（检查表单重构 + 照片隐私，用户反馈驱动）

> 触发：用户给出五个检查表单的完整新口径 + 宿舍照片隐私规则 + 主席团可录任意考勤 + 首页快捷操作去掉学生会分类。

| 需求 | 范围（独占文件） | 关键口径 |
|---|---|---|
| ① 首页快捷操作去掉「学生会」分类 | `utils/nav-groups.js`（新增 `homeGroups`）、`pages/home/home.js`、`tools/check-nav-groups.js` | **不能直接删 NAV_GROUPS 的分组** —— 那是管理中枢与首页共用的同一份数据源，删了会让持 `union.*` 权限的管理员失去入口。只在首页侧排除，且**持 union.* 权限者仍显示**（判定口径：纯身份成员才隐藏）。`hub.js` 保持用 `visibleGroups` 不变 |
| ② 五个表单新字段 | `server/src/services/check-modules.js` | 见下表。**存量库必须生效**（seedCheckModules 的更新策略是关键：不处理等于没改）；`FIELD_LIMIT` 仍在 DEFAULT_MODULES 之前（TDZ）；**不改公式引擎** |
| ③ 宿舍照片隐私 | `routes/union.js`、`services/union.js` | 宿舍照片仅**检查人 / 主席团 / 所属部门部长 / 教师账号**可见，其余人**不下发原图 URL**（`photos: []` + `photosBlurred` + `photoCount`）—— ⚠️ **"模糊"必须是不给原图 URL**，CSS 模糊一个真 URL 等于没做（抓包即得）。只在**宿舍**场景生效（`targetType='dorm_room'`）；教室/卫生区照片不受限 |
| ④ 主席团可录任意考勤 | `services/union.js::canEnterModule` | 主席团**短路部门归属检查**；校级全校、**分会限本校区展开范围**（不放开成全校）。其它角色行为逐字不变 |
| ⑤ 录入台渲染 + 照片上传 | `packageUnion/entry/**`、`routes/upload.js` | 新增 `type:'photo'`（≤9 张、选填）；新增成员可用的 `POST /api/upload/check-photo`（≤5MB，检查照片**不清理旧文件**，要留证）；`grade='网课'` 时隐藏并清空后续字段 |

**新字段契约**（`services/check-modules.js`，其它智能体据此实现）：

| 模块 | 受检对象 | 字段（顺序） |
|---|---|---|
| `hygiene` 卫生 | `['classroom','dorm_room','area']` | `grade`(优/良/差，必填) → `photos` → `remark`（**删掉 7 项打分制**） |
| `study_evening` 晚自习 | `['class']` | `grade`(优/良/差/**网课**) → `actualCount` → `absentList` → `reason` → `photos`；**`网课` 时后续字段清空且不校验必填**（班内无学生、在宿舍观看） |
| `night_dorm` 查宿 | `['dorm_room']` | `actualCount` → `absentList`（**宿内**搜索） → `reason` → `photos` |
| `morning_exercise` 早操 | `['class']` | `actualCount` → `absentList`（**班内**搜索） → `reason` → `photos` |
| `morning_class` 早八 | `['class']` | `lateList`（**校内**搜索） → `photos`；**只记迟到人**（无法同步课表）；迟到数用 `derived` 数字字段由 `lateList.length` 填。**没有记录 = 当天没人迟到**（2026-10-19 用户口径；`optionalWhenMissing: true` + `noRecordText: '无迟到'`）：不计入「应录 / 未录」统计、各页面显示「无迟到」而非「未录」，但录入台**仍列出**班级以便补录 |

> 人名搜索范围（用户原文）：晚自习/早操 = 班内；查宿 = 宿内；早八 = 校内（支持筛选）。
> 拍照**选填**（用户确认）；**旧记录保留、不做数据迁移**（用户确认）。

### 第四轮执行过程记录（复盘用）

- 智能体"检查表单字段"**第一次派单后一行未写就退出**（结束语是未完成的工作意向、文件时间戳未变）。
  已重新派单。→ 再次印证：**不能把 subagent 的 finished 当成交付**，必须核对目标文件的 mtime 与内容。
- 智能体"照片隐私 + 主席团录入"同样**未交报告**，但代码**已实际完成**（核实 `cropPhotos` /
  `photosBlurred` / `viewer` / `canEnterModule` 的主席团短路 + `inDepartmentScope` 单一实现处）→
  说明"无报告"既可能是什么都没做，也可能已完成，**必须逐项核对代码**。

**协调者（主 Agent）的失误记录**（写在这里是为了让后来人别重复）：
1. 用 `Get-Content | Set-Content` 管道批量替换源码 → `attendance.js` 被按本地代码页转码、丢换行，
   **无备份可恢复**，最终由原作者重建。（教训：改源码只用编辑工具或 Node 脚本，绝不用 shell 文本管道。）
2. 用 Node 脚本 `JSON.stringify` 整文件重写 `config.json` → 内容未丢，仅少一个末尾换行（已补）。
   同性质错误，因此给 `tools/check-miniprogram.js` 加了 **JS 语法解析 + U+FFFD 编码事故检测**，
   这类事故现在会当场报出来。

## 0. 本轮 6 项需求

| # | 需求 | 负责范围 |
|---|---|---|
| R1 | **弹窗 / 抽屉无法滚动** → 全部改造成可滚动 | A（+ 各页面 owner 在自己的抽屉里同步） |
| R2 | **早八应到人数已知** → 只记缺勤人数；其余模块同理（可推导人数的字段不让人填） | B（后端口径）+ C（前端展示） |
| R3 | 首页 / 我的入口命名统一为 **班级管理 / 学生会配置 / 学生会成员** | D |
| R4 | 管理中枢分类改为 **学生会**、**班级管理**；首页快捷操作重新分类与适配 | D |
| R5 | **班级配置**（新增「不跑操」标记：早操 + 校园跑） | B（接口）+ E（页面） |
| R6 | 独立班级管理页增加 4 个 tab：**学生名单 / 校园跑 / 班级考勤 / 班级配置** | E（+ C 提供班级考勤组件） |

## 1. 文件所有权（硬边界）

| Agent | 独占可改 | 禁止触碰 |
|---|---|---|
| **A 弹窗滚动** | `miniprogram/packageAdmin/union/members/*`、`miniprogram/packageAdmin/union/config/*`、`miniprogram/packageUnion/entry/*`、`miniprogram/packageUnion/records/*`、`miniprogram/packageUnion/record/*`、`miniprogram/packageUnion/roster/*`，以及自查发现的其它抽屉（改前在报告里列出） | `pages/**`、`server/**`、`app.json`、`custom-tab-bar/**` |
| **B 后端口径 + 班级配置** | `server/src/services/check-modules.js`、`server/src/routes/union.js`、`server/src/routes/admin/union.js`、`server/src/models/class-profile.js`、`server/src/routes/class.js` | `miniprogram/**`（除报告里建议）、其它 `server/src/**` |
| **C 录入台口径 + 班级考勤组件** | `miniprogram/packageUnion/entry/*`（与 A 协调：A 只动滚动容器结构，C 只动字段渲染与提交）、`miniprogram/packageUnion/attendance/*`（新建） | `pages/**`、`server/**`、`packageAdmin/**` |
| **D 导航与分类** | `miniprogram/pages/hub/*`、`miniprogram/pages/home/*`、`miniprogram/pages/profile/*`、`miniprogram/components/banchao-block/*` | `server/**`、`packageAdmin/**`、`packageUnion/**`、`custom-tab-bar/**` |
| **E 班级管理四 tab** | `miniprogram/packageAdmin/class/*` | `server/**`、`pages/**`、`packageUnion/entry/*`、`packageUnion/attendance/*`（只引用不改） |

> A 与 C 都涉及 `packageUnion/entry/`：约定 **A 只改滚动容器（抽屉结构）**，**C 只改字段渲染与提交逻辑**；谁先完成谁在报告里说明改过的行段。

## 2. 口径定义（必须一致）

### R2 人数口径（后端为准，前端只展示）

**原则：能从已知数推导出来的人数，一律不让用户填；由服务端推算并回写，前端只读展示。**

| 模块 | 用户填 | 服务端推算（写入 details，前端只读展示） | 公式 |
|---|---|---|---|
| 早操 `morning_exercise` | 应到、实到、请假 | `absentCount` | 应到 − 实到 − 请假（≥0） |
| 早八 `morning_class` | 应到、实到、请假、迟到 | `absentCount` | 应到 − 实到 − 请假（≥0） |
| 晚自习 `study_evening` | 应到、实到（教室）、宿舍网课、请假、插班进出、迟到、早退 | `absentCount` | 应到 + 插班净额 − 实到合计 − 请假（≥0） |
| 查宿 `night_dorm` | 应住、实住、请假、晚归、违规 | `notReturnedCount` | 应住 − 实住 − 请假（≥0） |
| 卫生 `hygiene` | 检查项得分、总评得分 | —（无人数推算） | — |

实现方式：字段定义里新增 **`derived: true`** 标记（`check_modules.fields[].derived`），
带该标记的字段**不出现在录入表单里**，只作为「计算结果」展示；管理端模块配置里也不能把它改成可填。

> 早八「应到人数」的默认值仍来自 `class_profiles.studentCount`（前端 `buildInitialForm` 已预填），
> 用户一般只需要改「实到」和「请假」两个数。

### R5「不跑操」标记

在 `class_profiles` 上扩展现有早操标记为**两项**，语义分开：

| 字段 | 含义 | 影响 |
|---|---|---|
| `hasMorningExercise` | 是否有早操（已有） | 早操模块的录入台对象、出勤率分母 |
| `hasMorningRun` | 是否参加**校园跑**（新增，默认 true） | 班级榜 / 校园跑相关统计、班级配置页 |

新增班级配置接口（B 负责）：`GET/PUT /api/admin/class/:className/profile`（`class.view` 读、`class.manage` 写），
字段：`hasMorningExercise`、`hasMorningRun`、`studentCount`、`dormCount`、`departmentName`、`grade`、`homeroomNames`、`remark`。

## 3. 接口清单（B 交付，C/E/D 按此对接）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/admin/union/modules` | `union.view` | 模块定义（**新增 `fields[].derived`**） |
| GET | `/api/union/entry/students` | 学生会成员 + 模块归属 + 院系 | 已有；本轮**追加返回 `studentCount`**（班级应到人数，前端预填用） |
| GET | `/api/admin/class/:className/profile` | `class.view` | 班级配置（含 `hasMorningRun`） |
| PUT | `/api/admin/class/:className/profile` | `class.manage` | 改班级配置 |
| GET | `/api/class/attendance?className=&from=&to=` | 班主任 / 班委（成员资格，只读） | **班级考勤汇总**：按日 × 模块的应到/实到/缺勤/未归与出勤率，供 E 的「班级考勤」tab 与 C 的组件 |
| GET | `/api/class/students?className=&page=` | 班主任 / 班委 | 已有（班级域），E 的「学生名单」tab 复用 |

权限模型（勿改）：`/api/class/*` 用**成员资格校验**（班主任 `homeroomClasses` / 班委 `isClassOfficer`），
**不使用 `requirePermission`**；管理端 `/api/admin/*` 才用 `requirePermission`。新增管理端能力要先在
`models/permission.js::DEFAULT_CATALOG` 加权限项（`class.view` / `class.manage` 若不存在则补）。

## 4. 各 Agent 交付清单

### A：弹窗 / 抽屉可滚动
- 把所有 `position: fixed` 的抽屉 / 弹层内部改成 `<scroll-view scroll-y>` + 固定高度（如 `height: 70vh`），
  不要用 `overflow-y: auto`（小程序 fixed 容器上真机滚动不可靠）；
- 覆盖范围：`packageAdmin/union/members`、`packageAdmin/union/config`、`packageUnion/entry` 的表单区、
  `packageUnion/records` 的筛选面板、`packageUnion/roster`、以及自查到的其它抽屉（写进报告）；
- 自查命令参考：`Select-String -Path miniprogram -Include *.wxss -Pattern "position: fixed" -Recurse`；
- 验收：每个抽屉都能在真机/模拟器里滚到底部按钮；`node tools/check-miniprogram.js` 不新增问题。

### B：后端口径与班级配置
- `derived` 字段标记 + 五个模块的定义调整（早操/早八/晚自习/查宿的 `absentCount` / `notReturnedCount` 标 derived）；
- `normalizeDetails` 对 derived 字段**忽略客户端传值**（始终以服务端推算为准，防伪造）；
- `/api/union/entry/students` 追加 `studentCount`；
- 班级配置接口 + `hasMorningRun` 字段 + 权限项 `class.view` / `class.manage`；
- `/api/class/attendance` 汇总接口（按日 × 模块：`should`、`actual`、`absent`、`notReturned`、`rate`）；
- 验收：`node --check` 全过；用 `node -e` 跑一遍五模块的 `fillDerived` + `computeMetrics` 打印结果贴进报告。

### C：录入台口径 + 班级考勤组件
- 录入表单**跳过 `f.derived` 字段**，改为在表单顶部展示「计算结果」行（如「缺勤 2 人（应到40 − 实到38 − 请假0）」）；
- 提交 payload 不再包含 derived 字段；
- 新建 `packageUnion/attendance`（组件或页面均可，E 会引用）：班级考勤汇总展示
  （日期 × 模块的出勤率/缺勤/未归，今日概览 + 近 7 天列表），数据来自 `/api/class/attendance`；
- 验收：语法 + `tools/check-miniprogram.js` 不新增问题。

### D：导航与命名
- 管理中枢 `pages/hub`：分组改为 **学生会**（分类名）与 **班级管理**（分类名），
  条目命名：`班级管理`、`学生会配置`、`学生会成员`、`班超排名`；
- 首页 `pages/home`：管理面板「快捷操作」按新分类重排（保持按权限过滤的既有机制）；
- 我的页 `pages/profile`：入口命名同步（班级管理 / 学生会配置不作入口，只保留班级管理与学生会相关入口）；
- **禁止**改 `app.json` 与 `custom-tab-bar`（路由与底栏由主 Agent 统一改）。
- 验收：`node tools/check-miniprogram.js` 不新增问题；截图或逐条列出改动点。

### E：班级管理四 tab
- `packageAdmin/class/class` 改为 4 个 tab：**学生名单 / 校园跑 / 班级考勤 / 班级配置**
  - 学生名单：复用现有 `/api/class/students`（搜索、分页、排序、督促）
  - 校园跑：现有班级运动数据（overview / ranking / 学生明细入口）
  - 班级考勤：引用 C 的 `packageUnion/attendance` 组件
  - 班级配置：读改 `/api/admin/class/:className/profile`（含**不跑操**开关），无 `class.manage` 时只读
- 保留班委只读、班主任可督促的既有语义；**服务端判权不变，前端隐藏不算权限**；
- 验收：`node --check` + `tools/check-miniprogram.js` 不新增问题。

## 5. 主 Agent（协调者）负责
- `app.json`（新页面登记）、`custom-tab-bar/index.js`（动态项命名）、
- 跨范围冲突仲裁、最终 `tools/check-miniprogram.js` 与后端契约测试、
- `docs/student-union-plan.md` 的进度与口径更新。
