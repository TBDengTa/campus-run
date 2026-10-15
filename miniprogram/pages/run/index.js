const auth = require('../../utils/request');
const fmt = require('../../utils/format');

// 两点间球面距离（米）
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ===== 跑步页原生模板广告（格子）尺寸：只调这两个常量，样式不必改 =====
// 官方口径（开放能力/广告/原生模板广告）：广告宽高由外层容器决定 —— 外层宽度 = 广告宽度，
// 内部 `ad-custom` 固定 width:100% + 高度按模板等比自适应，且「无广告展示时 ad-custom 不占高度」，
// 所以外层要自己给占位高度，否则填充前后会跳动。
// 这里做成「靠右侧的透明侧边块」：不再铺满地图，也不再自带白底/阴影/圆角/内边距。
//   · 宽 320rpx（375px 机型 ≈ 160px，320px 窄屏 ≈ 150px）：官方没给最小宽度，具体模板各异；
//     取「面板宽（702rpx）的 46%」的保守值，宁可稍宽也不留不填充的窄条（越小越可能不填充/字挤）。
//     这只是**占位/兜底**宽度：bindload 后会用 ad-custom 实测渲染宽（px→rpx）覆盖它，
//     让容器与广告内容边界一致（写死宽度比广告宽时会看到广告右侧一条空白）。
//   · 占位高 200rpx（与 components/ad-banner 的 MIN_HEIGHT_RPX 同口径）：
//     官方「无广告展示时 ad-custom 不占高度」→ 占位只在加载中/无填充时兜底；
//     **bindload 之后会把 min-height 收掉、换成实测高度**，避免「占位比广告高」在广告下方留一条透明空白。
const AD_BOX_WIDTH_RPX = 320;
const AD_BOX_MIN_HEIGHT_RPX = 200;
// 实测收紧时的边界：宽度量到异常值（0 / 极大）就不采用，继续用上面的兜底
const AD_BOX_WIDTH_MIN_RPX = 80;
const AD_BOX_WIDTH_MAX_RPX = 500;
Page({
  data: {
    state: 'idle', // idle | running | paused | finished
    stateText: '准备就绪',
    latitude: 39.909,
    longitude: 116.397,
    scale: 16,
    polyline: [],
    markers: [],
    distanceText: '0.00',
    durationText: '00:00',
    paceText: "--'--\"",
    saving: false,
    locationReady: false,
    isTeacher: false,
    // 广告位闸门：只有「角色已确认为学生」才渲染原生模板广告。
    // 首帧 isTeacher 还是默认 false（syncRole 未回来），若直接用 !isTeacher，
    // 教师账号会先渲染出广告节点并可能产生一次曝光 —— 所以单独用 showAd 兜住这个窗口
    // （拿不到 userInfo / role 也保持 false，宁可不展示广告）。
    showAd: false,
    // 侧边透明广告块的定位与尺寸（内联 style）：
    //   bottom = 窗口高 − 面板内控制区(.ctrls)顶部 + 间距（measureAd() 实测，锚在面板上沿之上）
    //   尺寸：未加载/无填充 = 兜底宽 + 占位高；bindload 后 = ad-custom 实测宽高（writeAdStyle()）
    adStyle: '',

    // 保存记录后获得的徽章（自定义带图弹窗，替代把徽章名拼进 wx.showModal 的纯文字写法）
    badgeAward: { visible: false, badges: [] },
  },

  onLoad() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    this.points = [];
    this.distance = 0;
    this.seconds = 0;
    this.timer = null;
    this.lastPoint = null;
  },

  onShow() {
    // 未登录 / 已退出 / 游客：统一跳登录页，不执行任何业务逻辑
    if (!getApp().requireLogin()) return;
    this.syncTabBar();
    this.bootstrap();
  },

  onReady() {
    // 首屏渲染完测一次（.ctrls 的 position:absolute 需要视口尺寸，节点渲染后才能测准）。
    // 角色未知时 measureAd() 会直接跳过：教师虽然也会 onReady，但一个字节的广告定位都不算。
    this.measureAd();
  },

  onResize() {
    this.measureAd();
  },

  // 学生路径下量一次控制区上沿，算出侧边广告块的 bottom + 自身尺寸。
  // 纯计算 + 一次 setData（只在结果有变化时），不做 DOM 操作，不影响地图与 disableScroll。
  measureAd() {
    // 角色未确认（首帧）或已确认是教师：不测量、不写 adStyle（教师彻底不参与广告定位）
    if (this._measuring || !this._roleKnown || this.data.isTeacher) return;
    const wxInfo = (wx.getWindowInfo && wx.getWindowInfo()) || (wx.getSystemInfoSync && wx.getSystemInfoSync()) || null;
    if (!wxInfo || !wx.createSelectorQuery) return;
    this._measuring = true;
    wx.createSelectorQuery()
      .in(this)
      .select('.ctrls')
      .boundingClientRect((rect) => {
        this._measuring = false;
        if (!rect || !rect.height) return;
        const vw = wxInfo.windowWidth || 375;
        const rpx = (n) => (n * 750) / vw;
        const winH = rpx(wxInfo.windowHeight);
        // 面板内「控制区」顶部（距离面板上沿还有 grab + stats 两块），先转成 rpx
        const ctrlsTop = rpx(rect.top);
        // 广告与面板上沿留出 20rpx。两个硬约束：
        //   ① 不压顶部状态胶囊 → 块 top ≥ 200rpx（顶栏底 137rpx + 63rpx 间距）
        //   ② 不遮面板里的数据区/按钮 → 块 top ≤ 面板上沿（正常机型都远高于此，
        //      只有小屏 + 待机态（面板较高）才需要把块往下压到面板上沿；此时块会略微压住
        //      面板顶部约 80~170rpx 的圆角/留白，但仍在数据区之上，按钮零位移）
        // 故取 min(锚定值, winH − 200 − 占位高)，再兜一个下限 240rpx
        const boxH = this._adFitH || AD_BOX_MIN_HEIGHT_RPX;
        let bottom = Math.round(winH - ctrlsTop + 20);
        bottom = Math.min(bottom, Math.round(winH - 200 - boxH));
        bottom = Math.max(240, bottom);
        this._adBottom = bottom;
        this.writeAdStyle();
      })
      .exec();
  },

  // 写广告块的内联样式：位置（bottom）+ 尺寸。
  // 尺寸有两态：
  //   · 广告未加载/无填充 → 兜底宽 320rpx + 占位高 200rpx（避免出现大片空白，也避免跳动）
  //   · 广告 bindload 之后 → 用 ad-custom 实测渲染宽高（fitAdToContent() 写进 _adFitW/_adFitH），
  //     把占位收掉：容器边界 = 广告内容边界，广告下方不再留「比广告高的透明占位」
  writeAdStyle() {
    if (this.data.isTeacher) return;
    const w = this._adFitW || AD_BOX_WIDTH_RPX;
    const h = this._adFitH;
    const size = h ? `width:${w}rpx;height:${h}rpx;` : `width:${w}rpx;min-height:${AD_BOX_MIN_HEIGHT_RPX}rpx;`;
    const adStyle = `bottom:${this._adBottom || 480}rpx;${size}`;
    if (adStyle !== this._adStyle) {
      this._adStyle = adStyle;
      this.setData({ adStyle });
    }
  },

  // 广告加载成功（bindload）→ 查一次 ad-custom 实际渲染尺寸，把容器收紧到「紧贴广告」。
  // 这一步解决用户截图的「缝隙」：写死的 320×260 比广告实际渲染大时，
  // 广告右侧/下方会露出容器的透明空白。量的到就用实测值，量不到继续用兜底（不跳动）。
  fitAdToContent() {
    if (this.data.isTeacher || this._adFitting || !wx.createSelectorQuery) return;
    const info = (wx.getWindowInfo && wx.getWindowInfo()) || (wx.getSystemInfoSync && wx.getSystemInfoSync()) || null;
    const vw = (info && info.windowWidth) || 375;
    this._adFitting = true;
    wx.createSelectorQuery()
      .in(this)
      .select('.run-ad-ad')
      .boundingClientRect((rect) => {
        this._adFitting = false;
        if (!rect) return;
        const pw = Math.round((rect.width * 750) / vw);
        const ph = Math.round((rect.height * 750) / vw);
        if (ph >= 20) this._adFitH = ph;
        // 宽度量到异常值（0 / 极小 / 比容器还宽）就不采用，继续用兜底宽
        if (pw >= AD_BOX_WIDTH_MIN_RPX && pw <= AD_BOX_WIDTH_MAX_RPX) this._adFitW = pw;
        this.writeAdStyle();
        // 尺寸变了 → 上沿位置跟着变，重算一次 bottom（保证块 top ≥ 200rpx 的约束仍然成立）
        this.measureAd();
      })
      .exec();
  },

  // 先确认角色，再决定是否进入跑步流程
  async bootstrap() {
    const isTeacher = await this.syncRole();
    // 教师账号不参与运动记录，停在此页提示
    if (isTeacher) {
      this.applyState('idle');
      return;
    }
    // 角色已确认：这里才允许测量 / 定位侧边广告（教师路径不测量，见 measureAd 首行）
    this.measureAd();
    // tab 页常驻：回到本页时若未开始跑步，刷新一次定位与状态提示
    if (this.data.state === 'idle' || this.data.state === 'finished') {
      this.applyState('idle');
      if (!this.data.locationReady) this.initLocation();
    } else {
      this.applyState(this.data.state);
    }
  },

  // 角色（教师不参与运动记录）
  async syncRole() {
    try {
      await getApp().ensureLogin();
    } catch (e) {
      // 未配置后端时忽略，按学生处理
    }
    const app = getApp();
    const user = (app.globalData && app.globalData.userInfo) || null;
    const isTeacher = !!(user && user.role === 'teacher');
    this._roleKnown = true; // 角色已确认 → 之后 measureAd() 才被放行（教师路径永远不放行）
    this.setData({ isTeacher, showAd: !!(user && user.role) && !isTeacher });
    // 角色还没拿到（首启时 globalData.userInfo 为空）→ 走统一的按需角色查询（每次启动最多一次，
    // 内部就是 /api/auth/me）；拿到后再写一次闸门，避免「本地缓存的旧角色」放行教师广告
    if (!user || !user.role) app.applyAdGate(this);
    return isTeacher;
  },

  // 自定义 tabBar 选中态
  syncTabBar() {
    if (typeof this.getTabBar !== 'function') return;
    const bar = this.getTabBar();
    if (bar && typeof bar.setActive === 'function') bar.setActive('/pages/run/index');
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' });
  },

  // 统一维护状态与状态文案
  applyState(state) {
    const map = { idle: '准备就绪', running: '跑步中', paused: '已暂停', finished: '已结束' };
    // setData 回调里复测：三种状态的控制区高度不同（大按钮 / 两个圆按钮），锚点跟着走
    this.setData({ state, stateText: map[state] || '准备就绪' }, () => this.measureAd());
  },


  onUnload() {
    this.stopTimer();
    this.stopLocationUpdate();
  },

  onHide() {
    if (this.data.state === 'running') {
      wx.showToast({ title: '跑步仍在进行中', icon: 'none' });
    }
  },

  initLocation() {
    wx.getLocation({
      type: 'gcj02',
      success: (res) => {
        this.setData({ latitude: res.latitude, longitude: res.longitude, locationReady: true });
      },
      fail: () => {
        wx.showModal({
          title: '需要位置权限',
          content: 'GPS 实跑需要获取您的位置信息，请在设置中开启',
          confirmText: '去设置',
          success: (r) => {
            if (r.confirm) wx.openSetting();
          },
        });
      },
    });
  },

  startLocationUpdate() {
    wx.startLocationUpdate({
      success: () => {
        wx.onLocationChange(this.onLocationChange.bind(this));
      },
      fail: (e) => {
        wx.showToast({ title: '定位启动失败：' + (e.errMsg || ''), icon: 'none' });
      },
    });
  },

  stopLocationUpdate() {
    try {
      wx.offLocationChange();
      wx.stopLocationUpdate();
    } catch (e) {
      /* 忽略 */
    }
  },

  onLocationChange(res) {
    if (this.data.state !== 'running') return;
    const { latitude, longitude } = res;
    const last = this.lastPoint;
    if (last) {
      const d = haversine(last.latitude, last.longitude, latitude, longitude);
      if (d >= 2 && d < 100) {
        // 过滤漂移
        this.distance += d;
      }
    }
    this.lastPoint = { latitude, longitude };
    this.points.push({ latitude, longitude, timestamp: Date.now() });
    if (this.points.length % 5 === 0 || this.points.length < 10) {
      this.updatePolyline();
    }
  },

  updatePolyline() {
    if (this.points.length < 2) return;
    this.setData({
      polyline: [
        {
          points: this.points,
          color: '#ff6b00',
          width: 6,
          arrowLine: true,
        },
      ],
      latitude: this.points[this.points.length - 1].latitude,
      longitude: this.points[this.points.length - 1].longitude,
    });
  },

  startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => {
      this.seconds += 1;
      this.updateStats();
    }, 1000);
  },

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  updateStats() {
    const paceSeconds = this.distance > 5 ? this.seconds / (this.distance / 1000) : 0;
    const paceText = paceSeconds
      ? `${Math.floor(paceSeconds / 60)}'${String(Math.round(paceSeconds % 60)).padStart(2, '0')}"`
      : "--'--\"";
    this.setData({
      distanceText: `${(this.distance / 1000).toFixed(2)}`,
      durationText: fmt.formatDuration(this.seconds),
      paceText,
    });
  },

  start() {
    if (this.data.isTeacher) {
      wx.showToast({ title: '教师账号不参与运动记录', icon: 'none' });
      return;
    }
    if (!this.data.locationReady) {
      this.initLocation();
      return;
    }
    this.applyState('running');
    this.startTime = Date.now();
    this.startLocationUpdate();
    this.startTimer();
  },

  pause() {
    this.applyState('paused');
    this.stopTimer();
  },

  resume() {
    this.applyState('running');
    this.startTimer();
  },

  finish() {
    if (this.distance < 10) {
      wx.showModal({
        title: '距离过短',
        content: '本次记录不足 10 米，将不会保存',
        showCancel: false,
        success: () => this.reset(),
      });
      return;
    }
    this.applyState('finished');
    this.stopTimer();
    this.stopLocationUpdate();
    this.save();
  },

  async save() {
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中…', mask: true });
    try {
      await getApp().ensureLogin();
      const result = await auth.post('/api/run/gps', {
        distance: Math.round(this.distance),
        durationSeconds: this.seconds,
        startTime: this.startTime ? new Date(this.startTime).toISOString() : undefined,
        endTime: new Date().toISOString(),
        routePoints: this.points.slice(-5000),
        location: '',
      });
      wx.hideLoading();
      if (!this.startTime) this.startTime = Date.now() - this.seconds * 1000;
      // 保存接口（POST /api/run/gps）已返回本次新获得的徽章，无需额外调 /api/badges/check
      const badges = result.newBadges || [];
      const recordId = (result.record && result.record._id) || '';
      // 有徽章 → 先弹带图徽章弹窗（badge-award，与首页同一套组件）；
      // 关掉它之后继续原来的「已保存」框，保留「查看记录」入口
      if (this.showBadgeAward(badges)) {
        this.pendingSave = { recordId };
        return;
      }
      this.showSavedModal(recordId);
    } catch (e) {
      wx.hideLoading();
      if (e.code === 403001) {
        wx.navigateTo({ url: '/pages/banned/banned' });
        return;
      }
      // 限制 GPS 实跑（反作弊/人工）：提示到期时间并引导按类型申诉
      if (e.code === 403004) {
        const r = e.restriction || {};
        wx.showModal({
          title: `${r.text || 'GPS 实跑'}已被限制`,
          content: `${r.reason || '数据异常'}\n解封时间：${r.until ? String(r.until).slice(0, 16).replace('T', ' ') : '永久'}`,
          confirmText: '去申诉',
          cancelText: '知道了',
          success: (res) => {
            if (res.confirm) wx.navigateTo({ url: `/pages/appeal/submit?scope=${r.scope || 'gps'}` });
          },
        });
        this.applyState('paused');
        return;
      }
      wx.showModal({ title: '保存失败', content: e.message, showCancel: false });
      this.applyState('paused');
    } finally {
      this.setData({ saving: false });
    }
  },

  reset() {
    this.points = [];
    this.distance = 0;
    this.seconds = 0;
    this.lastPoint = null;
    this.startTime = null;
    this.setData({ polyline: [], markers: [] });
    this.applyState('idle');
    this.updateStats();
    this.initLocation();
  },

  // ===== 原生模板广告（ad-custom）事件：仅日志 + 加载成功后收紧容器尺寸，无其它副作用 =====
  // 广告加载失败（无填充、开发者工具无广告等）时跑步流程、定位、保存全部照常；
  // 容器退回占位尺寸（不出现大片空白，也不因为广告消失而跳动）。
  adLoad(e) {
    console.log('[run] 原生模板广告加载成功', e && e.detail);
    // 加载成功 → 量一次 ad-custom 实际渲染宽高，把容器从「兜底 320×200」收紧到贴合广告，
    // 消掉广告右侧/下方露出的容器透明空白（用户反馈的「缝隙」）
    this.fitAdToContent();
  },

  adError(e) {
    console.error('[run] 原生模板广告加载失败', e && e.detail);
  },

  adClose() {
    // 用户关掉广告后平台会收回 ad-custom 的高度 → 回到占位尺寸，避免面板上方出现空洞/跳动
    this._adFitW = 0;
    this._adFitH = 0;
    this.writeAdStyle();
    console.log('[run] 原生模板广告已关闭');
  },

  // ===== 获得徽章弹窗（与首页 pages/home 用同一个 badge-award 组件） =====
  // 返回 true 表示带图弹窗已展示（随后由 closeBadgeAward 接回「已保存」框）。
  showBadgeAward(newBadges) {
    const list = newBadges || [];
    if (!list.length) return false;
    // 教师账号不参与运动记录，也就不会弹徽章
    if (this.data.isTeacher) return false;
    // 同一次会话只弹一次（与首页 checkBadges 共用一个标记：首页弹过这里也不再弹）
    const app = getApp();
    if (app.globalData.badgePopupShown) return false;
    app.globalData.badgePopupShown = true;
    this.setData({ badgeAward: { visible: true, badges: list } });
    return true;
  },

  // 保存成功提示（保留原来的「查看记录」入口；徽章名已交给带图弹窗，不再拼进文案）
  showSavedModal(recordId) {
    wx.showModal({
      title: '已保存',
      content: `${this.data.distanceText} km · ${this.data.durationText}`,
      confirmText: '查看记录',
      cancelText: '返回',
      success: (r) => {
        if (r.confirm && recordId) wx.navigateTo({ url: `/pages/run/detail?id=${recordId}` });
        this.reset();
      },
    });
  },

  // 知道了 / 下滑 / 点遮罩：关掉徽章弹窗后接着弹「已保存」框
  closeBadgeAward() {
    const pending = this.pendingSave;
    this.pendingSave = null;
    this.setData({ badgeAward: { visible: false, badges: [] } });
    if (pending) this.showSavedModal(pending.recordId);
  },

  // 去看我的徽章：只关弹窗并跳转，不再追加「已保存」框（否则会盖在徽章页上）
  goBadgesFromAward() {
    this.pendingSave = null;
    this.setData({ badgeAward: { visible: false, badges: [] } });
    wx.navigateTo({ url: '/pages/badges/badges' });
  },
});
