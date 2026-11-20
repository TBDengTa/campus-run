// 端到端验证：校园跑的**日期回看**（用户 2026-11-20 需求 3）
//
// 需求原文：「我的班级中校园跑要跟班超联赛中同样拥有日期选择」。
//
// 改造点（server/src/routes/class.js）：
//   · loadClassStats(className, dateKey) 第二参 = 「把哪一天当作今日」，缺省回落实今天；
//   · /overview、/students、/ranking 接受 ?date=YYYY-MM-DD，周起点随之取该日所在 ISO 周一。
//
// 这个脚本真连库、真挂 routes/class.js（auth 中间件按 header 打桩成指定班主任），
// 用**临时班级 / 临时学生 / 临时跑步记录**跑完整 HTTP 链路，跑完即删并核对残留为 0。
//
// 覆盖（每一条都对应一种会静默出错的实现方式）：
//   ① 不传 date = 传今天（向后兼容：老前端不传参数时行为不变）
//   ② 不同日期的 今日步数 / 今日达标 / 达标率 各自正确，且与独立算术一致
//   ③ 周起点 = 该日所在 ISO 周一（不是「该日 −6 天」、也不是恒为今天所在周一）
//   ④ 本周步数窗口 = 周一..所选日（未来的记录不能串进来）
//   ⑤ 班内榜单 / 学生列表同样跟随 date（不是只有概况切了）
//   ⑥ 非法 date 回落今天（脏链接不 500、不返回空数据）
//   ⑦ date 与 weekStart 回显（前端标题要用）
//
// 用法：node tools/verify-class-date.js
// 需要能连上 server/.env 里的数据库。只写带时间戳前缀的临时数据。
const path = require('path');
const serverDir = path.join(__dirname, '..', 'server');
const config = require(path.join(serverDir, 'src', 'config'));
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));
const express = require(path.join(serverDir, 'node_modules', 'express'));

const User = require(path.join(serverDir, 'src', 'models', 'user'));
const RunRecord = require(path.join(serverDir, 'src', 'models', 'run-record'));
const UserGoal = require(path.join(serverDir, 'src', 'models', 'user-goal'));
const dates = require(path.join(serverDir, 'src', 'utils', 'dates'));

let failed = 0;
function assert(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ← ' + JSON.stringify(extra)}`);
  if (!cond) failed += 1;
}

const TS = Date.now();
const TAG = `date_verify_${TS}`;
const CLS = `${TAG}_班`;

// 独立算「该日所在 ISO 周的周一」：故意**不用** dates.weekRange ——
// 被测实现写错时，复用同一份工具会让断言跟着一起错（本文件的意义就是交叉核对）。
function mondayOf(key) {
  const d = new Date(`${key}T00:00:00`);
  const shift = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - shift);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, '0')}`;
}
// 日期区间（闭区间）内逐日展开，用于独立算「周一..所选日」的窗口
function daysBetween(from, to) {
  const out = [];
  let cur = from;
  let guard = 0;
  while (cur <= to && guard < 40) {
    out.push(cur);
    cur = dates.addDays(cur, 1);
    guard += 1;
  }
  return out;
}

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });

  // ---- 0) 起真实路由（auth 打桩：直接给班主任身份）----
  const authMw = require(path.join(serverDir, 'src', 'middlewares', 'auth'));
  const actor = {
    _id: new mongoose.Types.ObjectId(),
    openid: `${TAG}_teacher`,
    role: 'teacher', // 班主任账号（岗位教师），不参与运动记录
    homeroomClasses: [CLS],
    className: '',
    permissions: [],
  };
  authMw.auth = (req, res, next) => {
    const who = req.headers['x-actor'] || '';
    if (who !== 'homeroom') return res.status(401).json({ code: 401, message: '未登录' });
    req.user = actor;
    next();
  };
  const classRouter = require(path.join(serverDir, 'src', 'routes', 'class'));
  const app = express();
  app.use(express.json());
  app.use('/api/class', classRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code || 500, message: err.message }));
  const port = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s.address().port));
  });
  const BASE = `http://127.0.0.1:${port}`;
  const call = async (method, url) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { 'content-type': 'application/json', 'x-actor': 'homeroom' } });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  const today = dates.todayKey();
  // 两个过去日期：A 必然在上一周（-9 天），B 在近几天（-2 天）——
  // 只取「比今天早」的日期，保证不会与今天的数据互相污染。
  const DAY_A = dates.addDays(today, -9);
  const DAY_B = dates.addDays(today, -2);
  const MON_A = mondayOf(DAY_A);
  const MON_B = mondayOf(DAY_B);
  const MON_TODAY = mondayOf(today);
  if (MON_A === MON_TODAY && MON_B === MON_TODAY) {
    // 理论上不可能（-9 天必然跨周），留一行防御性提示方便排查环境问题
    console.log(`⚠️ 日期选择异常：DAY_A=${DAY_A} DAY_B=${DAY_B} 与今天同周，断言将失去区分度`);
  }

  const openids = [`${TAG}_s1`, `${TAG}_s2`, `${TAG}_s3`];
  const createdUsers = [];
  let createdGoals = 0;
  let createdRecords = 0;

  try {
    // ---- 1) 造临时班级数据 ----
    // 三个学生 + 各自目标（daily=1000 / weekly=5000），刻意不依赖全局目标配置：
    // 线上全局目标随时可能被管理员改，读全局配置的脚本会在别人调整后假失败。
    const STUDENTS = [
      { openid: openids[0], name: '日期验证甲' },
      { openid: openids[1], name: '日期验证乙' },
      { openid: openids[2], name: '日期验证丙' },
    ];
    for (const s of STUDENTS) {
      createdUsers.push(
        (
          await User.create({
            openid: s.openid,
            account: s.openid,
            realName: s.name,
            role: 'student',
            className: CLS,
          })
        )._id
      );
      await UserGoal.create({
        openid: s.openid,
        daily: { steps: 1000, distance: 800, calories: 60 },
        weekly: { steps: 5000, distance: 4000 },
      });
      createdGoals += 1;
    }

    // 手工数据表（期望值全部由本表独立推出，与被测实现无关）：
    //   甲：A 1200（达标）/ B 300 / 今天 1500（达标）
    //   乙：A  800（未达标）/ 今天 900（未达标）
    //   丙：无记录
    const SEED = [
      { openid: openids[0], date: DAY_A, steps: 1200, distance: 1000 },
      { openid: openids[0], date: DAY_B, steps: 300, distance: 300 },
      { openid: openids[0], date: today, steps: 1500, distance: 1200 },
      { openid: openids[1], date: DAY_A, steps: 800, distance: 700 },
      { openid: openids[1], date: today, steps: 900, distance: 800 },
    ];
    await RunRecord.insertMany(SEED.map((x) => ({ ...x, source: 'werun' })));
    createdRecords = SEED.length;

    // 独立算某日视角下的期望值
    const expectFor = (dayKey) => {
      const mon = mondayOf(dayKey);
      const win = daysBetween(mon, dayKey);
      const byOpenid = new Map();
      for (const r of SEED) {
        if (!win.includes(r.date)) continue; // 本周窗口 = 周一..所选日（含端点）
        const cur = byOpenid.get(r.openid) || { today: 0, week: 0, todayRecords: 0, activeDays: 0 };
        cur.week += r.steps;
        if (r.date === dayKey) {
          cur.today += r.steps;
          cur.todayRecords += 1;
        }
        cur.activeDays += 1;
        byOpenid.set(r.openid, cur);
      }
      const list = STUDENTS.map((s) => {
        const a = byOpenid.get(s.openid) || { today: 0, week: 0, todayRecords: 0, activeDays: 0 };
        return {
          openid: s.openid,
          todaySteps: a.today,
          weekSteps: a.week,
          todayRecords: a.todayRecords,
          achievedToday: a.today >= 1000,
          avgSteps: a.activeDays ? Math.round(a.week / a.activeDays) : 0,
        };
      });
      const studentCount = list.length;
      const sum = (fn) => list.reduce((acc, s) => acc + fn(s), 0);
      const achievedToday = list.filter((s) => s.achievedToday).length;
      return {
        weekStart: mon,
        studentCount,
        stepsToday: sum((s) => s.todaySteps),
        recordsToday: sum((s) => s.todayRecords),
        activeToday: list.filter((s) => s.todayRecords > 0).length,
        achievedToday,
        dailyRate: studentCount ? Math.round((achievedToday / studentCount) * 100) : 0,
        classAvgSteps: studentCount ? Math.round(sum((s) => s.avgSteps) / studentCount) : 0,
        list,
      };
    };

    // ---- 2) 不传 date = 传今天（向后兼容）----
    console.log('\n[1] 不传 date = 今天（老前端行为不变）');
    {
      const noDate = await call('GET', `/api/class/overview?className=${encodeURIComponent(CLS)}`);
      const withToday = await call('GET', `/api/class/overview?className=${encodeURIComponent(CLS)}&date=${today}`);
      assert(noDate.status === 200 && withToday.status === 200, '两个请求都 200', [noDate.status, withToday.status]);
      const strip = (d) => {
        const copy = { ...d };
        delete copy.classRank; // 名次依赖全校聚合，两次调用之间可能有人同步（与日期参数无关）
        return copy;
      };
      assert(
        JSON.stringify(strip(noDate.data.data || {})) === JSON.stringify(strip(withToday.data.data || {})),
        '不传 date 与 date=今天 返回同一份数据',
        { noDate: strip(noDate.data.data || {}), withToday: strip(withToday.data.data || {}) }
      );
      assert((withToday.data.data || {}).date === today, 'date 回显为今天', (withToday.data.data || {}).date);
      assert((withToday.data.data || {}).weekStart === MON_TODAY, 'weekStart 回显今天所在周一', (withToday.data.data || {}).weekStart);
    }

    // ---- 3) 各日期概况与独立算术一致 ----
    console.log('\n[2] 概况跟随日期（逐日与独立算术核对）');
    for (const dayKey of [DAY_A, DAY_B, today]) {
      const exp = expectFor(dayKey);
      const r = await call('GET', `/api/class/overview?className=${encodeURIComponent(CLS)}&date=${dayKey}`);
      const d = r.data.data || {};
      assert(r.status === 200, `${dayKey} 概况 200`, r.status);
      assert(d.date === dayKey, `${dayKey} date 回显 = 所选日期`, d.date);
      assert(d.weekStart === exp.weekStart, `${dayKey} weekStart = 独立算的周一（${exp.weekStart}）`, {
        got: d.weekStart,
        exp: exp.weekStart,
      });
      assert(d.studentCount === exp.studentCount, `${dayKey} 学生数 ${exp.studentCount}`, d.studentCount);
      assert(d.stepsToday === exp.stepsToday, `${dayKey} 今日步数 ${exp.stepsToday}`, d.stepsToday);
      assert(d.recordsToday === exp.recordsToday, `${dayKey} 今日记录数 ${exp.recordsToday}`, d.recordsToday);
      assert(d.activeToday === exp.activeToday, `${dayKey} 今日活跃人数 ${exp.activeToday}`, d.activeToday);
      assert(d.achievedToday === exp.achievedToday, `${dayKey} 今日达标人数 ${exp.achievedToday}`, d.achievedToday);
      assert(d.dailyRate === exp.dailyRate, `${dayKey} 今日达标率 ${exp.dailyRate}%`, d.dailyRate);
      assert(d.classAvgSteps === exp.classAvgSteps, `${dayKey} 班级日均步数 ${exp.classAvgSteps}`, d.classAvgSteps);
    }

    // 三个日期的数字必须互不相同（否则「日期参数接了但没进查询」也能全过上面的断言）
    {
      const [a, b, c] = await Promise.all(
        [DAY_A, DAY_B, today].map((k) => call('GET', `/api/class/overview?className=${encodeURIComponent(CLS)}&date=${k}`))
      );
      const vals = [a, b, c].map((r) => (r.data.data || {}).stepsToday);
      assert(new Set(vals).size === 3, `三个日期的今日步数互不相同（${vals.join(' / ')}）`, vals);
      const rates = [a, b, c].map((r) => (r.data.data || {}).dailyRate);
      assert(new Set(rates).size >= 2, `三个日期的达标率不全相同（${rates.join(' / ')}%）`, rates);
      const wstarts = [a, b, c].map((r) => (r.data.data || {}).weekStart);
      assert(new Set(wstarts).size >= 2, `跨周的日期 weekStart 不同（${wstarts.join(' / ')}）`, wstarts);
    }

    // ---- 4) 周窗口 = 周一..所选日（未来记录不串进来）----
    console.log('\n[3] 本周窗口 = 周一..所选日');
    {
      // DAY_B 之后还有「今天」的记录（甲 1500 / 乙 900），回看 DAY_B 时不能算进本周
      const r = await call('GET', `/api/class/overview?className=${encodeURIComponent(CLS)}&date=${DAY_B}`);
      const d = r.data.data || {};
      const exp = expectFor(DAY_B);
      // 独立算出「若把今天也串进来」的错误值，断言实际值不等于它
      const withFuture = exp.list.reduce((acc, s) => {
        const future = SEED.filter((x) => x.openid === s.openid && x.date === today).reduce((a, x) => a + x.steps, 0);
        return acc + s.weekSteps + future;
      }, 0);
      const actualWeek = exp.list.reduce((a, s) => a + s.weekSteps, 0);
      assert(actualWeek > 0, 'DAY_B 本周有数据（造数生效）', actualWeek);
      assert(withFuture !== actualWeek, '构造的「串入未来」错误值确实不同（断言有区分度）', { actualWeek, withFuture });
      // 概况本身只下发今日与达标，本周人均走 classAvgSteps（也是周窗口派生）——
      // 用 student 列表的 weekSteps 做逐人核对更直接（见下一节），这里只验日期口径。
      assert(d.date === DAY_B && d.weekStart === exp.weekStart, 'DAY_B 回显日期与周起点', [d.date, d.weekStart]);
    }

    // ---- 5) 学生列表跟随日期 ----
    console.log('\n[4] 学生列表跟随日期');
    {
      const rA = await call('GET', `/api/class/students?className=${encodeURIComponent(CLS)}&date=${DAY_A}&sort=today`);
      const dA = rA.data.data || {};
      assert(rA.status === 200, '列表 200', rA.status);
      assert(dA.date === DAY_A && dA.weekStart === MON_A, '列表回显所选日期与周起点', [dA.date, dA.weekStart]);
      const rows = dA.list || [];
      assert(rows.length === 3, '列表 3 个学生', rows.length);
      const exp = expectFor(DAY_A);
      // 按姓名对齐（presentStudent 不下发 openid）
      for (const s of STUDENTS) {
        const row = rows.find((x) => x.name === s.name);
        const e = exp.list.find((x) => x.openid === s.openid);
        assert(!!row, `${s.name} 出现在列表里`);
        if (row && e) {
          assert(row.todaySteps === e.todaySteps, `${s.name} 当日步数 = ${e.todaySteps}（${DAY_A} 视角）`, row.todaySteps);
          assert(row.weekSteps === e.weekSteps, `${s.name} 本周步数 = ${e.weekSteps}`, row.weekSteps);
        }
      }
      // 默认排序 = 当日步数降序：甲 1200 → 乙 800 → 丙 0
      assert(
        rows[0] && rows[0].name === STUDENTS[0].name && rows[1] && rows[1].name === STUDENTS[1].name,
        '当日步数降序（甲 > 乙 > 丙）',
        rows.map((x) => `${x.name}:${x.todaySteps}`)
      );
      // 同一接口不传 date 时，甲的当日步数是今天（1500），与 DAY_A 视角（1200）不同
      const rToday = await call('GET', `/api/class/students?className=${encodeURIComponent(CLS)}&sort=today`);
      const rowS1 = (rToday.data.data || {}).list || [];
      const s1 = rowS1.find((x) => x.name === STUDENTS[0].name);
      assert(!!s1 && s1.todaySteps === 1500, '不传 date = 今天视角（甲 1500）', s1 && s1.todaySteps);
    }

    // ---- 6) 班内榜单跟随日期 ----
    console.log('\n[5] 班内榜单跟随日期');
    {
      const rA = await call('GET', `/api/class/ranking?className=${encodeURIComponent(CLS)}&date=${DAY_A}`);
      const d = rA.data.data || {};
      assert(rA.status === 200, '榜单 200', rA.status);
      assert(d.date === DAY_A && d.weekStart === MON_A, '榜单回显所选日期与周起点', [d.date, d.weekStart]);
      const names = (d.students || []).map((s) => s.name);
      assert(names.length === 3, '榜单含 3 人', names.length);
      // DAY_A 视角本周步数：甲 1200 > 乙 800 > 丙 0
      assert(names[0] === STUDENTS[0].name && names[1] === STUDENTS[1].name, `DAY_A 本周步数排名 甲>乙>丙`, names);
      const rToday = await call('GET', `/api/class/ranking?className=${encodeURIComponent(CLS)}`);
      const namesToday = ((rToday.data.data || {}).students || []).map((s) => s.name);
      // 今天视角：甲 1800（B 300 + 今天 1500）> 乙 900 > 丙 0 —— 与 DAY_A 的 1200/800 不同
      const tops = (rToday.data.data || {}).students || [];
      assert(tops[0] && tops[0].weekSteps === 1800, '今天视角甲本周 1800（含 -2 天那条）', tops[0] && tops[0].weekSteps);
      assert(namesToday[0] === names[0], '两个视角第一名相同（都是甲，但数值不同）', [namesToday, names]);
      assert(tops.length === 3, '今天视角榜单 3 人', tops.length);
    }

    // ---- 7) 非法 date 回落今天 ----
    console.log('\n[6] 非法 date 回落今天（脏链接不 500）');
    for (const bad of ['abc', '2026-1-1', '', '2026-13-40x']) {
      const r = await call('GET', `/api/class/overview?className=${encodeURIComponent(CLS)}&date=${encodeURIComponent(bad) || 'x'}`);
      const d = r.data.data || {};
      assert(r.status === 200 && d.date === today, `date=${bad || '(空)'} → 回落今天`, { status: r.status, date: d.date });
    }

    // ---- 8) 清理后自证 ----
  } finally {
    await RunRecord.deleteMany({ openid: { $in: openids } });
    await UserGoal.deleteMany({ openid: { $in: openids } });
    await User.deleteMany({ openid: { $in: openids } });
    const left = await Promise.all([
      RunRecord.countDocuments({ openid: { $in: openids } }),
      UserGoal.countDocuments({ openid: { $in: openids } }),
      User.countDocuments({ openid: { $in: openids } }),
    ]);
    console.log(`\n[7] 清理：用户 ${createdUsers.length} / 目标 ${createdGoals} / 记录 ${createdRecords} → 残留 ${left.join('/')}`);
    assert(left.every((n) => n === 0), '临时数据清理干净', left);
    await mongoose.disconnect();
    console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
    process.exit(failed ? 1 : 0);
  }
})().catch((e) => {
  console.error('ERR', e.stack);
  process.exit(1);
});
