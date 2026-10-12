# 首页插画素材目录

把文件按下表命名放进本目录（`miniprogram/assets/home/`），**重新编译即自动生效，不需要改任何代码**。

首页会在 `onLoad` 时用 `wx.getFileSystemManager().accessSync` 探测这些文件：
文件存在 → 用图片；文件不存在 → 回退到 CSS 插画（渐变天空 + 云朵 + 草地 + 虚线跑道）。

| 文件名 | 用途 | 建议尺寸 | 备注 |
|---|---|---|---|
| `hero.png` | 顶部人物场景图 | 750 × 350 及以上（2 倍图更佳） | 建议自带蓝天草地，正文白色标题会叠在偏上位置；下方约 96rpx 会被内容卡片压住 |
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
- 图片总大小会计入小程序包体积（主包上限 2MB），建议 `hero.png` 控制在 300KB 以内。
- 教师端首页不展示「目标计划 / 徽章成就」入口，但素材可以照常放。
