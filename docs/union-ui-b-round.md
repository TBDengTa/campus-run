# 学生会页面 B 端化改造任务书（并行执行）

> 用户原话：**「请你全部重新优化学生会相关面板与页面，仿照移动 B 端设计，现在部分操作很不便利。」**
> 已确认两条方向（用户选择）：
> ① 录入台 → **列表 + 半屏抽屉填表**（列表页只留受检对象 + 搜索 + 完成状态；点对象开抽屉填表；提交后抽屉关闭并自动定位下一个未录对象）
> ② B 端特征 → **吸顶筛选 + 卡片列表 + 抽屉表单 + 底部固定主操作**

## 0. 通用规范（四个智能体都必须遵守，否则四套视觉会打架）

### 只许用这些既有资源（**不要自创样式**）
- 设计令牌：`app.wxss` 的 `--tt-*`（品牌橙 `--tt-brand` / 浅底 `--tt-brand-soft` / 文字三级 `--tt-text-1|2|3` / 圆角 `--tt-radius(-sm)` / 间距 `--tt-gap` / `--tt-pad` / 卡片 `--tt-card` / 分割线 `--tt-line` / 阴影 `--tt-card-shadow`）。
  **禁止硬编码品牌色**（`#ff6b00` 等）与**旧蓝色**（`#0052d9`）。
- 公共类：`.tt-page` `.tt-card` `.tt-card-flat` `.tt-section` `.tt-section-extra` `.tt-hero` `.tt-stat-row/.tt-stat/.tt-stat-value/.tt-stat-label`
  `.tt-grid/.tt-grid-item/.tt-grid-text/.tt-chip-icon` `.tt-row/.tt-row-title/.tt-row-sub` `.tt-segment/.tt-segment-item/.active`
  `.tt-chip/.active/.tt-chip-brand` `.tt-pill-btn(.primary/.ghost)` `.tt-empty` `.tt-muted` `.tt-brand-text` `.num-font` `.tt-footer`
  `.tt-sheet` 系列（`-grab/-head/-icon/-title/-sub/-close/-body/-foot`）`.tt-sheet-label` `.tt-sheet-item` 系列 `.tt-sheet-pills/.tt-sheet-pill`
  `.tt-sheet-field/.tt-sheet-input/.tt-sheet-ph/.tt-sheet-note` `.tt-btn-right`。
- 大数字一律 `.num-font`。

### 抽屉硬性写法（**踩过多次的坑，照抄**）
```
.<页面私有sheet类> { display:flex; flex-direction:column; max-height:80vh; }
.<页面私有sheet类> .tt-sheet-body { flex:none; min-height:0; max-height:46vh; }   /* 底部两个按钮用 42vh */
```
`scroll-view` **必须拿到确定高度**才真的能滚（只写 `min-height:0` / `flex:1` 都会 `scrollTop` 恒为 0）。
抽屉骨架统一 `.tt-sheet*`，**不要再自绘一套 `.xx-sheet`**。

### B 端化的四条统一要求
1. **吸顶筛选**：页面顶部（模块切换 / 状态筛选 / 日期）用 `position: sticky; top: 0; z-index: 10`，
   背景用 `var(--tt-bg-page)`（或卡片色）避免透出下方内容；`.tt-page` 已有内边距，sticky 元素要注意不要被裁。
2. **卡片列表**：每行 = 左侧主信息（标题 + 副信息两行内）+ 右侧状态/数值（`.num-font`）+ 可点区域足够大（整行可点，`min-height ≥ 96rpx`）。
   行与行之间用 `.tt-row` 的分割线语言，或独立小卡（`margin-bottom`）——**同一页内二选一，不要混用**。
3. **抽屉表单**：点列表项 → 开抽屉填表；**抽屉内滚动区确定高度**；底部固定「取消 / 提交」。
4. **底部主操作固定**：主操作（提交/保存）不随内容滚走 —— 放抽屉 `.tt-sheet-foot` 或页面固定底栏（`padding-bottom: calc(... + env(safe-area-inset-bottom))`）。

### 硬约束
- **页面必须保留**：登录闸门 `getApp().requireLogin()`（`onLoad`/`onShow` 首行）、`.tt-page` 根类、
  既有 handler 名（`tools/check-miniprogram.js` 会校验「事件绑定的处理函数未定义」）、既有跳转目标（未登记会报错）。
- **不要动**：`app.json`、`app.wxss`（公共令牌在那，改了会影响全局）、`custom-tab-bar/**`、
  `server/**`（本轮**纯前端改造**，不动后端接口）、`pages/home/**`、`pages/hub/**`、`docs/**`、`tools/**`。
- **不要改接口契约**：现有请求路径 / 参数 / 响应字段一律照旧（后端刚稳定下来）。
- 图标名必须真实存在（可用 `t-icon` 常见名：`file-paste` `check-circle` `chat` `chart-bar` `usergroup` `camera` `close` `refresh`
  `info-circle` `search` `filter` `calendar` `chevron-right` `edit-1` `delete` `add` `check` `location` `home` `flag` `task-checked`
  `time` `user` `swap` `app` `layers` `city` `secured` `setting`）；**新增不确定的图标名前先 grep `icon.wxss` 确认**，否则会渲染空白。

## 1. 分工（**文件零重叠**，每人只碰自己那几件）

| 智能体 | 负责页面（独占） | 本轮重点 |
|---|---|---|
| **A 录入台** | `packageUnion/entry/**` | 列表 + 半屏抽屉填表（用户点名的最大不便利点）；吸顶模块/日期/时段筛选；提交后自动定位下一个未录对象 |
| **B 工作台 + 记录** | `pages/union/**`、`packageUnion/records/**`、`packageUnion/record/**` | 工作台：模块进度卡片化 + 待办优先（待复核/未录入前置）；记录列表：吸顶筛选 + 卡片列表 + 状态标签；记录详情：分区卡片 + 底部固定操作 |
| **C 排名 + 通讯录** | `packageUnion/stats/**`、`packageUnion/roster/**` | 排名：吸顶范围/周期分段 + 榜单卡片（前三名突出）；通讯录：按院校/部门分组、可吸顶分组标题、搜索 |
| **D 管理端学生会** | `packageAdmin/union/config/**`、`packageAdmin/union/members/**` | 配置：部门树 + 模块卡片化、抽屉编辑统一；成员：列表卡片化 + 吸顶筛选 + 添加成员抽屉（现有 person-picker 交互保留） |

> 注意：`packageAdmin/union/**` 是**管理端**（学生处/团委用），B 端化同样是「吸顶 + 卡片 + 抽屉」，与用户侧保持同一语言。

## 2. 验收（每个智能体交回前必须做）
- `node --check` 全部改动 js；
- 仓库根：`node tools/check-miniprogram.js`（**不许新增问题**；基线唯一既有问题是主包体积超 2MB）、
  `node tools/check-app-json.js`、`node tools/check-sheet-scroll.js`（**抽屉滚动区必须有确定高度**）、
  `node tools/check-admin-nav-coverage.js`、`node tools/check-nav-groups.js`（后两个只读校验，不应受影响）；
- **自查清单**（报告里逐条回答）：
  ① 是否有硬编码品牌色 / 旧蓝（应为 0）；② 是否所有抽屉都写了确定高度；③ 登录闸门是否保留；
  ④ 是否有新增的未定义 handler / 图标 / class（checker 会报）；⑤ 接口路径与参数是否与改造前一致（列出你调用的每个接口）。

## 3. 过程记录（复盘用）
- 第 N 轮同类事故：**subagent「完成」≠ 交付**（有耗尽空间中断、有一行未写、有未交报告但代码已改）。
  **每次都必须核对目标文件 mtime + 内容**，不能只看结束语。
- 并行前必须把**跨文件契约钉死**（本轮：令牌/公共类/抽屉写法/接口不变），否则四个智能体会各写一套视觉。

## 4. 进展与交接记录

| 智能体 | 状态 | 备注 |
|---|---|---|
| A 录入台 | **由我接手完成** | 子智能体改完 `entry.js`（列表侧状态机：`stats`/`allEntered`/`locatingId`/`bodyLocked`）后**耗尽空间中断**，`wxml`/`wxss` 未改、且它自己漏掉 `onKeyword`（checker 抓到「事件绑定的处理函数未定义」）。我补齐：`onKeyword`/`clearKeyword`/`viewRecord`/`locateNextMissing` + `pickTarget` 改开抽屉 + 重写 wxml（吸顶区/进度概览/卡片列表/半屏抽屉）+ wxss（`.en-sticky` sticky、`.en-sheet` 抽屉 46vh 确定高度、`.en-target-focus` 高亮）。临时脚本 `tmp/verify-entry-b.js` 12 项断言全绿后删除。 |
| B 工作台+记录 | ✅ 完成 | 待办优先 CTA 卡（待复核/未录/申诉/完成四态）、模块行卡片化 + 状态徽标、记录列表吸顶筛选 + 日期快捷（今天/近7天/本月）+ 高频筛选（仅我的/待复核）、详情六分区卡片 + **底部固定操作栏**（四态决策表，不丢任何既有操作）、照片被裁剪时显示「照片已隐藏（N 张）+ 可见范围」。**顺手修掉一个既有 bug**：详情页 `buildRows` 原先在 `setData` 前读 `this.data.record/module`（首次为 null）→ 关键指标第一次加载恒为空、第二次 `onShow` 才出现；改为显式传参后一次算对（我用桩实测首次即得「在宿率 87.5%」）。 |
| C 排名+通讯录 | ✅ 完成 | 吸顶分段/分组、卡片化榜单与成员行、空态 `.tt-empty`；**未发明接口参数**（`scope` 只有 school/department 两档，保持）；本地过滤不发请求。 |
| D 管理端学生会 | **由我接手完成** | 子智能体**耗尽空间、一行未写**（文件 mtime 仍是 10-16）。我补齐：`config` 吸顶 tab（`.uc-sticky`）+ 模块概览 `moduleStat`（**N 个模块 / M 个未配录入部门**——配置缺口显性化，这是管理员最该一眼看到的）+「未配置（没人能录）」警告文案；`members` 吸顶筛选（`.um-sticky`）+ 职务徽标（`.um-level` → `.um-role`，与模板同步改名）。临时脚本 19 项断言全绿后删除。 |
| 首页「学生会块」 | **我自己改** | 原「待复核 N」只是角落小灰字、操作格子主次不分 → 待办徽标（可点）+ 完成度进度条 + 主操作列表（行尾「已完成/去录入」）+ 次操作小按钮。 |

### 我修掉的两处「并行产出缺陷」（都不在原作者范围内，属汇总方职责）
1. **A 的断裂 handler**：`entry.wxml` 绑定 `onKeyword` 但 `entry.js` 里没有（子智能体自己承认漏掉）→ checker 报错。已补。
2. **C 的吸顶缝隙**：`.ro-group-head` 用 `margin: 0 var(--tt-gap)` 做左右留白，
   而 margin 区域**透明** → 吸顶时成员列表会从两侧 24rpx 缝隙里透出来滚过去。
   已改为整宽 + `padding: 16rpx var(--tt-gap) 12rpx`。
   **这是一条通用规则，新增吸顶元素必须遵守：sticky 元素用 padding 做留白，不要用 margin。**

### 全线统一的两条实现口径（后续改这些页面请沿用）
- 吸顶：`position: sticky; top: 0; z-index: 10;` + **不透明背景** `var(--tt-bg-page)`（本轮前全仓 `position: sticky` 为 0 处，现有 4 处：entry/stats/roster×2）。
- 分层的 sticky：上一层 `z-index: 10`，下层用较小 `z-index` 且 `top` 取上一层的实测高度（roster：搜索条 84rpx + 内边距 = 112rpx）。

### 最终结果（全部完成）

| 改造单元 | 交付者 | 结果 |
|---|---|---|
| 录入台（列表+半屏抽屉） | 我（接手） | ✅ |
| 工作台 + 记录列表 + 记录详情 | B | ✅（另修一个既有 bug） |
| 班级排名 + 通讯录 | C | ✅ |
| 管理端配置 + 成员 | 我（接手） | ✅ |
| 首页学生会块 | 我 | ✅ |

**验收**：全套八检绿 —— `check-miniprogram` 唯一问题仍是既有「主包体积超 2MB」；
`check-server-contract` 90/0、`check-class-profile-e2e` 0 失败、`check-nav-groups` 0 失败、
`check-app-json` 一致、`check-admin-nav-coverage` 无缺口、`check-sheet-scroll` 0 页需修。
**边界**：改动只落在 `pages/union` / `packageUnion/*` / `packageAdmin/union/*` / `components/banchao-block`，
`app.json`/`app.wxss`/`custom-tab-bar`/`server`/`tools` 一行未动（本轮为**纯前端改造**，接口契约零变更）。

**跨组遗留（B 提出，未实施）**：记录详情「提交修改」跳录入台时**不会定位到该条记录**
（entry 只读 `moduleKey`，编辑既有记录要靠 entry 内 409001 冲突流程）—— 这是改造前既有行为。
若要真正实现，需给 entry 加 `recordId` 入参（跨组契约变更），属独立小需求。

### 追加（2026-10-18）：首页「学生会块」视觉返工

用户反馈原话：**「这个学生会块怎么没有白色的背景 而且太难看了，减小比例，重新优化为紧凑排版的UI」**。

1. **没有白底的真因**（不是配色问题）：`components/banchao-block/banchao-block.json` 漏了
   `"styleIsolation": "apply-shared"` —— 组件的样式默认隔离，`app.wxss` 的 `.tt-card`（白底 / 圆角 / 阴影）
   与 `.num-font` 根本没进组件，只有组件自己的 `.bc-*` / `.ub-*` 生效，所以卡片"浮"在页面底色上。
   已补 `apply-shared`（班超块同一组件，白底也一并修好）。
   **凡是组件里用 `.tt-*` 公共类的，json 必须有这一行**（`docs/ui-design.md` 已有同样的约定，这次是漏写）。
2. **紧凑化**（`.union-block` 独立内边距，不影响班超块）：
   - 内边距 32 → `20/24/16` rpx；标题 32 → 28rpx；大数字 44 → 34rpx；
   - 概览与「待复核」徽标同排，进度条 8 → 6rpx 且紧贴概览；
   - 模块行由「两行 + `min-height:96rpx`」压成**单行约 64rpx**（模块名 + 进度 + 去录入 + 箭头）；
   - 底部「我的记录 / 待复核」两个浅橙大按钮 → **两个文字链**（一左一右、不铺底色），视觉权重让给模块行；
   - 结果：3 个模块时整卡约 680 → **400rpx**；新增模块每行约 64rpx。
3. **顺手修掉的口径问题**：`entryModules` 原来 `.slice(0, 3)`，第 4 个以后的可录入模块**在首页没有入口**；
   而概览的「应录」按全部模块求和 → 出现「应录 217、列表却只有 3 个模块」的对不上。
   现在**列出全部可录入模块**，汇总也只统计这些模块（应录数与列表严格一致）。

### 追加（2026-10-18 第二轮）：班超块 + 班超详细页

用户反馈：**「① 板块+页面要紧凑排版 ② 今日班超中要与我的班级一样能够直接滑动切换
③ 班超详细页中今日/本周/本月无法选择其他日期」**。

#### ① 紧凑化
- **首页班超块**（`components/banchao-block`）：旧版是「60rpx 大得分 + 一行 4 个大色块 + 第 5 个独占一行」，
  约 300rpx；改成 **一行头部 + 一行得分/排名 + 一行 5 个小格**，约 200rpx（模块格仍两行文字，不再换行占两排）。
  ⚠️ 模块值**不能用 `word-break: break-all`** —— 它会把「出勤率 98.5%」从数字中间断开（`98.` / `5%`）；
  改用默认 CJK 折行（在空格处断），数字保持完整。已踩过并写进注释。
- **班超详细页**（`pages/banchao`）：hero 得分 88 → 60rpx、内边距 40/36 → 26/28，
  得分与说明改成**左右同行**；周期切换 88 → 60rpx；模块行由「两行 + `align-items:flex-end`」改**单行**；
  记录/榜单行 padding 22 → 18/16；新增「我的班级」入口收成单行（原名 + 说明两行 → 一行）。

#### ② 首页班超块可滑动切换班级
与 `components/class-board`（我的班级卡）**同一套做法**（同一批踩坑结论，改动时请两处一起看）：
- 每个班用 `/api/union/class/:className` 各拉一份、**一次全拉好** → 滑动只切显示、不再发请求；
- 原生 `<swiper>`（手势跟手 + 回弹吸附），高度 = 首屏量一次**所有面板里最高**的那张后写入
  （只量第一张会漏掉「出勤率 98.5%」这种多一行的班 → 滑过去被裁）；
- 头部（班名 / 「今日班超」/ 圆点）在 swiper 之外固定不滑；
- **滑动只更新 `swipeIndex`，不回写 `classIndex`** —— `classIndex` 绑在 `<swiper current>` 上，
  在 `bindchange` 里写回同一序号会让 swiper 收到「跳回原页」而中断手势（真机表现为滑不过去）。
  只有点圆点这种显式操作才推进 `classIndex`。
- **刷新后必须停回正在看的那个班**：`load()` 里 `classIndex` 与 `swipeIndex` 一起写。
  否则「滑到第 2 个班 → 首页 onShow 刷新」时 `classIndex` 被重置成 0，swiper 把视图拽回第 1 个班，
  但头部镜像还停在第 2 个班（数字与卡片对不上）—— 这是本轮自查发现并修掉的真 bug。

#### ③ 班超详细页可选具体周期（今日选日期 / 本周选当月第几周 / 本月选 1-12 月）
- 口径**必须与班级排名页（`packageUnion/stats`）一致**，否则同一个「本周」在两个页面算出不同区间：
  周 = `month` + `weekNo`（「当月第 N 周」，1-7 / 8-14 / …截到月末），月 = `month`，日 = `date`。
  `stats.js` 早就在用 `weekNo`，而 `/api/union/class/:className` 当时只吃 `weekStart`/`month` →
  **服务端补上第 5 个参数**：`routes/union.js` 透传 `weekNo`，`services/band-chao.js::classSummary`
  接收 `weekNo` 并在返回里带 `periodLabel / weekNo / maxWeek`（`rangeOf` 本身早已支持，只是没接上）。
- 切月时**周序号要跟着收敛**（2 月只有 4 周，选着第 5 周会越界）：`onMonthChange` 里夹到 `weekOptions.length`。
- 日期 picker 的 `end` 用 `today`（数据里的今天），**不能用 `date`** —— 用 `date` 的话选了过去的日期后
  上限跟着退回，就再也选不回今天了。
- 顺手修文案：空记录提示原为「本{{rangeLabel}}还没有检查记录」，周会变成「本10月第2周还没有…」；
  改用独立量词 `rangeWord`（今日/本周/本月）。

#### 验收
- 桩测试 `tmp/verify-banchao-block.js` 18 项断言全绿（多班一次拉取、滑动不发请求、不回写 current、
  高度取最高面板、刷新后停回原班、跳转带上当前班、无身份不渲染）；`tmp/verify-banchao-page.js` 15 项全绿
  （三种周期参数、切月收敛周序号、today 上限、rangeWord）；`tmp/verify-rangeof.js` 6 项全绿（服务端口径）。
- **接真后端实测**（本地 `server/.env` 用 `dev-admin` 登录，该账号正好有 4 个班主任班、含截图里的
  「56级冒烟1班」）：`range=week&month=2026-10&weekNo=2` → `from=2026-10-08 to=2026-10-14
  periodLabel=10月第2周`，与 `/api/union/ranking` 同参数**完全同区间**；日/月同样正确。
- 静态检查：`check-server-contract` 113/0、`check-app-json` 一致、`check-sheet-scroll` 0 页需修、
  `check-nav-groups` 0 失败、`check-union-entry-form` 全通过、`check-miniprogram` 唯一问题仍是既有
  「主包体积超 2MB」。

### 追加（2026-10-19 第三轮）：删班超详细页 + 「我的班级」改名「班超联赛」+ 周选择带日期段

用户原话：**「去掉班级班超详细页面，因为在我的班级中的班级考勤中也有这个，将我的班级更改为班超联赛
然后显示这些内容。此外在周选择第几周时要显示时间段如第一周(10月1日至10月7日)」**。
追问后用户确认结构口径：**「班超跟考勤不是一个东西吗，并入就行啊」**。

#### ① 删页 + 并入
- **删除** `pages/banchao/banchao`（4 个文件整目录 + `app.json` 主包登记，主包 28 → 27 页）。
- 原页面内容（总评 hero / 检查明细 5 模块 / 得分趋势 / 最近记录 / 班级榜前三）**全部并入**
  `packageAdmin/class/class` 的「班超」tab；该 tab 紧接着下方就是原来的**班级考勤组件** ——
  正是用户说的「班超跟考勤是一个东西」：考勤看「哪个模块出勤多少」，班超看「这些检查折算多少分、排第几」。
- 该 tab 的 4 个 tab 变成 **学生名单 / 校园跑 / 班超 / 班级配置**（原「班级考勤」标签改名「班超」）。
- **所有入口改指**：`custom-tab-bar`（班委动态项 + 教师中间项）、`components/class-board.goManage`、
  `components/banchao-block.goBanChao`、`packageUnion/stats.goClass`、`pages/profile.goBanChao`、
  `pages/hub.navClass/openClassEntry`、`utils/nav-groups` 的 `classMy` 条目 → 一律
  `/packageAdmin/class/class?tab=attendance[&className=…]`。

#### ② ~~更名「我的班级」→「班超联赛」~~ → **实为「班级考勤 tab → 班超联赛 tab」**
> ⚠️ **2026-10-19 用户当场纠正**（原话）：**「管理中枢的我的班级还是叫我的班级，
> 我只是说我的班级中的之前的班级考勤更为班超联赛」**。
> 上面这一节最初被理解成「整个页面改名」，**改错了范围**，已按下述口径回退：

最终口径（**以此为准**）：
- **页面名与所有入口文案都叫「我的班级」**（回退到位）：`class.json` 标题、
  `wx.setNavigationBarTitle`、首页 `class-board` 标题与两个入口、`profile` 入口、
  `nav-groups` 条目 label、管理中枢分类标题（`groupTitle`）、`class-manage` 指向文案 —— 全部恢复「我的班级」。
- **只有页面内那个原叫「班级考勤」的 tab 改名为「班超联赛」**（`TABS` 第三项 `label: '班超联赛'`，
  key 仍是 `attendance`）—— 这才是用户说的「改为班超联赛」：它承载班超评比内容。
- **「班级管理」保持不变**（管理员管全校台账那一页 `packageAdmin/class-manage`）。
- 教训：**入口名 / 页面名 / 页面内 tab 名是三个层面**，用户说「改为 X」时要先确认改的是哪一层；
  这次一口气改了页面名与全部入口，被用户当场纠正。已把这条口径写进 `nav-groups.js` 与 `hub.js` 的注释。
- 守门断言同步：`tools/check-nav-groups.js` 的「教师条目文案」断言**恢复为「我的班级」**；
  选班断言的正则从 `\?className=` 放宽成 `[?&]className=`（URL 现在还有 `tab=attendance`，className 不再紧跟问号）。

#### ③ 周选择显示日期段（**周必须是完整 7 天**）
> ⚠️ **2026-10-19 用户当场纠正**（原话）：**「本周选择中的如图所示，不应该是这样周要完整的日期不是跟随月截断」**
> —— 截图里圈出的是 `第5周(10月29日至10月31日)`，被月末截断成 3 天，这是错的。

最终口径（**以此为准**）：
- 新增 **`miniprogram/utils/period.js`**（前端唯一实现）：`monthWeekRange / monthWeekOptions /
  weekNoOfDate / dateRangeText`，口径与 `server/src/services/band-chao.js::monthWeekRange` **逐例对齐**
  （`tmp/verify-period.js` 拿 9 个年月周组合与真实服务端函数对拍，9/9 同区间）。
- **周 = 从当月 1 日起算的完整 7 天**：1-7 日为第 1 周、8-14 日为第 2 周 …；
  **最后一周跨到下个月，不再截到月末** —— `10月第5周 = 10月29日至11月4日`（旧行为是 `10月29日至10月31日`）。
  周数上限仍 = `ceil(当月天数 / 7)`（2 月 28 天 → 4 周；31 天 → 5 周），越界周数仍夹到 `[1, maxWeek]`。
  **前后端两处必须同步改**（前端 `utils/period.js`、服务端 `band-chao.js::monthWeekRange`），
  否则同一个「第 N 周」会在排名页与我的班级页算出不同区间（桩测试逐例对拍守着）。
- label 形如 **「第2周(10月8日至10月14日)」**；跨月两端都带月份（「10月29日至11月4日」）避免歧义。
- **服务端同步补字段**：`monthWeekRange` 增加 `weekLabel`（带日期段）与 `weekRangeText`（纯日期段），
  `label`/`periodLabel` **保持原值不动**（既有消费者不受影响）；`/api/union/class/:className`
  与 `/api/union/ranking` 都下发这两个字段。前端优先用服务端回显，不自己重算（算错就与统计区间对不上）。
- 覆盖范围（用户要求「所有出现周期选择的地方」）：我的班级页的「班超联赛」tab（新）、班超排名页
  `packageUnion/stats`（周选择器 label + 一行「本周 10月8日至10月14日」说明）、班级考勤组件
  （父驱动时显示同一区间文案）。校园跑等的「本周」是**固定 ISO 本周**（周一→今天、不可选周），
  没有第 N 周选择器，故不适用。

#### ④ 合并时踩到/修掉的三个真问题
1. **考勤组件会出现两个周期条**：它是自带「今日/本周/本月」的独立组件，并入后与页面的周期选择器打架。
   → 给它加 `rangeFrom / rangeTo / rangePeriod` 三个属性：两者都是合法日期时**父驱动**
   （用父给的区间发请求 + 隐藏自带周期条），只给一端则退回自算（不吃半空区间）。
   未驱动时行为与改造前完全一致，别的引用方不受影响（`tmp/verify-attendance-driven.js` 守着）。
2. **切换周期时考勤会多发一次请求**：区间依赖班超接口回显，回显前组件会先用自算区间发一次。
   → 新增 `localRange()`：切周期 / 换班时先按同一口径在本地算出区间并立即交给组件，回显到达后覆盖为权威值。
   另：**换班时不清空区间** —— 区间只由周期决定、与班级无关，清空只会让组件白发一次请求。
3. **总评卡的排名口径错**：我最初沿用了页面上现成的 `classRank`，但那个来自 `/api/class/overview`、
   口径**固定为本周**，选「今日 / 本月」时会显示成本周名次（原班超页用的是 `data.ranking`，合并时差点丢掉）。
   → 改回 `banchao.rank`（班超接口按当前周期算的那个），并在桩测试里加断言：总评卡区块不得出现 `classRank.rank`。

   顺手修掉一个**原班超页的既有显示 bug**：最近记录的扣分原来渲染 `-{{scoreText}}`，而 `scoreText`
   已经是 `-5` / `0`，于是显示成 `--5` 与 `-0`；`records` 列表是直接渲染 `deductText` 的。
   现在统一直接渲染（见 `class.wxml` 的注释）。

#### 验收
- 桩测试：`tmp/verify-period.js` 18 项（与真实服务端函数对拍）、`tmp/verify-banchao-league.js` 30 项
  （周期参数同口径、考勤区间与班超同区间、**今日文案是单日期而不是日期段**、切月收敛、切班清空重拉、
  名次口径、跳转）、`tmp/verify-attendance-driven.js` 8 项（父驱动 / 半空退回 / 未驱动保持原行为）、
  `tmp/verify-banchao-block.js` 19 项、`tmp/verify-rangeof.js` 6 项 —— **全部通过**（exit=0）。
- **接真后端实测**（本地 `dev-admin`，含截图里的班）：
  `range=week&month=2026-10&weekNo=2` → `from=2026-10-08 to=2026-10-14`、
  `weekLabel=第2周(10月8日至10月14日)`、`weekRangeText=10月8日至10月14日`；
  `/api/union/ranking` 同参数**完全同区间**；`/api/class/attendance` 接受父驱动区间（`days=7`，role=homeroom）。
  权限链未受影响：非学生会 / 非本班的 `dev-teacher`、`dev-sadmin` 访问他班仍 **403**
  （`dev-student` 能看全校是**设计如此** —— 它是校学生会主席团成员，可见范围就是全校，不是越权）。
- 静态检查：`check-server-contract` 116/0、`check-app-json` 一致（主包 27 页）、`check-sheet-scroll` 0 页需修、
  `check-nav-groups` 0 失败、`check-union-entry-form` 全通过、`check-class-profile-e2e` 20 项 0 失败、
  `check-miniprogram` 唯一问题仍是既有「主包体积超 2MB」（删页后体积略降）。

#### 顺手修掉的检查脚本缺陷（非本次任务范围，但阻塞验收）
`tools/check-class-profile-e2e.js` 在验收时 16 项失败，排查后确认**与本次改动无关**，是两个已存在的漂移：
1. **缺桩**：班级域 `GET/PUT /profile` 早已改为调 `liveCount()`（`services/class-counts.js`，走
   `User.aggregate` + `DormAssignment.aggregate`）取「应到 / 应住人数」，而这个**进程内不连库**的测试
   只桩了 `ClassProfileModel` → 路由落到真实 mongoose，报 `users.aggregate() buffering timed out`
   （表象是 500，实为缺桩）。已补两处聚合桩（40 人 / 应住 32 人），GET 侧 10 项恢复。
2. **旧口径残留**：测试 ④ 仍传 `dormCount: 30`，而服务端现在对人数类字段**显式 400**
   （「应到 / 应住人数由学籍与住宿名单自动识别」）；测试 ⑥ 仍期望「静默忽略、值不变」，
   而现在是**明确报错**。已按当前口径更新这两处期望（并新增「被拦下后不写库」断言），
   恢复为 20 项 0 失败。
   注：这两处是**他人未提交的改动**（`routes/class.js` 的 +592 行、新增 `services/class-counts.js`
   均在工作区且非本次任务产物），本次只是把验收脚本对齐到现状，**未改任何产品行为**。

### 追加（2026-10-19 第四轮）：记录详情的复核留痕与底部按钮语义

用户报障（连问两句）：**「复核后应该留下复核人啊，并且为什么这个页面是提交修改呢？」**

> ⚠️ **一个重要前提**：截图那条记录在库里是 `status: 'submitted'`、`reviewedByName: ''`
> （复核人确实还没写）。但排查发现下面几个**真实缺陷**——它们让「即使复核了也看不出来」：
> 所以用户在「还没复核」的页面上问「为什么没留复核人」，实际是若干显示/语义 bug 的叠加观感。

#### ① `presentRecord` 根本不下发 `history`（真 bug）
- `check_records.history` 一直在写（复核 / 取消 / 申诉改判三处都 push），
  但**所有出口的 `presentRecord` 都没有 `base.history`** → 详情页模板写了 `wx:for="{{history}}"`
  却恒为空，永远只显示「暂无复核或修改记录」。
- 已补：`base.history = (r.history || []).map(...)`，且**只在 `withDetails` 分支**下发
  （列表出口用 `{ withDetails: false }`，不需要留痕，避免把数组塞进分页响应）。
- 前端顺手把 `changes` 渲染成人话（新增 `changeLines`）：
  原来是「改了 2 项」，现在是「状态：已提交 → 已复核 / 退回原因：空」——
  字段 key（`status`/`rejectReason`/…）与英文枚举都加了中文标签映射。

#### ② 复核时间有值但页面不展示（真 bug）
- 服务端 `reviewedByName` / `reviewedAt` **两个都写、也都下发**，但模板只渲染了复核人。
- 已补「复核时间」一行（`reviewedAtText` 经 `formatAt` 转成 `MM-DD HH:mm`）。
- 留痕是「谁 + 何时」，缺一半等于留痕不完整。

#### ③ 底部「提交修改」语义错（真 bug，用户点名的那个）
- 原判断只看 `canEdit`、**不看 `status`** → 一条**已复核 / 已退回**的记录，
  只要是提交人或复核者，底部照样显示「提交修改」，像是还能改；
  而服务端对「已复核 + 非复核者」会 403（`routes/union.js` 的 923 行）。
- 已改为 `editable = status ∈ {submitted, cancelled}` 才给「提交修改」；
  终态（approved / rejected）改为展示申诉入口（若还有申诉权），否则不显示主按钮。
  逐状态断言见 `tmp/verify-record-review.js`。

#### ④ 「提交修改」点了等于没反应（跨组遗留，本轮一并修掉）
- `record.js::edit()` 旧实现只传 `moduleKey`，进录入台后停在对象列表，
  用户得自己再找那个受检对象（`docs/union-ui-b-round.md` 上一轮就记过这条遗留）。
- 现在传 `recordId + targetId + date + period`；录入台新增 `focus` / `applyFocus()`：
  先把日期对齐到该记录那天（仅在补录窗口内命中时），再按 `targetId`（兜底 `recordId`）
  找到对象并**复用 `pickTarget` 打开抽屉**。找不到时静默降级 + 一次提示，不报错。

#### ⑤ 编辑时表单是空的（真 bug：会把原值覆盖成空）
- `pickTarget` 只调 `buildInitialForm(target)`，它给的是**字段默认值**，**从不读已有记录** →
  点开一个已录对象、直接提交，会把评价 / 缺勤名单 / 备注整条覆盖成空。
- 已补 `prefillFromRecord()` + `applyRecordToForm()`：读 `/api/union/records/:id` 后
  把 `details` 按字段类型映射回表单（`select` 单选还原字符串、多选还原数组、
  `items` 还原 `{key,label,score,max}`、`students` 原样、照片还原成预览态），
  与提交侧 `buildDetails` **互为逆运算**（桩测试对拍四种类型）。

#### ⑥ 顺带修掉一处损坏的模板串
- `routes/union.js` 申诉改判那行是 ``` `申诉改判??{result || '申诉成立'}` ```——
  `"${"` 被写成了 `"??{"`，会把**源码片段**原样显示成取消原因。
- 已修正为正常插值（`申诉改判：${result || '申诉成立'}`），并加全仓扫描 + 契约断言
  「没有 `??{` 损坏的模板串」，防止同类问题再混进来。

#### 验收
- 桩测试 `tmp/verify-record-review.js` **36 项**全绿（留痕字段齐全 / history 只走详情出口 /
  三处写入点 / 复核人+时间都渲染 / 逐项改动可读 / 六种状态×身份的按钮决策 / 跳转带四类定位参数 /
  编辑预填四种字段类型的映射）。
- **接真后端实测**：用另一个学生会身份（临时加入后已撤回）复核那条记录 →
  `reviewedByName='测试学生管理员'`、`reviewedAt` 有值、`history` 第 2 版带
  `{"status":{"from":"submitted","to":"approved"}}`；列表出口确认**不含** history。
  测试数据已全部还原（记录回到 `submitted`、`revision:1`、`history:[]`，临时成员已删）。
- 契约自检升到 **142 项 0 失败**（新增复核留痕 5 项 + 模板串损坏 1 项）。

### 追加（2026-10-19 第五轮）：早八「未录入即没有迟到」

用户原话：**「早八只录入迟到，未录入就证明没有迟到的情况」**（配图里早八显示「未录」）。
追问后确认：**显示「无迟到」且不再计入「应录/未录」统计**，但**录入台仍列出**班级以便补录。

#### 为什么这是个真问题
早八是五个模块里**唯一「纯扣分」**的（字段只有 `lateList`，没有应到/实到/缺勤）：
它的业务含义是「只记异常人」——没人迟到是常态。而旧实现把所有模块统一按「未录 = 漏录」处理，
于是首页/工作台的「应录 N 条」永远把 45 个班的早八算进去，待办里也永远挂着「早八 45 未录」，
**一个永远还不完的待办**（老师会以为纪检部没干活）。

#### 改法（引入一个语义标记，而不是写死 module key）
- `check_modules` 新增两个字段：**`optionalWhenMissing`**（没有记录 = 正常）与 **`noRecordText`**（未录时的文案）。
  只有早八标记为 `true` / `'无迟到'`；其余四个模块保持 `false` / `''`，**行为完全不变**。
  刻意不叫 `optional`/`disabled`，避免被理解成「关掉模块」——条目与入口都还在。
- **统计口径**（`entryTargets` / `classSummary` / `/dashboard`）：
  - `missing`（未录数）与 `expected`（应录数）对早八**恒为 0** → 不计入首页「应录 N 条」与待办；
  - 新增 **`rawMissing` / `rawExpected`** 保留真实数字（45 个班）→ 录入台内部进度与「去补录」仍可用；
  - `classSummary` 额外下发 `optionalWhenMissing` / `noRecordText`，前端据此渲染。
- **展示口径**（六处文案统一）：班超块、我的班级页的「班超联赛」tab、班级考勤组件（按天单元格）、
  学生会工作台徽标、录入台进度与行内状态 —— 早八未录一律显示「无迟到」（中性灰），
  不再显示「未录」/「去录入」/「已录完」。

#### 踩坑：只 +1 版本号不够（本轮真实事故）
`defVersion` 是用来做**一次性结构迁移**的。我先把 `DEF_VERSION` 从 3 提到 4，随后才加那两个字段 →
启动时迁移分支**已经跑过并落了 4**，新加的字段**永远不会再写进库**：
表现是 `defVersion: 4` 但 `optionalWhenMissing: undefined`，代码改了、库里还是旧的，而**版本号看不出异常**。
- 处理：把该模块 `defVersion` 退回 3、重跑播种 → 字段落库正确。
- **根治**：在「已是当前版本」的幂等分支里补一句 `if (exists.X === undefined) set.X = def.X`，
  这样「先升版本号、后加字段」也能自动补回（只补缺、不覆盖运营改动），并加契约断言守着。
- 教训写进 `services/check-modules.js` 注释：**新增结构字段必须同时进「迁移分支」与「幂等补齐分支」**。

#### 验收
- 桩测试 `tmp/verify-morning-class.js` **45 项**全绿（只有早八带标记 / schema 有字段 / 两个分支都写 /
  summary 口径 / 五处前端文案 / **入口未被过滤掉** / 十项语义逐例，含「晚自习未录仍是未录」的反例）。
- **接真后端实测**（`dev-student`，45 个受检班）：
  `/dashboard` 里早八 `expected=0 rawExpected=45 missing=0 rawMissing=45`，合计应录 **181 → 136**（少了 45）；
  班级接口早八未录返回 `optionalWhenMissing=true noRecordText='无迟到'`；
  **补录未受影响**：提交 1 条迟到 → `lateCount=1`、`deduct=0.5`、`score=99.5`，模块显示「迟到 1人」。
  测试记录已删除，`check_records` 回到 2 条原始数据。
- 契约自检升到 **148 项 0 失败**（新增早八语义 7 项）。

### 追加（2026-10-19 第六轮）：复核权限 —— 主席团可自审

用户报障原话：**「复核页面为什么是提交修改啊，我没法修改这是怎么回事」**

#### 先定位到根因（不是按钮坏了，是权限）
逐项实测（不是猜）：
| 检查项 | 实测结果 |
|---|---|
| 该记录的 `inspectorOpenid` | `dev_student_1` —— **正是当前登录账号**（测试学生甲） |
| 详情页 `canEdit` / `canReview` | `true` / **`false`** |
| 「提交修改」跳转 + 定位 + 预填链路 | 桩测试 15 项全通过（功能没坏） |
| 服务端 `PUT /records/:id` 三道闸门 | 全部放行（**能改**） |

`canReview=false` **只可能**来自 `routes/union.js` 的 `canReview: !isInspector && ...`
——即「禁止复核自己提交的记录」。而库里唯一具备复核资格的人就是提交人本人，
所以这条记录**没有任何人能复核**，页面只能给出「提交修改」，且**不解释为什么**。

#### 改法（用户选定：主席团可以自审，部长不行）
- `services/union.js` 新增 **`canSelfReview(identity)`**：`isPresidiumIdentity(identity)` —— 只有主席团为真。
  - **为什么放开主席团**：主席团是最终复核人，且经常亲自代录；禁止自审会让这类记录永久卡在待复核。
  - **为什么部长仍禁止**：部长复核的是本部门记录，自己录自己审等于没有把关；第二人复核正是该流程的意义。
- `routes/union.js` 两处同步（**唯一口径**）：
  - 详情出口：`canReview = canReview(...) && (!isInspector || canSelfReview(identity))`；
  - 复核接口：自审拦截加 `&& !unionSvc.canSelfReview(identity)`。
- 新增 `selfReviewBlocked` 出口字段：**部长**是提交人时，页面显示说明卡
  「你是这条记录的提交人，不能复核自己提交的记录 / 复核由其他部长或主席团完成」，
  不再只丢一个「提交修改」让用户猜。

#### 顺带修掉的连带问题：放开了复核，「修改」入口会消失
原按钮决策是「复核优先」，一旦 `canReview` 为真就只给「复核通过 / 退回」，
**提交人会再也找不到改内容的入口**。改为三动作：
- 主 = 复核通过，次 = 退回，另有**轻量文字链「修改」**（`barEdit`，仅在 `canEdit && editable` 时出现）。
- 「修改」做成文字链而不是第二个大按钮：一屏最多两个按钮，第三个再占整块会把复核主操作挤没
  （宽度实算：ghost 200rpx + 修改 ≈76rpx + 间距 32rpx ≈ 308rpx，余下 ~394rpx 给主按钮，放得下）。

#### 验收
- 桩测试 `tmp/verify-self-review.js` **32 项**全绿（主席团/部长/副部长/普通成员/空身份 ×
  可自审判定、详情出口与复核接口两处口径、按钮三动作矩阵、模板字段齐备、权限矩阵 5 例）。
- 桩测试 `tmp/verify-edit-flow.js` **15 项**全绿（用真实 hygiene 字段 + area 受检对象 + 已有记录
  驱动 `onLoad → load → applyFocus → pickTarget → prefillFromRecord`：
  抽屉自动打开、`existingId` 指向原记录、评价预填「差」、派生字段不进表单、定位失败静默降级）。
- **接真后端实测**：`canReview` 由 `false → true`、`selfReviewBlocked=false`；
  `POST /records/:id/review` 自审成功 → `status=approved`、`reviewedByName='测试学生甲'`、`revision=2`、`history` 1 条。
  验证后已把记录**还原为 `submitted`**（留给你自己点一次「复核通过」观察完整链路）。
- 契约自检升到 **157 项 0 失败**（新增自审口径 9 项）。

### 追加（2026-10-19 第七轮）：「点击修改没有效果」

用户报障：**「点击修改没有效果，请你完善。」**

诊断后确认 `edit()` **本身是好的**（桩测试证明它确实调用了 `wx.navigateTo` 且参数正确），
「没效果」来自两个叠加的真实缺陷：

#### ① 「修改」是 36rpx 高的下划线文字链 —— 手指点不准
第一版为了「不抢复核主操作」，把第三个动作做成 `text-decoration: underline` 的纯文字，
高度只有约 36rpx（相邻按钮是 88rpx）。手指点上去很容易落在缝隙里 → 表现就是「点了没反应」。
- 改成 **88rpx 高的实体按钮**：`height:88rpx` + `padding:0 28rpx` + 圆角 + **中性浅底**
  （`--tt-bg-page`，不是品牌橙，仍不与「复核通过」抢视觉），并加 `hover-class` 给出点按反馈。
- 宽度实算：ghost 200 + 修改 ≈108 + 间距 32 ≈ 340rpx，主按钮 flex 仍拿 ≈360rpx，放得下。

#### ② `wx.navigateTo` 失败时**完全静默** —— 这是「点了没反应」的典型成因
`wx.navigateTo` 在**页面栈满（10 层）**时直接失败，只写 console、**没有任何界面反馈**。
录入台是深链路（首页 → 工作台 → 记录列表 → 详情 → 录入台…），很容易踩到。
现在分三级兜底，绝不再静默：
1. `getCurrentPages().length >= 9` → 直接 `wx.redirectTo`（替换当前页，详情页本就可离开）；
2. `navigateTo` 失败 → 退到 `redirectTo`；
3. 两者都失败 → `wx.showToast('打开录入台失败，请从「记录」重新进入')`。
（`getCurrentPages` 不存在时也不报错 —— 基础库/测试环境差异，已做 `typeof` 判定。）

#### 验收
- 桩测试 `tmp/verify-edit-nav.js` **17 项**全绿（跳转 URL 五类参数、无 id 不跳、失败兜底、
  栈深 9 走 redirect、栈深 3 走 navigate、无 `getCurrentPages` 不崩、按钮尺寸与底色）。
- `tools/check-union-entry-form.js` 增加 **7 项**常驻断言（按钮尺寸 / 底色 / hover / 绑定 /
  URL 参数 / navigateTo→redirectTo 兜底 / 栈深判断），随仓库检查脚本长期守着。
- 既有 `tmp/verify-edit-flow.js` **15 项**仍全绿（跳过去之后抽屉能自动打开并预填原值）。

### 追加（2026-10-19 第八轮）：去掉重复的「每日明细」+ 班主任/班委看本班

用户两条反馈：
1. **「不需要每日啊，咱们已经有筛选了」**（班超页底部「每日明细」区块）
2. **「班主任与班委都可以查看本班，并且提出复议」**（打开记录详情报「记录不存在或你没有查看权限」，并弹「你还不是学生会成员」）

#### ① 「每日明细」整块下线
- 页面顶部已有「今日 / 本周 / 本月 + 具体日期」的周期选择器，组件再列一遍「每日明细（按日期倒序）」
  既重复，又和概览卡的「该区间暂无考勤记录」**自相矛盾**（卡片说没记录，下面却列出「10月19日 未录入」）。
- 删掉 `attendance.wxml` 的整块渲染 + `attendance.wxss` 的 `.at-list/.at-row/.at-cell…` 样式 +
  `attendance.js` 的 `cellOf` / `normalizeDays` / `dayLabel` / `MAX_DAYS` / `WEEKDAYS`（全部成为死代码）。
- 概览卡需要的「区间内有记录的天数」改用精简的 `countRecordedDays()`，
  `normalizeSummary(data, modules, recordedDaysFallback)` 不再依赖 days 数组。

#### ② 班主任 / 班委被「你还不是学生会成员」挡住（真 bug）
`GET /api/union/records/:id` 开头**无条件** `assertMember(identity)`，而下面的放行条件
`sameClass / isHomeroom` 写在它之后 —— 非学生会成员（班主任、班委）**根本走不到那两行**，
那两句形同虚设。修法：
- 去掉无条件的 `assertMember`；`inScope` 改为 `!!identity.isMember && (校级全校 || 分院本院系)`，
  放行条件补上 `isHomeroom`（`homeroomClasses` 含本班，且**提到判断之前**先算好）。
- `GET /api/union/records` 列表同理：成员走 `scopeFilter`，**非成员只限本班**
  （`homeroomClasses` + 本人所在班 → `className: { $in: [...] }`）。
  越权验证：班主任传 `className=24软件技术` → 实际只返回自己班的记录（`Object.assign` 让 scope 覆盖 query，fail-closed）。
- **附带修掉一个会 500 的真 bug**：`POST /records/:id/appeal` 在组装响应时引用了
  **未声明的 `identity`** → 申诉**已经存库**却抛 `ReferenceError`，客户端显示「申诉失败」，
  重试又提示「已有一条待处理申诉」。改为显式 `identity: null`（宿舍照片由 `canViewDormPhotos` 兜底：
  教师账号 / 检查人直接可见，其余角色 fail-closed）。

#### 验收
- **接真后端实测**（`dev-admin` = `dev_admin_1`，班主任且 `homeroomClasses` 含「56级冒烟1班」）：
  - 详情：`200`，`canAppeal=True`（原先 403「你还不是学生会成员」）；
  - 申诉：`POST /records/:id/appeal` → `appeal.status=pending`、`byRole=homeroom`（原先 500）；
  - 列表：只返回 `56级冒烟1班` 那 1 条；传 `className=24软件技术` 仍只返回本班（隔离生效）；
  - 反例：`dev-teacher`（班主任是 24软件技术，非本班）→ 403，没有放宽。
  - 测试用的申诉已清除，记录状态保持你操作后的 `approved`。
- 桩测试 `tmp/verify-class-access.js` **31 项**全绿（详情/列表/申诉三处源码口径 +
  可见性 7 例 + 申诉资格 5 例 + 每日明细下线 5 项）。
- `tools/check-server-contract.js` 增加 **7 项**常驻断言；`tools/check-attendance-component.js`
  把原来测「按日单元格」的 4 项换成「每日明细已下线」的 5 项并加了 `days` 兜底天数断言。
- 契约自检升到 **164 项 0 失败**。

### 追加（2026-10-19 第九轮）：检查记录列表的筛选条要按身份裁剪

用户报障：**「检查申诉记录不应该是这样啊，上面不应该与学生会中的仅我的和待复核一样啊」**

#### 问题：把学生会的工作台筛选搬给了班主任/班委
`packageUnion/records/records` 同时被两种人打开：
- 学生会成员（工作台 / 我的录入 / 待复核 / 申诉待处理）；
- **班主任、班委**（从「班超」页的「全部 ›」带 `className` 进来，只看本班）。

但筛选条是写死的一套，于是非成员会看到两个**对他们恒为空**的按钮：
- **仅我的** = 我提交的记录 → 班主任/班委从不提交检查记录；
- **待复核** = 等我复核 → 他们没有复核权。

点下去永远是「没有符合条件的记录」，属于「假筛选」（这个页面的注释里本来就警告过这类坑）。

#### 改法：筛选条按身份渲染（不发明新接口参数）
- 页面从 `/api/union/mine` 取 `isMember` / `canReview`，并计算 `classView = !isMember && 有 className`；
- **仅我的**：仅 `isMember` 时渲染（对非成员还会把 `mine` 复位为 false，避免带着一个看不见的筛选进页面）；
- **待复核**：仅 `canReview` 时渲染（没有复核权的人点了也没用）；
- **申诉中**：非成员 / 无复核权 / 已启用时渲染，沿用接口既有参数 `pendingAppeal=1`
  —— 这才是班主任与班委真正需要的（本班哪些记录在申诉流程里）。
- **模块筛选保留**：`/api/union/mine` 对**所有人**都下发模块清单（非成员的 `canEnter=false`），
  所以班主任也能按模块筛本班记录 —— 这个筛选有用，不能跟着「仅我的」一起误伤。

#### 验收
- 新增仓库检查脚本 `tools/check-union-records-filter.js`（**18 项**，常驻）：
  用打桩 `/api/union/mine` + `/api/union/records` 驱动真实页面代码，
  断言两种身份的 `isMember/canReview/classView`、模板渲染条件、`pendingAppeal=1` 的实际请求、
  以及「重置」能一次清干净。
- **接真后端实测**：`dev-admin`（班主任）→ `/api/union/mine` 返回 `isMember=false, canReview=false`，
  模块清单仍有 5 个；`dev-student` → `isMember=true, canReview=true` —— 与页面判定一致。
- 全套 12 个桩测试 + 8 个静态检查通过（仅 `check-miniprogram` 主包体积为既有基线）。

### 追加（2026-10-19 第十轮）：申诉成立要真的改判记录

用户报障：**「申诉成功后应该更改记录啊，并且增加申诉修改痕迹等。」**

#### 问题：申诉成立只改了状态，记录本身没变
旧实现的 `POST /records/:id/appeal/review` 在 `approve` 时只做三件事：
`status='cancelled'`、写 `cancelReason`、`source='appeal'`。
**记录自己的「扣分 40 / 得分 60」原样不动**，留痕也只记了一条「状态：已提交 → 已取消」。
用户点完「申诉成立」看到数字没变、理由也没进留痕，自然会问「到底改了什么」。

#### 改法（经用户第二次纠正后确定）
> ⚠️ **第一版走错了**：我先把「申诉成立」实现成「扣分清零、得分记满分」。
> 用户当场否掉：**「不对啊记录作废不就是没有了吗，也不应该直接是满分。」**
> 这句话点出两件事：① 作废本来就等于「记录没了」，不该再和别的动作并列成「改判方式」；
> ② **申诉成立 ≠ 该班表现满分**，只是原判定不对；正确做法是**更正记录内容**，按新内容重算扣分。

最终模型：**申诉成立必须真的改数据**，两条收尾路径：
- **更正内容并结案**：评审在录入台改数据（评价 / 名单等），`PUT /records/:id` 带 `settleAppeal=true` →
  按更正后的数据重算 `score/deduct`，记录落成 `approved`，申诉标记为成立，**同一条 revision 写清两件事**。
  例：评价 差→良 ⇒ `score 60→80`、`deduct 40→20`（**不是 0/100**）。
- **作废**（确属误录）：`status='cancelled'` + `cancelReason`，整条退出统计 —— 这就是「记录没了」。
- **既不改数据也不作废 → 直接 400 拒绝**：`申诉成立需要更正记录内容（或选择作废），不能只改状态`，
  从协议层堵死「点了申诉成立但记录没变」这个老问题。
- **代码里已彻底没有「记满分 / 扣分清零」路径**（契约断言 `!/record\.score = full/`、`!/record\.deduct = 0;/`）。

留痕（一条 revision 内）：
`grade{from,to}`、`score{from,to}`、`deduct{from,to}`、`status{from,to}`、`appeal.status{from,to}`、`appeal.result{to}`；
`FIELD_LABELS` 补 `deduct: '扣分'`，能直读「扣分：40 → 20」。

前端：点「申诉成立」→ `actionSheet`：
1. **更正记录内容（改完自动结案）** → 跳录入台（`appealReview=1`，自动定位并预填该记录），
   抽屉顶部提示「正在更正申诉记录：按更正后的内容重算扣分，提交后申诉直接标记为成立」，
   提交时带 `settleAppeal`；
2. **作废该记录（误录，退出统计）** → 填理由后作废。
驳回仍只填理由（记录完全不动）。

#### 顺带补齐「申诉修改痕迹」
申诉块原来只显示 状态 / 理由 / 处理意见，现补上
**申诉人（含班主任/班委身份小标签）/ 申诉时间 / 处理人 / 处理时间**（时间经 `formatAt` 格式化）。
另：作废时扣分标签改为「扣分（已作废，不计入）」并显示说明卡；
改判后显示「申诉改判：已按更正后的内容重算扣分，具体改动见下方留痕」。

#### 验收
- **接真后端实测**（另建**临时**记录，避免碰用户正在申诉的那条）：
  - 只改状态不改数据 → **400** `申诉成立需要更正记录内容（或选择作废），不能只改状态`；
  - 更正并结案（差→良）→ `score 60→80`、`deduct 40→20`、`status approved`、`source appeal`、
    `appeal.status approved`；留痕
    `{"grade":{"from":["差"],"to":["良"]},"score":{"from":60,"to":80},"deduct":{"from":40,"to":20},"appeal.status":{...},"appeal.result":{...}}`；
  - 作废 → `status cancelled` + `cancelReason='申诉改判：确属误录'`；
  - 临时记录已删除；用户的真实记录（含那条**待处理申诉**）**一字未动**。
- 桩测试 `tmp/verify-appeal-review.js` **28 项**全绿（含「改判结果不是满分」的语义逐例）；
  契约自检 **172 项 0 失败**。

### 追加（2026-10-19 第十一轮）：复核 / 申诉处理的权限口径

用户口径：**「申诉、审核只能由主席团或负责相应部门的部长处理，院校部门仅处理院校部门的，
全校主席团部门均能负责所有院校的申诉与审核。」**

#### 结论：权限模型本身已经符合，28 项矩阵逐条通过
用真实 `buildIdentity` + `canReview` 跑矩阵（`tmp/verify-review-scope.js`），确认：
- **只有主席团 / 负责该模块的部长**能复核与处理申诉：校级主席（副主席）、生活部部长、副部长可行；
  **学习部部长**（不负责卫生）✗、普通部员 ✗、非成员（教师）✗；
- **全校主席团 / 校级部长** 跨任意院校可行（`reviewLevel='school'` 短路）；
- **分院（院校）侧只限本校区**展开出的院系（`identity.departmentIds` 命中才算），跨校区 ✗；
- 部长必须命中「录入部门」或「模块归属部门」（`inspectorDeptKey` ∪ `module.entryDeptKeys`），
  所以**主席团代录**的记录，模块负责部长仍可复核。

#### 但顺着这条规则查出并修掉一个漏洞（本轮实际改动）
上上轮为「申诉更正结案」新加的 `PUT /records/:id + settleAppeal` 只校验了
`mine || isReviewer` —— 而 `mine`（录入人本人）是**普通部员**时也能通过，
等于**录入人可以给自己的记录结案申诉（自己批准自己的申诉）**，直接违反这条规则。
- 修法：`if (body.settleAppeal === true && !isReviewer) → 403 只有主席团或负责该部门的部长可以处理申诉`，
  并在 `settleAppeal` 的判定条件里**再判一次 `isReviewer`**（双重保险）。
- **实测**（临时把 `dev_student_1` 降为 `life/member` 普通部员后验证，随后已还原）：
  - 提交人（普通部员）+ `settleAppeal` → **403** `只有主席团或负责该部门的部长可以处理申诉`；
  - 同一个人**不带** `settleAppeal` 的正常修改 → 照常允许（没有误伤）；
  - 临时记录已删除，身份已还原为 `presidium/president`（`roleText=校学生会 · 主席团 · 主席`）。

#### 验收
- 桩测试 `tmp/verify-review-scope.js` **28 项**；`tools/check-server-contract.js` 增加 **9 项**常驻断言
  （校级跨院校 / 分院限本院 / 负责与不负责的部长 / 部员 / 教师 / 结案守卫），契约自检 **181 项 0 失败**。
- 全套 14 个桩测试 + 8 个静态检查通过（仅 `check-miniprogram` 主包体积为既有基线）。

### 追加（2026-10-20 第十二轮）：新增「学生会总管」权限（union.steward）

用户要求：**「增加学生会总管权限，这样具备该权力可以管理学生会。」**

#### 设计：一个权限覆盖学生会全部事务，且**不要求本人是成员**
- 权限目录新增 `union.steward`（module=学生会，sort 排在 view/manage 之后）。
- **蕴含**：`union.steward` 自动带出 `union.view` + `union.manage`
  （`Permission.PERM_IMPLIES`，在 `user.js::getEffectivePermissions` 这个**唯一出口**展开）。
  这样三条链路自动一致，不需要各处补判：
  ① 管理端 `/api/admin/union/*`（挂 `union.view` / `union.manage`）——总管天然可用；
  ② `/api/auth/me` 的 `effectivePermissions`——前端导航直接命中；
  ③ `nav-groups` 的入口显隐（按 `perm` 匹配）——非成员的总管也能在管理中枢/首页看到「学生会」分类。
  只在某一处判就会出现「入口看得见但接口 403」，所以集中在一处展开。
- **用户端成员管理**（`/api/union/manage/*`，原本按**身份**：主席团/部长）新增总管放行：
  `assertMemberManager` 先判身份、身份不够再看 `union.steward`；总管范围＝**全校**
  （`memberManageAllowed` 直接 true），`canTransfer`（跨部门转移）也放开。
  这是为了团委老师/学生处干事——他们通常不在成员名单里，却要维护名单。
  判定顺序刻意「身份先、权限后」：主席团/部长不额外查权限（省一次组展开）。

#### 实测（另起 3011 测试实例，不动用户 3010；临时给 dev_teacher_1 授予 steward，测完已还原）
| 验证点 | 结果 |
|---|---|
| 权限播种 | ✅ `permissions` 里有 `union.steward`（sort 72） |
| `/api/auth/me` 展开 | ✅ `effectivePermissions` 自动含 `union.view` + `union.manage` |
| 管理端成员列表（非成员） | ✅ 200 |
| 用户端成员管理（非成员） | ✅ 200，`scopeText=学生会总管（全校）`、`canTransfer=true`、`isSteward=true` |
| 管理端写接口（`POST members` 空 body） | ✅ 权限通过、卡在参数校验（400 而非 403） |
| 反例：成员但无管理权限 | ✅ 403「无权限（需要 union.view）」（不误放） |
| 反例：superadmin `*` | ✅ 照常 200（原行为不变） |
| `dev_teacher_1.permissions` | ✅ 已还原为 `[]` |

#### 顺带修掉一个测试脆弱性
`tmp/verify-banchao-league.js` 把「今日区间文案」写死成 `10月19日`——**跨天必然误报**（今天 10-20 就红了）。
改成按 `banchaoDate` 算期望值；同时把夹具 `banchaoResponse` 里也写死的 `periodLabel='10月19日'` 改成按 `from` 算，
否则夹具自相矛盾（`from` 是 20 号、文案却是 19 号），只会误导排查。

#### 验收
- 契约自检升到 **189 项 0 失败**（新增总管 8 项：目录 / 蕴含 / 只升不降 / 唯一出口展开 / 用户端放行 / 全校范围 / 拒绝文案）。
- `tools/check-nav-groups.js` 新增角色「学生会总管(非成员)」，验证非成员持 steward 时中枢与首页都显示「学生会」分类。
- 全套 14 个桩测试 + 9 个静态检查通过（仅 `check-miniprogram` 主包体积为既有基线）。

### 追加（2026-10-20 第十二轮）：用户管理页重设计（紧凑排版 + 班级状态/身份 + 批量操作）

用户要求三件事：**「重新设计UI紧凑排版」**、**「班级被设置为实习/毕业也要一并显示在其中，筛选中也要增加该内容，包括学生会、班委等」**、**「增加批量操作功能」**。

#### ① 紧凑排版：三行压成两行
旧行结构是「姓名+标签」/「学号+班级」/「宿舍+目标」**三行**（约 150rpx）。
现在把元信息合并成**一行** `metaText`（JS 里预计算好，WXML 不拼表达式），多数行降到约 105rpx，**一屏多看 2 行**。
同时删掉 `.user-row-sub/.user-row-goal/.user-row-dorm` 三条旧样式与 `goalText` 死字段。

> ⚠️ **第一版把信息压丢了**：我先按「学号 · 班级 · 宿舍 · 目标」带前缀合并，
> 用 Chromium 量测才发现两行的 `metaText` 被 `ellipsis` **截断**（宿舍/计划名直接看不见了）——
> 截断比换行更糟。改成：① 去掉「学号/宿舍」前缀（靠格式辨识：10 位数字=学号、含「级」=班级、含「楼」=宿舍）；
> ② 「默认目标」不再显示（全校大多数人都是它，对管理员无信息量）；
> ③ CSS 从 `text-overflow: ellipsis` 改为**允许换行**。
> 复测：截断全部消失，只有信息最密的那行从 105 涨到 136rpx（换行），信息不丢。
细节：未绑宿舍的学生**不显示**空槽位（否则一屏噪音）；教师行只显示「院系 · 院校」。

#### ② 班级状态 / 身份：行上标签 + 两个新筛选
- **列表行新增富化** `attachClassAndUnion()`：与 `attachDorms` 同一做法，**按本页一次批量查 + 内存 join**，
  绝不逐行查（N+1）。给每行补 `classStatus / classStatusText / isUnionMember / unionText / unionMore`。
- **标签策略**：只给**实习 / 毕业**打状态标签 —— 全校 54 个班里 45 个是正常，
  正常也打标签等于没打（一屏全是灰点，反而看不出谁特殊）。
  另加「班委」「班主任 N班」「学生会·部门·职务」（多条记录显示 `+N`）。
- **筛选新增两组**（与院校三级、年级、达标情况都是正交维度，可叠加）：
  - `classStatus`（正常/实习/毕业）：状态存在 `class_profiles` 上、users 只有 className，
    所以先按状态取班名再 `$in`。⚠️ `normal` 必须用 `$nin: ['intern','graduated']` ——
    **44 个老数据没有 status 字段**，用等值匹配会让它们在「正常」里凭空消失。
  - `identity`（班委/班主任/学生会成员）：学生会成员**必须 openid OR userId 双路**关联
    （成员记录未绑微信时 openid 是空串，实测存在这种数据，只按 openid 查会漏人）。
    空集合给一个不可能命中的值，**宁可返回 0 人也不退化成「不过滤」**。
- **计数口径统一**：`/filters` 下发 `classStatuses / identities` 的**人数**（不是班数），
  下拉显示「实习（395）」。实测六个筛选项的下拉计数与列表 total **逐个相等**。

#### ③ 批量操作
- **前端**：工具栏加「批量」开关（默认关闭 —— 常态是看人点详情，选择框常驻容易误触删除）。
  开启后：行左出勾选框、点行=勾选、**左滑禁用**（`t-swipe-cell` 的 `disabled`，防边选边误删）、
  底部浮出动作条（7 个动作横滑，不折行以免永久遮住列表最后一行）。
  「全选」只作用于**当前已加载的本页**，并在文案里写明「已选 N / 本页 M」——
  筛出 2600 人时不能让人误以为选中了整个库。动作成功后**清空选择**（防下一批误带上一次的人）。
- **服务端** `POST /api/admin/users/batch`：
  - **每个动作沿用单条接口的权限**（`officer/ban/unban`→`user.manage`，`transfer/reset-password/delete`→`permission.manage`），
    不给批量另设万能权限 —— 批量只是把 N 次单条合成一次，能力边界必须与单条**完全一致**，
    否则会出现「没有 permission.manage 的人能用批量删号」这种越权升级。
  - 单次上限 500（批量删号级联 8 张表，放开会占满请求线程，也超出人工核对能力）。
  - **逐条串行 + 单条失败不中断整批**，如实回报 `done / failed / missing`。
    半成功只弹一句「已完成」是批量最容易出的问题。
  - 抽出 `deleteUserCascade()` / `resetUserPassword()` 两个共用函数，**单条与批量同一份实现**
    （否则会出现「单条会恢复 initialHashes、批量不会」这类分裂）。断言「删除级联只有一份实现」。
  - `transfer` 会按「年级 + 专业」**重算班级名**（只转专业不改班名，会造出「23级机电班挂在大数据专业下」的脏数据）。
- **学生会批量加入/移出：按用户选择**不做**（需要部门+职务+学年，批量会丢信息；已有专门的「学生会成员」页）。

#### 踩到并修掉的两个静默失效
1. **`checkbox` 图标不存在** —— TDesign 图标名写错**不报错**，只渲染成空白，批量开关会变成一个没字的空按钮。
   改用 `check-circle`，并加断言「本页所有图标名必须在图标表里存在」。
2. **`bind:tap="{{batchMode ? 'onCheckOne' : 'onRowTap'}}"`** —— WXML 的事件绑定值**不做数据绑定**，
   动态事件名在真机上静默失效（表现就是「点行没反应」）。改成固定 `onRowTap`，由 JS 内部按模式派发。

#### 验收
- **接真后端实测**：
  - 富化：行上带 `classStatus/classStatusText/isUnionMember/unionText`；
  - 筛选：`intern=395 / normal=2286 / graduated=0`，`officer=2 / homeroom=2 / union=2`，
    **下拉计数与列表 total 逐项相等**；组合筛选（实习+班委+日目标）在 find 与 aggregate 两条分支都正确；
    非法值 `identity=hack` / `classStatus=xxx` → 400；
  - 批量：设/撤班委 3 人成功并还原；混合批次如实回报「成功 1 / 失败 1（教师不能设班委）/ 未找到 1」；
    批量删 2 个一次性账号 → 级联删净、按名搜 total=0；批量删超管 → 记为失败且账号仍在；
    无 `permission.manage` 的账号调批量删除 → 403；超 500 → 400。
  - 测试数据全部还原（班委回到 2、用户总数回到 2687、测试账号已删）。
- 新增 `tools/check-admin-users-page.js`（**42 项**，常驻）：驱动真实 `users.js` 断言紧凑排版、
  标签策略、筛选联动与计数、批量选择/全选口径、动作分发、左滑禁用、图标存在性。
- 契约自检升到 **205 项 0 失败**（新增用户管理 16 项）。
- 全套 14 个桩测试 + 11 个静态检查通过（仅 `check-miniprogram` 主包体积为既有基线）。

### 追加（2026-10-20 第十三轮）：标签折行修复（用户截图）

用户截图：`测试学生` 那一行里 **「实习」和「学生会·主席团 · 主席」被拆成两行**，
橙色那块孤零零占满第二行 —— 比没有标签还难看。

#### 根因
`.users-name` 是 `display:flex; flex-wrap:wrap`，长标签放不下就整块换行。
⚠️ **这个信号我上一轮量测时其实看到了**（`wrapped=2`），却把它当成「居中导致的 top 差异」放过了 ——
教训：量测出的异常值要么排除、要么修，不能凭猜测忽略。

#### 修法：单行 + 文案压缩 + 超预算折叠成 +N
1. **容器不折行**：`flex-wrap: nowrap` + `overflow: hidden`，姓名改 `flex: 0 1 auto; min-width: 0`
   （可收缩，保留 ellipsis 兜底）；标签加 `flex-shrink: 0`
   —— nowrap 下不禁止收缩的话标签会被**压扁变形**而不是被折叠掉。
2. **文案压缩**：`学生会·主席团 · 主席`（11 字）→ `学生会·主席`
   （主席团的部门名没有信息量，职务已说明身份；普通部门保留部门名，` · ` 压成 `·`）；
   `班主任 2班` → `班主任2班`。
3. **按宽度预算折叠**：`layoutChips()` 用**估算宽度**（中文≈字号、数字/字母≈0.55 倍）
   从前往后累加，超预算的标签丢弃并折成一个 `+N`。
   为什么不量 DOM：小程序列表逐行 `createSelectorQuery` 会拖慢首屏。
   预算 `470rpx` < 实际可用 `532rpx`（750 − 页边距×2 − 卡片内边距×2 − 头像 − 箭头 − gap），
   留 62rpx 余量 —— 估算偏保守只会多折一个标签，远好于折行。
   优先级：班级状态 > 班委/班主任 > 学生会。
4. **一行不能出现两个 `+N`**：union 自带的 `+N` 是「还有 N 个部门」，
   折叠的 `+N` 是「还有 N 个标签」，并排没人分得清 → **折叠时把各标签自带的 `+N` 合并计数**
   （信息不丢，完整明细在详情页看）。类名用 `.users-chip-fold`，
   不复用 `.users-chip-more`（后者是 union 标签内的部门计数，含义不同）。

#### 验收
- **量测复验**（Chromium 逐行量容器高）：12 行全部 `nameRowH == tallestChild == 37px`
  → **单行、零折行、零溢出**。
  （上一版用「子元素 top 是否相同」判断换行是错的：`align-items:center` 下
  姓名 28px 与标签 19px 高度不同，top 本来就不一样，会把居中误判成换行 —— 已改成量高度。）
- `tools/check-admin-users-page.js` 从 42 项扩到 **56 项**：新增「姓名行不折行」「标签禁止收缩」
  「折叠类名不撞名」「长姓名+多标签发生折叠」「折叠数字=被藏标签数」「不出现两个 +N」
  「未折叠时 union 保留自己的 +N」等，全部走**真实代码路径**（夹具行进 `load()`），
  不为了测试导出内部函数。
- 顺带修掉测试自身的脆弱性：全选计数原先写死 4，加一行夹具就误报 —— 改成跟随 `list.length`。
- 全套 14 个桩测试 + 11 个静态检查通过（仅 `check-miniprogram` 主包体积为既有基线）。

### 追加（2026-10-20 第十四轮）：标签混用两套体系 + 「班主任4班」歧义

用户截图（两个教师账号）问：**「有瑕疵 而且为什么 会有班主任4班啊」**

#### 先回答「班主任4班」
**不是 bug，是真实数据**：`测试管理员`（dev_admin_1）的 `homeroomClasses` 确实有 4 个班
（`56级冒烟1班 / 24数字媒体技术 / 24现代物流管理 / 24电子商务`，四个班名在台账里都存在）。
班主任本来就允许带多个班（`user.homeroomClasses` 是数组，上限 20）。
但**写成「班主任4班」会被读成「4 班」这个班名** —— 用户正是因此发问。已改成 **`班主任·4个班`**。

#### 瑕疵①：一行里混了两套标签体系（错位感的来源）
`管理员 / 教师 / 限制登录` 用 `t-tag`（TDesign 自带字号、内距、圆角、高度），
`班级状态 / 班委 / 班主任 / 学生会` 用自绘的 `.users-chip`（19rpx / `2rpx 10rpx`）——
两者**高度不同**，并排就是截图里「教师」比「班主任」大一圈的错落感。
而且 `t-tag` **不参与 `layoutChips` 的宽度预算**，折叠算不准。
→ 全部统一成 `.users-chip`，并给基类固定 `height: 34rpx`；`scopeLabels` 随之成为死代码已清理。

#### 瑕疵②：「班主任」和「实习」看起来同色
根因很隐蔽：本仓库把 **TDesign 的 primary 整套换成了品牌橙**
（`--td-primary-color-7 = #ff6b00 = --tt-brand`、`--td-primary-color-1 = #fff4ec = --tt-brand-soft`），
所以我给班委/班主任写的"蓝色"`info` 实际渲染成**橙色**，与「实习」（`--tt-brand-deep` + `--tt-brand-soft`）
底色**完全相同**，三类标签糊在一起。
→ 改用**语义色板**（明暗两套主题里都存在，不依赖 fallback）：
实习 = `--td-warning-*` 琥珀；班委/班主任 = `--td-success-*` 绿；限制 = `--td-error-*` 红；
教师/毕业 = 中性灰；管理员 = 品牌橙实心；学生会 = 品牌橙渐变。

#### 验收（量测而不是目测）
- **Chromium 逐行量**：16 行 `chipHeights` 全部只有一个值（34px）→ **错落行数 0/16**；
  `nameRowH == tallestChild == 37px` → 仍全部单行、零溢出。
- 计算色核对：`实习` bg=rgb(255,248,230)/fg=rgb(176,110,0)，`班委` bg=rgb(233,249,240)/fg=rgb(14,110,51)
  → 琥珀与绿**确实分开**（此前两者都是 #fff4ec 底）。
- `tools/check-admin-users-page.js` 从 56 项扩到 **64 项**：新增「姓名行内不再有 t-tag」
  「管理员/教师/限制也走 chips」「scopeLabels 死代码已清理」「info 不再用 primary」
  「班委与实习用不同色板」「标签共用同一高度基线」「班主任·N个班 不会被误读成班名」。
- 全套 14 个桩测试 + 11 个静态检查通过（仅 `check-miniprogram` 主包体积为既有基线）。

### 追加（2026-10-20 第十五轮）：固定 height 把标签文字裁没了（我上一轮引入的回归）

用户截图：标签全变成**纯色块、文字消失**，问 **「卧槽 为什么空白啊」**。

#### 根因：是我上一轮自己引入的回归
上一轮为了「所有标签等高」，我给 `.users-chip` 加了 `height: 34rpx`。
但 `.users-chip` 挂在 `<text>` 上，而 `<text>` 在 flex 容器里会被 **blockify**，
此时**固定 height 会把文字整块裁掉**（只剩纯色块）。
⚠️ **我的 Chromium 预览里渲染正常**（量测还显示 34px 等高、零溢出），所以预览完全没抓到——
这个 bug **只在真机出现**。教训：预览能渲染 ≠ 真机能渲染，尤其涉及 `<text>` 盒模型时。

#### 修法：去掉固定 height，等高改由盒模型自然得到
```css
.users-chip {
  padding: 4rpx 10rpx;   /* 同内距 */
  font-size: 19rpx;      /* 同字号 */
  line-height: 1.4;      /* 同 line-height → 自然等高 ≈ 30.6rpx，不依赖 height */
}
```
折叠标记的 `border` 也换成 `box-shadow: inset`（border 会给盒子加 4rpx、破坏等高）。
（中途我曾想加 `display: inline-block` 兜底，但它在 flex 容器里同样被 blockify、是无效声明，
已回退——不写没验证过的声明。）

#### 验收
- 复跑量测：16 行标签高度**全部单值 35px**、错落 0、折行 0、溢出 0 —— 去掉 height 后仍等高。
- `check-admin-users-page.js` 从 64 项扩到 **66 项**，新增三条**防回归断言**（把这次的坑钉死）：
  ① 标签基线**不得**设固定 height（正则 `(^|[^-])\bheight:` 刻意排除 `line-height` 的误匹配）；
  ② 等高靠 line-height + padding；
  ③ 折叠标记不靠 border 撑高。
- 全套 14 桩测试 + 11 静态检查通过。

#### ⚠️ 待用户真机确认
我这边无法复现真机空白（预览一直是好的），修复是**回退我引入的 height 回归**——
这是最可能的根因，但**必须由用户重新编译后在真机确认**文字是否恢复显示。

### 追加（2026-10-20 第十六轮）：标签又折到第二行——`<text>` 盒模型第三次坑（用户截图「又这样了」）

用户截图：标签（管理员 / 班主任·4个班）**掉到了姓名下方第二行**。追问确认现象是「挤到第二行」。

#### 复盘：这不是新问题，是被上一轮「空白」盖住了
第十五轮我把 `.users-name` 改成 `display:flex + flex-wrap:nowrap` 想强制单行——
**但它在真机从来没生效过**。第十四轮标签变成纯色块（height 裁字）时，"换行"这个更早的问题被
"空白"盖住了；第十五轮我修好空白、文字重现，换行就再次暴露。
根因是同一个：`<text>` 是 inline 元素，作为 flex 子项 / inline-block 时，
**各基础库对 `nowrap` 的遵守不一致**——真机会在标签内部断行，Chromium 预览当它是原子盒就不折。
这是本组件**第三次**栽在「`<text>` 盒模型设备差异」上（第一次 height 裁字、第二次 nowrap 不生效）。

#### 修法：标签元素从 `<text>` 换成 `<view>`
`<view>` 默认块级，`display:inline-block` 后是**保证原子、绝不内部折行**的行内盒——
这是小程序里最久经考验的单行标签写法，不赌 `<text>` 的行为。
容器再配 `white-space:nowrap`（纯文本规则，不经 flex 引擎）兜住「标签整体不挪到下一行」。
姓名仍是 `<text>`（它要 ellipsis 截断，inline 语义正确）。
标签内不留换行缩进（`<text>`/`<view>` 里的空白会渲染成前导空格让文字偏右），
兄弟间距用 `.users-chip` 的 `margin-left`（容器不再是 flex，没有 gap）。

#### 验收
- 量测（Chromium，用「只有姓名、无标签」的行作单行基准高 40px）：**真折行 0/16、标签等高 35px、零溢出**。
  （修正了判据：之前用 `容器高 > 子元素高 + 2` 会把 `vertical-align` 基线多出的 3px 误判成折行。）
- `check-admin-users-page.js` 从 66 项扩到 **70 项**，新增锁死这次的不变量：
  「标签元素必须是 `<view>`（`<text>` 真机会内部折行）」「容器用 `white-space:nowrap` 且不再是 flex」
  「标签是 `inline-block` + `vertical-align`」「标签内不留换行缩进」。
- 全套 14 桩测试 + 11 静态检查通过（仅 `check-miniprogram` 主包体积为既有基线）。

#### ⚠️ 仍需真机确认（我连续三轮在这块判断失误）
Chromium 预览**复现不出**这个 bug，所以我的量测只能证明「新写法在预览里不折」，
不能证明真机。`<view>` + `inline-block` + 容器 `nowrap` 是三者里最普适、最不依赖设备实现的组合，
我有较高把握，但**请务必重新编译后在真机确认**。若仍折行，下一步就不再用 CSS 赌，
而是**把标签直接拼进姓名字符串**（`测试管理员 · 管理员 · 班主任·4个班`，纯文本单行，绝无折行可能）。

#### 教训（写进本文件开头级别的规则）
小程序里凡是「一行内多个彩色标签」的排版，**标签元素一律用 `<view>`，不要用 `<text>`**；
`<text>` 的 padding / height / nowrap / 内部断行在真机与预览间不一致，已连踩三次。

### 追加（2026-10-20 第十七轮）：内置权限组改为可编辑（教师管理组）

用户在「权限组管理」页提出：**「我可以调整教师管理组的权限内容。」**

#### 与旧规则的冲突（AGENTS.md 已同步修订）
旧规则：内置组（`builtIn: true`）**只读**，每次启动 `seedPermissions()` 按默认值重新播种，改了也会被覆盖。
所以**只放开编辑是不够的**——管理员改完当下生效、下次重启被静默抹掉，属于「假生效」，比不能改更糟。
必须同时改播种逻辑。

#### 实现（三处联动，缺一不可）
- `models/permission-group.js`：新增 **`customized`** 字段（管理员改过内置组 → true）。
- `services/rbac.js::seedPermissions()`：播种前先 `findOne({key})`，
  **`customized` 为真就跳过覆盖**（`superadmin` 永远走播种，见下）。
- `routes/admin/permission-groups.js::PUT`：不再按 `builtIn` 拒绝；
  但 **`superadmin` 恒只读**（唯一持 `'*'`，改坏等于把自己锁在门外）；
  保存内置组时写 `customized = true`；DELETE 仍拒绝内置组（删了会让引用账号静默失去整组权限）。
- 前端 `groups.wxml/js`：编辑按钮只锁 `superadmin`；改过的组显示**「已自定义」**橙色标签
  （否则管理员会误以为它还是系统默认）；删除按钮对内置组继续隐藏；底部说明同步改写。

#### 验收（真后端，含重启验证）
| 验证点 | 结果 |
|---|---|
| PUT superadmin | ✅ 400「超级管理员组固定为全部权限，不可修改」 |
| PUT teacher（内置） | ✅ 保存成功，`customized=true`、权限 7→8 |
| **重启后改动是否存活** | ✅ perms=8、含新加的 `union.steward`，**播种让位** |
| 重启后 superadmin | ✅ 仍是 `*`，未被误伤 |
| DELETE 内置组 | ✅ 400「内置权限组不可删除」 |
| 教师账号有效权限 | ✅ 实时展开 `union.steward → union.view + union.manage` |

测试改动**已还原**（teacher 回到 7 项、`customized=false`、描述回原值，与测前快照逐字段一致）——
用户选择「先只做可编辑，具体权限我自己调」。
契约自检升到 **215 项 0 失败**（新增内置组可编辑 10 项，其中「播种跳过 customized」是防假生效的关键断言）。

### 追加（2026-10-20 第十八轮）：账户编辑页教师不该出现学号 / 年级

用户截图（账户编辑页，已切到「教师账户」）圈出「性别 / 出生日期 / 学号 / 年级」四行，问：
**「这为什么会有啊 教师账号不行嘛。」**

#### 根因
`account-edit.wxml` 里只有下面的「学籍信息（院校/系部/专业/班级）」用 `wx:if="{{role === 'student'}}"` 包起来，
而**性别 / 出生日期 / 学号 / 年级都在上面共享的「基本信息」区**，没有按 role 守卫 → 切到教师全露出来。
其中**学号、年级是学生专属**（教师没有学号，且 `studentId` 是唯一稀疏索引，给教师落值会污染数据）；
**性别、出生日期是通用人属性**（后端 `POST /account` 对教师也接受），保留。

#### 修法（两处，缺一不可）
- **WXML**：学号行 + 年级行（连同它们**前面的分隔线**）整段包进 `<block wx:if="{{role === 'student'}}">`。
  分隔线必须一起包进去，否则教师表单末尾会多一条没有下家的悬空分隔线。
- **JS 提交守卫**：`base.studentId` 改为 `d.role === 'student' ? d.studentId.trim() : ''`。
  只隐藏 UI 不够——用户可能「先按学生填了学号、再切到教师」，隐藏的 `data.studentId` 残值仍会被提交，
  落到教师身上污染唯一索引。后端对空 `studentId` 是「不改」（`if (sid)` 才落值），所以教师传空安全。
  `pickRole` 刻意**不清空** `studentId`：留着让「教师切回学生」能恢复之前填的学号。

#### 验收
- `tools/check-admin-users-page.js` 新增 [8] 节 **5 项**（从 70 → 75 项）：
  学号/年级行必须在 `role===student` block 内、性别/出生日期**不被误伤**（仍在 block 外、教师可见）、
  提交时 `studentId` 按 role 收敛。断言用「行内容 + block 定位」而非裸关键词，避免被注释误命中。
- `<block>` 开/闭标签配对校验 3/3 平衡。
- 全套 14 桩测试 + 11 静态检查通过（仅 `check-miniprogram` 主包体积为既有基线）。

### 追加（2026-10-20 第十九轮）：用户详情页教师不该出现「学生会」区块

用户截图（测试管理员 = 教师账号的详情页）问：**「教师账号怎么有学生会呢」**——
页面显示「学生会 / 成员身份：未加入学生会」。

#### 根因（与上一轮同源）
`user-detail.wxml` 的学生会区块守卫是 `!classOnly || union.isMember`（只管"班级视角"），
**没管教师**。而后端三处硬性禁止教师加入学生会
（`routes/admin/union.js`：「教师账号不能加入学生会」×3）——
所以这个区块对教师**永远只会渲染「未加入学生会」**：纯噪音，还暗示"教师也能进学生会、只是没加"。

#### 修法（两处，同一原则）
- **学生会区块**：条件改为 `!isTeacherUser && (!classOnly || union.isMember)`。
  页面已有 `isTeacherUser`（运动/宿舍区块同款守卫），沿用既有模式，不引入新概念。
- **顺带同源修复**：「基本信息」里的**学号 / 班级 / 专业**三行对教师也永远是「—」占位
  （教师没有这三项），一并加 `wx:if="{{!isTeacherUser}}"`；
  **院校 / 院系 / 注册时间保留**——创建教师账号时可填院系院校，人人都有注册时间。
  这与上一轮账户编辑页「教师隐藏学号/年级」是同一口径。

#### 验收
- `check-admin-users-page.js` 新增 [9] 节 **6 项**（75 → 81 项）：学生会区块按 `isTeacherUser` 守卫、
  学号/班级/专业三行对教师隐藏、**院校与注册时间不被误伤**（防"顺手全藏"的过度修复）。
- `<block>` 配对 26/26；`check-page-data-keys` 72 页全过。
- 全套 14 桩测试 + 11 静态检查通过（仅 `check-miniprogram` 主包体积为既有基线）。

### 追加（2026-10-20 第二十轮）：教师不该有「发放徽章」

用户接着上一轮截图问：**「而且也没有发放徽章嘛」**——教师详情页快捷操作里有「发放徽章」。

#### 查证：这是个死功能，不是"能用但没显示"
- `models/badge.js` 的 type enum 共 9 种（`total_steps` / `total_distance` / `total_days` / `goal_days` /
  `single_steps` / `single_distance` / `streak_days` / `points` / `rank`），**全部由运动数据推导**，
  没有任何「荣誉 / 手工」类型。
- 教师按 AGENTS.md「教师账号规则」三层拦截、**不产生任何 `run_records`** → 教师永远不可能合法达成任何徽章。
- 但 `routes/admin/user-badges.js` 旧注释却写「教师账号也允许发放…由管理员决定」——**这条口径是错的**，
  而且发出去的徽章**谁都看不见**：详情页徽章列表在「运动」Tab 内（教师已按 `!isTeacherUser` 隐藏），
  教师端「我的徽章」入口也被 `!isTeacher` 隐藏。等于把记录扔进黑洞。
- 实测库里教师持有徽章 **0 条**（2 个教师账号），无历史数据包袱，可安全收紧。

#### 修法（前端隐藏 + 服务端拦截，AGENTS.md 要求不能只靠前端）
- `user-detail.wxml`：按钮条件 `canManageBadges` → `canManageBadges && !isTeacherUser`；
  抽屉底部提示改为「徽章全部由运动数据达成，教师账号不参与运动，故不能发放」。
- `routes/admin/user-badges.js`：**POST 拦教师**（400「教师账号不参与运动，无法发放徽章」），
  并改写那段错误的旧注释说明理由。
- ⚠️ **GET 与 DELETE 刻意不拦**：万一有历史脏数据，管理员必须还能看见并回收（撤销是幂等删除）。
  这条边界写进断言，防止下一个人"顺手全关"。

#### 验收（真后端端到端 + 常驻断言）
用服务自身密钥签短期 admin token 打真实接口（测试后已删）：

| 请求 | 结果 |
|---|---|
| 教师 `GET /:id/badges` | ✅ 200（抽屉数据源仍开放） |
| 教师 `POST /:id/badges` | ✅ 400「教师账号不参与运动，无法发放徽章」 |
| 学生 `POST`（不存在的 key） | ✅ 404「徽章不存在」——证明守卫**没有误伤学生** |

- `check-admin-users-page.js` 新增 [10] 节 **6 项**（81 → 87）：按钮对教师隐藏、服务端 POST 拦教师、
  文案含原因、**GET/DELETE 不拦**（防过度修复）、旧误导文案已清除。
- 全套 14 桩测试 + 11 静态检查通过（仅 `check-miniprogram` 主包体积为既有基线）。

### 追加（2026-10-20 第二十一轮）：学生与教师账号重名导致串号

用户报：**「出现问题 当学生与教师账号重名。」** 追问确认现象是**「登录进去发现是学生的身份（串号）」**，
并要求「将陈宇航这个学生取消绑定微信」。

#### 实测数据（只读排查，全程未擅自改数据）
- `陈宇航`：学生（学号 2024090438、24软件技术、**已绑微信**）+ 教师（无学号、未绑定）
- 全库同名账号组 **41 个**，其中学生×教师跨角色同名 1 组；29 组是「一个已绑 + 一个未绑」
- 姓名唯一性只按「姓名 + 类型」（`routes/admin/users.js:268`），所以**重名是设计允许共存的**
  ——现实中同名师生大量存在，不能改成全局唯一。
- （更正我自己的一个中间结论：脚本报的「6 组同密码哈希」是误判——那是多个账号 `passwordHash`
  为空串被当成相同，实际含义是「从没改过密码」，不是真冲突。）

#### 串号的真正路径（不在 /bind，而在 /login）
`auth-login.js` 里 `auth.login()` 是**按微信 openid** 定身份的：这个微信一旦已绑定某账号就直接返回该身份，
页面上输入的姓名/密码**根本不会被使用** —— 旧实现直接 `afterLogin`，于是
「微信绑的是学生陈宇航、输入教师陈宇航的密码」会**静默进学生身份**，用户完全无从察觉。

排查中还发现 `/bind` 三处缺陷：
1. **失败计数连坐**：密码错时给**所有同名候选** +1 → 学生输错 5 次把同名教师一起锁掉。
2. **`matched[0]` 盲选**：多个同名都能匹配密码时静默取第一个 → 可能登进别人的身份。
3. **锁定判断在密码匹配之前**：先对全部候选查 `lockUntil` 就 429 → 学生被锁会让同名教师也登录不了。

#### 修法（后端消歧 + 前端串号防线）
- `routes/auth.js::/bind`：接收可选 `studentId` 收窄候选；歧义时返回 **400902** 要求补学号，
  绝不盲选；失败计数**只在能确定针对哪个账号时**进行；锁定判断移到密码匹配**之后**
  （按「未锁候选」匹配，匹配不上且有被锁候选才报 429）。
  代价：同名且未给学号时不计数（无法确定该惩罚谁），但攻击者要真登进去仍必须猜中学号。
- `auth-login.js`：`login()` 返回已绑定身份时，**比对输入姓名**，不符则弹「该微信已绑定其他账号」确认框，
  绝不静默顶替；点「返回」时 `auth.clearAuth()` 回滚登录态
  （`login()` 内部已 `setAuth` 存了 token，不回滚会停在登录页却处于登录态）。
- 收到 400902 时展开学号输入框（`needStudentId`）；教师账号无学号，留空重试即可。
- `request.js::bindAccount` 增加第三个参数 `studentId`。

#### 已执行的数据操作（用户明确授权）
解绑「学生陈宇航」的微信：走真实 `POST /api/admin/users/:id/unbind-wechat`（复用级联逻辑），
结果 openid 已清除、wx_sessions 残留 0、教师账号未受影响。
（`login_devices` 残留 10 条属该用户多设备历史，接口按 userId 撤销，与该 openid 无关。）

#### 验收
- 新增桩测试 `tmp/verify-dupname-login.js`（**19 项**）：密码可区分精确登录、歧义不连坐计数、
  补学号后只锁本人、**学生被锁时教师仍能登录**（旧实现会连累）、同名同密码绝不盲选、单人走原路径。
- 真后端非破坏性验证（错误密码 + 临时游客 token，测后已删）：400902 生效、两账号计数均未被改动。
- `check-server-contract.js` 新增 **8 项**（215 → 223）锁死上述不变量。
- 全套 15 桩测试 + 11 静态检查通过（仅 `check-miniprogram` 主包体积为既有基线）。

#### ⚠️ 遗留
- 登录页串号防线是**新增交互**，需真机确认弹窗文案与「返回」回滚行为。
- 存量 41 组同名账号未做任何处理（本次只修登录消歧）；如需批量核查可另开一轮。

### 追加（2026-10-21 第二十二轮）：院校 → 系部 → 专业 全面级联

用户截图（账户编辑页学籍信息：北校区 / 计财系 / 商务数据分析与应用）提出：
**「我希望所有涉及到院校、系部、专业的筛选与选择都是联动的不是独立，如选择了教师院才有教师系。」**

#### 盘点（先实测再下结论，不靠读注释）
逐个页面用真实数据驱动验证，结论：

| 页面 | 级联状况 | 处理 |
|---|---|---|
| `users/account-edit` | ❌ **半联动**（本次主修对象） | 重写 `buildOptions` |
| `class-manage` | ❌ **两处真实缺陷** | 修 `rawDepts` / `rawSpecs` |
| `users`（用户管理筛选） | ✅ 已联动（`resolveFilterOptions`） | 仅补测试覆盖 |
| `user-detail` 班主任抽屉 | ✅ 已联动（系部按院校过滤） | 不动 |
| `packageUnion/{stats,roster,entry}` | ✅ 已联动 | 不动 |
| `pages/org/bind` | ✅ 已联动 | 不动 |

> 教训：我一开始只读 class-manage 的文件头注释就判定"已联动"，**实测才发现两处 bug**。
> 注释会撒谎，行为不会 —— 与前面「预览正常≠真机正常」是同一类错误。

#### 缺陷 ①：account-edit 的"半联动"
旧代码把**全库存量平铺数组**并进子级选项：
```js
optDepartment = 该院校下的系部 ∪ d.usedDepartments   // 后半截是全库的！
```
于是选了「教师院」仍能看到北校区的「计财系」。改为严格收窄，并区分**两种"空"**：
- `null` = 完全不知道上级（没选 / 上级不在树里，如纯导入建号）→ 退全量，保证有得选；
- `[]` = 命中了上级但确认它下面什么都没有 → **保持为空**，绝不退全量。

为什么空数组必须保持空（真实数据验证）：`洋河校区` 在库里配了院校没配系部，
若退回全量，管理员会选出「洋河校区 + 计财系」这种**跨院校脏数据**。
选项为空时 wxml 的 `wx:else` 自动降级成手填输入框，是出路不是死路。

级联源改用 `/filters` 的 `tree`（服务端 `buildFilterTree` 已把组织架构与存量数据合并），
退回 `/api/org/tree`。顺带删掉 `prefillOrg`（`buildOptions` 已按值重算 index，两处逻辑会打架）。

#### 缺陷 ②：class-manage（真实数据实测发现）
1. **选「全部院校」时系部下拉完全为空**：`schoolTree.get('')` 未命中 → 返回 `[]`。
   直接违反它自己文件头注释「任一级选全部→下一级恢复全量」，且与专业级行为不一致。
2. **选「洋河校区」时泄漏 21 个北校区专业**：`return seen.size ? [...] : flat.specialties`
   —— 命中院校但该校无专业时退回全量，正是我刚在 account-edit 修掉的同类泄漏。

#### 一个不是 bug 的差异（记下来防止被"修错"）
`/users/filters` 与 `/class/profiles` 的 tree **口径故意不同**：
`class-profile.js::buildFacetTree` 只认 `organizations.parentId`、**不按名字猜父级**
（服务端注释：为「稳定、可解释」，避免共现关系随分组顺序变化让树变形）。
所以台账里有、组织架构没配 parentId 的「机电系」只出现在平铺 `facets.departments`、不进树。
→ 班级管理页选「北校区」看不到机电系那个班，是**设计如此**，去组织架构补父级即自动归位。

#### 数据在实时变动（排查中遇到）
第一次测 `洋河校区` 是 0 系部，几分钟后变 1 系部 —— 查 `organizations.updatedAt` 确认
`冶金材料系→洋河校区` 创建于 `2026-10-21T00:39:18Z`（北京 08:39），**有人正在编辑组织架构**。
→ 所有断言改为**从 tree 动态推导**，不写死院校/系部名（本仓库已多次因写死数据假失败）。

#### 验收
- 新增常驻桩测试 `tmp/verify-org-cascade.js`（**24 项 / 10 节**）：account-edit 严格收窄、
  两种"空"的区分、切换清空下级、手填保留、无 tree 退化，**外加 class-manage 9 项**。
- `check-admin-users-page.js` 新增 [8b]（9 项）+ [11]（5 项）→ 102 项；契约自检 223 项 0 失败。
- 真实数据端到端（临时脚本，测后已删）：教师院→只剩教师系；北校区+计财系→只剩计财系 10 个专业；
  洋河校区→专业为空且给出 `specHint` 说明；未选院校→全量。
- 全套 16 桩测试 + 11 静态检查通过（仅 `check-miniprogram` 主包体积为既有基线）。

#### ⚠️ 待用户真机确认
级联是**选项列表**行为，Chromium 无法验证小程序 picker；且组织架构正在被实时编辑，
请以最新配置为准在真机复核「选教师院是否只出教师系」。

### 追加（2026-10-21 第二十三轮）：移除账户编辑页的「手动输入」

用户截图（洋河校区/冶金材料系的专业 picker，末位「✎ 手动输入」被红框圈出）：
**「这个手动输入是什么鬼 组织架构只能有有权限的更改」**

#### 为什么这是真问题（不只是难看）
组织架构的增删改挂在 `content.manage`（`routes/admin/content.js`），
而账户编辑页只要有账户编辑权限就能**凭空敲一个系部/专业名保存** ——
这是一个**绕过权限模型的后门**，与 AGENTS.md「权限以服务端校验为准、组织架构是权威源」直接冲突。

#### 但直接删会丢数据（先量化再动手）
实测存量：`院校` 0 人、`专业` 0 人不在组织架构里，**只有 `机电系` 2 人**从没配进组织架构。
若直接删手填、又不管这个值，打开这些账号时 picker 会回落到第 0 项 ——
**显示的是一个他没选的系部，保存还会把真值改掉**（正是用户最反感的静默丢数据）。

#### 修法：移除后门，但保留存量值可见
- 删除 `MANUAL` 哨兵、`withManual`、`manual.*` 状态、`pickFrom`/`isManual`/`usePicker`
  以及三个手填 `<input>`（连带 `input(e)` 成为死代码，一并删）。
- 新增 **`ensureValue(list, current)`**：账号当前值不在选项里时补进**首位**，
  于是「看得见、改得了、不会误显示成别的」，但**只能看见这一个已存在的值，造不出新名字**。
  三级都套（`optSchool` / `optDepartment` / `optSpecialty`）。
- 某级在组织架构里确实没配 → 显示橙色可点击提示「…请到「组织架构」页添加 ›」，
  `goOrganizations` 跳 `/packageAdmin/content/organizations`（路径已与 app.json 分包核对一致）；
  无 `content.manage` 的人点了会被该页自己拦。
- 判断「有没有可选项」用**来源数量**而不是 `optXxx.length`：后者可能只含 ensureValue 补的那一个值，
  此时 picker 只有一项、点了没意义，仍应提示去配置页，而不是假装"有的选"。
- 底部说明改为「院校 / 系部 / 专业来自「组织架构」，需相应权限才能维护」。

#### 验收
- 真实数据端到端（临时脚本，测后已删）：打开 `冒烟新生343410 / 北校区 / 机电系`，
  值未被清空、出现在选项里、`departmentIndex >= 0`（picker 停在真值上）、选项里无手填哨兵。
  （排查中 `机电系` 已被补进组织架构 —— 组织架构仍在被实时编辑，但 ensureValue 这层保险必要且已验证。）
- `check-admin-users-page.js` 新增 [8c] **8 项**（102 → 110）：JS 无 MANUAL/manual 状态、
  WXML 无手填输入框与「手动输入」选项、提示指向组织架构页路由、三级都套 ensureValue。
- `verify-org-cascade.js` 的 [6]/[8]/[8b] 断言从"走手填"改为"补进选项保留"（24 项全过）。
- 全套 16 桩测试 + 11 静态检查通过（仅 `check-miniprogram` 主包体积为既有基线）。

### 追加（2026-10-21 第二十四轮）：筛选选中后必须回填到触发器标题

用户截图（用户管理筛选面板，年级已选「2025级」、选项上有勾，但触发器仍显示「年级」）：
**「用户管理中筛选选择后应该显示一下」**

#### 根因（TDesign 组件的一个反直觉行为）
`dropdown-menu.js::getAllItems()` 渲染的是 **`label || computedLabel`**：
组件自己会按 `value` 从 options 里算出 `computedLabel`（选中项的 label），
但我们一直传**静态** `label="年级"` —— 非空就把 `computedLabel` **永久盖住**了。
所以选完只有选项上的勾能看出状态，收起面板后触发器仍是维度名。

（组件有 observer `"label, computedLabel, disabled" → $parent.getAllItems()`，
所以把 label 改成动态值即可驱动菜单条重渲染 —— 这是本方案成立的前提，已核对源码确认。）

#### 修法
- `users.js` 新增 **`computeFilterLabels()`**：未选 = 维度名，已选 = 选中项 label，
  结果存 `filterLabels`；`updateFilterState()` 里一并算（与摘要三件套同一出口）。
- `users.wxml` 8 个 `t-dropdown-item` 的 `label` 全部改成 `{{filterLabels.xxx}}`。
- **去掉「（人数）」尾巴**：选项 label 是「冶金材料系（535）」，触发器每列仅约 190rpx，
  与 `class-manage` 的 `short` 同口径 `replace(/（[^（）]*）$/, '')`。
  长值靠组件自带 `.t-dropdown-menu__title{overflow:hidden;text-overflow:ellipsis}` 收尾，**不用自己写 CSS**。
- 维度名让位给值（不写「年级 2025级」）：一行三列放不下；完整「维度+值」由面板底部
  `filterSummary` 摘要条与工具栏角标兜住。

#### 过程中我自己引入并被测试抓出的两个 bug
1. **`clearFilters` 漏重算**：它手写 `hasActiveFilter/filterCount/filterSummary` 却没算 `filterLabels`
   → 清除筛选后触发器仍显示旧值。改为**复用 `updateFilterState()`**，
   不在两处算同一份状态（必然漂移）。
2. **`grade` 漏配映射**：选项数组是复数键（`grades`），我最初的三元表达式只处理了院校三层
   → 年级回填成原始值 `2024` 而不是 `2024级`。改为显式 **`FILTER_OPTION_KEYS`** 映射表，
   并加断言「映射必须覆盖全部维度 + 目标键真实存在」防将来新增维度再漏。

（另：一度写了 `.users-dd-label` 省略号与「已选橙色」两条 CSS，核对组件源码后发现
省略号组件已自带、而 `__item--active` 是「当前展开」不是「已选值」，**两条都是错的，已删**，
并在 wxss 留下注释说明为什么不需要。）

#### 验收
- `check-admin-users-page.js` 新增 [12] **12 项**（110 → **122**），端到端驱动真实 `users.js`：
  初始显示维度名、选年级→「2024级」、班级状态→「实习」（无人数尾巴）、未选项不受影响、
  8 个 label 全动态、无静态中文 label 残留、**清除后回到维度名且摘要同步归零**、
  `value='0'`（未达标）不被判空、映射表覆盖全部维度。
- 全仓库只有 `users.wxml` 用 `t-dropdown-item`，无其他页面中招。
- 全套 16 桩测试 + 11 静态检查通过（仅 `check-miniprogram` 主包体积为既有基线）。

### 追加（2026-10-21 第二十五轮）：批量转移改成级联 + 一键转院校

用户截图（批量栏点「转移」弹出「请输入新的院校」文本框）：
**「在转移中应该是多级而不是点击后出现一个弹窗进行输入才对，增加一键转移院校，只变院校，
因为两个校区的系部名称、专业名称一致，这样只需要转移院校就能一键转过去。」**

#### 查证：旧实现比"难看"严重得多
- 前端 `wx.showModal({editable:true})` 让管理员**手打**院校/系部/专业名；
- 服务端 `transfer` 分支**零校验**：`user.schoolName = String(school).trim()` 任何字符串直接落库
  → 打错一个字就把学生变成一个不存在的院校，筛选与班超分组全部对不上；
  且这等于给「组织架构只能由 content.manage 权限的人维护」开了后门（与第二十三轮同源）。
- **一个更隐蔽的数据隐患**（实测发现）：`users.schoolId` / `departmentId` 有 **1535 人**填过，
  而旧转移**只改 `*Name` 不改 `*Id`** → 转完院校后 id 仍指向**旧校区**的组织节点，
  按 id 归组的口径（学生会分会范围、班级台账）会把该生算回原校区，**名字对、id 错更难排查**。

#### 真实组织数据（决定「一键转院校」是否成立）
- 两校区系部名**完全一致**（都有 冶金材料系、机电建工系、计财系），
  但它们是**不同的 organization 节点**（同名不同 `_id`）；
- 计财系下的专业**不一致**：北校区 10 个、洋河校区 5 个
  → 所以「只转院校」对系部安全，对专业**不保证**（必须报出来）。

#### 实现
**服务端**（`routes/admin/users.js`）
- 新增 `buildOrgIndex()`：按 `parentId` 建 school→department→specialty 索引
  （与 `class-profile.js::buildFacetTree` 同口径，**只认 parentId、不按名字猜父级**）。
- `assertTransferSchool()` 循环外一次性校验新院校（打错字整批拒绝，
  而不是让 500 人各失败一次掩盖真因）；`resolveTransferTarget()` 逐人解析，
  系部/专业按**该生转移后所属院校**判定 → 一批混两个校区也能各自正确处理。
- **同步回填 `schoolId` / `departmentId`**；只转院校时按最终系部名在新校区重新解析 id；
  新校区没有同名系部 → 置 `null` 并写 `transferNote`，**随结果回报**（不静默吞掉副作用）。
- 年级不属于组织架构，单独校验 4 位年份。

**前端**（`users.js` / `users.wxml` / `users.wxss`）
- 删掉 `promptBatchTransfer`（自由文本弹窗），改为级联抽屉：每级首项「不修改」= 不提交该字段，
  选项只来自 `filterTree`；换院校自动清空系部/专业。
- 批量栏拆成两个入口：**「一键转院校」**（`data-mode="school"`，只选院校）与**「转移」**（四级全可选）。
- 年级显示用 `gradeLabel`（`2025级`）而非裸 value（`2025`）—— 与上一轮筛选触发器同一类错误。
- 抽屉高度沿用 `groups.wxss` 实测结论（`flex:none + min-height:0 + max-height:46vh`）；
  行内 label 用页面私有类（不能用 `.tt-sheet-label`，那是带橙条的分组标题）。

#### 顺手修掉一个我自己引入的风险
删掉 `transfer` 分发后，它会落到 `onBatchAction` 末尾的**默认分支**
`return this.runBatch({action, ids, body:{}})` —— 带着空 body 打到服务端变成「假成功」。
改为未知 action 一律提示不支持、**绝不发请求**。

#### 验收
- 端到端（建临时账号跑完整链路后删除，实测 **0 残留**、学生总数与校区分布未变）16 项全过：
  不存在院校→整批 400 且数据未动；**一键转院校后 `departmentId` 正确重解析到洋河的计财系**
  （`6ad80d93…` ≠ 北校区 `6acc54e7…`）；跨校区专业错配→该生失败且原因点名所属校区、未写坏；
  乱写系部名→拒绝；年级格式；教师仍不可转移。
- `check-admin-users-page.js` 新增 [13] **18 项**（122 → **140**）：级联收窄、换院校清空下级、
  只提交非「不修改」项、全「不修改」不发请求、年级用 label 回填、已无 editable、未知 action 不发请求。
- `check-server-contract.js` 新增 **12 项**（223 → **235**）：不再无条件落库、走组织解析、
  整批先校验院校、**同步回填两个 id**、按所属院校判定、清空时回报 transferNote、年级格式。
- 全套 16 桩测试 + 11 静态检查通过（仅 `check-miniprogram` 主包体积为既有基线）。

#### ⚠️ 遗留
- 「一键转院校」对**专业**不保证：北校区计财系 10 个专业、洋河只有 5 个，
  转过去后专业可能在新校区不存在。当前行为是**保留原专业名**（不猜、不静默改），
  建议后续在结果里对这类学生给出提示，或由学校在组织架构补齐专业后再转。

### 追加（2026-10-21 第二十六轮）：筛选选项的人数改为实时计算

用户截图（系部下拉里「机电建工系（364）/ 计财系（1424）」，但已选了年级 2025）：
**「括号中的人数要根据筛选实时计算才对」**

#### 根因
数字来自 `buildFilterTree()`，那是**整库全量**聚合（不带任何筛选条件），
所以无论选了什么年级/状态/关键词，系部人数都不变 → 点进去对不上。
`nodeOption` 还直接取了 tree 的 `label`（自带「计财系（1424）」），
等于把静态数字焊死在选项里。

#### 设计：计数随列表返回，不另开接口
```
GET /api/admin/users?...&withFacets=1  →  { list, total, facets: {school:{},department:{},...} }
```
放在同一个响应里的理由：列表每次筛选变化本来就要重新请求，
**同一次请求天然保证「数字」与「列表结果」同时刻、同口径**；
单开 `/facets` 要前端多打一次请求，还得处理两次请求之间数据已变、响应交错覆盖的问题。

口径（标准分面做法）：**维度 D 的计数 = 「除 D 以外所有已选条件」命中的人按 D 分组**。
排除自身是必须的 —— 否则选了「计财系」后其它系部全变 0，管理员没法切走。

#### 三个关键实现点
1. **条件构造抽成 `buildUserMatch(q, omit)`**，列表与六个维度计数**共用**。
   两处各写一份必然漂移 → 又变成「写着 1424、点进去 364」，正是本轮要修的病。
2. **年级与身份复用同一表达式**：`gradeCondition()`（列表与计数同源）、
   `identityCondition()`（含学生会 openid/userId 双路与 ObjectId 转换那个坑）。
   年级刻意**不做**「按有效年级 $group」——列表是三选一 $or，一人可能同时命中多源，
   分组只能挑一个，必然与列表 total 对不上；改为逐候选值 `countDocuments`（值只有个位数）。
3. **只在 `withFacets=1` 时算**：前端只在**筛选变化**（第一页）带这个参数，
   `onReachBottom` 翻页不带 → 不重复算六组聚合。
   前端判 `res.facets !== undefined` 而非 `'facets' in res`：
   服务端没算时该键经 JSON 序列化会被丢掉，用 `in` 会把「翻页没要」误判成「刻意不计数」，
   导致**翻页时把已有数字清空**。

#### 选了日/周目标时整体不返回计数（facets: null）
那两个条件要走 `run_records` 聚合（全库最贵的一张表），而计数要按 6 个维度各跑一遍；
另写一份简化管道又必然与列表漂移 —— 等于把本轮的 bug 换个地方复现。
**宁可退回「没有数字」（前端不渲染括号），也不给一个对不上或贵到拖慢筛选的数字。**

#### 过程中我自己绕的弯路（记下来）
一度把达标聚合管道复制成 `achievementPipeline()` helper 给计数用 ——
那正是我自己在注释里警告的"两处各写一份必然漂移"，及时删掉，改为上面的 null 方案。

#### 验收
- 真实服务端到端（临时脚本，测后已删）13 项全过，核心是**计数与列表 total 严格相等**：
  无筛选系部合计 719+1424+534；选年级 2020 → 列表 total=2 且系部计数合计=2；
  选系部后其它系部仍有数字；年级/班级状态/身份的列表 total 与刚才的计数一一对上；
  翻页无 facets；达标筛选下 facets=null。
- `check-admin-users-page.js` [3] 节扩到 **11 项**（140 → **148**）：
  **把桩里 `/filters` 的人数改成 999/777、列表 facets 改成 395/2**，
  两个来源给不同数字才能证明界面用的是实时那份（否则断言恒真）；
  另加「翻页不带 withFacets」「翻页不清空已有数字」「facets=null 不渲染括号」
  「选项带人数、**触发器标题剥掉人数尾巴**」（六个维度现在都带数，不剥会撑破 190rpx）。
- `check-server-contract.js` 新增 **10 项**（235 → **245**）：条件构造共用、列表内不再自带一份、
  两条返回分支都带 facets、withFacets 才计算、六维度各排除自身、年级/身份复用同一表达式、达标下不计数。
- 全套 16 桩测试 + 11 静态检查通过（仅 `check-miniprogram` 主包体积为既有基线）。

### 追加（2026-10-21 第二十七轮）：学生会部门去内置 + 职责模块可自助配置

用户截图（学生会配置页，红框圈住生活部/学习部/纪检部三个「内置」部门，职责显示 `hygiene` 等英文 key）：
**「去掉这个 学生会配置中我可以自己设定职责模块」**，追问澄清为
**「是全校部门的这几个内置，应该不需要内置，我自行配置职责模块即可。」**

#### 查证：真正卡住他的是播种，不是「内置」标签
先读代码 + 查真实数据（0 成员、2 条记录都是主席团 → 无悬空风险），发现三处叠加：
1. `union-department.js` 三个部门 `builtIn: true` → 界面挂「内置」、删除接口直接拒；
2. `seedUnionDepartments()` 每次启动 `$set` 回写 `builtIn/scope/name/dutyModules` → 改了重启就没；
3. ⚠️ **最关键**：`check-modules.js:570` 每次启动把 `entryDeptKeys`（**真正鉴权字段**）
   强制重置成代码里的 `['life']/['study']/['discipline']`
   → 他在配置页改的部门绑定**下次重启静默失效**。
   旁证：`POST /modules/:key/reset`（恢复内置默认）本来就刻意不动 `entryDeptKeys`
   —— 说明这字段的归属一直是「学校配置」，播种重置它是不一致的。

另外 `dutyModules` 是**第二份手写绑定**：改了模块的录入部门它不会跟着变，
界面于是显示一个与实际鉴权矛盾的"职责"，还直接甩 `hygiene` 这种内部 key 给管理员。

#### 主席团为什么必须保留内置
`presidium` 被 **20 处**代码当语义常量用于复核权限判定（`services/union.js::PRESIDIUM_KEY`、
`union-member.js:79` 的 `deptKey === 'presidium'`）。去掉内置=允许改名删除，复核权限会静默失效。
用户红框圈的恰好是那三个检查部门，不含主席团，按此理解执行。

#### 实现（五处联动）
- **模型**：三个检查部门 `builtIn: false`；`dutyModules` 标 `@deprecated`（真源是 `entryDeptKeys`）。
- **播种 `seedUnionDepartments()`**：只有主席团回写默认值；其余**只在缺失时创建**，存在即不动；
  并对存量做**一次性归位**（`builtIn: true → false`）—— 不清的话标签和删除拦截都还在，等于没改。
  删掉的部门不会被"复活"（那是用户明确意图）。
- **播种 `seedCheckModules()`**：`entryDeptKeys` 改为**只在缺失/为空时补默认**，不再强制回写。
- **GET /departments**：职责按 `entryDeptKeys` **反推**，返回中文模块名 `dutyNames`；
  并给 `noEntryByDesign`（主席团按设计不参与录入，不该显示成「未配置」）。
- **PUT /departments**：主席团名称/范围明确拒绝（旧实现是"改了当下生效、重启被覆盖"的假生效）；
  不再接收 `dutyModules` 写入（避免又存一份没人用的绑定）。
- **DELETE /departments**：主席团不可删；**被模块 `entryDeptKeys` 引用的部门先要求改配置**
  —— 否则留下悬空 key，而鉴权是 fail-closed，表现是「那模块突然谁都录不了」且看不出原因。
- **前端**：`dutyText` 用中文模块名；区分「不参与录入（只读 + 复核）」与「未配置」（后者标警告色）。

#### ⚠️ 我自己犯的错（记下来）
端到端验证脚本的**还原步骤**用 `bulkWrite` + `replacement`，因文档含 `undefined` 字段被 Mongo 拒绝
（`Document must be a valid JavaScript object`）—— 17 项断言全过、退出码非 0，
但**真实库被留在改动状态**（`生活部X` / `scope=school` / `hygiene.entry=[study]`）。
已用 `$set` 显式写回并二次核对。教训：**测真实库的脚本，还原必须用 `$set` 指定字段**
（`replacement` 会整文档替换，遇到 undefined/额外字段就失败）；且要在 finally 里核对还原结果，
不能假设它一定成功。

#### 验收
- 真实数据端到端 17 项全过（测后已还原并二次核对）：
  三部门 `builtIn=false`；主席团改名/删除仍被拒；改 `entryDeptKeys` 后
  **手动跑一遍真实播种函数**（等价重启）→ 配置仍在、部门名仍在、`builtIn` 未被改回 true；
  被模块引用的部门删除被拒并点名模块；`dutyNames` 返回「卫生检查」而非 `hygiene`。
- `check-server-contract.js` 新增 **16 项**（245 → **261**）：仅主席团内置、播种只回写主席团、
  不再回写 dutyModules、存量归位、**entryDeptKeys 不强制回写**、按真源反推、
  不再读废弃字段、删除前查模块引用、前端用中文名。
- 全套 16 桩测试 + 11 静态检查通过（仅 `check-miniprogram` 主包体积为既有基线）。

### 追加（2026-10-21 第二十八轮）：部门按校区独立（互不干扰）

用户截图（检查模块「允许录入的部门」四个平铺 chips + 删除部门被拦）：
**「这里出现问题，检查模块中我们需要多级的去设置 而不是独立的名称，
因为很有可能在北校区有生活部，而洋河校区叫卫生部」**，
澄清为 **「现在所有部门都是一个、只是在不同校区显示，我需要你修复这个，互不干扰」**。

#### 根因：数据模型表达不了「按校区各有部门」
`union_departments` 只有 `key`（全局唯一）+ `scope`（school/branch/both），
而 **`scope='branch'` 的语义是「挂到所有校区根下」** —— 所以北校区的「生活部」
必然同时出现在洋河校区，无法表达「北校区生活部 + 洋河卫生部」。
配置页的部门树也只是**按 scope 复制**同一份定义到每个校区根下（`belongsTo` 只看 scope），
看起来像「每个校区都有这些部门」，实际是同一批数据。

#### 修法：给部门加 `schoolId`（归属校区）
- **模型**：新增 `schoolId`。语义三态：有值 = 只属于该校区（scope 固定 `branch`）；
  空 + `school` = 只全校；空 + `both` = 全局（只留给主席团，因为分会主席团是真实概念）。
- **POST/PUT /departments**：接收并校验 `schoolId`（必须是组织架构的 `school` 层节点），
  挂到校区时**强制 `scope='branch'`**，避免「schoolId=洋河 但 scope=school」的自相矛盾。
  有在任成员时**禁止改归属校区**（成员的 `deptKey` 只存 key，改归属会让"他在哪个校区"静默改变）。
- **服务端归属闸门 `assertDeptFitsCampus()`**（权威，前端过滤只是体验）：
  主席团豁免；有 `schoolId` → 只能给同校区分会成员用（校级成员也不许）；
  无 `schoolId` → 按 scope 兜底旧数据。
  接在**三个写入口**：新建成员、批量加人、修改成员。
  ⚠️ 修改成员时校验必须放在**校区与部门都改完之后** —— 先校验部门再改校区，
  看到的还是旧校区，会把「洋河成员调进生活部 + 同时改成北校区」这种组合放过去。
- **删除部门**：主席团不可删；被模块 `entryDeptKeys` 引用的先要求改配置
  （否则留悬空 key，鉴权 fail-closed → 那个模块突然谁都录不了，且看不出原因）。
- **前端**：抽出共享判定 `utils/union-dept.js::deptFitsCampus`，**配置页与成员页共用**
  （两页各写必然漂移：配置页只显示本校区部门、成员页却能把人分到别校区的部门）。
  成员页换校区时重算可选部门（源用 `_deptAll` 原始全量，否则反复换校区选项越换越少）；
  部门表单加「归属校区」选择器；模块的录入部门改成**按校区分组**的 chips。

#### ⚠️ 过程中踩的坑
- 我一度把 `assertDept` 只返回 `{key,name}`，导致校验函数拿不到 `schoolId` 无法判归属 ——
  改为返回完整关键字段。
- 端到端脚本连续两轮「临时部门没删净」：`[F]` 故意验证「被模块引用时不许删」，
  留下的部门在清理阶段没先解绑模块。**不是产品 bug，是脚本清理顺序**；
  修正为先解绑再删 + 加兜底 `deleteMany`。
- `fetch failed` 再次出现：Node 的 fetch 把 `localhost` 解析成 IPv6，服务只监听 IPv4；
  脚本一律用 `127.0.0.1`。

#### 验收
- 真实数据端到端 **15 项全过**（测后数据已还原、二次核对：0 临时部门 / 0 成员 / 模块绑定回 `["life"]`）：
  两校区各建部门并绑到正确校区、`scope` 自动收敛 `branch`、
  列表返回 `schoolId`+校区名、模块只绑北校区部门、
  **洋河成员挂北校区部门被拒**、本校区可加、校级成员不能用分会部门、
  有成员时改归属被拒、被模块引用时删除被拒。
- `check-server-contract.js` 新增 **20 项**（261 → **281**）。
- 全套 16 桩测试 + 11 静态检查通过。

### 追加（2026-10-21 第二十九轮）：检查模块的录入部门"点不动" —— WXML 不能调方法

用户截图（晚自习考勤抽屉，四个部门 chips **全灰**、没有一个是选中态）：
**「我依旧无法改变部门啊，这个部门是需要可编辑的」**

#### 根因：WXML 表达式不支持方法调用
选中态写的是：
```html
class="uc-chip {{moduleForm.entryDeptKeys.indexOf(item.key) >= 0 ? 'active' : ''}}"
```
**小程序 WXML 模板里不能调用方法**（只有 WXS 可以），`indexOf(...)` 求值静默失败
→ 恒为 falsy → **四个 chips 永远渲染成未选中**。

于是：点一下其实已经改动了 `entryDeptKeys`、保存也会正确提交（实测 `["study"] → ["life"]`），
但**界面上一点变化都没有** —— 用户只会得出「点不动、改不了」的结论。

佐证（这次先查了权威写法再动手）：**TDesign 官方组件的 WXML 里 0 处使用 `indexOf`**，
数组判断全部走 WXS（`_.includes` / `_.cls`）。这条限制是真的，不是我的猜测。

#### 修法：选中态在 JS 里预计算，WXML 只读布尔值
- 新增 `refreshModuleGroups(entryKeys)`：给每个 chip 算好 `active: true/false`。
- `editModule()`（打开抽屉）与 `toggleModuleDept()`（点击后）都调它。
- WXML 改成 `class="uc-chip {{item.active ? 'active' : ''}}"`。

#### 验收
- 驱动真实 `config.js`：打开晚自习考勤 → 只有「学习部」`active=true`；
  点「生活部」→ `entryDeptKeys` 变 `["study","life"]`**且两个都 `active=true`**（选中态同步）。
- 真实服务端：PUT `entryDeptKeys:["life"]` → 落库、接口返回 `["life"]`、**还原回 `["study"]`** 已核对，
  测试后数据与测前一致。
- `check-server-contract.js` 新增 **10 项**（281 → **291**），其中三条是这次的核心：
  「WXML 不再调用 indexOf 判断选中」「WXML 用预计算的 item.active」「TDesign 官方 WXML 也不用 indexOf」。
  （断言里**必须剥掉 WXML 注释**再判：注释引用了这个错误写法作反面教材，直接 includes 会误报
   —— 与 `check-nav-groups.js` 踩过的坑相同。）
- 全套 16 桩测试 + 11 静态检查通过。

### 追加（2026-10-21 第三十轮）：录入部门改 Cascader 级联 + 去掉「适用范围」

用户截图两处：① 添加部门抽屉里「适用范围」（两级都有/仅校级/仅分院）与「归属校区」语义重叠；
② 晚自习考勤的部门选择器只剩「全校 / 通用 → 主席团」一个灰 chip。
**「这选项是啥，并且在图2中应该支持院校学生会部门的选择，请你优化一下，可以使用 Cascader 级联选择器」**
追问确认：「适用范围」**彻底去掉**，只留「归属校区」。

#### 问题 ①：「适用范围」与「归属校区」是同一件事的两套说法
上一轮加了 `schoolId`（归属校区）表达「只属于某校区」，但旧的 `scope`（校级/分院/通用）
仍以三连 tab 摆着 —— 两个控件能表达互相矛盾的组合（如 schoolId=洋河 + 仅校级）。
按用户要求**删除适用范围 tabs**，把三种归属折进「归属」一个下拉：
校学生会（仅校级） / 所有院校（各院校通用） / 具体校区。
选择器一次决定 `schoolId` + `scope`，不再有两个可以打架的控件。

#### 问题 ②：录入部门改成 Cascader 级联（校区 → 部门）
TDesign 的 `t-cascader` 本地已存在但**未注册**（`packageAdmin/union/config/config.json` 里加）。

**关键取舍**：cascader 的 `value` 是**单条路径数组**，而录入部门是**多选**。
所以设计成：cascader 只负责「挑哪一个部门」，选中后 toggle 进 `entryDeptKeys`；
已选集合用 chips 展示（显示部门名、带校区前缀区分，点一下移除）—— 既级联可找，又保留多选。

层级为什么是「校区 → 部门」而不是平铺：两校区可以各有「生活部」，
只列名字根本分不清勾的是哪个校区的；全局部门（校学生会专属 / 各院校通用）放在第一级
「全校 / 通用」下，否则会在每个校区节点里重复出现、看起来像有多个。

点分组节点本身不算选择（只展开），已实测不会误改选择。

#### 验收
- 驱动真实 `config.js`：cascader 数据正确生成「全校/通用、北校区、洋河校区」三组；
  选「北校区→生活部」与「洋河校区→卫生部」可**同时**选中（多选保留）；
  已选 chips 显示「北校区 · 生活部」「洋河校区 · 卫生部」而不是 `life`/`health` 这种 key；
  点分组本身选择不变。
- `check-server-contract.js` 更新/新增到 **298 项 0 失败**：
  「WXML 接入 Cascader 触发入口」「页面注册 t-cascader」「数据是校区→部门两级」
  「选中后 toggle 进 entryDeptKeys 保留多选」「点分组不改选择」「适用范围 tabs 已移除」
  「归属下拉三项表达完整归属」。
- 全套 16 桩测试 + 11 静态检查通过。

### 追加（2026-10-21 第三十一轮）：归属只留两类 + 修复「无法选择院校」

用户截图两处：① 归属下拉里仍有「所有院校（各院校通用）」；
② Cascader 里只有「全校 / 通用 → 主席团」，**院校节点点不进去**。
**「应该只有校学生会和院校(选择)学生会才对啊，如图二所示我无法选择院校」**

#### 问题 ①：「所有院校（各院校通用）」就是那个中间态
它是旧 `scope='both'` 的产物，语义是「每个校区下都出现」—— 正是用户反复反馈的
「所有部门都是一个、只是在不同校区显示」。按用户要求**删除该项**，归属只剩两类：
- 校学生会（仅校级）→ `schoolId` 空 + `scope='school'`
- 具体校区 → `schoolId` 有值 + `scope='branch'`

于是每个部门必须明确归属：要么校级、要么某一个校区，不再存在"到处都在"的部门。

#### 问题 ②：校区节点为空时整组被藏掉（图二的真因）
`moduleDeptGroups()` 里写的是 `if (items.length) groups.push(...)` —— 校区下没有部门时
**整组不输出**。实测库里当时只有「主席团」（`schoolId` 为空），于是两个校区节点全部消失，
Cascader 只剩「全校 / 通用」一个节点 → 用户看到的就是「无法选择院校」。

修法：
- 校区组**始终输出**（`empty: items.length === 0` 标记），不再按有无部门决定是否出现。
- 空校区给**不可选占位项**「该校区还没有部门，请先在「部门」里添加」，
  组名标「（暂无部门）」；`onModuleDeptCascaderChange` 识别 `__empty__` 前缀并忽略，
  点占位项不会改动已选部门。

#### 验收
- 驱动真实 `config.js`：归属下拉 = 校学生会 + 北校区 + 洋河校区（无「各院校通用」）；
  Cascader 三个节点全部出现（两个校区各带「暂无部门」占位）；点占位项 `entryDeptKeys` 不变。
- `check-server-contract.js` → **302 项 0 失败**，新增：
  「空校区也输出分组（不能藏掉）」「空校区给不可选占位提示」「点分组/占位项都不改选择」
  「归属下拉收录校学生会与各校区」「不再提供「所有院校通用」中间态」。
- 全套 16 桩测试 + 11 静态检查通过。

#### 附带说明
实测库里目前**只剩主席团一个部门**（生活部/学习部/纪检部已不在）。所以修复后
你会看到两个校区都显示「暂无部门」—— 这是正常状态，去「部门」页分别给北校区/洋河校区
各建部门即可（归属选对应校区）。

### 追加（2026-10-21 第三十二轮）：主席团全局唯一 + 部门标识自动生成

用户截图两处：① 同一个「主席团」在「全校 / 北校区 / 洋河校区」下各渲染一遍，看起来像三个部门；
② 添加部门表单里还要手填「部门标识（小写字母，如 sports）」。
**「1.图1你这个主席团是一样的代码，需要你不一样，都是主席团可以是内置，其他部门不用设置。
2.图2部门标识自动生成。」**

#### 问题 ①：主席团被按 scope='both' 渲染了三遍
`deptFitsCampus` 旧逻辑对 `scope='both'` 的部门在「全校」和**每个校区**都返回 true。
主席团恰恰是 `scope='both'`，于是出现三份。

但主席团是**全局唯一的语义实体**：代码用 `deptKey === 'presidium'` 判定复核权限，
分会主席团也是同一条记录（`level='branch'` + `deptKey='presidium'`），不按校区分裂。
→ 在共享判定里加 `isPresidium(dept)` 短路：**只在「全校」层出现一次**；归属文案改「全校（全局唯一）」。
（判定放在 `utils/union-dept.js`，配置页与成员页自动同步，不会一处改一处漏。）

#### 问题 ②：部门标识改为自动生成
key 只是鉴权用的内部唯一键（`check_modules.entryDeptKeys` 存它），手填既麻烦又易撞。
- 服务端新增 `generateDeptKey()`：名称为英文开头 → 取其开头英文段（`SportsTeam → sportsteam`）；
  中文开头 → `dept` 前缀；**冲突自动加序号**（`dept`、`dept2`…）而不是报 409。
- 前端表单删掉标识输入框，只留名称 + 归属，附一行「标识会自动生成」说明。

⚠️ 我自己踩的坑：第一版用 `replace(/[^a-z0-9]/g,'')` 清非 ASCII 字符，
把「临时体育部A」清成 `"a"`、「体育部」清成空串 —— 会生成一堆 a/b/c 这种毫无意义的鉴权标识。
已改为**只取开头的连续英文段**，并加断言锁死（`Chinese name must not produce residual key`）。

顺带修正：新建部门不指定校区时默认 `scope='school'`（旧默认 `both` 会让部门在每个校区都出现）。

#### 验收
- 真实数据端到端 9 项全过（测后已删净）：只给名称能创建、自动生成 key、同名再建得 `dept`/`dept2`、
  英文名得 `sportsteam`、指定校区 `scope=branch`、不指定 `scope=school`、显式 key 仍兼容。
- 判定实测：主席团 @全校 `true`、@北校区/洋河均 `false`；挂北校区的生活部 @洋河 `false`。
- `check-server-contract.js` → **313 项 0 失败**，新增：主席团按 key 识别、只在全校层、
  自动生成标识、中文名不产生残余 key、冲突加序号不报错、兼容显式 key、
  前端不再有标识输入框、默认归属校级。
- 全套 16 桩测试 + 11 静态检查通过。

#### 更正上一轮的误判
上一轮我写「实测库里只剩主席团一个部门」是**错的**——测后查询显示
`presidium(主席团) life(生活部) study(学习部) discipline(纪检部) sports(体育部)` 都在。
那句结论来自一次未清干净的临时脚本输出，已在此更正。

### 追加（2026-10-21 第三十三轮）：主席团分级 + 总管可查看记录 + 多照片上传

用户三条反馈：
**「1.校区主席团只能管该校区的考勤，全校主席团能都管。需要做区分
2.学生会总管是可以查看检查记录的，现在显示无法查看。
3.所有检查拍照片中可以上传或拍摄多个照片。」**

#### 第1条：主席团分级（服务端原本就对，破坏点是前端选择器）
先写端到端脚本实测**服务端**语义，16 项全过：
分会主席团 `level=branch` → `departmentIds` = 本校区全部院系 → 本校区可录、外校区拒绝
（原因「只能录入本院系的检查」）；全校主席团 `level=school` → 两校区都能录/复核；
`scopeFilter` 分会只返回本校区院系、全校返回空条件（= 全部）。

**真正的 bug 在上一轮我自己的改动**：为了让主席团在部门树里只出现一次，
我把 `deptFitsCampus` 写成「主席团只在全校层可用」，结果**成员页选北校区时主席团从下拉里消失了**
—— 分会主席根本加不了（实测 `addDeptOptions` 只剩「生活部」）。
修法：给判定加 `opts.forDeptTree`
· 部门树（`forDeptTree: true`）→ 主席团只在「全校」根下出现一次（不重复渲染）
· 成员/模块选择器（不传）→ 两级都可用（它是**职务**，作用范围由成员记录上的 `level`/`schoolId` 决定）
实测：选北校区 + 主席 → 提交 body 为 `level: 'branch'` + `schoolId: 'org-n'` + `deptKey: 'presidium'` → 只管本校区。

#### 第2条：学生会总管看不到检查记录
`union.steward` 权限早就存在，但只在 `/api/union/manage/*` 里放行。
总管（团委老师/学生处干事）**既不在成员名单、也没有班级**，于是：
· `/records` 列表：非成员分支只按 `homeroomClasses`/`className` 过滤 → 两者都空 → `scope = null` → **403**；
· `/records/:id` 详情：`inScope` 要求 `isMember`，另三条（同班/班主任/检查人）也不匹配 → **403**。
新增 `isRecordSteward(req, identity)`（身份先、权限后，与 `assertMemberManager` 同序），
列表 → `scope = {}`（全校），详情 → 放行，并给复核权（`union.steward` 语义含「记录与复核」）。

#### 第3条：「只能传一张」
前端查了也实测了：`count: remain`（首屏 9）、逐张上传、可累加到 6 张、提交带 3 个 URL —— **前端没问题**。
真因在服务端 `/api/upload/check-photo` 的 `assertUnionMember`：**要求必须是学生会成员**。
总管上传第一张就 403，逐张上传的循环在第一步失败，表现就是「传不了/只能一张」。
修法：该中间件放行 `union.steward`，且 `req.unionIdentity = identity || null`
（**不给录入权**：scopeFilter/canEnterModule 仍按成员身份判定）；普通非成员仍 403。

#### 验收（全部真实数据，测后已还原核对）
- 主席团分级 16 项：分会限本校区（录入/可见/复核）、全校通吃。
- 总管查看：列表不再 403、能查到别人的记录、详情可看、带复核权；**普通非成员仍 403**。
- 总管上传：连续 3 张全部成功、3 个 URL 互不相同、落库 `files` 表 `category=check_photo`；普通教师 403。
- `check-server-contract.js` → **323 项 0 失败**。
- 全套 16 桩测试 + 11 静态检查通过。

#### ⚠️ 我自己踩的坑
测上传时查集合写成 `file_objects`，实际是 **`files`**（`models/file-object.js` 显式
`collection: 'files'`）→ 误报「没落库」，白查一轮。AGENTS.md 里「模型必须显式指定集合名」
的另一面：**测试脚本也得按那个名字查**。

### 追加（2026-10-21 第三十四轮）：院校→部门联动 + 全校只保留主席团

用户截图（添加成员抽屉，「院校=北校区 / 部门=请选择部门」被红框圈出）：
**「这里选择院校要联动部门，全校仅有主席团没有其他部门了」**

#### 联动其实一直在生效，错的是「哪些部门算全校的」
`onAddCampus` 早就会按校区重算 `addDeptOptions`（上上轮加的）。真正的问题是 `deptFitsCampus`
对 `scope='both'` 在校级层也返回 true —— 于是「全校」下拉里同时有主席团、生活部、学习部、纪检部。
用户要的是：**校学生会层只有主席团，其余部门都属于各校区分会**。

存量数据也印证：`life / study / discipline` 三条仍是 `scope='both'`（早期播种留下的语义）。

#### 修法：校级层只认主席团
`utils/union-dept.js::deptFitsCampus`（配置页 + 成员页共用的唯一判定）：
- 主席团 → 按 `forDeptTree` 决定（部门树只在全校、选择器两级都可用）
- 有 `schoolId` → 只属于那个校区，校级层一律不可用
- **未指定校区的非主席团部门 → 只在各校区可用，校级层一律不可用**

服务端 `assertDeptFitsCampus` 同步收紧：`level === 'school'` 时除主席团外一律拒绝
（「XXX 不是学生会主席团，请选择具体院校（校区）」），否则前端拦住了、绕过前端仍能写进去。

⚠️ 这里**没有**把 `life/study/discipline` 硬塞进某个校区：它们被检查模块引用
（`hygiene→life`、`study_evening→study`、`discipline→宿管/早操/早八`），归哪个校区是学校的组织决定，
不是我能替它选的。它们现在语义是「各校区分会共用」（成员数为 0，不存在存量错配）。

#### 验收（驱动真实 members.js + 真实数据形状）
| 选院校 | 可选部门 |
|---|---|
| 全校 | 主席团（**仅此一项**） |
| 北校区 | 主席团、生活部、学习部、**北校区 · 体育部** |
| 洋河校区 | 主席团、生活部、学习部（看不到北校区专属的体育部） |

- 切换校区后部门实时重算、已选索引重置为 0。
- `check-server-contract.js` → **324 项 0 失败**（新增「校级层不再列出非主席团部门」
  「无 schoolId 的非主席团部门不能作为校级部门」）。
- 全套 16 桩测试 + 11 静态检查通过。

### 追加（2026-10-21 第三十五轮）：分组改用组织层级命名，去掉「通用」

用户截图（Cascader「选择录入部门」第一级显示「全校 / 通用」，第二级「请选择」）：
**「为什么有全校通用 这里还是要分开，要不然操作困难，就分为校学生会和院校学生会 别写通用 要不然操作成本高」**

#### 问题：分组名「全校 / 通用」既不是真实称谓，又把部门笼统混在一起
上一轮的分组是「全校 / 通用」+ 每个校区，且第一组收的是**所有没有 schoolId 的部门**
（生活部/学习部/纪检部/主席团）—— 管理员得点开一个含糊的「通用」找部门。
而实际组织结构就是两级：**校学生会 / 各院校学生会**。

#### 修法
- 第一组固定叫 **「校学生会」**（只含主席团，呼应上一轮「全校仅有主席团」）。
- 其后每个院校一组，叫 **「<校区>学生会」**（北校区学生会 / 洋河校区学生会）。
- 院校组里的部门 = 该校区专属部门 + 未指定校区的共用部门（用 `deptFitsCampus` 判定，
  与成员页/服务端同一份，不另写一套）。
- **主席团只在校学生会组出现一次**：它在两级都"可用"，但 key 完全相同，
  重复列三遍会让人以为有三个主席团（用户已就部门树抱怨过同一件事）。
- 共用部门的标签**不带校区前缀**（显示「生活部」而不是「洋河校区学生会 · 生活部」）——
  那不是它的归属，硬挂等于**谎报**；只有真正指定了校区的才显示「北校区 · 体育部」。

#### 验收（驱动真实 config.js）
```
校学生会          → 主席团
北校区学生会      → 生活部、学习部、纪检部、体育部
洋河校区学生会    → 生活部、学习部、纪检部
```
- 第一级完全没有「通用」字样；主席团不再重复出现；已选 chips 显示「生活部」（不带前缀）。
- `check-server-contract.js` → **328 项 0 失败**，新增 4 条：
  分组叫「校学生会」而非含糊的「全校 / 通用」、院校层级叫「<校区>学生会」、
  主席团只在校学生会组出现、共用部门标签不带校区前缀。
- 全套 16 桩测试 + 11 静态检查通过。

### 追加（2026-10-21 第三十六轮）：部门胶囊显示成「e」+ 支持连续多选

用户截图（已选部门胶囊里只有一个「e ✕」）：
**「应该可以多选部门啊，并且你现在我选择了生活部 居然还显示e」**

#### 问题 ①：「生活部」被渲染成「e」
先查数据确认不是查询问题（`key=life → name=生活部` 正常，选中的就是 life）。
`e` 恰好是 `life` 的**音序尾字符**，说明标签被**压窄到只容一个字**。

根因在 CSS：`.uc-chip` 没有 `white-space: nowrap`，也没有 `flex: 0 0 auto`。
胶囊在 flex 容器里被压窄 → 文字逐字换行 → 被 `border-radius: 999rpx` 的圆角裁掉，
只剩最后一个字落在圆形区域内，看起来就是一个「e」。
（同 `users.wxss` 里那次「空白 chips」是同一类问题：**胶囊必须明确不折行、不被压缩**。）

修法：
```css
.uc-chip { white-space: nowrap; flex: 0 0 auto; max-width: 100%; box-sizing: border-box; }
```

#### 问题 ②：选一个部门就关弹层，多选要反复点开
TDesign 的 cascader 选中叶子后**自己把弹层收掉**，于是「选第二个」要重新点「+ 选择部门」，
多选变成 3 步一次。

修法：在 `visible-change` 里区分两种关闭
· 由「刚选了部门」触发（`moduleDeptJustPicked`）→ **立刻重新打开**，像多选面板一样连续勾；
· 由用户点右上角 ✕ 触发 → 真正关闭，并把 page 侧 `visible` 置 false。

⚠️ 后者必须做：`visible` 在这个组件里**不是受控属性**（`controlledProps` 只有 `value`），
组件点 ✕ 时只改自己的内部 data。若不把 page 侧置 false，下次打开是 `true → true`，
不触发 observer → **弹层再也打不开**。
（同理「重新打开」要先置 false 再置 true，否则同样不触发。）

#### 验收（驱动真实 config.js）
选生活部 → 弹层保持打开（可继续选）；再选学习部 → 两个都在；再点学习部 → 取消勾选；
点 ✕ → 真正关闭且**能再次打开**（不卡死）；已选标签显示「生活部」而不是 key 或「e」。

- `check-server-contract.js` → **333 项 0 失败**，新增 5 条：
  「选完部门后弹层保持打开」「区分选完自动关与点✕主动关」「✕ 后 visible 能复位」
  「部门胶囊禁止折行（否则圆角裁掉只剩一个字）」「部门胶囊不被 flex 压窄」。
- 全套 16 桩测试 + 11 静态检查通过。

### 追加（2026-10-21 第三十七轮）：胶囊仍显示单字符 —— 是「兜底成 key + CSS 裁剪」两个 bug 叠加

用户再次截图（两个胶囊里分别只有一个 `e` 和一个 `s`）：
**「我点击后依旧是e s 依然出现这个问题，请你修复，你应该显示洋河校区·纪检部 这样 北校区·纪检部这样」**

#### 我第一轮判断错了，第二轮才找对
上一轮我只当它是 CSS 问题（`white-space`），修了但**没解决**。
关键线索是：`e` 和 `s` 是 **ASCII 字符**，而「部」是中文，中文不可能被裁成 `e`。
`e` / `s` 恰好是 `life` / `study` 的**最后一个字母** —— 说明：
1. `labelOf` 没命中（`this._deptList` 在某些刷新时机为空）→ 兜底 `labelOf.get(k) || k` 输出了**裸 key** `life`/`study`；
2. 然后这个 4~5 字符的 key 又被胶囊圆角裁得只剩最后一个字母。

两个 bug 叠加，所以只修 CSS 表象不变。

#### 修法
- **名字来源不再只依赖 `this._deptList`**：合并 `_deptList` + `moduleDeptGroups` 两处数据
  （渲染 chips 用的就是后者，它一定存在），任何一侧有就能取到名字。
- **兜底值不再是裸 key**：改成 `已选部门（life）`——技术标识对管理员没意义，
  且短字符串更容易被裁成单字符。
- **胶囊布局显式化**：`display: inline-flex; flex-flow: row nowrap; gap: 8rpx; min-width: 120rpx`，
  名字与 ✕ 各自包在独立 `<text>` 里（`.uc-chip-t` / `.uc-chip-x`），
  文字不再被父级 flex 压成逐字换行、再被 `border-radius: 999rpx` 裁掉。

#### 标签格式按用户要求改为「校区 · 部门」
`洋河校区 · 纪检部`、`北校区 · 体育部`：
- 明确归属某校区的部门 → 用它自己的 `schoolName`；
- **共用部门**（未指定校区）→ 用它**所在分会的校区名**做前缀（这样两校区各选一次同名部门能区分）；
- 主席团 → 只显示名字（它不属于任何校区）。

#### 验收
实测输出：`life → 洋河校区 · 生活部`、`discipline → 洋河校区 · 纪检部`。
- `check-server-contract.js` → **335 项 0 失败**，新增/更新：
  「已选部门标签带校区前缀」「主席团标签不带校区」「**取不到名字时也不甩裸 key**」。
- 全套 16 桩测试 + 11 静态检查通过。

#### 教训
同一现象修两次没好，就该怀疑**自己的归因**而不是继续加 CSS。
`e`/`s` 是 ASCII 这一点本可以在第一轮就发现 —— 中文部门名不可能渲染成英文字母。

### 追加（2026-10-21 第三十八轮）：去掉 cascader 弹窗，改抽屉内多级勾选

用户第三次截图（一个正确的「洋河校区 · 纪检部」+ 一个错误的「已选部门（e）」）：
**「你自己系统添加的就是文本，我用弹窗选的就是e，你别叠加弹窗选择了，
你就在原本弹窗中使用多级显示 我勾选吧」**

#### 终于找到 `e` 的确切成因
读 TDesign cascader 源码的 `_trigger("change", {...})`：
```js
value: s[s.length - 1] ?? ""     // ← 最后一级的**单个值**，不是路径数组
```
而我的代码写的是 `const path = e.detail.value || []; const deptKey = path[path.length - 1]`。
`detail.value` 是字符串 `"life"` 时，`"life"[3]` === **`"e"`**。
—— 用户那句「系统添加的是文本、弹窗选的是 e」正是决定性线索：两条路径都写了，
只有走 cascader 那条产生了 `e`。

这也解释了为什么前两轮修 CSS 完全无效：**数据层就已经是单个字符了**。

#### 按用户要求：不再叠加弹窗
抽屉里本来就有一个「模块配置」弹层，再套 cascader 的 `t-popup` 就是两层弹窗。
改成**在抽屉内直接按层级分组勾选**：
```
校学生会             → 主席团
各院校共用（未指定校区） → 生活部
北校区学生会         → 体育部
洋河校区学生会       → 纪检部
```
- 点一下即勾选（显示 ✓）/取消；`entryDeptKeys` 语义不变，保存提交的仍是真实 key。
- 删除 `t-cascader` 注册、组件、`buildModuleCascader`、`onModuleDeptCascader*`、
  `moduleDeptLabels` 等约 120 行（含弹层显隐同步那套复杂度）。

#### 顺带修掉一个真实缺陷：共用部门被列了两遍
旧分组把「未指定校区的共用部门」在**每个校区组**里各列一次。而 `entryDeptKeys` 只存**一个** key
→ 勾了北校区的「生活部」，洋河组的「生活部」也变亮，用户会以为勾了两个部门。
现在共用部门单独成组（`__shared__`），只出现一次；校区组只列**明确归属该校区**的部门。

#### 验收
驱动真实 config.js：四个分组正确；多选（生活部 + 纪检部）正常；再点取消；
保存提交 `["life","sports"]`（真实 key，不是 `e`）；无任何单字符标签。
- `check-server-contract.js` → **327 项 0 失败**：删除 15 条已废弃的 cascader 断言，
  新增「抽屉内直接按层级列出部门」「不再使用 t-cascader」「共用部门单独成组、不在每个校区重复」
  「校区组只列明确归属该校区的部门」「胶囊用 inline-flex」等。
- 全套 16 桩测试 + 11 静态检查通过。

### 追加（2026-10-21 第三十九轮）：晚自习开关 / 楼名白名单 / 删掉系统配置入口

用户三条需求：
**「1.增设班级管理中的晚自习开关部分班级是没有晚自习的所以不涉及考勤。
2.为了防止教室、宿舍被学生不统一填写。请在系统设置中增加教学用楼的楼名列表与宿舍用楼的楼名列表，
这样学生先选择楼名自己再去填写门牌号(纯数字)这样就统一了。3.系统设置中不应该有系统配置这一项了。」**

#### 第1条：晚自习开关（照早操/早八的同一套贯穿）
`class_profiles.hasNightStudy`（默认 true），把 `hasMorningClass` 的每一环都补一份：
- `services/band-chao.js::entryTargets` —— 无晚自习的班**不进录入台**；班级全景标注「本班无晚自习」
- `routes/union.js` —— 录入时拦截「本班没有晚自习安排，无需录入」（目标解析里带上标记）
- `routes/admin/class-profile.js` —— 单条 PUT / 批量标记 / 列表 select 与映射 / `noNightStudy` 筛选
- `routes/class.js` —— 班级域全景跳过 + `classInfo` 下发
- 前端 `class-manage` —— 批量区「晚自习 有/无」、列表标记、筛选「只看无晚自习」、确认文案

⚠️ 顺手把前端那串 `field === 'hasMorningExercise' ? '早操' : ...` 的 if/else 链改成查 `FLAG_LABELS` 表：
每加一个开关就要改三处正是漏项根源（这次就差点漏掉 `toggleFlag` 的确认文案）。

#### 第2条：楼名白名单（两份，分开维护）
`goal_config.buildings = { teaching: [String], dorm: [String] }`。**刻意分成两份**：
教学楼不会出现在查宿名单里，混成一份会让人选错楼，而"楼选错了、门牌号看着是对的"比不填更难发现。
- 写入：`POST/PUT /api/admin/config` 接受 `buildings`，经 `normalizeBuildings()` 去空白/去重/截断 20 字/上限 60 个
- 读取：新增 `GET /api/admin/config/buildings`（`config.view` 即可，**不要** `config.manage` ——
  班委要选楼名，但不该为了选楼名就获得改全局配置的权力）
- 新页面 `packageAdmin/config/buildings`（系统设置 → 楼名管理）：两栏各自添加/删除
- 填教室（`class-manage`）：先选教学用楼 → 再填门牌号，**门牌号只收 2~6 位数字**，拼成「楼名·201」
- 填宿舍（`dorms` / `user-detail`）：配置的宿舍楼清单**排在前面**并与历史已有楼合并
  （配置是新楼的唯一来源，历史数据兜底漏配）
- 两份清单为空时**退回原来的自由输入** —— 不能因为管理员还没配楼名就让人完全填不了教室

#### 第3条：删掉「系统设置 → 系统配置」
它只是分类中转页，里面三项（反作弊/跑分设置/激励视频）**都已经在别处平铺**：
前两项在「考核与目标」组，激励视频即「北斗运动」。删入口后该页成了孤儿页，
`check-admin-nav-coverage.js` 立刻报出来 —— 所以把 `packageAdmin/config/{config.js,json,wxml,wxss}`
四个文件一起删掉（同目录的 anticheat/points/reward-video 三个子页保留，各自都有入口）。
系统设置组现在是：楼名管理、文件管理、北斗运动。

#### 验收（真实数据，测后已还原并二次核对）
- 晚自习：把某班设为 false → 晚自习录入台**总数 44**（该班被剔除）→ 设回 true → **45**，差正好一个班；
  班级详情返回 `hasNightStudy`；PUT 关闭/打开都落库正确。
- 楼名：保存两份清单可读回；`[' 1号教学楼 ', '1号教学楼', '', '  ', '超长…']` 清洗后
  = `['1号教学楼', '超长截断…']`（去空白、去重、丢空项、截断 20 字）。
- 终态核对：`buildings = {teaching:[],dorm:[]}`（测前状态）、`hasNightStudy=false` 的班 = 0、班级总数 54 不变。
- `check-admin-nav-coverage.js`：36 页 / 28 入口 / 0 孤儿，exit 0。
- `check-server-contract.js` → **359 项 0 失败**（新增 19 条，覆盖上面每一条链路）。
- 全套 16 桩测试 + 11 静态检查通过。

#### ⚠️ 我自己踩的坑
测班级详情时调了 `GET /api/admin/class/profiles/:id` —— 那个路径**只有 PUT**，
真正的详情是 `GET /:className/profile`，于是误报「详情没返回 hasNightStudy」。
排查发现是测试脚本用错 URL，不是产品 bug。

### 追加（2026-10-21 第四十轮）：点哪都跳不动（严重回归）+ 成员批量管理 + 院校部门联动

用户两条反馈：
**「1.我现在怎么点击哪里都跳转不了 2.学生会成员中增加批量管理操作(改职务、调部门、离任)，
并且院校与部门的联动筛选不正常，尤其是院校为什么有全部和全校两个呢」**

#### 第1条：点哪都跳不动 —— 是我上一轮删页面造成的编译失败

上一轮按用户要求删掉「系统设置 → 系统配置」中转页，只确认了「没有 JS / 页面注册引用」，
**漏了 WXSS 的 `@import`**。而四个页面都在引用它：

| 文件 | 引用方式 |
|---|---|
| `packageAdmin/config/anticheat.wxss` | `@import "config.wxss";`（**整个文件只有这一行**） |
| `packageAdmin/config/points.wxss` | 同上 |
| `packageAdmin/config/reward-video.wxss` | 同上 |
| `packageAdmin/assessment/goals.wxss` | `@import "../config/config.wxss";`（**同样只有这一行**） |

WXSS 引用不存在的文件 → **小程序编译失败** → 整个应用起不来，表现就是「点哪里都跳不了」。
这个错误在 JS 语法检查、契约自检、页面注册检查、导航覆盖检查里**全都看不出来**，
只有开发者工具编译时才报。

修法：
- **恢复 `packageAdmin/config/config.wxss`**（只保留共用骨架 `.cfg-*`，不再含已删中转页的 `.cfg-hub/.cfg-cat`），
  并在文件头写明「被哪四个页面引用、不能删」。
- 新增检查器 **`tools/check-wxss-imports.js`**：扫描全仓库 wxss 的 `@import` 是否都能解析。
  反向验证过：把 config.wxss 改名后它准确报出那 4 处悬空引用、exit 1。
  同时把这条也加进契约自检（第 375 项）。

#### 第2条：成员批量管理（改职务 / 调部门 / 离任）
新增 `POST /api/admin/union/members/bulk-update`，`{ ids, action: role|dept|leave, role?, deptKey? }`。

三条刻意的设计：
- **逐条校验、逐条落库**，不是 `updateMany`：成员的 `level`/`schoolId` 各不相同，
  「这个部门该校区能不能用」「主席/副主席是否必须挂主席团」都要**按每条记录**判；
  一把梭会绕过守卫，造出「洋河成员 + 北校区部门」这类矛盾数据。
- **部分失败不清空已成功的**：返回 `{ updated, failed:[{id,name,reason}] }`，
  界面上逐条告诉操作者哪几个人没成、为什么（只报「成功了 N 个」会让人以为全好了）。
- **离任走软删除**（`status='left'`），与单条 DELETE 完全同口径，保留历史。

前端：顶部「批量」进/出批量模式 → 点整行勾选 → 底部固定栏「改职务 / 调部门 / 离任 / 全选本页」。
批量改职务**只给业务部门职务**（部长/副部长/部员）：批量选中的人可能分属各部门，
统一改成主席会大面积造出矛盾记录——要设主席请用单条「改职务」（它会连带把部门改成主席团）。

#### 第3条：院校筛选命名 + 院校→部门联动
- **命名**：原来两个选项叫「全部」「全校」，读起来像「全校 ⊂ 全部」却看不出差别。
  实际语义是「全部成员」= 不限（校学生会+各分会）／「校学生会」= 只列 `level='school'`。
  改为「全部成员 / 校学生会 / 北校区 / 洋河校区」，与成员列表里的 `orgText` 也统一成「校学生会」。
- **联动**：`onCampusChange` 之前只重载列表、**不重算部门筛选**，
  于是选了「北校区」还能筛出洋河才有的部门，筛出来必然 0 条，
  而两个筛选器各自看起来都"选着东西"，很难看出是矛盾。
  现在切院校会重算部门选项（`buildDeptFilterOptions(campus)`）并清空已选部门。
  顺带修了 `applyOptions` 里的时序问题：算部门要用**本次将要生效**的院校值（`nextCampus`），
  不能用还没 setData 的 `this.data.campus`。

#### 验收（真实数据，测后已还原核对）
- 批量：改职务 2 人成功；调部门时分会成员成功、**校级成员被拒并给出原因**
  「「体育部」属于某个院校的分会，不能作为校学生会部门」——部分失败隔离生效；
  离任 2 人 → `status=left` 且记录仍在；重复离任逐条报告；空选/未知动作被 400 拒。
  测后临时成员残留 0、成员总数 32 不变。
- `check-server-contract.js` → **375 项 0 失败**（新增 16 条）。
- 全套 16 桩测试 + **12** 静态检查（新增 wxss-imports）通过。

#### ⚠️ 这轮我又踩的坑
用 PowerShell `Get-Content -Raw | -replace | Set-Content -Encoding UTF8` 改测试脚本，
PowerShell 5 默认按 GBK 读 → 中文被双重编码写坏，`node --check` 报 `'鍖楁牎鍖?`。
最后用 write 工具整文件重写才好。**改含中文的文件必须用 write/edit 工具，不能用 PowerShell 管道。**

### 追加（2026-10-22 第四十一轮）：楼名页 require 路径写错（整页点击全失效）+ 院校筛选去掉「全部成员」

用户两条反馈：
**「我在模拟器中点击什么都不好使啊，没有效果只能滑动。
此外在学生会成员中的院校筛选不需要全部成员吧」**

#### 第1条：点不动但能滑动 —— 楼名管理页 require 路径多了一级
`packageAdmin/config/buildings.js`（上一轮我新建的）里写的是：
```js
const auth = require('../../../utils/request');   // ❌ 多了一级
```
该文件位于 `miniprogram/packageAdmin/config/`，到 `miniprogram/utils/` 只需 **`../../`**。
上一轮删除的旧 `config/config.js` 恰好也在同一目录、且当时写的是 `../../../utils/request`
（因为它在更深一层？不——它本来就该是 `../../`，是我照抄了错误的层级）。

**为什么表现是「只能滑动、点击全失效」**：require 失败 → 该页 JS 抛出 `module not found`
→ Page() 没有执行 → **所有 bind:tap 都没有绑定**，而 `t-swipe-cell` 的触摸拖动由组件内部
WXS 实现（不依赖页面 JS），所以**滑动仍能用**。这个「能滑不能点」的组合正是 JS 没跑起来的特征。

修法：改成 `require('../../utils/request')`。

**新增检查器 `tools/check-mini-refs.js`**（连同类错误一起兜住）：
- JSON 里 `usingComponents` 的组件路径是否存在（裸包名从 `miniprogram_npm` 解析）
- JS 里 `require('./...')` 的相对路径是否存在
- WXML 用到的 `t-xxx` 是否在该页 json 或 app.json 注册
反向验证过：把路径临时改回错误写法，检查器准确报出
`require 悬空: packageAdmin/config/buildings.js -> ../../../utils/request`、exit 1。
同时把「JS require 相对路径必须存在」也加进契约自检（第 377 项）。

#### 第2条：院校筛选去掉「全部成员」
上一轮我把「全部」改名成「全部成员」保留了下拉项，用户明确表示**不需要**：
院校选择器里给一个「不限」是没有意义的伪选项，清筛选有专门的「清除筛选」入口。
现在只剩真实档位：**校学生会 / 北校区 / 洋河校区**。
连带修两处：
- `campus` 默认值与「清除筛选」都回到 `'school'`（否则选择器会显示空白）
- 提示条 `wx:if` 从 `campus`（恒真）改为 `campus !== 'school' || deptKeyFilter || termIdFilter`，
  否则「点此清除筛选」会一直挂着

#### 验收
- `check-mini-refs.js`：76 json / 86 js / 74 wxml 全部可解析，exit 0（反向验证能抓错）
- `check-wxss-imports.js`：全部 @import 可解析
- `check-server-contract.js` → **377 项 0 失败**
- 全套 16 桩测试 + **13** 静态检查（新增 mini-refs）通过

### 追加（2026-10-22 第四十二轮）：楼号只能选 / 床号 1~8 / 楼名独立权限 + UI 美化

用户两条需求：
**「1.如图1这里我们需要你楼号只能选择，床号只能是1至8。教室设置也是只能选择不是手动输入，
输入的只有门号。2.楼名管理需要权限项，并重新美化一下UI效果。」**

#### 第1条：楼号只能选，只有门号能填
- **宿舍抽屉**（`components/dorm-sheet`，班级宿舍页与用户详情页共用）：
  楼号 → 白名单点选胶囊；门号 → 唯一输入项（`type=number` + 过滤非数字 + 限 6 位）；
  **床位号 → 固定 1~8 点选**（再点一次取消，因为它是选填）。
  没选楼号 / 没填门号时保存直接拦下并提示。
  对外接口保持 `roomText`（「楼名·201」）不变 —— 组件内部用 observer 把它拆成
  `pickBuilding` + `roomNo` 渲染，再拼回去，**两个父页面不需要改**。
- **教室**（`class-manage`）：改成调用新抽的 `utils/room-pick.js::composeRoom`，
  楼名只能从清单里选、门号才弹输入框。
  为什么抽成共用模块：教室与宿舍是两套页面两套接口，但「楼名只能选、门号才能填」是同一条规则，
  各写一份必然漂移（一处改了必填、另一处忘了）。
- 清单为空时**明确提示去系统设置配置**，而不是退回自由输入 —— 那等于把白名单规则又作废了。

#### 第2条：楼名独立权限项 + UI 美化
新增权限（`models/permission.js`）：
- `building.view` 查看楼名清单
- `building.manage` 管理楼名清单（教学楼/宿舍楼）

**为什么不复用 `config.view/config.manage`**：那两个覆盖反作弊阈值、跑分参数等全局计分口径，
而楼名只是「教室/宿舍怎么填」的基础字典。宿管要维护宿舍楼名，不该因此获得改计分规则的权力。

配套三处修改，缺一个都会破：
1. `requirePermission(...)` 扩展为**多权限任一满足**（`building.view` 或 `config.view`），
   既不把存量权限组锁死，又能收紧到新项；
2. `PUT /api/admin/config` 加**分字段守卫**：只持 `building.manage` 的账号**只能**改 buildings，
   请求里带 `points/anticheat/rewardVideo` 一律 403；
3. ⚠️ **`routes/admin/index.js` 的 `/config` 前缀不再预挂 `config.view`** ——
   本轮踩到的坑：只在子路由写细权限完全无效，前缀守卫先把请求挡了（表现为「改了还是 403」）。
   放开前缀后必须在 `GET /` 上显式补回 `config.view`，否则整份配置变裸奔。

UI 重做（`config/buildings`）：顶部渐变说明卡 + 两张分栏卡片（各有图标、数量徽标、
空态引导、主题色区分的胶囊），胶囊沿用「inline-flex + nowrap + flex:0 0 auto」
（本仓库踩过「生活部被裁成 e」的坑，楼名更长更容易出事）。

#### 验收（真实数据，测后已还原）
权限四组实测：
| 账号权限 | 读楼名 | 写楼名 | 改计分 |
|---|---|---|---|
| 仅 `building.view` | ✅ | ❌ 403 | ❌ |
| 仅 `building.manage` | ✅ | ✅ | ❌ 403（带 points 被拒，库里未被改） |
| 仅 `config.view`（存量） | ✅ 兼容 | ❌ | ❌ |
| 无相关权限 | ❌ 403 | ❌ | ❌ |

- 终态核对：`buildings = {teaching:[教学楼,实训楼], dorm:[1号楼(女生宿舍),2号楼(男生旧宿),3号楼(男生新宿)]}`（测前原样）、临时账号残留 0。
- `check-server-contract.js` → **385 项 0 失败**（新增 8 条，含「前缀不预挂 config.view」这条防回归）。
- 全套 16 桩测试 + 13 静态检查通过。

#### 本轮教训
改权限时**先确认请求到底被哪一层挡下**：路由前缀的 `router.use(..., requirePermission(...))`
会先于子路由执行，子路由里写再细的权限也无效。我第一版只改子路由，
测试一直报「需要 config.view」，排查后才发现是前缀守卫。

### 追加（2026-10-22 第四十三轮）：教室/宿舍统一改用「一次填完」的对话框

用户反馈（截图：选完「教学楼 / 实训楼」后又弹一个窗让填门号）：
**「尽量使用 Dialog 对话框完整的 现在你选择教学楼竟然还有弹窗让输入门号，直接让用户一次输入完。」**

#### 旧流程的问题
教室设置是「`wx.showActionSheet` 选楼 → 再 `wx.showModal` 填门号」两步：
第二个弹窗压在第一个上，用户要来回确认两次，且中途取消就前功尽弃。
另外「我的班级」页的教室**是内联 input**（可以直接手打楼名），
与「楼名只能选」的规则自相矛盾。

#### 修法：抽 `components/room-dialog`，一个面板填完
新组件（教室与宿舍共用）在一个 `t-popup` 里放下：
1. **楼号**：白名单胶囊点选（选中有 ✓，无任何 input）
2. **门号**：唯一手输项（`type=number` + 过滤非数字 + 限 6 位），未选楼时禁用并提示先选楼
3. **床位号**：仅宿舍显示，固定 1~8（再点取消，选填）
4. **实时预览**：「1号楼 · 201」——保存前就能看到最终会存成什么
5. 底部「清空 / 保存」，未选楼或未填门号时保存不可用

接入两处：
- `class-manage`（班级管理）：`editClassroom` → 打开对话框，确认后直接 PUT
- `class`（我的班级）：内联 input → 只读展示 + 点开对话框；
  教室在该页是**随表单一起保存**的字段，所以对话框只写 `profile.classroom`，
  再由「保存班级配置」统一提交（并在填写后提示「记得点保存」，避免以为已经存好）

顺带清理：`utils/room-pick.js` 被组件取代后成了孤儿，已删除（不留死代码）。

#### 验收
- `check-server-contract.js` → **390 项 0 失败**，新增/更新 8 条：
  「教室改用完整对话框（不再是两步弹窗）」「对话框内同时有楼号点选与门号输入」
  「楼号区域无输入框」「门号只收数字」「床号固定 1~8」「未选楼/未填号拒绝保存」
  「我的班级页教室也不再内联手输」「两个页面都注册了 room-dialog」。
- 全套 16 桩测试 + 13 静态检查通过（含 mini-refs：组件注册与 require 全部可解析）。

### 追加（2026-10-22 第四十四轮）：教室对话框 UI 塌陷 —— 漏配 styleIsolation

用户截图（弹层里内容挤在左侧、`×` 跑到中间、保存按钮拉满底部整行）：
**「我需要你重新优化这个UI效果。」**

#### 根因不是样式写得不好，是公共骨架根本没加载
新组件 `components/room-dialog/room-dialog.json` 漏了：
```json
"styleIsolation": "apply-shared"
```
组件的 wxml 用了 `app.wxss` 的公共 `.tt-sheet*` 骨架（head 横向一行、foot 固定底部、body 可滚），
但**默认 styleIsolation 是 isolated** → 这些公共类在组件内完全不匹配 →
所有元素退回默认块级布局：内容竖着堆在左边、关闭按钮按文档流排到中间、
底部按钮撑满一行。三个症状是同一个原因。

对照 `dorm-sheet.json` 一眼就能看出差别（它一直有这一行，所以从未出问题）。

#### 修法
1. `room-dialog.json` 补 `"styleIsolation": "apply-shared"`；
2. 重写 wxml 分块结构（`rd-block` 包裹每组「标签 + 内容」），
   wxss 只补私有类、**不再重写** head/foot 布局（那会被公共骨架覆盖，写也没用）；
3. 加检查器 **`tools/check-component-styles.js`**：
   组件若在 wxml/wxss 里用了 `.tt-*` 公共类，json 就必须声明 `styleIsolation: apply-shared`。
   反向验证过：把 room-dialog.json 的该项临时删掉，它准确报出
   `components/room-dialog/room-dialog.json（当前 styleIsolation: isolated）→ 公共骨架样式不会生效，布局会塌`、exit 1。
   同时把这条也加进契约自检（第 391 项）。

#### 验收
- `check-component-styles.js`：10 个组件全部合规，exit 0（反向验证能抓错）
- WXML 标签配对：view 25/25、block 1/1、scroll-view 1/1、t-popup 成对、t-icon 5 处自闭合
- `check-server-contract.js` → **391 项 0 失败**
- 全套 16 桩测试 + **14** 静态检查通过

#### 教训
「组件 UI 塌成一列」的第一嫌疑不是 CSS 写错，而是**公共样式没生效**（styleIsolation）。
本项目所有弹层共用 `app.wxss` 的 `.tt-sheet*` 骨架，新建组件时必须带上 `apply-shared`，
否则私有样式怎么写都补不回来。

### 追加（2026-10-22 第四十五轮）：恢复院校筛选的「全部成员」

用户：**「这里恢复一下吧 我还是要全部成员。」**

（上一轮按「不需要全部成员吧」去掉了它，这轮按最终口径加回来。口径变更两次，以本轮为准。）

现在的院校筛选：
| 选项 | 含义 | campus 值 |
|---|---|---|
| 全部成员 | 不限层级（校学生会 + 各校区都算） | `''` |
| 校学生会 | 只列 `level='school'` 的校级成员 | `'school'` |
| 北校区 / 洋河校区 | 该校区 | 校区 id |

「全部成员」与「校学生会」**不重复**：前者是"什么都不筛"，后者是"只筛校级那一层"。

#### 连带修掉一个隐藏 bug
恢复「全部成员」会立刻暴露一处：`buildDeptFilterOptions('')` 把空串直接传给了
`deptFitsCampus(d, '')` —— 而那里的 `''` 语义是「**校级层**」（只匹配 scope='school' 与主席团）。
结果：「全部成员」下的部门筛选只列出校级部门，**各校区分会的部门全都筛不出来**。

修法：不限层级时不做 `deptFitsCampus` 过滤，直接列全部部门。

#### 验收（驱动真实 members.js）
- 选项顺序：`全部成员('') / 校学生会('school') / 北校区 / 洋河校区`，默认选中「全部成员」
- 「全部成员」下部门筛选 = `全部部门 / 主席团 / 生活部 / 北校区·体育部 / 洋河校区·卫生部`（**全部都在**）
- 切到北校区 → 部门筛选收敛为 `全部部门 / 主席团 / 生活部 / 北校区·体育部`（无洋河卫生部）
- 「清除筛选」→ campus 回到 `''`、部门回到不限
- `check-server-contract.js` → **392 项 0 失败**
- 全套 16 桩测试 + 14 静态检查通过

### 追加（2026-10-22 第四十六轮）：批量栏无背景 + 扫码加人

用户两条：
**「1.这里低下的批量编辑UI没有背景。
2.为了方便学生一键加入学生会我想给每个用户的主页增加用户二维码，如主席团部长。
通过设置后扫描二维码进行批量添加」**
（追问后澄清：**学生主页出码，由主席团/部长/副部长去扫**）

#### 第1条：批量栏没背景 —— 用了不存在的 CSS 变量
`--tt-bg-card` **根本不存在**（项目里的令牌叫 `--tt-card`），
于是 `background` 声明整体失效 → 栏体透明 → 内容直接叠在列表上。
同类错误还有 `--tt-radius-lg`（应为 `--tt-radius`），共 **9 处**，分布在 3 个文件。

修法：全量替换，并新增检查器 **`tools/check-css-vars.js`**：
扫描所有 wxss 的 `var(--x)`，未在 app.wxss / TDesign 主题 / 本文件里定义的就报错。
当前 77 个 wxss / 2411 处引用全部有定义。
批量栏同时补齐实心背景 + 上边框 + 阴影 + `z-index: 60`，确保明确浮在列表之上。

#### 第2条：扫码加人（学生出码 → 干部扫码）
新增 `models/union-invite.js`（集合 `union_invites`）：
一次性凭证，**绑学生本人**、**10 分钟有效**、`expiresAt` 带 TTL 索引自动清理。
为什么不用学号直接写进二维码：学号可枚举（连号），任何人扫到别人的学号都能伪造入会请求；
凭证能追溯「是谁的码、被谁用掉」。

三个接口（挂在用户端 `routes/union.js`，因为干部在用户端操作）：
| 接口 | 作用 |
|---|---|
| `GET /invite/mine` | 学生取自己的凭证；`?userId=` 支持管理员替学生生成（需 union.manage/steward） |
| `GET /invite/:token` | 干部预览：是谁、是否已是成员、码是否过期（**不消费**凭证） |
| `POST /invite/:token/accept` | 干部确认加入，消费凭证 |

安全设计：
- 加入动作复用 **`assertMemberManager`**（与成员管理同一套闸门）——只有主席团/部长/副部长/总管能加人；
- 部门归属用 `assertDeptFitsCampus` 校验（与成员管理同一份），层级/校区**跟随干部自己的记录**；
- 凭证用掉即 `usedAt` + 记录使用人 openid，重复使用直接 409。

前端两处：
- **用户详情页**（学生主页）：新增「加入学生会二维码」入口 + 弹层，展示凭证串、有效期、重生成；
- **扫码加人页**（`packageAdmin/union/scan-join`）：`wx.scanCode` 扫码 → 预览 → 选部门 → 确认。

⚠️ 本轮踩的坑：`scan-join` 在三级目录，`require('../../utils/request')` 少了一级
（应为 `../../../`）。这正是前两轮刚踩过的同类错误，已加断言锁死。

#### 关于「真小程序码」
本版二维码内容是**凭证串**（`ttkp://union-invite/<token>`），可完整跑通「学生出码 → 干部扫码 → 加人」。
要换成微信官方 `getwxacodeunlimit` 生成的**真小程序码**，需要有效的 `WX_APPSECRET` + 外网访问微信接口；
届时只需替换「码内容」的生成方式，**校验逻辑（本集合）完全不变**。
（用户已确认先做可跑通版本。）

#### 验收（真实数据，测后已还原核对）
扫码加人全链路 **17 项**全过：
- 学生能生成 64 位 hex 凭证、带有效期与 qrText
- 普通学生**不能**替别人生成（403）
- 部长能预览、能确认加入；加入后成员记录为「生活部 · 分会」
- 无成员记录者预览被拒（403）
- 同一凭证重复使用被拒（409）、已标记 `usedAt` 并记录使用人
- 过期凭证被拒、无效凭证 404

- `check-css-vars.js` → 全仓库 0 处失效变量
- `check-server-contract.js` → **405 项 0 失败**（新增 13 条）
- 全套 16 桩测试 + **15** 静态检查通过
- 终态：临时账号/成员/凭证残留均 0，成员总数 32 不变

### 追加（2026-10-22 第四十七轮）：扫码流程改为「先选部门再扫」+ 所有用户都有码

用户：**「扫码时需要先设置主席团/部长/副部长需要先在扫码页面中设置部门然后直接去扫，
成为部员。所有用户都有码包括教师账户，在我的页面中上面的卡片就有这个按钮可以直接打开自己的二维码。」**

#### 改动一：扫码页改为「① 选部门 → ② 扫码即加入」
旧流程是「扫码 → 预览 → 选部门 → 确认」四步，现场操作太啰嗦。
现在**部门前置**：选好部门后扫码动作本身就是确认，现场只需两步。

- 未选部门时扫码按钮 **disabled** 且图标降级（明确"还不能扫"）；
- 扫到后立刻显示结果卡片（是谁 / 哪个班），并给**撤回**按钮
  （加错人可当场移出，不用跳去成员页）；
- 撤回走 `POST /api/union/manage/members/:id/remove`（用户端接口）——
  干部通常只有学生会身份、没有 `union.manage`，不能走管理端接口。

#### 改动二：所有用户都有码，含教师
- 去掉 `/invite/mine?userId=` 里的「教师不能生成码」拦截
  （教师不是学生会成员，扫码加人时 `/accept` 仍会拒绝，但「能出示自己的码」是身份展示能力）；
- **「我的」页顶部身份卡**新增「我的码」按钮，点开即出示自己的二维码；
- 用户详情页原有的「加入学生会二维码」入口保留（管理员替学生出码的场景）。

#### 顺带修掉两个权限判断 bug
1. `?userId=` 原先只认 `union.manage/union.steward` —— 但**主席团/部长通常没有 union.manage**，
   而扫码加人正是他们需要替学生取码。改为「能管成员（`canManageMembers`）或总管」。
2. ⚠️ **超管必须单独判**：`dev_admin_1` 持 `'*'` 但**不是学生会成员**，
   `canManageMembers` 返回 `false`，导致超管替别人取码被 403。已补 `perms.includes('*')` 短路。

#### 验收（真实数据，测后已还原）
- 教师能取自己的凭证；管理员能替教师生成（不再被拒）
- 干部替学生取码 → 带部门 `accept` → 成员记录建立（生活部 / 分会）
- 撤回生效：记录变 `left`（保留历史）
- 扫**教师**的码去加人 → 被拒（400「教师账号不能加入学生会」）
- 终态：临时账号/成员/凭证残留 0、成员总数 32 不变
- `check-server-contract.js` → **409 项 0 失败**
- 全套 16 桩测试 + 15 静态检查通过

### 追加（2026-10-22 第四十八轮）：二维码被底部导航挡住

用户截图（「我的」页二维码弹层下半截被 tabBar 盖住）：**「这码被挡住了」**

#### 根因：弹层层级低于自定义 tabBar
自定义 tabBar（`custom-tab-bar/index.wxss`）是 `position: fixed` + **`z-index: 999`**，
而我给二维码弹层写的是 `z-index: 40/41` → **tabBar 整个盖在弹层上面**。
同时弹层贴底（`bottom: 0`）但底部只留了 28rpx，
即便层级够了，底部说明与「重新生成」按钮仍会藏在胶囊后面。

#### 修法
- 遮罩/面板层级提到 **1020 / 1021**（高于 999）；
- 「我的」页弹层底部留白改为 `calc(140rpx + safe-area)` ——
  tabBar 高 112rpx + 自身 `bottom: 16rpx` 偏移 ≈ 128rpx，留 140rpx 才不会压住；
- `user-detail` 的同类弹层一并提到 1021（它不在 tabBar 页，但层级统一，避免从 tabBar 页跳进来时视觉不一致）。

#### 新增检查器 `tools/check-tabbar-overlay.js`
规则两条（都来自这次事故）：
1. tabBar 页里 `position:fixed` + 贴底 + `z-index` 在 10~999 之间的浮层 → 报错（会被 tabBar 盖）；
2. 这类贴底浮层的底部 `padding` 小于 120rpx → 报错（内容会藏在胶囊后）。
反向验证过：把层级临时改回 41，它准确报出
`pages/profile/profile.wxss .pf-qr-sheet → z-index 41 ≤ tabBar(999)`、exit 1。
同时把「tabBar 页贴底浮层高于 999」加进契约自检（第 410 项）。

#### 验收
- `check-tabbar-overlay.js`：6 个 tabBar 页全部合规，exit 0（反向验证能抓错）
- `check-server-contract.js` → **410 项 0 失败**
- 全套 16 桩测试 + **16** 静态检查通过

#### 教训
本项目底部导航是**自定义 tabBar 且 z-index 999**，任何全屏弹层/抽屉都必须高于它，
并且贴底时要给它留出约 128rpx —— 这两点之前只靠记忆，现在有检查器兜住。

### 追加（2026-10-22 第四十九轮）：真正生成二维码图 + 去掉固定文案

用户截图（弹层里只有一串凭证文本）：**「二维码呢 此外低下的请让主席团/部长用这个不使用，
因为以后也可能用到这个码。」**

#### 问题一：只有文本，没有二维码
上一轮为了先跑通链路，码内容是**凭证串文本**（`ttkp://union-invite/<token>`），没有真画成图。
这次补上真图：

- 后端装 `qrcode`（纯 JS，无需 canvas 编译），在 `GET /invite/mine` 里生成 **PNG dataURL**；
- 内容就是 `qrText`，所以微信扫一扫能直接识别；
- **生成失败不影响接口**：仍返回 `token`/`qrText`，前端回退显示文本 ——
  否则"图没画出来"会让整个出码功能不可用；
- 前端两个页面（我的页 / 用户详情页）都改成 `<image src="{{qr.qrImage}}">`，
  并保留文本回退分支；有图时去掉虚线框改白底（扫码识别率更高）。

#### 问题二：去掉固定文案
删掉「请让主席团 / 部长用「扫码加人」扫这张码」——
用户指出这张码**以后还可能用于别的场景**（不只是入会），写死用途会误导。
现在只保留「有效期至 …，使用一次即失效」。

#### 验收（真实数据）
- 接口返回 `qrImage`，PNG 魔数 `89504e470d0a1a0a` 正确、体积 >1KB、尺寸 **520×520**
- `qrText` 仍是 `ttkp://union-invite/<64位hex>`，与图片内容一致（同库可重生成）
- `qrcode` 已写入 `server/package.json` 依赖
- 全仓库已无「请让主席团 / 部长用」文案
- `check-server-contract.js` → **416 项 0 失败**（新增 6 条）
- 全套 16 桩测试 + 16 静态检查通过

### 追加（2026-10-22 第五十轮）：登录刷新缓存 + 只读不显示写操作

用户两条：
**「1.在登录账户时一定要刷新缓存。
2.在没有权限时如查看与管理，只有查看权限时应该不显示操作功能按钮，而不是点击后被后端拒绝掉。」**

#### 第1条：登录后刷新缓存
**根因**：各管理端页面在 `onLoad` 里按 `globalData.userInfo.effectivePermissions`
把 `canManage` 算好存进 `data`，之后再**永不重算**。
登录（含换账号）只更新了 `globalData.userInfo` —— 页面 data 里仍是上一个身份的结论。
表现正是用户第 2 条描述的现象：换成本该只读的账号，还能看到操作按钮，点了被后端 403。

修法（`utils/request.js`）：
- 新增 `refreshCachesAfterLogin(userInfo)`：清掉账号相关全局缓存
  （`userInfo/today/stats/unionIdentity/points`）、
  递增 `globalData.permissionEpoch`、并**遍历页面栈**调用各页的 `refreshPermission()`；
- **三条登录路径全部接上**：静默登录、绑定账号、一键登录（设备令牌）——
  少接一条就等于那条路径仍拿着旧权限；
- 新增 `permissionStale()` / `markPermissionSynced()` 供页面在 `onShow` 里判断是否需要重算。

五个管理端页面（class-manage / config-buildings / union-members / users / content-badges）
注入 `refreshPermission()` 并挂到 `onShow` 首行 —— 切回页面时也会重算。

#### 第2条：只读用户不显示写操作
先写检查器 **`tools/check-write-guard.js`** 全量排查（否则只能靠肉眼翻 30 多个 WXML）：
规则是「同时存在 `.view` 与 `.manage` 权限概念的页面」中，
所有写操作入口（add/save/submit/remove/apply/...）必须被 `canManage` 类条件守住
（同节点或祖先节点），祖先范围 80 行。

排查出并修掉的**真问题**：
| 位置 | 问题 |
|---|---|
| `config/points` `anticheat` `reward-video` | 保存栏、输入框、开关**完全没判权限**（`section.js` 只判了能看） |
| `content/badges` | 整页**没有任何权限变量**，新增/保存/启停全裸奔 |
| `class-manage` | 「批量」入口与批量面板没判权限 |
| `class` | 「保存卫生区」按钮没判权限 |
| `union/config` `union/members` `user-detail` `account-edit` `users` | 抽屉/表单的保存按钮缺显式条件（入口虽已隐藏，意图不清晰且无法静态校验） |

修法：`section.js` 补 `canManage`（`config.manage`）；badges 补 `canManage`（`content.manage`）；
只读用户**看不到**保存/新增/批量按钮，输入框与开关 `disabled`（能看当前值，改不了）。

检查器还剔除了 5 类误报：纯界面动作（展开/清筛选/批量模式开关）、
多行节点的属性续行、同一节点的多 `bind`、由「模式开关」间接守卫（如 `bulkMode`）的入口。

#### 验收
- 真实 page JS 驱动：五个页面在只读账号下 `canManage=false`、可写账号下 `true`（10 项）
- 登录刷新：`permissionEpoch` 递增、`today` 缓存清空、`userInfo` 换新（4 项）
- `check-write-guard.js`：10 个有只读用户的页面全部合规，exit 0
- `check-server-contract.js` → **429 项 0 失败**（新增 13 条）
- 全套 16 桩测试 + **17** 静态检查通过

#### 教训
「权限算一次就存进 data」是这个项目的系统性隐患：
只要账号能切换，就必须有「换代」机制。现在登录会递增 `permissionEpoch`，
页面 `onShow` 据此重算 —— 这是唯一可持续的做法（逐页 onShow 里重算权限太容易漏）。






