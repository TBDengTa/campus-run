# 唐唐快跑 UI 设计规范（白橙 · 简约大气）

> 适用范围：`miniprogram/` 全部页面（用户端 + `packageAdmin` 管理端）。
> 设计令牌与公共类定义在 `miniprogram/app.wxss`，页面样式只做局部补充。

## 1. 色彩

| 用途 | 令牌 | 浅色 | 深色 |
|---|---|---|---|
| 主色（品牌橙） | `--tt-brand` | `#ff6b00` | `#f09248` |
| 主色加深（文字/描边） | `--tt-brand-deep` | `#e05e00` | `#e07b24` |
| 主色浅底 | `--tt-brand-soft` | `#fff4ec` | 半透明橙 |
| 主色浅底（更强） | `--tt-brand-soft-2` | `#ffe6d2` | 半透明橙 |
| 页面底色 | `--tt-bg-page` | `#f6f7f9` | `#141414` |
| 卡片底 | `--tt-card` | `#ffffff` | `#1f1f1f` |
| 主文字 | `--tt-text-1` | `rgba(0,0,0,.9)` | `rgba(255,255,255,.9)` |
| 次文字 | `--tt-text-2` | `rgba(0,0,0,.6)` | `rgba(255,255,255,.6)` |
| 辅助文字 | `--tt-text-3` | `rgba(0,0,0,.42)` | `rgba(255,255,255,.42)` |
| 分割线 | `--tt-line` | `#f0f1f3` | `#2c2c2c` |
| 卡片阴影 | `--tt-card-shadow` | 柔和大范围投影 | 加深投影 |

TDesign 变量同样被改造成橙色系（`--td-brand-color-*`、`--td-bg-color-*`、`--td-shadow-*`），
因此 `t-button` / `t-tag` / `t-cell` / `t-progress` 等组件默认即为白橙风格，**不要**在页面里覆盖组件内部颜色。

语义色：成功 `--td-success-color-5` `#16a34a`、警告 `#f5a623`、错误 `--td-error-color-6` `#e5484d`。

主视觉渐变（仅用于 hero/用户卡/排行榜我的卡片）：

```css
background: linear-gradient(135deg, #ff9a3d 0%, #ff6b00 62%, #f25a00 100%);
box-shadow: 0 12rpx 32rpx rgba(255, 107, 0, 0.24);
```

## 2. 形状与间距

| 令牌 | 值 | 说明 |
|---|---|---|
| `--tt-radius` | `28rpx` | 卡片圆角 |
| `--tt-radius-sm` | `20rpx` | 小卡片 / 提示条 |
| `--tt-gap` | `24rpx` | 卡片外边距、卡片间距 |
| `--tt-pad` | `32rpx` | 卡片内边距 |

- 页面左右统一留白 `24rpx`（由 `.tt-card` / 分段容器的 `margin` 提供）。
- 页底留白统一 `calc(48rpx + env(safe-area-inset-bottom))`。
- 图标胶囊 `92rpx`、列表图标胶囊 `72~76rpx`、头像 `96~140rpx`。
- 阴影一律使用 `--tt-card-shadow`（或 hero 专用橙色投影），不要自创 `rgba(0,0,0,.3)` 硬阴影。

## 3. 公共类（定义在 app.wxss，直接使用，勿重复实现）

| 类名 | 用途 |
|---|---|
| `.tt-page` | 页面容器（底部安全区留白） |
| `.tt-card` | 白色卡片：圆角 + 内边距 + 投影 + 左右外边距 |
| `.tt-card-flat` | 无投影描边卡片（用于嵌套场景） |
| `.tt-section` | 分组标题（左侧橙色渐变短竖条，`::before` 自动生成） |
| `.tt-section-extra` | 分组标题右侧的次要文字/操作 |
| `.tt-hero` | 橙色渐变主视觉卡（首页专属样式在页面内细化） |
| `.tt-stat-row` / `.tt-stat` / `.tt-stat-value` / `.tt-stat-label` | 等分数据行（自动竖分割线） |
| `.tt-grid` / `.tt-grid-item` / `.tt-grid-text` / `.tt-chip-icon` | 图标入口网格（默认 4 列，`.tt-grid-3` 为 3 列） |
| `.tt-row` / `.tt-row-title` / `.tt-row-sub` | 列表行（带下分割线，最后一行自动去掉） |
| `.tt-segment` / `.tt-segment-item` / `.active` | 药丸分段控件 |
| `.tt-chip` / `.tt-chip.active` / `.tt-chip-brand` | 细标签 / 筛选标签 |
| `.tt-pill-btn` + `.primary` / `.ghost` | 药丸主/次按钮（非 TDesign 按钮，用于自绘场景） |
| `.tt-empty` | 空状态文案 |
| `.tt-muted` / `.tt-brand-text` / `.tt-num-brand` | 文字色辅助 |
| `.num-font` | 数字字体（TCloudNumber），所有大数字必须使用 |
| `.tt-footer` | 页脚说明文字 |
| `.tt-btn-right` | **行内靠右按钮容器**：包住 `t-button` 用（`<view class="tt-btn-right"><t-button size="small"/></view>`）。TDesign 按钮宿主节点在 flex 行里不会收缩，直接放进 `space-between` 行会让按钮停在中途、右侧留出空缺，包一层这个类才能收缩到内容宽度并贴右 |

## 4. 底部导航（自定义 tabBar）

`app.json` 的 `tabBar.custom = true`，实际渲染由组件 `custom-tab-bar/index` 负责：

- **形态**：白色悬浮胶囊（`left/right: 24rpx`、`height: 112rpx`、`border-radius: 999rpx`、柔和大投影），
  **全部为普通导航项，不做中间凸起圆钮**。
- **图标**：用 `t-icon` 矢量图标（选中用 `*-filled` 填充态 + `#ff6b00`，未选中用线性态 + `#9aa0a6`），
  不用位图，便于随主题换色；`assets/tabbar/*.png` 仅作为关闭 custom 时的原生兜底。
- **角色差异**：学生 = 首页 / 跑步 / 记录 / 排行 / 我的；
  教师（有管理权限）= 首页 / 管理 / 我的；教师（无管理权限）= 首页 / 公告 / 我的。
  教师账号不参与运动记录与排名，故不展示跑步 / 记录 / 排行入口。
- **接入约定**：每个 tab 页在 `onShow` 中调用 `this.getTabBar().setActive('<自身路径>')`
  （页面根节点同时加 `.tt-page-tab`，底部留白 `200rpx + 安全区`，避免内容被悬浮胶囊遮挡）。
- 非 tab 入口（管理端控制台 / 公告）在组件内用 `wx.navigateTo`，tab 页用 `wx.switchTab`。

## 5. 页面骨架

```xml
<view class="page tt-page">
  <view class="tt-section">分组标题<text class="tt-section-extra">右侧说明</text></view>

  <view class="tt-card">
    <view class="tt-stat-row">
      <view class="tt-stat">
        <view class="tt-stat-value num-font">12,345</view>
        <view class="tt-stat-label">累计步数</view>
      </view>
    </view>
  </view>

  <view class="tt-footer">说明文字</view>
</view>
```

标准表单/详情页骨架：

```xml
<view class="page tt-page">
  <view class="tt-hero">…主视觉（可选）…</view>
  <view class="tt-card">…表单…</view>
  <view class="tt-pill-btn primary" bind:tap="submit">提交</view>
</view>
```

## 6. 组件与图标

- 组件全部走 TDesign（`t-button`、`t-cell`、`t-input`、`t-tag`、`t-empty`、`t-stepper`…），图标统一用 `t-icon`
  （局部 `color` 传 `var(--tt-brand)` / 语义色）。
- **新增图标前必须确认图标名存在**（`icon.wxss` 是单行压缩 CSS，`Select-String` 逐行匹配会误报，请用正则）：

  ```powershell
  $css = Get-Content miniprogram\miniprogram_npm\tdesign-miniprogram\icon\icon.wxss -Raw
  [regex]::Matches($css, '\.t-icon-([a-z0-9-]+):before') | ForEach-Object { $_.Groups[1].Value }
  ```

  未命中会渲染成空白方块。
- `t-button` 主按钮直接用 `theme="primary"`（已是橙色）；次按钮用 `theme="default"`，
  需要橙色浅底时用 `variant="outline"` 或 `.tt-pill-btn.ghost`。
- 数字展示统一 `num-font`，步数用千分位（`fmt.formatNumber`），距离用 `fmt.formatDistance`，时长用 `fmt.formatDuration`。

## 7. 硬性要求

1. **只改样式与结构**（`.wxml` / `.wxss`），JS 仅允许为展示新增字段（如预格式化的 `xxxText`），
   不得改动接口调用、鉴权、路由与业务分支；角色相关的界面差异（如教师端导航）除外，需同步更新本文档。
2. 禁止硬编码蓝色（`#0052d9` 等）或旧灰蓝色系；颜色一律引用令牌。
3. 禁止修改 `miniprogram_npm/` 内任何文件。
4. 页面级 `.wxss` 不得重定义 `.tt-*` 等公共类，只能定义页面私有类名（建议以页面名开头，如 `.water-*`）。
5. 新增页面必须把 4 件套（`.js/.json/.wxml/.wxss`）登记进 `app.json`；tab 页还需在 `onShow` 里同步自定义 tabBar 选中态。
6. 空状态优先使用 `.tt-empty` 或页面自绘空状态，保持视觉统一。
7. 修改完成后必须自检：
   - `node --check <改动的 .js>`（如动过 JS）
   - JSON 文件保持合法（可用 `Get-Content -Raw | ConvertFrom-Json` 校验）
   - WXML 中引用的每个图标名都已确认存在
   - 所有 `bind:tap` 指向的方法在对应 `.js` 中存在

## 8. 首页（学生端）版式与插画素材位

首页自上而下：**插画头 → 公告跑马灯 → 广告位 → 今日目标 → 本周目标 → 管理面板（有权限时）→ 快捷入口 → 页脚**。

- **插画头**（`.sky`）：两种形态自动切换。
  - **有素材**（`assets/home/hero.png` 存在）：`<image mode="widthFix">` 按**图片本身比例**铺满宽度，容器高度自适应
    （1500×523 的图 → 750rpx 宽时约 262rpx 高），并且**不再叠加标题文字**（图内已含「唐唐快跑」与标语）。
  - **无素材**：CSS 插画兜底 —— 高 `350rpx` 的天空渐变 + 圆角云朵 + 双层椭圆草地 + 虚线椭圆跑道 +
    白色标题（四向蓝描边）与标语，标题区 `padding-top: 74rpx`、跑道 `bottom: 38rpx`。
  - 公告条用 `margin-top: -20rpx` 叠在插画底边上，遮住图片与页面底色的接缝。
- **公告跑马灯**：`.notice-viewport`（`overflow: hidden` 定高）+ `.notice-track`（两份文案 + `translateX(-50%)` 无限循环动画）。
  文案 ≤ 14 字不滚动（只渲染一份、不加 `.run`）；超过则 `animation-duration = clamp(字数 × 0.2, 8, 40)` 秒（约 125rpx/s）。
  文案由**当前生效的多条公告正文**拼接（标题兜底、换行压平、单条超 60 字截断、最多 5 条）——只显示第一条的标题会看起来像写死的错误文案。
- **今日目标 + 本周目标（同一张卡片）**：上半部分今日、下半部分本周，中间用 `.card-split`（2rpx `--tt-line`）分隔，比两张卡省一次卡片间距与内边距。
  标题 + 计划名胶囊（点进身体数据/目标计划）+ 「同步」胶囊（微信运动同步入口）。
  - **有记录**：摘要行显示「日期 · 步数 · 里程」，下面是**本周 7 天圆点**与**橙色四项指标条**（步数/公里/时长/卡路里）。
  - **无记录**（当日无记录，或同步后步数与里程都为 0）：摘要行只留日期，**四项指标条整块不渲染**，改为一行「今天还没有运动记录，去运动 ›」（`.today-empty`，点击切到跑步 tab）。两块是 `wx:if="{{hasRecord}}"` / `wx:else` 的二选一关系，且必须是相邻兄弟节点。
  - **每日目标步数**（`.today-goal`，浅橙底圆角块）：标题行「每日目标 + 大号目标步数 + 步 + 右侧 已完成 N%/未开始」，
    下面 8rpx 橙色渐变进度条（宽度 = 今日完成度 `percent`），底部一行「还差 N 步达标 / 今天还没有运动记录，去走一走吧」。
    数据全部来自 `/api/run/today` 的 `goal.daily.steps`（`applyToday` 已算好 `goalStepsText`/`percent`/`remainSteps`，**不要在 WXML 里重算**）。
  - **7 天环形进度**（`.day-ring`）：外圈是 **conic-gradient 环形进度条**，弧长 = 当日步数 ÷ 每日目标；
    内圈 `.day-ring-inner` 白底（达标日改为橙色渐变底）放小人图标 `assets/home/day-run-{white,orange,gray}.png`（白=达标/橙=有记录/灰=无记录）。
    样式由 `applyWeek` 逐日算好写在 `item.ringStyle` 内联 style 里（**不要在 WXML 里拼 gradient**）；今天用 `outline: 2rpx solid var(--tt-brand)` + `outline-offset: 4rpx` 高亮。
    未来日期给纯灰环（`background: #eef0f3`）；conic-gradient 不支持时退化为灰环，功能不丢失。
- **本周目标**：**步数 / 里程两项并排两列**（`.weekly-cols` 内两个 `.prog-col`，中间 2rpx 分隔线），每列「标签 + `x/y` + 橙色进度条」，
  数据取 `goal.weekly` 与本周（周一起）实际累计，右上角显示周区间（如 `10.12 - 10.18`）。
  紧凑比例：标题 24rpx、数值 19rpx、进度条高 `8rpx`。
- **广告位**：卡片右上角固定「广告」标识（`.ad-flag`，右上 `12rpx`，半透明黑底白字 18rpx，`pointer-events: none`）。
  图片用 `mode="aspectFit"`，**不裁切**；swiper 高度由 `measureAdHeight()` 按图片真实比例换算成 rpx 并写入内联 style
  （可用宽 702rpx = 750 − 卡片左右各 24rpx，限幅 120~420rpx）。`wx.getImageInfo` 失败（如未配置下载域名）时
  保持兜底 `250rpx`，配合 aspectFit 仍能完整显示。
  **圆角与其它卡片一致**：卡片 / swiper / 图片三层都写 `border-radius: var(--tt-radius)`，避免圆角被裁切得不一致。
- **紧凑比例**：整页按约 0.85 比例收紧（插画头 420→350rpx、卡片内边距 30→22rpx、7 天圆点 66→52rpx、
  指标条数字 36→28rpx、入口图标 104→84rpx），如需再缩放，改 `pages/home/home.wxss` 里对应数值即可。
- **快捷入口**：饮水管理 / 目标计划 / 徽章成就 / 身体数据（教师端为 饮水管理 / 身体数据 / 公告 / 管理端）。
  「目标计划」「身体数据」是同一页，用 `?focus=plan|body` 让 `body-data` 页自动滚动到对应区块。

### 插画素材位（可选，放入即生效，无需改代码）
首页在 `onLoad` 用 `wx.getFileSystemManager().accessSync` 探测以下代码包文件，存在则用图片、不存在则回退到 CSS 插画：

| 素材 | 路径 | 建议尺寸 |
|---|---|---|
| 顶部场景图（图内含标题文字） | `miniprogram/assets/home/hero.png` | 宽高比 2.87:1（现用 1500×523），≤ 400KB |
| 入口-饮水管理 | `miniprogram/assets/home/entry-water.png` | 240×240（原图 512×512 压缩后 ~9KB） |
| 入口-目标计划 | `miniprogram/assets/home/entry-plan.png` | 240×240 |
| 入口-徽章成就 | `miniprogram/assets/home/entry-badge.png` | 240×240 |
| 入口-身体数据 | `miniprogram/assets/home/entry-body.png` | 240×240 |
| 7 天圆点小人（**自动生成，勿手改**） | `assets/home/day-run-{gray,orange,white}.png` | 81×81，由 `tools/gen-tabbar-icons.js` 产出 |

路径常量在 `pages/home/home.js` 顶部的 `HERO_IMAGE` / `ENTRY_IMAGES`，目录内另有 `assets/home/README.md` 给设计/运营看。
（注意：不要用 WXSS `background-image` 引用尚不存在的文件，会导致构建报错；统一走上面的运行时探测。
原始大图放仓库根目录 `.design-src/`（已 gitignore，不入包），压缩后再放进 `assets/home/`。）

## 9. 其他页面版式（改版后的统一语言）

统一节奏：**页面顶部留白 16rpx、卡片间距 16rpx、卡片内边距 20~22rpx、数值 30rpx / 标签 20rpx、行内边距 16rpx**。
需要比公共类更紧时，用「公共类 + 页面私有类」复合选择器（如 `.tt-card.day-card { padding: 20rpx 22rpx }`），
**不要在页面里整体重定义 `.tt-*` 公共类**。

- **目标计划 `pages/goal-plan`**：`tt-hero` 当前生效目标（4 列数值）→ **「适合你的计划」** → AI 智能匹配 → **「查看全部计划」默认收起**。
  适合性判定与后端 `services/goals.js::matchPlan` 同维度：`BMI 区间`（`bmiMin <= bmi < bmiMax`）+ `偏好强度`（`preferenceLevel`）+ `性别`（`all` 通用）。
  **只展示匹配的计划**（上限 `MAX_SUITABLE`），其余折进「查看全部计划」；一条都不匹配时回退 `isDefault` 计划并提示原因；
  `gender` 未知时不算排除项，只提示「完善性别可更精准」；`BMI` 缺失时提示去补身体数据。
  注意：计划库里有**同名但不同性别**的计划（如 2 条 `BMI正常·激进版`），去重必须按 `_id`，不能按 `name`。
- **身体数据 `pages/body-data`**：橙色 `tt-hero` BMI 概览（无数据显示灰色「待完善」）→ 关键指标四列 → 编辑表单（性别/身高/体重/强度偏好，斤↔kg 可切换）→ **目标计划只留跳转入口**（数值不在此重复展示）。
  数据读取注意：`GET /api/goal/body-data` 返回的是 `{ bodyData, currentPlan, planName, autoMatched, effective }`，**字段在 `bodyData` 里**，不要按扁平对象读。
- **记录三页 `pages/records/day`｜`records/week`｜`pages/run/detail`**：只有一套语言 —— 概要卡（无独立 hero）+ `.tt-section` 分区 + 30rpx 数值 / 20rpx 标签。
  week 的 7 天为**7 列柱状图**（替代 7 行横条）；detail 主视觉压成窄条（步数 56rpx）、核心数据 4 列（配速并入）、地图 340rpx。
- **我的 `pages/profile`**：5 组 —— 用户卡（`.tt-hero`）→ 学籍信息（**只读，学生不可自改**）→ 累计数据（教师隐藏）→ 运动与健康 → 账号与帮助 → 管理功能（仅 `isAdmin`）→ 退出登录。
  菜单行图标底色统一 `var(--tt-brand-soft)`、图形统一 `var(--tt-brand)`；字号固定 5 级（36/28/26/24/22rpx）；副文案只出现在需要解释的管理行。
  **顶部身份卡是「异形卡」**：本页用 `.tt-hero.id-card` 覆盖公共圆角，做成**盾形拱底**——
  `border-radius: 40rpx 40rpx 50% 50% / 40rpx 40rpx 64rpx 64rpx`（8 值语法：左右下角各展开半个卡宽形成平缓拱形），
  配套 `padding-bottom: 92rpx` 给拱形留出空间；装饰层为「公共 `.tt-hero::after` 实心圆 + 本页 `::before` 细光环 + `.id-sheen` 斜向高光带」，
  内容节点（`.hero-body/.enroll-grid/.enroll-tip`）统一 `position: relative; z-index: 1` 压在装饰层之上。
  学籍信息以两列网格 `.enroll-grid`（半透明白底 + 2rpx 描边）**融在同一张卡内**，不再单独占一张卡片。
  注意：拱底会让卡片左右下角内收，**任何内容都必须留出 ≥ 64rpx 的底部安全距离**，否则会被圆角裁掉。

改完任何页面都要跑 `node tools/check-miniprogram.js`（损坏检测/处理函数/图标/图片/class 定义/标签配平/闸门/主包体积）。
