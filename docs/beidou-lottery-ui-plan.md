# 北斗运动抽奖页 · 紧凑化 + 播报 + 动效 + 音效 改造方案

> **状态：S1–S7 已实施（2026-11-12）；2026-11-13 按用户截图再修一轮版式与音效，见 §12**
> 版式/音效的易回退点已写入 `AGENTS.md`「抽奖页 UI」与 `check-beidou-lottery` 第 [1b] 节。
> 前置阅读：`docs/beidou-lottery-plan.md`（玩法与口径，本次**不改玩法**）、`docs/ui-design.md`（白橙设计系统）、`AGENTS.md`「北斗运动 2.0」。

## 0. 一句话目标

把现在「一屏放不下、信息平铺、抽完没反馈」的抽奖页，改成**拼多多式的紧凑活动页**：
首屏就能看到转盘和次数、持续滚动的中奖播报、抽中稀有奖有爆款动效和音效。

## 1. 现状盘点（改之前的事实）

| 项 | 现状 | 问题 |
|---|---|---|
| 页面高度 | hero 卡 1 屏 + 620rpx 转盘 + 签到卡 + 任务卡 + 已入账 + 最近中奖 + 规则 4 行 | 手机上要滑 3~4 屏才看得完，转盘和次数还不在同一屏 |
| 转盘 | 620rpx，`conic-gradient` 画 8 格 | 占屏大；`conic-gradient` 在部分安卓机型渲染异常（见 §9） |
| 中奖反馈 | 转盘停下后底部出现一张「抽到 100 步」卡 | **几乎没有爽感**：无音效、无震动、无高亮、无弹窗 |
| 最近中奖 | 只展示**自己**的 5 条，且时间列**恒为空** | `reward.wxml` 引用 `item.atText`，但 `services/beidou.js` 只下发 `at`（Date 对象）→ bug |
| 播报 | 无 | 用户要的「陈** 刚获得…」完全没有 |
| 音效 | 无（仓库 `miniprogram/assets/` 下**没有任何 mp3/wav**） | 全仓只用了 3 处 `wx.vibrateShort`，没有一处音频 |
| 主包体积 | **3.10 MB**（上限 2 MB，已超 1.1 MB） | **不能往主包加音频文件**，这条决定了音效方案 |

## 2. 设计目标与硬约束

**三个目标**：① 紧凑 —— 转盘 + 剩余次数 + 抽奖按钮在**同一屏**；② 炫 —— 中奖有爆点；③ 真 —— 播报是真实数据，不是假名字。

**四条硬约束**（不满足就不做）：
1. **不加任何二进制资源**（主包已超限 1.1MB）。音效必须**代码生成**，不能放 mp3。
2. **播报必须是真数据**，脱敏到「陈**」这一级，**绝不展示学号/班级/完整姓名**。
3. **不能因为炫酷拖慢首屏**：所有动效用 CSS，不用 canvas 粒子（低端机掉帧）。
4. **弱网/无音效/系统静音都要能用**：动效与音效全部可降级，失败静默。

## 3. 新版页面结构（紧凑排版）

从 4 屏压到 **2 屏内**，关键动作全部落在第一屏。

```
┌─────────────────────────────────────────┐
│ ←  北斗运动          [每日0点重置]       │  ← 原生导航（不变）
├─────────────────────────────────────────┤
│ 🎉 陈** 刚抽中「1500 步」· 稀有    ↑滚动 │  ← 新增：播报条（36 字高，常驻）
├─────────────────────────────────────────┤
│        剩余 3 次   ·   今日已得 900 步   │  ← 次数收进转盘上方一条，不再单独占卡
│  ┌───────────────────────────────┐      │
│  │            ▼ 指针             │      │
│  │      ╱╲  8 格转盘   ╱╲        │      │  ← 转盘 520rpx（原 620）
│  │     │    [抽奖]    │          │      │     中心即按钮，去掉下方重复主按钮
│  │      ╲╱            ╲╱         │      │
│  └───────────────────────────────┘      │
│   今日步数奖励还剩 2100 步额度           │  ← 封顶提示保留（抽中空奖**之前**能看到）
├─────────────────────────────────────────┤
│ 签到 ①②③④⑤⑥⑦   [签到]                │  ← 7 格压成一行横条（原整卡）
├─────────────────────────────────────────┤
│ [▶ 看视频 +1次]  [👥 邀请 +1次]           │  ← 两个任务并排（原竖排两行）
├─────────────────────────────────────────┤
│ 今日已入账  900 步 · 630m · 36千卡 · 07:30│  ← 四宫格压成一行文字
├─────────────────────────────────────────┤
│ 最近中奖（我的）                          │
│ · 1500 步  10:24:11                      │
│ · …                                       │
├─────────────────────────────────────────┤
│ 规则说明 ▾（默认折叠）                    │  ← 规则折叠，点开才展开（含概率公示）
└─────────────────────────────────────────┘
```

**具体尺寸改动**：转盘 620→**520rpx**；hero 卡取消（次数并到转盘上方一行）；签到卡→**76rpx 高的横条**；任务卡→**两个并排胶囊**；已入账四宫格→**一行文字**；规则默认折叠。

> 折叠规则**不违反口径**：概率公示是合规必需，但「默认折叠 + 标题写明『中奖概率』」仍然可见可展开。**加一行小字把最低/最高概率直接写出来**，不必展开也能看到关键信息（见 §4.3）。

## 4. 中奖播报（用户的核心诉求）

### 4.1 「陈**」怎么来

仓库里**已有**脱敏实现，复用它，不要另写一套：

```js
// server/src/routes/ranking.js::maskName  —— 已有
name.slice(0, 1) + '**'   // 陈宇航 → 陈**
```

播报只下发**脱敏后的字符串**，完整姓名**永不出服务端**。这条要在检查器里钉死（反向断言：接口响应里不含未脱敏姓名）。

### 4.2 播报数据从哪来（新增接口）

```http
GET /api/beidou/winners?limit=20
→ { items: [
      { nameMasked: '陈**', prizeLabel: '1500 步', prizeKey: 'steps_1500',
        rarity: 'rarest', percent: 2, at: '2026-11-12T02:24:11.000Z' }
   ], rarityText }
```

- 数据源：`beidou_draws` 最近 N 条（**只取 `type !== 'none'`**，谢谢参与不播报——播报空奖等于劝退）。
- **`rarity` 由服务端算**：`percent <= 该奖池最小 percent + ε` → `rarest`；`percent < 10` → `rare`；否则 `normal`。
  前端**不自己算稀有度**（与「概率公示由服务端算」同一条纪律）。
- 一个用户连续中奖时**去重合并**，避免刷屏（同一 openid 最多占 2 条）。

### 4.3 「中奖概率最小的奖项」怎么表达

页面顶部/播报条文案：`陈** 刚抽中「1500 步」· 稀有`

规则区（未展开时也有）提示一句：
> 最低概率奖：1500 步 2% · 最高：谢谢参与 38%

`minPercent / maxPercent` 由服务端在 `/today` 里一并下发（已有 `prizes[].percent`，只是取 min/max）。

### 4.4 ⚠️ 隐私口径（**需要你拍板**，见 §10 Q1）

播报别人的中奖记录属于「公开面」。仓库里 `privacy.hideName` 目前**只作用于排行榜**（AGENTS.md 明确）。
我的建议：**播报一律显示脱敏名，且 `privacy.exitRanking = true`（不参与排名）的学生不进播报**——
理由是这类学生表达过「不想被公开」，把他放进滚动播报与「不参与排名」自相矛盾。

代价：播报池会小一点，夜间可能没内容（要有空态，见下）。

### 4.5 播报条动效

- **竖向轮播**：每 3 秒上滚一条，CSS `@keyframes` + `transform: translateY`，**只动 transform**（不动 height/top，避免重排）。
- 新数据（自己刚中奖）**插到最前面并高亮一次**：背景扫光一次 + 左侧 🎉 弹一下。
- **空态**：接口失败或数据为空 → 播报条显示「今天还没人抽中，来抢第一个」，**不留白条**。

## 5. 抽中后的动效（拼多多式爆点）

分三档，**按稀有度给不同强度的反馈**（全都中奖等于全都平淡）：

| 档位 | 触发 | 动效 | 时长 |
|---|---|---|---|
| **普通**（谢谢参与 / 100 步） | `rarity: normal` | 转盘停位 + 数字弹一下 + 轻震动 | 0.4s |
| **稀有**（≤10%） | `rarity: rare` | + 全屏暖色径向光晕扩散 + 奖品卡从下弹入 + 中等震动 + 音效 | 1.2s |
| **最稀有**（最小概率奖） | `rarity: rarest` | + **金色描边闪光** + 彩带横飞（CSS 伪元素 8 片）+ **连震两下** + 专属音效 + 底部横幅「🎊 恭喜抽中稀有奖」 | 2.0s |

**为什么用 CSS 不用 canvas**：canvas 粒子在中低端安卓上抽奖瞬间掉帧最明显（正是最需要的时刻）。CSS `transform/opacity` 走合成层，稳得多。彩带用 8~12 个绝对定位的 `<view>` + 错开的 `animation-delay`，代码量小、零依赖。

**必须有的收尾**：动效期间按钮禁用（`spinning` 已有），动效结束**自动恢复**；动效中途离开页面要能安全终止（`onUnload` 清 timer，复用现有 `_spinTimer` 模式）。

## 6. 音效方案（零二进制资源，代码生成）

**核心难点**：仓库里没有音频，主包又超限 1.1MB，**不能加 mp3**。

**方案：运行时合成 WAV → 写入用户目录 → 用 `InnerAudioContext` 播放**。

```js
// utils/sfx.js（新增，约 90 行）
// 1) 合成：生成 16bit PCM WAV 字节（纯 JS，无依赖）
//    中奖音 = 三个音符上行扫（C-E-G，每音 90ms，带淡出包络）
//    稀有音 = 加一个高八度尾音
// 2) 落地：wx.getFileSystemManager().writeFileSync(`${wx.env.USER_DATA_PATH}/bd_win.wav`, buf)
//    只写一次（存在性判断），之后复用路径
// 3) 播放：wx.createInnerAudioContext()，模块级单例，play() 前 setVolume
```

**五条必须做到**：
1. **首次播放必须在用户手势内**（点抽奖那一 tick 初始化一次音频上下文）。iOS 上不在手势里创建的音频可能永久静音。
2. **失败一律静默**：`writeFile` 失败、`InnerAudioContext` 不可用、播放报错 → 只 `console.warn`，**绝不影响抽奖与入账**。音效是锦上添花，不能成为新故障点。
3. **遵守系统静音**：`InnerAudioContext.obeyMuteSwitch = true`（iOS 侧边静音键按下就不响）。
4. **管理端开关**：`goal_config.beidou.sfxEnabled`（默认开），学生端记住「上次是否静音」到 storage，页面右上角给一个小喇叭图标可一键关（**很多人在地铁上打开**）。
5. **震动分级**：普通 `vibrateShort({type:'light'})`、稀有 `medium`、最稀有 `heavy` 两连。`wx.vibrateShort` 已在本仓多处使用（`profile.js` / `water.js` / `goal-plan.js`），口径一致；调用前判存在性。

> **备选（若你不想做代码合成）**：只做震动 + 视觉动效，完全不要音效。这样最省事、零风险，但「拼多多感」会少一半。见 §10 Q2。

## 7. 服务端改动清单（很小）

| 文件 | 改动 |
|---|---|
| `services/beidou.js` | ① `recent` 补 `atText`（**修现有 bug**）+ `prizeLabel`；② 新增 `winnersFeed()`（脱敏 + 稀有度 + 去重 + 过滤 `exitRanking`）；③ `todayState` 增加 `minPercent/maxPercent` |
| `routes/beidou.js` | 新增 `GET /api/beidou/winners`（登录即可读，教师也不拦 —— 教师进不来页面，但接口不该 403 白屏） |
| `models/goal-config.js` | 新增 `beidou.sfxEnabled`（布尔，默认 true） |
| `routes/admin/config.js` | 无需改（`normalizeBeidouInput` 加一个布尔键即可） |

**玩法零改动**：抽奖概率、封顶、幂等、签到、`drawId` 全部不动。这是纯展示层改造 + 一个只读播报接口。

## 8. 性能与降级

| 场景 | 降级方式 |
|---|---|
| 系统「减少动画」/低端机 | CSS 动效已在 `prefers-reduced-motion` 之外；用 `wx.getSystemInfoSync().benchmarkLevel < 10` 时**跳过彩带与光晕**，只留弹卡 |
| 音频不可用 | 静默跳过，`sfxEnabled` 自动置 false 并记 storage，不再重试 |
| 播报接口失败 | 播报条显示空态文案，不重试（下一次 onShow 再拉） |
| `conic-gradient` 渲染异常（部分安卓） | 见 §9，改为 **8 个 `clip-path` 扇区**（可以提前做） |
| 弱网抽奖 | 已有：`drawId` 幂等 + 按钮禁用，不改 |

**首屏请求数不变**：`/api/beidou/today`（已存在）+ `/api/beidou/winners`（新增 1 个 GET，可与 today **并行**发，不串行等待）。

## 9. 顺带要修的两个既有问题

1. **`atText` 恒空**（§1）：`recent` 只有 `at: Date`，WXML 却渲染 `item.atText` → 最近中奖时间列永远空白。这次一并修。
2. **`conic-gradient` 兼容风险**：安卓部分机型/低版本 WebView 不支持，转盘会渲染成纯色（用户看到的「转盘没格子」）。建议本次**直接换成 8 个 `clip-path: polygon()` 扇区**，一劳永逸；顺带让每个扇区可以单独加 hover/高亮（停位那格闪一下），这正是「炫」需要的能力。

## 10. 需要你拍板（4 个问题）

| # | 问题 | 选项 |
|---|---|---|
| **Q1** | 播报里能不能出现**别人**的名字（脱敏后）？ | A 可以，脱敏为「陈**」，且 `exitRanking` 学生不进播报（建议）<br>B 只播报我自己（安全，但「拼多多感」基本没了）<br>C 可以，但**不打码显示完整姓名**（公开同学中奖，有隐私争议） |
| **Q2** | 音效怎么做？ | A 代码合成 WAV（零资源文件，有真实音效）（建议）<br>B 只做震动 + 视觉动效，不要音效<br>C 你提供 mp3 文件，我接进去（但主包已超限，得先解决分包） |
| **Q3** | 中奖播报要不要**自己也能立刻看到自己被播报**？ | A 要，自己中奖时播报条置顶高亮一次（建议）<br>B 不要，避免「自己夸自己」 |
| **Q4** | 「最稀有奖」的判定口径 | A 该奖池 `percent` 最小且 **≤10%** 才算（建议，避免奖池很平时全员「最稀有」）<br>B 只要是奖池里最小的就算 |

## 11. 实施顺序（你确认后我按这个做）

| 阶段 | 内容 | 可独立验收 |
|---|---|---|
| S1 | 服务端：修 `atText` + `winnersFeed` + `minPercent/maxPercent` + `sfxEnabled` + 新路由 | `verify-beidou-lottery.js` 加一节 |
| S2 | 转盘改 `clip-path` 8 扇区（去掉 `conic-gradient`） | 真机看格子是否正常 |
| S3 | 紧凑排版（转盘 520、次数并排、签到横条、任务并排、规则折叠） | 一屏能看全 |
| S4 | 播报条（竖向滚动 + 空态 + 自己置顶高亮） | 真空数据可见 |
| S5 | 中奖三档动效（弹卡 / 光晕 / 彩带 / 金边） | 抽到各档都能看到 |
| S6 | `utils/sfx.js` 音效 + 喇叭开关 + 震动分级 | 真机听得到、静音键有效 |
| S7 | 回归：`check-page-runtime`（加播报与动效用例）+ `check-beidou-lottery`（补脱敏/稀有度断言）+ 全量 | 全绿 |

**关于 S7 的检查器**：这次的新逻辑（脱敏、稀有度、播报去重、音效降级）**都是静态检查抓不到的**。
我会在 `tools/check-page-runtime.js` 里加用例：① `applyState` 带播报数据不抛；② 三档动效方法都被调用且不重复触发；③ 音效不可用时抽奖仍成功入账。
服务端侧加**反向断言**：`/api/beidou/winners` 响应里**不含**任何未脱敏的完整姓名。

## 12. 2026-11-13 第二轮（按用户截图修版式 + 让音效真的响）

用户截图暴露的四件事，逐条对应改法：

| 截图现象 | 真因 | 改法 |
|---|---|---|
| 「王** 刚抽中 100步」与「0 次可抽 · 今日已得 100 步」两行字重在一起 | `.bd-count` 是 `position:absolute; top:-52rpx`，被绝对定位到转盘上方，正好压在播报条上 | 改成 `.bd-stat` **正常文档流**一行（它本来就在盘上方，绝对定位零收益） |
| 转盘里的「100步」歪着/倒着写 | **三层原因**：① 文字放在被 `clip-path` 裁开的扇形里 → 被楔形边缘**切掉一截**；② 文字切向排布 → 8 个格子的字落在 8 个不同角度上；③ 盘面停下时转了 `360−(i*45+22.5)`（如第 1 格是 292.5°）→ 水平文字跟着整体歪 **22.5°~90°** | ① 文字**独立成层**（`.bd-label`，不参与裁剪）；② 改成**径向**单行文字（`textDeg=±90`，下半圈翻 180° 避免倒读）；③ 径向是**旋转对称**的，盘面停在任何角度都整齐 |
| 指针歪着停在某个角度，看着像坏了 | 上一版为了保住水平文字，让**指针转、盘面不转** | 改回**指针固定在 12 点、盘面旋转**（用户对「转盘」的默认预期）；文字用径向，所以盘面转起来也不乱 |
| 中奖特效「不到 1 秒就没了，什么都没看见」 | `FX_MS.normal = 420` —— 还没看清就自动关了 | `normal 2200 / rare 3000 / rarest 4200`，并且随时可点「收下」或点遮罩立刻关 |
| 签到只显示一个「大」字 | 格子里写的是 `item.big ? '大' : ''`（表示第 3/7 天是大奖），**奖励内容一个字都没有** | 每格三行：第几天 / `+N次` / `+N步`（无步数则第三行不出现），大档改用描边样式强调 |
| 中心「没次数」灰色死按钮 | 文案写死，点了没反应 | `buildCenterState()` 三态 → 没次数时显示「赚次数 / 去做任务」，点 `tapCenter` 滚到任务区 |
| 没有音效 | ① 管理端 `sfxEnabled` 只进 data 从没被读（假开关）；② iOS 上 3.2 秒后才 `play()` 会被静默拦掉 | ① 播放前判 `sfxEnabled`；② 点抽奖那一 tick 先播极短 `spin`「哒」（既是即时反馈，也是解锁音频的唯一可靠时机）；③ `sfx.reset()` 给手动重开一次机会 |

顺带补回与加固：

- **我的最近中奖**（服务端 `/today` 早就下发 `recent`，但 WXML 从未渲染 —— 这就是「缺失内容」之一）：奖品名 + 稀有度 + 封顶 + 时间。
- **今日签到可得**：横条下面一行「今日签到可得 +2次 +200步」，不用点也能知道值不值。
- **中心内圈白环 + 旋转中盘面发光 + 弹层光晕**：盘面层次拉开，`is-spinning` 有明确视觉反馈。
- **三档 tint 明度拉开**（截图里盘面整片发白）：步数暖橙 / 再来一次金 / 谢谢参与冷灰。
- **弹层可点遮罩收起**（`closeFx`），卡片内 `catch:tap` 防误关。
- **失败路径 `restoreCenter()`**：早先只写 `spinning:false`，接口一失败按钮就永远停在「抽奖中」。

回归：`check-page-runtime` 新增 18 条（文字层与扇形分离、`textDeg = -midDeg` 平行断言、中心三态、点中心不发请求、
签到每格写清奖励、recent 渲染、closeFx、`sfxEnabled` 关闭时动效照给）；
`check-beidou-lottery` 新增第 [1b] 节 9 条防回退断言。两处都做过变异测试（还原旧写法分别报 1 / 3 条失败）。

### 转盘文字的几何口径（改之前先算一遍）

**指针固定、盘面旋转**是这套版式的前提。文字必须**径向**（`textDeg` 恒为 ±90）：
径向关于圆心旋转对称，盘面停在任何角度看起来都一致；水平文字则会被整体带歪 22.5°~90°。
判据只看一个量：**绝对旋转 = `midDeg + textDeg` 不能落在 90°~270°**（那是倒着读），
所以 `midDeg ∈ (180,360)` 时 `textDeg` 取 +90（改朝中心读），其余取 −90（朝外读）。
`rotateDeg` 只绑 `.bd-wheel` 的 `transform`；指针固定不转，它的 tick 动画只动自己。

转盘 520rpx（R=260），文字层圆心在 **r=158**，块宽 **108rpx**、高约 48rpx：
- 相邻标签中心弦长 `2×158×sin22.5° ≈ 121rpx` > 108 → 不会互相压字；
- 标签横向半宽对应角度 `arcsin(54/158) ≈ 20°` < 22.5°（半格）→ 不会跨过楔形分隔线；
- 最近角点半径 `≈144rpx` > 内圈白环 107rpx，最远角点 `≈190rpx` < R → 不出盘、不被内圈盖住。

改半径/字号/宽度前先按这三条重算，否则会重新出现「字被切 / 字挤在一起」。

### 装饰层 + 拼多多式中奖 FX v2（2026-11-22 重美化）

**装饰层不改 §12 几何**：外圈铜环 + 16 颗灯珠、钱包产出进度条、玩法切换 thumb、签到/任务/播报美化
全部是盘外视觉，转盘 520rpx、楔形顶点 `50% 50%`、文字径向 `textDeg ±90`、指针固定 12 点、
停位角 `360−(i*45+22.5)` **逐字未动**（回归仍按上面三条几何口径断言）。灯珠用
`rotate(deg) translateY(-278rpx)`（与 `.bd-label` 同定位手法），`rimLights` 用 `{deg:i*22.5}` 确定性生成。

**FX 三档（全部 CSS transform/opacity，禁 canvas 粒子）**：

| 组成 | normal（含 none 的卡） | rare | rarest |
|---|---|---|---|
| 放射光芒 `.bd-rays` | — | — | 16 条窄条三角光带（四暖色轮换，clip-path 顶点在圆心，避安卓 conic-gradient）旋转 14s + 入场 burst |
| 金币雨 `.bd-coin` | 5 | 8 | 14 枚（远程 `coin.iconUrl`，断网回退 CSS 铜币+「铜」字） |
| confetti | 10 中爆发 | 14 大爆发 | 20 片（8 色 × 3 形状 × 8 方向两段式爆发，v3.2） |
| 星光 / 闪光 / 光环 | 4 / 小 / 1 | 6 / 中 / 2 | 8 / 大 / 3（v3.2） |
| 震屏（挂 .bd-fx 自身） | sm | md | lg（v4） |
| 卡片入场 | bd-card-pop-sm | bd-card-pop | bd-card-pop+shine |
| 绶带 / 金额 | — / 小 | 恭喜中奖 / 有 | 稀有大奖 / 最大档 + amount-pop + throb 脉动 |
| vibrate | medium | heavy | 重中重 |

**none（空奖）不在矩阵内**：淡遮罩+纯卡、无粒子无震屏不震（用户 2026-11-25 确认「中奖全炸裂，空奖克制」）。

`playFx(rarity, prize, capped)` 编排要点：`none→fx:'normal'` 且四组粒子+fxShake 全空；
中奖三档都生成 confetti(10/14/20)、coinRain(5/8/14)、fxSparks(4/6/8)，fxRays 仅 rarest(16, deg=i*22.5)；
`fxShake` = sm/md/lg（lite 时 ''）。**rarest 紧接 normal 必须换回 normal 自有档**。
`_reducedMotion` 为 true 时四组粒子全空+fxShake ''（静态出卡）。
金额 `fxAmountText`：coin→`+N`+coinName、steps→`+N`+`步`、draw→`返还`；`capped`（封顶降级）、
`type==='mixed'`（九宫格明细已在卡片 sub）、`none` 一律留空，绝不给误导性的单一单位 `+N`。
`closeFx` 与 `_fxTimer` 同时清 `fx/confetti/coinRain/fxRays/fxSparks/fxShake/fxAmountText/fxAmountUnit`（**清空点缺一即泄漏**）。
金币雨 rarest delay 起点 500ms 对齐音效金币尾音；normal/rare 编排收束在各自 FX_MS 内。
`FX_MS = {normal:2600, rare:3200, rarest:4200}`（v4 上调，≥2s 红线保持）。

**音效 v2（`utils/sfx.js`）**：五档文件名全部升版 `_v2`（`ensureFile` 用 accessSync 复用旧文件，
不升版老用户永远听旧音）；`synthWav` 支持第三位和声频率（0.5× 振幅叠加，主 0.32 + 和 0.16 不削波）、
起音 4ms 线性 attack 防爆音；rarest = 五度和声号角 + 6 连金币尾音。零资源文件，失败一律静默不阻塞入账。

**后台紧凑（`packageAdmin/config/reward-video.*`）**：Tab 吸顶实底托底（`.bd-tabs-bar`）、
概览/经济长句拆 2×2 / 5 小格、奖池与符号行 2×2 网格（行1 两 picker / 行2 数量+权重）、
流水行两行版式、铜版来源挂 `rv-src-{{srcKind}}`（video/share/checkin 各自一色，wheel/grid/refund/welcome→prize，
其余→unknown，样式走本页 `--rv-src-*` 令牌）。

回归：`check-page-runtime` 新增「金币雨 14 / 光芒 16 / 彩带 20-14-10 按档 / 星光 8-6-4 / 震屏 sm-md-lg /
金额分类型 / 封顶与 mixed 留空 / rarest→normal 换回自有档 / reduced-motion 静态出卡不震屏 /
灯珠 16 等分 / 产出进度 / 音效 _v2 与和声 WAV / 后台 srcKind 映射」；
`check-page-data-keys`、`check-css-vars`、`check-dark-mode`、`check-write-guard`、`check-beidou-lottery`、`check-beidou-grid` 全绿
（`check-miniprogram` 仅报既有的「主包超 2MB」，本次未加任何二进制资源）。

### FX v3 炫彩爆发（2026-11-25，用户「中奖特效要炫酷多彩一点，像拼多多」）

- **彩带两段式爆发**：起点改屏幕中心，8 套方向 keyframes（`bd-confetti-burst-0~7`）烘焙
  「0% 中心 scale .4 → 35% 方向顶点 → 100% 落点 y≈700rpx」，关键帧内分段缓动（炸开急出减速、飘落加速下坠），
  **不用 var() 进 keyframes**（旧 X5 兼容）。颜色/形状/方向走显式类 `bd-confetti-t-1~8 / -s-0~2 / -d-0~7`，
  **废 nth-child 轮换**（插兄弟节点会移位配色）。8 色令牌 = 暖四色 + 紫绿蓝粉，暗色块成对（1~4 存量缺口一并补齐）。
- **光芒层瘦身是 16 条的前提**：每条 `.bd-ray` 从满幅 1600rpx²（12 条 ≈31MB GPU 层）改窄条
  160×800rpx、`transform-origin:50% 100%`、clip 顶点在底边中心 —— 几何与旧 clip 等价，16 条 ≈2MB。
  四暖色（金/橙/红/亮金）nth-child(4n+k) 轮换、脉冲延迟错开 0/.3/.6/.9s；冷色交给彩带/星光/光环，主调不跑偏。
- **新增零资源元素**（全 rarest、pointer-events:none）：星光 ✦✧×8（`fxSparks` 确定性环布，金/白/青 twinkle）、
  全屏彩色闪光×1（radial-gradient opacity 脉冲，垫卡片底）、彩色冲击波×3（硬边圆环 scale .35→2.2，金/橙/青，
  与 halo 柔光互补）。金额追加 throb 脉动（pop 结束后 0.9s 起，不重叠）。
- **reduced-motion 双保险**：CSS reduce 块（卡片/绶带/金额/按钮静态呈现，粒子 animation:none + opacity:0）
  + JS `lite` 闸（粒子连 DOM 都不生成）。
- **性能预算**：rarest 峰值 ≈84 动画节点（上限 85）；新粒子一律不加 will-change（只保留 rays/coin/reel-strip 三处）；
  降级杠杆按序砍：彩带 20→14 → 星光 8→6 → 金币雨 14→10 → 光芒 16→12（砍光芒同步 check-page-runtime 断言）。

### FX v4 全档炸裂 + 震屏（2026-11-25，用户「所有等级奖项都要炸裂特效」）

- **全中奖档都有爆发**（矩阵见 §12 表）：normal 中爆发 / rare 大爆发 / rarest 最大；none 克制不变。
  覆盖旧「全都中奖=全都平淡」口径（用户明确修订，空奖仍不惩罚）。
- **震屏只挂 `.bd-fx` 自身**：fixed 元素的祖先一旦有 transform，其 containing block 会变成该祖先
  （整页内容高、随页滚动）→ 弹层立刻错位；fixed 元素自身 transform 不影响自己的参照系。
  `.bd-fx` 负 inset -24rpx overscan（> 最大振幅 12rpx 防露页边，对称保中心）；
  三档 baked keyframes bd-shake-sm/md/lg（±4/8/12rpx，0.4-0.5s），**不用 var() 进 keyframes**。
- **冲击力配套**：flash 全中奖档（强度 sm/md/大）、rings 1/2/3、rarest rays 入场 opacity burst、
  卡片 normal pop-sm / rare pop、vibrate normal medium / rare heavy（**不动 FS_NAME/SEQUENCES**，③g 保持绿）。
- **背景暂停保预算**：根视图 `is-fx` 时 marquee 灯珠/win 格脉冲/转盘灯珠 `animation-play-state:paused`
  （弹层全遮罩时背景不可见，暂停纯赚）→ 同屏可见动画节点 = fx 层峰值 ≤85。
- reduced-motion：shake/lever/marquee 进 reduce 块；lite 闸 fxShake '' + 四组粒子空。

## 13. 九宫格卷轴展示层（2026-11-24，用户「改为老虎机一样的那种转盘」）

**纯前端改造，服务端零改动**：3×3 盘面、9 图案、8 条连线派奖全保留，只把「逐格 110ms 翻牌」
换成「3 列卷轴垂直滚动、左→中→右逐列减速停」。契约红线不变：结果只由服务端定。

- **图案带构成**：第 c 列 = 装饰帧 `16+8c` 个 + 末端严格 3 帧服务端图案。装饰帧 = 管理端 `symbols`
  候选按配置顺序**确定性循环**（起点错开 c 位，零 `Math.random`、纯视觉、不参与判奖）；
  末端 3 帧 = `board[c]、board[c+3]、board[c+6]`（**board 行主序，列要跳 3 取**）。
  停位由 board 结构保证，不是概率保证 —— 与转盘外圈灯珠同性质。
- **几何全 rpx**（reward 页无 screen-* 覆写）：帧高 148rpx + 间距 12rpx = 步距 160rpx；
  视窗高 468rpx + 列底 12rpx = 480rpx（与静态 9 格同高，停稳换回无跳变）；列宽 31.5%。
  目标偏移 `offsetRpx = 装饰帧数 × 160`（2560/3840/5120），三列平均速度一致 ≈2000rpx/s。
- **时序**：三列同时起滚、时长 1200/1900/2600ms 形成 stagger；缓动 `cubic-bezier(0.3, 0.3, 0.15, 1)`
  （近匀速快转→末段制动；v3.2 改，原转盘曲线初始爆发后长尾蠕动是「卡片平移感」来源，转盘自身曲线不动）。
  **两拍启动**：strip 是新挂载节点，挂载时就带目标 transform
  不会发生过渡 → 第一拍装带（offset 0），60ms 后第二拍滚到目标偏移。
  **strip 过冲（y>1）否决**：停位底边恰贴视窗底，过冲会露出 strip 之外空白；垫缓冲帧会破坏
  「末端 3 帧=board」契约 —— 回弹感只放停稳 scale 脉冲（1→1.035→0.99→1，0.3s）。
- **完成驱动：兜底 timer 是权威**（duration + 80ms 缓冲），`transitionend` 只是提前量
  （过滤 `propertyName==='transform'` + `_gridStopDone[col]` 幂等守卫）——
  vm 桩与部分 iOS WebView 不触发 transitionend，timer 路径独立成立（同转盘 3600ms 手法）。
- **双态渲染**：滚动中（`grid.revealing && grid.reels.length`）渲染 reel；其余时刻渲染现有静态
  `.bd-grid` 9 格（「?」占位保留）。停稳/中断同一拍清空 reels + cells 全 revealed → 立即静态终态。
  `grid.cells[].revealed/win` 语义不变：停轴 = 该列 3 格 revealed；win 只在 finishGridReveal
  由服务端 lines 置位。`grid.revealing` 仍是权威禁点布尔；新增 `grid.phase`（idle/spinning/settling/done）。
- **中断保护**：onHide/onUnload/applyState 都走 `clearGridTimer`（清全部 `_gridTimers` +
  revealAll 时按 lastResult 直接终态），不残留半滚动画、不卡「开奖中」；开奖失败分支同样清 reels 恢复按钮。
- **reduced-motion**：wxss `@media (prefers-reduced-motion: reduce)` 块 + 隐藏探针 `.bd-reel-probe`
  （width/height 0，不用 display:none —— 那会读不到 computedStyle），onShow 读 `transitionDuration`
  缓存 `_reducedMotion`；为 true 时跳过装带直接终态。
- **音效**：手势栈 prewarm + spin 原样保留；每列停轴复用现有 `spin` 音作「咔哒」（34ms），
  **不新增音频文件**（FS_NAME 五档断言保持绿）；sfxEnabled 总开关真拦。
- **令牌**：`--bd-reel-shade-grad`（视窗上下渐隐）/`--bd-reel-settle-glow`（停稳描边）亮暗双块定义；
  同轮补齐存量缺口：`--bd-grid-*` 全套暗色压暗重写（此前暗色下格子漏白）。
- **机框 chrome（v3.2→v4 赌场老虎机，2026-11-25 用户给参考图「做成这样的」）**：
  `.bd-slot-row` = 枪灰金属机身 `.bd-machine` + 右侧 84rpx **可点拉杆**（绿球+金属臂+轨+底钮，
  tap=onLeverTap→同步栈调 playGrid 保 sfx 手势，**下压走常驻节点两拍 transition**
  （is-pulled→translateY 120rpx，260ms 后松手回弹；class-add animation 在同批 setData 合并后
  部分 WebView 不启动——用户 2026-11-25「拨杆没有动」的根因）；与 SPIN 同入口，
  playGrid 首行守卫兜底双入口竞态；onHide/switchMode 复位 leverPulled）。
  机身纵向：`.bd-marquee` 金色像素跑马灯牌（24 方珠复用 bd-bulb-blink 奇偶交替，滚动中 is-spin 提速）→
  `.bd-bezel` 银包边 → **`.bd-window` 恒内宽 480rpx 双态共用容器**（reels/grid + 常驻 window-sep×2 +
  `.bd-glass-line` 中部玻璃压线，替代 v3.2 的 dashed payline）→ `.bd-console` 三 glossy 按钮
  （红=去赚铜版 scrollToTasks / 绿=看概率 scrollToRules[#rules 自动展开] / 金=开一局 playGrid，
  禁用逻辑镜像旧 bd-grid-btn，旧按钮已删）→ `.bd-base` 底座+投币口装饰。
  **卷轴白两态 = 真实卷轴 intentional**：label/「?」固定深色令牌（--bd-reel-label/--bd-grid-q 亮暗同），
  coin/steps/win tint 暗色也浅，shade 白系；机身枪灰两态、页面暖底不动。
  帧 148/步距 160/视窗 468/列 31.5% 逐字未动 → 停稳零跳变。**strip 过冲否决**（露底）；回弹只走停稳 scale。

回归：`check-page-runtime` ②b（停位=board 逐帧断言 / 装饰帧候选集 / 两拍启动 / 逐列停 stagger /
win 反向断言 / 中断 3s 反证 / reduced-motion / 失败恢复）+ `check-beidou-lottery`
（buildReels 零随机反向断言、停位取 board 的列跳 3 公式）。
