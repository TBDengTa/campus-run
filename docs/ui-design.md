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

## 4. 底部导航（自定义 tabBar）

`app.json` 的 `tabBar.custom = true`，实际渲染由组件 `custom-tab-bar/index` 负责：

- **形态**：白色悬浮胶囊（`left/right: 24rpx`、`height: 116rpx`、`border-radius: 999rpx`、柔和大投影），
  学生端中间项为**凸起的橙色渐变圆钮**（`104rpx`、`linear-gradient(135deg,#ff9a3d,#ff6b00)` + 橙色投影 + `6rpx` 白描边）。
- **图标**：用 `t-icon` 矢量图标（选中用 `*-filled` 填充态 + `#ff6b00`，未选中用线性态 + `#9aa0a6`），
  不用位图，便于随主题换色；`assets/tabbar/*.png` 仅作为关闭 custom 时的原生兜底。
- **角色差异**：学生 = 首页 / 跑步 / 记录 / 排行 / 我的（中间凸起圆钮）；
  教师（有管理权限）= 首页 / 管理 / 我的；教师（无管理权限）= 首页 / 公告 / 我的。
  **教师端三项均为普通导航项，不做凸起圆钮**（只给学生端「跑步」标记 `center: true`）。
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

- **插画头**（`.sky`，高 `350rpx`）：天空渐变 + 圆角云朵 + 双层椭圆草地（地平线）+ 虚线椭圆跑道 + 白色标题（四向蓝描边阴影）与标语。
  标题区 `padding-top: 74rpx`，跑道 `bottom: 38rpx`（避免被悬浮公告条压住），公告条用 `margin-top: -28rpx` 叠在草地上。
- **公告跑马灯**：`.notice-viewport`（`overflow: hidden` 定高）+ `.notice-track`（两份文案 + `translateX(-50%)` 无限循环动画）。
  文案 ≤ 14 字不滚动（只渲染一份、不加 `.run`）；超过则 `animation-duration = max(10, 字数 × 0.5)` 秒。
  文案取自 `/api/content/announcements` 的第一条。
- **今日目标**：标题 + 计划名胶囊（点进身体数据/目标计划）+ 「同步」胶囊（微信运动同步入口），
  下面是**本周 7 天圆点**（达标=橙色渐变+勾、有记录=橙色描边+橙点、无记录=灰底+「—」、今天=橙色描边）与**橙色四项指标条**（步数/公里/时长/卡路里，橙色渐变 + 白色分隔线）。
- **本周目标**：`步数 x/y`、`里程 x/y km` 两条橙色进度条，数据取 `goal.weekly` 与本周（周一起）实际累计。
- **紧凑比例**：整页按约 0.85 比例收紧（插画头 420→350rpx、卡片内边距 30→22rpx、7 天圆点 66→52rpx、
  指标条数字 36→28rpx、入口图标 104→84rpx、广告位 250→210rpx），如需再缩放，改 `pages/home/home.wxss` 里对应数值即可。
- **快捷入口**：饮水管理 / 目标计划 / 徽章成就 / 身体数据（教师端为 饮水管理 / 身体数据 / 公告 / 管理端）。
  「目标计划」「身体数据」是同一页，用 `?focus=plan|body` 让 `body-data` 页自动滚动到对应区块。

### 插画素材位（可选，放入即生效，无需改代码）

首页在 `onLoad` 用 `wx.getFileSystemManager().accessSync` 探测以下代码包文件，存在则用图片、不存在则回退到 CSS 插画：

| 素材 | 路径 | 建议尺寸 |
|---|---|---|
| 顶部人物场景图 | `miniprogram/assets/home/hero.png` | 750×350 以上，底部自带草地 |
| 入口-饮水管理 | `miniprogram/assets/home/entry-water.png` | 120×120 |
| 入口-目标计划 | `miniprogram/assets/home/entry-plan.png` | 120×120 |
| 入口-徽章成就 | `miniprogram/assets/home/entry-badge.png` | 120×120 |
| 入口-身体数据 | `miniprogram/assets/home/entry-body.png` | 120×120 |

路径常量在 `pages/home/home.js` 顶部的 `HERO_IMAGE` / `ENTRY_IMAGES`，目录内另有 `assets/home/README.md` 给设计/运营看。
（注意：不要用 WXSS `background-image` 引用尚不存在的文件，会导致构建报错；统一走上面的运行时探测。）
