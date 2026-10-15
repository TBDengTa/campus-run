// 通用流量主横幅（原生模板 ad-custom）：徽章 / 目标计划 / 身体数据 / 饮水管理 四个用户端页面共用。
//
// 用法（父页面）：
//   1) 页面 json 注册： "ad-banner": "/components/ad-banner/ad-banner"
//   2) wxml 放一行：   <ad-banner unit-id="adunit-……" show-ad="{{showAd}}" />
//   3) 页面 JS：data 里 `isTeacher: false, showAd: false`（两道闸门），
//      在 `await getApp().ensureLogin()` 之后调 `getApp().applyAdGate(this)` ——
//      只有角色确认是学生才把 showAd 置真（教师 / 角色未知都不渲染，首帧不会给教师闪一条广告）。
//      注意：applyAdGate 是异步的（本地没角色时会去查一次 /api/auth/me），
//      所以调用时不要 `return/await` 它之后再继续页面逻辑 —— 直接调，广告节点会晚一帧出现即可。
//
// 为什么用组件：四个页面共用同一份「占位高度 + 加载后贴合实际尺寸 + 事件只记日志」的逻辑，
// 不在四个页面各写一套（设计系统要求占位高度用统一常量/公共类）。
//
// 尺寸口径（官方：外层容器宽度 = 广告宽度，内部 ad-custom 固定 width:100%、
// 高度按模板等比自适应，且「无广告展示时 ad-custom 不占高度」）：
//   · 加载前 / 无填充 / 关闭后：容器 min-height 占位 MIN_HEIGHT_RPX，页面下方内容不跳动；
//   · bindload 之后：查一次自己渲染出来的真实高度，把 min-height 换成实测 height ——
//     既不留「比广告高的透明空框」，也不出现「加载完再跳一下」；
//     **宽度不动**（横幅就是卡片宽 100%，容器已有左右 var(--tt-gap) 留白）；
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
      const adStyle = `min-height:${MIN_HEIGHT_RPX}rpx;`;
      if (adStyle !== this.data.adStyle) this.setData({ adStyle });
      console.log('[ad-banner] 原生模板广告已关闭', this.data.unitId, e && e.detail);
    },

    // 查一次 ad-custom 实际渲染高度（px → rpx）
    measure() {
      if (!wx.createSelectorQuery) return;
      wx.createSelectorQuery()
        .in(this)
        .select('.ad-banner-ad')
        .boundingClientRect((rect) => {
          if (!rect) return;
          this.applyMeasuredHeight(rect.height);
        })
        .exec();
    },

    // 实测高度可用就把占位换成实测高度；拿不到 / 不可信（0、极小）就保留占位，不制造跳动
    applyMeasuredHeight(heightPx) {
      const rpxH = Math.round((Number(heightPx) || 0) * rpxPerPx());
      if (rpxH < 20) return false;
      const adStyle = `height:${rpxH}rpx;`;
      if (adStyle !== this.data.adStyle) this.setData({ adStyle });
      return true;
    },
  },
});
