/**
 * 管理导航的「分类 → 条目 → 页面」两级交互（管理中枢与首页「快捷操作」共用）
 *
 * 用户要求的交互：
 *   ① 宫格里的按钮**就叫分类名**（我的班级 / 学生会 / 用户与权限 / …），点击**不直接跳页**；
 *   ② 点分类 → 弹出该分类下的**条目列表**；
 *   ③ 点条目 → 进入页面。
 *   单条目分类（如「申诉审核」）在浮层里就是那一行 + 「进入页面」，保持同一个交互模型。
 *
 * 为什么抽成 Behavior：首页与 hub 都要这套逻辑，各写一套必然漂移（历史上权限 key 与分组名就是这么漂的）。
 * 页面只需在模板里放 sheet 结构、在 data 里给出 navGroups，其余交互都在这里。
 *
 * 页面可覆盖的钩子：`onNavEntryBlocked(entry)` —— 返回 true 表示该条目由页面自行处理
 * （如 hub 的「班级管理」要先让多班班主任选班）。
 */
const navGroups = require('../utils/nav-groups.js');

/**
 * 判断一个分类里的「有效条目」。**必须按可见性再筛一次**：
 * 分类里的条目可以各有 perm（如学生会的「学生会成员」需 union.view、「检查记录」只需成员身份），
 * 若只看原始条目数，会把「实际只剩 1 条可见」的分类误判成多条、仍然弹浮层。
 * 依赖 nav-groups 的 entryVisible（分组级 only 作为条目默认值）。
 */
function effectiveItems(group, ctx) {
  const items = (group && group.items) || [];
  if (!ctx) return items;
  const { entryVisible } = navGroups;
  return items.filter(
    (it) => entryVisible({ ...it, only: it.only === undefined ? group.only : it.only }, ctx)
  );
}

module.exports = Behavior({
  data: {
    // 当前打开的分类（null = 未打开）
    navSheet: null,
    navSheetVisible: false,
  },

  methods: {
    // 由页面在拿到上下文后调用；返回可见分类数组（页面自行 setData）
    buildNavGroups(ctx) {
      return navGroups.visibleGroups(ctx);
    },

    // 点分类按钮：
    //   · 该分类下**只剩 1 条可见条目**（如「申诉审核」）→ 直接进页面，不弹浮层 ——
    //     用户明确要求：单条目分类没必要再点一次弹窗；
    //   · 多条 → 打开条目浮层。
    onNavCellTap(e) {
      const key = e.currentTarget.dataset.key;
      const groups = this.data.navGroups || this.data.mgrGroups || [];
      const group = groups.find((g) => g.key === key);
      if (!group) return;

      const items = effectiveItems(group, this.data.navCtx);
      if (items.length <= 1) {
        const only = items[0];
        if (!only || !only.url) {
          wx.showToast({ title: '该分类下暂无可用入口', icon: 'none' });
          return;
        }
        this.onNavEntryTap({ currentTarget: { dataset: { url: only.url, key: only.key } } });
        return;
      }

      this.setData({
        navSheet: {
          key: group.key,
          title: group.title,
          tint: group.tint,
          items: items.map((it) => ({
            key: it.key,
            label: it.label,
            icon: it.icon,
            url: it.url,
            bg: it.bg,
            color: it.color,
            desc: it.desc || '',
          })),
        },
        navSheetVisible: true,
      });
    },

    onNavSheetVisible(e) {
      const visible = !!(e && e.detail && e.detail.visible);
      this.setData({ navSheetVisible: visible });
      if (!visible) this.setData({ navSheet: null });
    },

    closeNavSheet() {
      this.setData({ navSheetVisible: false, navSheet: null });
    },

    // 点条目 → 进页面（页面可用 onNavEntryBlocked 拦截）
    onNavEntryTap(e) {
      const { url, key } = e.currentTarget.dataset;
      const entry = { url: url || '', key };
      if (typeof this.onNavEntryBlocked === 'function' && this.onNavEntryBlocked(entry)) return;
      if (!entry.url) {
        wx.showToast({ title: '该入口暂不可用', icon: 'none' });
        return;
      }
      this.closeNavSheet();
      wx.navigateTo({ url: entry.url });
    },
  },
});
