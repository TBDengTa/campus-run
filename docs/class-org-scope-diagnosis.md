# 班级归属院系 / 院校筛选「暂无班级」诊断与修复方案

> 触发：用户 2026-11-13 报「部员检查录入时提示**目标班级没有归属院系，无法确认范围**」，
> 并截图班级管理页院校下拉显示「北校区（暂无班级）/ 洋河校区（暂无班级）」，
> 但**选下去确实能筛出班级**；用户同时说明「院系都与专业相应绑定」。
>
> 诊断部分的数字均来自**真实库**（`server/.env` 指向的 campus_run，2026-11-13 15:30~15:50 实测），
> 复现命令见文末附录。

---

## 〇、修复状态（2026-11-13 已落地）

| 项 | 状态 |
|---|---|
| 26 级整届缺 `departmentId`（20 班 / 1147 学生 / 152 房 / 21 区 / 3 条真实记录） | ✅ 已用 `server/scripts/backfill-org-ids.js --apply` 回填 **1340 条**；再跑 dry-run 为 0 条 |
| 写入/名单路径只读 id、不按名字兜底 | ✅ 新增 `services/org-resolve.js`（唯一实现），`resolveClassInfo` / `resolveTarget`（宿舍/卫生区）改走它 |
| 控制台显示「分院学生会」 | ✅ 改为真实校区名（`北校区学生会 · 纪检部 · 部长`），`/api/union/mine` 另下发 `campusName` |
| 跨校区拦截文案看不出原因 | ✅ 文案带两个校区名 + 「请让管理员核对该成员的院校」 |
| facets.tree 院校 count 恒 0（「暂无班级」） | ✅ 系部命中分支也累加院校 count；`unmappedDeptCount` 改挂节点；facets 与列表同 status 口径 |
| 宿舍/卫生区同名系部跨校区判错 | ✅ 不再 `list[0]` 猜；用归属班级的院校消歧，推不出则标 `orgAmbiguous` 并 fail-closed |
| 导入 / 台账同步再次产生「只有名字」的班 | ✅ `roster.importRows` 新建与更新都写 id；`syncClassProfiles` 缺 id 时按名字补（只补不覆盖） |
| 回归 | ✅ `tools/check-org-resolve.js`（静态 34 项）+ `tools/verify-org-scope.js`（真连库 21 项）全通过；`check-server-contract` 887 项、`check-union-review`、`check-union-entry-form`、`check-page-runtime`、`check-admin-users-page` 均通过 |

实测验证（北校区纪检部部长 闻响 / 洋河 姜承林）：本校区班级、宿舍、卫生区的名单接口全部 200；
另一校区仍 403；提交 26 级记录成功且落库 `departmentId=6acc…ae / departmentName=计财系`；
复审队列能看到该记录；测试记录已清理。

> 下文第二~六章是**当时的诊断记录**（保留现场与证据），第七~九章是方案。
> 实际落地的口径比方案更收敛：**id 优先、名字只在 id 缺失时兜底**，且名字兜底只比对
> 「本校区展开出的系部名」，不会跨校区放行。

---

## 一、结论速览

| # | 现象 | 根因 | 严重度 |
|---|---|---|---|
| **A** | 录入台能列出 26 级受检对象，一点缺勤名单 / 提交就 `403 403002 目标班级没有归属院系，无法确认范围` | **写入/鉴权路径按 `departmentId` 判范围**（`inDepartmentScope` fail-closed），而 26 级 20 个班 `class_profiles.departmentId` **全为 null**；列表路径用的是「按名字反查组织树」（`band-chao.js::resolveOrg`），两条路径口径不一致 | **P0 阻断录入** |
| **B** | 班级管理页院校下拉「北校区（暂无班级）」，但选中确实能筛出班级 | `routes/admin/class-profile.js::buildFacetTree` 第 ④ 段**把院校节点 count 只在「系部名没命中」的分支里 +1**；系部命中的分支只给系部计数、不向上累加到院校 → 院校节点恒 0。前端 `withCount()` 把 0 渲染成「暂无班级」 | **P1 误导**（不影响筛选，纯展示错） |
| **C** | 26 级班级 / 学生 / 宿舍 / 卫生区普遍只有**名字**没有 **id** | 名单导入（`services/roster.js`）只写 `schoolName` / `departmentName`，从不写 `schoolId` / `departmentId`；`syncClassProfiles` 只在学籍里有 id 时才回填 id → 整届 26 级 id 全空 | **P0 数据面**（A 的成因） |
| **D** | `check_records.departmentId = null` 的记录，分院成员**看不到、也复核不了**（会永远卡在待复核） | `union.js::scopeFilter` / `canReview` / 复审队列全部只认 `departmentId` | **P1 流程漏洞**（A 的次生问题） |
| **E** | 宿舍/卫生区按名字反查系部时，**同名系部跨校区**会挑错校区（实测 2 间宿舍 + 1 个卫生区） | `resolveOrg` 在没有 `schoolId` / `schoolName` 时退化为 `list[0]`（按插入顺序随便取一个同名系部） | **P2 范围错判** |

**用户观察到的「院系与专业绑定」是成立的**：组织架构里 35 个专业全部挂在正确的系部下，
（院校 + 专业）组合 **唯一确定** 一个系部（35/35，歧义 0）；台账 52 个班、学籍 35 个（院校/系部/专业）
组合也 **100% 能在组织架构里解析**。所以这不是「配置错」，而是**「配置存在但记录里没带 id」+「页面计数没累加」**。

---

## 二、现象 A：目标班级没有归属院系（阻断录入）

### 2.1 代码路径（谁在哪里判的）

```
录入台列表  GET /api/union/entry/targets
  → services/band-chao.js::entryTargets
      → resolveOrg(p, maps)        ← 按 departmentName 反查组织树，返回 departmentId  ✅ 有值
      → targets.push({ departmentId: org.departmentId })   ← 前端拿到的是「查出来的 id」

点缺勤名单  GET /api/union/entry/students?moduleKey=…&className=…
提交记录    POST /api/union/records
  → routes/union.js::resolveClassInfo(className)
      → profile.departmentId ? String(...) : ''      ← 直接读台账字段，26 级为 ''  ❌
  → services/union.js::canEnterModule(identity, moduleDef, target.departmentId)
      → inDepartmentScope(identity, '') → false
      → 因为 identity.level === 'branch' 且 want === ''
      → reason = '目标班级没有归属院系，无法确认范围'    ← 用户看到的文案
```

两处关键代码：

- `server/src/routes/union.js:191-209` —— `resolveClassInfo()` 只取 `class_profiles.departmentId`
  （注释明说「分院范围校验的基准」），**没有**按名字反查。
- `server/src/services/union.js:378-385` —— `inDepartmentScope()` 对空 `departmentId` **返回 false**
  （注释：fail-closed「宁可判成越权，也不能因为拿不到归属就放行」）；
  `server/src/services/union.js:411-412` 把空值翻译成那句用户文案。

### 2.2 真实库证据

```
class_profiles 共 52 个班，缺 departmentId 20 个 —— 正好是整届 26 级
  26级云计算技术应用 / 信息安全技术应用 / 商务数据分析与应用 / 大数据与会计 / 大数据技术 /
  工业机器人技术 / 工程造价 / 应用化工技术 / 建筑工程技术 / 数字媒体技术 / 智能轧钢技术 /
  机械制造及自动化 / 机电一体化技术 / 现代物流管理 / 电子商务 / 电气自动化技术 / 软件技术 /
  金属材料检测技术 / 金融科技应用 / 钢铁智能冶金技术
users（学生）2716 人，缺 departmentId 1147 人（26 级整届 1143 + 零散 4）
dorm_rooms 335 间，缺 departmentId 153 间；sanitary_areas 37 个，缺 21 个
check_records 42 条，departmentId 为空 7 条（3 条真实 26 级 + 4 条测试残留 rv_verify_*）
```

用真实路由 + 真实北校区分会成员（昝程静）复现：

```
GET  /api/union/entry/targets?moduleKey=study_evening           → 200，23 个对象，26 级 5 个都在列表里
GET  /api/union/entry/students?className=26级大数据技术         → 403 403002 目标班级没有归属院系，无法确认范围
POST /api/union/records  {targetId:'26级大数据技术'}             → 403 403002 同上
GET  /api/union/entry/students?className=25级大数据与会计       → 403 只能录入本院系的检查（这条是**正确**的：洋河校区 vs 北校区分会）
```

> 说明：`25级大数据与会计` 的那条 403 是**正常的跨校区拦截**，不是 bug。
> 真正异常的是 26 级：同一个校区的班，列表能列出来、录不进去。

### 2.3 为什么「能列出来」

`band-chao.js::resolveOrg()`（**唯一**会按名字反查的地方）在 `departmentId` 缺失时会：
1. 用 `departmentName` 在组织架构里找同名系部；
2. `schoolId` / `schoolName` 存在时用校区二次收敛；
3. 返回 `{ departmentId, departmentName, schoolId, schoolName }`。

所以 `entryTargets` 下发的 26 级对象**带着正确的 departmentId**（实测 23 个对象里
`departmentId` 为空 **0** 个），录入台按院校/系部筛选、按班级分组全都正常 —— 这就是用户说的
「确实能筛选」。但写入与鉴权根本没走这个函数，于是「列表能点、点开就 403」。

### 2.4 严重程度与影响面

- **整届 26 级（20 个班、1143 名学生、152 间宿舍）无法录入任何检查**，包括晚自习 / 早八 / 早操 / 卫生 / 查宿。
- 只有**校级**身份（`identity.level === 'school'`）能录 —— `inDepartmentScope` 对校级直接 `return true`，
  所以主席团/校级部长目前是唯一能录 26 级的人。分会（含各校区主席团、部长、部员）全部被拒。
- 台面上看到的「录入台有 23 个对象、能点进去」会让检查人以为只是**偶发权限问题**，
  实际是**整届数据面缺 id**，重试无效。

---

## 三、现象 B：院校下拉「暂无班级」但能筛选

### 3.1 代码路径

`server/src/routes/admin/class-profile.js:576-602`（`buildFacetTree` 第 ④ 段）：

```js
const dept = deptName ? school.depts.get(deptName) : null;
if (dept) {
  dept.count += 1;                                  // ← 只给系部 +1
  if (spec) specialtyNodeOf(dept, spec, false).count += 1;
  continue;                                         // ← 直接 continue，院校节点没加
}
// 院校在组织架构里、系部名不在 → 才走这里
school.node.count += 1;                             // ← 只有「系部没命中」才 +1
if (deptName) school.unmappedDeptCount = (school.unmappedDeptCount || 0) + 1;
```

于是：**只要某个班的院校名与系部名都能在组织架构里命中（正是正常数据），院校节点 count 恒为 0。**

另外两个连带缺陷：

- `school.unmappedDeptCount` 写在了 **tree 索引条目**（`{ node, depts }`）上，
  而不是 `school.node` 上 —— 这个字段**永远到不了响应体**（`treeNode()` 里也没有它的初值）。
- 前端 `miniprogram/packageAdmin/class-manage/class-manage.js:201-206::withCount()`
  把 `count === 0` 一律渲染成「（暂无班级）」，不区分「真没班」与「计数错」。

### 3.2 真实库证据（同一个接口、同一份数据里两个值互相矛盾）

```
GET /api/admin/class/profiles?page=1&limit=5&status=normal  （真实账号，超级管理员组）

facets.schools   = 北校区 count=37 / 洋河校区 count=15        ← 平铺口径正确
facets.tree      = 北校区 count=0（depts: 计财系 26 / 机电建工系 7 / 冶金材料系 4 = 37）
                   洋河校区 count=0（depts: 计财系 5 / 机电建工系 6 / 冶金材料系 4 = 15）
请求体里的 total = 43（=「只显示正常班」口径：北校区 28 + 洋河校区 15）
```

- 院校节点 count=0，**它下面三个系部加起来正好 37** —— 一眼可见「父子不守恒」。
- 前端院校 picker 读 `facets.tree`（`buildOptions()`），系部 picker 也读 tree，于是：
  **院校显示「（暂无班级）」，系部显示「计财系（26个班）」**，而选院校确实能筛出班级
  （`GET /profiles?school=北校区` 走的是 `filter.schoolName` 等值匹配，与 count 无关）。
- 这正好是用户截图那一屏。
- **还有一个次生口径问题**（修完 count 后会暴露出来）：facets 的计数是**全量台账**
  （`ClassProfile.find({})`，含实习/毕业班），而列表默认只显示正常班。
  所以修好后下拉会写「北校区（37个班）」，点进去「只显示正常班」却只有 28 个 ——
  这是**第二个会让人以为筛选坏了的不一致**，修 count 时必须一并处理（见 7.4 第 3 条）。

### 3.3 影响面

- 纯**展示层**错误：筛选、列表、批量操作都不受影响。
- 但它是**运维最容易被带偏的信号**：管理员看到「暂无班级」会去「从学籍同步」反复点，
  或去组织架构重复建院校（历史报障「配置了却看不到」就是这一类），而真实问题是计数逻辑。
- `emptyReason()` 也依赖 `count`：只要列表非空就走不到该文案，所以这次没表现为「空列表」，
  只表现为下拉标签错。

---

## 四、现象 C：26 级整届只有名字没有 id（A 的数据面成因）

### 4.1 代码路径

- `server/src/services/roster.js:399-410`（更新已有用户）与 `:444-463`（新建用户）：
  只写 `schoolName` / `departmentName` / `specialty` / `className`，**从不写 `schoolId` / `departmentId`**
  （只有 `PUT /api/auth/school`、管理端「转移院校」`resolveTransferTarget()` 这两条人工路径才会回填 id）。
- `server/src/services/class-profiles.js:187-212`（`syncClassProfiles`）：
  ```js
  if (r.schoolId) set.schoolId = r.schoolId;
  if (r.departmentId) set.departmentId = r.departmentId;   // ← 学籍没有 id 就不写
  ```
  注释写明「只补不覆盖 / 学籍有值才写」是**刻意**的（避免把手工修正抹成空）。
  结果是：**学籍整届没有 id → 台账整届 never 得到 id**，两边一起空。

### 4.2 可解析性（修复可行性已验证）

按「（院校名, 系部名）」在组织架构里反查，要求**唯一命中**：

```
class_profiles 缺 departmentId：20 个班 → 可唯一解析 20 个（100%）
users（学生）缺 id：1147 人 → 可唯一解析 1145 人（99.8%）
   北校区|计财系 501 / 北校区|机电建工系 363 / 北校区|冶金材料系 279
   洋河校区|计财系 1 / 洋河校区|机电建工系 1
   ∅|∅ 2 人（示例学生1/2，班级 24级软件技术，无任何归属 —— 应保持为空并单独占位）
dorm_rooms 缺 departmentId：153 间 → 借房间 className → 台账 schoolName → 可解析 153 间（100%）
sanitary_areas 缺 departmentId：21 个 → 借责任班 → 可解析 20 个（1 个是冒烟测试区「测试」，责任班 56级冒烟1班 不在台账）
check_records 缺 departmentId：7 条 → 可解析 3 条（真实 26 级），4 条是 rv_verify_* 测试残留
```

**歧义风险已排除**：同名系部（计财系/机电建工系/冶金材料系）在两个校区各有一个，
但**加上院校名后组合唯一**（7 个组合里只有 `∅|∅` 那 2 个示例学生无法解析）。
专业同样：35 个（院校+专业）组合，没有任何一个对应多个系部。

---

## 五、现象 D：departmentId 为空的记录，分院看不到也复核不了

`server/src/services/union.js:692-698`：

```js
function scopeFilter(identity) {
  if (identity.level === 'school') return {};           // 校级：全校 ✅
  const ids = (identity.departmentIds || []).filter(Boolean);
  if (!ids.length) return null;
  return { departmentId: { $in: ids } };                // ← 只认 id
}
```

`canReview()`（`:453-471`）同样只比 `departmentId`。于是 `check_records.departmentId = null` 的记录：

- 分院成员：`/records`、`/review/queue`、`/dashboard` 的待复核数**全都看不到**；
- 部长：`canReview` 返回 false → **永远无法复核**，记录永久停在 `submitted`；
- 校级：能看到、能复核（所以现网那 3 条 26 级记录最终是 `approved`）。

与「班级榜、班级状态看板」形成鲜明对比：那两个页面走 `class-status-board` / `/api/union/ranking`
**已经用「名字兜底」**（`routes/union.js:2232-2237` 在渲染层按 `schoolName / departmentName` 过滤），
所以**同一批 26 级数据：看板能看、记录看不到** —— 这正是「数据没错、口径分叉」的典型症状。

---

## 六、现象 E：同名系部跨校区的反查退化

`server/src/services/band-chao.js:363-378`：

```js
let candidates = list;                                  // list = 同名系部的全部组织节点
if (r.schoolId)      candidates = list.filter(d => d.parentId === r.schoolId);
else if (r.schoolName) candidates = list.filter(d => d.parentId === 该校区);
dept = candidates[0] || list[0] || null;                // ← 两者都没有 → 按插入顺序随便取
```

宿舍与卫生区**都没有 schoolId/schoolName 字段**（`dorm_rooms` 335/335 缺 schoolId，
`sanitary_areas` 37/37 缺 schoolId），所以必然走到 `list[0]`。用「在住学生的多数院校」做真值交叉核对：

```
宿舍：可核对 282 间，判错 2 间
  · 洋河·男宿男宿416（机电建工系，departmentId 指向北校区节点）→ 判北校区，真实洋河校区
  · 洋河·女宿209（计财系，无 departmentId）                    → 判北校区，真实洋河校区
  其中「缺 departmentId」的 151 间里判错 1 间
卫生区：可核对 26 个，判错 1 个
  · 洋河校区男生宿舍楼前区域（计财系，责任班 25级商务数据分析与应用 / 25级现代物流管理）→ 判北校区，真实洋河校区
```

现在只错 3 条，是因为「洋河校区的班大多住在洋河」这类数据巧合；**任何一次跨校区新增都会静默错判**，
而且错判方向是**把记录记到另一个校区的系部**，属于跨校区越权/错算，比报错更难发现。

---

## 七、修复方案

### 7.1 总原则

1. **单一实现**：新增 `server/src/services/org-resolve.js` 作为「组织归属解析」的唯一实现
   （`loadOrgIndex()` + `resolveDepartmentOf({departmentId, departmentName, schoolId, schoolName})`），
   `band-chao.resolveOrg`、`routes/union.resolveClassInfo`、宿舍/卫生区解析全部改为调用它。
   （仓库既有约定：`resolveOrg` 已有其实现在 band-chao，但只被录入台列表用到 —— 这次把它提成公共层。）
2. **fail-closed 不变**：解析不出来（组合为空 / 同名校名歧义）仍然拒绝，只是**拒绝理由要可读**
   （「该班的系部名『X』在组织架构里找不到，请到组织架构补系部」而不是「没有归属院系」）。
3. **id 为主、名字兜底**：与 `services/ranking-scope.js`（已落地）保持同一口径，
   不要再出现「有的页面用 id、有的页面用名字」。

### 7.2 P0-1：写入/鉴权路径按名字兜底（修现象 A，代码面）

`server/src/routes/union.js::resolveClassInfo()`：

```js
const profile = await ClassProfile.findOne({ className: name }).lean();
if (profile) {
  const org = await orgResolve.resolveDepartmentOf({
    departmentId: profile.departmentId,
    departmentName: profile.departmentName,
    schoolId: profile.schoolId,
    schoolName: profile.schoolName,
  });
  return {
    className: name,
    departmentId: org.departmentId,       // ← 名字反查后的 id（原为空则现为真 id）
    departmentName: org.departmentName,
    schoolId: org.schoolId,               // 新增：供写入 / 范围判定复用
    schoolName: org.schoolName,
    ...
  };
}
```

同一份 org 结果要顺着 `resolveTarget()` 返回，使 `POST /records` 在
`CheckRecord.create({ departmentId: target.departmentId  ||  null })` 时**写入的是解析后的 id**，
而不是继续写 null（`routes/union.js:1804`）。这一步是「新数据不再产生脏记录」的关键。

> 注意：`resolveTarget` 的宿舍分支（`:249-290`）与卫生区分支（`:293-315`）目前是
> 「房间自己的 departmentId → 否则主班台账」；改为统一走 `resolveDepartmentOf`，
> 并额外接受「从 className 反推 schoolName」这一层（见 7.5）。

### 7.3 P0-2：数据回填（修现象 C，一次性 + 可重跑）

新增 `server/scripts/backfill-org-ids.js`（命名与 `backfill-badge-level.js` 一致，**幂等可重跑**，
默认 `--dry-run`，写库需显式 `--apply`）：

| 集合 | 补什么 | 依据 | 预计命中 |
|---|---|---|---|
| `users` | `schoolId`、`departmentId` | (schoolName, departmentName) 唯一命中组织架构 | 1145 人（另 2 个示例学生跳过并打印） |
| `class_profiles` | `schoolId`、`departmentId` | (schoolName, departmentName) | 20 个班 |
| `dorm_rooms` | `schoolId` | 房间 `className` → 台账 `schoolName` | 全部 335 间（当前 0 间有） |
| `dorm_rooms` | `departmentId` | ① 已有值→校验；② 否则 (推得的 schoolName, departmentName) | 153 间 |
| `sanitary_areas` | `schoolId` | 责任班 `classNames[0]` → 台账 `schoolName` | 能解析的 26 个 |
| `sanitary_areas` | `departmentId` | 同上 | 20 个（1 个冒烟测试区打印告警、不写） |
| `check_records` | `departmentId` | `className` → 台账解析 | 3 条真实记录；`rv_verify_*` 测试残留只打印不写 |

脚本输出必须是「**每条改动前后值 + 无法解析清单 + 总计数**」，且写库前先 `countDocuments` 核对，
写完再跑一次必须 0 改动（幂等自证）。**不要把回填写成启动期自动执行** —— 它是数据修复，
不是 schema 迁移；放 `scripts/` 由管理员显式执行，避免部署时静默改数据。

> 前置：`syncClassProfiles()` 不改动也没关系（回填后 id 已就位）；
> 但**强烈建议同时**在 `syncClassProfiles` 里加「名字可解析但 id 为空时补 id」的分支，
> 否则下一次「从学籍同步」虽不会抹掉 id（`if (r.departmentId)` 才写），
> 但**新导入的 27 级仍会重复出现同样的空 id**（见 7.6）。

### 7.4 P1-1：修 facets.tree 的院校计数（修现象 B）

`server/src/routes/admin/class-profile.js:588-602` 改为「计数向上累加」：

```js
const dept = deptName ? school.depts.get(deptName) : null;
if (dept) {
  dept.count += 1;
  school.node.count += 1;                        // ← 补这一行（父子守恒）
  if (spec) specialtyNodeOf(dept, spec, false).count += 1;
  continue;
}
school.node.count += 1;
if (deptName) school.node.unmappedDeptCount = (school.node.unmappedDeptCount || 0) + 1;  // ← 改为 node
```

配套三处：

1. `treeNode()` 加 `unmappedDeptCount: 0` 初值，让前端能稳定读到（不再出现 undefined）。
2. 新增**不变量自检**：`packages` 末尾断言
   `school.count === sum(school.departments[].count) + (该院校下「有院校无系部」的班数)`；
   不成立就 `console.warn` 带院校名与数目（这类错不报错、不改色，只能靠断言抓）。
3. 前端 `withCount()` 的文案细化（可选）：
   `count === 0 && !configured` → 「暂无班级」；`count === 0 && configured` →
   「已配置，暂无班级」。语义更准，但**不改也能用** —— 修完 7.4 主逻辑后 0 就是真 0。
4. **计数必须与列表同口径（否则修完 count 会换来第二个「筛选坏了」的报障）**：
   现在的 `facets` 是**全量台账**（`ClassProfile.find({})`，含 9 个实习班），
   而列表默认 `status=normal`。实测北校区全量 37、正常班 28 —— 修好后下拉写「37个班」、
   点进去却只有 28 个。二选一（**推荐 a**）：
   a. facets 聚合也按 `status` 过滤（`status=normal` 时只数正常班），让「下拉数字 = 点进去的班数」；
   b. 保留全量计数，但文案改成「37个班（含实习/毕业）」并在 `emptyReason` 里说明。
   无论选哪个，**验收断言必须是** `tree[校区].count === 该校区在「当前 status 口径」下的班数`
   （与 `total` 相加相等），否则这类不一致永远只能靠人眼发现。

### 7.5 P1-2：记录可见性 / 复核的范围判定加名字兜底（修现象 D）

`server/src/services/union.js`：

```js
// scopeFilter：id 集合 + 系部名集合（与 ranking-scope.js 同口径）
function scopeFilter(identity, deptNames = null) {
  if (!identity?.isMember) return null;
  if (identity.level === 'school') return {};
  const ids = (identity.departmentIds || []).filter(Boolean);
  const names = (deptNames || identity.departmentNames || []).filter(Boolean);
  if (!ids.length && !names.length) return null;
  const or = [];
  if (ids.length) or.push({ departmentId: { $in: ids } });
  if (names.length) or.push({ departmentName: { $in: names } });
  return { $or: or };
}
```

`canReview()` / `reviewableOf()` 的 `targetDepartmentId` 改成接收 `{ departmentId, departmentName }`，
两者任一命中即放行（同样 fail-closed：都为空 → false）。

配套约束（**必须一起做，否则是放宽越权**）：

- `identity.departmentNames` 由 `buildIdentity()` 从 `campusDepartmentIndex()` 的
  `deptId → name` 映射展开（校区下全部系部名），**不能**取成员记录里的 `departmentName`（那是老口径）。
- 名字分支必须带校区消歧（同名系部跨校区）：`scopeFilter` 的 `$or` 里，
  `departmentName` 条件要 `$and`(校区条件) —— 与 `ranking-scope.js::scopeClauses` 完全一致，
  **建议直接复用 `rankingScope.scopeClauses` 的系部分支**，不要再写第二份。
- 前提是先做 7.3 回填：回填后 26 级记录都有 id，名字分支只是**兜底**，正常数据走 id。

> 顺序上更稳的做法：**先回填（7.3）→ 再改代码（7.2/7.5）**。回填后现象 A 立即消失（幂等、可回滚：
> 记录旧值清单），代码改动则保证「以后新导入的届别再犯」。

### 7.6 P0-3：让导入链路自己带 id（治本，防 27 级复发）

`server/src/services/roster.js`：

- `smartFillRows()` 在主字段推导之后，增加一步
  `orgResolve.attachIds(rows)`：按 (school, department, specialty) 填 `schoolId` / `departmentId`
  （**唯一命中才填**，歧义/不存在留空并计入 `warnings`，由导入预览下发）；
- `importRows()` 的 create/update 两条分支都把 `schoolId` / `departmentId` 写进用户文档。

`routes/admin/class-profile.js::POST /profiles/sync` → `classProfilesSvc.syncClassProfiles()`：
在「学籍有值才写」的既有规则里补一条 —— **`departmentName` 有值而 `departmentId` 为空且能唯一解析时写 id**。
（仍是「只补不覆盖」：已有 id 一律不动。）

### 7.7 P2：`resolveOrg` 的跨校区退化（修现象 E）

`services/org-resolve.js::resolveDepartmentOf()` 的解析顺序（**严格按优先级，任一命中即停**）：

1. `departmentId` 有效且节点类型为 department → 用它（同时校验 parentId 与 `schoolId` 一致，不一致报警）；
2. `(schoolId, departmentName)` → 唯一命中；
3. `(schoolName, departmentName)` → 唯一命中；
4. `(推得 schoolName, departmentName)`：调用方可传「从班级/房间在住学生推得的校区名」；
5. 只剩 `departmentName` 且同名节点 ≥2 → **不再 `list[0]`**：返回 `{ ambiguous: true, candidates: [...] }`，
   调用方按场景决定：
   - 录入台对象列表：该对象照常列出，但 `departmentId` 留空且打 `orgAmbiguous: true`，
     前端列表项显示「归属待确认」角标（不阻断列出，但**阻断写入并就歧义给出可读原因**）；
   - 宿舍 / 卫生区：先用 `className` / `classNames[0]` 推校区（数据面 100% 可推），推不出才判歧义。

宿舍可推校区的前提已经具备：`dorm_rooms.className` 335/335 有值，据此 100% 能推出校区；
卫生区 26/37 有责任班，其余 11 个需要管理员补责任班（在班级管理页勾选即写 `classNames`）。

---

## 八、验收与回归

### 8.1 新增静态检查 `tools/check-org-resolve.js`

- `org-resolve` 是唯一实现：`band-chao` / `routes/union` / `routes/admin/class-profile` 里
  **不得再出现**自拼「deptByName 反查」的循环（正则反向断言）；
- `inDepartmentScope` / `canReview` / `scopeFilter` 三处都接受名字兜底，且都 fail-closed；
- `buildFacetTree` 院校 count 有向上累加（`school.node.count += 1` 在 dept 分支里存在）；
- `unmappedDeptCount` 写在 `node` 上且 `treeNode()` 有初值；
- 导入链路 `roster.importRows` 写入 id（正向断言）。
- 前端 `withCount()` 对 `configured && count===0` 的文案分支（若采纳 7.4 第 3 条）。

### 8.2 新增端到端验证 `tools/verify-org-scope.js`（真连库）

用**临时班级 / 临时成员 / 临时房间**（跑完删除并核对残留 0）覆盖十条：

1. 造一个「只有 schoolName+departmentName、无 id」的临时班 + 临时房 + 临时学生；
2. 分院成员：`entry/targets` 能列出 → `entry/students` **200**（不是 403）；
3. `POST /records` 成功，且落库 `departmentId` **非空**；
4. 该记录出现在**分院部长**的 `/review/queue` 里，且 `canReview=true`；
5. 另一个校区的同名系部成员：同一对象 **403**（跨校区仍拦，证明兜底没放宽越权）；
6. `facets.tree` 的 `school.count === Σ departments[].count`（对真实库全量跑）；
7. 院校 picker 文案不再出现「（暂无班级）」而该院校确有班级
   （真实库断言：`status=normal` 下北校区 28 / 洋河 15，二者相加 = `total` 43）;
8. 宿舍/卫生区按「班级→校区」解析，与「在住学生多数校区」一致（拿本次的 3 条已知错例做回归）；
9. 歧义场景：造两个同名系部且都不带校区 → 写入被拒且 reason 含「归属待确认」；
10. 清理核对：临时文档全部删除，计数归零。

### 8.3 现有检查器要跟着改

- `tools/check-server-contract.js`：第 351-364 行已有「录入台预检（null 目标）不按院系拦截」用例，
  新增「id 为空但名字可解析 → 允许」与「名字也解析不出 → 仍拒绝且 reason 可读」两条。
- `tools/check-admin-users-page.js` 第 [11] 节：补 `buildFacetTree` 父子计数的断言（`school.node.count` 累加）。
- `tools/check-page-runtime.js`：给 `class-manage` 加一条 payload（`tree` 里院校 count=0 但 depts 非空）
  断言渲染出的 label 不是「暂无班级」（若采纳文案细化）。

---

## 九、执行顺序建议（低风险优先）

| 步 | 动作 | 影响面 | 回滚 |
|---|---|---|---|
| 1 | 跑 `backfill-org-ids --dry-run`，人工核对清单 | 只读 | 无 |
| 2 | `--apply` 回填 users / class_profiles / dorm_rooms / sanitary_areas / check_records | 写数据（有前后值输出） | 用 dry-run 输出反写 |
| 3 | 部署 7.2（`resolveClassInfo` 名字兜底）+ 7.4（院校计数） | 代码 | 回退文件 |
| 4 | 部署 7.5（scopeFilter/canReview 名字兜底）+ 7.6（导入带 id） | 代码 | 回退文件 |
| 5 | 部署 7.7（歧义不再 `list[0]`） | 代码 | 回退文件 |
| 6 | 跑 `check-org-resolve` / `verify-org-scope` / 既有三个 check | 只读 | 无 |

> 第 1-2 步做完，**用户当天报的 403 就会消失**；第 3-5 步防止「27 级导入后复发」。
> 第 3 步与第 2 步**互不依赖**，但先回填能让第 3 步的回归用例更贴近现状。

---

## 十、附录：本次排查用的复现命令

一次性脚本（已按仓库约定 `tmp/_probe-*.js` 命名并在排查后删除），要点如下：

```js
// ① 复现 403：真起 routes/union.js，auth 打桩成北校区分会成员
authMw.auth = (req, _res, next) => { req.user = user; next(); };
GET /api/union/entry/students?moduleKey=study_evening&className=26级大数据技术
  → 403 403002 目标班级没有归属院系，无法确认范围

// ② 复现院校 count=0：真起 routes/admin/index.js，auth 打桩成 class.view 账号
GET /api/admin/class/profiles?page=1&limit=5&status=normal
  → facets.schools 北校区 count=37，但 facets.tree 北校区 count=0

// ③ 数据面统计（只读聚合）
class_profiles: 52 总数 / 20 缺 departmentId（= 整届 26 级）
users:          2682 学生 / 1147 缺 departmentId（可唯一解析 1145）
dorm_rooms:     335 / 153 缺 departmentId / 335 缺 schoolId
sanitary_areas: 37 / 21 缺 departmentId
check_records:  42 / 7 条 departmentId 为空（3 真实 + 4 测试残留）

// ④ 反证「院系与专业绑定是好的」
(院校 + 专业) 35 个组合 → 每个都唯一对应一个系部（歧义 0）
台账 52 个班 + 学籍 35 个归属组合 → 100% 可在组织架构解析
```

---

## 十一、给用户的一句话总结

**不是院系配置错了，是 26 级整届的班级/学生/宿舍记录「只有名字、没有组织 id」**；
录入台的「对象列表」按名字能反查出院系所以能列出来，而「提交 / 缺勤名单」按 id 判权限就直接判失败 ——
两套口径不一致造成了「能筛不能录」。班级管理页的「暂无班级」是另一个独立的**计数显示 bug**
（院校节点计数只在系部对不上时才加），筛选本身一直是好的。
回填 id + 统一解析口径 + 修计数，三件事做完即恢复。
