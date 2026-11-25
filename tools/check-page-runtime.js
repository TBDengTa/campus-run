/**
 * 检查器：小程序页面「运行时自检」——在桩环境里真实执行页面 JS 的关键方法。
 *
 * 为什么必须有它（2026-11-12 线上事故）：
 *   北斗运动页把 `const earned` 改名成 `const e` 时，setData 里还留着简写 `earned,`
 *   → 运行时 ReferenceError: earned is not defined → **整页转盘空白、只弹一个 toast**。
 *   而当时所有检查器都是绿的：
 *     · `node --check` / `check-miniprogram` 的 vm.Script —— 这是**运行时**错误，语法完全合法；
 *     · `check-page-data-keys` —— 只验「WXML 引用的键在 JS 里有没有出现过」，
 *       而 `earned` 在 `data:` 块里声明过，所以它认为没问题；
 *       它看不到「setData 里那个变量的值是 undefined」。
 *   也就是说：**语法检查 + 键名检查都天然看不见这一类错误**，只有真正执行才会暴露。
 *
 * 本检查器的做法：用 vm 在桩环境里跑页面 JS，拿到 Page({...}) 定义，
 * 构造假页面实例（setData 合并 data），再用**真实接口形态**的 payload 调关键方法。
 * 覆盖三件事：
 *   ① 首屏 applyState 不抛（含最小 payload 兜底：新用户首日字段大量缺失）；
 *   ② 抽奖结果 applyDrawResult 不抛，且已入账数字真的刷新了；
 *   ③ 转盘停位角度精确等于 (360 − (index*45 + 22.5))° —— 差半格就会「停在 A 却发 B」。
 *
 * 新增页面若要纳入自检，在 TARGETS 里加一条即可（桩不需要写得多全，缺的全局变量补进 BASE_SANDBOX）。
 *
 * 运行：node tools/check-page-runtime.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const M = path.join(__dirname, '..', 'miniprogram');

let failed = 0;
function ok(cond, label, extra) {
  console.log(`${cond ? '  ok   ' : '  FAIL '}${label}${cond ? '' : '  -> ' + JSON.stringify(extra)}`);
  if (!cond) failed += 1;
}

// 桩环境里可用的全局（页面 JS 里用到的标准库都要显式给，vm 上下文不是完整的 node 全局）
const BASE_SANDBOX = {
  console: { log() {}, warn() {}, error() {} },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  Math,
  JSON,
  String,
  Number,
  Boolean,
  Array,
  Object,
  Promise,
  parseInt,
  parseFloat,
  isNaN,
};

// 通用 require 桩：页面里常引 utils/*，这里给最小可用实现（只求「不抛」）
// ⚠️ utils/format **必须加载真实模块**：它是纯函数、没有 wx 依赖，
//   而页面新用的 fmt.scoreText 一旦在桩里缺席，就会把「页面缺函数」误报成「桩缺函数」，
//   或者更糟：桩里手写一个简化版，页面用了真实版才有的行为，检查就永远绿着。
function makeRequire(state = { get: async () => ({}) }) {
  return function stubRequire(p) {
    if (p.includes('utils/request')) {
      return {
        getUser: () => ({ role: 'student', name: '张三' }),
        // state.get 可被用例替换：让页面走「真实接口形态」的 payload，而不是空对象
        get: (url, params) => state.get(url, params),
        post: async () => ({}),
        put: async () => ({}),
        isBound: () => true,
        // 水印相机链路（packageUnion/entry）：成功回 URL 并记录调用，
        // entry 的 appendWatermarkPhotos → uploadPending 用例靠它走通「pending → done」
        uploadCheckPhoto: async (filePath, opts) => {
          state.uploads = state.uploads || [];
          state.uploads.push(filePath);
          // 用例注入失败：断言「失败原因真的到了界面上」
          if (state.uploadFailMsg) {
            const e = new Error(state.uploadFailMsg);
            if (state.uploadFailCode) e.code = state.uploadFailCode;
            throw e;
          }
          if (opts && opts.onProgress) opts.onProgress(100);
          return { url: `https://files.test/${state.uploads.length}.jpg` };
        },
        // 下载并打开文件（2026-11-20 班级状态导出）：记录 (url, opts)；
        // 用例可注入 state.downloadResult / state.downloadFail 覆盖成功与各失败分支。
        downloadAndOpen: async (url, opts) => {
          state.downloads = state.downloads || [];
          state.downloads.push({ url, opts });
          if (state.downloadFail) {
            const f = state.downloadFail;
            throw f instanceof Error ? f : Object.assign(new Error(String(f)), f);
          }
          return state.downloadResult || { filePath: 'wxfile://usr/tt-export.csv', fileName: 'tt-export.csv', saved: true, via: 'open' };
        },
      };
    }
    if (p.includes('utils/format')) return require(path.join(M, 'utils/format.js'));
    // utils/watermark 是纯函数（只依赖 utils/format），必须加载真实模块：
    // 桩成 {} 会让 wcamera 的 buildLines/computeLayout 全部 TypeError（「桩缺函数」误报成页面 bug）
    if (p.includes('utils/watermark')) return require(path.join(M, 'utils/watermark.js'));
    // utils/period 同样是纯函数（日期区间文案），class.js 的 loadBanchao 会调它 ——
    // 桩成 {} 会让「period.dateRangeText is not a function」变成用例里的假失败。
    if (p.includes('utils/period')) return require(path.join(M, 'utils/period.js'));
    // utils/sfx：**纯函数合成 + 有副作用但全静默**。这里用真实实现（它在没有 wx 文件系统时
    // 会安全返回 false），而不是桩成 {} —— 桩成 {} 会让页面里的 sfx.play 变成
    // "sfx.play is not a function"，把「桩缺函数」误报成「页面有 bug」。
    // require 进来的真实模块在 node 下 play() 一定返回 false，但**不会抛**，正好测降级路径。
    if (p.includes('utils/sfx')) return require(path.join(M, 'utils/sfx.js'));
    // ./section（配置子页共享逻辑）：它自己会 require utils/request 并调 ensureLogin/refreshUser，
    // 在桩环境里跑通它没有意义（要真登录态）。这里给一组空实现：
    // 管理页的用例**直接调 loadDraws 等方法**，不经过 section.onShow，所以桩只需要「存在」。
    if (p.includes('./section')) {
      return {
        checkAndLoad: async () => {},
        load: async () => {},
        save: async () => {},
        onShow: () => {},
      };
    }
    return {};
  };
}

// 最近一次 toast：用例要断言「提示文案是服务端下发的」就必须看到它
let lastToast = null;
// 最近一次 wx.previewImage（2026-11-20 班超记录卡片照片预览）：用例要断言 urls/current 两参
let lastPreviewImage = null;
// 最近一次 wx.showModal（导出失败的分档文案：无权限 / 网络 / 保存 / 打开）
let lastModal = null;
// showActionSheet 桩（2026-11-20 班级状态导出的窗口选择）：默认「用户取消」，
// 这是真实会发生的分支（取消不是失败，不能弹错）。用例内部替换成「选第 N 项」。
let showActionSheetImpl = (o) => o && o.fail && o.fail({ errMsg: 'showActionSheet:fail cancel' });

// 相机 / 导航 / 文件系统桩（水印相机用例）：默认 no-op，用例临时替换
// （WX_STUB 是全部 target 共享的单例，不能整体换掉 —— 换成 hook 委托互不干扰）
let navigateToImpl = () => {};
let chooseMediaImpl = () => {};
let openSettingImpl = () => {};
let cameraContextImpl = () => null;
let getImageInfoImpl = (o) => o && o.fail && o.fail({ errMsg: 'getImageInfo:fail 桩未配置' });
let canvasToTempFilePathImpl = (o) => o && o.fail && o.fail({ errMsg: 'canvasToTempFilePath:fail 桩未配置' });
let selectorQueryImpl = () => ({ in: () => ({ select: () => ({ fields: () => ({ exec: (cb) => cb([]) }) }) }) });
// 窗口信息 / 转屏（wcamera 横屏接线）与成片体积（体积闭环用例）的桩；
// 用例临时替换，结束必须复位（后面的 entry 用例依赖默认 size 12345）
let winInfoStub = { statusBarHeight: 44, windowWidth: 375, windowHeight: 812 };
const resizeHandlers = [];
let fileInfoSize = 12345;
// getFileInfo 失败桩：体积闭环的「读不到体积不许当通过」（fail-open 回归）
let fileInfoFails = false;
// 最近一次 canvasToTempFilePath 的完整参数（断言 destWidth/destHeight 显式给了画布像素）
let lastCanvasExportOpts = null;
// 合成产物落盘（copyFile → 用户目录）桩：默认成功；可注入失败验证回退
let copyFileFails = false;
let copyFileCalls = 0;

const WX_STUB = {
  showToast(o) {
    lastToast = o || null;
  },
  // showModal 必须回调 success：wcamera 合成失败走「弹窗确认 → 退回原图入托盘」，
  // 桩不回调 success 这条降级路径就永远测不到（上面 2026-11-12 事故同类：桩缺行为 = 假绿灯）
  showModal(o) {
    lastModal = o || null;
    if (o && o.success) o.success({ confirm: true });
  },
  showLoading() {},
  hideLoading() {},
  navigateBack() {},
  navigateTo(o) {
    navigateToImpl(o);
  },
  reLaunch() {},
  switchTab() {},
  pageScrollTo() {},
  vibrateShort() {},
  setClipboardData() {},
  // 页面切换班级时会改标题（class.js::switchClass）；缺桩会 TypeError，被误报成页面 bug
  setNavigationBarTitle() {},
  // 2026-11-20：班超记录卡片照片预览（catch:tap → previewPhoto）
  previewImage(o) {
    lastPreviewImage = o || null;
  },
  // 2026-11-20：班级状态「导出」的窗口选择（本周/本月）
  showActionSheet(o) {
    showActionSheetImpl(o);
  },
  chooseMedia(o) {
    chooseMediaImpl(o);
  },
  openSetting(o) {
    openSettingImpl(o);
  },
  createCameraContext() {
    return cameraContextImpl();
  },
  getImageInfo(o) {
    getImageInfoImpl(o);
  },
  canvasToTempFilePath(o) {
    lastCanvasExportOpts = o;
    canvasToTempFilePathImpl(o);
  },
  createSelectorQuery() {
    return selectorQueryImpl();
  },
  getFileSystemManager() {
    return {
      // 桩回可配置 size：entry.appendWatermarkPhotos 靠它补 size，wcamera 体积闭环靠它判档
      // 路径里含 gone/missing 的一律 fail：模拟「临时文件已被系统清理」
      getFileInfo: (o) => {
        const p = String((o && o.filePath) || '');
        if (fileInfoFails || /gone|missing/.test(p)) {
          if (o && o.fail) o.fail({ errMsg: 'getFileInfo:fail 文件不存在' });
          return;
        }
        if (o && o.success) o.success({ size: fileInfoSize });
      },
      // 合成产物落盘（canvas 临时文件 →copy→ 用户目录）：
      // 微信明确「临时文件随时可能被系统清理」，而上传发生在相机页销毁之后，
      // 所以必须留一份稳定副本；但**用 copyFile 不用 saveFile**（saveFile 是移动，
      // 副本读不到时就没有退路）。两条路径一起回传，上传前由 entry 验证哪份还在。
      copyFile: (o) => {
        copyFileCalls += 1;
        if (copyFileFails) {
          if (o && o.fail) o.fail({ errMsg: 'copyFile:fail 桩制造落盘失败' });
          return;
        }
        if (o && o.success) o.success({});
      },
      // 过期清理：默认空目录（用例只验证「调了、不抛」）
      readdir: (o) => o && o.success && o.success({ files: [] }),
      stat: (o) => o && o.success && o.success({ lastModifiedTime: Math.floor(Date.now() / 1000) }),
      unlink: (o) => o && o.success && o.success({}),
    };
  },
  // 用户目录（saveFile 的目标目录；真实环境由微信注入）
  env: { USER_DATA_PATH: 'wxfile://usr' },
  getWindowInfo: () => ({ ...winInfoStub }),
  onWindowResize: (cb) => {
    if (typeof cb === 'function') resizeHandlers.push(cb);
  },
  offWindowResize: (cb) => {
    const i = resizeHandlers.indexOf(cb);
    if (i >= 0) resizeHandlers.splice(i, 1);
  },
  createRewardedVideoAd: () => ({
    onLoad() {}, onError() {}, onClose() {}, show: () => Promise.resolve(), load: () => Promise.resolve(),
  }),
  createInterstitialAd: () => ({ onLoad() {}, onError() {}, onClose() {}, show: () => Promise.resolve() }),
};

const APP_STUB = {
  requireLogin: () => true,
  ensureLogin: async () => ({ role: 'student' }),
  refreshUser: async () => ({ role: 'student' }),
  globalData: { userInfo: { role: 'student' } },
  applyAdGate() {},
};

/** 在桩环境里跑页面 JS，返回 Page({...}) 的定义 */
function loadPage(relPath, state = { get: async () => ({}) }) {
  const file = path.join(M, relPath);
  const src = fs.readFileSync(file, 'utf8');
  let captured = null;
  const sandbox = Object.assign({}, BASE_SANDBOX, {
    module: { exports: {} },
    require: makeRequire(state),
    wx: WX_STUB,
    getApp: () => APP_STUB,
    Page: (def) => {
      captured = def;
    },
    Component: () => {},
    Behavior: (b) => b,
  });
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: file });
  if (!captured) throw new Error(`${relPath}: 未捕获到 Page 定义`);
  return captured;
}

/** 造一个假页面实例：setData 合并进 data（与小程序运行时同语义） */
function makePage(def) {
  const page = Object.assign({}, def);
  page.data = JSON.parse(JSON.stringify(def.data || {}));
  // ⚠️ 必须执行第二个参数 callback：仓库里大量页面写成 `this.setData({...}, () => this.load())`
  //   （窗口切换、筛选、批量选择都走这个形态）。桩里忽略 callback 的话，
  //   「点了没发请求」这类真 bug 会被**静默跳过** —— 用例只是没测到，而不是测过了。
  //
  // ⚠️ 必须支持 `'a.b'` 点路径（与微信 setData 同语义）：仓库里 55 处、20+ 页面在用
  //   （`form.xxx` / `config.xxx` / `drawFilter.xxx`）。早先这里只写 `this.data[k]=patch[k]`，
  //   于是 `setData({'drawFilter.source': 'video'})` 会凭空造出一个**顶层键** `"drawFilter.source"`，
  //   而 `data.drawFilter.source` 永远是初始值 —— 用例读它就读不到，
  //   轻则假失败，重则「断言的是没被改的那个对象」而假通过。
  page.setData = function (patch, cb) {
    for (const k of Object.keys(patch)) assignPath(this.data, k, patch[k]);
    if (cb) cb();
  };
  return page;
}

/**
 * 按微信 setData 的语义赋值：键里含 `.` 或 `[n]` 时写进嵌套路径，否则写顶层键。
 * 路径中间缺失时补成对象（微信在父级不存在时同样是建出来再写）。
 */
function assignPath(root, key, value) {
  if (!/[.[]/.test(key)) {
    root[key] = value;
    return;
  }
  const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.').filter((s) => s !== '');
  let node = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const seg = parts[i];
    if (node[seg] === null || typeof node[seg] !== 'object') node[seg] = {};
    node = node[seg];
  }
  node[parts[parts.length - 1]] = value;
}

// 用例的 auth.get 替身：默认回空对象，用例可整体替换（state.get = async () => payload）
const DEFAULT_STATE = () => ({ get: async () => ({}) });

// ===== 目标页面与用例 =====
const TARGETS = [
  {
    file: 'pages/reward/reward.js',
    name: '北斗运动页',
    // async：中奖弹层「停留时长」那条用例要真等 800ms 才能验证「没被提前关掉」
    async run(def) {
      // ---- ① 首屏 applyState：真实接口形态 ----
      const page = makePage(def);
      const payload = {
        enabled: true,
        date: '2026-11-12',
        coin: {
          name: '铜版', balance: 88, earnedToday: 12, spentToday: 4, gameEarnedToday: 6,
          dailyGameCap: 200, gameCapLeft: 194, gameCapReached: false,
        },
        video: { enabled: true, coinPerWatch: 1, drawPerWatch: 0, dailyLimit: 10, adUnitId: '', count: 2, remaining: 8 },
        share: {
          enabled: true, coinPerClick: 1, drawPerShare: 0, dailyLimit: 3, count: 1, remaining: 2,
          rewardedToday: 1, clicksToday: 1, token: 'abc123abc123abc1', path: '/pages/splash/splash?bdshare=abc123abc123abc1',
        },
        checkin: {
          enabled: true,
          done: false,
          streak: 2,
          todayIndex: 2,
          milestones: [
            { coin: 1, draw: 0, steps: 0 }, { coin: 1, draw: 0, steps: 0 }, { coin: 1, draw: 0, steps: 0 },
            { coin: 1, draw: 0, steps: 0 }, { coin: 1, draw: 0, steps: 0 }, { coin: 1, draw: 0, steps: 0 }, { coin: 1, draw: 0, steps: 0 },
          ],
          award: { coin: 0, draw: 0, steps: 0 },
        },
        draw: {
          remaining: 3, unlimited: true, total: 5, used: 2, maxPerDay: 0, cost: 5,
          pity: { after: 5, losses: 2, remaining: 3, ready: false, text: '再抽 3 次必中保底' },
          prizes: [
            { key: 'coin_2', label: '2 铜版', type: 'coin', amount: 2, weight: 30, percent: 30, tier: 'low' },
            { key: 'none', label: '谢谢参与', type: 'none', amount: 0, weight: 70, percent: 70, tier: 'none' },
          ],
          sectors: ['coin_2', 'none', 'coin_2', 'none', 'coin_2', 'none', 'coin_2', 'none'],
          sectorCount: 8,
        },
        grid: {
          enabled: true, cost: 6, canPlay: true, playsToday: 1, maxPerDay: 0,
          pity: { after: 5, losses: 1, remaining: 4, ready: false, text: '再抽 4 次必中保底' },
          symbols: [
            { key: 'star', label: '星星', icon: '⭐', type: 'coin', amount: 3, tier: 'low' },
            { key: 'blank', label: '空白', icon: '▫', type: 'none', amount: 0, tier: 'none' },
          ],
          outcomes: [
            { key: 'none', label: '没有连线', lines: 0, symbolKey: '', weight: 60, percent: 60 },
            { key: 'line_star', label: '星星连线', lines: 1, symbolKey: 'star', weight: 40, percent: 40 },
          ],
        },
        cap: { cap: 3000, used: 300, left: 2700, capped: false },
        earned: { steps: 300, distance: 210, calories: 12, durationSeconds: 150 },
        rarityText: '最低概率奖：2 铜版 30% · 最高：谢谢参与 70%',
        sfxEnabled: true,
        recent: [{ prizeKey: 'coin_2', prizeLabel: '2 铜版', game: 'wheel', type: 'coin', amount: 2, capped: false, atText: '09:12' }],
      };
      try {
        page.applyState(payload);
        ok(true, 'applyState 执行无异常（首屏不会白屏）');
      } catch (e) {
        ok(false, 'applyState 执行无异常（首屏不会白屏）', e.message);
      }
      ok(page.data.earned && page.data.earned.steps === 300, 'earned 正确写入 data', page.data.earned);
      ok(String(page.data.earnedLine || '').indexOf('300') >= 0, 'earnedLine 已拼好（含步数）', page.data.earnedLine);
      ok(Array.isArray(page.data.sectors) && page.data.sectors.length === 8, 'sectors 渲染 8 格', (page.data.sectors || []).length);
      // 转盘已从 conic-gradient 改为 clip-path 8 楔形（安卓兼容）
      ok(
        page.data.sectors.every((s) => typeof s.clip === 'string' && s.clip.indexOf('polygon(') === 0),
        '每格都有 clip-path polygon（盘面不会渲染成纯色）',
        page.data.sectors[0] && page.data.sectors[0].clip
      );
      ok(page.data.wheel.remaining === 3, 'wheel.remaining = 3', page.data.wheel.remaining);
      ok(String(page.data.capText || '').indexOf('2700') >= 0, 'capText 含剩余额度', page.data.capText);
      ok(String(page.data.rarityText || '').indexOf('最低概率') >= 0, '概率区间文案已下发（折叠时也能看到）', page.data.rarityText);
      ok(page.data.coin.balance === 88, '铜版余额写入 data', page.data.coin);
      ok(page.data.grid.cost === 6 && page.data.grid.symbols.length === 2, '九宫格配置写入 data', page.data.grid);
      ok(/bdshare=/.test(page.data.share.path), '分享路径带 bdshare 令牌', page.data.share.path);
      ok(page.data.checkin.cells.length === 7, '签到 7 格', page.data.checkin.cells.length);
      ok(
        page.data.checkin.cells.filter((c) => c.signed).length === 2,
        '连签 2 天 → 2 格打勾',
        page.data.checkin.cells.filter((c) => c.signed).length
      );
      ok(page.data.checkin.cells.some((c) => c.isToday), '有「今天」高亮格');
      // 每个签到格都必须写清「给多少铜版」，不能是空奖励
      const c3 = page.data.checkin.cells[2];
      ok(c3.rewardCoinText === '+1' && /铜版/.test(c3.rewardText), '签到格写清 +1 铜版', c3);
      ok(
        page.data.checkin.cells.every((c) => c.rewardCoinText || c.rewardText),
        '每个格子都至少写了一个奖励',
        page.data.checkin.cells.map((c) => [c.rewardCoinText, c.rewardText])
      );
      ok(
        // 反向断言：格子里不许再出现那个占位大字
        !/'大' : ''/.test(require('fs').readFileSync(
          require('path').join(__dirname, '..', 'miniprogram', 'pages', 'reward', 'reward.wxml'), 'utf8'
        )),
        '格子不再用「大」字占位',
        true
      );

      // ---- ①b 播报 ----
      page.applyFeed({
        items: [
          { nameMasked: '陈**', prizeLabel: '1500 步', rarity: 'rarest', atText: '09:20', isMine: false },
          { nameMasked: '李**', prizeLabel: '100 步', rarity: 'normal', atText: '09:18', isMine: false },
        ],
      });
      ok(page.data.feed.length === 2, '播报数据写入', page.data.feed.length);
      ok(page.data.feed[0].nameMasked === '陈**', '播报名字是脱敏串（直接来自服务端）', page.data.feed[0].nameMasked);
      // 空数据 → 空态，不留白条
      page.applyFeed({ items: [] });
      ok(page.data.feed.length === 0 && !!page.data.feedEmptyText, '播报空态有兜底文案', page.data.feedEmptyText);
      page.applyFeed({ items: [{ nameMasked: '陈**', prizeLabel: '1500 步', rarity: 'rarest', atText: '09:20' }] });

      // ---- ② 抽奖结果（三档动效都跑一遍）----
      const drawPayload = (rarity, prize) => ({
        success: true, index: 0, rarity,
        prize,
        capped: false, coinCapped: false, pity: false, cost: 5,
        coin: { name: '铜版', balance: 90, earnedToday: 14, spentToday: 9, gameEarnedToday: 8, dailyGameCap: 200, gameCapLeft: 192, gameCapReached: false },
        remaining: 2, unlimited: true, total: 5, used: 3,
        earned: { steps: 400, distance: 280, calories: 16, durationSeconds: 200 },
        cap: { cap: 3000, used: 400, left: 2600, capped: false },
        newBadges: [],
      });
      const cases = [
        ['normal', { key: 'coin_2', label: '2 铜版', type: 'coin', amount: 2 }, 'normal'],
        ['rare', { key: 'steps_800', label: '800 步', type: 'steps', amount: 800 }, 'rare'],
        ['rarest', { key: 'steps_1500', label: '1500 步', type: 'steps', amount: 1500 }, 'rarest'],
        ['none', { key: 'none', label: '谢谢参与', type: 'none', amount: 0 }, 'normal'],
      ];
      for (const [rarity, prize] of cases) {
        try {
          page.applyDrawResult(drawPayload(rarity, prize));
          ok(true, `applyDrawResult(${rarity}) 执行无异常`);
        } catch (e) {
          ok(false, `applyDrawResult(${rarity}) 执行无异常`, e.message);
        }
        const expectFx = rarity === 'none' ? 'normal' : rarity;
        ok(page.data.fx === expectFx, `动效档位与稀有度对齐（${rarity} → ${expectFx}）`, page.data.fx);
        if (rarity === 'rarest') {
          ok(page.data.confetti.length === 20, '最稀有彩带 20（全档最多）', page.data.confetti.length);
        } else if (rarity === 'none') {
          ok(page.data.confetti.length === 0, '空奖无彩带（克制）', page.data.confetti.length);
        } else {
          ok(page.data.confetti.length > 0, `全档炸裂：${rarity} 也有彩带`, page.data.confetti.length);
        }
        // 每轮都校验 lastPrize 跟着当前这一档走（别把断言放在循环外——最后一轮会覆盖前面的值）
        ok(
          page.data.lastPrize && String(page.data.lastPrize.text || '').indexOf(prize.label.split(' ')[0]) >= 0,
          `${rarity} 的 lastPrize 文案用当前下发的 prize（不是上一轮的残留）`,
          page.data.lastPrize && page.data.lastPrize.text
        );
      }
      ok(String(page.data.earnedLine || '').indexOf('400') >= 0, '抽奖后已入账刷新为 400', page.data.earnedLine);
      // 音效模块在 node 下必然不可用 —— 关键断言是「不可用时抽奖仍然成功落盘」
      ok(!!page.data.lastPrize, '音效不可用时抽奖仍正常落盘（音效绝不阻塞入账）');

      // ---- ②b 九宫格卷轴：停位严格 = 服务端 board，win 只来自服务端 lines ----
      // 桩里没有 CSS transition/transitionend —— 停轴由兜底 setTimeout 权威驱动（与真机降级路径同构）。
      const gridPayload = {
        success: true, duplicated: false, game: 'grid', playId: 'g1',
        board: [
          { symbolKey: 'star', icon: '⭐', iconUrl: '', label: '星星', type: 'coin', amount: 3 },
          { symbolKey: 'star', icon: '⭐', iconUrl: '', label: '星星', type: 'coin', amount: 3 },
          { symbolKey: 'star', icon: '⭐', iconUrl: '', label: '星星', type: 'coin', amount: 3 },
          { symbolKey: 'foot', icon: '👣', iconUrl: '', label: '足迹', type: 'steps', amount: 100 },
          { symbolKey: 'foot', icon: '👣', iconUrl: '', label: '足迹', type: 'steps', amount: 100 },
          { symbolKey: 'foot', icon: '👣', iconUrl: '', label: '足迹', type: 'steps', amount: 100 },
          { symbolKey: 'blank', icon: '▫', iconUrl: '', label: '空白', type: 'none', amount: 0 },
          { symbolKey: 'blank', icon: '▫', iconUrl: '', label: '空白', type: 'none', amount: 0 },
          { symbolKey: 'blank', icon: '▫', iconUrl: '', label: '空白', type: 'none', amount: 0 },
        ],
        lines: [
          { key: 'row0', label: '第 1 行', symbolKey: 'star', cells: [0, 1, 2], prizeText: '第 1 行 · 星星 +3 铜版' },
          { key: 'row1', label: '第 2 行', symbolKey: 'foot', cells: [3, 4, 5], prizeText: '第 2 行 · 足迹 +100 步' },
        ],
        rewards: [
          { symbolKey: 'star', label: '星星', type: 'coin', lines: 1, singleAmount: 3, amount: 3, tier: 'low' },
          { symbolKey: 'foot', label: '足迹', type: 'steps', lines: 1, singleAmount: 100, amount: 100, tier: 'mid' },
        ],
        coinAmount: 3,
        stepsAmount: 100,
        rewardText: '星星 1 线 · +3 铜版；足迹 1 线 · +100 步',
        prize: { key: 'star', label: '星星 1 线 · +3 铜版；足迹 1 线 · +100 步', type: 'mixed', amount: 3, lines: 2, percent: 40, tier: 'high' },
        capped: false, coinCapped: false, pity: false, rarity: 'rarest', cost: 6,
        coin: { name: '铜版', iconUrl: '', balance: 87, earnedToday: 17, spentToday: 15, gameEarnedToday: 11, dailyGameCap: 200, gameCapLeft: 189, gameCapReached: false },
        earned: { steps: 500, distance: 350, calories: 20, durationSeconds: 250 },
      };
      try {
        page.applyGridResult(gridPayload);
        ok(page.data.grid.cells.length === 9, '九宫格 9 格渲染', page.data.grid.cells.length);
        ok(page.data.grid.revealing === true, '卷轴滚动中（按钮禁用）', page.data.grid.revealing);
        ok(page.data.grid.reels.length === 3, '装带 3 列卷轴', page.data.grid.reels.length);
        // 停位 = board：每列末 3 帧严格等于 board 该列 3 格（board 行主序，列 c 取 c/c+3/c+6）
        const allowedKeys = new Set([
          ...gridPayload.board.map((b) => b.symbolKey),
          ...page.data.grid.symbols.map((s) => s.symbolKey || s.key),
        ]);
        for (let c = 0; c < 3; c += 1) {
          const reel = page.data.grid.reels[c];
          const decor = 16 + 8 * c;
          ok(reel.frames.length === decor + 3, `第 ${c + 1} 列帧数 = 装饰 ${decor} + 终态 3`, reel.frames.length);
          const tail = reel.frames.slice(-3);
          for (let r = 0; r < 3; r += 1) {
            const want = gridPayload.board[c + r * 3];
            ok(
              tail[r].symbolKey === want.symbolKey && tail[r].icon === want.icon && tail[r].label === want.label && tail[r].type === want.type,
              `第 ${c + 1} 列停位第 ${r + 1} 帧 = board[${c + r * 3}]（前端不自抽）`,
              { got: tail[r], want }
            );
          }
          ok(reel.frames.every((f) => allowedKeys.has(f.symbolKey)), `第 ${c + 1} 列装饰帧只来自 symbols/board 候选`, reel.frames.map((f) => f.symbolKey));
          ok(reel.offsetRpx === 0, `第 ${c + 1} 列第一拍 offset=0（两拍启动才有过渡）`, reel.offsetRpx);
        }
      } catch (e) {
        ok(false, 'applyGridResult 执行无异常', e.message);
      }
      await new Promise((r) => setTimeout(r, 200));
      for (let c = 0; c < 3; c += 1) {
        ok(page.data.grid.reels[c].offsetRpx === (16 + 8 * c) * 160, `第 ${c + 1} 列目标偏移 = 装饰帧数×160rpx`, page.data.grid.reels[c].offsetRpx);
      }
      ok(
        page.data.grid.reels[0].durationMs < page.data.grid.reels[1].durationMs && page.data.grid.reels[1].durationMs < page.data.grid.reels[2].durationMs,
        '三列时长严格递增（逐列减速停）',
        page.data.grid.reels.map((r) => r.durationMs)
      );
      await new Promise((r) => setTimeout(r, 1300));
      ok([0, 3, 6].every((i) => page.data.grid.cells[i].revealed), '首列停轴 = 该列 3 格 revealed', page.data.grid.cells.map((c) => c.revealed));
      ok([1, 4, 7, 2, 5, 8].every((i) => !page.data.grid.cells[i].revealed), '其余两列尚未停（stagger 生效）', page.data.grid.cells.map((c) => c.revealed));
      ok(page.data.grid.revealing === true, '未全部停稳前仍禁点', page.data.grid.revealing);
      await new Promise((r) => setTimeout(r, 1500));
      ok(page.data.grid.revealing === false, '三列停稳恢复可点', page.data.grid.revealing);
      ok(page.data.grid.cells.filter((c) => c.revealed).length === 9, '9 格全部揭示', page.data.grid.cells.filter((c) => c.revealed).length);
      ok(page.data.grid.reels.length === 0, '停稳后卷轴清空（换回静态格）', page.data.grid.reels.length);
      ok(page.data.grid.cells.slice(0, 6).every((c) => c.win), '多条中奖线 6 格全部高亮（来自服务端 lines）', page.data.grid.cells.slice(0, 6));
      ok(page.data.grid.cells.slice(6).every((c) => !c.win), '未中奖 3 格不得高亮（win 只来自服务端 lines）', page.data.grid.cells.slice(6));
      ok(page.data.lastPrize && page.data.lastPrize.game === 'grid' && /铜版/.test(page.data.lastPrize.text || '') && /步/.test(page.data.lastPrize.text || ''), '混合奖励弹层文案含铜版+步数', page.data.lastPrize);

      // ---- ②b-2 中断保护：滚动中 onHide → 立即静态终态，无 timer 复活 ----
      {
        const p2 = makePage(def);
        p2.applyGridResult(gridPayload);
        await new Promise((r) => setTimeout(r, 200));
        ok(p2.data.grid.revealing === true && p2.data.grid.reels.length === 3, '中断用例：滚动中', p2.data.grid.phase);
        p2.onHide();
        ok(p2.data.grid.revealing === false && p2.data.grid.reels.length === 0, 'onHide 立即终态（不残留半滚动画）', { revealing: p2.data.grid.revealing, reels: p2.data.grid.reels.length });
        ok(p2.data.grid.cells.every((c) => c.revealed), 'onHide 后 9 格全揭示', p2.data.grid.cells.map((c) => c.revealed));
        ok(p2.data.grid.cells.slice(0, 6).every((c) => c.win) && p2.data.grid.cells.slice(6).every((c) => !c.win), 'onHide 终态 win 仍按服务端 lines', p2.data.grid.cells.map((c) => c.win));
        const textAfterHide = p2.data.grid.resultText;
        await new Promise((r) => setTimeout(r, 3000));
        ok(p2.data.grid.revealing === false && p2.data.grid.resultText === textAfterHide && p2.data.grid.reels.length === 0, '中断后无 timer 复活（3s 反证）', { revealing: p2.data.grid.revealing, text: p2.data.grid.resultText });
      }

      // ---- ②b-3 减弱动效：跳过卷轴直接终态 ----
      {
        const p3 = makePage(def);
        p3._reducedMotion = true;
        p3.applyGridResult(gridPayload);
        ok(p3.data.grid.revealing === false && p3.data.grid.reels.length === 0, 'reduced-motion 同步终态（按钮立即恢复）', { revealing: p3.data.grid.revealing, reels: p3.data.grid.reels.length });
        ok(p3.data.grid.cells.every((c) => c.revealed), 'reduced-motion 9 格全揭示', p3.data.grid.cells.map((c) => c.revealed));
        ok(p3.data.grid.cells.slice(0, 6).every((c) => c.win) && p3.data.grid.cells.slice(6).every((c) => !c.win), 'reduced-motion win 仍按服务端 lines', p3.data.grid.cells.map((c) => c.win));
      }

      // ---- ②b-4 开奖失败必须恢复按钮（对齐转盘 restoreCenter 教训）----
      {
        const p4 = makePage(def);
        p4.applyState({ enabled: true, grid: { enabled: true, canPlay: true, cost: 6 }, coin: { balance: 88 } });
        await p4.playGrid(); // 桩 post 回 {} → success falsy → 失败分支
        ok(p4.data.grid.revealing === false && p4.data.grid.reels.length === 0, '开奖失败恢复可点（不卡「开奖中」）', { revealing: p4.data.grid.revealing, reels: p4.data.grid.reels.length });
        ok(p4.data.grid.resultText === '点「开一局」看连线结果', '开奖失败文案恢复', p4.data.grid.resultText);
      }

      // ---- ③ 盘面停位（差半格就会「停在 A 却发 B」）----
      // 指针固定在 12 点、盘面转：要停的角度 = 360 − 扇区中线 = 360 − (idx*45+22.5)。
      for (const idx of [0, 1, 3, 7]) {
        try {
          page.spinTo(idx, () => {});
          const normalized = ((page.data.rotateDeg % 360) + 360) % 360;
          const expected = (360 - (idx * 45 + 22.5)) % 360;
          ok(
            Math.abs(normalized - expected) < 0.001,
            `spinTo(${idx}) 停位精确（期望 ${expected}°，实际 ${normalized}°）`,
            { normalized, expected }
          );
        } catch (e) {
          ok(false, `spinTo(${idx}) 执行无异常`, e.message);
        }
      }

      // ---- ③b 转盘文字（用户两次反馈「转盘还是乱的」）----
      // 三层事故叠在一起：
      //   ① 文字放在**被 clip-path 裁开的扇形**里 → 被楔形边缘切掉；
      //   ② 文字用切向排布 → 8 格落在 8 个不同角度上，再加左右翻转 = 一片歪字；
      //   ③ 盘面停下角度是 360−(i*45+22.5)，水平文字会被整体带歪 22.5°~90°。
      // 现方案：文字独立成层（不裁剪）+ **径向**排布（textDeg=±90，旋转对称，任何角度都整齐）。
      ok(
        page.data.sectors.every((s) => s.textDeg === -90 || s.textDeg === 90),
        '文字是径向的（textDeg 恒为 ±90，旋转对称）',
        page.data.sectors.map((s) => ({ mid: s.midDeg, text: s.textDeg }))
      );
      // 判据：绝对旋转 = midDeg + textDeg 绝不能落在 (90,270)（那是倒着读）
      const badRot = page.data.sectors.filter((s) => {
        const r = ((s.midDeg + s.textDeg) % 360 + 360) % 360;
        return r > 90 && r < 270;
      });
      ok(badRot.length === 0, '没有一格是倒着读的（绝对角避开 90°~270°）', badRot.map((s) => s.midDeg));
      // 左半边（midDeg∈(180,360)）必须翻成 +90，其余 −90 —— 只查「有 textDeg」抓不到这个
      const flipped = page.data.sectors.filter((s) => s.midDeg > 180 && s.midDeg < 360);
      ok(flipped.length > 0 && flipped.every((s) => s.textDeg === 90), '下半圈翻 180°（改朝中心读）', flipped.map((s) => s.midDeg));
      ok(
        page.data.sectors.filter((s) => s.midDeg < 180).every((s) => s.textDeg === -90),
        '上半圈朝外读（不翻）',
        page.data.sectors.filter((s) => s.midDeg < 180).map((s) => s.midDeg)
      );
      // 文字层必须与扇形分开：放在 clip-path 里就会被切
      const rewardWxml = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'miniprogram', 'pages', 'reward', 'reward.wxml'), 'utf8'
      );
      ok(
        /class="bd-label[^"]*"/.test(rewardWxml) && /class="bd-sector bd-sector-\{\{item\.tint\}\}[^"]*"[^>]*>\s*<\/view>/.test(rewardWxml),
        '文字层独立于 clip-path 扇形（不会被楔形边缘切掉）',
        /class="bd-sector bd-sector-\{\{item\.tint\}\}[^"]*"[^>]*>\s*<\/view>/.test(rewardWxml)
      );

      // ---- ③b2 楔形顶点必须是圆心（用户 2026-11-13「背景的分层不对…背景错位了」）----
      // 事故形态：clipOf 的首点写成 '50% 0%'（盘子**正上方**），而弧点绕 50% 50% 画。
      // 于是 8 格尖端全部汇聚到 12 点，整盘从顶部往下散开：中心白环与格子对不上、
      // 白色分隔线（从圆心发出）与颜色边界（从顶部发出）互相错位。
      // 这类几何错误不抛异常、不白屏、颜色也都在，静态检查看不出来 —— 只能算顶点。
      const pairsOf = (clip) => (clip.match(/([\d.]+)% ([\d.]+)%/g) || [])
        .map((p) => p.match(/([\d.]+)% ([\d.]+)%/).slice(1, 3).map(Number));
      const apexes = page.data.sectors.map((s) => pairsOf(s.clip)[0]);
      ok(
        apexes.length === 8 && apexes.every((a) => a && a[0] === 50 && a[1] === 50),
        '每个楔形的顶点都是圆心（扇形从中心散开，不是从盘顶）',
        apexes
      );
      // 顶点到弧点的距离必须等于半径 50%（否则扇形不是圆扇形，边缘会切出直边）
      const radiiOk = page.data.sectors.every((s) => {
        const nums = pairsOf(s.clip);
        const [ax, ay] = nums[0];
        return nums.slice(1).every(([x, y]) => Math.abs(Math.hypot(x - ax, y - ay) - 50) < 0.6);
      });
      ok(radiiOk, '弧点到顶点距离恒为 50%（真圆弧，边缘不会切出直边）', radiiOk);
      // 分隔线也必须从圆心发出（与扇形边界重合，否则就是截图里那种两套线）
      ok(
        /\.bd-wedge\s*\{[\s\S]{0,300}top:\s*0;[\s\S]{0,120}height:\s*50%;[\s\S]{0,120}transform-origin:\s*50% 100%/.test(
          require('fs').readFileSync(require('path').join(__dirname, '..', 'miniprogram', 'pages', 'reward', 'reward.wxss'), 'utf8')
        ),
        '分隔线以圆心为旋转原点（与扇形边界同一套几何）',
        true
      );
      // 位置由 midDeg 决定，翻的只是文字块自身 —— 两者一旦被写成同一个值，停位就会错半格
      ok(
        page.data.sectors.every((s) => s.centerDeg === s.midDeg),
        '停位角度仍按 midDeg（反翻不影响「停在 A 却发 B」）',
        page.data.sectors.map((s) => s.centerDeg)
      );

      // ---- ③c 中心按钮三态 + 没余额时点它是「去赚铜版」而不是死按钮 ----
      ok(page.data.centerMain === '抽奖' && /铜版/.test(page.data.centerSub), '有余额：中心显示「抽奖 + 铜版成本」', {
        main: page.data.centerMain, sub: page.data.centerSub,
      });
      page.applyCounters({ remaining: 0, coin: { ...page.data.coin, balance: 0 } });
      ok(page.data.centerMain === '赚铜版', '没余额：中心变成「赚铜版」（不是灰色死按钮）', page.data.centerMain);
      ok(page.data.centerSub === '去做任务', '没余额：副文案直接指向下一步', page.data.centerSub);
      // 点中心在没有余额/次数时必须滚到任务区，**绝不能**发抽奖请求
      let scrolled = 0;
      page.scrollToTasks = () => { scrolled += 1; };
      let drew = 0;
      page.draw = () => { drew += 1; };
      page.tapCenter();
      ok(scrolled === 1 && drew === 0, '没余额时点中心 = 滚到任务区（不发抽奖请求）', { scrolled, drew });
      page.applyCounters({ remaining: 2, coin: { ...page.data.coin, balance: 90 } });
      page.tapCenter();
      ok(drew === 1, '有余额时点中心 = 抽奖', drew);

      // ---- ③c2 失败路径必须把「抽奖中」还原 ----
      // 事故形态：接口失败只写 spinning:false，中心文案是独立 data → 转盘没动、
      // 按钮却永远停在「抽奖中」，用户只能杀进程重进。
      page.setData({ spinning: true, centerMain: '抽奖中', centerSub: '' });
      page.restoreCenter();
      ok(page.data.spinning === false, 'restoreCenter 复位 spinning', page.data.spinning);
      ok(page.data.centerMain === '抽奖', '失败后中心从「抽奖中」还原成可点态', page.data.centerMain);

      // ---- ③d 我的最近中奖：服务端下发什么就渲染什么 ----
      ok(
        Array.isArray(page.data.recent) && page.data.recent.length === 1 && page.data.recent[0].atText === '09:12',
        '最近中奖写进 data（含服务端拼好的时间文案）',
        page.data.recent
      );
      ok(!!page.data.recent[0].prizeLabel, '最近中奖有奖品名（不是只给 key）', page.data.recent[0]);

      // ---- ③d2 中奖弹层必须停够久（用户 2026-11-13「特效就显示了1秒不到我什么都没看见」）----
      // 回归点：FX_MS.normal 曾只有 420ms —— 还没看清就自动关了。
      await new Promise((r) => setTimeout(r, 800));
      page.playFx('normal', { type: 'steps', amount: 100 }, false);
      await new Promise((r) => setTimeout(r, 800));
      ok(page.data.fx === 'normal', '普通档弹层 800ms 后仍然在（不会一闪就没）', page.data.fx);
      page.closeFx();

      // ---- ③e 手动收起弹层（自动收起会再闪一下）----
      page.playFx('rarest', { type: 'steps', amount: 1500 }, false);
      ok(page.data.fx === 'rarest', '先有弹层', page.data.fx);
      page.closeFx();
      ok(page.data.fx === '' && page.data.confetti.length === 0 && page.data.fxSparks.length === 0, 'closeFx 立刻收起并清彩带/星光', {
        fx: page.data.fx, confetti: page.data.confetti.length, sparks: page.data.fxSparks.length,
      });

      // ---- ③e2 拼多多式动效：最稀有才有光芒 + 金币雨，金额按奖品类型 ----
      page.playFx('rarest', { type: 'steps', amount: 1500 }, false);
      ok(Array.isArray(page.data.coinRain) && page.data.coinRain.length === 14, '金币雨 14 枚', (page.data.coinRain || []).length);
      ok(
        page.data.coinRain.every((c) => typeof c.left === 'number' && typeof c.delay === 'number' && typeof c.dur === 'number' && typeof c.size === 'number'),
        '每枚金币都有 left/delay/dur/size（编排不会 NaN）',
        page.data.coinRain[0]
      );
      ok(
        Array.isArray(page.data.fxRays) && page.data.fxRays.length === 16 && page.data.fxRays.every((r) => Math.abs(r.deg - r.k * 22.5) < 0.001),
        '光芒 16 条等分（deg 步进 22.5°）',
        (page.data.fxRays || []).length
      );
      ok(
        Array.isArray(page.data.confetti) && page.data.confetti.length === 20
          && page.data.confetti.every((c) => c.dir >= 0 && c.dir <= 7 && c.tone >= 1 && c.tone <= 8 && c.shape >= 0 && c.shape <= 2
            && typeof c.delay === 'number' && typeof c.dur === 'number'),
        '彩带 20 片：8 方向 × 8 色 × 3 形状编排不越界不 NaN',
        page.data.confetti[0]
      );
      ok(
        Array.isArray(page.data.fxSparks) && page.data.fxSparks.length === 8
          && page.data.fxSparks.every((s) => typeof s.x === 'number' && typeof s.y === 'number'
            && typeof s.delay === 'number' && typeof s.dur === 'number' && s.tone >= 1 && s.tone <= 3 && !!s.ch),
        '星光 8 颗环布（x/y/delay/dur/tone/字符齐全）',
        page.data.fxSparks[0]
      );
      ok(page.data.fxAmountText === '+1500' && page.data.fxAmountUnit === '步', '步数奖金额 +1500 步', [page.data.fxAmountText, page.data.fxAmountUnit]);
      page.closeFx();
      ok(
        page.data.coinRain.length === 0 && page.data.fxRays.length === 0 && page.data.confetti.length === 0 && page.data.fxSparks.length === 0 && page.data.fxShake === '' && page.data.fxAmountText === '',
        'closeFx 清金币雨/光芒/彩带/星光/震屏/金额',
        { c: page.data.coinRain.length, r: page.data.fxRays.length, f: page.data.confetti.length, s: page.data.fxSparks.length, k: page.data.fxShake, a: page.data.fxAmountText }
      );

      // 全档炸裂（2026-11-25）：normal/rare 也有自己的爆发档（逐档递进），光芒仍 rarest 签名
      page.playFx('normal', { type: 'coin', amount: 2 }, false);
      ok(
        page.data.confetti.length === 10 && page.data.coinRain.length === 5 && page.data.fxSparks.length === 4
          && page.data.fxRays.length === 0 && page.data.fxShake === 'sm',
        '普通档中爆发：彩带10/金币5/星光4/无光芒/震屏sm',
        { f: page.data.confetti.length, c: page.data.coinRain.length, s: page.data.fxSparks.length, k: page.data.fxShake }
      );
      ok(
        page.data.coinRain.every((c) => typeof c.left === 'number' && typeof c.delay === 'number' && typeof c.dur === 'number' && typeof c.size === 'number'),
        '普通档金币编排不 NaN',
        page.data.coinRain[0]
      );
      ok(page.data.fxAmountText === '+2' && page.data.fxAmountUnit === '铜版', '铜版奖金额 +2 铜版', [page.data.fxAmountText, page.data.fxAmountUnit]);
      page.closeFx();
      page.playFx('rare', { type: 'steps', amount: 800 }, false);
      ok(
        page.data.confetti.length === 14 && page.data.coinRain.length === 8 && page.data.fxSparks.length === 6
          && page.data.fxRays.length === 0 && page.data.fxShake === 'md' && page.data.fxAmountText === '+800',
        '稀有档大爆发：彩带14/金币8/星光6/无光芒/震屏md，金额 +800',
        { f: page.data.confetti.length, c: page.data.coinRain.length, s: page.data.fxSparks.length, k: page.data.fxShake, a: page.data.fxAmountText }
      );
      ok(
        page.data.coinRain.every((c) => typeof c.left === 'number' && typeof c.delay === 'number' && typeof c.dur === 'number' && typeof c.size === 'number'),
        '稀有档金币编排不 NaN',
        page.data.coinRain[0]
      );
      page.closeFx();

      // rarest 紧接 normal：normal 必须拿自己的档位数量，不能残留 rarest 的
      page.playFx('rarest', { type: 'coin', amount: 5 }, false);
      page.playFx('normal', { type: 'steps', amount: 100 }, false);
      ok(
        page.data.coinRain.length === 5 && page.data.fxRays.length === 0 && page.data.confetti.length === 10
          && page.data.fxSparks.length === 4 && page.data.fxShake === 'sm',
        'rarest 紧接 normal 换成 normal 自有档（不残留旧档特效）',
        { c: page.data.coinRain.length, r: page.data.fxRays.length, f: page.data.confetti.length, s: page.data.fxSparks.length, k: page.data.fxShake }
      );
      page.closeFx();

      // ---- ③e4 减弱动效：粒子连 DOM 都不生成，静态出卡 ----
      {
        const pLite = makePage(def);
        pLite._reducedMotion = true;
        pLite.playFx('rarest', { type: 'steps', amount: 1500 }, false);
        ok(
          pLite.data.fx === 'rarest' && pLite.data.confetti.length === 0 && pLite.data.coinRain.length === 0
            && pLite.data.fxRays.length === 0 && pLite.data.fxSparks.length === 0 && pLite.data.fxShake === '',
          'reduced-motion 弹层静态出卡（四组粒子全空、不震屏）',
          { fx: pLite.data.fx, f: pLite.data.confetti.length, c: pLite.data.coinRain.length, r: pLite.data.fxRays.length, s: pLite.data.fxSparks.length, k: pLite.data.fxShake }
        );
        pLite.closeFx();
      }

      // 空奖 / 封顶降级 / 混合奖：金额留空，绝不给误导性的 +N
      page.playFx('none', { type: 'coin', amount: 2 }, false);
      ok(page.data.fx === 'normal' && page.data.fxAmountText === '', '空奖走普通档且金额留空', { fx: page.data.fx, a: page.data.fxAmountText });
      ok(
        page.data.confetti.length === 0 && page.data.coinRain.length === 0 && page.data.fxSparks.length === 0 && page.data.fxShake === '',
        '空奖保持克制（全档炸裂不含 none）',
        { f: page.data.confetti.length, c: page.data.coinRain.length, k: page.data.fxShake }
      );
      page.closeFx();
      page.playFx('rarest', { type: 'coin', amount: 2 }, true);
      ok(page.data.fxAmountText === '', '封顶降级时金额留空（不给假的 +N）', page.data.fxAmountText);
      page.closeFx();
      page.playFx('rarest', { type: 'mixed', amount: 3 }, false);
      ok(page.data.fxAmountText === '', 'mixed 奖金额留空（明细已在卡片 sub，避免单一单位误导）', page.data.fxAmountText);
      page.closeFx();

      // ---- ③e3 钱包产出进度条 + 外圈灯珠（纯展示，封顶仍由服务端判定）----
      ok(Array.isArray(page.data.rimLights) && page.data.rimLights.length === 16, '外圈灯珠 16 颗', (page.data.rimLights || []).length);
      ok(page.data.rimLights.every((l, i) => Math.abs(l.deg - i * 22.5) < 0.001), '灯珠等分 22.5°', page.data.rimLights.slice(0, 3).map((l) => l.deg));
      const pCap = makePage(def);
      pCap.applyState({ enabled: true, coin: { name: '铜版', gameEarnedToday: 6, dailyGameCap: 200 } });
      ok(pCap.data.coinCapPercent === 3, '产出进度 = round(6/200*100)=3', pCap.data.coinCapPercent);
      const pCap0 = makePage(def);
      pCap0.applyState({ enabled: true, coin: { name: '铜版', gameEarnedToday: 5, dailyGameCap: 0 } });
      ok(pCap0.data.coinCapPercent === 0, '上限 0（不限）时进度为 0（进度条隐藏）', pCap0.data.coinCapPercent);

      // ---- ③g 音效 v2：五档文件名升版 + 和声序列可合成（零资源文件）----
      const sfxMod = require('../miniprogram/utils/sfx.js');
      const fsNames = sfxMod._internal.FS_NAME;
      ok(
        Object.keys(fsNames).length === 5 && Object.keys(fsNames).every((k) => /_v2\.wav$/.test(fsNames[k])),
        '五档音效文件名均升版 _v2（改序列必须升版，否则老用户听旧音）',
        fsNames
      );
      const rarestSeq = sfxMod._internal.SEQUENCES.rarest;
      ok(rarestSeq.some((n) => n.length === 3 && n[2] > 0), 'rarest 序列含和声元组（号角更饱满）', rarestSeq.filter((n) => n.length === 3).length);
      try {
        const wav = sfxMod.synthWav(rarestSeq);
        const totalMs = rarestSeq.reduce((s, [, ms]) => s + ms, 0) + 10;
        const sampleCount = Math.floor((sfxMod._internal.SAMPLE_RATE * totalMs) / 1000);
        ok(
          wav.sampleCount === sampleCount && wav.buffer.byteLength === 44 + sampleCount * 2,
          '合成 WAV = 44 字节头 + 采样×2',
          { sc: wav.sampleCount, bl: wav.buffer.byteLength }
        );
      } catch (e) {
        ok(false, 'rarest 和声序列可合成（不抛）', e.message);
      }

      // ---- ③f 管理端音效总开关必须真的生效（早先只进 data、从没被读）----
      // 关掉后抽奖仍要正常落盘、动效照给 —— 音效只是锦上添花，不能成为阻塞点。
      const muted = makePage(def);
      muted.applyState({ enabled: true, sfxEnabled: false, draw: { remaining: 1, prizes: [], sectors: [] } });
      ok(muted.data.sfxEnabled === false, 'sfxEnabled=false 已进 data', muted.data.sfxEnabled);
      muted.playFx('rare', { type: 'steps', amount: 800 }, false);
      ok(muted.data.fx === 'rare', '音效关闭时动效照常（不是一起关掉）', muted.data.fx);

      // ---- ④ 最小 payload：新用户首日字段大量缺失时也不能崩 ----
      const page2 = makePage(def);
      try {
        page2.applyState({ enabled: true });
        ok(true, '最小 payload（只有 enabled）也不崩');
      } catch (e) {
        ok(false, '最小 payload（只有 enabled）也不崩', e.message);
      }
      // 播报接口失败（null）也必须安全
      const page3 = makePage(def);
      try {
        page3.applyState({ enabled: true });
        page3.applyFeed(null);
        ok(true, '播报接口失败（null）也不崩');
      } catch (e) {
        ok(false, '播报接口失败（null）也不崩', e.message);
      }
    },
  },
  {
    file: 'packageAdmin/class/class.js',
    name: '我的班级（班超联赛 tab）',
    // 10 分制改造把 scoreText / barPercent 引入了这个页面（模块级 const + fmt.scoreText）。
    // 这两处正是「语法合法、键名检查也过、一进页面就抛」的高危区：
    //   · fmt.scoreText 若没在 utils/format 里导出 → 每次渲染都 TypeError；
    //   · barPercent 的参数若漏传 fullScore → 趋势条恒 10% 宽（不报错，只是数字错）。
    async run(def, state) {
      const page = makePage(def);
      page.data.className = '26级信息安全技术应用';
      state.get = async () => ({
        fullScore: 10,
        score: 9.5,
        deduct: 0.5,
        rangeLabel: '今日',
        periodLabel: '11月12日',
        recordCount: 3,
        ranking: { rank: 7, total: 43, score: 9.5 },
        rankingTop: [{ className: 'a', score: 9.95 }, { className: 'b', score: 8 }],
        modules: [
          { key: 'morning_class', shortName: '早八', entered: true, skipped: false, deduct: 0.05, score: 9.95, metricText: '迟到 1 人' },
          { key: 'hygiene', shortName: '卫生', entered: false, skipped: false, deduct: 0, score: null, noRecordText: '', optionalWhenMissing: false },
        ],
        days: [{ date: '2026-11-12', deduct: 0.5, score: 9.5 }],
        recent: [{ id: 'r1', moduleName: '早八', targetName: '本班', date: '2026-11-12', statusText: '已提交', deduct: 0.05 }],
        from: '2026-11-12',
        to: '2026-11-12',
      });
      try {
        await page.loadBanchao();
        ok(true, 'loadBanchao 执行无异常（班超 tab 不会白屏）');
      } catch (e) {
        ok(false, 'loadBanchao 执行无异常（班超 tab 不会白屏）', e.message);
      }
      ok(page.data.banchao && page.data.banchao.scoreText === '9.50', '总评文案两位小数', page.data.banchao && page.data.banchao.scoreText);
      ok(
        page.data.banchaoDays && page.data.banchaoDays[0].percent === 95,
        '趋势条 = 得分 ÷ 满分（9.5 分 → 95%，不是 9.5%）',
        page.data.banchaoDays && page.data.banchaoDays[0].percent
      );
      ok(
        page.data.banchaoModules && page.data.banchaoModules[0].scoreText === '9.95',
        '模块得分两位小数（迟到 1 人扣 0.05 看得见）',
        page.data.banchaoModules && page.data.banchaoModules[0].scoreText
      );
      ok(
        page.data.banchaoRecent && page.data.banchaoRecent[0].scoreText === '-0.05',
        '最近记录扣分带负号且两位小数',
        page.data.banchaoRecent && page.data.banchaoRecent[0].scoreText
      );
      ok(
        page.data.banchaoRankingTop && page.data.banchaoRankingTop[0].scoreText === '9.95',
        '班级榜前三分数已预计算（模板不再直接渲染数字）',
        page.data.banchaoRankingTop && page.data.banchaoRankingTop[0]
      );
      // 后端还没部署新版（不下发 fullScore）时也不能崩、更不能显示成 0.095
      const p2 = makePage(def);
      p2.data.className = 'x';
      state.get = async () => ({ score: 9.5, days: [{ date: '2026-11-12', score: 9.5 }], modules: [], recent: [], rankingTop: [] });
      try {
        await p2.loadBanchao();
        ok(p2.data.banchaoDays[0].percent === 95, '缺 fullScore 时按兜底满分 10 换算（不显示 9.5%）', p2.data.banchaoDays[0].percent);
      } catch (e) {
        ok(false, '缺 fullScore 时不崩', e.message);
      }

      // ===== 用户 2026-11-20：dayRecords（班级考勤 · 检查记录）+ 记录卡片字段 =====
      //
      // 这里验的是**行为**而不是静态接线：服务端下发的 dayRecords 能不能被正确分组、
      // 检查人/复核人空值有没有落成可读文案、照片 +N 与 metric 兜底摘要有没算出来。
      // 这些写错都不会报错，只会让卡片空一块或显示 [object Object]。
      const p4 = makePage(def);
      p4.data.className = '26级信息安全技术应用';
      state.get = async () => ({
        fullScore: 10,
        score: 9.5,
        deduct: 0.5,
        rangeLabel: '今日',
        periodLabel: '11月12日',
        recordCount: 3,
        ranking: { rank: 7, total: 43, score: 9.5 },
        rankingTop: [],
        modules: [],
        days: [],
        from: '2026-11-12',
        to: '2026-11-12',
        recent: [
          { id: 'r1', moduleName: '早八', targetName: '本班', date: '2026-11-12', deduct: 0.05, inspectorName: '李老师', reviewedByName: '王部长', photos: ['a'], photoCount: 1 },
        ],
        dayRecords: [
          { id: 'd1', moduleName: '晚自习', targetName: '本班', date: '2026-11-12', statusText: '已提交', deduct: 0.05, inspectorName: '', reviewedByName: '', photos: ['p1', 'p2'], photoCount: 4, metrics: { ratios: { rate: 0.9 } } },
          { id: 'd2', moduleName: '晚自习', targetName: '本班', date: '2026-11-12', statusText: '已提交', deduct: 0, inspectorName: '张老师', reviewedByName: '李部长', photos: [], photoCount: 0 },
          { id: 'd3', moduleName: '卫生', targetName: '1号楼201', date: '2026-11-12', statusText: '已复核', deduct: 0.4, inspectorName: '张老师', reviewedByName: '李部长', photos: ['p3'], photoCount: 1, metrics: { values: { score: 8 } } },
        ],
        dayRecordsTotal: 5,
        dayRecordsRange: { from: '2026-11-12', to: '2026-11-12' },
      });
      await p4.loadBanchao();
      ok(p4.data.banchaoDayGroups.length === 2, 'dayRecords 按模块分组（晚自习 2 条 + 卫生 1 条 → 2 组）', p4.data.banchaoDayGroups.length);
      const g0 = p4.data.banchaoDayGroups[0] || { items: [] };
      ok(g0.moduleName === '晚自习' && g0.items.length === 2 && g0.countText === '2 条', '分组保持服务端顺序且带条数文案', g0 && [g0.moduleName, g0.items.length, g0.countText]);
      ok(
        p4.data.banchaoDayTotal === 5 && p4.data.banchaoDayTruncated === true && p4.data.banchaoDayTruncateText === '仅显示前 3 条',
        '总数 5 > 返回 3 → 截断提示（文案在 JS 里拼好，模板不拼三元）',
        [p4.data.banchaoDayTotal, p4.data.banchaoDayTruncated, p4.data.banchaoDayTruncateText]
      );
      ok(/11月12日/.test(p4.data.banchaoDayRangeText), '区间文案来自服务端 dayRecordsRange', p4.data.banchaoDayRangeText);
      const d1 = g0.items[0] || {};
      ok(d1.inspectorText === '—' && d1.reviewerText === '待复核', '检查人空 → 「—」、复核人空 → 「待复核」', [d1.inspectorText, d1.reviewerText]);
      ok(d1.photos.length === 2 && d1.photoMoreText === '+2', '照片前 3 张 + 多出的显示 +N（photoCount 4 → +2）', [d1.photos.length, d1.photoMoreText]);
      ok(/出勤率 90%/.test(d1.metricSummary), '记录没下发 metricText 时由 metrics 兜底出「实际数据」摘要', d1.metricSummary);
      const d3 = (p4.data.banchaoDayGroups[1] || { items: [] }).items[0] || {};
      ok(d3.reviewerText === '李部长' && /得分 8/.test(d3.metricSummary), '已复核记录显示复核人 + 得分摘要', [d3.reviewerText, d3.metricSummary]);
      lastPreviewImage = null;
      p4.previewPhoto({ currentTarget: { dataset: { id: 'd1', index: 1 } } });
      ok(
        !!lastPreviewImage && lastPreviewImage.urls.length === 2 && lastPreviewImage.current === lastPreviewImage.urls[1],
        'previewPhoto 传 { urls, current }（点第 2 张就从第 2 张开始）',
        lastPreviewImage
      );

      // ===== 用户 2026-11-20：校园跑日期回看（/overview /ranking 带 date）=====
      const ovCalls = [];
      state.get = async (url, params) => {
        ovCalls.push({ url, params });
        return { students: [], classRank: null, date: params && params.date, list: [], total: 0 };
      };
      const p5 = makePage(def);
      p5.data.className = '26级信息安全技术应用';
      p5.data.runDate = '2026-11-10';
      await p5.loadOverview();
      await p5.loadRanking();
      const ovCall = ovCalls.find((c) => c.url === '/api/class/overview');
      const rkCall = ovCalls.find((c) => c.url === '/api/class/ranking');
      ok(!!ovCall && ovCall.params.date === '2026-11-10', '回看时 /overview 带所选日期', ovCall && ovCall.params);
      ok(!!rkCall && rkCall.params.date === '2026-11-10', '回看时 /ranking 带所选日期', rkCall && rkCall.params);
      // 选日期后两个接口都要按新日期重取（只刷概况会让「榜单还是昨天的」）
      ovCalls.length = 0;
      p5.onRunDate({ detail: { value: '2026-11-12' } });
      await new Promise((r) => setTimeout(r, 0));
      ok(
        p5.data.runDate === '2026-11-12' && p5.data.runIsPast === true && /回看/.test(p5.data.runDateTip),
        '选过去日期进入回看态（runIsPast + 回看标签）',
        [p5.data.runDate, p5.data.runIsPast, p5.data.runDateTip]
      );
      ok(
        ovCalls.some((c) => c.url === '/api/class/overview' && c.params.date === '2026-11-12') &&
          ovCalls.some((c) => c.url === '/api/class/ranking' && c.params.date === '2026-11-12'),
        'onRunDate 同时按新日期刷新概况与榜单',
        ovCalls.map((c) => `${c.url}:${c.params && c.params.date}`)
      );
      // 切到学生名单：用户 2026-11-22「校园跑的日期选择应该能查看当天的未达标学生」
      //   → 名单与概况都**沿用所选日期**（listDate），不再回今天；顶部给回看横条。
      ovCalls.length = 0;
      p5.data.tab = 'run'; // 默认 tab 是 students，不先切到 run 的话 switchTab 会直接 return
      p5.switchTab('students');
      await new Promise((r) => setTimeout(r, 0));
      const ovToday = ovCalls.find((c) => c.url === '/api/class/overview');
      const realToday = require(path.join(M, 'utils/format.js')).todayKey();
      ok(!ovToday || ovToday.params.date === '2026-11-12', '学生名单 tab 沿用所选日期（不再强制回到今天）', ovToday && ovToday.params);
      ok(p5.data.listDate === '2026-11-12' && p5.data.listDateIsPast === true && p5.data.listDateLabel === '11月12日', '名单日期三件套跟随所选日期', [p5.data.listDate, p5.data.listDateIsPast, p5.data.listDateLabel]);
      // 名单请求必须带 date（旧实现不传 → 回看历史日期时看到的是今天的达标结果）
      ovCalls.length = 0;
      p5.data.page = 1;
      await p5.loadStudents(1);
      const stCall = ovCalls.find((c) => c.url === '/api/class/students');
      ok(!!stCall && stCall.params && stCall.params.date === '2026-11-12', '/students 带所选日期（按天筛未达标）', stCall && stCall.params);
      // 回今天：三件套复位成「今日」，请求也回到今天
      ovCalls.length = 0;
      p5.onRunToday();
      await new Promise((r) => setTimeout(r, 0));
      ok(p5.data.listDate === realToday && p5.data.listDateIsPast === false && p5.data.listDateLabel === '今日', '点「今天」后名单日期复位', [p5.data.listDate, p5.data.listDateLabel]);
      ok((p5.data.filters || []).some((f) => f.key === '0' && /未达标/.test(f.label) && !/月/.test(f.label)), '回到今天时达标筛选文案为「今日未达标」', p5.data.filters);
      // 回看态下「未达标名单」入口必须可用（旧实现 wxml 用 !runIsPast 隐藏了两个入口）
      const classWxml = require('fs').readFileSync(path.join(__dirname, '..', 'miniprogram', 'packageAdmin', 'class', 'class.wxml'), 'utf8');
      ok(!/wx:if="\{\{canNudge && !runIsPast\}\}"/.test(classWxml), '督促入口不再因回看日期被隐藏', null);
      ok(/openNudge/.test(classWxml) && /openUnachieved/.test(classWxml), '督促 / 未达标名单两个入口都在');
      // 切回校园跑：保留回看日期并按它重取
      ovCalls.length = 0;
      p5.data.runDate = '2026-11-12';
      p5.data.listDate = '2026-11-12';
      p5.switchTab('run');
      await new Promise((r) => setTimeout(r, 0));
      ok(
        p5.data.runDate === '2026-11-12' && ovCalls.some((c) => c.params && c.params.date === '2026-11-12'),
        '切回校园跑 tab 保留回看日期（不悄悄跳回今天）',
        ovCalls.map((c) => c.params && c.params.date)
      );
      // 督促清单：回看态下也按所选日期取（旧实现直接 return，抽屉打不开）
      ovCalls.length = 0;
      p5.data.canNudge = true;
      p5.data.tab = 'run';
      p5.data.listDate = '2026-11-12';
      p5.data.listDateIsPast = true;
      p5.data.listDateText = '11月12日';
      p5.data.nudgeLoading = false;
      await p5.openNudge();
      const nudgeCall = ovCalls.find((c) => c.url === '/api/class/students' && c.params.achievedToday === '0');
      ok(!!nudgeCall && nudgeCall.params.date === '2026-11-12', '回看态督促清单按所选日期取（不被 runIsPast 拦下）', nudgeCall && nudgeCall.params);
      ok(/11月12日/.test(p5.data.nudgeText || ''), '督促文案写所选日期而不是「今日」', p5.data.nudgeText);
      // 切班级：回看日期重置为今天（不能把 A 班的回看日期带到 B 班）
      const p6 = makePage(def);
      p6.data.className = '26级信息安全技术应用';
      p6.data.classes = [{ className: '26级信息安全技术应用' }, { className: '25级大数据技术' }];
      p6.data.runDate = '2026-11-10';
      p6.data.runIsPast = true;
      p6.data.runDateText = '11月10日';
      // 注意 dataset 的键是短名 class（WXML 里 data-class），不是 className
      p6.switchClass({ currentTarget: { dataset: { class: '25级大数据技术' } } });
      ok(p6.data.runDate === realToday && p6.data.runIsPast === false, '切换班级时回看日期重置为今天', [p6.data.runDate, p6.data.runIsPast]);

      // ===== 用户 2026-11-20 第三轮：班超 KPI 双列卡 / hero 文案 / 双列最近记录 =====
      //
      // 这三处都是「聚合展示」：写错不报错，只会让卡片空着或数字对不上。
      // KPI 由 buildBanchaoKpis 读 overview + banchao + banchaoDayCount，两个接口谁后到都补齐。
      const kpiOf = (page) => Object.fromEntries((page.data.banchaoKpis || []).map((k) => [k.key, k]));
      const pK = makePage(def);
      pK.data.overview = { studentCount: 48, dailyRate: 87, achievedToday: 42, weeklyRate: 81, achievedWeek: 39 };
      pK.data.banchao = { scoreText: '9.50', recordCount: 12, rank: { rank: 7, total: 43 } };
      pK.data.banchaoDayCount = 5;
      pK.buildBanchaoKpis();
      ok(pK.data.banchaoKpis.length === 4, 'KPI 双列卡固定 4 张（今日达标 / 本周达标 / 班超名次 / 本期记录）', pK.data.banchaoKpis.length);
      const kpi = kpiOf(pK);
      ok(
        kpi.daily.valueText === '87%' && kpi.daily.auxText === '今日达标 42/48 人' && kpi.daily.hasBar === true,
        '今日达标卡：主数据 87% + 人数 + 进度轨',
        kpi.daily
      );
      ok(kpi.weekly.valueText === '81%' && kpi.weekly.auxText === '本周达标 39/48 人', '本周达标卡主/次数据', kpi.weekly);
      ok(kpi.rank.valueText === '7 / 43' && /9\.50/.test(kpi.rank.auxText), '班超名次卡：主数据 7/43 + 本期得分', kpi.rank);
      ok(kpi.records.valueText === '12 条' && kpi.records.auxText === '覆盖 5 天', '本期记录卡：条数 + 覆盖天数', kpi.records);
      // 三态：不参跑 / 未上榜 / 数据未到
      const pEx = makePage(def);
      pEx.data.overview = { studentCount: 48, dailyRate: 0, weeklyRate: 0 };
      pEx.data.runExcluded = true;
      pEx.data.banchao = { scoreText: '—', recordCount: 0, rank: null };
      pEx.buildBanchaoKpis();
      const kpiEx = kpiOf(pEx);
      ok(kpiEx.daily.valueText === '不参跑' && kpiEx.daily.hasBar === false, '不参跑班：达标卡写「不参跑」且不画进度轨', kpiEx.daily);
      ok(kpiEx.rank.valueText === '未上榜' && kpiEx.rank.auxText === '本期无检查记录', '本期没进榜：名次卡「未上榜」（不是 0 名）', kpiEx.rank);
      const pNd = makePage(def);
      pNd.data.overview = null;
      pNd.data.banchao = null;
      pNd.buildBanchaoKpis();
      const kpiNd = kpiOf(pNd);
      ok(
        kpiNd.daily.valueText === '—' && kpiNd.rank.valueText === '—' && kpiNd.records.valueText === '—',
        '两个接口都没回来时 KPI 显示「—」（不崩溃、不显示 0）',
        kpiNd
      );
      // hero 备注：整句由 JS 拼好（模板只渲染），修掉「本今日」拼接 bug
      // （模板侧断言在 check-class-ui：WXML 不得出现 本{{rangeWord}}）
      ok(
        p4.data.banchaoHeroNote === '' || /条记录|还没有检查记录/.test(p4.data.banchaoHeroNote),
        'hero 备注只有 JS 预计算这一种形态（空串或整句）',
        p4.data.banchaoHeroNote
      );
      // 最近记录块已删（2026-11-23）：banchaoRecent 仍保留给记录详情定位，不再派生网格
      ok(
        /条记录|还没有检查记录/.test(p4.data.banchaoHeroNote) && !/本今日/.test(p4.data.banchaoHeroNote),
        'hero 备注是「本期 X 条记录 / 还没有检查记录」整句（不会是「本今日」）',
        p4.data.banchaoHeroNote
      );
      // 2026-11-23 iOS 重排版：吸顶分段 + 页内选班抽屉（多班管理）
      const wxmlCls = classWxml;
      ok(wxmlCls.includes('cls-topbar') && wxmlCls.includes('tt-segment'), '吸顶头 + 分段控制器在 WXML', '');
      ok(
        wxmlCls.includes('cls-topbar-range') && !wxmlCls.includes('cls-sticky'),
        '周期行融合进 topbar（无独立第二层吸顶）',
        ''
      );
      const pPick = makePage(def);
      pPick.data.classes = ['23级大数据技术', '24级软件技术'];
      pPick.data.className = '23级大数据技术';
      pPick.openClassPick();
      ok(pPick.data.classPickVisible === true, '多班点班级条开页内抽屉', pPick.data.classPickVisible);
      pPick.onPickClass({ currentTarget: { dataset: { class: '24级软件技术' } } });
      ok(
        pPick.data.classPickVisible === false && pPick.data.className === '24级软件技术',
        '选班后关抽屉且切班（转发 switchClass）',
        [pPick.data.classPickVisible, pPick.data.className]
      );
      ok(pPick.data.runDate === pPick.data.runToday, '切班后校园跑回看重置为今天', [pPick.data.runDate, pPick.data.runToday]);
      const pSingle = makePage(def);
      pSingle.data.classes = ['23级大数据技术'];
      pSingle.openClassPick();
      ok(pSingle.data.classPickVisible === false, '单班不开抽屉（班级条直接显示班名）', pSingle.data.classPickVisible);
    },
  },
  {
    file: 'packageAdmin/class-status/class-status.js',
    name: '班级状态总览',
    async run(def, state) {
      // decorate 是纯展示函数（用户报的「考勤 100% 应该显示分数」就落在这里）
      const page = makePage(def);
      // decorate 第三轮起需要显式传 view（columns/deductMode）：不传会读页面 data 的列，
      // 而默认列里没有班超分 —— chips 断言会全部落空（读不到就误报成实现没做）。
      const VIEW_ATT = { columns: { daily: true, weekly: true, attendance: true }, deductMode: 'avg' };
      const d = (r, v) => page.decorate(r, v || VIEW_ATT);
      const withLate = d({
        className: 'A',
        studentCount: 48,
        run: { enabled: true, dailyRate: 20, weeklyRate: 40 },
        attendance: { ratePercent: 98.5, score: 9.85, lateCount: 3, hasData: true },
      });
      ok(withLate.attText === '9.85', '考勤列显示分数（不是 98.5%）', withLate.attText);
      ok(withLate.attSub === '迟到 3 人', '分数副行带迟到人数（扣了什么看得见）', withLate.attSub);
      ok(withLate.attLevel === 'ok', '9.85 分判为 ok（阈值 = 旧 90% ÷10）', withLate.attLevel);
      const full = d({
        className: 'B',
        studentCount: 40,
        run: { enabled: true, dailyRate: 100, weeklyRate: 100 },
        attendance: { ratePercent: null, score: 10, lateCount: 0, hasData: true },
      });
      ok(full.attText === '10.00' && full.attSub === '', '无迟到 = 10.00 且不带迟到副行', [full.attText, full.attSub]);
      const none = d({
        className: 'C',
        studentCount: 40,
        run: { enabled: true, dailyRate: null, weeklyRate: null },
        attendance: { ratePercent: null, score: null, lateCount: 0, hasData: false },
      });
      ok(none.attText === '—', '没有考勤数据显示「—」', none.attText);
      ok(none.attLevel === 'none', '「—」不算差评（不能落成 0.00 分）', none.attLevel);
      const low = d({
        className: 'D',
        studentCount: 40,
        run: { enabled: true, dailyRate: 0, weeklyRate: 0 },
        attendance: { ratePercent: 60, score: 6.5, lateCount: 10, hasData: true },
      });
      ok(low.attLevel === 'bad', '6.5 分判为 bad（阈值 = 旧 70% ÷10）', low.attLevel);
      const warn = d({
        className: 'E',
        studentCount: 40,
        run: { enabled: true, dailyRate: 0, weeklyRate: 0 },
        attendance: { ratePercent: 80, score: 7.5, lateCount: 0, hasData: true },
      });
      ok(warn.attLevel === 'warn', '7.5 分判为 warn', warn.attLevel);

      // ===== 考勤统计窗口（用户 2026-11-12「要本日、本周、本月，而不是3天7天这样」）=====
      // 静态检查只能验「代码长什么样」，这里验**行为**：切窗口真的换了请求参数、
      // 页面文案跟着服务端回显走（前端不许自己反推窗口名，否则会出现
      // 「chip 写着本月、数据是本周」—— 而这页的数字是要发进工作群的）。
      // ===== mock：真实接口形态（第三轮新增 hasAnyCheck / copyScope / deductTotal / dayCount）=====
      const rowWithAtt = {
        className: 'A班',
        studentCount: 40,
        departmentName: '计财系',
        run: { enabled: true, dailyRate: 50, weeklyRate: 60, achievedToday: 20, achievedWeek: 24 },
        attendance: {
          score: 9.2,
          ratePercent: 92,
          lateCount: 2,
          hasData: true,
          hasAnyCheck: true,
          // 日均 0.8 / 窗口合计 4.0（5 天）：口径切换的两个数据源
          deduct: 0.8,
          deductTotal: 4.0,
          dayCount: 5,
          deductDetail: [
            {
              key: 'hygiene',
              name: '卫生',
              deduct: 0.6,
              totalDeduct: 3.0,
              targets: [
                { key: 'hygiene:dorm_room', name: '卫生-宿舍', avgDeduct: 0.35, totalDeduct: 1.75, count: 2 },
                { key: 'hygiene:classroom', name: '卫生-教室', avgDeduct: 0.15, totalDeduct: 0.75, count: 1 },
                { key: 'hygiene:area', name: '卫生-卫生区', avgDeduct: 0.1, totalDeduct: 0.5, count: 1 },
              ],
            },
            {
              key: 'study_evening',
              name: '晚自习',
              deduct: 0.2,
              totalDeduct: 1.0,
              targets: [{ key: 'study_evening:classroom', name: '晚自习-教室', avgDeduct: 0.2, totalDeduct: 1.0, count: 1 }],
            },
            // 老服务 / 无受检类型聚合的模块：退回「模块名 - 扣分」
            { key: 'night_dorm', name: '查宿', deduct: 0.1, totalDeduct: 0.5 },
          ],
        },
      };
      const calls = [];
      state.get = (url, params) => {
        calls.push(params);
        // 窗口终点 to：2026-11-19 起窗口是**完整周/月**（与班超同源），
        // 脚注与图片标题必须用服务端下发的 to，不能用所选日 today 顶替。
        const toOf = (r) => (r === 'day' ? '2026-11-12' : r === 'month' ? '2026-11-30' : '2026-11-15');
        return Promise.resolve({
          today: '2026-11-12',
          from: params.attRange === 'day' ? '2026-11-12' : params.attRange === 'month' ? '2026-11-01' : '2026-11-09',
          to: toOf(params.attRange),
          weekStart: '2026-11-09',
          attRange: params.attRange,
          attRangeLabel: { day: '本日', week: '本周', month: '本月' }[params.attRange] || '本周',
          // 系统能力（筛选前全量）：与 rows 无关，前端据此决定班超分列/范围行是否可用
          hasAnyCheck: true,
          copyScope: params.copy || 'all',
          withAtt: params.att === '1',
          attRuleLines: ['总分满分 10 分（含卫生）：每天从 10 分起扣，统计期各天得分取平均', '卫生按评价扣：评良扣 2 分、评差扣 4 分'],
          rows: [rowWithAtt],
          totals: { classCount: 1, studentCount: 40, achievedToday: 20, achievedWeek: 24, dailyRate: 50, weeklyRate: 60, skippedClasses: 0 },
          filtered: null,
          activeFilters: [],
          grades: [],
          schools: [],
          departments: [],
          copyText: 'x',
        });
      };
      const p2 = makePage(def);
      p2.data.todayKeyText = '2026-11-12';
      await p2.load();
      // 首屏：初始列 = 日+周（班超分关）→ copy=all/att=0；
      // 服务端 hasAnyCheck=true → 自动打开班超分列 → **必须补一次请求**让复制正文跟上显示列
      ok(calls.length === 2, '首屏自动打开班超分列后补一次请求（复制正文跟着列走）', calls.length);
      ok(
        calls[0] && calls[0].copy === 'all' && calls[0].att === '0',
        '首次请求按初始列派生 copy=all / att=0',
        calls[0]
      );
      ok(
        calls[1] && calls[1].copy === 'all' && calls[1].att === '1',
        '补的请求带上 att=1（班超分列已显示），复制正文才会写班超分',
        calls[1]
      );
      ok(p2.data.columns.attendance === true, '有检查记录时自动打开班超分列', p2.data.columns);
      ok(p2.data.copyScope === 'all', '复制口径以服务端回显为准（前端不自己映射）', p2.data.copyScope);
      ok(!('days' in (calls[0] || {})), '请求里已经没有旧的 days 参数', Object.keys(calls[0] || {}));
      ok(
        p2.data.attRangeLabel === '本周' && /本周/.test(p2.data.periodText) && /11-09/.test(p2.data.periodText) && /累计扣分×10%/.test(p2.data.periodText) && /缺勤人次×0.02/.test(p2.data.periodText),
        '班超分统计区间来自服务端窗口（from~to + 公式），模板不拼字符串',
        p2.data.periodText
      );
      ok(p2.data.showDeductMode === true, '本周窗口显示「日均/合计」口径', p2.data.showDeductMode);
      ok(p2.data.attRuleLines.length === 2, '规则文案来自服务端', p2.data.attRuleLines);
      ok(/满分 10 分/.test(p2.data.footerText), '页面脚注用服务端规则第一句', p2.data.footerText);
      ok(!/每迟到 1 人扣 0\.05 分/.test(p2.data.footerText), '脚注不再硬编码单价（改了单价不会说谎）', p2.data.footerText);

      // onAttRange 内部是 setData(..., () => this.load())，load 是 async 且不返回给调用方，
      // 所以必须让微任务队列跑完再断言（否则这里读到的永远是上一次响应）。
      const flush = () => new Promise((r) => setTimeout(r, 0));

      p2.onAttRange({ currentTarget: { dataset: { key: 'month' } } });
      await flush();
      ok(calls.length === 3 && calls[2].attRange === 'month', '切本月会重新请求并带上窗口参数', calls[2]);
      ok(/11-01/.test(p2.data.periodText) && /本月/.test(p2.data.periodText), '本月窗口区间/标签按服务端 from~to 回显', p2.data.periodText);
      ok(/11-01/.test(p2.data.periodText) && !/至/.test(p2.data.periodText), '区间文案用「~」而不是旧的「至」（与班超同款）', p2.data.periodText);
      ok(p2.data.showDeductMode === true, '本月窗口仍可选日均/合计', p2.data.showDeductMode);

      // 本日窗口：合计 ≡ 日均 → 隐藏口径（用户 2026-11-20 第三轮）
      p2.onAttRange({ currentTarget: { dataset: { key: 'day' } } });
      await flush();
      ok(p2.data.showDeductMode === false, '本日窗口隐藏「日均/合计」口径（合计=日均，切了没意义）', p2.data.showDeductMode);
      ok(/本日/.test(p2.data.periodText) && /11-12/.test(p2.data.periodText), '本日窗口区间回显', p2.data.periodText);
      // 2026-11-19：脚注区间终点用服务端 **to**（窗口终点），本日窗口 from==to 才是同一天
      ok(/考勤（本日：2026-11-12 ~ 2026-11-12）/.test(p2.data.footerText), '脚注里的窗口随服务端回显联动', p2.data.footerText);
      // 同窗口重复点不应再发请求
      const before = calls.length;
      p2.onAttRange({ currentTarget: { dataset: { key: 'day' } } });
      await flush();
      ok(calls.length === before, '重复点同一窗口不发多余请求', calls.length - before);

      // ===== 窗口终点（2026-11-19）：本周脚注必须写完整周区间（周一~周日），
      // 不能写所选日 —— 否则页面说的区间与实际统计区间不符（用户报「日周月不一致」的表现之一）。
      p2.onAttRange({ currentTarget: { dataset: { key: 'week' } } });
      await flush();
      ok(/考勤（本周：2026-11-09 ~ 2026-11-15）/.test(p2.data.footerText), '本周脚注用完整周终点（不是所选日）', p2.data.footerText);
      ok(p2.data.showDeductMode === true, '切回本周口径选项恢复', p2.data.showDeductMode);

      // ===== 复制口径跟着显示列走（用户 2026-11-20：上面的复制已自动识别显示内容）=====
      // 当前列 = 日+周+班超分 → 派生 all/1；关掉周 → 仍混合 → all/1；再关日 → 只剩班超分 → att/1；
      // 最后关掉班超分 → 只剩周 → weekly/0。每次都要真的重查（服务端生成正文）。
      const lastCall = () => calls[calls.length - 1];
      p2.onToggleColumn({ currentTarget: { dataset: { key: 'weekly' } } });
      await flush();
      ok(
        p2.data.columns.weekly === false && lastCall().copy === 'all' && lastCall().att === '1',
        '关掉周达标后仍按「日+班超分」派生 all/att=1',
        lastCall()
      );
      p2.onToggleColumn({ currentTarget: { dataset: { key: 'daily' } } });
      await flush();
      ok(p2.data.columns.daily === false && lastCall().copy === 'att' && lastCall().att === '1', '只显示班超分 → copy=att/att=1', lastCall());
      p2.onToggleColumn({ currentTarget: { dataset: { key: 'attendance' } } });
      await flush();
      ok(
        p2.data.columns.attendance === false && lastCall().copy === 'daily' && lastCall().att === '0',
        '关掉班超分后三列全空 → 兜底保留日达标，copy=daily/att=0（复制正文不再写班超分）',
        lastCall()
      );
      // 恢复「日+班超分」再验口径切换（onDeductMode 只重排已有行，需要 columns.attendance=true）
      p2.onToggleColumn({ currentTarget: { dataset: { key: 'attendance' } } });
      await flush();
      ok(p2.data.columns.attendance === true, '重新打开班超分列（为口径切换用例恢复前提）', p2.data.columns);

      // ===== 扣分来源 chips（具体受检类型；仅在显示班超分时产出）=====
      // 第五轮：每个模块优先展开 targets（卫生 3 条全展开），同一模块 ≤3、整行 ≤4，其余 +N。
      const chipRow = d({
        className: 'F',
        studentCount: 40,
        run: { enabled: true, dailyRate: 50, weeklyRate: 60 },
        attendance: rowWithAtt.attendance,
      });
      ok(chipRow.deductChips.length === 4, '整行最多 4 条扣分 chip（第五轮放开到 4）', chipRow.deductChips);
      ok(
        chipRow.deductChips.map((c) => c.text).join('|') ===
          '卫生-宿舍 -0.35|晚自习-教室 -0.20|卫生-教室 -0.15|卫生-卫生区 -0.10',
        'chip 展开到受检类型（卫生-宿舍/卫生-教室/卫生-卫生区）+ 两位小数，按扣分降序（同模块最多 3 条）',
        chipRow.deductChips.map((c) => c.text)
      );
      // 来源共 5 条（卫生 3 + 晚自习 1 + 查宿 1）→ 显示 4 + 「+1」（查宿被折进 +N）
      ok(chipRow.deductMore === 1, '其余折成 +N（5 条来源 → 显示 4 + 「+1」）', chipRow.deductMore);
      ok(chipRow.deductLine === '日均扣 0.80', '班超分块下口径副行默认「日均扣 0.80」', chipRow.deductLine);
      // 合计口径：chips 改用 totalDeduct（不乘天数），副行写「合计扣」
      const chipTotal = d(rowWithAtt, { columns: { daily: true, weekly: true, attendance: true }, deductMode: 'total' });
      ok(
        chipTotal.deductChips.map((c) => c.text).join('|') ===
          '卫生-宿舍 -1.75|晚自习-教室 -1.00|卫生-教室 -0.75|卫生-卫生区 -0.50',
        '合计口径的 chips 用服务端 totalDeduct（不是日均 × 天数）',
        chipTotal.deductChips.map((c) => c.text)
      );
      ok(chipTotal.deductLine === '合计扣 4.00', '合计口径副行「合计扣 4.00」', chipTotal.deductLine);
      // 用户 2026-11-20 第五轮：切换日均/合计时 chips 必须跟着变（同一份数据两个口径）
      ok(
        chipRow.deductChips[0].text === '卫生-宿舍 -0.35' && chipTotal.deductChips[0].text === '卫生-宿舍 -1.75',
        '切日均/合计 chips 数值真的变化（不是同一份日均数挂两个标签）',
        [chipRow.deductChips[0].text, chipTotal.deductChips[0].text]
      );
      const chipLegacy = d(
        {
          className: 'G',
          studentCount: 40,
          run: { enabled: true, dailyRate: 50, weeklyRate: 60 },
          attendance: { score: 9.6, ratePercent: 96, lateCount: 0, hasData: true, deductDetail: [{ key: 'hygiene', name: '卫生', deduct: 0.4 }] },
        },
        VIEW_ATT
      );
      ok(
        chipLegacy.deductChips.length === 1 && chipLegacy.deductChips[0].text === '卫生 -0.40',
        '无 targets 的老服务退回「模块名 -0.40」（不显示空白）',
        chipLegacy.deductChips
      );
      // 异常数据：模块有扣分、但 targets 全是 0 → 退回模块名一条，不能把这块扣分吞掉
      const chipZeroTargets = d(
        {
          className: 'G2',
          studentCount: 40,
          run: { enabled: true, dailyRate: 50, weeklyRate: 60 },
          attendance: {
            score: 9.6,
            ratePercent: 96,
            lateCount: 0,
            hasData: true,
            deduct: 0.4,
            deductTotal: 2.0,
            deductDetail: [
              {
                key: 'hygiene',
                name: '卫生',
                deduct: 0.4,
                totalDeduct: 2.0,
                targets: [{ key: 'hygiene:dorm_room', name: '卫生-宿舍', avgDeduct: 0, totalDeduct: 0 }],
              },
            ],
          },
        },
        VIEW_ATT
      );
      ok(
        chipZeroTargets.deductChips.length === 1 && chipZeroTargets.deductChips[0].text === '卫生 -0.40',
        '某模块 targets 全为 0 但模块有扣分 → 退回模块名一条（扣分不被吞掉）',
        chipZeroTargets.deductChips
      );
      const chipNone = d(
        {
          className: 'H',
          studentCount: 40,
          run: { enabled: true, dailyRate: 100, weeklyRate: 100 },
          attendance: { score: 10, ratePercent: 100, lateCount: 0, hasData: true, deductDetail: [] },
        },
        VIEW_ATT
      );
      ok(chipNone.deductChips.length === 0 && chipNone.deductEmptyText === '无扣分', '没有扣分时给「无扣分」弱文案', chipNone.deductEmptyText);

      // ===== 指标矩形块（用户 2026-11-20 第五轮「去掉进度条，改成矩形块」）=====
      const withAtt = d(rowWithAtt, VIEW_ATT);
      ok(withAtt.metricBlocks.length === 3, '显示班超分列：3 个指标块（日/周/班超分）', withAtt.metricBlocks);
      ok(
        withAtt.metricBlocks.map((b) => b.label).join('|') === '日达标|周达标|班超分',
        '块标签顺序 = 日达标/周达标/班超分',
        withAtt.metricBlocks.map((b) => b.label)
      );
      ok(
        withAtt.metricBlocks.map((b) => b.value).join('|') === '50%|60%|9.20',
        '块数值 = 服务端百分比 + 班超分两位小数',
        withAtt.metricBlocks.map((b) => b.value)
      );
      ok(
        withAtt.metricBlocks.map((b) => b.level).join('|') === 'bad|warn|ok',
        '块档位沿用 rateLevel/attScoreLevel（50%→bad / 60%→warn / 9.20→ok）',
        withAtt.metricBlocks.map((b) => b.level)
      );
      // 班超分列关掉：只有日/周两块，且所有扣分信息不产出
      const noAtt = d(rowWithAtt, { columns: { daily: true, weekly: true, attendance: false }, deductMode: 'avg' });
      ok(
        noAtt.metricBlocks.length === 2 && noAtt.metricBlocks.map((b) => b.label).join('|') === '日达标|周达标',
        '班超分列关掉时只有 2 块（日/周）',
        noAtt.metricBlocks
      );
      ok(
        noAtt.deductChips.length === 0 && noAtt.deductEmptyText === '' && noAtt.deductLine === '' && noAtt.scoreEmptyText === '',
        '不显示班超分时没有任何扣分信息（chips/无扣分/口径副行都不产出）',
        [noAtt.deductChips.length, noAtt.deductEmptyText, noAtt.deductLine, noAtt.scoreEmptyText]
      );
      // 无数据 / 不参跑：沿用旧文案语义（— / 不参跑），不落成 0%
      const noneRun = d(
        {
          className: 'J',
          studentCount: 40,
          run: { enabled: true, dailyRate: null, weeklyRate: null },
          attendance: { score: null, deductDetail: [], hasData: false },
        },
        VIEW_ATT
      );
      ok(
        noneRun.metricBlocks[0].value === '—' && noneRun.metricBlocks[1].value === '—' && noneRun.metricBlocks[0].level === 'none',
        '无数据块显示「—」而不是 0%',
        noneRun.metricBlocks
      );
      const disabledRun = d(
        {
          className: 'K',
          studentCount: 40,
          run: { enabled: false, dailyRate: 0, weeklyRate: 0 },
          attendance: { score: null, deductDetail: [], hasData: false },
        },
        VIEW_ATT
      );
      ok(
        disabledRun.metricBlocks[0].value === '不参跑' && disabledRun.metricBlocks[1].value === '不参跑' && disabledRun.runDisabled === true,
        '不参跑的班块文案是「不参跑」（不会被误读成 0%）',
        disabledRun.metricBlocks
      );
      // 没有检查记录：第三块写「无检查记录」而不是 0 分
      const noScore = d(
        { className: 'I', studentCount: 40, run: { enabled: true, dailyRate: 0, weeklyRate: 0 }, attendance: { score: null, deduct: null, deductTotal: null, dayCount: 0, deductDetail: [], hasData: false } },
        VIEW_ATT
      );
      ok(
        noScore.hasScore === false && noScore.scoreEmptyText === '无检查记录' && noScore.metricBlocks[2].value === '无检查记录' && noScore.metricBlocks[2].level === 'none',
        '无检查记录时第三块写「无检查记录」（不是 0 分）',
        [noScore.scoreEmptyText, noScore.metricBlocks[2]]
      );

      // 口径切换不重发请求：onDeductMode 只重排已有行（chips 与口径副行同步变化）
      const beforeMode = calls.length;
      p2.onDeductMode({ currentTarget: { dataset: { key: 'avg' } } });
      await flush();
      ok(calls.length === beforeMode, '切日均/合计不重发请求（服务端两个数都已下发）', calls.length - beforeMode);
      ok(
        p2.data.shown[0].deductChips.map((c) => c.text).join('|') ===
          '卫生-宿舍 -0.35|晚自习-教室 -0.20|卫生-教室 -0.15|卫生-卫生区 -0.10',
        '切到日均后 chips 立刻改用 avgDeduct（与口径同一份数）',
        p2.data.shown[0].deductChips
      );
      ok(p2.data.shown[0].deductLine === '日均扣 0.80', '日均口径副行「日均扣 0.80」', p2.data.shown[0].deductLine);
      p2.onDeductMode({ currentTarget: { dataset: { key: 'total' } } });
      await flush();
      ok(
        p2.data.shown[0].deductChips.map((c) => c.text).join('|') ===
          '卫生-宿舍 -1.75|晚自习-教室 -1.00|卫生-教室 -0.75|卫生-卫生区 -0.50',
        '切到合计后 chips 改用 totalDeduct（与口径副行对得上）',
        p2.data.shown[0].deductChips
      );
      ok(
        p2.data.shown[0].deductLine === '合计扣 4.00',
        '切到合计后口径副行立刻变「合计扣 4.00」',
        p2.data.shown[0].deductLine
      );

      // ===== 生成图片：指标区画矩形块（第五轮），不再画进度条 =====
      // 桩一个 2d ctx 记录每次 fillText/fillRect/strokeRect：
      //  · 断言块内文字（日达标/周达标/班超分 + 数值）都画了；
      //  · 断言没有任何「细长条」绘制（旧进度条形态）；
      //  · 用 2 行 / 45 行两次绘制核对画布高度预算真的跟着新行高走。
      const shot = () => {
        const rec = { texts: [], rects: [], strokes: [] };
        const ctx = {
          font: '',
          fillStyle: '',
          strokeStyle: '',
          textAlign: '',
          textBaseline: '',
          lineWidth: 1,
          scale() {},
          fillText: (t, x, y) => rec.texts.push({ t: String(t), x, y }),
          fillRect: (x, y, w, h) => rec.rects.push({ x, y, w, h }),
          strokeRect: (x, y, w, h) => rec.strokes.push({ x, y, w, h }),
          beginPath() {},
          moveTo() {},
          lineTo() {},
          stroke() {},
        };
        const node = { width: 0, height: 0, getContext: () => ctx };
        // 与真实 SelectorQuery 同链式语义：in()/select().fields() 都回到同一个 query，exec 挂在 query 上
        selectorQueryImpl = () => {
          const q = { in: () => q, select: () => ({ fields: () => q }), exec: (cb) => cb([{ node }]) };
          return q;
        };
        // 输出失败即可（这里只验绘制；真实分享链路不涉及）
        canvasToTempFilePathImpl = (o) => o && o.fail && o.fail({ errMsg: 'check-page-runtime 桩' });
        return { rec, canvas: node };
      };
      const shareRow = (name) =>
        d(
          {
            className: name,
            studentCount: 40,
            run: { enabled: true, dailyRate: 50, weeklyRate: 60 },
            attendance: rowWithAtt.attendance,
          },
          VIEW_ATT
        );
      const newSharePage = (columns, shown, withRules) => {
        const pg = makePage(def);
        pg.data.columns = columns;
        pg.data.shown = shown;
        pg.data.rows = shown;
        pg.data.filtered = { classCount: shown.length, studentCount: shown.length * 40 };
        pg.data.today = '2026-11-12';
        pg.data.from = '2026-11-09';
        pg.data.attTo = '2026-11-15';
        pg.data.attRangeLabel = '本周';
        pg.data.attRuleLines = withRules ? ['卫生按评价扣分'] : [];
        return pg;
      };
      const ROW_ATT = { daily: true, weekly: true, attendance: true };
      const pShare = newSharePage(ROW_ATT, [shareRow('A班'), shareRow('B班')], true);
      const shot2 = shot();
      pShare.onShareImage();
      ok(shot2.canvas.width === 1500 && shot2.canvas.height % 2 === 0, '画布按 750 逻辑宽 ×2 出图（高度为偶数物理像素）', [shot2.canvas.width, shot2.canvas.height]);
      const isBlockRect = (r) => r.h >= 40 && r.h <= 70 && r.w >= 90 && r.w <= 220;
      const blockRects = shot2.rec.rects.filter(isBlockRect);
      ok(blockRects.length === 6, '每行画 3 个矩形块（2 行 × 3 块）', blockRects.length);
      ok(
        blockRects.every((r) => shot2.rec.strokes.some((s) => s.x === r.x && s.y === r.y && s.w === r.w && s.h === r.h)),
        '每个块既有浅底填充也有矩形描边（描边 + 浅底）',
        shot2.rec.strokes.length
      );
      const texts2 = shot2.rec.texts.map((x) => x.t);
      ok(
        texts2.includes('日达标') && texts2.includes('周达标') && texts2.includes('班超分'),
        '图片画了块标签/列头：日达标 · 周达标 · 班超分',
        texts2.slice(0, 20)
      );
      ok(
        texts2.includes('50%') && texts2.includes('60%') && texts2.includes('9.20'),
        '图片画了块内数值（百分比 + 两位小数分数），不再只画文字列',
        texts2.filter((t) => /%|9\.20/.test(t))
      );
      ok(!shot2.rec.rects.some((r) => r.h <= 16 && r.w >= 60), '没有任何细长条绘制（旧进度条形态已删除）', shot2.rec.rects.filter((r) => r.h <= 16));
      ok(
        texts2.includes('唐唐快跑 · 班级状态') && texts2.some((t) => /考勤计算规则/.test(t)),
        '规则文本 / 底部品牌仍由现有逻辑画'
      );
      // 行高从块矩形间距反推（块 y 差 = 行高），45 行时画布高度必须按它线性增长
      const stride = blockRects[3].y - blockRects[0].y;
      ok(stride >= 60, '块式行高比旧文字行（54）更高', stride);
      const many = Array.from({ length: 45 }, (_, i) => shareRow(`C${i}班`));
      const pShare45 = newSharePage(ROW_ATT, many, true);
      const shot45 = shot();
      pShare45.onShareImage();
      ok(
        shot45.canvas.height - shot2.canvas.height === 2 * 43 * stride,
        '45 行画布高度 = 2 行高度 + 43 × 行高（高度预算跟着新行高走，不会重叠）',
        [shot45.canvas.height, shot2.canvas.height, stride]
      );
      ok(
        shot45.rec.texts.filter((x) => x.t === '日达标').length === 46,
        '文本绘制次数随行数线性（日达标 = 45 行各 1 次 + 列头 1 次）',
        shot45.rec.texts.filter((x) => x.t === '日达标').length
      );
      const blocks45 = shot45.rec.rects.filter(isBlockRect);
      ok(blocks45.length === 135, '45 行 × 3 块全部画进画布', blocks45.length);
      const maxBlockBottom = Math.max(...blocks45.map((r) => r.y + r.h));
      ok(
        maxBlockBottom < shot45.canvas.height / 2 - 20,
        '最后一行块底仍留出规则/落款区（内容不被裁）',
        [maxBlockBottom, shot45.canvas.height / 2]
      );
      // 班超分列关掉：每行只画 2 块，且不画任何扣分信息（第三轮约束）
      const pShareNoAtt = newSharePage({ daily: true, weekly: true, attendance: false }, [shareRow('A班')], false);
      const shotNoAtt = shot();
      pShareNoAtt.onShareImage();
      const blocksNoAtt = shotNoAtt.rec.rects.filter(isBlockRect);
      const textsNoAtt = shotNoAtt.rec.texts.map((x) => x.t);
      ok(blocksNoAtt.length === 2, '班超分列关掉时每行只画 2 块（日/周）', blocksNoAtt.length);
      ok(
        !textsNoAtt.includes('班超分') && !textsNoAtt.some((t) => /卫生-|晚自习-|查宿|合计扣|日均扣/.test(t)),
        '班超分列关掉时图片里不画任何扣分信息',
        textsNoAtt.filter((t) => /卫生|晚自习|查宿|扣/.test(t))
      );
      // 还原共享桩（后面的水印相机 target 会自己设置 selectorQuery）
      selectorQueryImpl = () => {
        const q = { in: () => q, select: () => ({ fields: () => q }), exec: (cb) => cb([]) };
        return q;
      };
      canvasToTempFilePathImpl = (o) => o && o.fail && o.fail({ errMsg: 'canvasToTempFilePath:fail 桩未配置' });

      // ===== 用户 2026-11-20 第三轮：导出改成 Excel(.xlsx) + 生成前先预览 =====
      //
      // 用户真机报「CSV 本机无法打开，转发也失败」——微信 wx.openDocument 不支持 csv。
      // 新链路：选窗口 → 拉 json 预览（列 + 前 5 行 + total）→ 用户确认 → 生成 xlsx。
      const p4 = makePage(def);
      p4.data.attRange = 'month';
      p4.data.loading = false;
      p4.data.today = '2026-11-12';
      p4.data.copyText = '可复制的表格文本';
      let sheet = null;
      showActionSheetImpl = (o) => {
        sheet = o;
        o.success({ tapIndex: 0 });
      };
      // 预览接口 stub：列/行形态与后端 format=json 一致（总标 23 列 + sheets 名单；班超分紧跟早八扣分）
      const previewColumns = [
        { title: '序号', wch: 6 },
        { title: '院校', wch: 16 },
        { title: '系部', wch: 16 },
        { title: '专业', wch: 22 },
        { title: '年级', wch: 8 },
        { title: '学生数', wch: 8 },
        { title: '住宿数', wch: 8 },
        { title: '班委数', wch: 8 },
        { title: '学生会成员数', wch: 12 },
        { title: '卫生累计扣分', wch: 12 },
        { title: '晚自习累计扣分', wch: 14 },
        { title: '查宿累计扣分', wch: 12 },
        { title: '早操累计扣分', wch: 12 },
        { title: '早八累计扣分', wch: 12 },
        { title: '班超分', wch: 9 },
        { title: '校园跑班级日目标平均达标率', wch: 24 },
        { title: '校园跑班级周目标平均达标率', wch: 24 },
        { title: '校园跑班级日目标达标次数', wch: 22 },
        { title: '校园跑班级周目标达标次数', wch: 22 },
        { title: '校园跑班级日目标达标最低值', wch: 24 },
        { title: '校园跑班级周目标达标最低值', wch: 24 },
        { title: '校园跑累计步数', wch: 15 },
        { title: '校园跑人均累计步数', wch: 17 },
      ];
      const previewRows = [
        [1, '北校区', '计财系', '信息安全技术应用', '2026', 48, 46, 3, 5, 8, 4, 2, 1, 1, 9.2, '92.3%', '88.5%', 6, 3, '85.7%', '80%', 168000, 3500],
        [2, '北校区', '机电建工系', '电气自动化技术', '2025', 52, 50, 2, 4, 6, 3, 1, 2, 1, 8.7, '88.1%', '84.0%', 5, 2, '81.4%', '76.2%', 175000, 3365],
      ];
      let previewParams = null;
      const pageLoadGet = state.get;
      state.get = async (url, params) => {
        if (url === '/api/admin/class/status-export') {
          previewParams = params;
          return {
            title: '2026年11月17日至2026年11月23日（本周）班级状态总表',
            subtitle: '统计区间：2026-11-01 ~ 2026-11-30（本月） ｜ 筛选：全校 ｜ 共 43 个班 / 2263 人 ｜ 导出时间：2026-11-20 15:30',
            note: '总标 = 看板同源数据；校园跑为区间独立聚合；明细见每班「详细数据」sheet。',
            columns: previewColumns,
            rows: previewRows,
            total: 43,
            sheets: ['总标', '26级信息安全技术应用详细数据', '字段说明'],
            preview: true,
          };
        }
        return pageLoadGet(url, params);
      };
      p4.onExport();
      ok(
        !!sheet && sheet.itemList[0] === '本月考勤表（当前）',
        '导出菜单：当前窗口排第一并标注「（当前）」（选本月时本月在前）',
        sheet && sheet.itemList
      );
      await flush();
      ok(
        !!previewParams && previewParams.format === 'json' && previewParams.preview === '1' && previewParams.attRange === 'month',
        '点导出先拉预览数据（format=json + preview=1 + 当前窗口）',
        previewParams
      );
      ok(p4.data.previewVisible === true && p4.data.previewLoading === false, '预览弹层打开且 loading 收尾', p4.data.previewVisible);
      ok(
        /班级状态总表$/.test(p4.data.previewTitle) && /共 43 个班/.test(p4.data.previewSubtitle),
        '预览标题（新格式：日期段+年级段+班级状态总表）/副标题来自服务端',
        p4.data.previewSubtitle
      );
      ok(
        p4.data.previewCols.length === 23 && p4.data.previewRows.length === 2 && p4.data.previewRows[0].cells.length === 23,
        '预览总标 23 列 × 前 2 行（cells 在 JS 预计算，模板零运算）',
        [p4.data.previewCols.length, p4.data.previewRows.length]
      );
      ok(
        p4.data.previewCols[0].style === 'width:96rpx;' && p4.data.previewRows[0].cells[5].style === 'width:112rpx;',
        '列宽按 Excel 字符宽折算（wch 6 保底 96rpx、wch 8 → 112rpx），行单元格复用同一列宽',
        [p4.data.previewCols[0].style, p4.data.previewRows[0].cells[0].style]
      );
      ok(
        p4.data.previewRows[0].cells[5].v === '48' && /预览前 2 行 · 总表含全部 43 个班/.test(p4.data.previewMoreText) && /将导出 3 张工作表/.test(p4.data.previewSheetsText),
        '预览内容用服务端行数据 + 明确提示「预览≠全表」',
        [p4.data.previewRows[0].cells[5], p4.data.previewMoreText, p4.data.previewSheetsText]
      );

      // 确认导出：生成 **xlsx**（不是 csv），参数里带 format=xlsx
      state.downloads = [];
      state.downloadResult = { filePath: 'wxfile://usr/x.xlsx', fileName: 'x.xlsx', saved: true, via: 'open' };
      lastToast = null;
      p4.data.exporting = false;
      p4.confirmExport();
      await flush();
      ok(p4.data.previewVisible === false, '确认生成后关闭预览弹层', p4.data.previewVisible);
      const dl0 = (state.downloads || [])[0];
      ok(!!dl0 && dl0.url === '/api/admin/class/status-export', '导出真的请求了服务端导出接口', dl0 && dl0.url);
      ok(
        !!dl0 && dl0.opts.fileType === 'xlsx' && dl0.opts.query.format === 'xlsx' && /\.xlsx$/.test(dl0.opts.fileName || ''),
        '生成 Excel：fileType/format/文件名都是 xlsx（微信 openDocument 只认 Office 格式）',
        dl0 && { fileType: dl0.opts.fileType, format: dl0.opts.query.format, name: dl0.opts.fileName }
      );
      ok(
        !!dl0 && dl0.opts.query.attRange === 'month' && !('copy' in dl0.opts.query) && dl0.opts.query.today === '2026-11-12',
        '导出参数：换窗口 + 去掉 copy + 带上服务端回显的 today',
        dl0 && dl0.opts.query
      );
      ok(p4.data.exporting === false, '导出完成后复位 exporting', p4.data.exporting);
      ok(!!lastToast && /已生成本月 Excel/.test(lastToast.title || ''), '成功 toast 说明生成了 Excel（可转发/保存）', lastToast && lastToast.title);

      // 降级分享成功 = 导出成功（本机预览器打不开时降级发送文件，不能报错）
      lastToast = null;
      state.downloadResult = { filePath: 'wxfile://usr/x.xlsx', fileName: 'x.xlsx', saved: true, via: 'share' };
      await p4.exportAttendance('week');
      ok(!!lastToast && /Excel 已保存/.test(lastToast.title || ''), 'via=share 算成功并提示用 Excel/WPS 打开', lastToast && lastToast.title);

      // 失败分档：无权限 / 网络 / 打不开 → 弹窗文案不同；打不开时给「复制文本」兜底
      lastModal = null;
      state.downloadFail = Object.assign(new Error('没有下载权限'), { code: 403, statusCode: 403 });
      p4.data.exporting = false;
      await p4.exportAttendance('week');
      ok(
        !!lastModal && /没有导出权限/.test(lastModal.content || '') && lastModal.confirmText === '复制文本',
        '403 → 「没有导出权限」且提供「复制文本」兜底',
        lastModal && lastModal.content
      );
      lastModal = null;
      state.downloadFail = Object.assign(new Error('网络异常'), { network: true, stage: 'download' });
      p4.data.exporting = false;
      await p4.exportAttendance('week');
      ok(!!lastModal && /网络/.test(lastModal.content || ''), '网络失败 → 提示检查网络', lastModal && lastModal.content);
      lastModal = null;
      state.downloadFail = Object.assign(new Error('本机无法预览'), { stage: 'open' });
      p4.data.exporting = false;
      await p4.exportAttendance('week');
      ok(!!lastModal && /复制表格文本/.test(lastModal.content || ''), '打不开（stage=open）→ 明确引导「复制表格文本」', lastModal && lastModal.content);
      // 导出中重复点击不再弹菜单（showLoading 遮罩 + exporting 双保险）
      state.downloadFail = null;
      p4.data.exporting = true;
      sheet = null;
      p4.onExport();
      ok(sheet === null, '导出中重复点击不弹第二次菜单', !!sheet);
      p4.data.exporting = false;
      // 预览请求失败（用户 2026-11-21「请求失败(200)」）：不再弹「预览失败」死路，
      // 而是关弹层 + **直接降级生成 Excel**（后端支持就仍能导出成功）。
      state.get = async () => {
        throw Object.assign(new Error('预览炸了'), { code: 500 });
      };
      lastModal = null;
      lastToast = null;
      state.downloads = [];
      state.downloadResult = { filePath: 'wxfile://usr/x.xlsx', fileName: 'x.xlsx', saved: true, via: 'open' };
      await p4.openExportPreview('week');
      ok(
        p4.data.previewVisible === false && !!lastToast && /预览不可用/.test(lastToast.title || ''),
        '预览失败 → 关弹层 + toast 提示直接生成 Excel（不留空白弹层）',
        lastToast && lastToast.title
      );
      ok((state.downloads || []).length === 1 && state.downloads[0].opts.fileType === 'xlsx', '预览失败后自动降级导出 xlsx', state.downloads && state.downloads[0] && state.downloads[0].opts);
      // 后端过旧（2xx 但响应不是 JSON → request 层抛 stale）：降级导出也失败时，
      // 弹窗必须把「后端未更新」说清楚，不能再让用户猜「请求失败(200)」。
      state.get = async () => {
        throw Object.assign(new Error('服务端返回格式异常（可能后端未更新）'), { code: -1, stale: true });
      };
      lastModal = null;
      lastToast = null;
      state.downloadFail = Object.assign(new Error('文件格式不支持'), { stage: 'open' });
      p4.data.exporting = false;
      await p4.openExportPreview('week');
      await flush(); // 降级导出是 openExportPreview 里的异步尾巴
      ok(
        !!lastModal && /后端/.test(lastModal.content || ''),
        '后端过旧（stale）+ 导出失败 → 弹窗明确提示「后端未更新/重启后端」',
        lastModal && lastModal.content
      );
      state.downloadFail = null;
      // 复位共享桩（后面的 target 也会用到 ActionSheet 默认行为）
      showActionSheetImpl = (o) => o && o.fail && o.fail({ errMsg: 'showActionSheet:fail cancel' });
    },
  },
  {
    file: 'packageUnion/entry/entry.js',
    name: '检查录入台',
    run(def) {
      // 早八名单范围（用户 2026-11-12 报「名单怎么是全校呢」）：
      // pickerScope 是这条修复的唯一开关，且它读 this.data —— 必须在真实页面实例上跑。
      const page = makePage(def);
      const want = { morning_class: 'class', morning_exercise: 'class', study_evening: 'class', night_dorm: 'dorm', hygiene: 'class' };
      for (const [key, expect] of Object.entries(want)) {
        page.data.moduleKey = key;
        page.data.module = { key };
        let got;
        try {
          got = page.pickerScope();
        } catch (e) {
          got = `抛错 ${e.message}`;
        }
        ok(got === expect, `${key} 名单范围 = ${expect}`, got);
      }
    },
  },
  {
    file: 'packageUnion/wcamera/wcamera.js',
    name: '水印相机（docs/watermark-camera-plan.md）',
    async run(def) {
      const flush = () => new Promise((r) => setTimeout(r, 30));
      // 合成产物的路径断言：canvas 导出在临时区，落盘后进用户目录（wxfile://usr/wm-*.jpg）。
      // 两种情况都算「带水印成片」，但**绝不能**是相机原图（shot.jpg）——
      // 断言比具体文件名更重要的是「拿到的不是原图」。
      const isComposed = (p) => p === 'wxfile://composed.jpg' || /^wxfile:\/\/usr\/wm-/.test(String(p || ''));
      // ===== 画布 / 图片 / 相机的桩 =====
      const ctx = {
        font: '',
        fillStyle: '',
        globalAlpha: 1,
        textBaseline: '',
        save() {}, restore() {}, translate() {}, rotate() {},
        drawImage() {}, fillRect() {}, fillText() {},
        createLinearGradient: () => ({ addColorStop() {} }),
        // measureText 用字数 × 12 估宽：够 wrapText 走真实折行逻辑
        measureText: (t) => ({ width: String(t).length * 12 }),
      };
      const canvasNode = { width: 0, height: 0, getContext: () => ctx };
      canvasNode.createImage = () => {
        const img = { onload: null, onerror: null };
        Object.defineProperty(img, 'src', {
          set(v) {
            img._src = v;
            Promise.resolve().then(() => {
              if (typeof img.onload === 'function') img.onload();
            });
          },
          get() {
            return img._src;
          },
        });
        return img;
      };
      selectorQueryImpl = () => ({
        in: () => ({
          select: () => ({
            fields: () => ({
              exec: (cb) => cb([{ node: canvasNode }]),
            }),
          }),
        }),
      });
      cameraContextImpl = () => ({
        takePhoto: ({ success }) => success({ tempImagePath: 'wxfile://shot.jpg' }),
      });
      // 记录每次输出的 quality：体积闭环用例靠它断言「降档后真的用了第二档质量」
      const outQualities = [];
      canvasToTempFilePathImpl = (o) => {
        outQualities.push(o.quality);
        o.success({ tempFilePath: 'wxfile://composed.jpg' });
      };

      const makeWcam = () => {
        const p = makePage(def);
        const emitted = [];
        let initHandler = null;
        p.getOpenerEventChannel = () => ({
          on: (evt, cb) => {
            if (evt === 'init') initHandler = cb;
          },
          emit: (evt, payload) => emitted.push([evt, payload]),
        });
        p.__emitInit = (payload) => initHandler && initHandler(payload);
        p.__emitted = emitted;
        return p;
      };

      // ---- ① init 文案 → 实时浮层（预览与烙图同源）----
      const page = makeWcam();
      page.onLoad();
      page.__emitInit({ moduleName: '晚自习检查', targetName: '1号教学楼201', deptName: '生活部' });
      page.onShow();
      ok(page.data.live.line1 === '晚自习检查 · 1号教学楼201', '浮层行1 = 模块 · 对象', page.data.live);
      ok(page.data.live.line3 === '生活部 · 张三', '浮层行3 = 部门 · 检查人（本地缓存姓名）', page.data.live.line3);
      ok(/^\d{4}-\d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2}:\d{2}$/.test(page.data.live.line2), '浮层行2 含秒含周X（format 单点口径）', page.data.live.line2);
      // init 迟到（EventChannel 异步）也不崩：无 init 时浮层走缺省文案
      const pNoInit = makeWcam();
      try {
        pNoInit.onLoad();
        pNoInit.onShow();
        ok(pNoInit.data.live.line1 === '检查留证', '无 init 时行1 缺省「检查留证」（不空白）', pNoInit.data.live.line1);
      } catch (e) {
        ok(false, '无 init 时不崩', e.message);
      }

      // ---- ② 乐观预览（2026-11-13 真机反馈「拍完没有确认」的根治）----
      // 桩成 getImageInfo 永不回调（模拟真机大图解码挂死）：快门后确认界面也必须立刻出现
      getImageInfoImpl = () => {};
      page.onShutter();
      await flush();
      ok(page.data.previewing === true && page.data.previewPath === 'wxfile://shot.jpg', '拍完立即进确认界面（乐观预览原图）', {
        previewing: page.data.previewing,
        path: page.data.previewPath,
      });
      ok(page.data.composing === true, '合成在后台追赶（composing 提示可见）', page.data.composing);
      const trayDuringCompose = page.data.tray.length;
      page.onUsePhoto();
      ok(page.data.tray.length === trayDuringCompose, '合成中「用照片」不生效（不把无水印图当成功交上去）', page.data.tray.length);
      page.onRetake();
      ok(page.data.previewing === false && page.data.composing === false, '重拍随时可用（合成中被作废）', {
        previewing: page.data.previewing,
        composing: page.data.composing,
      });

      // ---- ③ 全链路：拍 → 合成 → 预览换图 → 托盘 → 完成 ----
      getImageInfoImpl = (o) => o.success({ width: 800, height: 600, orientation: 'up' });
      page.onShutter();
      await flush();
      ok(page.data.previewing === true && isComposed(page.data.previewPath), '合成完成预览换成带水印图', page.data.previewPath);
      ok(page.data.composing === false, '合成收尾 composing=false（确认按钮恢复）', page.data.composing);
      ok(canvasNode.width === 800 && canvasNode.height === 600, '画布按原图尺寸（orientation up 不交换；2560 档内不缩放）', {
        w: canvasNode.width,
        h: canvasNode.height,
      });
      ok(outQualities[outQualities.length - 1] === 0.92, '首档输出质量 = 0.92（成片规格，2026-11-13 定稿）', outQualities.slice(-1));
      page.onUsePhoto();
      ok(page.data.tray.length === 1 && page.data.previewing === false, '「用照片」进托盘并退出预览', page.data.tray);
      page.onFinish();
      const doneEvt = page.__emitted.find(([evt]) => evt === 'done');
      ok(!!doneEvt && doneEvt[1].photos.length === 1 && isComposed(doneEvt[1].photos[0].path), '「完成」带托盘全部照片回 entry', doneEvt && doneEvt[1]);
      page.__emitted.length = 0;
      page.onFinish();
      ok(page.__emitted.length === 0, '完成防重（连点不重复回传）', page.__emitted.length);
      // 自定义导航：托盘有照片时返回等同「完成」（带照片回录入台）
      const pBack = makeWcam();
      pBack.onLoad();
      pBack.data.tray = [{ path: 'wxfile://t.jpg' }];
      pBack.onBack();
      ok(pBack.__emitted.some(([evt]) => evt === 'done'), '自定义导航返回：托盘有照片时带照片回传', pBack.__emitted);

      // ---- ④ EXIF 姿态：orientation right → 输出宽高互换（§7.2 安卓旋转标记）----
      const p2 = makeWcam();
      p2.onLoad();
      getImageInfoImpl = (o) => o.success({ width: 600, height: 800, orientation: 'right' });
      p2.onShutter();
      await flush();
      ok(canvasNode.width === 800 && canvasNode.height === 600, 'orientation=right 输出宽高互换（水印不横着）', {
        w: canvasNode.width,
        h: canvasNode.height,
      });

      // ---- ⑤ 画布失败自动降档（首档失败 → 2048/0.85 档重试成功）----
      const p3 = makeWcam();
      p3.onLoad();
      getImageInfoImpl = (o) => o.success({ width: 3000, height: 2000, orientation: 'up' });
      let outCalls = 0;
      canvasToTempFilePathImpl = (o) => {
        outCalls += 1;
        outQualities.push(o.quality);
        if (outCalls === 1) o.fail({ errMsg: 'canvasToTempFilePath:fail 桩制造首档失败' });
        else o.success({ tempFilePath: 'wxfile://composed.jpg' });
      };
      p3.onShutter();
      await flush();
      ok(canvasNode.width === 2048 && canvasNode.height === 1365, '首档画布失败后降到 2048 档重试（3000×2000 → 2048×1365）', {
        w: canvasNode.width,
        h: canvasNode.height,
      });
      ok(outQualities[outQualities.length - 1] === 0.85, '降档后的输出质量 = 0.85（阶梯第二档）', outQualities.slice(-1));
      ok(isComposed(p3.data.previewPath) && p3.data.composing === false, '降档重试成功后正常进入可确认态', {
        path: p3.data.previewPath,
        composing: p3.data.composing,
      });

      // ---- ⑤b 体积闭环（round2 A2）：首档成片超 8MB → 自动降到第二档重出 ----
      const p5 = makeWcam();
      p5.onLoad();
      getImageInfoImpl = (o) => o.success({ width: 3000, height: 2000, orientation: 'up' });
      // 桩按 quality 决定成片体积：首档 0.92 → 9MB（超预算），第二档 0.85 → 2MB（通过）
      canvasToTempFilePathImpl = (o) => {
        outQualities.push(o.quality);
        fileInfoSize = o.quality >= 0.9 ? 9 * 1024 * 1024 : 2 * 1024 * 1024;
        o.success({ tempFilePath: 'wxfile://composed.jpg' });
      };
      p5.onShutter();
      await flush();
      ok(canvasNode.width === 2048 && canvasNode.height === 1365, '成片 9MB 超 8MB 预算 → 自动降到 2048 档（闭环只看实际文件大小）', {
        w: canvasNode.width,
        h: canvasNode.height,
      });
      ok(outQualities[outQualities.length - 1] === 0.85 && outQualities[outQualities.length - 2] === 0.92, '体积闭环走了 0.92 → 0.85 两档', outQualities.slice(-2));
      ok(isComposed(p5.data.previewPath) && p5.data.composing === false, '降档重出后进入可确认态', {
        path: p5.data.previewPath,
        composing: p5.data.composing,
      });
      fileInfoSize = 12345; // 复位：后面的 entry 用例依赖默认 size
      canvasToTempFilePathImpl = (o) => {
        outQualities.push(o.quality);
        o.success({ tempFilePath: 'wxfile://composed.jpg' });
      };

      // ---- ⑤c 成片像素必须 1:1 钉死（2026-11-13「水印照片又传不上去」的真根因）----
      // canvasToTempFilePath 的 destWidth/destHeight **默认是「区域尺寸 × 屏幕像素密度」**，
      // 不传就是在画布尺寸上再乘一次 DPR（常见 3 倍）：2560 宽 → 实际输出 7680 宽（44MP），
      // q0.92 成片几十 MB → wx.uploadFile 直接失败。而且**每一档都超预算**，
      // 闭环一路降到最后一档被无条件接受 → 照样几十 MB（「明明在降档还是传不上去」）。
      const pDpr = makeWcam();
      pDpr.onLoad();
      getImageInfoImpl = (o) => o.success({ width: 3000, height: 2000, orientation: 'up' });
      lastCanvasExportOpts = null;
      pDpr.onShutter();
      await flush();
      ok(!!lastCanvasExportOpts, '合成确实走了 canvasToTempFilePath', lastCanvasExportOpts);
      ok(
        lastCanvasExportOpts && lastCanvasExportOpts.destWidth === canvasNode.width && lastCanvasExportOpts.destHeight === canvasNode.height,
        'destWidth/destHeight = 画布像素（1:1，不再被 DPR 放大 3 倍）',
        lastCanvasExportOpts && { dest: [lastCanvasExportOpts.destWidth, lastCanvasExportOpts.destHeight], canvas: [canvasNode.width, canvasNode.height] }
      );
      // 反向：不许传 x/y/width/height 区域参数（部分机型按 canvas 的 CSS 尺寸解释这几个值，
      // 本页离屏画布 CSS 只有 320×240 → 可能只导出左上角一小块）。
      // 区域默认就是整块画布：packageAdmin/class-status 的分享图同样不传区域，现网已验证。
      ok(
        lastCanvasExportOpts && lastCanvasExportOpts.x === undefined && lastCanvasExportOpts.y === undefined && lastCanvasExportOpts.width === undefined && lastCanvasExportOpts.height === undefined,
        '不传区域参数（防机型按 CSS 尺寸解释 → 只导出左上角）',
        lastCanvasExportOpts && { x: lastCanvasExportOpts.x, y: lastCanvasExportOpts.y, w: lastCanvasExportOpts.width, h: lastCanvasExportOpts.height }
      );

      // ---- ⑤d 体积读不到时不许当通过（fail-open 回归）----
      // 旧实现 `!size → 接受`：getFileInfo 一失败就放行第一档超大成片。
      const pNoSize = makeWcam();
      pNoSize.onLoad();
      getImageInfoImpl = (o) => o.success({ width: 3000, height: 2000, orientation: 'up' });
      const qBefore = outQualities.length;
      fileInfoFails = true;
      pNoSize.onShutter();
      await flush();
      fileInfoFails = false;
      const qAfter = outQualities.slice(qBefore);
      // ⑧ 的 `const wm` 在本作用域更靠后（TDZ），这里用独立别名取阶梯长度
      const OUT_N = require(path.join(M, 'utils', 'watermark.js')).OUT_ATTEMPTS.length;
      ok(qAfter.length === OUT_N, '体积读不到 → 逐档降到底（不是第一档就放行）', qAfter);
      ok(qAfter[qAfter.length - 1] === 0.75, '最后一档无条件接受（还有上传侧压缩重试兜底）', qAfter.slice(-1));
      ok(isComposed(pNoSize.data.previewPath) && pNoSize.data.composing === false, '体积未知仍进入可确认态（不卡住录入）', {
        path: pNoSize.data.previewPath,
        composing: pNoSize.data.composing,
      });

      // ---- ⑤e 中途某档抛错但前面已出图：用带水印那张，不退回无水印原图 ----
      const pHalf = makeWcam();
      pHalf.onLoad();
      getImageInfoImpl = (o) => o.success({ width: 3000, height: 2000, orientation: 'up' });
      let halfCalls = 0;
      canvasToTempFilePathImpl = (o) => {
        halfCalls += 1;
        outQualities.push(o.quality);
        if (halfCalls === 1) o.success({ tempFilePath: 'wxfile://composed.jpg' });
        else o.fail({ errMsg: 'canvasToTempFilePath:fail 桩制造后续档失败' });
      };
      fileInfoSize = 9 * 1024 * 1024; // 第一档超预算 → 继续降档 → 降档全失败
      pHalf.onShutter();
      await flush();
      ok(isComposed(pHalf.data.previewPath) && pHalf.data.composing === false, '降档途中失败仍保留已产出的带水印成片', {
        path: pHalf.data.previewPath,
      });
      fileInfoSize = 12345; // 复位
      canvasToTempFilePathImpl = (o) => {
        outQualities.push(o.quality);
        o.success({ tempFilePath: 'wxfile://composed.jpg' });
      };

      // ---- ⑤f 合成产物必须落盘到用户目录（2026-11-13「拍照上传就失败」的真根因）----
      // canvasToTempFilePath 产出的是**临时文件**，微信明确「临时文件随时可能被系统清理」；
      // 而上传发生在相机页 navigateBack 销毁之后 → 连拍几张后最早的合成图可能已被回收，
      // entry 上传时文件不存在 → uploadFile 直接 fail。相册只挑 1~2 张、不产生额外临时文件，
      // 所以「相册能传、拍照不行」。
      const pSave = makeWcam();
      pSave.onLoad();
      getImageInfoImpl = (o) => o.success({ width: 3000, height: 2000, orientation: 'up' });
      copyFileCalls = 0;
      pSave.onShutter();
      await flush();
      ok(copyFileCalls >= 1, '合成完成后 copyFile 落盘（不赌临时文件活到上传那一刻）', copyFileCalls);
      ok(
        pSave.data.previewPath === 'wxfile://usr/wm-1.jpg' || /^wxfile:\/\/usr\//.test(pSave.data.previewPath),
        '预览/托盘用**落盘后的稳定路径**（不是 canvas 临时路径）',
        pSave.data.previewPath
      );
      // 落盘失败要退回临时路径（上传仍尽力而为，不能因此丢照片）
      const pSaveFail = makeWcam();
      pSaveFail.onLoad();
      copyFileFails = true;
      pSaveFail.onShutter();
      await flush();
      copyFileFails = false;
      ok(pSaveFail.data.previewPath === 'wxfile://composed.jpg', '落盘失败退回临时路径（不丢照片）', pSaveFail.data.previewPath);
      ok(pSaveFail.data.composing === false, '落盘失败也进入可确认态（不卡住录入）', pSaveFail.data.composing);

      // ---- ⑥ 两档都失败：保留原图、toast 知情、确认流程照常可用 ----
      const p6 = makeWcam();
      p6.onLoad();
      canvasToTempFilePathImpl = (o) => o.fail({ errMsg: 'canvasToTempFilePath:fail 桩全部失败' });
      lastToast = null;
      p6.onShutter();
      await flush();
      ok(p6.data.composing === false, '合成失败解除 composing（确认不被卡住）', p6.data.composing);
      ok(p6.data.previewing === true && p6.data.previewPath === 'wxfile://shot.jpg', '失败保留乐观预览的原图', p6.data.previewPath);
      ok(lastToast && /已保留原图/.test(lastToast.title), '失败有 toast 知情（不是静默）', lastToast && lastToast.title);
      p6.onUsePhoto();
      ok(p6.data.tray.length === 1 && p6.data.tray[0].path === 'wxfile://shot.jpg', '失败后「用照片」= 交无水印原图（录入不停摆）', p6.data.tray);

      // ---- ⑦ 授权失败：引导面板 + 系统相机回退 ----
      const p4 = makeWcam();
      p4.onLoad();
      p4.onCameraError();
      ok(p4.data.cameraError === true, 'binderror 进引导面板态', p4.data.cameraError);
      chooseMediaImpl = (o) => o.success({ tempFiles: [{ tempFilePath: 'wxfile://sys1.jpg' }, { tempFilePath: 'wxfile://sys2.jpg' }] });
      p4.onSystemCamera();
      await flush();
      const sysEvt = p4.__emitted.find(([evt]) => evt === 'done');
      ok(!!sysEvt && sysEvt[1].photos.length === 2, '回退系统相机：多张照片统一走 done 回传', sysEvt && sysEvt[1]);
      openSettingImpl = (o) => o.success({ authSetting: { 'scope.camera': true } });
      p4.onOpenSetting();
      ok(p4.data.cameraError === false, '授权打开后恢复相机态', p4.data.cameraError);

      // ---- ⑧ wrapText / withTimeout（canvas 无自动换行、合成超时的唯一实现）----
      const wm = require(path.join(M, 'utils', 'watermark.js'));
      const measureCtx = { font: '', measureText: (t) => ({ width: String(t).length * 10 }) };
      const one = wm.wrapText(measureCtx, '短文本', 20, 200, 2);
      ok(one.length === 1 && one[0] === '短文本', '不超宽不折行', one);
      const wrapped = wm.wrapText(measureCtx, '字'.repeat(45), 20, 200, 2);
      ok(wrapped.length === 2, '超宽折成 ≤2 行（plan §4 上限）', wrapped.length);
      ok(wrapped[1].endsWith('…'), '截断补省略号', wrapped[1]);
      const rows = wm.wrapText(measureCtx, '字'.repeat(21), 20, 200, 2);
      ok(rows.length === 2 && !rows[1].endsWith('…'), '恰好装下时不加省略号（21 字折成 20+1）', rows);
      // 成片规格阶梯（round2 A2 定稿；这是规格常量，不是「压缩回潮」）
      ok(
        wm.OUT_ATTEMPTS.length === 3 && wm.OUT_ATTEMPTS[0].longEdge === 2560 && wm.OUT_ATTEMPTS[0].quality === 0.92,
        'OUT_ATTEMPTS 三档阶梯（首档 2560/0.92）',
        wm.OUT_ATTEMPTS
      );
      ok(wm.OUT_MAX_BYTES === 8 * 1024 * 1024, 'OUT_MAX_BYTES = 8MB 预算红线', wm.OUT_MAX_BYTES);
      // 横屏成片版式（round2 B6）：字号基准从图宽换成图高，底条从 42% 压到 ~25%
      const land = wm.computeLayout(4032, 3024);
      ok(land.landscape === true && land.bandH / 3024 <= 0.3, '横屏底条 ≤30% 画面高（不再半张照片是黑条）', {
        landscape: land.landscape,
        bandRatio: +(land.bandH / 3024).toFixed(3),
      });
      ok(land.f2 / 3024 <= 0.08, '横屏时间大字 ≤8% 画面高', +(land.f2 / 3024).toFixed(3));
      ok(land.maxW < 4032 * 0.7, '横屏行1 折行宽度限到 ≤70% 画面宽（长对象名不铺满）', land.maxW);
      const port = wm.computeLayout(3024, 4032);
      ok(
        port.landscape === false && port.f1 === 126 && port.f2 === 202 && port.f3 === 108 && port.maxW === 2722,
        '竖屏规格逐字不变（第一轮验收过的口径，防顺手改小）',
        port
      );
      // withTimeout：正常透传 + 超时按 label 拒绝（「拍完卡死」的根治）
      const passed = await wm.withTimeout(Promise.resolve(7), 50, '不该超时');
      ok(passed === 7, 'withTimeout 正常透传 resolve 值', passed);
      const timeoutErr = await wm.withTimeout(new Promise(() => {}), 20, '自定义超时文案').then(
        () => null,
        (e) => e.message
      );
      ok(timeoutErr === '自定义超时文案', 'withTimeout 超时按 label 拒绝', timeoutErr);

      // ---- ⑨ 横屏接线（round2 B4）：首帧方向 + 转屏跟随 + 卸载清理 ----
      resizeHandlers.length = 0;
      winInfoStub = { statusBarHeight: 44, windowWidth: 812, windowHeight: 375 };
      const pL = makeWcam();
      pL.onLoad();
      ok(pL.data.isLandscape === true, '进页即横屏：首帧按窗口尺寸判方向（WXML 分支不闪竖屏布局）', pL.data.isLandscape);
      pL.onShow();
      resizeHandlers.forEach((h) => h({ size: { windowWidth: 375, windowHeight: 812 } }));
      ok(pL.data.isLandscape === false, '转回竖屏：onWindowResize 跟随切换布局', pL.data.isLandscape);
      resizeHandlers.forEach((h) => h({ size: { windowWidth: 812, windowHeight: 375 } }));
      ok(pL.data.isLandscape === true, '再转横屏：方向状态往返不丢', pL.data.isLandscape);
      const handlerCount = resizeHandlers.length;
      pL.onUnload();
      ok(resizeHandlers.length === handlerCount - 1, 'onUnload 解除转屏监听（不泄漏）', resizeHandlers.length);
      winInfoStub = { statusBarHeight: 44, windowWidth: 375, windowHeight: 812 }; // 复位竖屏

      navigateToImpl = () => {};
      chooseMediaImpl = () => {};
      openSettingImpl = () => {};
      cameraContextImpl = () => null;
      canvasToTempFilePathImpl = (o) => o.success({ tempFilePath: 'wxfile://composed.jpg' });
    },
  },
  {
    file: 'packageUnion/entry/entry.js',
    name: '检查录入台（水印相机接线）',
    async run(def, state) {
      const page = makePage(def);
      page.data.module = { name: '晚自习检查', fields: [{ key: 'photos', type: 'photo', label: '留证照片' }] };
      page.data.current = { targetName: '1号教学楼201' };
      page.data.wmDeptName = '生活部';
      page.data.photos = [];

      // ---- ① init 文案来自页面 data（相机页零网络请求的供给方）----
      let initPayload = null;
      navigateToImpl = (o) => {
        o.success({ eventChannel: { emit: (evt, payload) => { if (evt === 'init') initPayload = payload; } } });
      };
      page.onWatermarkCamera({ currentTarget: { dataset: { field: 'photos' } } });
      ok(!!initPayload, 'onWatermarkCamera 发起 init', initPayload);
      ok(initPayload.moduleName === '晚自习检查' && initPayload.targetName === '1号教学楼201', 'init 带模块与对象（行1 与抽屉标题同源）', initPayload);
      ok(initPayload.deptName === '生活部', 'init 带部门名（/api/union/mine 的 roles[].deptName 下发值）', initPayload);

      // ---- ② done 回传：size 补齐 + 走既有上传管线（pending → done）----
      chooseMediaImpl = () => {};
      const doneShots = [{ path: 'wxfile://w1.jpg' }, { path: 'wxfile://w2.jpg' }, { path: '' }];
      await page.appendWatermarkPhotos(doneShots, 'photos');
      // appendWatermarkPhotos 对 uploadPending 是 fire-and-forget（与相册入口同形态）：
      // 断言上传结果前必须让微任务队列跑完，否则读到的是「正在传」的中间态
      await new Promise((r) => setTimeout(r, 20));
      const photos = page.data.photos;
      ok(photos.length === 2, '空路径被过滤（不入列）', photos.length);
      ok(photos.every((p) => p.size === 12345), '合成产物 size 已补齐（getFileInfo）——失败兜底的 <2MB 判断才不会误跳', photos.map((p) => p.size));
      ok(photos.every((p) => p.status === 'done' && /files\.test/.test(p.url)), '回传照片直接走既有逐张上传管线并成功落 URL', photos.map((p) => [p.status, p.url]));
      ok((state.uploads || []).length === 2, '逐张上传各调了一次 check-photo（Promise.all 并发没有回潮）', state.uploads);
      ok(page.data.form.photos.length === 2, 'syncPhotoForm 已把 URL 写进表单字段', page.data.form.photos);

      // ---- ③ 相册入口：album-only + 带 size ----
      let albumOpts = null;
      chooseMediaImpl = (o) => {
        albumOpts = o;
        o.success({ tempFiles: [{ tempFilePath: 'wxfile://a.jpg', size: 555 }] });
      };
      page.onAlbumPick({ currentTarget: { dataset: { field: 'photos' } } });
      await new Promise((r) => setTimeout(r, 20));
      ok(albumOpts && albumOpts.sourceType.length === 1 && albumOpts.sourceType[0] === 'album', '相册入口 album-only（拍照一律走水印相机）', albumOpts && albumOpts.sourceType);
      ok(page.data.photos.length === 3, '相册照片入列（相册自带 size）', page.data.photos.length);

      // ---- ④ 上传中被挡：按钮不发起选图（与旧单入口同口径）----
      page.data.uploading = true;
      const before = page.data.photos.length;
      page.onWatermarkCamera({ currentTarget: { dataset: { field: 'photos' } } });
      page.onAlbumPick({ currentTarget: { dataset: { field: 'photos' } } });
      ok(page.data.photos.length === before, 'uploading 中双入口都被挡（不会叠出双批次并发上传）', page.data.photos.length);
      page.data.uploading = false;

      // ---- ⑤ 失败原因带真实体积（2026-11-13「水印照片又传不上去」的排查抓手）----
      // 「几十 MB」= 合成侧规格没生效；「1~3MB」= 网络/服务端问题。两种根因修法完全相反，
      // 现场没有这个数字就只能靠猜 —— 所以断言它真的出现在界面文案里（而不只是拼在 JS 里）。
      page.data.photos = [];
      state.uploadFailMsg = '上传超时（照片较大或网络较慢），请检查网络后重试';
      await page.appendWatermarkPhotos([{ path: 'wxfile://big.jpg' }], 'photos');
      await new Promise((r) => setTimeout(r, 20));
      const failedOne = page.data.photos[0] || {};
      ok(failedOne.status === 'failed', '单张失败只标记这一张（不丢整组）', failedOne.status);
      ok(/照片 [\d.]+ (MB|KB)/.test(failedOne.error || ''), '失败文案带这张图的真实体积（现场可自证根因）', failedOne.error);
      state.uploadFailMsg = null;
      // 服务端已给出体积信息时不重复追加
      page.data.photos = [];
      state.uploadFailMsg = '照片超过 12.34 MB 上限';
      await page.appendWatermarkPhotos([{ path: 'wxfile://big2.jpg' }], 'photos');
      await new Promise((r) => setTimeout(r, 20));
      ok(!/（照片 /.test(page.data.photos[0].error || ''), '文案已含体积就不再追加（不出现「MB（照片 MB）」）', page.data.photos[0].error);
      state.uploadFailMsg = null;

      // ---- ⑥ 双路径兜底 + 不静默（2026-11-13「超过 250KB 就传不上去、调试连报错都没有」）----
      // 相机页同时给「用户目录副本」与「临时路径副本」；上传前必须验证哪份真的能读。
      // 旧实现直接信 path，读不到时 getFileInfo 既不 success 也不 fail → 入列链**静默卡死**
      // （照片不出现、没有任何报错），正是用户说的「连报错都没有」。
      page.data.photos = [];
      await page.appendWatermarkPhotos([{ path: 'wxfile://usr/gone.jpg', backupPath: 'wxfile://tmp_alive.jpg' }], 'photos');
      await new Promise((r) => setTimeout(r, 30));
      ok(
        page.data.photos.length === 1 && page.data.photos[0].path === 'wxfile://tmp_alive.jpg',
        '主路径读不到时自动改用备份路径（不再直接丢图）',
        page.data.photos
      );

      // 两份都读不到：必须有可见反馈（toast + console.error），不能静默
      lastToast = null;
      page.data.photos = [];
      const missing = await page.resolvePhotoSource({ path: '', backupPath: '' });
      ok(missing === null, '空路径解析为 null（不抛）', missing);
      const oldGetFileInfo = null;
      // 让所有 getFileInfo 都失败，模拟「文件已被系统清理」
      fileInfoFails = true;
      await page.appendWatermarkPhotos([{ path: 'wxfile://gone-1.jpg', backupPath: 'wxfile://gone-2.jpg' }], 'photos');
      fileInfoFails = false;
      await new Promise((r) => setTimeout(r, 30));
      ok(page.data.photos.length === 0, '两份都失效时不入列（避免传一个不存在的路径）', page.data.photos.length);
      ok(!!lastToast && /失效/.test(lastToast.title || ''), '两份都失效时有可见提示（不静默）', lastToast && lastToast.title);

      // ---- ⑦ 一次失败不许把后续上传卡死（uploading 闸门必须松开）----
      // 旧风险：某张上传「既不成功也不报错」→ uploading 恒 true → 之后每张都静默 return。
      page.data.photos = [];
      state.uploadFailMsg = '上传失败：网络异常';
      await page.appendWatermarkPhotos([{ path: 'wxfile://f1.jpg' }], 'photos');
      await new Promise((r) => setTimeout(r, 30));
      ok(page.data.uploading === false, '失败后 uploading 已复位（不卡死后续上传）', page.data.uploading);
      state.uploadFailMsg = null;
      const beforeSecond = (state.uploads || []).length;
      await page.appendWatermarkPhotos([{ path: 'wxfile://f2.jpg' }], 'photos');
      await new Promise((r) => setTimeout(r, 30));
      ok((state.uploads || []).length >= beforeSecond + 1, '失败一张之后，下一张仍然会正常发起上传', (state.uploads || []).length);
      ok(page.data.photos.some((p) => p.status === 'done'), '第二张上传成功后状态为 done', page.data.photos.map((p) => p.status));

      navigateToImpl = () => {};
      chooseMediaImpl = () => {};
    },
  },
  {
    file: 'packageAdmin/users/users.js',
    name: '用户管理（搜索并发）',
    // 用户 2026-11-12 报「搜索冯绍鹏没有同音字的检查」—— 服务端是对的，真因在前端并发：
    // t-search 每敲一个字触发 reload()，reload 先清空列表再 load()，
    // 旧 load() 开头 `if (loading) return` 把后到的请求全丢了 →
    // 搜 3 个字看到的是第 1 个字（单字，按口径不启用同音）的结果。
    // 这里用**可控制时序的 auth.get** 复现：第 1 个请求慢、后面快，
    // 断言最终列表是**最后那个请求**的结果。
    async run(def, state) {
      const page = makePage(def);
      const calls = [];
      state.get = (url, params) => {
        if (url !== '/api/admin/users') return Promise.resolve({});
        const kw = (params && params.keyword) || '';
        calls.push(kw);
        // 关键字越长返回越快（真实网络就是这样：先发的请求不一定先回）
        const delay = kw.length === 1 ? 60 : 5;
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                list: [{ _id: kw || 'x', realName: `name_for_${kw}`, account: `name_for_${kw}`, nickname: '' }],
                total: 1,
                page: 1,
                limit: 20,
              }),
            delay
          )
        );
      };
      // 直接调 load 三次（绕过防抖定时器，专测并发保护这一层）
      page.data.keyword = '冯';
      const p1 = page.load();
      page.data.keyword = '冯绍';
      const p2 = page.load();
      page.data.keyword = '冯绍鹏';
      const p3 = page.load();
      await Promise.all([p1, p2, p3]);
      const shown = (page.data.list || []).map((r) => r.realName);
      ok(
        shown.length === 1 && shown[0] === 'name_for_冯绍鹏',
        '并发搜索：最终列表 = 最后一次输入的结果（慢的旧请求不得覆盖）',
        { shown, calls }
      );
      ok(calls.length === 3, '三次输入都真的发出了请求（不再被 loading 挡掉）', calls);
      ok(page.data.loading === false, 'loading 已收尾（旧请求不会提前关掉它）', page.data.loading);
    },
  },
  {
    file: 'pages/ranking/ranking.js',
    name: '排行榜（范围 / 班级榜）',
    // 用户 2026-11-12 报「点击系部与院系时出现请完成学生认证」。
    // 真因是服务端按 departmentId/schoolId 判可用性（26 级整届只有名字没有 id），
    // 前端这一侧另有两条必须钉住的接线：
    //   ① 提示文案必须读服务端 needText（写死的那句话把用户引到「去做认证」的死路）；
    //   ② rank.scopes 原样来自接口，页面不得自行兜底成「全部不可用」。
    run(def, state) {
      // ---- ① 点不可用范围：提示 = 服务端下发的 needText ----
      const page = makePage(def);
      lastToast = null;
      page.pickScope({
        currentTarget: {
          dataset: { key: 'department', available: false, needText: '尚未绑定系部，请联系管理员补全学籍' },
        },
      });
      ok(!!lastToast, '点不可用范围会给出提示（不是静默无反应）');
      ok(
        lastToast && lastToast.title === '尚未绑定系部，请联系管理员补全学籍',
        '提示文案来自服务端 needText（不写死「请完成学生认证」）',
        lastToast
      );
      ok(page.data.scope !== 'department', '不可用范围不会被真的选中', page.data.scope);

      // ---- ② 点可用范围：切换并重新拉榜 ----
      let loaded = 0;
      page.load = async () => {
        loaded += 1;
      };
      lastToast = null;
      page.pickScope({ currentTarget: { dataset: { key: 'school', available: true, needText: '' } } });
      ok(page.data.scope === 'school', '可用范围会被选中', page.data.scope);
      ok(loaded === 1 && lastToast === null, '切换范围触发重新加载且不弹提示', { loaded, toast: lastToast });

      // ---- ③ 首屏：接口下发的 scopes 原样进 data（含只有名字的系部/院系可用）----
      state.get = async (url) => {
        if (url !== '/api/ranking') return {};
        return {
          kind: 'person',
          metric: 'steps',
          range: 'today',
          scope: 'all',
          metricText: '步数',
          rangeText: '今日',
          scopeText: '全校',
          unit: '步',
          participants: 1,
          list: [{ rank: 1, openid: 'o1', name: '张三', className: '26级软件技术', steps: 100, value: 100 }],
          me: { rank: 1, value: 100, steps: 100, distanceKm: '0.10', name: '张三', className: '26级软件技术' },
          scopes: [
            { key: 'class', label: '班级', available: true, needText: '' },
            { key: 'department', label: '系部', available: true, needText: '' },
            { key: 'school', label: '院系', available: true, needText: '' },
            { key: 'all', label: '全校', available: true, needText: '' },
          ],
        };
      };
      const p2 = makePage(def);
      return p2.load().then(() => {
        const scopes = (p2.data.rank && p2.data.rank.scopes) || [];
        const dept = scopes.find((s) => s.key === 'department') || {};
        const school = scopes.find((s) => s.key === 'school') || {};
        ok(dept.available === true && school.available === true, '首屏系部/院系范围可用（只有名字也能用）', { dept, school });
        ok(p2.data.rank && (p2.data.rank.list || []).length === 1, '榜单列表正常渲染', p2.data.rank && p2.data.rank.list);
        ok(p2.data.loading === false && !p2.data.error, '加载收尾且无错误', { loading: p2.data.loading, error: p2.data.error });
      });
    },
  },
  {
    file: 'packageAdmin/config/reward-video.js',
    name: '北斗运动配置页（中奖记录筛选）',
    async run(def, state) {
      const flush = () => new Promise((r) => setTimeout(r, 0));
      const prizes = [
        { key: 'steps_1500', label: '1500 步', type: 'steps', amount: 1500, weight: 2 },
        { key: 'steps_100', label: '100 步', type: 'steps', amount: 100, weight: 30 },
        { key: 'none', label: '谢谢参与', type: 'none', amount: 0, weight: 38 },
      ];
      const calls = [];
      // 记录版 stub：命名成 recGet，便于「空字段用例」临时替换后再恢复
      // （否则后面的 query 断言读不到 calls，会误判成「没发请求」）。
      const recGet = async (url) => {
        calls.push(url);
        return {
          list: [{ _id: 'x1', date: '2026-11-12', realName: '陈宇航', studentId: '20230101', className: '23级大数据', source: 'checkin', sourceText: '签到', prizeKey: 'steps_1500', prizeLabel: '1500 步', type: 'steps', amount: 1500, capped: false, roll: 0.01, index: 0, createdAt: '2026-11-12T02:24:00.000Z' }],
          total: 7,
          page: 1,
          limit: 20,
          // 口径整句由服务端下发；页面必须原样渲染，不得自己拼一份
          sourceNote: '抽奖次数是一个合并池，抽奖时按 再来一次 → 签到 → 看视频 → 邀请 的优先级从各来源余额里扣一笔。',
          filters: {},
          facets: {
            source: [
              { key: 'video', label: '看视频', count: 3 },
              { key: 'checkin', label: '签到', count: 2 },
              { key: 'share', label: '邀请', count: 1 },
              { key: 'prize', label: '再来一次', count: 1 },
              { key: 'unknown', label: '未记录', count: 0 },
            ],
            type: [],
            prizes,
          },
        };
      };
      state.get = recGet;

      const p = makePage(def);
      await p.loadDraws(true);
      await flush();
      ok(calls.length === 1 && /beidou-draws\?page=1&limit=20&dateFrom=/.test(calls[0]), '首次载入带分页与默认日期范围', calls[0]);
      ok(p.data.draws.length === 1 && p.data.drawsTotal === 7, '列表与总数写入', [p.data.draws.length, p.data.drawsTotal]);
      ok(p.data.sourceFacets.length === 5, '来源分面 5 项', p.data.sourceFacets.length);

      // ===== 明细行的「详细」字段（用户 2026-11-12「中奖记录详细记录」）=====
      const row = p.data.draws[0];
      ok(row.whoSubText === '20230101 · 23级大数据', '明细含「学号 · 班级」（同名学生要靠学号定位）', row.whoSubText);
      ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(row.timeText), '明细时间是 formatDateTime 口径（不是只有日期）', row.timeText);
      ok(row.prizeText === '1500 步' && row.prizePrefix === '+', '奖品文案用服务端 prizeLabel（模板不再自己拼）', [row.prizeText, row.prizePrefix]);
      ok(row.sourceText === '签到', '来源中文文案直接来自服务端', row.sourceText);
      // 口径整句：页面原样透传服务端文案（顺序改了页面自动跟着变）
      ok(/再来一次 → 签到 → 看视频 → 邀请/.test(p.data.sourceNote), '来源口径整句渲染服务端下发内容', p.data.sourceNote);
      // 服务端没给时不编造（空态不显示，而不是留一句写死的旧说明）
      const pNoNote = makePage(def);
      const saved = state.get;
      state.get = async () => ({ list: [], total: 0, facets: { source: [], type: [], prizes } });
      await pNoNote.loadDraws(true);
      await flush();
      ok(pNoNote.data.sourceNote === '', '服务端没给口径时保持空（不编造写死的说明）', JSON.stringify(pNoNote.data.sourceNote));
      state.get = saved;
      // 服务端没给 prizeLabel 时不能渲染空白
      state.get = async () => ({
        list: [{ _id: 'x2', date: '2026-11-12', realName: '李晓明', type: 'none', amount: 0, capped: false, createdAt: '2026-11-12T01:02:03.000Z' }],
        total: 1, facets: { source: [], type: [], prizes },
      });
      const pEmpty = makePage(def);
      await pEmpty.loadDraws(true);
      await flush();
      ok(pEmpty.data.draws[0].prizeText === '谢谢参与', '缺 prizeLabel 时兜底文案不为空', pEmpty.data.draws[0].prizeText);
      ok(pEmpty.data.draws[0].sourceText === '未记录', '缺 sourceText 时显式标「未记录」（不假装是某个来源）', pEmpty.data.draws[0].sourceText);
      ok(pEmpty.data.draws[0].whoSubText === '', '没有学号/班级时子行为空（不会渲染出「 · 」这种断句）', JSON.stringify(pEmpty.data.draws[0].whoSubText));
      // 必须换回记录版 stub：后面的 query 断言靠 calls 数组，不恢复就会读到空
      state.get = recGet;

      // ⚠️ 这一组是本次修的真 bug：range 没插「全部奖品」占位，而 onDrawPrize 按 idx-1 取值，
      //    导致整个奖品下拉错位一格（选第一个=不筛、永远筛不到最后一个），且不报任何错。
      ok(p.data.prizeLabels[0] === '全部奖品', '奖品 range 首项是「全部奖品」占位', p.data.prizeLabels[0]);
      ok(p.data.prizeKeys[0] === '', 'prizeKeys 首项是空串（与 labels 下标一一对应）', p.data.prizeKeys[0]);
      ok(p.data.prizeLabels.length === prizes.length + 1, 'labels 长度 = 奖池数 + 1', p.data.prizeLabels.length);
      ok(p.data.prizeKeys.length === p.data.prizeLabels.length, 'keys 与 labels 等长（错位就断在这）', {
        keys: p.data.prizeKeys.length, labels: p.data.prizeLabels.length,
      });

      // 选第 1 项（占位）= 不筛
      p.onDrawPrize({ detail: { value: 0 } });
      await flush();
      ok(p.data.drawFilter.prizeKey === '', '选「全部奖品」→ prizeKey 为空（不筛）', p.data.drawFilter.prizeKey);
      // 选第 1 个真实奖品 → 必须是它自己，不是前一个/后一个
      p.onDrawPrize({ detail: { value: 1 } });
      await flush();
      ok(p.data.drawFilter.prizeKey === 'steps_1500', '选第 1 个奖品 → 命中 steps_1500（不错位）', p.data.drawFilter.prizeKey);
      ok(p.data.drawFilterPrizeLabel === '1500 步', '回显文案与实际条件一致', p.data.drawFilterPrizeLabel);
      // 选最后一个奖品必须可达（旧实现永远选不到它）
      p.onDrawPrize({ detail: { value: prizes.length } });
      await flush();
      ok(p.data.drawFilter.prizeKey === 'none', '最后一个奖品也能选中（旧实现筛不到）', p.data.drawFilter.prizeKey);

      // 筛选条件必须进 query（前端本地筛会让「共 N 条」与列表对不上）
      const last = calls[calls.length - 1];
      ok(/prizeKey=none/.test(last), '奖品条件拼进 query（由服务端筛）', last);

      // 来源 chips：点同一个再点一次取消
      p.onDrawSource({ currentTarget: { dataset: { key: 'video' } } });
      await flush();
      ok(p.data.drawFilter.source === 'video' && /source=video/.test(calls[calls.length - 1]), '点来源写入并带上 query', calls[calls.length - 1]);
      p.onDrawSource({ currentTarget: { dataset: { key: 'video' } } });
      await flush();
      ok(p.data.drawFilter.source === '', '再点同一来源取消筛选', p.data.drawFilter.source);

      // 只清来源不影响日期/奖品（与「清空筛选」区分）
      p.onDrawPrize({ detail: { value: 1 } });
      await flush();
      p.onDrawDate({ currentTarget: { dataset: { key: 'dateFrom' } }, detail: { value: '2026-11-01' } });
      await flush();
      p.clearDrawFilterSource();
      await flush();
      ok(
        p.data.drawFilter.source === '' && p.data.drawFilter.prizeKey === 'steps_1500' && p.data.drawFilter.dateFrom === '2026-11-01',
        '「全部来源」只清来源维度，日期与奖品保留',
        p.data.drawFilter
      );

      // 清空筛选：三个维度 + picker 下标一起归零（否则高亮与实际条件不一致）
      p.clearDrawFilter();
      await flush();
      ok(
        !p.data.drawFilter.prizeKey && /^\d{4}-\d{2}-\d{2}$/.test(p.data.drawFilter.dateFrom || '') && p.data.drawFilterPrizeIndex === 0 && !p.data.drawFilterPrizeLabel,
        '清空筛选把奖品维度归零、日期回到默认区间',
        { f: p.data.drawFilter, idx: p.data.drawFilterPrizeIndex, label: p.data.drawFilterPrizeLabel }
      );
      const cleanQ = calls[calls.length - 1];
      ok(!/prizeKey=|source=/.test(cleanQ) && /dateFrom=/.test(cleanQ), '清空后 query 不带奖品/来源筛选（日期回默认区间）', cleanQ);

      // ===== 点路径 setData 真的写进了嵌套对象（检查器基础设施）=====
      p.data.config = { beidou: { prizes: [], checkin: { milestones: [] }, draw: {}, video: {}, share: {} } };
      p.onDrawSource({ currentTarget: { dataset: { key: 'share' } } });
      await flush();
      ok(p.data.drawFilter.source === 'share', "setData({'drawFilter.source'}) 写进了嵌套对象", p.data.drawFilter);

      // 奖池编辑：改权重后归一概率必须实时重算（这是与用户端公示同口径的预览）
      p.data.config.beidou.prizes = [
        { key: 'a', label: 'A', type: 'steps', amount: 100, weight: 30 },
        { key: 'b', label: 'B', type: 'none', amount: 0, weight: 70 },
      ];
      p.recalcOdds();
      ok(p.data.config.beidou.prizes[0].percentText === '30.00%', '归一概率按权重实时算', p.data.config.beidou.prizes[0].percentText);
      p.data.config.beidou.prizes = [
        { key: 'a', label: 'A', type: 'steps', amount: 100, weight: 0 },
      ];
      p.recalcOdds();
      ok(!!p.data.oddsInvalid, '权重全 0 时给出显式警告（不能静默回退默认奖池）', p.data.oddsInvalid);

      // 用户 2026-11-22：保底不再手填 key，改用选择器（看得懂的名字）
      p.data.config.beidou.prizes = [
        { key: 'a', label: '星星奖', type: 'steps', amount: 100, weight: 30 },
        { key: 'b', label: '铜版奖', type: 'coin', amount: 2, weight: 70 },
      ];
      p.data.config.beidou.wheel = { pity: { prizeKey: '' } };
      p.data.config.beidou.grid = {
        pity: { outcomeKey: '' },
        symbols: [{ key: 's', label: '星星', icon: '⭐', type: 'coin', amount: 3, tier: 'low' }],
        outcomes: [{ key: 'o1', label: '星星连线', lines: 1, symbolKey: 's', weight: 100 }],
      };
      // 用户 2026-11-22「后台签到点击更改会变成 21 行」：wx:key 缺失 + 脏数据 21 行
      // 编辑态必须固定 7 行且每行有稳定 dayNo；改一个值后长度不能膨胀
      p.data.config.beidou.checkin.milestones = Array.from({ length: 21 }, () => ({ coin: 1 }));
      p.setData({ canManage: true });
      p.decorateConfig({});
      ok(p.data.config.beidou.checkin.milestones.length === 7, '后台签到固定 7 行（21 行脏数据被截断）', p.data.config.beidou.checkin.milestones.length);
      ok(new Set(p.data.config.beidou.checkin.milestones.map((m) => m.dayNo)).size === 7, '签到每行有稳定且唯一的 dayNo（wx:key 不会重复渲染）', p.data.config.beidou.checkin.milestones.map((m) => m.dayNo));
      p.onMilestoneField({ currentTarget: { dataset: { index: 0 } }, detail: { value: '2' } });
      ok(p.data.config.beidou.checkin.milestones.length === 7, '改签到奖励后仍是 7 行（不会 7 变 21）', p.data.config.beidou.checkin.milestones.length);
      ok(p.data.config.beidou.checkin.milestones[0].coin === 2, '改签到奖励写入对应行', p.data.config.beidou.checkin.milestones[0].coin);
      p.onMilestoneField({ currentTarget: { dataset: { index: 0 } }, detail: { value: '' } });
      ok(p.data.config.beidou.checkin.milestones.length === 7 && p.data.config.beidou.checkin.milestones[0].coin === 0, '删除输入也不会把列表改坏（7 行、第 1 行归 0）', p.data.config.beidou.checkin.milestones);
      p.recalcOdds();
      ok(p.data.pityPrizeLabels[0] === '自动选择最低档铜版奖', '保底奖品选择器首项是「自动」', p.data.pityPrizeLabels[0]);
      ok(p.data.pityPrizeLabels.length === 3, '保底奖品选择器列出全部奖池项（自动 + 2）', p.data.pityPrizeLabels);
      p.onPityPrize({ detail: { value: 1 } });
      ok(p.data.config.beidou.wheel.pity.prizeKey === 'a', '选保底奖品写入对应 key', p.data.config.beidou.wheel.pity.prizeKey);
      ok(p.data.pityPrizeLabel === '星星奖（步数 · 100 步）', '选择器回显可读名称（不显示内部 key）', p.data.pityPrizeLabel);
      ok(p.data.pitySymbolLabels[0] === '自动选择最低单线奖图案', '保底图案选择器首项是「自动」', p.data.pitySymbolLabels[0]);
      p.onPitySymbol({ detail: { value: 1 } });
      ok(p.data.config.beidou.grid.pity.symbolKey === 's', '选保底图案写入对应 key', p.data.config.beidou.grid.pity.symbolKey);
      ok(/星星/.test(p.data.pitySymbolLabel), '保底图案回显可读名称', p.data.pitySymbolLabel);

      // ===== 铜版流水来源标签（srcKind 配色桶）=====
      // 服务端 COIN_SOURCE_TEXT 真实来源是 welcome/video/checkin/share/wheel/grid/refund；
      // 页面把它们折进 5 个配色桶：三任务来源各自一色，游戏产出/赠送归 prize，其余 unknown。
      const coinGet = async (url) => {
        calls.push(url);
        return {
          list: [
            { _id: 'c1', realName: '陈宇航', studentId: '20230101', className: '23级大数据', source: 'video', sourceText: '看视频', delta: 1, balanceAfter: 89, createdAt: '2026-11-12T02:24:00.000Z' },
            { _id: 'c2', realName: '李晓明', source: 'grid', sourceText: '九宫格产出', delta: 2, balanceAfter: 91, createdAt: '2026-11-12T02:20:00.000Z' },
            { _id: 'c3', realName: '王五', source: 'mystery', sourceText: '', delta: -1, balanceAfter: 90, createdAt: '2026-11-12T02:18:00.000Z' },
          ],
          total: 3,
          facets: { source: [], game: [] },
          totals: { earned: 3, spent: 1 },
        };
      };
      state.get = coinGet;
      const pc = makePage(def);
      await pc.loadCoinLogs(true);
      await flush();
      const cl = pc.data.coinLogs;
      ok(cl.length === 3, '铜版流水写入', cl.length);
      ok(
        cl[0].srcKind === 'video' && cl[1].srcKind === 'prize' && cl[2].srcKind === 'unknown',
        '来源映射 video→video / grid→prize / 未知→unknown',
        cl.map((r) => r.srcKind)
      );
      ok(
        cl[0].deltaText === '+1' && cl[2].deltaText === '-1' && cl[2].directionText === '扣除',
        '增减方向文案正确',
        [cl[0].deltaText, cl[2].deltaText, cl[2].directionText]
      );
      state.get = recGet;

      // 接口失败不能把上一次的记录留着（会被当成最新数据）
      state.get = () => Promise.reject(Object.assign(new Error('boom'), { code: 500 }));
      const p2 = makePage(def);
      await p2.loadDraws(true);
      await flush();
      ok(p2.data.draws.length === 0 && p2.data.drawsLoading === false, '失败时列表为空且收尾 loading', [p2.data.draws.length, p2.data.drawsLoading]);
    },
  },
];

(async () => {
  for (const t of TARGETS) {
    console.log(`\n[${t.name}] ${t.file}`);
    const state = DEFAULT_STATE();
    let def;
    try {
      def = loadPage(t.file, state);
    } catch (e) {
      ok(false, `${t.file} 可被加载`, e.message);
      continue;
    }
    try {
      await t.run(def, state);
    } catch (e) {
      ok(false, `${t.name} 用例整体未抛错`, e.message);
    }
  }

  console.log(failed ? `\n发现 ${failed} 个问题` : '\n页面运行时自检全部通过');
  process.exit(failed ? 1 : 0);
})();
