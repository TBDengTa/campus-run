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
        video: { drawPerWatch: 1, dailyLimit: 10, adUnitId: '', count: 2, remaining: 8 },
        share: { drawPerShare: 1, dailyLimit: 0, minIntervalSec: 5, count: 1, remaining: -1 },
        checkin: {
          enabled: true,
          done: false,
          streak: 2,
          todayIndex: 2,
          milestones: [
            { draw: 1, steps: 0 }, { draw: 1, steps: 0 }, { draw: 2, steps: 200 },
            { draw: 1, steps: 0 }, { draw: 1, steps: 0 }, { draw: 1, steps: 0 }, { draw: 3, steps: 500 },
          ],
          award: { draw: 0, steps: 0 },
        },
        draw: {
          remaining: 3, unlimited: true, total: 5, used: 2, maxPerDay: 0,
          prizes: [
            { key: 'steps_100', label: '100 步', type: 'steps', amount: 100, weight: 30, percent: 30 },
            { key: 'none', label: '谢谢参与', type: 'none', amount: 0, weight: 70, percent: 70 },
          ],
          sectors: ['steps_100', 'none', 'steps_100', 'none', 'steps_100', 'none', 'steps_100', 'none'],
          sectorCount: 8,
        },
        cap: { cap: 3000, used: 300, left: 2700, capped: false },
        earned: { steps: 300, distance: 210, calories: 12, durationSeconds: 150 },
        rarityText: '最低概率奖：1500 步 2% · 最高：谢谢参与 38%',
        sfxEnabled: true,
        recent: [{ prizeKey: 'steps_100', prizeLabel: '100 步', type: 'steps', amount: 100, capped: false, atText: '09:12' }],
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
      ok(page.data.remaining === 3, 'remaining = 3', page.data.remaining);
      ok(String(page.data.capText || '').indexOf('2700') >= 0, 'capText 含剩余额度', page.data.capText);
      ok(String(page.data.rarityText || '').indexOf('最低概率') >= 0, '概率区间文案已下发（折叠时也能看到）', page.data.rarityText);
      ok(page.data.checkin.cells.length === 7, '签到 7 格', page.data.checkin.cells.length);
      ok(
        page.data.checkin.cells.filter((c) => c.signed).length === 2,
        '连签 2 天 → 2 格打勾',
        page.data.checkin.cells.filter((c) => c.signed).length
      );
      ok(page.data.checkin.cells.some((c) => c.isToday), '有「今天」高亮格');
      // 第 3/7 天（有步数的那两档）必须被标出来，否则用户看不出哪天是大奖
      ok(
        page.data.checkin.cells.filter((c) => c.big).length === 2,
        '第 3/7 天被标记（有步数奖励）',
        page.data.checkin.cells.filter((c) => c.big).length
      );
      // 用户 2026-11-13「签到没有显示获得奖品，只有大字」：
      // 每个格子必须写清「给几次 / 给多少步」，不能只有一个「大」字。
      const c3 = page.data.checkin.cells[2];
      ok(c3.rewardDrawText === '+2次' && c3.rewardStepsText === '+200步', '第 3 天写清「+2次 / +200步」', c3);
      const c1 = page.data.checkin.cells[0];
      ok(c1.rewardDrawText === '+1次' && c1.rewardStepsText === '', '第 1 天只有次数（无步数时该行不出现）', c1);
      ok(
        page.data.checkin.cells.every((c) => c.rewardDrawText || c.rewardStepsText),
        '每个格子都至少写了一个奖励（不会有空白的「大」）',
        page.data.checkin.cells.map((c) => [c.rewardDrawText, c.rewardStepsText])
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
        capped: false, remaining: 2, unlimited: true, total: 5, used: 3,
        earned: { steps: 400, distance: 280, calories: 16, durationSeconds: 200 },
        cap: { cap: 3000, used: 400, left: 2600, capped: false },
        newBadges: [],
      });
      const cases = [
        ['normal', { key: 'steps_100', label: '100 步', type: 'steps', amount: 100 }, 'normal'],
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
          ok(page.data.confetti.length > 0, '最稀有才有彩带', page.data.confetti.length);
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

      // ---- ③c 中心按钮三态 + 没次数时点它是「去赚次数」而不是死按钮 ----
      ok(page.data.centerMain === '抽奖' && /剩/.test(page.data.centerSub), '有次数：中心显示「抽奖 + 剩 N 次」', {
        main: page.data.centerMain, sub: page.data.centerSub,
      });
      page.applyCounters({ remaining: 0 });
      ok(page.data.centerMain === '赚次数', '没次数：中心变成「赚次数」（不是灰色「没次数」死按钮）', page.data.centerMain);
      ok(page.data.centerSub === '去做任务', '没次数：副文案直接指向下一步', page.data.centerSub);
      // 点中心在没有次数时必须滚到任务区，**绝不能**发抽奖请求
      let scrolled = 0;
      page.scrollToTasks = () => { scrolled += 1; };
      let drew = 0;
      page.draw = () => { drew += 1; };
      page.tapCenter();
      ok(scrolled === 1 && drew === 0, '没次数时点中心 = 滚到任务区（不发抽奖请求）', { scrolled, drew });
      page.applyCounters({ remaining: 2 });
      page.tapCenter();
      ok(drew === 1, '有次数时点中心 = 抽奖', drew);

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
      ok(page.data.fx === '' && page.data.confetti.length === 0, 'closeFx 立刻收起并清彩带', {
        fx: page.data.fx, confetti: page.data.confetti.length,
      });

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
    },
  },
  {
    file: 'packageAdmin/class-status/class-status.js',
    name: '班级状态总览',
    async run(def, state) {
      // decorate 是纯展示函数（用户报的「考勤 100% 应该显示分数」就落在这里）
      const page = makePage(def);
      const d = (r) => page.decorate(r);
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
      const calls = [];
      state.get = (url, params) => {
        calls.push(params);
        return Promise.resolve({
          today: '2026-11-12',
          from: params.attRange === 'day' ? '2026-11-12' : params.attRange === 'month' ? '2026-11-01' : '2026-11-09',
          weekStart: '2026-11-09',
          attRange: params.attRange,
          attRangeLabel: { day: '本日', week: '本周', month: '本月' }[params.attRange] || '本周',
          attRuleLines: ['考勤分 = 10 × 加权出勤率 − 早八迟到人数 × 0.05', '早操 / 晚自习：出勤率 = 实到 ÷ 应到'],
          rows: [{ className: 'A班', studentCount: 40, run: { enabled: true, dailyRate: 50, weeklyRate: 60 }, attendance: { score: 9.9, ratePercent: 99, lateCount: 2, hasData: true } }],
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
      ok(calls.length === 1 && calls[0].attRange === 'week', '缺省按本周请求（不再传 days）', calls[0]);
      ok(!('days' in (calls[0] || {})), '请求里已经没有旧的 days 参数', Object.keys(calls[0] || {}));
      ok(p2.data.attRangeLabel === '本周' && /本周/.test(p2.data.attRangeText), '窗口标签用服务端回显', p2.data.attRangeText);
      ok(p2.data.attRuleLines.length === 2, '规则文案来自服务端', p2.data.attRuleLines);
      ok(/10 × 加权出勤率/.test(p2.data.footerText), '页面脚注用服务端规则第一句', p2.data.footerText);
      ok(!/每迟到 1 人扣 0\.05 分/.test(p2.data.footerText), '脚注不再硬编码单价（改了单价不会说谎）', p2.data.footerText);

      // onAttRange 内部是 setData(..., () => this.load())，load 是 async 且不返回给调用方，
      // 所以必须让微任务队列跑完再断言（否则这里读到的永远是上一次响应）。
      const flush = () => new Promise((r) => setTimeout(r, 0));

      p2.onAttRange({ currentTarget: { dataset: { key: 'month' } } });
      await flush();
      ok(calls.length === 2 && calls[1].attRange === 'month', '切本月会重新请求并带上窗口参数', calls[1]);
      ok(p2.data.attRangeText.includes('2026-11-01'), '本月窗口区间按服务端 from 显示', p2.data.attRangeText);
      ok(p2.data.attRangeText.includes('本月'), '本月窗口标签来自服务端回显', p2.data.attRangeText);
      p2.onAttRange({ currentTarget: { dataset: { key: 'day' } } });
      await flush();
      ok(p2.data.attRangeText.includes('仅当日'), '本日窗口显示「仅当日」（from==today 不说成一段区间）', p2.data.attRangeText);
      ok(/考勤（本日：2026-11-12 ~ 2026-11-12）/.test(p2.data.footerText), '脚注里的窗口随服务端回显联动', p2.data.footerText);
      // 同窗口重复点不应再发请求
      const before = calls.length;
      p2.onAttRange({ currentTarget: { dataset: { key: 'day' } } });
      await flush();
      ok(calls.length === before, '重复点同一窗口不发多余请求', calls.length - before);

      // ===== 图片底部布局（用户 2026-11-12「要在图片下面标注考勤计算规则」）=====
      // 画布溢出是**静默**的：图片能生成、能发出去，只是规则少了半行。
      // 所以这里把「footH 是否装得下所有行」直接算出来断言，而不是靠肉眼看图。
      const wrapped = p2.wrapCanvasLines(
        ['考勤分 = 10 × 加权出勤率 − 早八迟到人数 × 0.05', '早操 / 晚自习：出勤率 = 实到 ÷ 应到；缺勤 1 人扣 10 ÷ 应到人数（班越大扣得越少）'],
        34
      );
      ok(wrapped.every((l) => l.length <= 34), '折行后每行不超预算（不会溢出画布宽度）', wrapped.map((l) => l.length));
      ok(wrapped[0].startsWith('· '), '规则条目带项目符', wrapped[0]);
      ok(wrapped.length >= 3, '长句被切成多行', wrapped.length);

      const foot = p2.planShareFooter({ omitted: 5, wrapped: ['考勤计算规则（本周：2026-11-09 ~ 2026-11-12）', ...wrapped] });
      ok(foot.lines.length >= 4, '底部含口径行 + 截断行 + 规则标题 + 条目', foot.lines.map((l) => l.kind));
      ok(foot.lines.some((l) => l.kind === 'ruleTitle'), '规则标题单独一档（绘制时加粗上色）', foot.lines.map((l) => l.kind));
      // 逐行不重叠 + 最后一行不越过 footH（这两条就是「图片被切」的判据）
      const ys = foot.lines.map((l) => l.y);
      ok(ys.every((y, i) => i === 0 || y > ys[i - 1]), '各行 y 严格递增（不重叠）', ys);
      const lastBottom = ys[ys.length - 1];
      ok(foot.footH >= lastBottom + 20, `footH(${foot.footH}) 装得下最后一行(${lastBottom})`, { footH: foot.footH, lastBottom });
      // 后端没给规则时不编造：底部只剩口径 + 截断
      const footNoRule = p2.planShareFooter({ omitted: 0, wrapped: [] });
      ok(!footNoRule.lines.some((l) => l.kind === 'rule' || l.kind === 'ruleTitle'), '没有规则数据时不画规则块', footNoRule.lines.map((l) => l.kind));
      ok(footNoRule.footH >= 60, '没有规则块时底部仍有落款空间', footNoRule.footH);
      ok(foot.footH > footNoRule.footH, '有规则块时画布更高（规则不会被压进原高度）', [foot.footH, footNoRule.footH]);

      // 失败路径必须清空规则（留着上一次的会被当成最新数据发进群里）
      state.get = () => Promise.reject(Object.assign(new Error('boom'), { code: 500 }));
      const p3 = makePage(def);
      p3.data.todayKeyText = '2026-11-12';
      await p3.load();
      ok(p3.data.attRuleLines.length === 0 && p3.data.footerText === '', '加载失败清空规则与脚注', [p3.data.attRuleLines, p3.data.footerText]);
      ok(!!p3.data.errorText, '失败有显式错误文案', p3.data.errorText);
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
      ok(calls.length === 1 && /beidou-draws\?page=1&limit=20$/.test(calls[0]), '首次载入只带分页参数（无筛选不传空值）', calls[0]);
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
        !p.data.drawFilter.prizeKey && !p.data.drawFilter.dateFrom && p.data.drawFilterPrizeIndex === 0 && !p.data.drawFilterPrizeLabel,
        '清空筛选把下标与回显文案一起归零',
        { f: p.data.drawFilter, idx: p.data.drawFilterPrizeIndex, label: p.data.drawFilterPrizeLabel }
      );
      const cleanQ = calls[calls.length - 1];
      ok(!/prizeKey=|dateFrom=|source=/.test(cleanQ), '清空后 query 不带任何筛选条件', cleanQ);

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
