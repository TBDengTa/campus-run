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
| `.tt-sheet` / `.tt-sheet-grab` / `.tt-sheet-head` / `.tt-sheet-icon` / `.tt-sheet-title` / `.tt-sheet-sub` / `.tt-sheet-close` / `.tt-sheet-body` / `.tt-sheet-foot` | **底部抽屉骨架**：顶部握把 + 品牌色图标胶囊 + 标题/副标题 + 圆形关闭按钮 + 滚动区 + 底部主按钮（用柔性投影代替硬分割线） |
| `.tt-sheet-label` | 抽屉内分组小标题（左侧橙色短竖条，与 `.tt-section` 同语言） |
| `.tt-sheet-item` + `-icon/-main/-title/-desc` + `.active` | 抽屉内**可选项卡片**（图标 + 标题 + 说明 + 右侧圆形勾选），选中态 = 品牌描边 + 品牌浅底 |
| `.tt-sheet-pills` / `.tt-sheet-pill` + `.active` | 抽屉内药丸选项（时长等短选项），选中态为品牌渐变 |
| `.tt-sheet-field` / `.tt-sheet-input` / `.tt-sheet-ph` / `.tt-sheet-note` | 抽屉内输入行 / 占位符 / 说明文字 |
| `.tt-btn-right` | **行内靠右按钮容器**：包住 `t-button` 用（`<view class="tt-btn-right"><t-button size="small"/></view>`）。TDesign 按钮宿主节点在 flex 行里不会收缩，直接放进 `space-between` 行会让按钮停在中途、右侧留出空缺，包一层这个类才能收缩到内容宽度并贴右 |

> **抽屉统一用 `.tt-sheet*`**（不要再在页面里各写一套 `.xx-sheet`）：限制账号功能、权限多选、权限组表单都已改用它。
> 自定义组件里要用这些公共类，必须在组件 json 声明 `"styleIsolation": "apply-shared"`——app.wxss 的 class 默认不进组件内部
> （TDesign 组件也是这么声明的）；参考 `components/ban-sheet`。
>
> **抽屉滚动区必须给「确定高度」**（本仓库已踩过多次：权限组表单、账户编辑权限多选、获得徽章弹窗都中过招）：
> `<scroll-view class="tt-sheet-body">` 只有拿到**确定的 CSS 高度**才真的能滚动。实测（automator 真实视口几何 + `scroll-view.scrollTop` 回读，视口高 834）：
> 只写 `min-height:0`、或 `flex:1 1 auto + min-height:0`，body 会被 `.tt-sheet` 的 `max-height:80vh` 裁住（不再顶出屏幕），
> 但 `scrollTop` 恒为 0（**滚不动**）、底部主按钮仍在屏外；统一写法是
> `.<页面私有sheet类> { display:flex; flex-direction:column; max-height:80vh }` +
> `.<页面私有sheet类> .tt-sheet-body { flex:none; min-height:0; max-height:46vh }`（底部有两个按钮的弹窗用 `42vh`）。
> 用 `max-height` 而非固定 `height`：内容短时自适应、内容长时封顶可滚；只要 `head(61) + body(≤46vh) + foot(101) < 80vh`，主按钮就始终在屏内。
> 已按此写法：`packageAdmin/permissions/groups`（`.pg-sheet`）、`packageAdmin/users/account-edit`（`.ae-sheet`）、`components/badge-award`（`.award-sheet`）；
> 固定高度先例：`class/class`、`content/badges`（徽章组级表单，级别编辑器较长，52vh），`pages/badges`、`pages/hub`、`user-detail`（46vh）。

## 4. 底部导航（自定义 tabBar）

`app.json` 的 `tabBar.custom = true`，实际渲染由组件 `custom-tab-bar/index` 负责：

- **形态**：白色悬浮胶囊（`left/right: 24rpx`、`height: 112rpx`、`border-radius: 999rpx`、柔和大投影），
  **全部为普通导航项，不做中间凸起圆钮**。
- **图标**：用 `t-icon` 矢量图标（选中用 `*-filled` 填充态 + `#ff6b00`，未选中用线性态 + `#9aa0a6`），
  不用位图，便于随主题换色；`assets/tabbar/*.png` 仅作为关闭 custom 时的原生兜底。
- **角色差异**：学生 = 首页 / 跑步 / 记录 / 排行 / 我的；
  教师（有管理权限）= 首页 / **管理** / 我的，其中「管理」指向 **管理中枢** `pages/hub/hub`（分类列出全部管理入口，
  不再直接跳用户管理）；教师（无管理权限但是**班主任**）= 首页 / **班级** / 我的，指向 `packageAdmin/class/class`；
  其余无权限教师 = 首页 / 公告 / 我的。
  教师账号不参与运动记录与排名，故不展示跑步 / 记录 / 排行入口。
- **管理入口按权限、不按角色**（`buildList` 先判权限再判角色）：「有管理权限」= `/api/auth/me` 的
  `effectivePermissions` 非空（含 `'*'` 通配）或 `isManager` 为真 —— **学生身份的管理员同样出现「管理」项**
  （学生 5 项 → 首页 / 跑步 / 记录 / **管理** / 排行 / 我的，插在「记录」与「排行」之间），
  点它 `switchTab` 到 `pages/hub/hub` 并 `setActive('/pages/hub/hub')`；hub 页自己按 `effectivePermissions` 过滤分组。
  学生班委（`isClassOfficer`）仍是在「排行」与「我的」之间插「班级」；普通学生 5 项不变。
- **接入约定**：每个 tab 页在 `onShow` 中调用 `this.getTabBar().setActive('<自身路径>')`
  （页面根节点同时加 `.tt-page-tab`，底部留白 `200rpx + 安全区`，避免内容被悬浮胶囊遮挡）。
- 非 tab 入口（管理端控制台 / 公告）在组件内用 `wx.navigateTo`，tab 页用 `wx.switchTab`。

### 管理中枢 `pages/hub/hub`（**主包 tabBar 页**，教师端「管理」入口）

- **它是 tabBar 页而不是普通跳转页**：`app.json` 的 `tabBar.list` 含 `pages/hub/hub`，教师端自定义 tabBar 的「管理」
  项用 `switchTab` 进入 → **切换导航时底部栏常驻、可随时切回首页/我的**；页面根节点带 `.tt-page-tab`，
  `onShow` 里调 `this.getTabBar().setActive('/pages/hub/hub')` 点亮选中态。学生端的自定义 tabBar 不渲染该项。
- **定位**：把所有管理端入口**按分类**列出来，按 `effectivePermissions` 过滤（`'*'` 全显），
  没有可用权限时给明确空状态而不是空白页。
- **版式**：顶部 `.tt-hero` 身份卡（内容 = 管理中枢 / 角色胶囊 / 姓名·班级·一句说明），
  下面每个分类一组：`.tt-section`（标题 + 右侧说明）+ `.tt-card` 内 `.tt-grid` 宫格（复用 `.tt-chip-icon` + `.tt-grid-text`）。
- **分类**：我的班级 / 用户与权限 / 考核与目标 / 内容与通知 / 广告运营 / 系统设置。
  「我的班级」调 `GET /api/class/mine`，仅班主任或班委显示（无管理权限也能进，对应班主任需求）。
- **进入方式只有两处**（首页「快捷操作」里那枚「管理中枢」宫格已按产品要求移除，避免与底部导航重复）：
  ① 自定义 tabBar 的「管理」项（`switchTab`，按 `effectivePermissions` 渲染，学生管理员同样有）；
  ② 管理端内部的相互跳转（用户详情 / 权限组 / 各中枢子页）。

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

首页自上而下：**插画头 → 公告跑马灯 → 广告位（教师不展示）→ 今日目标 → 本周目标 → 管理面板（数据概览+快捷按钮，有权限时）→ 快捷入口 → 页脚**。

- **插画头**（`.sky`）：两种形态自动切换。
  - **有素材**（`assets/home/hero.jpg` 存在，旧名 `hero.png` 亦可）：`<image mode="widthFix">` 按**图片本身比例**铺满宽度，容器高度自适应
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
  **教师账号无广告**：`GET /api/ads/slot/:key` 对教师角色直接返回空数组（服务端拦截为权威），首页 banner 不渲染、PV/点击不发生。

- **紧凑比例**：整页按约 0.85 比例收紧（插画头 420→350rpx、卡片内边距 30→22rpx、7 天圆点 66→52rpx、
  指标条数字 36→28rpx、入口图标 104→84rpx），如需再缩放，改 `pages/home/home.wxss` 里对应数值即可。
- **快捷入口**：饮水管理 / 目标计划 / 徽章成就 / 身体数据（教师端为 饮水管理 / 身体数据 / 公告）。
  「目标计划」「身体数据」是同一页，用 `?focus=plan|body` 让 `body-data` 页自动滚动到对应区块。
- **管理面板（教师/管理员）**：**数据概览 + 快捷按钮**两段——不展示账户类型与权限数；
  概览 4 格（总用户/今日活跃/今日步数/广告PV），**广告PV 格按 `canViewAds`（ad.view）显隐**，
  服务端 overview 同步按 ad.view 过滤广告字段；无 `dashboard.view` 者只显示快捷按钮（overview 静默失败，不无限转圈）。
  快捷按钮 = 按 `effectivePermissions` 过滤的管理子模块宫格（用户管理 / 申诉审核 / 广告管理 / 内容管理 / 运动考核 / 文件管理 / 系统配置）；
  **不再在末尾追加「管理中枢」宫格**（产品要求：与底部导航的「管理」项重复），进管理中枢统一走底部导航。
  **数据看板独立页已删除**（`packageAdmin/dashboard` 不存在）：教师底部 tab「管理」直达用户管理页，
  首页/我的页内不再有「管理端控制台」按钮。

### 插画素材位（可选，放入即生效，无需改代码）
首页与**「我的」页**都在页面加载时用 `wx.getFileSystemManager().accessSync` 探测以下代码包文件，
存在则用图片、不存在则回退（首页 → CSS 插画；「我的」页 → 原 `t-icon` 矢量图标）：

| 素材 | 路径 | 建议尺寸 |
|---|---|---|
| 顶部场景图（图内含标题文字） | `miniprogram/assets/home/hero.jpg` | 宽高比 2.87:1（现用 1500×523），JPG q85 约 74KB；PNG 命名 `hero.png` 亦可作兜底 |
| 入口-饮水管理 | `miniprogram/assets/home/entry-water.png` | 240×240（原图 512×512 压缩后 ~9KB） |
| 入口-目标计划 | `miniprogram/assets/home/entry-plan.png` | 240×240 |
| 入口-徽章成就 | `miniprogram/assets/home/entry-badge.png` | 240×240 |
| 入口-身体数据 | `miniprogram/assets/home/entry-body.png` | 240×240 |
| 7 天圆点小人（**自动生成，勿手改**） | `assets/home/day-run-{gray,orange,white}.png` | 81×81，由 `tools/gen-tabbar-icons.js` 产出 |
| 我的-身体数据 | `miniprogram/assets/profile/entry-body.png` | 240×240（行内显示 68rpx） |
| 我的-目标计划 | `miniprogram/assets/profile/entry-plan.png` | 240×240 |
| 我的-喝水打卡 | `miniprogram/assets/profile/entry-water.png` | 240×240 |
| 我的-我的徽章 | `miniprogram/assets/profile/entry-badge.png` | 240×240 |

**「我的」页素材位与首页完全同款**：`pages/profile/profile.js` 顶部的 `ENTRY_IMAGES` + `assetExists()` 探测，
WXML 里 `wx:if="{{entryImages.xxx}}"` 用 `<image mode="aspectFit" class="menu-img">`、`wx:else` 回退原 `t-icon`，
图标位尺寸不变（68rpx，见 `profile.wxss` 的 `.menu-icon` / `.menu-img`）。

路径常量在 `pages/home/home.js` 顶部的 `HERO_IMAGE_JPG` / `HERO_IMAGE_PNG` / `ENTRY_IMAGES` 与 `pages/profile/profile.js` 的 `ENTRY_IMAGES`，
目录内另有 `assets/home/README.md`、`assets/profile/README.md` 给设计/运营看。
（注意：不要用 WXSS `background-image` 引用尚不存在的文件，会导致构建报错；统一走上面的运行时探测。
原始大图放仓库根目录 `.design-src/`（已 gitignore，不入包），压缩后再放进 `assets/home/`。）

**大图格式与体积（实测）**：`hero` 这类 1500×523 满幅插画 ——
**JPG q85 + progressive = 74.2KB（采用）** ／ PNG 调色板 256 = 321.1KB（已到 PNG 压缩极限，再压只剩量化降色）／
WebP q80 = 41.4KB（更小，但 `image` 组件 iOS 需 14+，目标环境实测不显示 → **已弃用**，仓库不再存 WebP）。
画质：JPG q85 RMSE 2.49 / PSNR 40.2dB，**优于** PNG 调色板 256 的 3.03 / 38.5dB（JPG q80 更小 64.4KB，但推荐 q85）。
所以 `hero` 只保留 `hero.jpg`；若把 `hero.png` 放回该目录，`resolveHero()` 会自动兜底用它（无需改代码）。
`<image bind:error="onHeroError">` 保留为二次兜底：解码失败就清空 `heroImage` → 回退 CSS 插画。
240×240 的入口小图**统一保持 PNG**：实测这类扁平小图的 WebP 反而比 PNG 大 3%~40%，换格式没有收益。

### 8.1 开屏广告页与卡片广告位

- **开屏页 `pages/splash/splash`**（`app.json` 的**首屏**，`navigationStyle: custom` + `disableScroll`）：
  全屏广告素材（`mode="aspectFill"` 铺满，**启动页广告位 `startup_banner`**，独占位只出权重最高 1 条）+ **左上角倒计时跳过**（`5s 跳过`）
  + 跳过按钮正下方的「广告」标识（半透明黑底白字）+ **底部居中靠下的品牌胶囊**（盾牌图标 `secured` +「唐唐快跑 2.0」+「由 河北唐博科技有限公司 提供技术支持」）。
  - **跳过按钮定位**：与右上角胶囊**同高、垂直对齐**，`top/height` 由 `wx.getMenuButtonBoundingClientRect()` 实测值写入内联 `style`（px），
    取不到胶囊时退回 `statusBarHeight + 4`，都取不到再用 `20 + 4` 兜底 —— **不要用 `env(safe-area-inset-top)`**（模拟器/多数安卓为 0，会把按钮顶进状态栏）。
  - **底部胶囊**：`.splash-foot`（整行 flex 居中 + `bottom: 28rpx + env(safe-area-inset-bottom)`）内套 `.splash-foot-pill`（自适应宽度、`border-radius: 999rpx`、
  `rgba(0,0,0,.42)` 底、文字 `white-space: nowrap`），**不是通栏底条**。
  - 倒计时 **5 秒**（`COUNTDOWN`），到点或点「跳过」→ `wx.switchTab` 首页（失败兜底 `reLaunch`）；进过落地页返回时直接进首页。
  - **绝不阻塞启动**：无素材 / 图片 `binderror`（域名未配置等）/ 接口异常 → 立即进首页；图片迟迟不返回有 2.5s 兜底；
    倒计时**等图片 `bindload` 之后**才开始（避免对着空屏倒数）。
  - 未登录（`getApp().requireLogin()` 为假）不展示开屏，直接走登录页；单页栈非 tabBar 页必须 `wx.hideHomeButton()`。
  - 平台限制：只有**冷启动进首屏**才会看到开屏；分享/扫码直达其它页面时不展示。
  - 开屏素材建议 9:19.5 竖图或两侧留安全边距（`aspectFill` 全屏，9:16 素材在长屏机会裁掉左右约 18%）。
- **卡片广告位（记录页 / 排行榜）**：通用组件 `components/ad-card/ad-card`，页面里一行接入
  `<ad-card slot-key="record_card" refresh-at="{{adRefreshAt}}" />`（页面 `onShow` 里 `setData({ adRefreshAt: Date.now() })` 即刷新）。
  - 位置：记录页在「本周概览」下方、排行榜在「我的排名」卡下方；**无素材时整块不渲染**（不留空卡片）。
  - 视觉与首页一致：右上角 `.ad-card-flag`「广告」标识、`aspectFit` 不裁切、高度按图片比例换算（限幅 120~420rpx）。
  - 曝光/点击上报与首页同一套（`POST /api/ads/:id/pv|click`）；教师账号拿到空数组，整块不出现。
  - 素材解码失败（如老 iOS 不支持 WebP）自动摘掉该条，不留空白卡。
- **流量主广告位（三处 + 通用横幅四处，教师账号一律不可见）**：unit-id 是客户端公开标识，可以进仓库；服务端地址/密钥/AppSecret 绝不进被跟踪文件。
  | 页面 | 形态 | unit-id | 位置 |
  |---|---|---|---|
  | 北斗运动 `pages/reward` | 插屏（JS 实例） | `adunit-773c53ab76db1155` | 无节点：模块级全局单例，**进入页面（首屏数据加载完成后）展示 1 次** |
  | 我的 `pages/profile` | 原生模板（横版 `ad-custom`） | `adunit-eeb7b18e406d94b1` | 「我的信息」卡与「累计数据」卡之间的夹缝（**不在**连点 5 次彩蛋那张卡内部） |
  | 跑步 `pages/run/index` | 原生模板（格子 `ad-custom`） | `adunit-8b909cca0be100b5` | **`.sheet` 之外**：靠右侧的**透明**侧边块（`position: fixed; right: 24rpx`，尺寸两态见 §8.2），`bottom` 由 `measureAd()` 实测锚定在面板上沿之上 → 数据区/按钮零位移 |
  | 徽章 / 目标计划 / 身体数据 / 饮水管理 | 原生模板（横版 `ad-custom`） | 见下方通用横幅表 | 通用组件 `components/ad-banner/ad-banner`，一行接入 |
  - **教师闸门是两道**：`isTeacher` 之外还有 `showAd`（只有确认角色是学生后才置真）——
    首帧 `isTeacher` 还是默认 `false`，只用 `!isTeacher` 会让教师先渲染出广告节点、产生一次曝光。
    角色确认统一走 `app.js::applyAdGate(page)`（在 `await ensureLogin()` 之后调用）：
    优先用内存里已确认的 `globalData.userInfo.role`，拿不到就按需查一次 `/api/auth/me`
    （`this._roleProbe` 缓存，每次启动最多一次）；接口不可用则保持 `showAd: false`（宁可不展示）。
  - **北斗运动页教师「进不去」是刻意的三道拦截**（教师不参与运动记录，本页只对学生开放）：
    ① 入口：我的页「累计数据」连点 5 次（`profile.js::onStatsTap`）判定教师 → 只 toast「教师账号不参与运动记录」，**不 navigateTo**；
    ② 页面 `onLoad`：用本地缓存角色（`auth.getUser().role`）判定 → `blocked=true` 且转出，**首帧不闪内容**；
    ③ 页面 `onShow` / `load()` 接口确认角色后再拦一次（开发者工具直填路径 / 分享链接也进不去）。
    拦截路径下**不创建**激励视频与插屏实例、**不调** `show()`、**不发** `/api/reward-video/*`，提示后 `wx.navigateBack`（无上一页则 `reLaunch` 首页）；
    WXML 用一层 `wx:if="{{!blocked}}"` 整块不渲染（`pages/reward/reward.wxml`）。
  - **插屏节流**（常量在 `pages/reward/reward.js` 头部）：`INTERSTITIAL_SESSION_MAX = 3`（本次运行最多 3 次）、
    **每次进入最多 1 次**（`onShow` 重入不重复弹）、`show()` 失败 catch 静默**且不占额度**；
    计数器是模块级（跨页面重进累计），回调 `onLoad/onError/onClose` 只注册一次。
  - `ad-custom` 容器都给了 `min-height` 占位（我的页 240rpx、跑步页 200rpx、通用横幅 `ad-banner` 200rpx）：
    **官方口径「无广告展示时 `ad-custom` 不占高度」**，
    所以占位高度必须由父容器给，加载中 / 无填充时也占住高度，不发生布局跳动；
    跑步页与 `ad-banner` 还会在 `bindload` 后按实测尺寸收紧（不留「容器比广告大」的空框，见 §8.2）；
    广告由微信模板自绘并自带「广告」标识，页面不再额外加标识。
- **通用流量主横幅 `components/ad-banner/ad-banner`（徽章 / 目标计划 / 身体数据 / 饮水管理 四处）**：
  四个页面共用「占位高度 + 加载后贴合实际尺寸 + 事件只记日志」这一份实现，页面里只放一行
  `<ad-banner unit-id="adunit-…" show-ad="{{showAd}}" />`（json 里注册 `ad-banner`）。
  **位置铁律（产品口径：流量主是收入来源，插在内容末尾 = 没有曝光）**：
  ① **必须首屏可见**：插在页面头部 —— 页面标题 / hero（概览卡）之后、主内容列表或表单之前，
     不滚动就能看到（几何核算见 `node tools/ad-above-fold.js`：逐页给出 top / top+高 / 首屏高 / 余量）；
  ② **不与主操作按钮相邻**：与开始跑步 / 应用此计划 / 保存提交等可点击主操作至少隔 24rpx，
     且不在按钮正上方紧贴（登记类页面的提交路径上不插广告）；
  ③ **不打断关键流程**：跑步页在跑步中 / 结束后不新插横幅；身体数据 / 目标计划不在提交路径上插；
  ④ 教师不渲染（`applyAdGate`）、占位防跳动、失败不影响页面。
  | 页面 | unit-id | 插入位置（首屏） |
  |---|---|---|
  | 徽章 `pages/badges` | `adunit-09dddc560022022c` | 汇总卡之后、3 列矩阵**之前**（矩阵是下一个兄弟节点，不覆盖任何 `.badge-cell`，详情抽屉在更外层） |
  | 目标计划 `pages/goal-plan` | `adunit-431307a81dc3d26a` | 「当前生效目标」hero 之后、AI 智能匹配卡**之前**（与 hero 提示条相隔 24rpx，与 AI 按钮相隔 131rpx） |
  | 身体数据 `pages/body-data` | `adunit-e21e9b1b1c5f690d` | BMI 概览卡 + 关键指标卡之后、**编辑表单之前**（不在提交路径上，与「保存并匹配目标计划」按钮相隔约 512rpx） |
  | 饮水管理 `pages/water/water`（学生端打卡页） | `adunit-d3c555674f1c360c` | **首屏固定视口底部**（`variant="flow-fixed"`）：本页首屏是占满一屏的水瓶舞台，插在舞台之后必然被挤出第一屏，所以用 fixed 贴底 —— 必定可见、不占文档流、不挤压交互区（舞台用 `--wt-ad-h` 让位、`adH` 存在时隐藏「下滑」提示），下滑后被内容自然盖住 |
  | 我的 `pages/profile`（既有横幅，自查） | `adunit-eeb7b18e406d94b1` | 「我的信息」卡与「累计数据」卡之间 → top ≈ 578rpx、余量 468rpx（min 屏），**首屏可见**，无需上移 |
  - **占位高度统一**：`ad-banner.js` 的 `MIN_HEIGHT_RPX = 200`（容器 `min-height`），
    加载中 / 无填充 / 关闭后都占住这 200rpx，不出现大片空白也不跳动；`bindload` 后查一次自己渲染出来的
    真实高度，把容器收紧成实测高度（消掉「容器比广告高」的透明空框），`binderror` 退回占位。
    横幅宽度保持卡片宽 100%（容器自带左右 `var(--tt-gap)` 留白），只收紧高度。
    高度每次变化会 `triggerEvent('height')`，饮水页据此把实测高度写进 `--wt-ad-h`。
  - **教师两道闸门**：`show-ad` 由页面给，页面 `data` 里先写 `isTeacher: false, showAd: false`，
    在 `await getApp().ensureLogin()` 之后调 `getApp().applyAdGate(this)`——
    只有拿到 `userInfo.role` 且不是 `teacher` 才把 `showAd` 置真（角色未知同样 false）。
    首帧 `isTeacher` 默认 false，只用 `!isTeacher` 会让教师先闪出一条广告，所以必须两道。

### 8.2 跑步页格子广告的落位（侧边透明块）

- **形态**：`.run-ad` 在 `.sheet` **之外**，`position: fixed` + `right: 24rpx`（= 面板 `.sheet` 的
  `right: 24rpx` 内沿，与面板右边界对齐），**透明**——
  无背景 / 无阴影 / 无圆角 / 无内边距，只做定位与尺寸占位（广告由微信模板自绘并自带「广告」标识）。
- **尺寸（外层容器决定广告宽高）**：官方口径是「外层容器宽度 = 广告宽度，内部 `ad-custom` 固定 `width:100%`、
  高度按模板等比自适应」，且「**无广告展示时 `ad-custom` 不占高度**」→ 占位高度必须由外层给。
  **两态**（这是「缝隙」的根因与修法）：
  ① 加载前 / 无填充 / `bindclose` 后：兜底宽 `AD_BOX_WIDTH_RPX = 320` + 占位高 `AD_BOX_MIN_HEIGHT_RPX = 200`
  （只改这两个常量即可）——320rpx（375px 机型 ≈ 160px；320px 窄屏 ≈ 150px）＝面板宽 702rpx 的 46%，
  占位高从 260 收到 200，避免无填充时留一大块透明空白；
  ② `bindload` 之后：`fitAdToContent()` 用 `wx.createSelectorQuery()` 量 `.run-ad-ad`（ad-custom）
  实际渲染宽高（px→rpx），把内联 `style` 换成 `width:实测w;height:实测h`（`height` 顶掉 `min-height`）——
  容器边界 = 广告内容边界，**广告右侧 / 下方不再露出「比广告大的透明空框」**；
  宽度量到异常值（< 80 或 > 500rpx）就丢弃、继续用 320rpx 兜底，高度量到 < 20rpx 也丢弃（保留占位）。
- **锚定**：`bottom = 窗口高 − 面板内控制区（`.ctrls`）顶部 + 20rpx`，再用
  `min(winH − 200rpx − 当前广告块高)` 封顶（保证块 `top ≥ 200rpx`，不压顶部状态胶囊；小屏 / 待机态面板较高时
  会把块往下压到面板上沿，最多压住面板顶部约 84rpx 的圆角留白，仍在数据区之上），下限 240rpx。
  由 `pages/run/index.js::measureAd()` 用 `wx.createSelectorQuery` 实测后写进内联 `style`
  （`onReady` / `onResize` / 每次状态切换 `setData` 回调里复测；`fitAdToContent()` 量到新尺寸后再复测一次；
  角色未知或教师时直接跳过）。
  面板是 `bottom` 锚定，面板内元素到屏幕底部的距离与广告无关 → **数据区与按钮位移 0**。
- **为什么不做顶部固定条**：顶部 24rpx 已被状态胶囊 + 定位重试胶囊占用，顶部条会与之打架；
  面板上沿到状态条之间是纯地图区，块放这里**不遮挡**开始按钮 / 数据区 / 地图关键信息。
- **跑步页只有这一条广告**（不在首屏再叠加横幅）：它是 `fixed` 的右侧块，首屏就在屏幕中部偏下
  （`top ≈ winH − 面板高 − 块高`，375×667 机型约 300rpx 处），**不滚动即可见**；
  按「不打断关键流程」的要求，跑步中 / 结束后不会新插横幅。
- 教师账号整块不进 DOM（`.blocked` 分支 + `!isTeacher && showAd`），`adStyle` 保持空且不测量；
  加载失败只 `console.error`，容器仍占位、状态机照常，不影响跑步流程。


## 9. 其他页面版式（改版后的统一语言）

统一节奏：**页面顶部留白 16rpx、卡片间距 16rpx、卡片内边距 20~22rpx、数值 30rpx / 标签 20rpx、行内边距 16rpx**。
需要比公共类更紧时，用「公共类 + 页面私有类」复合选择器（如 `.tt-card.day-card { padding: 20rpx 22rpx }`），
**不要在页面里整体重定义 `.tt-*` 公共类**。

- **目标计划 `pages/goal-plan`**：`tt-hero` 当前生效目标（4 列数值）→ **首屏横幅（ad-banner）** → **「适合你的计划」** → AI 智能匹配 → **「查看全部计划」默认收起**。
  适合性判定与后端 `services/goals.js::matchPlan` 同维度：`BMI 区间`（`bmiMin <= bmi < bmiMax`）+ `偏好强度`（`preferenceLevel`）+ `性别`（`all` 通用）。
  **只展示匹配的计划**（上限 `MAX_SUITABLE`），其余折进「查看全部计划」；一条都不匹配时回退 `isDefault` 计划并提示原因；
  `gender` 未知时不算排除项，只提示「完善性别可更精准」；`BMI` 缺失时提示去补身体数据。
  注意：计划库里有**同名但不同性别**的计划（如 2 条 `BMI正常·激进版`），去重必须按 `_id`，不能按 `name`。
- **身体数据 `pages/body-data`**：橙色 `tt-hero` BMI 概览（无数据显示灰色「待完善」）→ 关键指标四列 → **首屏横幅（ad-banner，在编辑表单之前）** → 编辑表单（性别/身高/体重/强度偏好，斤↔kg 可切换）→ **目标计划只留跳转入口**（数值不在此重复展示）。
  数据读取注意：`GET /api/goal/body-data` 返回的是 `{ bodyData, currentPlan, planName, autoMatched, effective }`，**字段在 `bodyData` 里**，不要按扁平对象读。
- **管理端 · 班级管理 `packageAdmin/class/class`**（班主任 / 班委）：
  顶部身份卡（班级名 + `班主任`/`班委 · 仅查看` 胶囊 + 概况四格）→ 排名卡（班内榜 + 该班在全校班级榜的名次）→
  名单（分页 + 搜索 + 「今日未达标」筛选 + 排序 chips）→ 底部操作。
  **班主任**：可「督促未达标学生」（抽屉列出未达标名单，可复制到剪贴板）；
  **班委**：`canNudge:false`，**不渲染任何操作按钮**，卡片上直接写明「仅查看模式：可查看概况、名单与榜单，不能做任何修改」。
  两种身份同一页面，用 `role/readonly/canNudge` 控制，不要写两个页面。
- **本班数据概况卡 `components/class-board`**（首页用）：概况四格 + 本班前三名 + 全校班级名次 + 管理入口；
  **无班级身份时整块不渲染**（`show:false`，所以学生端首页可无条件放置）；属性 `title/className/showManage/refreshAt`，
  事件 `ready/manage/student/classchange`，方法 `reload()`。组件内用 `app.wxss` 公共类必须声明 `"styleIsolation": "apply-shared"`。
  **多班（班主任被分配多个班）时卡片可左右滑动切换**：用原生 `<swiper>`（`current` + `bindchange`），
  每个班各拉一份 `/api/class/overview` + `/api/class/ranking`（带 `className`），滑动是纯手势切换、不再发请求
  —— 切到哪班就显示哪班的数字，不会出现「卡片换了数字没换」；班级名 / 身份胶囊 / 全校名次 / 「n/N」在 swiper 之外固定不滑，
  卡片底部另有圆点 + `n/N` 指示器（可点选）。swiper 高度由 JS 实测「最高的一张卡」写在内联 style（只往上调，兜底 `min-height`），
  单班时 `multi:false` → **不渲染 swiper、不显示任何滑动控件**（与改造前一致）。
- **跑分：首页/我的/记录/排行统一口径**：数字用 `.num-font` + `--tt-brand`，文案为「今日/本周/累计跑分」；
  首页在「今日目标」卡内用浅色三格（`.today-points`），我的页面用独立卡（`.points-card`）；
  **教师账号不参与跑分**（相关块整体隐藏，不是显示 0）。
  规则文案口径（`pages/profile`、管理端用户详情、`packageAdmin/config/points`）：
  超出**日/周**目标后的加分档位都是「**个人目标 × `extraPercent`% / `weeklyExtraPercent`%（默认各 10）**」
  而不是固定步数，所以文案只能说「每再多达成个人日目标/周目标的 X% 加 M 分」，
  **不要再出现按固定步数分档的说法**（`perStep` 已完全弃用，日、周公式都不再读取；
  管理端「跑分设置」用长标签 + `cfg-fdesc` 说明，日/周各有一块实时预览，
  老配置会显示一张品牌浅底的迁移提示卡 `.cfg-legacy`，日、周各提供「填入 X%（与旧口径一致）」一键操作；
  单周上限 `weeklyExtraCap` 的 **0 = 不封顶**，与单日上限的 0 语义不同，须在说明里写明）。
- **管理端 · 用户管理 `packageAdmin/users/users`**：信息密度按手机端压缩，首屏留给列表。
  顶部 = 搜索（`t-search shape="round"`，80rpx，需一张白底卡托住灰色输入框）＋ 三枚等高 64rpx 工具按钮
  「筛选 / 导入名单 / 创建账户（橙色渐变主按钮）」，**筛选面板默认收起**（`showFilters`），点「筛选」才展开——
  面板内是两行带小标签的分段 **状态（全部/正常/封禁）** 与 **角色（全部/学生/教师）**，
  以及两行 6 个下拉筛选（下拉行高由 `--td-dropdown-menu-height: 76rpx` 压到 76rpx）；
  **「日目标 / 周目标」筛的是「当日 / 当周是否达标」，不是目标步数**（选项固定为 已达标 / 未达标）：
  前端传 `dailyAchieved` / `weeklyAchieved`（`'1'` 达标 / `'0'` 未达标），服务端聚合 `run_records`
  当日步数（周为本周一至今之和）与该用户生效目标（`user_goals` 优先，缺省取 `goal_config` 全局值）比较，
  **不要退回成按 `user_goals.daily.steps` 匹配数值**；注意传空串时要当成「不筛」（服务端只认 `'0'/'1'`）。
  条件生效时「筛选」按钮右上角显示条件数角标，下方另有 `.users-active-bar` 提示当前条件并提供一键清除。
  列表行 = 头像 60rpx + 姓名 28rpx + 学号/日目标 22rpx + 右侧 `chevron-right`，行内边距 16rpx 18rpx。
  **操作路径**：点整行 → 用户详情（`onRowTap`，手机端主路径）；左滑留 3 键「编辑 · 封禁/解封 · 删除」
  （滑出区 3×104rpx，内联样式**必须写 `padding:0`**：TDesign 的 `.t-swipe-cell__content` 自带 `padding:0 32rpx`，
  不清掉每个按钮实际宽 168rpx、三个按钮要滑出 504rpx 才吸附展开，手机上一次很难滑到底。
  颜色为品牌橙 / `--td-error-color-6` / 中性灰，**不要再用蓝色 `#2f7cf6`**）。
  滑动按钮必须用**映射后**的 item（含 `isSuper`）生成：`buildSwipeButtons(u)` 依赖 `u.isSuper`，
  传原始接口对象会让超管也出现「封禁 / 删除」。
  行卡片不使用 `.tt-card`（会被列表外边距二次内缩），改用页面私有 `.user-row`；
  投影写在 `t-swipe-cell` 宿主节点上（写在行上会被宿主 `overflow: hidden` 裁掉）。
  跳转账户编辑页必须写全两级路径 `packageAdmin/users/account-edit/account-edit`（少一级会静默跳转失败）。
- **管理端 · 账户编辑 `packageAdmin/users/account-edit/account-edit`**：
  院校 / 系部 / 专业是**「组织树 ∪ 存量数据」选择器**（关键：两套命名常常对不上——组织树里叫「机电建工系」，
  用户数据里叫「机电系」；只按组织树给选项会出现「专业整行消失、根本选不到」）：
  选项 = 组织树节点（按已选上级收窄）∪ `/api/admin/users/filters` 返回的在用值，**末位固定一项「✎ 手动输入」**；
  `t-picker` 必须绑定 `value="{{index < 0 ? 0 : index}}"`，否则滚轮不落在当前项上；已有值不在选项里时自动切到手填
  （`.ae-switch` 可回到「选已有」）。
  组织树（`/api/org/tree`）与用户数据（`/api/admin/users/:id`）是两个并发请求，**回显必须在两者都就绪后触发**
  （`tryPrefillOrg()` 由两边分别调用），否则选项是空的、选择器点了没内容。
  **年级只读展示、不入表单**：`年级 = 学号前 4 位`（如 `20230101 → 2023级`），前端 `gradeFromStudentId()` 仅用于展示，
  落库由服务端 `roster.gradeFromStudentId()` 在创建/保存时统一推导（存量数据 `grade` 字段普遍为空，务必保留按学号推导的兜底）。
  **班级只读自动识别**：`班级 = 年级（学号前 4 位后两位）+ 专业`，如 `23级大数据技术`；页面只用 `.ae-static` 展示预览，
  **不提交 `className`**，落库由服务端 `roster.classNameFromGradeSpecialty()` 推导（年级或专业缺失时保留原值，
  已存在的更细班名如「23级机电1班」原样保留）——不要在页面里加班级输入框或候选接口。
  **账户类型与权限可在本页直接改**：`role` 用顶部「账户类型」分段（编辑模式同样可改，但需 `permission.manage`：
  保存走 `PUT /:id/permissions`，与详情页同一接口）。
  **权限用「多选抽屉」而不是铺满 chip**：卡片里只留两行摘要（权限组 / 独立权限，右侧 `chevron-right`），
  点击打开 `t-popup`（bottom）+ `t-checkbox-group`（`options=[{label,value}]`、`value=[key]`）：
  权限组一个列表，独立权限按模块分组逐段渲染；勾选逻辑走 `utils/permission-ui.js`
  （`buildModules` / `mergeModuleKeys` / `refreshSelected` / `buildGroupOptions`），模块内勾选变化只合并该模块的 key。
  点保存时先 `PUT /:id/profile` 再 `PUT /:id/permissions`；新建账户则在 `POST /account` 成功后补一次授权；
  `GET /api/admin/permissions` 403 时整块隐藏并提示无权限。
- **管理端 · 权限组管理 `packageAdmin/permissions/groups`**：列表（名称 + 内置标记 + 标识 + 权限数 + 使用账号数 + 权限清单）
  → 「+ 新增权限组」/ 行内「编辑 / 删除」→ 底部抽屉表单（名称、标识、说明 + 按模块的权限多选）。
  内置组显示「系统维护」、不可编辑删除；删除失败（仍被账号使用）时把服务端文案原样提示。
  入口：账户编辑页「账户权限」标题右侧（用户详情页的权限管理区已移除，不再有此入口）。
  接口：`GET/POST /api/admin/permission-groups`、`PUT/DELETE /api/admin/permission-groups/:id`（需 `permission.manage`）。
- **管理端 · 徽章管理 `packageAdmin/content/badges`**：**以「组」为单位管理**（数据形态不变：仍是一枚徽章一条定义）。
  列表 = 等级徽章按 `tierGroup` 聚合成一行（组名 + `等级组 · N 级` + 条件类型 + 级别摘要 `Lv1 7 天 / Lv2 30 天 / Lv3 120 天` + `启用` / `部分停用（n/N 级启用）`），
  独立徽章（`mode==='single'`）各占一行（图标 + 名称 + 阈值 + `独立徽章`）；组按组内 `Lv1` 的 `sort` 参与混排、独立徽章按自身 `sort`（与用户端 `pages/badges` 同规则）。
  行内操作：组 =「编辑整组 / 删除」，独立徽章 =「编辑 / 删除」。
  → 「+ 新增徽章」→ **底部抽屉**（`.tt-sheet*` 公共骨架，与权限组/班级抽屉同款），**顶部药丸切换两种模式**：
  ① **独立徽章**：`key`（编辑态只读）/名称/描述/图标/条件类型/目标值/排序/启用（提交 `mode='single'` 且 `tierGroup` 置空）；
  ② **等级徽章组**：组名 `tierGroup`（新建时自动给可读草稿、可手改、必须唯一；编辑态只读，服务端也拒绝改）+ 全组共用条件类型（9 选 1）+
  组描述 + **级别编辑器**（一行一级：等级名/阈值（带单位提示）/图标/等级色，可增删，**2~8 级**，行序即 `tierLevel`，阈值必须严格递增）+
  排序 + 启用（作用于全组）；保存**整组一次提交**（前端不循环调单条接口）。
  **抽屉 `scroll-view.tt-sheet-body` 必须给确定高度**（本页 `.badge-sheet .tt-sheet-body { flex:none; min-height:0; height:52vh }`）——
  只写 `min-height:0` 不够，权限组那种不写高度的老写法会让表单撑高、确定按钮被顶出屏幕。
  条件类型下拉含 9 项：7 类运动数据 + `points`（跑分达标，全历史累计跑分）/ `rank`（跑分排名前 N，全校跑分总榜名次）。
  接口：`GET/POST /api/admin/content/badges`、`PUT/DELETE /api/admin/content/badges/:id`（单条，向后兼容）
  + `GET /api/admin/content/badges/groups`、`POST /api/admin/content/badges/group`、`PUT/DELETE /api/admin/content/badges/group/:tierGroup`（整组，需 `content.manage`）：
  一次写入整组（按 `tierGroup`+`tierLevel` upsert）、组内 `type` 必须一致、`tierLevel` 从 1 连续且唯一、`target` 随级别严格递增、级别名不重复、组名唯一；
  **删除级别 / 整组时若已有用户获得（`user_badges` 引用该 `badgeKey`）→ 409 拒绝**，不静默删除用户已获得的徽章。
- **管理端 · 用户详情 `packageAdmin/user-detail/user-detail`**：**权限管理区已移除**（角色/权限编辑只在账户编辑页）；
  编辑资料/重置密码/删除按钮按**当前登录者** effectivePermissions（`permission.manage`）显隐，不再调权限接口探测。
  区块顺序：Hero（绑定状态脱敏展示）→ 基本信息 → **考核与目标**（综合日/周达标率大数字 + 达标计数 + 当前目标）→
  运动数据（累计 + 最近运动）→ **运动记录**（日/周 chips 切换，✓=达标）→ **饮水记录**（近 14 天）→ **徽章记录** →
  **登录与绑定**（微信绑定脱敏展示，持 `user.manage` 者可「解绑」：清 openid/wx_sessions 并吊销设备令牌，业务数据保留）→
  当前限制 → 账号操作（封禁/解封、重置密码 `permission.manage`、删除账户）→ 限制/解除流水。
  数据来源：`GET /api/admin/users/:id`（含 loginInfo）+ `GET /api/admin/users/:id/sport-detail`（日/周窗口、全历史达标率、饮水、徽章、生效目标）。
- **管理端 · 分类中枢页**：`config/config`、`content/index`、`assessment/index` 是同一套「分类中枢」语言——
  `.tt-section` 标题（副文案写清生效范围）+ 单张 `.tt-card` 内多行 `tt-row` 分类项
  （`.cfg-cat-icon`/`.ct-cat-icon`/`.am-cat-icon`：72rpx 品牌软底圆角块 + 品牌色图标 + 标题/摘要 + `chevron-right`），
  每行跳独立子页；中枢页与子页都必须有 `checkAndLoad` 权限闸门。
  配置子页（`config/anticheat|reward-video`）共用 `config/section.js` + `@import "config.wxss"`，
  页面用 `sectionKeys` 声明本组键，**保存只回传本组**（服务端按白名单合并，未提供的键不动）。
- **管理端 · 运动考核 `packageAdmin/assessment/*`**：独立模块（首页管理面板入口，权限 `assessment.view`/`assessment.manage`）。
  中枢 2 卡：默认目标（`goals`，全局单例 每日/每周 编辑）与 计划目标（`plans`，BMI 预设计划库 CRUD，
  「列表 + 内联表单 + 确认删除」公告模式；类型/枚举用原生 picker，字段白名单校验在服务端；
  被用户应用中的计划删除会被 409 拦截，提示改停用）。
  **分时段目标（graded）已废弃移除**——前后端均不得再引用。
- **管理端 · 组织架构 `packageAdmin/content/organizations`**：**拍平递归树**——js 把 `/api/org/tree` 拍平成带 `depth` 的节点列表，
  wxml 单层 `wx:for` + `padding-left: depth*36rpx` 内联缩进（**禁止再写死 l1/l2/l3 三层循环**）；
  每节点操作 `+ 下级`（仅学校/院系）/ 编辑 / 删除；表单只有 上级(只读)/名称/排序，
  **类型由服务端按父级推导、前端不选**；删除确认明示递归删除全部下级。
  服务端 `/api/admin/content/organizations` 白名单只收 name/sort(/parentId)，`/api/org/tree` 按 parentId 通用建树。
- **管理端 · 表单弹层**：计划目标 / 组织架构 / 公告管理 / 版本日志 / 权限组 / 徽章管理的「新增/编辑」统一用 **t-popup 底部弹层**
  （`placement="bottom"` + `bind:visible-change` 同步状态，`.{xx}-sheet` = 头部标题/关闭 + `scroll-view` 表单（max-height 62vh）+
  底部保存按钮（含 safe-area），样式先例 `permissions/groups` 的 `.pg-sheet`）。列表页内不再放内联表单卡。
- **管理端 · 文件管理 `packageAdmin/files/files`**：统计卡（总数/占用 + 四分类计数）→ 分类 chips（`.tt-chip`，active 品牌态）
  → 3 列缩略图网格（`aspectFill` + 名称/大小/日期，右上角悬浮删除钮 `catch:tap`），点图 `wx.previewImage`；
  右下角品牌色 FAB 上传；分页 `onReachBottom`。权限 `file.view`（删除/上传需 `file.manage`）。
- **记录三页 `pages/records/day`｜`records/week`｜`pages/run/detail`**：只有一套语言 —— 概要卡（无独立 hero）+ `.tt-section` 分区 + 30rpx 数值 / 20rpx 标签。
  week 的 7 天为**7 列柱状图**（替代 7 行横条）；detail 主视觉压成窄条（步数 56rpx）、核心数据 4 列（配速并入）、地图 340rpx。
- **跑步 `pages/run/index`**：保存成功（`POST /api/run/gps` 返回 `record` + `newBadges`）时，
  **有 `newBadges` 就先弹 `components/badge-award` 带图弹窗**（与首页 `pages/home` 同一个组件、同一份用法），
  不再把徽章名拼进 `wx.showModal`；关掉弹窗后接回原来的「已保存」框（文案只留 `里程 · 时长`，保留「查看记录」入口）。
  没有新徽章 / 教师账号 / 本次会话已弹过 → 直接走「已保存」框；点「查看我的徽章」跳徽章页，不再追加「已保存」框。
  会话去重与首页共用 `app.globalData.badgePopupShown`。
- **我的 `pages/profile`**：5 组 —— 用户卡（`.tt-hero`）→ 学籍信息（**只读，学生不可自改**）→ 累计数据（教师隐藏）→ 运动与健康 → 账号与帮助 → 退出登录。
  **「管理功能 → 用户权限管理」入口已移除**（产品要求）：管理相关入口只保留「管理中枢」`pages/hub/hub`
  （底部导航「管理」项）与管理端用户详情页里的权限编辑，`profile.js` 不再有 `goPerms` 与相关字段。
  头像选择后**先上传服务器**（`POST /api/upload/avatar`，限 2MB，旧头像自动清理）再保存资料——微信临时路径其他设备不可见，禁止直接把 `e.detail.avatarUrl` 存进 `User.avatarUrl`。
  菜单行图标底色统一 `var(--tt-brand-soft)`、图形统一 `var(--tt-brand)`；字号固定 5 级（36/28/26/24/22rpx）；副文案只出现在需要解释的行（如「身体数据 / 目标计划」）。
  **顶部身份卡是「异形卡」**：本页用 `.tt-hero.id-card` 覆盖公共圆角，做成**盾形拱底**——
  `border-radius: 40rpx 40rpx 50% 50% / 40rpx 40rpx 64rpx 64rpx`（8 值语法：左右下角各展开半个卡宽形成平缓拱形），
  配套 `padding-bottom: 92rpx` 给拱形留出空间；装饰层为「公共 `.tt-hero::after` 实心圆 + 本页 `::before` 细光环 + `.id-sheen` 斜向高光带」，
  内容节点（`.hero-body/.enroll-grid/.enroll-tip`）统一 `position: relative; z-index: 1` 压在装饰层之上。
  学籍信息以两列网格 `.enroll-grid`（半透明白底 + 2rpx 描边）**融在同一张卡内**，不再单独占一张卡片。
  注意：拱底会让卡片左右下角内收，**任何内容都必须留出 ≥ 64rpx 的底部安全距离**，否则会被圆角裁掉。

改完任何页面都要跑 `node tools/check-miniprogram.js`（损坏检测/处理函数/图标/图片/class 定义/标签配平/闸门/主包体积）。
