/**
 * 三端响应式断点（唯一实现，用户 2026-11-23 玻璃拟态 + 三端适配）
 *
 * compact  <600px        iPhone / 手机 → 单列、低密度（默认 rpx）
 * regular  600~900px     iPad 竖屏/分屏 → 双栏卡片网格、中密度
 * wide     >900px        iPad 横屏 / Mac·PC 微信窗口 → 三栏 dashboard、高密度
 *
 * ⚠️ 宽屏样式一律 px、禁 rpx：rpx 按窗口宽换算（750rpx = 窗口宽），
 * 宽窗口下会把字号/圆角放大数倍（wcamera 横屏已踩过同类坑）。
 * 页面侧由 behaviors/screen.js 在根节点挂 .screen-regular / .screen-wide，
 * 令牌与公共类的 px 对应值定义在 app.wxss 的「三端响应式」段。
 */
const REGULAR_MIN = 600;
const WIDE_MIN = 900;

function modeOf(windowWidth) {
  const w = Number(windowWidth) || 0;
  if (w > WIDE_MIN) return 'wide';
  if (w >= REGULAR_MIN) return 'regular';
  return 'compact';
}

function currentMode() {
  // getWindowInfo 基础库 2.20.1+；旧库退回 getSystemInfoSync（同字段）
  const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
  return modeOf(info && info.windowWidth);
}

/**
 * 监听窗口尺寸变化（iPad 分屏拖动 / PC 微信拉伸窗口）。
 * 返回解绑函数 —— 调用方必须在 detached/onUnload 里调用，防止监听器泄漏（同 wcamera 约定）。
 */
function onResize(cb) {
  const handler = (res) => {
    const size = (res && res.size) || {};
    cb(modeOf(size.windowWidth), size);
  };
  wx.onWindowResize(handler);
  return () => {
    if (typeof wx.offWindowResize === 'function') wx.offWindowResize(handler);
  };
}

module.exports = { REGULAR_MIN, WIDE_MIN, modeOf, currentMode, onResize };