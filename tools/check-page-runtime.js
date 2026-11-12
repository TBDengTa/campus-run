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
    return {};
  };
}

const WX_STUB = {
  showToast() {},
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
  page.setData = function (patch) {
    for (const k of Object.keys(patch)) this.data[k] = patch[k];
  };
  return page;
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
        recent: [{ prizeKey: 'steps_100', type: 'steps', amount: 100, capped: false, at: '2026-11-12T01:00:00.000Z' }],
      };
      try {
        page.applyState(payload);
        ok(true, 'applyState 执行无异常（首屏不会白屏）');
      } catch (e) {
        ok(false, 'applyState 执行无异常（首屏不会白屏）', e.message);
      }
      ok(page.data.earned && page.data.earned.steps === 300, 'earned 正确写入 data', page.data.earned);
      ok(page.data.earnedStepsText === '300', 'earnedStepsText 已计算', page.data.earnedStepsText);
      ok(Array.isArray(page.data.sectors) && page.data.sectors.length === 8, 'sectors 渲染 8 格', (page.data.sectors || []).length);
      ok(
        typeof page.data.wheelBg === 'string' && page.data.wheelBg.indexOf('conic-gradient') === 0,
        'wheelBg 是 conic-gradient（盘面不会空）',
        page.data.wheelBg
      );
      ok(page.data.remaining === 3, 'remaining = 3', page.data.remaining);
      ok(String(page.data.capText || '').indexOf('2700') >= 0, 'capText 含剩余额度', page.data.capText);
      ok(page.data.checkin.cells.length === 7, '签到 7 格', page.data.checkin.cells.length);
      ok(
        page.data.checkin.cells.filter((c) => c.signed).length === 2,
        '连签 2 天 → 2 格打勾',
        page.data.checkin.cells.filter((c) => c.signed).length
      );
      ok(page.data.checkin.cells.some((c) => c.isToday), '有「今天」高亮格');

      // ---- ② 抽奖结果 ----
      try {
        page.applyDrawResult({
          success: true, index: 0, prize: { key: 'steps_100', label: '100 步', type: 'steps', amount: 100 },
          capped: false, remaining: 2, unlimited: true, total: 5, used: 3,
          earned: { steps: 400, distance: 280, calories: 16, durationSeconds: 200 },
          cap: { cap: 3000, used: 400, left: 2600, capped: false },
          newBadges: [],
        });
        ok(true, 'applyDrawResult 执行无异常');
      } catch (e) {
        ok(false, 'applyDrawResult 执行无异常', e.message);
      }
      ok(
        page.data.lastPrize && String(page.data.lastPrize.text || '').indexOf('100') >= 0,
        'lastPrize 文案正确',
        page.data.lastPrize && page.data.lastPrize.text
      );
      ok(page.data.earnedStepsText === '400', '抽奖后已入账刷新为 400', page.data.earnedStepsText);

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
    run(def) {
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
];

console.log('页面运行时自检（在桩环境里真实执行页面 JS 的关键方法）');
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
