// 端到端验证：班级状态的「导出考勤表」（用户 2026-11-20 需求 4）
//
// 需求原文：「班级状态中增加导出考勤表格本周、本月的各班考勤详细信息(包括校园跑)」。
//
// 实现：`GET /api/admin/class/status-export`（server/src/routes/admin/class-profile.js）
//   · 取参与筛选**完全复用**看板（boardQuery + classStatusBoard + applyBoardFilter），
//     导出的每个数字都来自看板的同一份行数据，不在导出里重算分数/出勤率/达标率；
//   · 输出 CSV + BOM（Excel 双击不乱码），行上限 500，需 class.view（随 /api/admin/class 前缀）。
//
// 这个脚本真连库、真挂 routes/admin/index.js（auth 中间件按 header 打桩成指定账号），
// 造一个临时班 + 已知扣分记录，然后把 CSV 逐格与「独立手算的期望值」和「看板 API 行数据」对账。
//
// 覆盖：
//   ① HTTP 形状：200 / text/csv / BOM / Content-Disposition 附件文件名
//   ② 表头列齐全（含校园跑列），列数固定
//   ③ 数据行数 = 当前筛选下的看板行数（导出就是看到的）
//   ④ 临时班逐格核对：班超分 / 综合出勤率 / 模块「应到/实到/率」/ 扣分明细（含 卫生-宿舍）
//   ⑤ 校园跑列与看板行同源（今日达标人数 / 达标率 / 当日人均步数）
//   ⑥ 筛选条件真的进导出（keyword 只剩 1 行；非法筛选不筛成空）
//   ⑦ 窗口跟随 attRange（本月 → 日期区间从 1 号起；本周 → 周一起）
//   ⑧ 权限：无 class.view → 403；未登录 → 401
//   ⑨ 只读：导出前后库内记录数不变
//
// 用法：node tools/verify-class-export.js
// 需要能连上 server/.env 里的数据库。只写带时间戳前缀的临时数据，跑完即删并核对残留为 0。
const path = require('path');
const serverDir = path.join(__dirname, '..', 'server');
const config = require(path.join(serverDir, 'src', 'config'));
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));
const express = require(path.join(serverDir, 'node_modules', 'express'));

const User = require(path.join(serverDir, 'src', 'models', 'user'));
const ClassProfile = require(path.join(serverDir, 'src', 'models', 'class-profile'));
const CheckRecord = require(path.join(serverDir, 'src', 'models', 'check-record'));
const RunRecord = require(path.join(serverDir, 'src', 'models', 'run-record'));
const dates = require(path.join(serverDir, 'src', 'utils', 'dates'));
const boardSvc = require(path.join(serverDir, 'src', 'services', 'class-status-board'));
const scoreScale = require(path.join(serverDir, 'src', 'services', 'score-scale'));
const XLSX = require(path.join(serverDir, 'node_modules', 'xlsx'));

let failed = 0;
function assert(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ← ' + JSON.stringify(extra)}`);
  if (!cond) failed += 1;
}

const TS = Date.now();
const TAG = `exp_verify_${TS}`;
const CLS = `${TAG}_班`;

// 独立算「该日所在 ISO 周的周一」与「月初」：不复用被测的 dates.weekRange / monthRange
function mondayOf(key) {
  const d = new Date(`${key}T00:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, '0')}`;
}

// 简易 CSV 解析：本接口每个单元格都被双引号包裹，内部双引号转义为 ""
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
function parseCsv(text) {
  const body = text.replace(/^\uFEFF/, '');
  const lines = body.split('\r\n').filter((l) => l.length > 0);
  const rows = lines.map(parseCsvLine);
  return { header: rows[0] || [], rows: rows.slice(1) };
}

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });

  // ---- 0) 起真实管理端路由（auth 打桩：按 x-actor 指定账号）----
  const authMw = require(path.join(serverDir, 'src', 'middlewares', 'auth'));
  const actors = new Map();
  authMw.auth = (req, res, next) => {
    const who = req.headers['x-actor'] || '';
    if (who === 'anon') return res.status(401).json({ code: 401, message: '未登录' });
    const doc = actors.get(who);
    if (!doc) return res.status(401).json({ code: 401, message: 'unknown actor' });
    req.user = doc;
    next();
  };
  const adminRouter = require(path.join(serverDir, 'src', 'routes', 'admin', 'index'));
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code || 500, message: err.message }));
  const port = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s.address().port));
  });
  const BASE = `http://127.0.0.1:${port}`;
  const call = async (who, url, method = 'GET') => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { 'x-actor': who } });
    // ⚠️ 不能用 res.text() 判 BOM：fetch 的 text() 走 UTF-8 解码，会**吃掉**开头的 BOM，
    //   于是「服务端有没有写 BOM」这件事永远验不出来（实测假红过一次）。
    //   必须拿原始字节判 EF BB BF。
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString('utf8');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, bytes, json };
  };

  const today = dates.todayKey();
  const MON = mondayOf(today);
  const monthFirst = `${today.slice(0, 7)}-01`;
  const openids = [`${TAG}_u1`, `${TAG}_u2`];
  const createdUserIds = [];

  // 手工期望值（与任何被测实现无关）：
  //   晚自习：应到 30 / 实到 27（率 90%），扣 0.20
  //   卫生（宿舍类）：扣 0.40
  //   → 班超分 = 10 − (0.20 + 0.40) = 9.40；扣分明细应含「卫生-宿舍 -0.40」「晚自习-班级 -0.20」
  const SEED = {
    study: { should: 30, actual: 27, deduct: 0.2 },
    hygieneDeduct: 0.4,
  };
  const EXP_SCORE = scoreScale.scoreText(10 - SEED.study.deduct - SEED.hygieneDeduct);

  try {
    // ---- 1) 造临时班 / 学生 / 记录 ----
    // 打桩账号：一个持 class.view（导出应放行），一个无任何权限（应 403）。
    // 必须是**真实 User 文档**：requirePermission 会调 user.getEffectivePermissions()。
    const adminUser = await User.create({
      openid: `${TAG}_admin`,
      account: `${TAG}_admin`,
      realName: '导出-管理员',
      role: 'teacher',
      permissions: ['class.view'],
    });
    const nopermUser = await User.create({
      openid: `${TAG}_noperm`,
      account: `${TAG}_noperm`,
      realName: '导出-无权限',
      role: 'teacher',
      permissions: [],
    });
    createdUserIds.push(adminUser._id, nopermUser._id);
    actors.set('admin', adminUser);
    actors.set('noperm', nopermUser);

    await ClassProfile.create({ className: CLS, status: 'normal' });
    for (const openid of openids) {
      const u = await User.create({ openid, account: openid, realName: `${TAG}学生`, role: 'student', className: CLS });
      createdUserIds.push(u._id);
    }
    // 当日步数：u1 跑 3000 步（u2 无记录）→ 当日人均步数 = round(3000 / 2) = 1500
    await RunRecord.create({ openid: openids[0], source: 'werun', date: today, steps: 3000, distance: 2000 });
    await CheckRecord.create({
      moduleKey: 'study_evening',
      date: today,
      period: '',
      targetType: 'classroom',
      targetId: CLS,
      targetName: CLS,
      className: CLS,
      details: { shouldCount: SEED.study.should, actualCount: SEED.study.actual, absentCount: SEED.study.should - SEED.study.actual },
      metrics: { ratios: { rate: SEED.study.actual / SEED.study.should } },
      score: 10 - SEED.study.deduct,
      deduct: SEED.study.deduct,
      status: 'submitted',
      source: 'union',
      inspectorName: '导出-检查人',
    });
    await CheckRecord.create({
      moduleKey: 'hygiene',
      date: today,
      period: '',
      targetType: 'dorm_room',
      targetId: `${TAG}_room`,
      targetName: '洋河-男宿101',
      className: CLS,
      details: { grade: ['良'], score: 8, photos: [] },
      metrics: { values: { score: 8 } },
      score: 10 - SEED.hygieneDeduct,
      deduct: SEED.hygieneDeduct,
      status: 'submitted',
      source: 'union',
      inspectorName: '导出-检查人',
    });
    if (typeof boardSvc.clearCache === 'function') boardSvc.clearCache();
    // 先把看板刷新到今天（force 会重建缓存，之后导出与它对账的是同一份快照）
    const full = await boardSvc.classStatusBoard({ today, attRange: 'week', force: true });
    const boardRow = (full.rows || []).find((x) => x.className === CLS);
    assert(!!boardRow, '临时班出现在看板里', (full.rows || []).length);

    // ---- 2) HTTP 形状 ----
    console.log('\n[1] HTTP 形状与表头');
    const res = await call('admin', `/api/admin/class/status-export?attRange=week&today=${today}&format=csv`);
    assert(res.status === 200, '导出 → 200', res.status);
    assert(/text\/csv/.test(res.headers.get('content-type') || ''), 'Content-Type = text/csv', res.headers.get('content-type'));
    const dispo = res.headers.get('content-disposition') || '';
    assert(/attachment/.test(dispo), 'Content-Disposition = attachment', dispo);
    assert(new RegExp(`filename="class-status-\\d{4}-\\d{2}-\\d{2}\\.csv"`).test(dispo), '文件名是 ASCII 安全的 class-status-日期.csv', dispo);
    assert(res.bytes[0] === 0xef && res.bytes[1] === 0xbb && res.bytes[2] === 0xbf, 'CSV 以 UTF-8 BOM（EF BB BF）开头（Excel 不乱码）', [...res.bytes.slice(0, 3)].map((b) => b.toString(16)));
    const { header, rows } = parseCsv(res.text);
    const wantHeader = [
      '日期区间',
      '班级',
      '院校',
      '系部',
      '年级',
      '学生数',
      '班超分',
      '综合出勤率',
      '早操',
      '早八',
      '晚自习',
      '查宿',
      '扣分明细',
      '今日达标人数',
      '今日达标率',
      '本周达标人数',
      '本周达标率',
      '当日人均步数',
    ];
    assert(JSON.stringify(header) === JSON.stringify(wantHeader), '表头 18 列齐全且顺序固定', header);
    // 每一行列数必须等于表头（拆分错位会让整张表错列）
    const badWidth = rows.filter((r) => r.length !== wantHeader.length);
    assert(badWidth.length === 0, `每行 ${wantHeader.length} 列（不错列）`, badWidth.slice(0, 2).map((r) => r.length));

    // ---- 3) 行数 = 看板行数（导出就是看到的）----
    console.log('\n[2] 行数与筛选');
    assert(rows.length === (full.rows || []).length, '导出数据行数 = 看板行数', {
      csv: rows.length,
      board: (full.rows || []).length,
    });
    // 同一份取参下，带筛选的导出必须只剩筛选结果（证明参数进了服务端，不是前端假筛）
    const fRes = await call('admin', `/api/admin/class/status-export?attRange=week&today=${today}&format=csv&keyword=${encodeURIComponent(CLS)}`);
    const f = parseCsv(fRes.text);
    assert(fRes.status === 200 && f.rows.length === 1, 'keyword 筛出恰好 1 行（临时班）', f.rows.length);
    assert(f.rows[0] && f.rows[0][1] === CLS, '筛出的就是临时班', f.rows[0] && f.rows[0][1]);
    // 非法筛选值不得把全表筛成空（与看板同一条回落口径）
    const badRes = await call('admin', `/api/admin/class/status-export?attRange=week&today=${today}&format=csv&quick=notARealFilter`);
    const bad = parseCsv(badRes.text);
    assert(badRes.status === 200 && bad.rows.length === rows.length, '非法筛选被忽略而非筛空', bad.rows.length);
    // 工号 / 注入口径：attRange 非法回落本周
    const badRange = await call('admin', `/api/admin/class/status-export?attRange=quarter&today=${today}&format=csv`);
    const br = parseCsv(badRange.text);
    assert(
      badRange.status === 200 && br.rows[0] && br.rows[0][0] === `${MON} ~ ${dates.addDays(MON, 6)}`,
      'attRange 非法回落本周（区间 = 周一 ~ 周日）',
      br.rows[0] && br.rows[0][0]
    );

    // ---- 4) 临时班逐格对账（独立手算）----
    console.log('\n[3] 临时班逐格对账（独立手算）');
    const row = rows.find((r) => r[1] === CLS);
    assert(!!row, '临时班在导出里', rows.length);
    if (row) {
      const col = (name) => row[wantHeader.indexOf(name)];
      assert(col('日期区间') === `${MON} ~ ${dates.addDays(MON, 6)}`, '本周日期区间 = 周一 ~ 周日（完整周）', col('日期区间'));
      assert(col('年级') === '', '年级列（临时班没有年级）为空', col('年级'));
      assert(col('学生数') === '2', '学生数 = 2', col('学生数'));
      assert(col('班超分') === EXP_SCORE, `班超分 = 10 − 0.60 = ${EXP_SCORE}`, col('班超分'));
      assert(col('综合出勤率') === '90%', '综合出勤率 = 90%（应到加权，早八不计率）', col('综合出勤率'));
      // 模块列「应到N/实到M/率P%」
      assert(col('晚自习') === '应到30/实到27/率90%', '晚自习单元格 = 应到30/实到27/率90%', col('晚自习'));
      // 没有记录的模块留空（不是「应到0/实到0」—— 否则「没录」会被当成「应到 0」）
      assert(col('早操') === '' && col('查宿') === '', '无数据模块留空（不硬造 0 人）', [col('早操'), col('查宿')]);
      // 扣分明细：必须写到「具体考察项」（用户 2026-11-20 点名的 卫生-宿舍 / 晚自习）
      const detail = col('扣分明细');
      assert(/卫生-宿舍 -0\.40/.test(detail), '扣分明细含「卫生-宿舍 -0.40」', detail);
      assert(/晚自习/.test(detail) && /-0\.20/.test(detail), '扣分明细含晚自习 -0.20', detail);
      // 校园跑列与看板行同源
      assert(col('今日达标人数') === String(boardRow.run.achievedToday), '今日达标人数 = 看板行', {
        csv: col('今日达标人数'),
        board: boardRow.run.achievedToday,
      });
      assert(col('本周达标人数') === String(boardRow.run.achievedWeek), '本周达标人数 = 看板行', col('本周达标人数'));
      assert(col('当日人均步数') === '1500', '当日人均步数 = 3000 ÷ 2 = 1500', col('当日人均步数'));
      assert(col('今日达标率') === (boardRow.run.dailyRate === null ? '' : `${boardRow.run.dailyRate}%`), '今日达标率与看板一致', col('今日达标率'));
    }
    // 扣分明细的子项求和口径：Σ targets === 模块日均扣分（导出文案直接来自 targets，算不平就会被看出来）
    assert(
      !!boardRow &&
        (boardRow.attendance.deductDetail || []).every((d) => {
          const sum = (d.targets || []).reduce((a, t) => a + t.avgDeduct, 0);
          return Math.abs(sum - d.deduct) < 0.011;
        }),
      '扣分明细的 targets 之和 = 模块日均扣分（对账口径钉死）',
      boardRow && boardRow.attendance.deductDetail
    );

    // ---- 5) 窗口跟随 attRange（本月）----
    console.log('\n[4] 本月窗口');
    const mRes = await call('admin', `/api/admin/class/status-export?attRange=month&today=${today}&format=csv`);
    const mm = parseCsv(mRes.text);
    assert(mRes.status === 200 && mm.rows.length === rows.length, '本月导出同样 200 且行数一致', mm.rows.length);
    const mRow = mm.rows.find((r) => r[1] === CLS);
    assert(!!mRow && mRow[0].startsWith(`${monthFirst} ~`), '本月日期区间从 1 号起', mRow && mRow[0]);

    // ---- 5b) XLSX / JSON 预览（用户 2026-11-20 真机「CSV 本机无法打开、转发也失败」）----
    // 微信 wx.openDocument 不支持 csv，导出必须给真 Excel；同时 json 预览让用户在生成文件前
    // 看到表格长什么样。两种格式必须与 CSV **同一份数据**（同一 builder），不能各自重算。
    console.log('\n[5] XLSX / JSON 预览');
    {
      const x = await call('admin', `/api/admin/class/status-export?attRange=week&today=${today}&format=xlsx`);
      assert(x.status === 200, 'xlsx 导出 → 200', x.status);
      assert(/spreadsheetml/.test(x.headers.get('content-type') || ''), 'xlsx Content-Type 是 spreadsheetml', x.headers.get('content-type'));
      assert(/class-status-\d{4}-\d{2}-\d{2}\.xlsx/.test(x.headers.get('content-disposition') || ''), 'xlsx 附件名 .xlsx', x.headers.get('content-disposition'));
      assert(x.bytes[0] === 0x50 && x.bytes[1] === 0x4b, 'xlsx 是合法 zip（PK 头）', [...x.bytes.slice(0, 2)]);
      const wb = XLSX.read(x.bytes, { type: 'buffer' });
      assert(wb.SheetNames.join(',') === '班级状态,字段说明', 'xlsx 两个 sheet：班级状态 + 字段说明', wb.SheetNames);
      const sheetRows = XLSX.utils.sheet_to_json(wb.Sheets['班级状态'], { header: 1 });
      assert(String(sheetRows[0] && sheetRows[0][0]) === '班级状态考勤表', 'xlsx 第 1 行是标题', sheetRows[0]);
      assert(/统计区间：/.test(String((sheetRows[1] || [])[0])) && /导出时间/.test(String((sheetRows[1] || [])[0])), 'xlsx 第 2 行是区间/筛选/班数/导出时间', (sheetRows[1] || [])[0]);
      // 表头与 CSV 逐字一致（同一份 exportColumns）
      const xHead = sheetRows[3] || [];
      assert(JSON.stringify(xHead) === JSON.stringify(wantHeader), 'xlsx 表头与 CSV 逐字一致（18 列）', xHead);
      const xRow = sheetRows.find((r) => r[1] === CLS);
      assert(!!xRow, 'xlsx 含临时班数据行', sheetRows.length);
      if (xRow) {
        assert(xRow[0] === `${MON} ~ ${dates.addDays(MON, 6)}`, 'xlsx 日期区间与 CSV 一致（完整周）', xRow[0]);
        assert(String(xRow[6]) === EXP_SCORE, `xlsx 班超分 = ${EXP_SCORE}（与 CSV/看板同一口径）`, xRow[6]);
        // 模块列顺序：[8]早操 [9]早八 [10]晚自习 [11]查宿
        assert(String(xRow[10]) === '应到30/实到27/率90%', 'xlsx 晚自习列 = 应到30/实到27/率90%', xRow[10]);
        assert(String(xRow[12]).includes('卫生-宿舍 -0.40') && String(xRow[12]).includes('晚自习-教室 -0.20'), 'xlsx 扣分明细含具体考察项（卫生-宿舍 / 晚自习-教室）', xRow[12]);
        assert(String(xRow[17]) === '1500', 'xlsx 当日人均步数与 CSV 一致', xRow[17]);
      }
      const tailText = sheetRows.map((r) => String((r || [])[0] || '')).join('\n');
      assert(/考勤计算规则/.test(tailText), 'xlsx 表尾带考勤计算规则', tailText.slice(-120));
      assert(/班超分 = 10 − 日均扣分/.test(tailText), 'xlsx 表尾带口径说明', tailText.slice(-160));
      assert((wb.Sheets['班级状态']['!merges'] || []).length >= 3, 'xlsx 标题/副标题/说明做了合并单元格', (wb.Sheets['班级状态']['!merges'] || []).length);
      const dict = XLSX.utils.sheet_to_json(wb.Sheets['字段说明'], { header: 1 }).map((r) => String((r || [])[0] || ''));
      assert(dict.includes('班超分') && dict.includes('扣分明细') && dict.includes('筛选'), '字段说明 sheet 覆盖关键列与筛选口径', dict.slice(0, 6));

      // json 预览：列定义 + 前 N 行 + total；与 CSV 同源（筛选到临时班只剩 1 行）
      const j = await call('admin', `/api/admin/class/status-export?attRange=week&today=${today}&format=json&preview=1&limit=2&keyword=${encodeURIComponent(CLS)}`);
      const jd = (j.json && j.json.data) || {};
      assert(j.status === 200 && jd.preview === true, 'json 预览 → 200 + preview=true', j.status);
      assert(Array.isArray(jd.columns) && jd.columns.length === wantHeader.length && jd.columns[0].title === '日期区间', 'json 列定义 18 列且首列日期区间', jd.columns && jd.columns.length);
      assert(Array.isArray(jd.rows) && jd.rows.length === 1 && jd.total === 1, 'json 预览按筛选只回 1 行（total=1）', [jd.rows && jd.rows.length, jd.total]);
      assert(jd.rows && jd.rows[0][1] === CLS && String(jd.rows[0][6]) === EXP_SCORE, 'json 预览行与 CSV/xlsx 同一份数据', jd.rows && jd.rows[0] && jd.rows[0].slice(0, 8));
      assert(jd.columns.every((c) => typeof c.wch === 'number'), 'json 每列带 Excel 字符宽（前端预览按它折算列宽）', jd.columns.slice(0, 2));
      assert(/统计区间：/.test(jd.subtitle || '') && /导出时间/.test(jd.subtitle || ''), 'json 副标题含区间/导出时间（预览弹层标题用）', jd.subtitle);

      // 缺省 format 仍是 CSV（旧客户端/脚本行为不变）
      const def = await call('admin', `/api/admin/class/status-export?attRange=week&today=${today}`);
      assert(/text\/csv/.test(def.headers.get('content-type') || ''), '不传 format 默认仍是 CSV（向后兼容）', def.headers.get('content-type'));
    }

    // ---- 6) 权限与只读 ----
    console.log('\n[6] 权限与只读');
    const noperm = await call('noperm', `/api/admin/class/status-export?attRange=week&today=${today}&format=csv`);
    assert(noperm.status === 403, '无 class.view → 403', noperm.status);
    const anon = await call('anon', `/api/admin/class/status-export?attRange=week&today=${today}&format=csv`);
    assert(anon.status === 401, '未登录 → 401', anon.status);
    const cnt = await CheckRecord.countDocuments({ className: CLS });
    assert(cnt === 2, '导出是只读的（记录数仍为 2）', cnt);
  } finally {
    // ---- 清理：临时数据一条不留 + 刷新看板缓存（不留 60 秒脏行）----
    await CheckRecord.deleteMany({ className: CLS });
    await RunRecord.deleteMany({ openid: { $in: openids } });
    await ClassProfile.deleteMany({ className: CLS });
    await User.deleteMany({ openid: new RegExp(`^${TAG}`) });
    if (createdUserIds.length) await User.deleteMany({ _id: { $in: createdUserIds } });
    if (typeof boardSvc.clearCache === 'function') boardSvc.clearCache();
    await boardSvc.classStatusBoard({ force: true }).catch(() => {});

    const left = {
      users: await User.countDocuments({ openid: new RegExp(`^${TAG}`) }),
      profiles: await ClassProfile.countDocuments({ className: CLS }),
      records: await CheckRecord.countDocuments({ className: CLS }),
      runs: await RunRecord.countDocuments({ openid: { $in: openids } }),
    };
    console.log(`\n[7] 清理：残留 用户 ${left.users} / 班级配置 ${left.profiles} / 检查记录 ${left.records} / 跑步记录 ${left.runs}`);
    assert(Object.values(left).every((n) => n === 0), '临时数据清理干净', left);
    await mongoose.disconnect();
    console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
    process.exit(failed ? 1 : 0);
  }
})().catch((e) => {
  console.error('ERR', e.stack);
  process.exit(1);
});
