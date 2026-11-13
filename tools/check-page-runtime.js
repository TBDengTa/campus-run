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
        getUser: () => ({ role: 'student' }),
        // state.get 可被用例替换：让页面走「真实接口形态」的 payload，而不是空对象
        get: (url, params) => state.get(url, params),
        post: async () => ({}),
        put: async () => ({}),
        isBound: () => true,
      };
    }
    if (p.includes('utils/format')) return require(path.join(M, 'utils/format.js'));
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

const WX_STUB = {
  showToast(o) {
    lastToast = o || null;
  },
  showModal() {},
  showLoading() {},
  hideLoading() {},
  navigateBack() {},
  navigateTo() {},
  reLaunch() {},
  switchTab() {},
  pageScrollTo() {},
  vibrateShort() {},
  setClipboardData() {},
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
    run(def) {
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
      // 第 3/7 天（有步数的那两档）必须被标大，否则用户看不出哪天是大奖
      ok(
        page.data.checkin.cells.filter((c) => c.big).length === 2,
        '第 3/7 天标为「大」（有步数奖励）',
        page.data.checkin.cells.filter((c) => c.big).length
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

      // ---- ③ 转盘停位（差半格就会「停在 A 却发 B」）----
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
