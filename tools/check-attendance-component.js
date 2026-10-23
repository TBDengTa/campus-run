// 可重复运行的组件契约测试：用服务端真实响应形状（B 的 GET /api/class/attendance）驱动 attendance 组件的取值逻辑
// 运行：node tools/check-attendance-component.js
// 手法与 C 的 mock 运行时一致：vm + 假 Component/Page/wx，把组件代码原样加载后调用其方法。
//
// 夹具说明（重要）：服务端的查询查宿未归只在 **days[].modules[key].notReturned** 与
// **summary.modules[key].notReturned** 上；API 文档里 summary 是模块 MAP
// （不是 { modules: {...} } 的嵌套），所以夹具按文档形状写，避免夹具自身走样导致误报。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const compPath = path.join(__dirname, '..', 'miniprogram', 'components', 'attendance', 'attendance.js');
const MINI = path.join(__dirname, '..', 'miniprogram');
const code = fs.readFileSync(compPath, 'utf8');

// ===== 服务端真实响应（照 server/src/routes/class.js 的 ok(res, {...}) 形状构造）=====
const serverResponse = {
  className: '23级大数据技术',
  from: '2026-03-02',
  to: '2026-03-08',
  role: 'homeroom',
  canNudge: true,
  classInfo: {
    className: '23级大数据技术',
    studentCount: 45,
    hasMorningExercise: false, // 本班无早操
    hasMorningClass: true,
    hasMorningRun: false,
  },
  days: [
    {
      date: '2026-03-08',
      weekday: '周日',
      hasRecord: true,
      absentTotal: 2,
      modules: {
        morning_class: { key: 'morning_class', name: '早八', should: 45, actual: 43, absent: 2, notReturned: 0, avgRate: 0.9778, ratePercent: 97.8, days: 1 },
        night_dorm: { key: 'night_dorm', name: '查宿', should: 40, actual: 37, absent: 0, notReturned: 2, avgRate: 0.95, ratePercent: 95, days: 1 },
      },
    },
    {
      date: '2026-03-07',
      weekday: '周六',
      hasRecord: true,
      absentTotal: 1,
      modules: {
        morning_class: { key: 'morning_class', name: '早八', should: 45, actual: 44, absent: 1, notReturned: 0, avgRate: 1, ratePercent: 100, days: 1 },
      },
    },
    { date: '2026-03-06', weekday: '周五', hasRecord: false, absentTotal: 0, modules: {} },
  ],
  // ===== summary：按真实 API 形状 —— 它**本身就是模块 map**（键即 moduleKey），
  // 模块字段直接挂在 map 上；另有 totalDays/recordedDays/skipped/absentTotal/... 这些元信息。
  // （早前夹具写成 { modules: {...} } 的嵌套，那是错的一层，会同时骗过我自己与代码。）
  summary: {
    from: '2026-03-02',
    to: '2026-03-08',
    totalDays: 7,
    recordedDays: 2,
    morning_exercise: { key: 'morning_exercise', name: '早操', rateName: '出勤率', skipped: true, skipReason: '本班无早操', days: 0, should: 0, actual: 0, absent: 0, notReturned: 0, avgRate: null, ratePercent: null },
    morning_class: { key: 'morning_class', name: '早八', rateName: '出勤率', skipped: false, skipReason: '', days: 2, should: 90, actual: 87, absent: 3, notReturned: 0, avgRate: 0.9667, ratePercent: 96.7 },
    study_evening: { key: 'study_evening', name: '晚自习', rateName: '出勤率', skipped: false, skipReason: '', days: 1, should: 40, actual: 38, absent: 2, notReturned: 0, avgRate: 0.95, ratePercent: 95 },
    night_dorm: { key: 'night_dorm', name: '查宿', rateName: '在宿率', skipped: false, skipReason: '', days: 1, should: 40, actual: 37, absent: 0, notReturned: 2, avgRate: 0.95, ratePercent: 95 },
    hygiene: { key: 'hygiene', name: '卫生', rateName: '得分', skipped: false, skipReason: '', days: 1, should: 0, actual: 0, absent: 0, notReturned: 0, avgRate: null, ratePercent: null },
    skipped: { morning_exercise: '本班无早操' },
    absentTotal: 3,
    notReturnedTotal: 2,
    avgRate: 0.9606,
    ratePercent: 96.1,
  },
};

// ===== 假运行时：只需要 auth.get 返回上面的响应 + setData 落地 =====
const sandboxResults = {};
const fakeWx = { showToast() {}, getStorageSync: () => '', setStorageSync() {} };
let instance = null;

const sandbox = {
  console,
  require(p) {
    if (p.includes('utils/request')) {
      return { get: async () => serverResponse, post: async () => ({}), env: {} };
    }
    if (p.includes('utils/format')) {
      return { todayKey: () => '2026-03-08', formatNumber: (n) => String(n) };
    }
    throw new Error(`未预期的 require: ${p}`);
  },
  getApp: () => ({ ensureLogin: async () => ({}), globalData: { userInfo: {} }, requireLogin: () => true }),
  wx: fakeWx,
  Component(def) {
    instance = {
      data: { ...(def.data || {}) },
      properties: def.properties || {},
      setData(patch) {
        for (const [k, v] of Object.entries(patch)) {
          if (k.includes('.')) {
            const [a, b] = k.split('.');
            this.data[a] = { ...(this.data[a] || {}), [b]: v };
          } else this.data[k] = v;
        }
      },
      triggerEvent(name, detail) {
        sandboxResults.events = sandboxResults.events || [];
        sandboxResults.events.push({ name, detail });
      },
      selectComponent: () => null,
    };
    for (const [k, fn] of Object.entries(def.methods || {})) instance[k] = fn.bind(instance);
    Object.assign(instance.properties, { className: '23级大数据技术', refreshAt: 0 });
    Object.assign(instance.data, { className: '23级大数据技术' });
    instance.data.className = '23级大数据技术';
    instance.data.period = instance.data.period || 'day';
  },
  Page() {},
};
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

function assert(name, cond, detail) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -> ${detail}`}`);
  if (!cond) process.exitCode = 1;
}

(async () => {
  // 直接调用组件的取数方法（load 内部串起 normalizeModules/Days/Summary）
  const res = instance.load ? instance.load() : null;
  if (res && typeof res.then === 'function') await res;
  const d = instance.data;

  const keys = (d.modules || []).map((m) => m.key);
  assert('模块列表非空（对象 shaped modules 被正确读取）', keys.length >= 4, JSON.stringify(keys));
  assert('模块顺序按 MODULE_ORDER', JSON.stringify(keys) === JSON.stringify(['morning_exercise', 'morning_class', 'study_evening', 'night_dorm', 'hygiene']), JSON.stringify(keys));

  const ex = (d.modules || []).find((m) => m.key === 'morning_exercise');
  assert('无早操 → 标记为 off', ex && ex.off === true, JSON.stringify(ex));
  assert('无早操 → 文案用服务端 skipReason', ex && ex.rateText === '本班无早操', ex && ex.rateText);
  assert('无早操 → 不参与出勤率平均（hasRate=false）', ex && ex.hasRate === false, JSON.stringify(ex));

  const mc = (d.modules || []).find((m) => m.key === 'morning_class');
  assert('早八 → ratePercent 直接采用（96.7 而不是 0.97）', mc && mc.rate === 97, mc && mc.rate);

  const sum = d.summary || {};
  assert('平均出勤率优先用服务端加权值 96.1', sum.avg === 96, `${sum.avg}`);
  assert('平均出勤率标记为服务端口径', sum.avgFromServer === true, `${sum.avgFromServer}`);
  assert('累计缺勤取服务端 absentTotal=3', sum.absent === 3, `${sum.absent}`);
  assert('累计未归取服务端 notReturnedTotal=2', sum.notReturned === 2, `${sum.notReturned}`);
  assert('未标 estimated（服务端给了汇总）', sum.estimated === false, `${sum.estimated}`);
  // 「区间内在统计里的天数」：服务端没给 recordedDays 时按 days 里有记录的天数兜底
  assert('有记录天数兜底 = 2（days 里两天有模块数据）', sum.days === 2, `${sum.days}`);

  // 「每日明细」整块已按用户口径下线：组件不再构造每天单元格，也不再渲染该区块。
  // 这里守住「没有被悄悄加回来」——否则又会与页面顶部的周期筛选重复、并与概览卡的
  // 「该区间暂无考勤记录」自相矛盾。
  assert('组件 data 不再有 days（每日明细已下线）', d.days === undefined, JSON.stringify(d.days));
  const wxml = fs.readFileSync(path.join(MINI, 'components/attendance/attendance.wxml'), 'utf8');
  assert('模板不再渲染「每日明细」区块', !/<text>\s*每日明细\s*<\/text>/.test(wxml), 'wxml still renders 每日明细 section');
  const jsSrc = fs.readFileSync(path.join(MINI, 'components/attendance/attendance.js'), 'utf8');
  assert('组件 JS 不再有按日单元格逻辑', !/function cellOf|function normalizeDays/.test(jsSrc), 'cellOf/normalizeDays still present');

  console.log('\n结论：组件已能正确消费服务端真实形状（此前按数组读 → 全部显示「未录」）');
})();
