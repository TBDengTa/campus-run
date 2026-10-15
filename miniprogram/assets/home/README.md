# 首页插画素材目录

把文件按下表命名放进本目录（`miniprogram/assets/home/`），**重新编译即自动生效，不需要改任何代码**。

首页会在 `onLoad` 时用 `wx.getFileSystemManager().accessSync` 探测这些文件：
文件存在 → 用图片；文件不存在 → 回退到 CSS 插画（渐变天空 + 云朵 + 草地 + 虚线跑道）。

| 文件名 | 用途 | 建议尺寸 | 备注 |
|---|---|---|---|
| `hero.jpg` | 顶部场景图 | 宽高比约 **2.87 : 1**（现用 1500 × 523） | 图内已含「唐唐快跑」标题与标语 → **放图后首页不再叠加文字**，头部高度按图片比例自适应（750rpx 宽 ≈ 262rpx 高）；JPG q85 + progressive 实测约 74KB（同图 PNG 要 321KB） |
| `entry-water.png` | 入口：饮水管理 | 240 × 240 | 透明 PNG，风格统一（显示 84rpx） |
| `entry-plan.png` | 入口：目标计划 | 240 × 240 | 透明 PNG |
| `entry-badge.png` | 入口：徽章成就 | 240 × 240 | 透明 PNG |
| `entry-body.png` | 入口：身体数据 | 240 × 240 | 透明 PNG |

路径常量集中在 `miniprogram/pages/home/home.js` 顶部：

```js
const HERO_IMAGE_JPG = 'assets/home/hero.jpg';
const HERO_IMAGE_PNG = 'assets/home/hero.png'; // 旧命名兜底：目录里放 PNG 也能生效
const ENTRY_IMAGES = { water: 'assets/home/entry-water.png', ... };
```

注意事项：

- 不要用 WXSS 的 `background-image` 引用还不存在的文件，会导致**构建报错**；本目录的探测走的是运行时判断。
- **顶部大图用 JPG，入口小图用 PNG**：
  - 大图（1500×523 满幅不透明插画）用 **JPG q85**：`image` 组件对 JPG 全平台无兼容门槛，
    实测 74KB（PNG 调色板 256 是 321KB，WebP q80 是 41KB 更小但 **iOS 需 14+、目标环境实测不显示**，已弃用）。
    当前目录只放 `hero.jpg`；如需换回 PNG，命名成 `hero.png` 放进来即可（`resolveHero()` 会兜底，不用改代码）。
  - 240×240 的**扁平小图 WebP 反而比 PNG 大 3%~40%**（实测），一律保持 PNG。
- **主包体积上限 2MB**。原始大图（3MB 级）请放到仓库根目录 `.design-src/`（已在 .gitignore 中，不会入包也不会提交）。
  转 JPG（Pillow，质量 85）：
  ```python
  from PIL import Image
  im = Image.open("原始图.png").convert("RGB")  # 满幅不透明图，无需 alpha
  im = im.resize((1500, round(im.size[1] * 1500 / im.size[0])), Image.LANCZOS)
  im.save("miniprogram/assets/home/hero.jpg", "JPEG", quality=85, progressive=True, optimize=True, subsampling=2)
  ```
  入库前请确认 `node tools/check-miniprogram.js` 仍然 ✅（含主包 ≤ 2MB）。
- 教师端首页不展示「目标计划 / 徽章成就」入口，但素材可以照常放。
