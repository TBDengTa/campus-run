/**
 * 三端响应式 behavior：给页面注入 data.screenMode（compact / regular / wide）。
 * 页面根节点挂 class="... screen-{{screenMode}}"，令牌与公共类的宽屏 px 值见 app.wxss。
 * 结构分支（栏位容器）用 screenMode，纯样式分支走各页 wxss 的 .screen-regular / .screen-wide 块。
 * onWindowResize 在 detached 解绑，防泄漏（同 wcamera 约定）。
 */
const screen = require('../utils/screen');

module.exports = Behavior({
  data: {
    screenMode: 'compact',
  },
  lifetimes: {
    attached() {
      this.setData({ screenMode: screen.currentMode() });
      this._screenOff = screen.onResize((mode) => {
        if (mode !== this.data.screenMode) this.setData({ screenMode: mode });
      });
    },
    detached() {
      if (this._screenOff) {
        this._screenOff();
        this._screenOff = null;
      }
    },
  },
});