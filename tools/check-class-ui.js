// 静态契约检查：我的班级 / 班级状态 UI 重构 + 导出（用户 2026-11-20）
//
// 需求（五条一起做的这一轮）：
//   1. 班超「最近记录」与「班级考勤」重做卡片：检查人 / 复核人 / 实际数据 / 照片；
//      班级考勤列出**所选区间全部**检查记录（服务端 dayRecords）。
//   2. 班超联赛紧凑排版。
//   3. 班级里的**校园跑**跟班超一样支持日期回看（/overview /ranking 的 ?date=）。
//   4. 班级状态导出本周/本月考勤表（CSV，含校园跑）→ 小程序下载/打开/降级分享能力。
//   5. 班级状态每行显示**具体扣分考察项**（卫生-宿舍 / 晚自习…）+ 班超分统计区间。
//
// 全部是静态断言（读源码 + WXML/WXSS 交叉核对），不连库；真连库的行为验证分别在：
//   verify-class-date.js / verify-class-export.js / verify-class-status.js / verify-union-review.js
//
// 为什么仍需静态断言：这些接线（参数名、字段名、模板引用）写错时**不会报错**，
// 只会表现为「日期选了没反应」「导出的表少了列」这类静默失效。
//
// 用法：node tools/check-class-ui.js
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const MINI = path.join(ROOT, 'miniprogram');

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  if (!cond) failed += 1;
};
const read = (p) => fs.readFileSync(p, 'utf8');

const classJs = read(path.join(MINI, 'packageAdmin', 'class', 'class.js'));
const classWxml = read(path.join(MINI, 'packageAdmin', 'class', 'class.wxml'));
const classWxss = read(path.join(MINI, 'packageAdmin', 'class', 'class.wxss'));
const csJs = read(path.join(MINI, 'packageAdmin', 'class-status', 'class-status.js'));
// 去注释后的代码：断言「源码里不再出现某标识符」时必须只看代码（注释里会提到被删掉的旧名字）
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '');
const csCode = stripComments(csJs);
const csWxml = read(path.join(MINI, 'packageAdmin', 'class-status', 'class-status.wxml'));
const csWxss = read(path.join(MINI, 'packageAdmin', 'class-status', 'class-status.wxss'));
const reqJs = read(path.join(MINI, 'utils', 'request.js'));
const routeClass = read(path.join(SERVER, 'src', 'routes', 'class.js'));
const routeUnion = read(path.join(SERVER, 'src', 'routes', 'union.js'));
const bandChaoSrc = read(path.join(SERVER, 'src', 'services', 'band-chao.js'));
const boardSrc = read(path.join(SERVER, 'src', 'services', 'class-status-board.js'));
const adminClsSrc = read(path.join(SERVER, 'src', 'routes', 'admin', 'class-profile.js'));

// 取某个函数的函数体（到下一个「顶格 }」为止）：函数内断言必须只看这个函数自己的代码
function fnBody(src, header) {
  const at = src.indexOf(header);
  if (at < 0) return '';
  const end = src.indexOf('\n  }', at + header.length);
  return end < 0 ? src.slice(at) : src.slice(at, end + 4);
}
const countOf = (src, re) => (src.match(re) || []).length;

console.log('=== 一、服务端：校园跑日期回看（需求 3）===');
ok(
  'loadClassStats 接受日期参数（第二参 dateKey）',
  /async function loadClassStats\(className, dateKey\)/.test(routeClass)
);
ok(
  '日期参数白名单校验、非法/缺省回落今天（不抛 400）',
  /dates\.isValidDateKey\(String\(dateKey \|\| ''\)\)/.test(routeClass) &&
    /today = dates\.isValidDateKey\(String\(dateKey \|\| ''\)\) \? String\(dateKey\) : dates\.todayKey\(\)/.test(routeClass)
);
ok(
  'queryDate 是请求侧**唯一**取参入口',
  /function queryDate\(req\)/.test(routeClass) && /dates\.isValidDateKey\(raw\) \? raw : dates\.todayKey\(\)/.test(routeClass)
);
ok(
  'overview / students / ranking 三个出口全部透传 date',
  countOf(routeClass, /loadClassStats\(scope\.className, queryDate\(req\)\)/g) === 3,
  countOf(routeClass, /loadClassStats\(scope\.className, queryDate\(req\)\)/g)
);
ok(
  '三个出口都用 stats.today 回显所选日期（前端标题要用）',
  countOf(routeClass, /date: stats\.today/g) >= 3,
  countOf(routeClass, /date: stats\.today/g)
);
ok(
  '周起点随之取所选日所在 ISO 周（weekRange(today) 用同一个 today）',
  /const \{ startKey: weekStart \} = dates\.weekRange\(today\)/.test(routeClass)
);
ok(
  '校园跑数据窗口是「周一..所选日」（未来记录不会串进来）',
  /date: \{ \$gte: weekStart, \$lte: today \}/.test(routeClass)
);

console.log('\n=== 二、服务端：班超 dayRecords（需求 1）===');
ok(
  '下发 dayRecords / dayRecordsTotal / dayRecordsRange',
  /dayRecords:/.test(routeUnion) && /dayRecordsTotal,/.test(routeUnion) && /dayRecordsRange: \{/.test(routeUnion)
);
ok(
  'dayRecords 按所选区间（scopeRange.from ~ to）查询，与汇总区间同源',
  /date: \{ \$gte: scopeRange\.from, \$lte: scopeRange\.to \}/.test(routeUnion)
);
ok(
  '状态/作废口径与 recent 完全一致（COUNTED_STATUS + voided）',
  /status: \{ \$in: CheckRecord\.COUNTED_STATUS \},\s*\n\s*date: \{ \$gte: scopeRange\.from/.test(routeUnion) &&
    /voided: \{ \$ne: true \}/.test(routeUnion)
);
ok(
  '卡片映射只写一份（presentRow），recent 与 dayRecords 共用',
  /const presentRow = \(r\) => \(\{/.test(routeUnion) &&
    /recent: recent\.map\(presentRow\)/.test(routeUnion) &&
    /dayRecords: dayRows\.map\(presentRow\)/.test(routeUnion)
);
ok(
  'presentRow 复用 presentRecord（withDetails:false + photoLimit:3）+ roster',
  /presentRecord\(r, \{ withDetails: false, viewer, photoLimit: 3 \}\)/.test(routeUnion) &&
    /roster: rosterFor\(r, moduleMap\.get\(r\.moduleKey\), req, viewer\)/.test(routeUnion)
);
ok(
  '单次上限 50、总数单独 countDocuments（前端显示「共 N 条」）',
  /limit\(50\)\.lean\(\)/.test(routeUnion) && /CheckRecord\.countDocuments\(dayMatch\)/.test(routeUnion)
);
ok(
  '汇总 / 排名 / recent / dayRecords / 计数一次 Promise.all（不串行拖慢首页班超块）',
  /const \[summary, ranking, recent, dayRows, dayRecordsTotal\] = await Promise\.all\(\[/.test(routeUnion)
);

console.log('\n=== 三、服务端：扣分来源 targets（需求 5）===');
ok(
  'band-chao 定义受检类型中文名唯一一份 TARGET_TYPE_TEXT',
  /const TARGET_TYPE_TEXT = \{/.test(bandChaoSrc) && /TARGET_TYPE_TEXT,/.test(bandChaoSrc)
);
{
  // 全仓服务端只允许一份定义（三处各写一份必然出现「宿舍 / 寝室」漂移）
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(path.join(SERVER, 'src'));
  const defs = files.filter((p) => /const TARGET_TYPE_TEXT = \{/.test(fs.readFileSync(p, 'utf8')));
  ok('受检类型映射在服务端只有一处定义（禁止各路由自拼）', defs.length === 1, defs.map((p) => path.relative(ROOT, p)));
}
ok(
  'targets 名称 = 「模块名-受检类型」',
  /name: `\$\{moduleName\}-\$\{TARGET_TYPE_TEXT\[type\] \|\| TARGET_TYPE_TEXT\.unknown\}`/.test(bandChaoSrc)
);
ok(
  'targets 最多 3 项、其余折叠为「<模块>-其他」',
  /list\.slice\(0, 3\)/.test(bandChaoSrc) && /name: `\$\{moduleName\}-其他`/.test(bandChaoSrc)
);
ok(
  'Σ targets.avgDeduct 严格等于模块日均扣分（尾差调平）',
  /const diff = round2\(moduleAvgDeduct - sum\)/.test(bandChaoSrc) &&
    /top\[0\]\.avgDeduct = round2\(top\[0\]\.avgDeduct \+ diff\)/.test(bandChaoSrc)
);
ok(
  'scoreOfAggregate 的 moduleDeduct 增量下发 targets（老字段一个不删）',
  /moduleDeduct\[k\] = \{/.test(bandChaoSrc) &&
    /targets: buildTargetItems\(/.test(bandChaoSrc) &&
    /deduct: round2\(hit\.deduct\)/.test(bandChaoSrc)
);
ok(
  '看板专用「模块×受检类型」轻量聚合另起一次（不撑大主聚合）',
  /async function aggregateTargetsLite\(/.test(bandChaoSrc) &&
    /bandChao\.aggregateTargetsLite\(/.test(boardSrc) &&
    /Promise\.all\(\[\s*\n\s*bandChao\.aggregateScoresLite/.test(boardSrc)
);
ok(
  '两个轻量聚合共用 liteMatch（口径不许分叉）',
  countOf(bandChaoSrc, /const match = liteMatch\(\{ from, to, classNames \}\);/g) === 2,
  countOf(bandChaoSrc, /const match = liteMatch\(\{ from, to, classNames \}\);/g)
);
ok(
  '看板 deductDetail 透传 targets，且缺省是 []（不是 undefined）',
  /targets: modDeduct\[k\]\.targets \|\| \[\]/.test(boardSrc)
);
ok(
  '看板行新增 run.avgSteps（学生数 0 不产生 NaN）',
  /avgSteps: run\.studentCount \? Math\.round\(\(run\.stepsToday \|\| 0\) \/ run\.studentCount\) : 0/.test(boardSrc)
);

console.log('\n=== 四、服务端：导出工作簿（总标 + 每班明细，需求 4）===');
ok('新增 GET /status-export', /router\.get\(\s*\n\s*'\/status-export'/.test(adminClsSrc));
ok(
  '看板与导出共用 boardQuery（取参唯一，杜绝「页面 12 个班、导出 15 个班」）',
  /function boardQuery\(req\)/.test(adminClsSrc) && countOf(adminClsSrc, /boardQuery\(req\)/g) >= 2,
  countOf(adminClsSrc, /boardQuery\(req\)/g)
);
{
  // 2026-11-20 用户定稿：导出改成「总标 + 每班明细」工作簿，实现搬进独立 service。
  const exportSvcSrc = read(path.join(SERVER, 'src', 'services', 'class-status-export.js'));
  const exportStart = adminClsSrc.indexOf('// ===== 班级状态导出');
  const exportEnd = adminClsSrc.indexOf('module.exports = router');
  const seg = adminClsSrc.slice(exportStart, exportEnd);
  ok('导出路由变薄：只取参 + 调 service（不自己查库/写格式）',
    /require\('\.\.\/\.\.\/services\/class-status-export'\)/.test(seg) && !/\.aggregate\(|CheckRecord\.|require\('xlsx'\)/.test(seg));
  ok('导出复用 applyBoardFilter（筛选与页面同源）', /board\.applyBoardFilter\(full, q\.filter\)/.test(seg));
  const SUMMARY_COLUMNS = [
    '序号', '院校', '系部', '专业', '年级', '学生数', '住宿数', '班委数', '学生会成员数',
    '卫生累计扣分', '晚自习累计扣分', '查宿累计扣分', '早操累计扣分', '早八累计扣分',
    '校园跑班级日目标平均达标率', '校园跑班级周目标平均达标率',
    '校园跑班级日目标达标次数', '校园跑班级周目标达标次数',
    '校园跑班级日目标达标最低值', '校园跑班级周目标达标最低值',
    '校园跑累计步数', '校园跑人均累计步数',
  ];
  ok('总标 = 用户指定的 22 列（逐字 + 顺序）',
    SUMMARY_COLUMNS.every((t) => exportSvcSrc.includes(`'${t}'`)) &&
      SUMMARY_COLUMNS.reduce((acc, t) => {
        const i = exportSvcSrc.indexOf(`'${t}'`);
        return i > acc ? i : -1;
      }, 0) > 0);
  ok('每班明细 sheet 命名「<className>详细数据」+ 31 字符/非法字符清洗',
    /详细数据/.test(exportSvcSrc) && /sheetNameOf/.test(exportSvcSrc));
  ok('明细含考勤检查人/复核人/名单假别 + 校园跑每人日/周达标率',
    /检查人/.test(exportSvcSrc) && /复核人/.test(exportSvcSrc) && /reason/.test(exportSvcSrc) &&
      /日达标率/.test(exportSvcSrc) && /周达标率/.test(exportSvcSrc));
  ok('工作簿顺序：总标 → 每班详细数据 → 字段说明',
    (() => {
      const w = exportSvcSrc.match(/function buildWorkbook[\s\S]*?\n\}/) || [''];
      const s = w[0];
      const a = s.indexOf('book_append_sheet(wb, buildSummarySheet');
      const b = s.indexOf('book_append_sheet(wb, buildClassSheet');
      const c = s.indexOf('book_append_sheet(wb, buildDictSheet');
      return a >= 0 && b > a && c > b;
    })());
  ok('XLSX：xlsx 库写 buffer + 正确 MIME + .xlsx 附件名',
    /require\('xlsx'\)/.test(exportSvcSrc) && /bookType: 'xlsx'/.test(exportSvcSrc) &&
      /spreadsheetml\.sheet/.test(exportSvcSrc) && /class-status-\$\{safeDay\}\.xlsx/.test(exportSvcSrc));
  ok('CSV：只出总标 22 列 + BOM + attachment（旧脚本兼容）',
    /sendCsv/.test(exportSvcSrc) && /\\uFEFF/.test(exportSvcSrc) && /attachment/.test(exportSvcSrc) && /class-status-\$\{safeDay\}\.csv/.test(exportSvcSrc));
  ok('JSON 预览：22 列定义 + 截断行 + total + sheets（生成文件前先看表格/工作簿结构）',
    /jsonPreview/.test(exportSvcSrc) && /sheets/.test(exportSvcSrc) && /total/.test(exportSvcSrc) && /slice\(0,/.test(exportSvcSrc));
  ok('上限常量：总标 500 / 班级 sheet 500 / 区间明细 5000',
    /SUMMARY_ROW_LIMIT = 500/.test(exportSvcSrc) && /CLASS_SHEET_LIMIT = 500/.test(exportSvcSrc) && /ATTENDANCE_ROW_LIMIT = 5000/.test(exportSvcSrc));
  ok('导出不重算看板数字（服务里没有 classSummary/scoreOfAggregate）',
    !/classSummary\(/.test(exportSvcSrc) && !/scoreOfAggregate\(/.test(exportSvcSrc));
}

console.log('\n=== 五、前端：校园跑日期回看（需求 3）===');
ok(
  'runDate / runToday / runIsPast 等状态齐全',
  /runDate: fmt\.todayKey\(\)/.test(classJs) && /runToday: fmt\.todayKey\(\)/.test(classJs) && /runIsPast: false/.test(classJs)
);
ok('派生文案单点预算（runDateView，模板不拼三元）', /function runDateView\(date, today\)/.test(classJs));
ok(
  '日期选择器：picker 上限恒为今天（end=runToday，不能用 runDate）',
  /end="\{\{runToday\}\}"/.test(classWxml) && /bindchange="onRunDate"/.test(classWxml)
);
{
  const body = fnBody(classJs, 'onRunDate(e) {');
  ok('选日期后同时刷新概况与班内榜单（不是只刷概况）', /this\.loadOverview\(\)/.test(body) && /this\.loadRanking\(\)/.test(body), body.slice(0, 200));
}
ok('「今天」快捷按钮只在回看态出现', /bind:tap="onRunToday"/.test(classWxml) && /wx:if="\{\{runIsPast\}\}"/.test(classWxml));
ok(
  '/overview 请求带所选日期（date）',
  /auth\.get\('\/api\/class\/overview', \{ className, date \}\)/.test(classJs) ||
    /\/api\/class\/overview', \{[\s\S]{0,120}?date/.test(classJs)
);
ok('/ranking 请求带所选日期', /\/api\/class\/ranking', \{[^}]*date: this\.data\.runDate/.test(classJs));
{
  // 学生名单必须保持「今天」语义：/students 的参数块里绝不能出现 date
  const calls = classJs.match(/\/api\/class\/students', \{([\s\S]*?)\n\s*\}\);/g) || [];
  ok('学生名单请求**不传** date（名单是今天语义，回看只改校园跑）', calls.length >= 1 && calls.every((c) => !/\bdate:/.test(c)), calls.length);
}
{
  const body = fnBody(classJs, 'switchClass(e) {');
  ok('切换班级时把回看日期重置为今天（不串班回看）', /runDateView\(runToday, runToday\)/.test(body), body.slice(0, 160));
}
ok(
  '回看态禁用督促名单（抽屉名单是今天语义，避免张冠李戴）',
  /this\.data\.runIsPast\) return/.test(classJs) && /runPastTip/.test(classJs)
);

console.log('\n=== 六、前端：班超紧凑排版 + 记录卡片 + dayRecords（需求 1、2）===');
ok(
  'dayRecords 四个展示字段接线（groups/total/truncated/rangeText）',
  /banchaoDayGroups: \[\]/.test(classJs) &&
    /banchaoDayTotal: 0/.test(classJs) &&
    /banchaoDayTruncated: false/.test(classJs) &&
    /banchaoDayRangeText: ''/.test(classJs)
);
ok('loadBanchao 读取 data.dayRecords / dayRecordsTotal / dayRecordsRange', /Array\.isArray\(data\.dayRecords\)/.test(classJs) && /data\.dayRecordsRange/.test(classJs));
ok(
  '截断文案只在真的被截断时出现（length < total）',
  /banchaoDayTruncated: dayRecords\.length < dayTotal/.test(classJs) && /仅显示前/.test(classJs)
);
ok(
  '切换周期先清空旧 dayRecords（不残留上一个区间）',
  countOf(classJs, /this\.clearBanchaoDayRecords\(\);/g) >= 3,
  countOf(classJs, /this\.clearBanchaoDayRecords\(\);/g)
);
ok(
  '记录卡片是**同一个模板**（最近记录 + 当日分组复用，不写两套视觉）',
  /<template name="bc-record">/.test(classWxml) && countOf(classWxml, /<template is="bc-record"/g) >= 2,
  countOf(classWxml, /<template is="bc-record"/g)
);
ok(
  '卡片显示检查人 / 复核人 / 实际数据（模板字段，不是直接渲染原始字段）',
  /inspectorText/.test(classWxml) && /reviewerText/.test(classWxml) && /metric/.test(classWxml) &&
    /function decorateBanchaoRecord\(r\)/.test(classJs)
);
ok(
  '照片：catch:tap 阻止冒泡 + wx.previewImage({urls, current})',
  /catch:tap="previewPhoto"/.test(classWxml) &&
    /wx\.previewImage\(\{/.test(classJs) &&
    /urls/.test(fnBody(classJs, 'previewPhoto(e) {'))
);
ok(
  '「班级考勤」区显示总数、区间、截断与空态（文案单点，模板不拼三元）',
  /共 \{\{banchaoDayTotal\}\} 条/.test(classWxml) &&
    /banchaoDayRangeText/.test(classWxml) &&
    /banchaoDayTruncateText/.test(classWxml) &&
    /所选区间暂无检查记录/.test(classWxml)
);
ok('紧凑排版：明细两列网格 + 趋势迷你条（不再竖排 5 行）', /cls-bc-module-head/.test(classWxml) && /cls-bc-trend-bars/.test(classWxml) && /cls-bc-trend-col/.test(classWxml));

// ---- 第三轮（用户 2026-11-20）：总评压缩 + KPI 双列卡 + 明细/记录双列 ----
ok(
  'KPI 双列卡片：buildBanchaoKpis 唯一实现，loadOverview / loadBanchao 后各补一次（谁后到都补齐）',
  /buildBanchaoKpis\(\) \{/.test(classJs) &&
    countOf(classJs, /this\.buildBanchaoKpis\(\);/g) >= 2 &&
    /banchaoKpis: \[\]/.test(classJs) &&
    /cls-bc-kpis/.test(classWxml) &&
    /cls-bc-kpi/.test(classWxml)
);
ok(
  '检查明细 = 两列独立卡片（每格主数据得分 + 次数据模块/指标），不再套一张大卡',
  /cls-bc-modules/.test(classWxml) && /cls-bc-module-desc/.test(classWxml) && !/tt-card cls-bc-modules/.test(classWxml)
);
ok(
  '最近记录 = 同一 bc-record 模板 + 唯一双列容器（详细检查记录仍全宽列表）',
  /cls-bc-records-grid/.test(classWxml) &&
    /banchaoRecentGrid/.test(classWxml) &&
    countOf(classWxml, /cls-bc-records-grid/g) === 1 &&
    countOf(classWxml, /<template is="bc-record"/g) >= 2
);
ok(
  '修掉「本今日还没有检查记录」：hero 备注整句由 JS 预计算，模板不再拼 `本{{rangeWord}}`',
  /banchaoHeroNote/.test(classWxml) && !/本\{\{rangeWord\}\}/.test(classWxml) && /banchaoHeroNote:/.test(classJs)
);
{
  // WXML 用到的页内类名必须在页内 WXSS 定义（本仓库踩过「写了类名没样式 → 控件裸排」）
  const tokens = new Set();
  for (const m of classWxml.matchAll(/class="([^"]*)"/g)) {
    for (const t of m[1].split(/\s+/)) {
      if (t && !t.includes('{') && /^(cls-|bc-)/.test(t)) tokens.add(t);
    }
  }
  const missing = [...tokens].filter((t) => !new RegExp(`\\.${t.replace(/[-/]/g, '\\$&')}[\\s,{.:]`).test(classWxss));
  ok(`我的班级 WXML 用到的页内类名都在 class.wxss 定义（${tokens.size} 个）`, missing.length === 0, missing);
}

console.log('\n=== 七、前端：班级状态行 UI + 导出（需求 4、5）===');
ok('导出窗口常量只有本周/本月', /const EXPORT_RANGES = \[/.test(csJs) && /label: '本周'/.test(csJs) && /label: '本月'/.test(csJs));
ok(
  '导出入口 onExport + exporting 防重复点击（两处入口判定）',
  /bind:tap="onExport"/.test(csWxml) && countOf(csJs, /if \(this\.data\.exporting\) return;/g) >= 2,
  countOf(csJs, /if \(this\.data\.exporting\) return;/g)
);
ok(
  '窗口由用户选（showActionSheet，当前窗口排第一并标注「（当前）」）',
  /wx\.showActionSheet\(\{/.test(csJs) && /（当前）/.test(csJs)
);
{
  const body = fnBody(csJs, 'buildExportQuery(rangeKey) {');
  ok(
    '导出参数：换 attRange、去掉 copy、today 兜底（与看板同参）',
    /delete q\.copy/.test(body) && /delete q\.att/.test(body) && /q\.attRange = rangeKey === 'month' \? 'month' : 'week'/.test(body) && /q\.today/.test(body),
    body.slice(0, 200)
  );
}
ok(
  '下载走 utils/request.downloadAndOpen → /api/admin/class/status-export（**xlsx**，不是 csv）',
  /auth\.downloadAndOpen\('\/api\/admin\/class\/status-export'/.test(csJs) &&
    /fileType: 'xlsx'/.test(csJs) &&
    /format: 'xlsx'/.test(csJs) &&
    // 微信 wx.openDocument 不支持 csv：页面里不允许再出现 fileType: 'csv' 这条死路
    !/fileType: 'csv'/.test(csJs)
);
// 第三轮（用户真机「CSV 本机无法打开、转发也失败」）：导出前先预览表格样式
{
  const body = fnBody(csJs, 'openExportPreview(rangeKey) {');
  ok(
    '导出前先拉「预览数据」：format=json + preview=1 + limit 小样本（预览=最终文件同一实现）',
    /format: 'json'/.test(body) && /preview: '1'/.test(body) && /limit: 5/.test(body),
    body.slice(0, 240)
  );
  ok(
    '预览列宽按 Excel 字符宽折算 + 行转成 {key,cells}（WXML 零运算、可直接 wx:for）',
    /previewCols/.test(body) && /wch/.test(body) && /cells:/.test(body)
  );
}
ok(
  '预览弹层：标题/区间标签/副标题/表格/总行数提示/生成 Excel 按钮齐全',
  /cs-prev-mask/.test(csWxml) &&
    /cs-prev-title/.test(csWxml) &&
    /previewCols/.test(csWxml) &&
    /previewRows/.test(csWxml) &&
    /previewMoreText/.test(csWxml) &&
    /bind:tap="confirmExport"|catch:tap="confirmExport"/.test(csWxml) &&
    /catch:tap="closeExportPreview"/.test(csWxml)
);
ok(
  '预览失败/导出失败都有文案，且导出失败给「复制表格文本」兜底（这是用户真正能发进群的东西）',
  /title: '预览失败'/.test(csJs) &&
    /showExportFailure\(e\)/.test(csJs) &&
    /confirmText: canCopy \? '复制文本' : '知道了'/.test(csJs)
);
ok(
  '失败文案分档：登录过期 / 无权限 / 网络 / 保存 / 打开',
  /err\.code === 401/.test(csJs) && /err\.code === 403/.test(csJs) && /err\.stage === 'save'/.test(csJs) && /err\.stage === 'open'/.test(csJs) && /err\.network/.test(csJs)
);
ok(
  '扣分 chips：从 targets 展开、每模块≤2、整行≤3、其余 +N',
  /const DEDUCT_CHIP_MAX = 3/.test(csJs) &&
    /const DEDUCT_CHIP_PER_MODULE = 2/.test(csJs) &&
    /Array\.isArray\(mod\.targets\)/.test(csJs) &&
    /\.slice\(0, DEDUCT_CHIP_PER_MODULE\)/.test(csJs)
);
{
  const body = fnBody(csJs, 'decorate(r, view = {}) {');
  ok(
    'chips 全局截断 + +N 计数在 decorate 里算好（模板零运算）',
    /allChips\.slice\(0, DEDUCT_CHIP_MAX\)/.test(body) && /deductMore: allChips\.length > DEDUCT_CHIP_MAX/.test(body),
    body.slice(0, 200)
  );
  // 用户 2026-11-20 第三轮：不显示班超分列时**不产出任何扣分信息**
  ok(
    '班超分列关闭时 chips / 无扣分文案一律不产出（用户明确要求）',
    /const showAtt = !!cols\.attendance/.test(body) &&
      /const allChips = showAtt \? this\.buildDeductChips\(att, deductMode\) : \[\]/.test(body) &&
      /if \(showAtt && !deductChips\.length\)/.test(body)
  );
}
ok(
  'chips 在 WXML 渲染（循环 deductChips.chip.text + deductMore「+N」）',
  /wx:for="\{\{item\.deductChips\}\}"/.test(csWxml) && /chip\.text/.test(csWxml) && /item\.deductMore/.test(csWxml)
);
ok('班超分统计区间可见（periodText 来自服务端 from/to，并写明新公式：四模块累计扣分×10% − 缺勤人次×0.02）', /periodText: d\.from/.test(csJs) && /periodText/.test(csWxml) && /累计扣分×10%/.test(csJs) && /缺勤人次×0.02/.test(csJs));
ok('班超分大字走 num-font（数字排版约定）', /cs-score num-font/.test(csWxml));

// ---- 第三轮（用户 2026-11-20）：复制 autodetect + 班超分范围/口径 + 单多数据排版 ----
ok(
  '删掉独立「复制内容」picker（用户：上面的复制已经自动识别显示内容）',
  !/COPY_SCOPES/.test(csCode) && !/copyScopes/.test(csCode) && !/onCopyScopePick/.test(csCode) && !/cs-pick-copy/.test(csWxml)
);
ok(
  '复制口径由显示列自动派生（autoCopy 唯一实现：只日/只周/只班超分/混合）',
  /function autoCopy\(columns\)/.test(csJs) &&
    /copy: 'att', att: '1'/.test(csJs) &&
    /copy: 'daily', att: '0'/.test(csJs) &&
    /copy: 'weekly', att: '0'/.test(csJs) &&
    /copy: 'all', att: att \? '1' : '0'/.test(csJs)
);
ok(
  '请求同时带 copy 与 att（页面显示班超分与否决定复制正文）',
  /copy: scope\.copy, att: scope\.att/.test(csJs)
);
ok(
  '切换显示列后重查，保证复制正文跟着列走（不再本地只改显隐）',
  /onToggleColumn\(e\) \{/.test(csJs) && /this\.load\(\)/.test(fnBody(csJs, 'onToggleColumn(e) {'))
);
ok(
  '「有没有检查记录」读服务端顶层 hasAnyCheck（筛选后不消失，旧后端回退现算）',
  /typeof d\.hasAnyCheck === 'boolean'/.test(csCode) && /d\.hasAnyCheck/.test(csCode) && /rows\.some/.test(csCode) && /hasAnyCheck\)/.test(csCode)
);
ok(
  '班超分范围行只在显示班超分列时出现（本日/本周/本月）',
  /班超分范围/.test(csWxml) && /wx:if="\{\{columns\.attendance && !errorText\}\}"/.test(csWxml) && /onAttRange/.test(csWxml)
);
ok(
  '日均/合计口径：选项 + 切换只重排已有数据（不重发请求）+ 本日窗口隐藏口径',
  /const DEDUCT_MODE_OPTIONS = \[/.test(csJs) &&
    /label: '日均'/.test(csJs) &&
    /label: '合计'/.test(csJs) &&
    /onDeductMode\(e\) \{/.test(csJs) &&
    !/this\.load\(\)/.test(fnBody(csJs, 'onDeductMode(e) {')) &&
    /showDeductMode: \(d\.attRange \|\| this\.data\.attRange\) !== 'day'/.test(csJs) &&
    /wx:if="\{\{showDeductMode\}\}"/.test(csWxml)
);
ok(
  '合计口径用服务端 totalDeduct / deductTotal（前端只挑口径，不乘天数）',
  /buildDeductChips\(att, mode\)/.test(csJs) &&
    /const totalMode = mode === 'total'/.test(csJs) &&
    /pick\(mod\.deduct, mod\.totalDeduct\)/.test(csJs) &&
    /pick\(t && t\.avgDeduct, t && t\.totalDeduct\)/.test(csJs) &&
    /合计扣 \$\{scoreText\(total\)\}/.test(csJs)
);
ok(
  '达标单/多数据不同排版（is-single / is-multi，模板不拼三元）',
  /runbarsClass: runSingle \? 'is-single' : 'is-multi'/.test(csJs) &&
    /item\.runBars/.test(csWxml) &&
    /\.cs-runbars\.is-single/.test(csWxss) &&
    /\.cs-runbars\.is-multi/.test(csWxss)
);
ok(
  '右列（班超分大字 + 口径副行）只在显示班超分列时渲染',
  /class="cs-side" wx:if="\{\{columns\.attendance\}\}"/.test(csWxml) &&
    /扣分为 0 或没有检查记录时为空串/.test(csJs)
);
ok(
  '旧控件已彻底移除（attRangeText / cs-bar-days / 独立 cs-period 条）',
  !/attRangeText/.test(csCode) && !/attRangeText/.test(csWxml) && !/cs-bar-days/.test(csWxml) && !/cs-period"/.test(csWxml)
);

{
  const tokens = new Set();
  for (const m of csWxml.matchAll(/class="([^"]*)"/g)) {
    for (const t of m[1].split(/\s+/)) {
      if (t && !t.includes('{') && /^cs-/.test(t)) tokens.add(t);
    }
  }
  // 只作 BEM 修饰、没有独立样式的类（**改动前就存在**，不是本轮新增）：
  // 写在这里是为了让「新增类名必须有定义」这条断言仍然有效，而不是把整个检查关掉。
  const MODIFIER_ONLY = new Set(['cs-bar-chips', 'cs-bar-level', 'cs-bar-opts']);
  const missing = [...tokens].filter(
    (t) => !MODIFIER_ONLY.has(t) && !new RegExp(`\\.${t.replace(/[-/]/g, '\\$&')}[\\s,{.:]`).test(csWxss)
  );
  ok(`班级状态 WXML 用到的 cs-* 类都在 class-status.wxss 定义（${tokens.size} 个）`, missing.length === 0, missing);
}
ok('两页 WXSS 不硬编码旧品牌蓝 #0052d9', !/#0052d9/i.test(classWxss) && !/#0052d9/i.test(csWxss));

console.log('\n=== 八、前端：下载能力（utils/request.js）===');
ok('downloadAndOpen 已导出（页面用 auth.downloadAndOpen 调用）', /downloadAndOpen,/.test(reqJs));
ok('下载域名只来自 env.BASE_URL（RED LINE：页面不许自拼域名）', /env\.BASE_URL/.test(reqJs) && /function buildDownloadUrl\(path, query\)/.test(reqJs));
ok('带 Authorization，token 读法与 request() 同源 getToken()', /Authorization: getToken\(\) \? `Bearer \$\{getToken\(\)\}`/.test(reqJs));
ok(
  '落盘到 wx.env.USER_DATA_PATH（临时文件会被清理），失败回退临时路径',
  /wx\.env\.USER_DATA_PATH/.test(reqJs) && /getFileSystemManager\(\)\.saveFile/.test(reqJs)
);
ok(
  'openDocument 失败降级 shareFileMessage，降级成功 = 整体成功（via: share）',
  /wx\.shareFileMessage/.test(reqJs) && /via: 'share'/.test(reqJs)
);
ok(
  '错误带 stage 三档（download / save / open）+ statusCode/network，页面才能分文案',
  /stage = 'download'/.test(reqJs) && /stage = 'save'/.test(reqJs) && /stage = 'open'/.test(reqJs) && /statusCode: /.test(reqJs)
);
ok('文件名 sanitize（去路径分隔符/非法字符，空名时间戳兜底）', /function sanitizeFileName\(name, ext\)/.test(reqJs));
ok(
  '现有 request() 行为未被改动（函数与导出都还在）',
  /async function request\(/.test(reqJs) && /\n  request,/.test(reqJs) && /module\.exports = \{/.test(reqJs)
);
ok('下载文件名兜底前缀不与其它临时文件混淆', /DOWNLOAD_FALLBACK_PREFIX/.test(reqJs));

console.log(failed ? `\n契约自检：失败 ${failed} 项` : '\n契约自检全部通过');
process.exit(failed ? 1 : 0);
