// 班超报表（复制文本 / 生成图片 / 导出表格）静态回归（用户 2026-11-23）
//
// 背景：「我的班级 → 班超联赛」要能把本期（日/周/月）问题情况直接发到本班群：
//   ① 复制文本（短文本，微信里不被折叠）；
//   ② 生成图片（本地画布，字段来自服务端 report）；
//   ③ 导出详情表格（服务端 xlsx：总览 + 检查明细）。
//
// 这个检查器盯的是**那些改错了也不报错、只会静默发出错数字**的地方：
//   [1] 三份产物同源：都来自 GET /api/union/class/:className/report，参数与页面同期（range/date/weekNo/month）
//   [2] 权限单点：路由复用 canViewClassFull（与页面 GET /class/:className 同一份判定），不得另写一份
//   [3] 服务端不重算：报表数字全部取自 bandChao.classSummary，不得自算扣分/达标
//   [4] 文本规则：本期无记录写「—」不能写 0 分；扣分项只列真正扣了分的模块
//   [5] 图片：先算布局再画（高度与绘制同一份）、分数字体色不写死、不发照片、canvas 不传 x/y/width/height
//   [6] 表格：xlsx 含总览与明细两个 sheet；文件名带班级；中文名走 filename*
//   [7] 前端接线：三个入口都在、复制走服务端 copyText、导出走 downloadAndOpen(fileType xlsx)
//
// 用法：node tools/check-banchao-report.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let failed = 0;
function ok(cond, label, extra) {
  if (cond) {
    console.log(`ok   ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL ${label}${extra === undefined ? '' : `  -> ${JSON.stringify(extra)}`}`);
  }
}

const svc = read('server', 'src', 'services', 'class-report-export.js');
const route = read('server', 'src', 'routes', 'union.js');
const pageJs = read('miniprogram', 'packageAdmin', 'class', 'class.js');
const pageWxml = read('miniprogram', 'packageAdmin', 'class', 'class.wxml');
const pageWxss = read('miniprogram', 'packageAdmin', 'class', 'class.wxss');
const imgUtil = read('miniprogram', 'utils', 'banchao-report.js');

console.log('=== [1] 三份产物同源 ===');
ok(/module\.exports\s*=\s*\{[\s\S]*buildReport[\s\S]*buildCopyText[\s\S]*buildWorkbook[\s\S]*sendXlsx/.test(svc), '服务已导出 buildReport / buildCopyText / buildWorkbook / sendXlsx');
ok(/class\/:className\/report/.test(route), '路由存在 GET /class/:className/report');
ok(/reportSvc\.buildReport\(/.test(route) && /reportSvc\.sendXlsx\(/.test(route), '文本与表格走同一个 buildReport');
ok(/range:\s*this\.data\.range,[\s\S]{0,40}\.\.\.this\.banchaoParams\(\)/.test(pageJs), '前端 report 参数与页面同期（range + banchaoParams）');
ok(
  /format:\s*'xlsx'/.test(pageJs) && /range:\s*this\.data\.range/.test(pageJs),
  '导出表格同样带 range（不会导成别的周期）'
);

console.log('\n=== [2] 权限单点 ===');
ok(/async function canViewClassFull/.test(route), 'canViewClassFull 单点定义在路由');
ok(
  (route.match(/canViewClassFull\(req, identity, className, info\)/g) || []).length >= 2,
  '页面与报表共用 canViewClassFull（两处调用）',
  (route.match(/canViewClassFull\(/g) || []).length
);
ok(!/canViewClass\s*[:=]/.test(svc), '服务端不另写权限判定函数');
ok(!/isRecordSteward/.test(svc), '服务端不重算管家身份');

console.log('\n=== [3] 服务端不重算分数 ===');
ok(/bandChao\.classSummary\(/.test(svc), '数字来自 bandChao.classSummary');
ok(!/scoreOfAggregate|aggregateScores|classSummary\([^)]*\)\s*\.score\s*\*/.test(svc), '没有第二套分数计算');
ok(/module\.exports[\s\S]*class-status-export/.test(svc) || /require\('\.\/class-status-export'\)/.test(svc), '版式复用 class-status-export（颜色/字体单点）');
const lay = read('server', 'src', 'services', 'class-status-export.js');
ok(/XLSX_COLORS,[\s\S]{0,400}styleNoteBlock/.test(lay), 'class-status-export 已导出版式工具供复用');

console.log('\n=== [4] 文本规则 ===');
ok(/本期还没有检查记录/.test(svc), '无记录时明说「还没有检查记录」');
ok(/score === null \|\| r\.score === undefined/.test(svc), '分数为 null 时走无记录分支（不冒充 0 分）');
ok(/problemModules = moduleRows\.filter\(\(m\) => m\.state === 'entered' && m\.deduct > 0\)/.test(svc), '扣分项只列真正扣分的模块');
ok(/missingModules/.test(svc) && /未录模块/.test(svc), '未录模块单独提醒（不混进扣分项）');
ok(/noteLines/.test(svc) && /班超分 = /.test(svc), '文本/表格附口径说明');
ok(/targetName: base\.targetName \|\| r\.targetName/.test(svc), '明细带受检对象名（宿舍/区域，群里才知道扣在哪）');
ok(/m\.key === 'hygiene' \? '' : m\.metricText/.test(svc), '卫生不展示累加「得分」（与扣分并列会被读成单次得分）');
ok(/optionalMissing/.test(svc) && /!m\.optionalMissing/.test(svc), '可选模块（早八无迟到）不算「未录待补」');
ok(/扣分明细/.test(svc) && /另有 \$\{problemRecords\.length - 5\} 条/.test(svc), '扣分明细限量并注明剩余条数');

console.log('\n=== [5] 图片 ===');
ok(/function planLayout/.test(imgUtil) && /function draw\(ctx, r, plan\)/.test(imgUtil), '先算布局再画（planLayout + draw(plan)）');
ok(/const H = footStart \+ FOOT_H/.test(imgUtil), '画布高度由内容算出（不写死）');
ok(/opts|不传 x\/y\/width\/height/.test(pageJs) && !/canvasToTempFilePath\(\{[\s\S]{0,200}(x:|y:|width:|height:)/.test(pageJs), 'canvasToTempFilePath 不传区域参数');
ok(/canvas\.width = reportUtil\.W \* dpr/.test(pageJs) && /ctx\.scale\(dpr, dpr\)/.test(pageJs), '画布按 DPR 放大且 ctx 同步缩放');
ok(/showShareImageMenu/.test(pageJs) && /saveReportImage/.test(pageJs), '优先分享菜单，低版本回退存相册');
ok(!/photos/.test(imgUtil), '图片工具不引用照片（发群不带检查照片）');
// 颜色字面量必须与令牌同值（canvas 拿不到 CSS 变量；不一致 = 图片与页面两种颜色）
const appWxss = read('miniprogram', 'app.wxss');
const tokenVal = (name) => {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(appWxss);
  return m ? m[1].replace(/\s+/g, '').toLowerCase() : '';
};
const canvasColor = (key) => {
  const m = new RegExp(`${key}:\\s*'([^']+)'`).exec(imgUtil);
  return m ? m[1].replace(/\s+/g, '').toLowerCase() : '';
};
for (const [key, token] of [
  ['brand', 'tt-brand'],
  ['brandSoft', 'tt-brand-soft'],
  ['text', 'tt-text-1'],
  ['text2', 'tt-text-2'],
  ['text3', 'tt-text-3'],
]) {
  ok(canvasColor(key) !== '' && canvasColor(key) === tokenVal(token), `画布 ${key} 与 --${token} 同值`, [canvasColor(key), tokenVal(token)]);
}

console.log('\n=== [6] 表格 ===');
ok(/addWorksheet\('本期总览'/.test(svc) && /addWorksheet\('检查明细'/.test(svc), 'xlsx 含「本期总览」「检查明细」两个 sheet');
ok(/filename\*/.test(svc) && /encodeURIComponent\(fileName\)/.test(svc), '中文文件名走 filename*（老客户端退回 ASCII 名）');
ok(/attachment; filename=/.test(svc), '声明为附件下载');
ok(/MAX_ROWS/.test(svc) && /recordsTruncated/.test(svc) && /仅列出前/.test(svc), '明细超上限时显式说明（不静默截断）');
ok(/autoFilter/.test(svc), '明细表带筛选（发群里方便核对）');

console.log('\n=== [7] 前端接线 ===');
ok(/copyBanchaoReport\(/.test(pageJs) && /shareBanchaoReportImage\(/.test(pageJs) && /exportBanchaoReport\(/.test(pageJs), '三个动作方法都在');
ok(/copyBanchaoReport/.test(pageWxml) && /shareBanchaoReportImage/.test(pageWxml) && /exportBanchaoReport/.test(pageWxml), '三个入口都挂到 WXML');
ok(/r\.copyText/.test(pageJs) && /setClipboardData/.test(pageJs), '复制用服务端 copyText');
ok(/downloadAndOpen\(/.test(pageJs) && /fileType:\s*'xlsx'/.test(pageJs), '导出走 downloadAndOpen(fileType xlsx)');
ok(/id="bcReportCanvas"/.test(pageWxml) && /createSelectorQuery\(\)/.test(pageJs), '画布节点与查询都在页面里');
ok(/\.cls-bc-report-canvas/.test(pageWxss), '画布样式有定义（离屏不占位）');
ok(/reportBusy/.test(pageJs) && /reportExporting/.test(pageJs), '三个动作都有防连点状态');
ok(/tt-card tt-glass cls-bc-aggr/.test(pageWxml), '报表聚合卡走玻璃拟态（2026-11-23 聚合：报表+趋势+榜前三一块）');

console.log('');
if (failed) {
  console.log(`班超报表自检：失败 ${failed} 项`);
  process.exit(1);
}
console.log('班超报表自检全部通过');
