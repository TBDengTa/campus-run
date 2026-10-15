// 通用流量主横幅（原生模板 ad-custom）：徽章 / 目标计划 / 身体数据 / 饮水管理 四个用户端页面共用。
//
// 用法（父页面）：
//   1) 页面 json 注册： "ad-banner": "/components/ad-banner/ad-banner"
//   2) wxml 放一行：   <ad-banner unit-id="adunit-……" show-ad="{{showAd}}" bind:height="onAdHeight" />
//   3) 页面 JS：data 里 `isTeacher: false, showAd: false`（两道闸门），
//      在 `await getApp().ensureLogin()` 之后调 `getApp().applyAdGate(this)` ——
//      只有角色确认是学生才把 showAd 置真（教师 / 角色未知都不渲染，首帧不会给教师闪一条广告）。
//      注意：applyAdGate 是异步的（本地没角色时会去查一次 /api/auth/me），
//      所以调用时不要 `return/await` 它之后再继续页面逻辑 —— 直接调，广告节点会晚一帧出现即可。
//
// 为什么要放**首屏**：这是收入来源，插在内容末尾（要滚动才看得到）等于没有曝光。
// 四个页面的插入位置统一为「页面头部」：标题 / hero（概览卡）之后、主内容列表或表单之前；
// 具体落点见 docs/ui-design.md §8.1。
//
// 两种形态：
//   · 默认（徽章 / 目标计划 / 身体数据）：在正常文档流里 —— 占位 → 加载后贴合实际高度，前后内容不跳动；
//   · `flow-fixed`（饮水页）：`position: fixed; bottom: 0`，**首屏始终可见、不占文档流**，
//     由页面把量到的高度写进 `--wt-ad-h`，`.wt-stage` 的 padding-bottom 跟着让位 ——
//     水瓶交互区不被挤压，滚动下滑时横幅自然被内容盖住，正常流里的内容不受影响。
//
// 尺寸口径（官方：外层容器宽度 = 广告宽度，内部 ad-custom 固定 width:100%、
// 高度按模板等比自适应，且「无广告展示时 ad-custom 不占高度」）：
//   · 加载前 / 无填充 / 关闭后：容器 min-height 占位 MIN_HEIGHT_RPX，页面下方内容不跳动；
//   · bindload 之后：查一次自己渲染出来的真实高度，把 min-height 换成实测 height ——
//     既不留「比广告高的透明空框」，也不出现「加载完再跳一下」；
//     **宽度不动**（横幅就是卡片宽 100%，容器已有左右 var(--tt-gap) 留白）；
//   · 每次高度变化都 triggerEvent('height')，`flow-fixed` 页面据此让位（父页面没监听也不报错）。
//   · binderror（无填充 / 开发者工具无广告）：退回占位高度，保持稳定，只 console.error。
const MIN_HEIGHT_RPX = 200; // 统一占位高度（四个页面同款，只在这里改）

function rpxPerPx() {
  const info = (wx.getWindowInfo && wx.getWindowInfo()) || (wx.getSystemInfoSync && wx.getSystemInfoSync()) || null;
  const vw = (info && info.windowWidth) || 375;
  return 750 / vw;
}

Component({
  properties: {
    // 该位置的流量主 unit-id（客户端公开标识，不是密钥）
    unitId: { type: String, value: '' },
    // 两道闸门的结果由父页面给：只有「不是教师 且 角色已确认为学生」才为 true
    showAd: { type: Boolean, value: false },
    // 'flow'（默认，文档流内占位） | 'flow-fixed'（固定在视口底部，饮水页首屏可见）
    variant: { type: String, value: 'flow' },
  },

  data: {
    // 占位/贴合样式：加载前给 min-height 占位，bindload 后换成实测高度
    adStyle: `min-height:${MIN_HEIGHT_RPX}rpx;`,
  },

  methods: {
    // 广告渲染成功：真实事件 detail 里带宽高（px），取不到再查节点 boundingClientRect。
    // 两者都拿不到时保留占位高度（宁可与占位一致，也不要量到 0 让下方内容上跳）。
    onLoad(e) {
      console.log('[ad-banner] 原生模板广告加载成功', this.data.unitId, e && e.detail);
      const detail = (e && e.detail) || {};
      if (this.applyMeasuredHeight(detail.height)) return;
      setTimeout(() => this.measure(), 0);
    },

    onError(e) {
      console.error('[ad-banner] 原生模板广告加载失败（保留占位，不影响页面）', this.data.unitId, e && e.detail);
    },

    onClose(e) {
      // 用户关掉广告后平台会把 ad-custom 高度收回 → 回到占位高度，避免下方内容上跳
      console.log('[ad-banner] 原生模板广告已关闭', this.data.unitId, e && e.detail);
      this.setHeight(MIN_HEIGHT_RPX);
    },

    // 查一次自己容器实际渲染高度（px → rpx）。
    // 量容器而不是只量 ad-custom：容器带外边距/圆角，父页面（flow-fixed）需要的是整块占位高度；
    // 未填充时容器高度就是占位高度（父页面照样让位，不出现「广告没出但底部被盖住」）。
    measure() {
      if (!wx.createSelectorQuery) return;
      wx.createSelectorQuery()
        .in(this)
        .select('.ad-banner')
        .boundingClientRect((rect) => {
          if (!rect) return;
          this.applyMeasuredHeight(rect.height);
        })
        .exec();
    },

    // 实测高度可用就用实测高度（贴合，去掉占位多出来的空白）；不可信（0 / 极小）就保留占位
    applyMeasuredHeight(heightPx) {
      const rpxH = Math.round((Number(heightPx) || 0) * rpxPerPx());
      if (rpxH < 20) return false;
      this.setHeight(rpxH);
      return true;
    },

    // 写内联高度 + 通知父页面（饮水页据此给水瓶舞台让位）
    setHeight(rpxH) {
      const adStyle = `height:${rpxH}rpx;`;
      if (adStyle !== this.data.adStyle) this.setData({ adStyle });
      this.triggerEvent('height', { height: rpxH });
    },
  },
});
