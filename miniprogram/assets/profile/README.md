# 「我的」页插画素材目录

把文件按下表命名放进本目录（`miniprogram/assets/profile/`），**重新编译即自动生效，不需要改任何代码**。

「我的」页在 `pages/profile/profile.js` 的 `onLoad` 用 `wx.getFileSystemManager().accessSync` 探测这些文件
（与首页 `assets/home/` 是同一套做法）：文件存在 → 用图片；不存在 → 回退到原来的 `t-icon` 矢量图标。

| 文件名 | 用途 | 建议尺寸 | 备注 |
|---|---|---|---|
| `entry-body.png` | 「身体数据」行图标 | 240 × 240 | 透明 PNG；显示尺寸 68 × 68rpx |
| `entry-plan.png` | 「目标计划」行图标 | 240 × 240 | 透明 PNG |
| `entry-water.png` | 「喝水打卡」行图标 | 240 × 240 | 透明 PNG |
| `entry-badge.png` | 「我的徽章」行图标 | 240 × 240 | 透明 PNG |

路径常量集中在 `miniprogram/pages/profile/profile.js` 顶部：

```js
const ENTRY_IMAGES = {
  body: 'assets/profile/entry-body.png',
  plan: 'assets/profile/entry-plan.png',
  water: 'assets/profile/entry-water.png',
  badge: 'assets/profile/entry-badge.png',
};
```

注意事项：

- 这里**只用 PNG**：240×240 的扁平插画换成 WebP 反而比 PNG 大 3%~40%（实测），换格式没有收益。
  首页的大图 `assets/home/hero.webp` 才是 WebP（1500×523，PNG 321KB → WebP 41KB）。
- 不要用 WXSS 的 `background-image` 引用还不存在的文件，会导致**构建报错**；本目录的探测走的是运行时判断。
- 教师端「我的」页不展示「运动与健康」整块，素材可照常放。
- **主包体积上限 2MB**：4 张图合计请控制在 60KB 以内（240×240 调色板 PNG 单张约 8~10KB）。
  原始大图请放到仓库根目录 `.design-src/`（已在 .gitignore 中，不会入包也不会提交），压缩后再放进本目录。
