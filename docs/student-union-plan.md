# 「班超 + 学生会」功能方案（唐唐快跑 2.0）

> 需求来源：上级领导要求的学生会功能（班级卫生 / 班级考勤 / 班级查宿 / 早操出勤 / 早八出勤）。
> 本文是**评审用方案**：先把概念、角色、数据模型、权限矩阵、页面与分期定下来，确认后再进入开发。
> 关联文档：`docs/database-v2.md`、`docs/api.md`、`docs/ui-design.md`、`AGENTS.md`。

---

## 0. 一句话方案

把「卫生 / 晚自习 / 查宿 / 早操 / 早八」做成**一套可配置的班级检查（班超）体系**：

- 用**模块注册表**描述五大检查（谁查、查什么、怎么算），用**一张检查记录主表**存数据 → 领导以后加新检查项，只加配置不改表；
- **学生会部门成员负责录入**（生活部→卫生、学习部→晚自习、纪检部→查宿/早操/早八），**班委与班主任只读本班**、可申诉；
- 检查结果按班汇总成**班级总评与排名**（本期不动个人跑分口径，预留联动位）；
- 小程序首页与「我的」新增**班超导航项**与**班超块**（**仅班委 / 班主任可见，普通学生不显示**），学生会成员额外有**学生会块**与**学生会导航项**（自定义 tabBar 动态项）；首页板块固定顺序：公告条 → 广告位 → 学生会块 → 班超块 → 我的班级 → 今日目标卡 → 快捷入口 → 数据概况。

---

## 1. 现状盘点：已有能力与缺口

### 1.1 已经有的（直接复用，不重造）

| 能力 | 现位置 | 本方案怎么用 |
|---|---|---|
| 班级名口径（`users.className`） | `models/user.js`、`services/roster.js` | 班超全部按 `className` 归集，与管理端、班级域一致 |
| 班主任 / 班委身份 | `user.homeroomClasses` / `user.isClassOfficer` | 班主任与班委的**只读**范围判定，沿用成员资格校验思路 |
| 班级域只读接口与页面 | `routes/class.js`、`packageAdmin/class/class` | 班超数据在班级页做「检查结果」分区 |
| 三级组织树 | `organizations`（school→department→specialty） | **分会归属（school 层院校/校区）**与检查范围校验（展开为其下 department 层系部） |
| 首页 + 我的 + 自定义 tabBar | `pages/home`、`pages/profile`、`custom-tab-bar` | 新增班超 / 学生会导航项与板块的落点 |
| 权限目录 + 权限组 | `models/permission.js`、`permission-groups` | 管理端「学生会配置 / 班超设置」的权限项 |
| 上传、通知公告、审计习惯 | `routes/admin/upload.js`、`announcements` | 检查留证照片、结果公示 |

### 1.2 缺口（本方案要新建）

1. **没有学生会的任何组织建模**（主席团 / 分院主席团 / 各部门 / 部长 / 部员）；
2. **没有检查类业务**：全仓库检索「卫生 / 考勤 / 早操 / 查宿 / 晚自习」零命中；
3. **没有宿舍的班级与学生归属数据**（宿舍录入需要「这间房住着谁」）；
4. **没有卫生区（包干区）与班级的对应关系**；
5. **没有「本班是否有早操」的标记**（出勤率分母问题）；
6. 班委当前**只能读运动数据**，没有任何写能力，而本次要给班委/班主任增加**只读**的检查结果视图。

---

## 2. 概念与角色

### 2.1 名词对齐（避免歧义，先统一叫法）

| 词 | 定义 |
|---|---|
| **班超** | 面向**班级**的检查评比域。本期包含 5 个模块：卫生、晚自习、查宿、早操、早八。班级是评比主体。 |
| **模块** | 一类检查（卫生 / 晚自习 / 查宿 / 早操 / 早八），由 `check_modules` 注册表定义 check 对象、粒度、计分口径。 |
| **检查对象** | 教室 / 宿舍 / 卫生区 / 班级（考勤类以班级为对象）。 |
| **录入方** | 学生会对应部门的部长 / 部员（跨班录入）；班委与班主任**不录入**，只读本班结果并可申诉。 |
| **学生会** | 全校主席团 + **各院校（校区）分会**（分会主席团 + 分会各部门，部门有部长 / 副部长 / 部员）。 |
| **分会（院校/校区）** | 即现有 `organizations` 中的 **`school` 层（院校/校区，如北校区 / 洋河校区 / 教师院）**。分会学生会的检查范围默认限定在**本院校下全部系部的班级**。 |

> ⚠️ **口径变更记录（第三轮）**：分会维度**原先绑的是 `department`（院系）**，后按用户明确要求上移到 **`school`（院校/校区）**：
> 「学生会部门树形 UI…咱们不是有院校嘛，你得是**全校与相应的院校**啊，如北校区 洋河校区啊」。
> 现在的映射是：`union_members.schoolId → organizations.type='school'`；`level='school'` = 全校（**不是**"校级"这种抽象词），`level='branch'` = 某院校（校区）分会。
>
> **鉴权不靠给 `check_records` 加字段，而是「校区展开为其下全部院系 id」**：
> `services/union.js::campusDepartmentIndex()` 一次 `Organization.find({type:'department', parentId:{$in: schoolIds}})`，
> 把校区换算成系部 id 列表喂给既有的 `canEnterModule` / `canReview` / `scopeFilter`，
> 于是这三个函数与 `bandChao.classRanking({departmentIds})` **一行都不用改**（`check_records.departmentId` 存的仍是班级所属院系）。
>
> - **校区下还没配系部**时 `departmentIds` 为空 → `scopeFilter` 返回 `null`（该分会成员什么都看不到）。
>   这是**刻意的安全默认**（宁可看不到，也不能越权看全校），并且**不静默**：管理端成员列表逐条下发 `campusWarning`，
>   录入侧给出「请先到『组织架构』配置系部」的可读原因。
> - **老数据兼容**：只有 `departmentId`、没有 `schoolId` 的 branch 记录仍按老口径工作（`departmentIds` 含它）。
> - **唯一索引必须含 `schoolId`**：校区口径下分院记录 `departmentId` 恒为 `null`，旧键（不含 schoolId）会把
>   「北校区分会-生活部」与「洋河校区分会-生活部」当成同一个键 → E11000 → **500**。
>   启动期 `services/union.js::migrateMemberUniqueIndex()` 负责建新键、按**键模式**删旧索引
>   （旧索引是自动命名的，按名字删不可靠）；`tools/check-server-contract.js` 有断言守住"键里有 schoolId"。

### 2.2 学生会组织建模

三层结构，全部**配置化**（不写死“生活部”“纪检部”字样，部门列表由管理端维护）：

```
全校学生会
├── 主席团：主席 / 副主席
└── 各部门（学习部、生活部、纪检部、办公室、宣传部…）

院校（校区）分会 —— **每个院校（organizations 的 school 层）一套**，如 北校区分会 / 洋河校区分会 / 教师院分会
├── 分会主席团：主席 / 副主席
└── 分会各部门：部长 / 副部长 / 部员
```

> 上图的「全校 / 各院校」是**第三轮按用户口径修正后**的画法（原文写的是「校学生会 / 每个院系一套」）。
> 分会维度是 **院校（校区）**，不是院系：分会成员绑 `schoolId`，其检查范围 = 该校区下**全部系部**的班级。

数据落点：新集合 **`student_union_members`**（成员任期记录），并在 `users` 上加**缓存字段**供客户端判身份：

```js
// users 新增（派生缓存，由成员记录同步维护；判定以服务端实时校验为准）
unionRoles: [{            // 一个人可同时是校学生会 + 分院学生会成员
  level: 'school' | 'branch',     // 校级 / 分院
  departmentId: ObjectId | null,  // branch 时必填（organizations.department）
  deptKey: String,                // 部门 key，null = 主席团
  role: 'president' | 'vice_president' | 'minister' | 'vice_minister' | 'member',
}],
isUnionMember: Boolean,   // 便于首页「学生会块」快速判断
```

**部门 key 与职责的绑定放在配置里**（`union_departments`，管理端可增删改）：

| deptKey（默认播种） | 名称 | 默认负责模块 |
|---|---|---|
| `presidium` | 主席团 | 全部模块（只读 + 复核，不录入） |
| `life` | 生活部 | 卫生（教室 / 宿舍 / 卫生区） |
| `study` | 学习部 | 晚自习（含网课） |
| `discipline` | 纪检部 | 查宿、早操出勤率、早八出勤 |

> 部门 → 模块的映射是**配置项**，不是代码常量：学校把早操改给体育部，只需要在管理端改一行。

### 2.3 角色与能力总览

| 角色 | 读到什么 | 能写什么 |
|---|---|---|
| 普通学生 | 只看公开班级榜（排行榜页）；**无班超块、无检查明细** | 无 |
| 班委（`isClassOfficer`） | 本班检查结果与班超总评（只读） | 无（沿用“班级域无写接口”的既有约定） |
| 班主任（`homeroomClasses`） | 所带班级全部检查明细 | 无（可发起**申诉**与备注，不算写业务数据） |
| 学生会部员 / 副部长 | 本部门负责模块的录入台 + **本院校（校区）下各系部**记录 | **提交**检查记录（本校区范围，需复核） |
| 学生会部长 | 同上 + 本校区本部门全部记录 | 提交 / 修改本人提交的记录 / 申请撤销 |
| 分会主席团（`level=branch`） | 本院校（校区）下各系部全部模块记录与排名 | 复核（通过 / 退回）、导出 |
| 全校主席团（`level=school`） | 全校全部模块记录与排名 | 复核、撤销、发布通报 |
| 管理部门（学生处 / 团委） | 管理端全部 | 配置模块、部门、成员、计分规则 |

---

## 3. 权限矩阵（服务端为准）

### 3.1 三类鉴权方式，按域分开

沿用仓库既有约定，**不要**把班级域/学生会域塞进 `requirePermission`：

| 域 | 路径 | 鉴权方式 | 依据 |
|---|---|---|---|
| 班级域（只读） | `/api/class/*` | 成员资格：班主任 / 班委 | 既有 `routes/class.js` |
| 学生会域 | `/api/union/*` | 学生会成员资格 + 模块归属 + 院系范围 | 本方案新增 |
| 管理端 | `/api/admin/*` | `requirePermission('union.view' / 'union.manage')` | 权限目录新增权限项 |

### 3.2 学生会域权限判定（写操作的核心）

写接口的判定链（缺一不可，任一失败即 403 + `403002`，不要用 `403003`）：

1. **是学生会成员**：存在 `student_union_members` 有效记录（`status: active`，且在任期内）；
2. **模块归属**：该成员的 `deptKey` 在模块配置的 `entryDeptKeys` 里（如 `hygiene.entryDeptKeys = ['life']`）；
3. **院系范围**：`level = 'school'` → 全校；`level = 'branch'` → 目标班级所属 `departmentId` 必须与成员一致；
4. **目标对象存在且属于该院系**：目标班级的 `className` 必须能在 `users` 中找到且非教师；
5. **时间窗与冲突**：同一 `模块 + 班级 + 日期 + 时段` 是否已有记录（有则按覆盖规则处理，见 §5.6）。

> 注：**不要**给“部门成员”分配 `*` 权限组 —— 否则他们会顺带进管理端。学生会成员应是普通 `student` 角色 + 成员记录。

### 3.3 权限目录新增项（`Permission.DEFAULT_CATALOG`）

| key | 名称 | 模块 | 用途 |
|---|---|---|---|
| `union.view` | 查看学生会与班超 | 学生会 | 管理端看板、成员、检查记录 |
| `union.manage` | 管理学生会（成员 / 部门 / 模块配置 / 计分规则） | 学生会 | 增删改配置与成员 |
| `union.steward` | 学生会总管 | 学生会 | 一个权限覆盖学生会全部事务：自动蕴含 `union.view` + `union.manage`（`Permission.PERM_IMPLIES`，在 `user.js::getEffectivePermissions` 唯一出口展开），且**不要求本人是成员**（团委老师 / 学生处干事可维护名单）。用户端 `/api/union/manage/*` 也放行总管，范围＝全校 |

---

## 4. 五大检查模块详细设计

> 统一字段（所有模块共有）：**检查日期**、**时段/节次**、**受检班级**、**检查人**、**受检对象**、**提交时间**、**状态（已提交/已复核/已退回）**、**备注**、**留证照片**。
> 下列“专属明细”存 `details`，由服务端按模块校验（见 §5.2）。

### 4.1 卫生（生活部）— 三种受检对象

| 受检对象 | 由谁录入的班级来源 | 检查内容 | 结果口径 |
|---|---|---|---|
| **教室** | 每个班级 1 条（对象 = 班级） | 地面/桌面/门窗/黑板/垃圾/桌椅摆放等检查项 | 每项打分 → 折百分制评分 + 扣分项 |
| **宿舍** | 按房间检查，房间归属班级（见 §5.5） | 床铺/地面/物品摆放/违规电器/垃圾 | 每间房一条，班级得分 = 房间均分（人数加权可选） |
| **卫生区** | 班级 ↔ 卫生区映射（见 §5.5） | 区域整洁度/垃圾清运/死角 | 每区一条，映射到责任班级 |

关键点：
- **扣分项结构化**：`items: [{ key, name, score, max, remark }]`，便于“哪个班老在窗户上丢分”这类统计；
- **宿舍检查**：一间房一条记录，`details.roomId` 指向房间，班级分通过房间归属反查 —— **不要**在录入时手填班级（必错）；
- **卫生区**：一个区可能由多个班级共管，映射表支持多对多，班级得分按 `share` 权重分摊；
- **留证**：每项问题允许拍照（复用 `routes/admin/upload.js` 的上传能力，客户端走 `/api/upload`）。

### 4.2 晚自习 / 插班晚自习（学习部）

领导原话：「班级考勤插班晚自习（在教室与在宿舍网课）」——即晚自习考勤要区分**在教室**与**在宿舍上网课**两种形态，并记录**插班**（学生去别的班/别的地点自习）。

> ⚠️ **以下 4.2–4.5 是初版字段设计，第四轮已被用户给出的新表单取代**（见本节末尾「4.6 第四轮表单口径（现行）」）。
> 保留原文只为追溯为什么会有 `transferIn`/`onlineDorm` 这些字段；**写代码请以 4.6 为准**。

必须记录的两组号：

| 字段 | 说明 |
|---|---|
| `shouldCount` | 应到人数（默认取班级学生数，可手工修正并留痕） |
| `actualClassroom` | 实到（在教室） |
| `onlineDorm` | 在宿舍网课人数 |
| `leave` | 请假人数（分支：事假/病假/公假） |
| `absentList` | 缺勤名单（姓名 + 学号 + 默认缺勤原因） |
| `transferIn / transferOut` | **插班**：外班插入本班人数 / 本班去外班人数（可点选对方班级） |
| `late / earlyLeave` | 迟到 / 早退人数 |

口径：`实到合计 = actualClassroom + onlineDorm`；
`出勤率 = (实到合计 + 请假 + 插班净额) ÷ (应到 + 插班净额)`，净额 = `transferIn − transferOut`，公式写在服务层常量里，前端只展示不算数。

### 4.3 班级晚上查宿（纪检部）

| 字段 | 说明 |
|---|---|
| `shouldStay` | 应住人数（默认 = 宿舍归属名单里的本班学生数） |
| `actualStay` | 实住人数 |
| `notReturnedList` | 未归名单（自动带出学生所属房间，便于宿管核对） |
| `leaveList` | 请假名单（事假/病假/公假） |
| `lateReturn` | 晚归人数 |
| `violations` | 违规项（大功率电器 / 留宿外人 / 卫生违规等，可配置字典） |

同一晚一栋楼多条记录（按楼层或按检查小组），班级维度汇总时按班级聚合。

### 4.4 早操出勤率（纪检部）— 必须支持「无早操班级」

这是需求里明确点出的坑：**有的班级本来就没有早操**。处理方式：

- 给班级加 **`hasMorningExercise` 标记**（`class_profiles` 配置表，见 §5.5），可由管理端批量维护（按年级/专业设置）；
- 录入台只列出**当日应有早操**的班级；无早操班级**不产生记录**；
- 出勤率分母 `shouldCount` 默认 = 班级学生数（可手工修正）；
- 统计时**分母只算“当日应有早操”的班级**，无早操班级既不计入达标率也不计入排名分母（否则它们永远拖着全校平均分）；
- 遇到**临时取消**（天气、场地、考试）：录一条 `cancelled` 状态记录，原因必填，该班当日**退出统计**（不是算 0 分）。

### 4.5 早八出勤（纪检部）

与早操结构一致，差异在：
- 年级/专业差异：大三、大四可能没有早八 → 同样用 `hasMorningClass` 标记 + `cancelled` 记录；
- 建议录入形态为**按班 1 条**（人数 + 缺勤名单），而非逐个学生打卡 —— 学生会现场点名，逐个打卡不现实。

### 4.5b 第四轮表单口径（**现行，写代码以此为准**）

用户第四轮给出的五张表单（取代 4.2–4.5 的初版字段）。实现位置：`services/check-modules.js::DEFAULT_MODULES` +
`normalizeDetails` / `fillDerived`；前端渲染在 `packageUnion/entry`。

| 模块 | 受检对象 | 字段（顺序即表单顺序） |
|---|---|---|
| `hygiene` 卫生 | `classroom` / `dorm_room` / `area`（教室 / 宿舍 / 卫生区） | `grade`(优/良/差，必填) → `photos` → `remark`；`score`(derived：优100/良80/差60) |
| `study_evening` 晚自习 | `class` | `grade`(优/良/差/**网课**) → `actualCount` → `absentList` → `reason` → `photos`；`shouldCount`/`absentCount`(derived) |
| `night_dorm` 查宿 | `dorm_room` | `actualCount` → `absentList`(宿内搜索) → `reason` → `photos`；`shouldStay`/`notReturnedCount`(derived) |
| `morning_exercise` 早操 | `class` | `actualCount` → `absentList`(班内搜索) → `reason` → `photos`；`shouldCount`/`absentCount`(derived) |
| `morning_class` 早八 | `class` | `lateList`(校内搜索) → `photos`；`lateCount`(derived) |

四条必须守住的实现口径（都是踩过的坑）：

1. **「应到 / 应住」是 derived，但仍是出勤率的分母** —— 用户要求「应到是已知数，不让录入人再数一遍」，
   所以表单里没有它；由**服务端写入时注入**（班级取 `class_profiles.studentCount`，宿舍取该房间在住学生数，
   见 `routes/union.js::shouldCountCtx` + `fillDerived(version, details, ctx)`）。
   `normalizeDetails` 会丢弃客户端传来的 `shouldCount` —— **分母绝不能被客户端伪造**。
2. **拿不到台账时不能静默报 0**：`fillDerived` 在无 `ctx` 且自身也没有应到时，退化为「缺勤名单人数」。
   录了缺勤名单却显示缺勤 0 会让真实缺勤被掩盖（本文件最容易踩的坑）。
3. **「优/良/差」折算不能写进公式**：`services/formula.js` 是**无 eval 的递归下降解析器**，
   明确不支持字符串比较与三元 → 折算必须落成 `derived` 数字字段（`score`），metric 只引用它。
   早八「迟到数 = 名单人数」同理（名单是数组，公式引擎只认数字）。
4. **网课（`grade='网课'`）要跳过后续字段**：班内无学生、在宿舍观看，不填实到/缺勤/原因。
   `normalizeDetails` 必须**跳过这几个字段的必填校验**（否则永远录不进网课班），
   `fillDerived` 必须清空它们**并把注入的 `shouldCount` 也清 0**（否则「网课 + 应到 40」会算成缺勤 40）。
   ⚠️ `grade` 在 details 里是**数组**（select 口径），判定必须用 `isOnlineDormGrade()` 兼容数组与字符串
   —— 前端按数组、后端按字符串比过一次，网课班因此仍被要求填实到人数。

> 照片字段 `photos`（`type:'photo'`）**选填、≤9 张**，前端上传到 `POST /api/upload/check-photo`
> （成员可传、≤5MB、`category='check_photo'`），落库在 `check_records.photos`（**顶层字段**，不在 details）。
> 宿舍场景的照片受隐私裁剪：仅**检查人 / 学生会主席团 / 所属部门部长 / 教师账号**可见，
> 其余人**不下发原图 URL**（`photos: []` + `photosBlurred` + `photoCount`）——
> ⚠️ 「模糊」必须是不给原图 URL；用 CSS 模糊一个真 URL 等于没做（抓包即得）。
> 判断实现见 `services/union.js::cropPhotos` / `canViewDormPhotos`（只在 `targetType='dorm_room'` 时生效）。

> **存量库生效靠 `DEF_VERSION`**：`check_modules` 原有播种是"只在首次创建时写一次"，
> 那样**线上老库永远用不上新表单**（改代码等于没改）。现在 `defVersion < DEF_VERSION` 时
> **强制覆盖一次结构字段**（fields/metrics/scoring/targetTypes/name），之后按版本幂等跳过，
> 不再每启动全量覆盖（会抹掉运营改的名称/选项/权重）。**改内置模块结构时必须手动 `DEF_VERSION + 1`**。

### 4.6 模块配置表（`check_modules`，启动幂等播种）

| 字段 | 说明 |
|---|---|
| `key` | `hygiene` / `study_evening` / `night_dorm` / `morning_exercise` / `morning_class` |
| `name` | 卫生检查 / 晚自习考勤 / 晚上查宿 / 早操出勤 / 早八出勤 |
| `ownerDeptName` | 归属部门展示名（生活部 / 学习部 / 纪检部）—— 仅展示，鉴权用 `entryDeptKeys` |
| `entryDeptKeys` | 允许录入的部门 key 列表 |
| `targetTypes` | `classroom` / `dorm_room` / `area` / `class` |
| `periods` | 可选时段（如 `evening_study`、`night`、`morning`） |
| `metrics` | 展示指标定义（出勤率 / 平均分 / 未归人数…），含单位与保留位数 |
| `scoring` | 计分规则：`mode: deduct|percent|rate`、权重、满分 |
| `enabled` | 启停 |
| `sort` | 首页与服务端返回顺序 |

---

## 5. 数据设计

### 5.1 集合总览（命名与 `docs/database-v2.md` 同风格）

```
student_union_members   学生会成员（任期记录）
union_departments       学生会部门（校级/分院共用字典，默认播种）
union_terms             学生会届次 / 任期（可选，用于学期切换）
check_modules           检查模块注册表（配置，5 条默认播种）
check_records           检查记录主表（单表 + details 明细）
class_profiles          班级配置（是否有早操/早八、默认应到人数）
dorm_rooms              宿舍房间（楼栋/房号/所属院系班级/床位）
dorm_assignments        学生 ↔ 床位（住宿名单）
sanitary_areas          卫生区（区域名/责任班级/权重）
files                   上传文件元数据（category: avatar/ad/badge/check_photo/other）
```

> ⚠️ **两个闭合 enum 必须同步扩**（第四轮踩过的坑）：新增「文件用途」要加 `file-object.js::CATEGORIES`，
> 新增「检查字段类型」要加 `check-module.js::fields[].type`。漏了会是**硬失败**：
> 前者 `FileObject.create` ValidationError → 上传接口 400 不可用；后者 `check_modules.save()` 校验失败
> → 播种/保存即炸（`services/check-modules.js` 里写了新 type 却没改 model enum 就是这样）。
> 两个 enum 的消费方**部分**从常量派生，所以加一项**不一定**自动传导 —— 这是第五轮的真实翻车点：
> 新增 `check_photo` 时，`admin/upload.js` 从 `FileObject.CATEGORIES` 取（自动跟上），
> 但 `routes/admin/files.js` 的统计键写死了 `{ avatar, ad, badge, other }`、前端
> `packageAdmin/files/files.js` 的 `CATS` 也漏了它 → 学生会的检查照片在「文件管理」里
> **没有分类计数、也没有筛选条**（用户报障「学生会拍照上传没有显示」）。
> 现已把服务端统计键改为从 `FileObject.CATEGORIES` 派生，并加了两道守门：
> `tools/check-server-contract.js` 校验「统计键派生 + 前端 CATS 与 enum 闭合」，
> `tmp/verify-files-categories.js` 桩测试逐项比对。
> **结论：新增文件用途要同时改三处** —— `file-object.js::CATEGORIES`、
> 前端 `files.js::CATS`（展示文案与顺序）、以及按需给 `admin/upload.js::CATEGORY_PERMS` 加权限项。
>
> **检查照片（`category:'check_photo'`）刻意不做旧文件清理**（与 avatar 不同）：它是留证用途。


**大集合索引（`check_records` 必须有）**：

```js
{ className: 1, date: -1, moduleKey: 1 }         // 班级视角：本班某模块历史
{ moduleKey: 1, date: -1, status: 1 }            // 学生会录入台：某模块某天待复核
{ departmentId: 1, moduleKey: 1, date: -1 }      // 分院视角看板
{ date: 1, moduleKey: 1 }                        // 全校当日汇总
{ inspectorOpenid: 1, createdAt: -1 }            // 「我提交的」
// 幂等/防重复提交（部分索引，仅对已生效记录约束）
{ moduleKey: 1, targetType: 1, targetId: 1, date: 1, period: 1 }  // unique + partial(status in [submitted, approved])
```

### 5.2 `check_records` 字段（单表 + 明细）

| 字段 | 类型 | 说明 |
|---|---|---|
| `moduleKey` | String | 模块 key |
| `date` | String | 日历键 `YYYY-MM-DD`（与全库一致） |
| `period` | String | 时段：`morning` / `morning_class` / `evening_study` / `night` / `daytime` |
| `targetType` | String | `classroom` / `dorm_room` / `area` / `class` |
| `targetId` | String | 对象 id：班级名 / `dorm_rooms._id` / `sanitary_areas._id` / 班级名 |
| `className` | String | **冗余索引字段**：结果归属班级（宿舍与卫生区经映射反查后写入），便于按班查询与排名 |
| `departmentId` | ObjectId | 班级所属**院系**（冗余，分会范围过滤与看板用）—— 注意这是**班级**的院系，不是分会维度；分会维度见 `union_members.schoolId` |
| `grade` | String | 年级（冗余，便于按年级筛选） |
| `inspectorOpenid` / `inspectorName` | String | 录入人 |
| `inspectorDeptKey` | String | 录入人所属部门（用于审计“谁在录”） |
| `details` | Mixed | 模块专属明细（结构由模块定义 + 服务端校验函数保证） |
| `score` | Number | 本条折算分（0~100 或扣分，按模块 `scoring.mode`） |
| `metrics` | Mixed | 派生指标快照（出勤率、实到人数…），便于列表直出、避免每次重算 |
| `photos` | [String] | 留证图片 URL |
| `remark` | String | 备注 |
| `status` | String | `submitted`（已提交）/ `approved`（已复核）/ `rejected`（已退回）/ `cancelled`（取消，如早操临时取消） |
| `cancelReason` / `rejectReason` | String | 取消 / 退回原因（必填校验） |
| `reviewedBy` / `reviewedAt` | String / Date | 复核人 openid / 复核时间（`reviewedByName` 另有姓名，详情页两个都展示） |
| `source` | String | `union`（学生会录入）/ `import`（批量导入）/ `appeal`（申诉改判） |
| `revision` | Number | 版本号：每次修改 +1，保留 `history` 快照（谁改了什么） |
| `appeal` | Object | `{ status, reason, byOpenid, at, result }` 申诉子文档 |

> **为什么单表 + Mixed details**：领导明确要求的是“五类检查 + 以后可能加”，单表能让首页/看板/排名/导出**只写一套聚合**；同时服务端维护 `modules/*.js` 校验器（`normalize(moduleKey, details)`），保证写入结构受控 —— 数据库宽松、接口严格。

### 5.3 `student_union_members`

| 字段 | 说明 |
|---|---|
| `openid` / `userId` | 学生（索引；同一人可多条：不同 level/部门） |
| `level` | `school` / `branch` |
| `schoolId` / `schoolName` | **分会所属院校（校区，`level=branch` 必填，取自 `organizations` 的 `school` 层）**；`level='school'` 记录为空 |
| `departmentId` / `departmentName` | **老口径 / 兼容，不要删**：第三轮之前分院绑的是院系。新记录按院校口径写，这两个字段可空 |
| `deptKey` / `deptName` | 部门 key / 名称（主席团 `deptKey = 'presidium'`；`null` 也可） |
| `role` | `president` / `vice_president` / `minister` / `vice_minister` / `member` |
| `termId` / `termName` | 届次（如「2025-2026 学年第一学期」） |
| `status` | `active` / `left`（离任保留历史，不物理删除） |
| `remark` | 备注 |
| `createdBy` | 管理员 openid |

索引：`{ openid: 1, status: 1 }`、`{ level: 1, departmentId: 1, deptKey: 1, status: 1 }`。

### 5.4 `union_departments`

| 字段 | 说明 |
|---|---|
| `key` | `presidium` / `life` / `study` / `discipline`（`^[a-z][a-z0-9_-]{1,31}$`，与权限组 key 规则一致） |
| `name` | 生活部 / 学习部 / 纪检部 |
| `scope` | `school` / `branch` / `both`（该部门是否**各院校分会**也有；`school` = 只在「全校」根、`branch` = 只在各院校根） |
| `dutyModules` | 默认负责的模块 key 列表（模块侧 `entryDeptKeys` 为准，这里用于展示与初始化） |
| `sort` / `enabled` / `builtIn` | 排序 / 启停 / 内置（内置不可删，参考 `permission_groups` 的 `builtIn` 约定） |

> **`scope` 是部门唯一的层级来源 —— 模型里没有 `parentId`，也不该加**（用户提问"部门不是多级吗"，答案就是这个）。
> 「学生会配置 → 部门」渲染成**可展开树**（视觉对齐 `packageAdmin/content/organizations` 页）：
> **根 = 「全校」+ `organizations` 里每一个 `type='school'` 的真院校**（北校区 / 洋河校区 / 教师院…，走现成 `GET /api/org/tree`，**后端不用改**）。
> `全部（全校）`根收 `scope ∈ {school, both}`；**每个院校根**收 `scope ∈ {branch, both}`。
>
> > ⚠️ 这条是**用户明确纠正过**的：第一版做成了「校级学生会 / 分院学生会」两个抽象根，用户否掉了 ——
> > 「学生会有院校嘛，你得是**全校与相应的院校**啊，如北校区 洋河校区啊」。
> > **不要**再用"校级/分院"当根节点名字面。
>
> **`scope='both'` 的部门在「全校」与每一个院校下都出现（多挂）**，所以节点 id 必须**全局唯一**
> （`school-<key>` / `<院校id>-<key>`；院校同名或无 `_id` 时还要撞车兜底）——用裸 `key` 当 `wx:key` 会在同级重复、展开态错乱。
> 成员数：全校根用 `schoolCount`（精确）；院校根用 `branchCount`，但它是**全局分院校计数的旧口径、未按校区细分**
> （三个院校会显示同一个数字），所以文案必须**显式标注「未按校区细分」**，**不许**假装它是该校区的人数。
> 院校根下**不要伪造「每个院系一套部门」的子节点** —— 字典里只有一套共用定义，院系范围在「组织架构」维护。
> `/api/org/tree` 拿不到院校时，仍渲染「全校」根 + 一行提示，**不白屏、不空树**。
>
> 若未来真要支持「院系独有部门」，正确做法是加**院系维度**（如 `branchKeys: [String]` 或独立关联集合），
> **不是**加 `parentId`：后者会与 `dutyModules` 及鉴权口径（`check_modules.entryDeptKeys` 按部门 key）冲突。


### 5.5 支撑表（让录入不需要手填班级）

| 集合 | 关键字段 | 作用 |
|---|---|---|
| `class_profiles` | `className`(unique)、`departmentId`、`grade`、`hasMorningExercise`、`hasMorningClass`、`studentCount` | **早操/早八是否有**标记、默认应到人数、班级院系 |
| `dorm_rooms` | `buildingId`、`buildingName`、`roomNo`、`departmentId`、`className`、`capacity`、`enabled` | 宿舍按房间检查；`className` 为默认归属班 |
| `dorm_assignments` | `openid`、`roomId`、`bedNo`、`className`、`status` | 学生 ↔ 房间；**查宿的“应住人数 / 未归名单 / 网课人数”都来自这里** |
| `sanitary_areas` | `name`、`areaType`、`className`、`weight`、`enabled` | 班级 ↔ 卫生区（支持多班共管 + 权重） |

初始化三条路径（降低录入门槛）：
1. **从学籍自动生成**：`class_profiles` 由 `users` 按 `className` 聚合生成（人数、院系、年级自动带出）；
2. **宿舍名单导入**：管理端提供 Excel/CSV 模板（楼栋 + 房号 + 学号），导入即建房间 + 床位（复用 `users/import` 的解析骨架与结果报告范式）；
3. **手工增补**：管理端页面可单条维护（宿舍调整频繁时用）。

### 5.6 写入规则（防错、防重复、可追溯）

| 场景 | 规则 |
|---|---|
| 重复提交 | 同 `module + target + date + period` 已有 `submitted/approved` 记录 → 返回 `409` + 提示「今日该对象已有记录，是否修改？」；确认后走**修改**接口（`revision + 1`，保留 `history`） |
| 覆盖权限 | 仅记录本人、本部门部长、主席团、管理端可改；部员改不了别人录的 |
| 补录 | 默认允许补录 **T+3 天**内（配置项 `backfillDays`），超期只能管理端操作 |
| 早操取消 | `status = cancelled` + `cancelReason` 必填；不计分、不进分母 |
| 复核 | 分会主席团（`level=branch`，限本院校/校区）与全校主席团可 `approved` / `rejected`；被退回后录入方可修改重提 |
| 申诉 | 班委 / 班主任对本班记录发起申诉（`appeal`），主席团或管理端改判，改判留痕并写 `source: 'appeal'` |
| 删除 | **不做物理删除**：`rejected` / `cancelled` 即软失效；管理端可标记 `void` |

---

## 6. 班级总评与排名（本期范围）

### 6.1 总评分（实时聚合，不落快照）

```
班级当日总评 = 100 − Σ(各模块当日扣分)
各模块扣分 = f(模块记录, 模块 scoring 配置)
  · 卫生  : 扣分 = max(0, 满分 − 平均得分) × 卫生权重
  · 晚自习: 扣分 = 缺勤人数 × 每人分 + 迟到人数 × 每人分（可配）
  · 查宿  : 扣分 = 未归 × 分 + 晚归 × 分 + 违规 × 分
  · 早操  : 扣分 = (1 − 出勤率) × 满分 × 权重（无早操班级不参与）
  · 早八  : 同早操
```

- 权重、单位扣分、封顶值全部在管理端「班超设置」里配（`check_scoring` 单例配置或写进 `check_modules.scoring`）；
- **未录入 ≠ 满分**：当日应有记录却没有 → 记为 `missing`，可配置扣分或仅提示（建议先只提示，避免学生会没来得及录就冤扣班级分）；
- 排名支持三个范围：全校 / 本校区（展开为其下各系部） / 本年级；周期：日 / 周（周一~今天）/ 月；
- **红黑榜**：前 3 名 / 后 3 名，用于首页与学生会“今日通报”。

> 个人跑分（`goal_config.points`）**本期不动**：班超只做班级维度。后续若领导要求与跑分挂钩，按 §10 的扩展位接入，届时历史跑分口径会随配置重算（与现有跑分体系“实时计算”的设计一致）。

---

## 7. 接口设计

### 7.1 学生会域 `/api/union/*`（学生端，成员资格校验）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/mine` | 我的学生会身份：`{ roles: [...], modules: [...], scope: {level, departmentId}, canEnter: [...] }`；非成员返回 `200 + roles: []`（**不要 403**，首页要据此隐藏板块） |
| GET | `/dashboard?date=&scope=` | 学生会工作台：今日各模块完成情况（已录/应录）、未复核数、快捷入口 |
| GET | `/modules` | 模块与录入模板（字段定义、选项字典、必填项、计分说明） |
| GET | `/entry/targets?moduleKey=&date=&period=` | 录入台对象列表：应检班级/房间/区域 + 每个对象的**录入状态**（未录 / 已录 / 取消）—— 一次返回，避免逐班请求 |
| POST | `/records` | 提交一条检查记录（服务端 `normalize` + 权限链校验） |
| PUT | `/records/:id` | 修改（本人/部长/主席团，`revision+1`） |
| GET | `/records` | 记录列表（按模块/日期/院系/班级/状态，分页） |
| GET | `/records/:id` | 记录详情（含 `history`、`appeal`） |
| POST | `/records/:id/appeal` | 申诉（班委 / 班主任 / 班级学生代表） |
| POST | `/records/:id/review` | 复核（主席团：`approved` / `rejected`） |
| GET | `/summary?scope=&range=` | 班超总评：班级分数、模块明细、排名、红黑榜 |
| GET | `/class/:className` | 某班检查全景（教室/宿舍/卫生区/考勤/查宿/早操/早八）—— 首页「班超块」与班级页共用 |

### 7.2 班级域扩展 `/api/class/*`（只读，沿用成员资格校验）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/checks` | 本班检查结果汇总（班级页新增分区；班委/班主任**只读**） |
| GET | `/checks/records` | 本班检查记录分页明细（含申诉状态） |

### 7.3 管理端 `/api/admin/union/*`（`union.view` / `union.manage`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST/PUT/DELETE | `/members` | 学生会成员增删改查（批量导入成员） |
| GET/POST/PUT/DELETE | `/departments` | 部门配置（内置项不可删，参考权限组规则） |
| GET/PUT | `/modules` | 检查模块配置（启停、录入部门、计分规则、字段选项） |
| GET/PUT | `/scoring` | 班超计分与权重、补录天数、是否“未录入即扣分” |
| GET/POST/PUT/DELETE | `/class-profiles` | 班级是否早操/早八、默认应到人数 |
| GET/POST/DELETE + POST `/dorms/import` | `/dorms` | 宿舍房间与住宿名单（Excel/CSV 导入） |
| GET/POST/PUT/DELETE | `/areas` | 卫生区与责任班级 |
| GET | `/records` · POST `/records/:id/void` | 全量记录查询与导出（CSV）、作废 |
| GET | `/stats` | 班超统计（按模块/院系/班级/时间趋势） |

### 7.4 权限项落地（照 AGENTS.md 的既有要求）

1. 先在 `Permission.DEFAULT_CATALOG` 加 `union.view` / `union.manage`（启动自动播种）；
2. 再在 `routes/admin/index.js` 挂 `router.use('/union', requirePermission('union.view'), require('./union'))`，写操作内部逐个 `requirePermission('union.manage')`；
3. 前端 `utils/permission-ui.js` 加对应入口显隐；
4. **导出/作废等敏感操作单独校验**，不只靠前端隐藏。

---

## 8. 小程序 UI 方案

### 8.1 导航改动（自定义 tabBar）

现状：学生 5 项（首页/跑步/记录/排行/我的）+ 班委才插入「班级」；教师按角色 3 项。

目标（用户原话：「在首页中与学生中增加班超导航项」「班委的班级也改为班超融入进去」「学生是学生会成员也要有学生会块」；首页班超块**仅班委 / 班主任可见**，普通学生不显示）：

| 角色 | tabBar 项 |
|---|---|
| 普通学生 | 首页 / 跑步 / 记录 / 排行 / 我的（不变） |
| 班委（`isClassOfficer`） | 首页 / 跑步 / 记录 / **班超** / 我的（原「班级」→「班超」，图标沿用 `usergroup`） |
| 学生会成员 | 首页 / 跑步 / 记录 / **学生会** / 我的（无班级身份时） |
| **既是班委又是学生会成员** | 首页 / 跑步 / 记录 / **班超** / 我的 + 首页「学生会块」与「我的」页学生会入口（tabBar 只放 1 个动态项，避免 7 项挤压） |
| 教师（班主任） | 首页 / **班超** / 我的（原「班级」改名与改指向） |
| 教师（有管理权限） | 首页 / 管理 / 我的（不变） |

实现要点（**照 AGENTS.md 的硬性要求**）：
- 动态项仍是 `tab: false` 的 `navigateTo`；新页面路径要么在**主包**，要么沿用分包（与本方案 §8.2 一致）；
- 每个 tab 页 `onShow` 调 `this.getTabBar().setActive('<路径>')`，页面根节点加 `.tt-page-tab`；
- `custom-tab-bar/index.js` 的 `buildList()` 需要读 `app.globalData.userInfo` 的新字段（`isUnionMember` / `unionRoles`）→ 因此 `/api/auth/me` 的出口要**补这两个字段**（走 `toSafeJSON()` 白名单，别带哈希）。

### 8.2 页面清单（主包门户 + 分包重页面）

> 取舍理由：tabBar 的动态项用 `navigateTo`，跨分包跳转没问题；因此**门户页放主包**（快、体积小），**录入/配置等重页面放新分包 `packageUnion`**，避免主包超过 2MB。

| 页面 | 分包 | 说明 |
|---|---|---|
| `pages/banchao/banchao` | 主包 | ~~**班超门户**（原「班级」页的班超化）：班级总评卡 + 五大模块卡 + 本周趋势 + 记录列表 + 申诉入口~~ **2026-10-19 已删除**：内容并入 `packageAdmin/class/class`（我的班级页）的「班超联赛」tab，与班级考勤合并 |
| `pages/union/union` | 主包 | **学生会门户**：今日录入进度 + 部门快捷入口 + 待复核 + 通报 |
| `packageUnion/entry/entry` | 新分包 | **检查录入台**（五大模块共用，按 `moduleKey` 渲染字段）：对象列表 → 表单 → 提交 |
| `packageUnion/record/record` | 新分包 | 检查记录详情（含留证照片、历史修改、申诉与复核） |
| `packageUnion/records/records` | 新分包 | 记录列表（模块/日期/状态/院系筛选） |
| `packageUnion/stats/stats` | 新分包 | 班超总评与排名（全校/院系/年级 + 红黑榜 + 趋势） |
| `packageUnion/roster/roster` | 新分包 | 学生会通讯录（按分院 + 部门，展示职务；仅成员可见） |
| `packageAdmin/union/*` | 管理端 | 成员 / 部门 / 模块配置 / 宿舍与卫生区 / 班超计分 / 记录查询与导出 |

### 8.3 首页板块顺序与显隐（已按反馈确认）

**固定顺序**（`home.wxml` 必须按此顺序重排，缺数据的块整体不渲染、不留空位）：

```
顶部插画头 hero → 公告条 → 广告位 → 学生会块 → 班超块 → 我的班级 → 今日目标卡 → 快捷入口 → 数据概况
```

| 顺序 | 板块 | 显隐条件 |
|---|---|---|
| 1 | 顶部插画头 | 恒显示 |
| 2 | 公告条 | 有公告才显示 |
| 3 | 广告位 | 有素材才显示 |
| 4 | **学生会块** | `isUnionMember`（学生会成员）才渲染 |
| 5 | **班超块** | **仅班主任 / 班委**（`homeroomClasses` 或 `isClassOfficer`）渲染；**普通学生不显示** |
| 6 | 我的班级 `class-board` | 班主任 / 班委（沿用现有组件，不动） |
| 7 | 今日目标卡 | 学生显示（教师不显示，现状如此） |
| 8 | 快捷入口 | 学生显示 |
| 9 | 数据概况 | 管理员 / 有权限的教师 |

分角色实际渲染结果：

| 角色 | 首页板块顺序 |
|---|---|
| 普通学生 | hero → 公告条 → 广告位 → 今日目标卡 → 快捷入口 |
| 班委（`isClassOfficer`） | hero → 公告条 → 广告位 → **班超块** → 我的班级 → 今日目标卡 → 快捷入口 |
| 班主任（教师） | hero → 公告条 → 广告位 → **班超块** → 我的班级 |
| 学生会成员（非班委） | hero → 公告条 → 广告位 → **学生会块** → 今日目标卡 → 快捷入口 |
| 既是学生会成员又是班委 | hero → 公告条 → 广告位 → **学生会块** → **班超块** → 我的班级 → 今日目标卡 → 快捷入口 |
| 管理员 / 有权限教师 | hero → 公告条 → 广告位 → 数据概况 |

```
【学生会成员看到的块（顺序 4）】
┌─────────────────────────────────────────────┐
│ 生活部 · 部员            今日卫生 3/12 未录  │
│ [ 卫生录入 ] [ 我的记录 ] [ 待复核 1 ]       │
└─────────────────────────────────────────────┘

【班委 / 班主任看到的块（顺序 5，普通学生不渲染）】
┌─────────────────────────────────────────────┐
│ 23级大数据技术          今日 96 分  全校 #3  │
│ ┌──────┬──────┬──────┐                      │
│ │ 卫生 │晚自习│ 查宿 │  ← 今日得分 / 出勤率 │
│ │ 98   │ 100% │ 1未归│                      │
│ ├──────┼──────┼──────┤                      │
│ │ 早操 │ 早八 │ 详情 │                      │
│ │ 无   │ 97%  │  ›   │                      │
│ └──────┴──────┴──────┘                      │
└─────────────────────────────────────────────┘
```

**wxml 显隐条件（实施时按此写）**：

| 块 | 条件 |
|---|---|
| 学生会块 | `wx:if="{{isUnionMember}}"` |
| 班超块 | `wx:if="{{isHomeroom \|\| isClassOfficer}}"`（**不要用 `!isTeacher`**，否则普通学生会看到） |
| 我的班级 `class-board` | 组件自身判身份（现状），保持不动 |
| 今日目标卡 / 快捷入口 | `wx:if="{{!isTeacher}}"`（现状） |
| 数据概况 | `wx:if="{{isManager}}"`（现状） |

> 连带影响：普通学生的首页**不再出现任何班超入口**。若要保留“想知道本班排名”的诉求，走排行榜页（`pages/ranking`）的班级榜（公开榜，无需班超权限），首页不放班超块。

### 8.4 「我的」页新增板块

| 板块 | 内容 |
|---|---|
| 班超 | 「我的班级 · 检查结果」入口 + 今日总评分；**仅班委 / 班主任显示（普通学生不显示，同首页口径）** |
| 学生会 | 我的职务卡（校/分院 + 部门 + 职务 + 届次）+「录入台 / 我的记录 / 通讯录」入口；非成员不显示 |
| 账号与帮助 | 追加「检查申诉记录」入口（与现有“我的申诉”区分命名） |

### 8.5 UI 规范约束（必须遵守）

- 只用 `app.wxss` 的 `--tt-*` 令牌与 `.tt-*` 公共类，禁止硬编码品牌色；
- 卡片语言与首页现有卡一致（`tt-card` / `tt-section` / `tt-grid`）；大数字用 `.num-font`；
- 检查录入表单优先用已注册的 TDesign 组件（`t-input` / `t-stepper` / `t-radio` / `t-textarea`；上传需新注册 `t-upload`）；
- 新页面 `onLoad/onShow` 首行 `if (!getApp().requireLogin()) return;`。

---

## 9. 分期实施计划

| 阶段 | 内容 | 产出与验收 | 预估 |
|---|---|---|---|
| **P0 评审** | 本方案评审、口径确认（§11 待确认项） | 领导确认五大模块口径与早操/早八规则 | 1~2 天 |
| **P1 底座** | `student_union_members` / `union_departments` / `check_modules` / `check_records` + 索引；`/api/union/mine`、`/modules`；管理端成员与部门管理 | 能配出「生活部 3 人 + 纪检部 2 人」，客户端能识别学生会身份、首页出现学生会块（空数据） | 3~4 天 |
| **P2 录入链路** | 模块校验器 + 提交/修改/列表/详情 + 权限链 + 防重复；卫生（教室/宿舍/卫生区）与查宿先跑通 | 生活部能录教室卫生、纪检部能录查宿，重复提交被拦、修改有留痕 | 4~5 天 |
| **P3 考勤模块** | 晚自习（含宿舍网课 + 插班）、早操（含无早操/取消）、早八；`class_profiles` 标记 | 无早操班级不出现在录入台、不进分母；出勤率口径与服务端公式一致 | 3~4 天 |
| **P4 展示与门户** | 班超门户页（主包）、学生会门户页、`/summary` 总评与排名、首页班超块 + 学生会块、我的页板块、tabBar 动态项 | 领导可在首页看到班级总评与排名；班委/班主任只读本班；学生会成员看到录入进度 | 4~5 天 |
| **P5 复核与统计** | 复核流转、申诉、留证照片、CSV 导出、趋势图、红黑榜与通报 | 分院主席团可复核；班主任可申诉；管理端可导出上报材料 | 3~4 天 |
| **P6（可选）** | 与个人跑分联动 / 微信订阅消息（未录入提醒、复核结果通知）/ 学期届次切换 | 按领导意见决定 | 待定 |

**建议先做 P1+P2 的「卫生 + 查宿」最小闭环**给领导演示（一次录入 → 班级得分 → 首页可见），确认体验后再铺 P3 的考勤模块。

---

## 9.1 实施进度（代码已落地，待联调）

> P1~P5 的服务端与小程序端代码已全部写完，**尚未做端到端联调**（本机无 MongoDB，见下）。
> 验收清单见 §12，联调时按它逐条过。

### 后端（server）

| 层 | 文件 |
|---|---|
| 模型 | `models/union-department.js`（内置部门播种）、`models/union-member.js`（成员任期 + 唯一索引）、`models/check-module.js`（模块注册表）、`models/check-record.js`（记录主表，8 个索引含部分唯一索引 `uniq_slot_active`）、`models/class-profile.js`、`models/dorm-room.js`、`models/dorm-assignment.js`、`models/sanitary-area.js` |
| 服务 | `services/formula.js`（**不用 eval** 的公式解析器）、`services/check-modules.js`（模块定义 + 明细校验 + 指标/扣分计算 + 播种）、`services/union.js`（身份解析 + 权限链 + 播种）、`services/band-chao.js`（班级总评与排名 + 录入台对象 + 60s 排名缓存）、`services/class-profiles.js`（班级台账同步，**只补不覆盖**早操标记） |
| 学生端接口 | `routes/union.js`：`/mine`、`/modules`、`/dashboard`、`/entry/targets`、`/records`（增改查 + 取消）、`/records/:id/review`、`/records/:id/appeal(/review)`、`/class/:className`、`/ranking` |
| 管理端接口 | `routes/admin/union.js`：成员（含批量导入）、部门、模块配置（含恢复默认）、班级台账（同步 / 批量标记早晚操）、宿舍（含 Excel 预览-确认导入）、卫生区、记录（查询 / 统计 / **CSV 导出** / 作废）、`/dashboard` |
| 接线 | `app.js` 挂 `/api/union`；`routes/admin/index.js` 挂 `/api/admin/union`（`union.view` + 写操作 `union.manage`）；`models/permission.js` 加两个权限项；`routes/auth.js` 的 `/me`、login、bind 出口补 `isUnionMember/unionRoles/unionText`（**走 `toSafeJSON()`，不含凭据字段**）；`index.js` 启动期幂等播种部门 / 模块 / 班级台账（台账仅在整表为空时生成） |

### 小程序（miniprogram）

| 位置 | 内容 |
|---|---|
| 首页 | 板块顺序按产品要求重排为：公告条 → 广告位 → **学生会块** → **班超块** → 我的班级 → 今日目标卡 → 快捷入口 → 数据概况；两个块由 `components/banchao-block`（`mode` 区分）**自己判身份**：学生会块要 `isUnionMember`，班超块要 `homeroomClasses` 或 `isClassOfficer`（**普通学生不渲染**） |
| 主包新页 | `pages/banchao/banchao`（班超门户：总评 + 五模块 + 趋势 + 最近记录 + 班级榜前三）、`pages/union/union`（学生会工作台：今日录入进度 + 快捷入口） |
| 分包 `packageUnion` | `entry`（五模块共用录入台，字段由服务端下发）、`records`（列表筛选）、`record`（详情 + 复核 / 申诉 / 留痕）、`stats`（班超排名 + 红黑榜）、`roster`（通讯录） |
| 管理端 | `packageAdmin/union/members`（成员增删改 + 抽屉表单）、`packageAdmin/union/config`（部门 / 检查模块 / 班级台账三合一，含「无早操」筛选与批量标记） |
| 导航 | `custom-tab-bar` 动态项：班委 → 「班超」，学生会成员 → 「学生会」，两者都是时只放「班超」（学生会入口在首页块与我的页）；教师（班主任）中间项 → 「班超」。**管理权限优先**的既有分流逻辑保持不变 |
| 我的页 | 新增「学生会」块（仅成员）与「班超」块（仅班主任 / 班委）；申诉入口指向本班检查记录 |
| 管理中枢 | 新增「学生会与班超」分组（成员 / 配置 / 班超排名），无权限时不显示 |

### 填人的地方一律「搜索选择」，不手输姓名 / 学号

同名同姓与录错一位学号在检查数据里是没法回滚的错误，因此凡是需要填人的表单一律走
`packageUnion/components/person-picker`（搜索 + 筛选 + 多选 + 已选列表，带防抖与过期响应丢弃）：

| 场景 | 交互 | 数据来源 |
|---|---|---|
| 添加学生会成员（管理端） | 关键字（姓名/学号/班级）搜索 + 按院系筛选；**可多选批量添加**，`/members/bulk` 逐个报告成功/跳过/失败 | `GET /api/admin/union/members/candidates`（带「已是成员」标记，避免重复添加） |
| 录入台缺勤名单（晚自习 / 早操 / 早八） | 打开即列本班学生（autoLoad），点选缺勤人员，逐人可切「事假/病假/公假/无故」 | `GET /api/union/entry/students?moduleKey=&className=` |
| 录入台未归名单（查宿） | 同上，且顺带显示该生所在房间号，现场核对更快 | 同上（同接口按 `dorm_assignments` 带出 `roomNo`） |

两处细节：① 名单类字段的单条人数上限由服务端下发（`checkModules.FIELD_LIMIT = 200`），
前端勾选上限与后端校验**同源**，不会出现「前端让选 200、后端只收 100」；
② `entry/students` 复用提交记录的权限链（模块归属 + 院系范围），不会因为多一个查询接口而放开越权读取。

### 第二轮改造（已落地）

用户提出的 6 项在本轮全部实现，口径以本节为准：

| 需求 | 实现 |
|---|---|
| 弹窗无法滚动 | 全部改 `<scroll-view>` + 确定高度（`docs/ui-design.md` 的既有写法）；**嵌套滚动**（选人组件在固定抽屉内）用「结果区降到 400rpx」解决，不用 `catch:touchmove`（会吃掉手势让外层滚不动） |
| 「不跑操」设置 | `class_profiles.hasMorningRun`（与 `hasMorningExercise` **语义分开**：前者管校园跑，后者管早操考勤分母）。两条写路径：`PUT /api/admin/class/:className/profile`（需 `class.manage`）与 **`PUT /api/class/profile`（仅班主任，成员资格校验，无需任何权限）** —— 后者是必需的，否则「被设为班主任但无管理权限」的教师永远改不了自己班 |
| 早八只记缺勤 | `absentCount` / `notReturnedCount` 标 `derived`：**不进录入表单**、前端只读展示推算结果；服务端 `fillDerived()` 总是覆盖、`normalizeDetails()` 丢弃客户端传值（**伪造 `absentCount:0` 无效**）、管理端无法改回可填、考勤接口读取时再重算（历史伪造值也不采信） |
| 命名统一 | 管理入口：**班级管理 / 学生会配置 / 学生会成员**；「班超」保留为产品名（门户页与评比文案） |
| 分类重排 | 管理中枢分 **班级管理 / 学生会** 两组；首页「快捷操作」分三组宫格，且**与 `isManager` 解耦** —— 班主任/班委本来就没有管理权限，挂在管理面板里等于对他们消失 |
| 独立班级管理四 tab | `packageAdmin/class/class`：**学生名单 / 校园跑 / 班级考勤 / 班级配置**；配置 tab 走**双路径**（有 `class.manage` → 管理端接口；班主任/班委 → 班级域接口，`canEdit` 决定可写性） |

配套的关键设计决定（后续改动请勿破坏）：

1. **管理端导航只有一份数据**：`miniprogram/utils/nav-groups.js` 是管理中枢（`pages/hub`）与首页「快捷操作」的**共用数据源**。
   两处以前各写一套 `GROUPS` / `HOME_ENTRIES` + `entryVisible`，权限 key 与分组名都漂移过（例：导入名单在 hub 写 `user.manage`、服务端实际要 `user.import`，导致只持 `user.import` 的账号看不到入口）。
   **改分类只能改这个文件**，不要在页面里另写清单。

   **两处交互刻意不同**（用户明确要求，别统一）：

   | 位置 | 交互 |
   |---|---|
   | 管理中枢 `pages/hub` | **分类 + 按钮平铺**：每个分类下列出全部入口按钮，点按钮**直接进页面**（不做折叠、不弹浮层） |
   | 首页「快捷操作」`pages/home` | 宫格按钮**只显示分类名**；点分类后：**可用条目 >1 → 弹浮层选条目**，**只剩 1 条 → 直接进页面**（浮层模板 `templates/nav-sheet.wxml` + 行为 `behaviors/nav-sheet.js`） |

   **「班级管理」与「我的班级」是两个不同页面**（用户明确：班级管理管所有班级，
   教师管自己名下班级的入口叫「我的班级」）：

   > ⚠️ **2026-10-19 变更（以此为准）**：
   > ① ~~教师侧那页由「我的班级」改名为「班超联赛」~~ → **已按用户当场纠正回退**：
   >   用户原话「管理中枢的我的班级还是叫我的班级，我只是说我的班级中的之前的班级考勤更为班超联赛」，
   >   所以**页面名与入口名仍叫「我的班级」**，只有**页内第三个 tab**（原「班级考勤」）改名为「班超联赛」；
   > ② 原独立页 `pages/banchao/banchao`（班超详细页）**已删除**，内容并入该 tab
   >   （与「班级考勤」合并 —— 用户口径「班超跟考勤不是一个东西吗，并入就行」）；
   > ③ 该页 tab 由「学生名单 / 校园跑 / **班级考勤** / 班级配置」变为
   >   「学生名单 / 校园跑 / **班超联赛** / 班级配置」；
   > ④ 「班级管理」（管理员管全校台账）**名字与职责不变**。

   | 页面 | 入口文案 | 谁能进 | 权限模型 |
   |---|---|---|---|
   | `packageAdmin/class/class` | **我的班级**（页内 4 tab：学生名单 / 校园跑 / **班超联赛** / 班级配置） | 班主任 / 班委 | 成员资格校验（`homeroomClasses` / `isClassOfficer`），**不需要任何管理权限** |
   | `packageAdmin/class-manage/class-manage` | **班级管理**（全校台账：早操 / 早八 / 校园跑标记、人数、从学籍同步） | 学生处 / 管理员 | `class.view` 读、`class.manage` 写 |

   班级台账原先是「学生会配置」页的一个 tab，本次拆成独立的「班级管理」页：台账管的是全校所有班级，
   与学生会（部门、检查模块）不是一回事，且它的权限语义是 `class.*` 而非 `union.*`。
   新页走专属路由 `/api/admin/class/profiles`（列表 / `POST …/sync` 同步 / `PUT …/:id` 改开关）。

   **「班级管理」页能设什么**（用户要求）：

   | 项 | 录入方式 | 存储 | 说明 |
   |---|---|---|---|
   | 早操 / 早八 / 校园跑 | 点开关（需 `class.manage`） | `class_profiles.hasMorningExercise / hasMorningClass / hasMorningRun` | 为 false 的班不进对应考勤的录入台与出勤率分母 |
   | 教室 | 点一下填「1号教学楼·201」 | `class_profiles.classroom`（字符串） | 纯展示与检查核对用，不参与统计口径；刻意不建教室台账表 |
   | 卫生区 | 抽屉内多选 + **就地新建** | `sanitary_areas.classNames`（只改"本班加入哪些区域"） | 全校卫生区此前**没有任何维护页**（后端有接口、零 UI）；不支持就地新建则新学校打开就是空列表，功能等于不存在 |
   | 宿舍 | 二级页 `class-manage/dorms`，逐个学生填「1号楼·201」 | `dorm_assignments`（**学生 ↔ 房间**） | ⚠️ 见下 |
   | 院校 / 系部 / 专业 / 年级筛选 | 四个 picker（**前三级联动**，选项来自接口 `facets.tree`） | `class_profiles.schoolName/departmentName/specialty/grade`（同步带出，不开放手改） | 院校=school 层、系部=department 层、专业=specialty 层（与用户管理页同词）。**facets = 组织架构树 ∪ 台账 ∪ 学籍 distinct**：只读台账会让"组织架构里配了校区却没班"的院校整个消失（**用户实际报障：下拉只有北校区，缺洋河校区/教师院**）。**联动规则**：选院校→系部只剩该校的、并重置专业；选系部→专业只剩该系部的；任一级选「全部」→下一级恢复全量；**年级是正交属性，始终全量不联动**。筛选与归组都按名字（导入只写名字不写 id）；选项标注「（N 个班）/（暂无班级）」 |

   > **宿舍只能「学生绑房间」，不能「班级绑房间」**（用户明确纠正：存在混宿）。
   > 一间房可住几个班的学生，同班学生也可能分散在不同楼。所以房间的班级归属**按在住学生算**
   > （`services/dorms.js::roomOwners`），混宿房间的得分按各班住宿人数**分摊**；
   > `dorm_rooms.className` 只是无名单时的兜底展示，绝不参与计分归属。
   > 配套地，`check_records` 的「唯一槽位」索引**必须含 `className`** —— 否则混宿房间第二个班那条记录
   > 会被唯一约束直接拒掉（历史上只能把整间房的分记给一个班）。启动期 `dorms.migrateSlotIndex()`
   > 负责建新索引并删旧的 `uniq_slot_active`（Mongoose 不会自动替换已存在的同名索引）。
   >
   > 另两处同类陷阱（都已修，改代码时别再退回）：
   > ① 班级域 `PUT /api/class/profile` 的文本字段分支**必须按 key 写回**，不能硬编码 `remark`
   >    —— 加了 `classroom` 后硬编码会让"填教室"把备注整段覆盖掉；
   > ② 班级域与管理端两条 `presentProfile` 的**字段名与年级推导口径必须一致**
   >    （前端两条路径共用一套渲染），且 class.js 记得 `require('../services/roster')`
   >    （漏 import 会让 `GET /api/class/profile` 直接 500，`check-class-profile-e2e.js` 能抓到）。

   **宿舍的四个入口与统一口径**（同一份数据，别在任何一处另写一套逻辑）：

   | 入口 | 页面 | 接口 | 能做什么 |
   |---|---|---|---|
   | 按班批量维护 | `packageAdmin/class-manage/dorms`（班级管理 → 宿舍） | `/api/admin/class/profiles/:id/dorms*` | 看本班谁没绑、逐个绑/退宿 |
   | 按人设置 | `packageAdmin/user-detail`（用户详情 → 宿舍卡） | `PUT/DELETE/GET /api/admin/users/:id/dorm` | 给任意学生绑房间 + 床位号 |
   | 列表展示 | `packageAdmin/users`（用户管理列表） | `GET /api/admin/users` 每行带 `dorm` | 只读 |
   | 名单展示 | `packageAdmin/class` 学生名单 tab | `GET /api/class/students` 每行带 `roomText` | 只读（班主任/班委） |

   - 绑定/换房/自动建档统一走 `server/src/services/dorms.js::assignStudentRoom`（**只读复用**，四处不得各写一套）；
     展示串统一 `roomLabel()` → 「1号楼·201」。
   - 批量补宿舍一律「当页 openid 一次 `$in` + Map join」，**禁止 N+1**；教师行永远不给宿舍（不住学生宿舍）。
   - 写权限 `user.manage`（用户侧）/ `class.manage`（班级侧）；`user.view`/`class.view` 只读。
   - 任何改住宿的动作都要回填 `class_profiles.dormCount`，且**同时回填「学生当前班」与「被改记录自己的 className」**
     —— 转班后历史记录仍是老班名，只刷一边会让老班人数永久虚高。
   - 删除账号（`DELETE /api/admin/users/:id`）会把在住记录置 `checked_out` 并在 remark 标注「（账号已删除）」：
     不清就会让那间房的应住人数虚高（记录不物理删除，查宿历史还要它）。

   > 顺带修掉的 AGENTS.md 红线：`GET /api/admin/users` 列表此前只 `.select('-__v')`，真实账号的
   > `passwordHash/initialHashes/resetHashes` 会进列表响应（详情一直排除、列表漏了，本地 dev_* 测试账号没有这些字段所以发现不了）。
   > 现在三个出口（列表 find / 日周达标聚合 / 详情）统一由 `CREDENTIAL_FIELDS` 常量派生 ——
   > **新增凭据字段只改这一处**，不要在某个分支再写硬编码字符串。

   **学员侧「教室 / 卫生区」与企业侧对齐**（用户报障：「我的班级 → 班级配置」不能设教室与卫生区）：

   - 教室：`PUT /api/class/profile` 已含 `classroom`（仅班主任可写），配置 tab 有输入框；班委 disabled。
   - 卫生区：班级域新增 `GET/PUT /api/class/sanitary` —— **权限 = 班主任可写、班委只读、外人 403 + 403002**
     （走 `resolveScope` 成员校验，**不用 requirePermission**）；只增删本班在 `sanitary_areas.classNames`/`weights`
     里的存在，**绝不动其他班的归属与权重**；同样支持**就地新建区域**（否则新学校老师打开是空列表）。
   - ⚠️ 卫生区有**两份语义相同但代码独立**的实现（班级域 `routes/class.js`、管理端 `admin/class-profile.js`），
     字段名一致；改语义必须**两处同步**。班级域只有这一条读路径，因此「持 `class.view` 但非本班的人」在该区块
     只会看到一行指向「班级管理」页的说明（不发必然 403 的请求）。

   **宿舍绑定抽屉已收成一份公共组件**（用户报障：「用户详情的弹窗与班级宿舍的弹窗不一致」）：

   - 组件 `miniprogram/components/dorm-sheet/`（**主包**，与既有 8 个组件一致；两处页面用绝对路径
     `/components/dorm-sheet/dorm-sheet` 注册）。`"styleIsolation": "apply-shared"` 才能用 app.wxss 的 `.tt-sheet*`。
   - **全受控**：组件不存草稿副本，输入/快捷点击统一抛 `change{field,value}`，页面回灌；
     `save{roomText,bedNo}` / `unbind` / `close`；**组件不发任何请求**（两处接口不同，取数与提交留在页面）。
   - 统一形态 = 单栏「宿舍号（楼号·门号）」+ 可选「床位号」+ 楼栋/本班已有房间快捷 + 退宿/保存
     （班级侧此前**缺床位号入口**，统一后两处能力一致；后端 `assignStudentRoom` 一直支持 `bedNo`）。
   - 两处**故意保留**的差异：班级侧不传 `disabled`（其 `load()` 已滤掉未绑微信学生）、快捷房间由
     `GET …/dorms` 自算；用户侧用 `/users/:id/dorm` 返回的 `quickRooms`。`canUnbind` 判定口径一致。

   > ⚠️ 同名班级跨院校 / 系部的**归属歧义不许静默**：`aggregateRoster` 的 `$first` 已改为**多数票**
   > （同输入结果稳定、幂等），并把冲突收集成 `conflicts`（含各值计数与最终选中值）由 `POST /profiles/sync`
   > 透出，前端弹窗提示管理员去核对。**改回 `$first` 会让"只剩一个校区"这类问题复发且无从发现**。




   分类标题按人群动态取（`nav-groups.js::groupTitle`）：只有教师侧条目时标题是「我的班级」，
   含管理员的全校台账时是「班级管理」，两者都有（既是班主任又持 `class.view`）时取上位概念「班级管理」。

   > ⚠️ 条目 key 与 `hub.js::go()` 的特判必须同步：教师的「我的班级」key = **`classMy`**（多班班主任点它要走选班抽屉），
   > 管理员的「班级管理」key = **`classManage`**（直跳台账页）。这个坑踩过两次（先 `class`→`classManage`、
   > 再本次把 `classManage` 语义让给台账页），两次都会让多班班主任**静默走第一个班**；`check-nav-groups.js` 有断言守住。

   > 单条目判定必须按**实际可见**条目数（`entryVisible` 过滤后）算，不能只看配置里的原始条数：
   > 「学生会」配置有 3 条，但只持 `ad.view` 的账号只剩「检查记录」1 条可见 → 该直接跳。
   > 副作用是同一分类对不同角色可能跳不同页（`tools/scan-nav-single-item.js` 会列出这些组合，便于复核）。

   8 个分类（用户钦定，顺序即展示顺序）：

   | # | 分类 | 条目 | 显示条件 |
   |---|---|---|---|
   | 1 | 我的班级 / 班级管理（按人群动态取，见下） | 我的班级（教师）、班级管理（管理员台账）、班超排名 | 前两条 `only:'class'`（班主任 / 班委，无需管理权限）；台账条目需 `class.view` |
   | 2 | 学生会 | 学生会成员、学生会配置、检查记录 | `only:'unionMember'`；成员→`union.view`、配置→`union.manage` |
   | 3 | 用户与权限 | 用户管理、导入名单（`user.import`）、权限组、组织架构 | 各条 `perm` |
   | 4 | 考核与目标 | 运动考核、默认目标、计划目标、跑分设置、反作弊 | `assessment.view` / `config.view` |
   | 5 | 申诉审核 | 申诉审核 | `appeal.view`（天然单条目 → 点分类直接进页） |
   | 6 | 内容与通知 | 公告、节假日、内容中枢、徽章、版本日志 | `content.view` |
   | 7 | 广告运营 | 广告素材管理、赞助商、广告位、广告统计、广告落地页 | `ad.view` |
   | 8 | 系统设置 | 系统配置、文件管理、北斗运动 | `only:'admin'` |

   - 「班超排名」**只在「我的班级」分类出现一次**（用户明确：学生会里不该有重复的班超排名）。
     非班委的学生会成员看榜单走首页 / 我的页的班超相关入口，不靠管理导航。
   - 「北斗运动」**只有一个条目**（用户明确：「激励视频规则就是北斗运动」）：声明 `url = 规则配置页` + `fallbackUrl = 用户端页`，
     有 `config.view` 的账号进规则配置页、否则进用户端页面 —— 合并成一条后必须让 `url` 按权限择一，否则持单一权限的人点了必然 403。
   - 分类 3/6/7/8 里各有一两条「用户没点名、但原本只在管理中枢有入口」的页面（组织架构、徽章、内容中枢、广告落地页）——
     不折进来就会变成**不可达**（功能还在、没人能进）。`tools/check-admin-nav-coverage.js` 专门守这条。
   - 首页管理卡的**内部顺序**（用户要求）：数据概况 → 平均步数排行 → **快捷操作**。
     `showHomeEntries`（有无可见入口）与 `isManager`（管理数据）是两个独立条件，不可混用 ——
     班主任 / 班委没有管理权限，看不到数据与排行，但必须看到快捷操作。

2. **管理中枢的班级特判按条目 key 走**：`hub.js::go()` 用 `key === 'classManage'` 特判，多班班主任才会弹「选班抽屉」。
   踩过的坑：条目 key 改成 `classManage` 却仍判 `'class'` → 多班班主任静默进了第一个班（很难发现）。改 `nav-groups.js` 的 key 必须同步 `hub.js`。

3. **共享组件放主包**：`components/attendance`（班级考勤）与 `components/person-picker`（搜索选人）被**两个不同分包**引用，而平台规则是「分包页面只能引用同包或主包的组件」→ 必须在主包。`tools/check-app-json.js` 会拦下跨分包引用。

4. **`summary` 就是模块 map**：`GET /api/class/attendance` 的 `summary` 顶层键即 moduleKey（模块字段直接挂上面），**不是** `summary.modules`；`days[].modules` 是对象。前端曾两次读错这一层，症状是「全部显示未录」——`tools/check-attendance-component.js` 用真实形状做夹具，专门防这个。

5. **无早操判定看两处**：`summary[key].skipped`（配 `skipReason` 文案）**以及** `classInfo.hasMorningExercise === false`。第二处必要：区间内可能一条记录都没有，只有班级属性判得出来。

### 验收工具（本机无 MongoDB 也能跑）

| 命令 | 覆盖 |
|---|---|
| `node tools/check-miniprogram.js` | 结构 + **JS 语法解析** + **U+FFFD 编码事故检测** + 事件/图标/class/闸门 + 主包体积 |
| `node tools/check-app-json.js` | 页面四件套、组件路径可解析、**跨分包引用组件**、tabBar 页归属主包 |
| `node tools/check-server-contract.js` | 后端 61 项契约（服务导出面 / 索引 / derived 防伪造 / 五模块扣分基线 / 班级域权限模型） |
| `node tools/check-class-profile-e2e.js` | 班级配置**真实路由** + 打桩 DB：班主任可读写、班委只读、跨班 403、白名单拦 `studentCount` |
| `node tools/check-attendance-component.js` | 考勤组件 15 条：无早操文案、`ratePercent` 直采、服务端加权平均、某天单元格、days 倒序等 |
| `node tools/check-nav-groups.js` | 管理导航角色矩阵（5 种身份）+ 校验**管理中枢与首页分类完全一致**；并断言两处**交互不同**（hub 平铺直跳、首页分类弹浮层） |
| `node tools/check-admin-nav-coverage.js` | **每个管理端页面都有入口或属于设计上的二级页**（防止重构分类时把页面变成不可达） |
| `node tools/check-sheet-scroll.js` | **所有 `.tt-sheet` 抽屉的滚动区是否给了确定高度**（scroll-view 没确定高度就滚不动，是本站踩过多次的坑） |
| `node tools/scan-nav-single-item.js` | 列出「哪些角色下某个分类只剩 1 条可见」（这些分类点一下会直接跳页，需复核是否可预期） |

### 已知问题与待办

1. **主包体积**：`node tools/check-miniprogram.js` 报「主包 ≈ 2.21 MB（上限 2 MB）」。
   npm（tdesign）约 0.87 MB、业务代码约 1.38 MB。**超限在本轮开始前就存在**（当时 2.09 MB）；本轮贡献约 77 KB：两个门户页 + 两个块组件约 39 KB + **把两个共享组件移入主包约 38 KB**（移包是为满足跨分包引用规则，见上文决定 1，属于正确性成本）。
   另有历史因素：`assets/home/hero.jpg` 已从 HEAD 的 74 KB 涨到 107 KB（更早一次提交正是为瘦身：1.94→1.76 MB）。
   收缩选项（按性价比排序）：① 压 hero.jpg 到 80 KB 内；② 清理主包未引用资源；③ 把 `pages/reward` 等**非 tab** 大页下沉分包（`/pages/run/index` 是 tabBar 页，下沉会破坏「跑步」tab 的一次点击，不建议）。
2. **端到端联调**：本机没有 MongoDB（`127.0.0.1:27017` 拒绝连接），所有接口只做了「语法 + 契约 + 打桩路由 e2e + 纯函数用例」验证，**未跑真实数据库请求**。联调步骤：启动 MongoDB（或指向测试库）→ `cd server && npm run dev`（`.env` 里 `DEV_LOGIN=true`）→ 小程序 `env.js` 设 `DEV_LOGIN: true` 与目标账号 → 按 §12 清单逐条过。
3. **必须人工在微信开发者工具里验证的**（本机无小程序运行环境，无法自动化）：三个抽屉滚到底、首页三种账号（管理员/班主任/普通学生）的快捷操作分组、四 tab 的切 tab 手势、无早操班级在考勤 tab 的显示。
4. **批量「不跑操」标记**：`services/class-profiles.js::batchSetFlags` 的字段白名单目前只放行早操/早八两项；单班改可用两条 PUT，批量需把 `hasMorningRun` 加进白名单（1 行）。
5. **`hasMorningRun === false` 时校园跑 tab 仍展示数据**（只加提示条）—— 产品口径未定，先不隐藏数据。
6. **宿舍与卫生区的录入台**已支持（`targetTypes` 含 `dorm_room` / `area`），但需要先导入住宿名单与维护卫生区映射，否则录入台对象为空 —— 联调前先准备这两份数据。

---

## 10. 扩展位（本期不做，但结构上留好）

1. **个人跑分联动**：`check_scoring.pointsLink` 预留 `{ enabled, perPoint, weightsByModule }`；实现时在 `services/points.js` 增加 `pointsFromClassChecks(openid, date)` 并接入日/周聚合（注意历史口径重算问题）。
2. **检查项字典化**：卫生检查项、违规项字典做成配置集合（现在先放模块配置里）。
3. **微信订阅消息**：录入提醒（当日 21:00 未录）、复核结果通知、申诉反馈。
4. **多学期**：`union_terms` + `check_records.termId`，学期切换后历史保留、榜单重置。
5. **与现有 `class_monitors` 的收敛**：旧「班长绑定」集合与 `isClassOfficer` 语义重叠，建议在 P4 一并标注废弃（只读兼容，不再新增绑定入口）。

---

## 11. 风险与待确认

### 11.1 风险与对策

| 风险 | 对策 |
|---|---|
| 越权录入（录别人院系/别的班） | 服务端三重校验（成员资格 + 模块归属 + 院系范围），且**校验目标班级确实存在于该院系**；前端隐藏不算数 |
| 学生会成员被误授予管理权限 | 学生会成员 = `student` 角色 + 成员记录，**不给 `*` 权限组**；管理端入口与学生会域完全分离 |
| 检查记录暴增（每日 5 模块 × N 班） | 单表 + 复合索引；聚合走 `$match date` 前缀；首页总评做 60s 进程内缓存（沿用 `routes/class.js::classRankCache` 的做法） |
| 早操/早八分母争议 | `cancelled` 明确退出统计，无早操班级不进分母，公式写在服务端常量并在管理端展示说明 |
| 「未录入即扣分」误伤 | 默认**只提示不扣分**，配置项由学校决定开启 |
| 数据被改而不留痕 | `revision` + `history` + 不可物理删除；复核/申诉/作废全留 `operator` 与时间 |
| 隐私：学号/姓名出现在学生会端 | 学生会端默认展示姓名 + 班级，**学号按需遮蔽**；复用现有 `privacy.hideName` 遮蔽口径 |
| 与运动数据混淆 | 班超与跑分是两个域，页面分区、接口分区（`/api/union/*` 不复用 `/api/class/*`） |

### 11.2 待确认（需领导拍板）

1. **早操/早八的“应有”如何维护**：按班级逐个标记，还是按年级/专业批量规则？（建议两者都支持：批量规则 + 班级覆盖）
2. **卫生检查的评分口径**：百分制打分还是只记扣分项？（影响 `scoring.mode`）
3. **查宿的检查单位**：按房间逐间录，还是按班级汇总录？是否要按楼层/检查组拆分？
4. **晚自习「在宿舍网课」是否纳入出勤**：纳入即算“出勤”，还是单列指标不参与出勤率？
5. **插班口径**：插班学生计入“对方班”的应到还是实到？跨院系插班是否允许？
6. **学生会成员名单来源**：管理端手工录入 / Excel 导入 / 由学生会自己提供名单后管理员确认？
7. **是否需要对班级公示与红黑榜**（首页展示还是仅通报群内）？
8. **检查结果是否与班主任考核、班级评优挂钩**（若挂钩，导出格式与周期需提前定）。

---

## 12. 验收清单（评审通过后直接当测试用例）

- [ ] 普通学生首页：**没有班超块**、没有任何录入或申诉入口；本班公开排名只能从排行榜页看到
- [ ] 班委：tabBar 出现「班超」，首页有班超块（在广告位下方、我的班级上方），页内只读（无提交按钮），可发起申诉
- [ ] 首页板块顺序对所有角色一致：公告条 → 广告位 → 学生会块 → 班超块 → 我的班级 → 今日目标卡 → 快捷入口 → 数据概况（无数据的块整体不渲染）
- [ ] 班主任（无管理权限）：tabBar 中间项为「班超」，可看所带班级全部检查明细，多班时可切换
- [ ] 生活部部员：只能录**本院校（校区）下各系部**的教室/宿舍/卫生区卫生；录别的校区班级返回 403 + `403002`；同一对象同日重复提交被拦并可改
- [ ] 分会（校区）学生会的范围：绑北校区 → 只能看/录北校区下各系部的班（洋河校区的班 403）；**北校区没配系部时看不到任何记录，且管理端有 `campusWarning` 提示**
- [ ] 跨校区同名部门：给北校区分会和生活部分会都加「生活部」，**第二条不报 500**（唯一索引含 `schoolId` + 启动期迁移已生效）
- [ ] 学习部部员：晚自习可录「在教室 + 在宿舍网课 + 请假 + 插班进出」，出勤率与页面展示一致
- [ ] 纪检部部员：查宿可带出本班未归名单；**无早操班级不出现在早操录入台**；临时取消录 `cancelled` 后该班当日退出统计
- [ ] 早八同样支持无早八班级与取消
- [ ] 首页「学生会块」只在学生会成员账号出现，展示身份 + 今日录入进度 + 快捷入口
- [ ] 既班委又学生会成员：tabBar 1 个动态项（班超），首页同时有班超块与学生会块
- [ ] 分会主席团（`level=branch`）：可复核本院校（校区）下各系部记录（通过/退回），不能复核其它校区
- [ ] 管理端：能配部门与成员、模块启停与计分权重、班级早操标记、宿舍与卫生区映射、导出 CSV
- [ ] `/api/auth/me` 返回 `isUnionMember` / `unionRoles`，且**不含任何凭据字段**
- [ ] 所有新页面 `onLoad` 首行有登录闸门；未登录不发业务请求
