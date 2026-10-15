// 获得徽章的弹窗（自定义，替代 wx.showModal —— 纯文字看不到徽章长什么样）
// 用法：<badge-award visible="{{badgeAward.visible}}" badges="{{badgeAward.badges}}" bind:close="..." bind:go="..." />
// 说明：本组件内使用 app.wxss 的公共类（.tt-sheet*），json 里必须声明 styleIsolation: "apply-shared"。
Component({
  properties: {
    visible: { type: Boolean, value: false },
    // 本次新获得的徽章（POST /api/badges/check 的 newBadges：key/name/icon/mode/tierGroup/tierLevel/level）
    badges: { type: Array, value: [] },
  },

  data: {
    items: [],
    title: '',
  },

  observers: {
    badges(list) {
      const arr = Array.isArray(list) ? list : [];
      const items = arr.map((b) => {
        const lv = Number(b.tierLevel) || Number(b.level) || 0;
        const isTier = b.mode === 'tier' || lv > 0 || !!b.tierGroup;
        const icon = b.icon || '';
        // icon 是图片 URL / 代码包路径时用 <image>（原色直出）；空 icon 才回退 t-icon
        const isImage = /^https?:/i.test(icon) || icon.indexOf('/') === 0;
        return {
          key: b.key || b.name,
          name: b.name || '新徽章',
          image: isImage ? icon : '',
          level: lv,
          // 等级徽章额外显示「升级到 LvN · 等级名」
          sub: isTier && lv > 0 ? `升级到 Lv${lv} · ${b.tierGroup || b.name || ''}` : '',
        };
      });
      const hasUpgrade = items.some((i) => i.level > 0);
      this.setData({
        items,
        title: hasUpgrade ? `恭喜获得 ${items.length} 项徽章成就` : `获得 ${items.length} 枚新徽章`,
      });
    },
  },

  methods: {
    // 点遮罩 / 下滑关闭（t-popup 既有行为）
    onVisibleChange(e) {
      if (e.detail && !e.detail.visible) this.triggerEvent('close');
    },

    close() {
      this.triggerEvent('close');
    },

    goBadges() {
      this.triggerEvent('go');
    },
  },
});
