# 首页插画素材目录

把文件按下表命名放进本目录（`miniprogram/assets/home/`），**重新编译即自动生效，不需要改任何代码**。

首页会在 `onLoad` 时用 `wx.getFileSystemManager().accessSync` 探测这些文件：
文件存在 → 用图片；文件不存在 → 回退到 CSS 插画（渐变天空 + 云朵 + 草地 + 虚线跑道）。

| 文件名 | 用途 | 建议尺寸 | 备注 |
|---|---|---|---|
| `hero.png` | 顶部场景图 | 宽高比约 **2.87 : 1**（现用 1500 × 523） | 图内已含「唐唐快跑」标题与标语 → **放图后首页不再叠加文字**，头部高度按图片比例自适应（750rpx 宽 ≈ 262rpx 高）；请控制文件 ≤ 400KB |
| `entry-water.png` | 入口：饮水管理 | 120 × 120 | 透明 PNG，风格统一 |
| `entry-plan.png` | 入口：目标计划 | 120 × 120 | 透明 PNG |
| `entry-badge.png` | 入口：徽章成就 | 120 × 120 | 透明 PNG |
| `entry-body.png` | 入口：身体数据 | 120 × 120 | 透明 PNG |

路径常量集中在 `miniprogram/pages/home/home.js` 顶部：

```js
const HERO_IMAGE = 'assets/home/hero.png';
const ENTRY_IMAGES = { water: 'assets/home/entry-water.png', ... };
```

注意事项：

- 不要用 WXSS 的 `background-image` 引用还不存在的文件，会导致**构建报错**；本目录的探测走的是运行时判断。
- **主包体积上限 2MB**：`hero.png` 建议 ≤ 400KB。原始大图（3MB 级）请放到仓库根目录 `.design-src/`（已在 .gitignore 中，不会入包也不会提交），用降采样 + 调色板量化压缩后再放进本目录：
  ```python
  from PIL import Image
  im = Image.open("原始图.png").convert("RGB")
  im = im.resize((1500, round(im.size[1] * 1500 / im.size[0])), Image.LANCZOS)
  im.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.NONE).save("hero.png", optimize=True)
  ```
- 教师端首页不展示「目标计划 / 徽章成就」入口，但素材可以照常放。
