// 端到端验证：班超报表（复制文本 / 导出 xlsx）与页面口径一致（用户 2026-11-23）
//
// 真连库，走真实的 service（不经 HTTP、不写库），逐项核对：
//   [1] report 的核心数字与 bandChao.classSummary **逐字一致**（分数 / 记录数 / 区间）
//   [2] 复制文本包含班名、区间、分数、口径说明；无记录时明确说「还没有检查记录」且不写 0 分
//   [3] 扣分项只列真的扣了分的模块；未录模块单独提醒
//   [4] xlsx 能生成，且含「本期总览」「检查明细」两个 sheet，表头与行数对得上
//   [5] 图片布局：planLayout 的高度覆盖所有分段（不会溢出 = 发出去被切掉半行）
//
// 用法：node tools/verify-banchao-report.js
const path = require('path');
const ROOT = path.join(__dirname, '..');
const serverDir = path.join(ROOT, 'server');
const config = require(path.join(serverDir, 'src', 'config'));
const mongoose = require(path.join(serverDir, 'node_modules', 'mongoose'));

const ClassProfile = require(path.join(serverDir, 'src', 'models', 'class-profile'));
const reportSvc = require(path.join(serverDir, 'src', 'services', 'class-report-export'));
const bandChao = require(path.join(serverDir, 'src', 'services', 'band-chao'));
const checkModules = require(path.join(serverDir, 'src', 'services', 'check-modules'));
const dates = require(path.join(serverDir, 'src', 'utils', 'dates'));
const imgUtil = require(path.join(ROOT, 'miniprogram', 'utils', 'banchao-report.js'));

let failed = 0;
function assert(cond, label, extra) {
  console.log(`${cond ? '✔' : '✘'} ${label}${cond ? '' : `   → ${JSON.stringify(extra)}`}`);
  if (!cond) failed += 1;
}

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName, serverSelectionTimeoutMS: 20000 });
  const modules = await checkModules.listModules({ force: true });
  const today = dates.todayKey();

  // 选一个「有检查记录」的班 + 一个「没记录」的班，两种分支都要覆盖
  const CheckRecord = require(path.join(serverDir, 'src', 'models', 'check-record'));
  const withRecords = await CheckRecord.aggregate([
    { $match: { voided: { $ne: true }, status: { $in: CheckRecord.COUNTED_STATUS } } },
    { $group: { _id: '$className', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 1 },
  ]);
  const target = withRecords[0] && withRecords[0]._id;
  if (!target) throw new Error('库里没有检查记录，无法验证');
  const emptyClass = (await ClassProfile.findOne({ className: { $ne: target }, status: 'normal' }).lean()).className;

  for (const range of ['day', 'week', 'month']) {
    const r = await reportSvc.buildReport({ className: target, range, date: today, modules });
    const s = await bandChao.classSummary({ className: target, date: today, range, modules });
    console.log(`\n=== [${range}] ${target} · ${r.periodLabel}（${r.periodSpan}）===`);
    // [1] 与页面同源
    assert(r.score === s.score, `班超分与 classSummary 一致（${r.scoreText}）`, [r.score, s.score]);
    assert(r.recordCount === s.recordCount, '记录数一致', [r.recordCount, s.recordCount]);
    assert(r.from === String(s.from).slice(0, 10) && r.to === String(s.to).slice(0, 10), '区间一致', [r.from, r.to]);
    assert(r.moduleRows.length === (s.modules || []).length, '模块行数与后端模块数一致', [r.moduleRows.length, (s.modules || []).length]);
    // [2] 文本
    const t = r.copyText;
    assert(t.includes(target), '文本含班级名');
    assert(t.includes(r.periodSpan), '文本含区间');
    if (r.score === null) {
      assert(t.includes('还没有检查记录'), '无记录时明说没有记录');
      assert(!/班超分 0/.test(t), '无记录时不写 0 分');
    } else {
      assert(t.includes(r.scoreText), '文本含班超分', r.scoreText);
    }
    assert(t.includes('口径') || r.noteLines.length > 0, '口径说明存在');
    // [3] 扣分项只列真扣分的
    assert(
      r.problemModules.every((m) => m.deduct > 0 && m.state === 'entered'),
      '扣分项全部真的扣了分',
      r.problemModules.map((m) => [m.name, m.deduct, m.state])
    );
    assert(r.missingModules.every((m) => m.state === 'missing'), '未录模块只含未录的', r.missingModules.map((m) => m.name));
    if (r.problemModules.length) assert(t.includes('扣分项'), '有扣分时文本列出扣分项');
    // 文本长度：超过 500 字在微信里会被折叠（呼应「文本太多被折叠」的历史需求）
    assert(t.length <= 600, `文本足够短（${t.length} 字）`, t.length);
    // [4] xlsx
    const buf = await reportSvc.buildWorkbook(r);
    const ExcelJS = require(path.join(serverDir, 'node_modules', 'exceljs'));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const names = wb.worksheets.map((w) => w.name);
    assert(names.includes('本期总览') && names.includes('检查明细'), 'xlsx 含两个 sheet', names);
    const detail = wb.getWorksheet('检查明细');
    const headerRow = detail.getRow(3).values.filter(Boolean);
    assert(headerRow.includes('模块') && headerRow.includes('扣分'), '明细表头齐全', headerRow);
    // 明细行数 = min(记录数, MAX_ROWS)（第 1-3 行是标题/副标题/表头）
    const expectRows = Math.min(r.recordsTotal, reportSvc.MAX_ROWS);
    let dataRows = 0;
    detail.eachRow((row, n) => {
      if (n > 3 && row.getCell(3).value) dataRows += 1;
    });
    assert(dataRows === expectRows, `明细行数与记录数一致（${dataRows}/${expectRows}）`, [dataRows, expectRows]);
    // [5] 图片布局
    const page = {
      className: r.className,
      rangeWord: r.rangeWord,
      periodSpan: r.periodSpan,
      departmentName: r.departmentName,
      score: r.score,
      scoreText: r.scoreText,
      fullScore: r.fullScore,
      recordCount: r.recordCount,
      dayCount: r.dayCount,
      modules: r.moduleRows,
      records: r.records.slice(0, 10),
      noteLines: r.noteLines,
    };
    const plan = imgUtil.planLayout(page);
    const lastY = plan.footStart + 56;
    assert(plan.H >= lastY, `画布高度覆盖落款（H=${plan.H} ≥ ${lastY}）`, [plan.H, lastY]);
    assert(plan.noteLines.length > 0, '口径说明有折行内容', plan.noteLines.length);
  }

  // 无记录班：覆盖「本期无记录」分支
  const er = await reportSvc.buildReport({ className: emptyClass, range: 'day', date: today, modules });
  console.log(`\n=== 无记录班 ${emptyClass}（今日记录 ${er.recordCount} 条）===`);
  if (er.recordCount === 0) {
    assert(er.score === null, '无记录时班超分为 null（不是 0）', er.score);
    assert(er.copyText.includes('还没有检查记录'), '无记录文本明说没有记录');
    assert(!/班超分 0(\.00)?\s*分/.test(er.copyText), '无记录不显示 0 分');
    assert(er.problemModules.length === 0, '无记录时无扣分项');
  } else {
    // 今天这个班恰好有记录：换成一个确定没记录的历史日期验证无记录分支
    const past = dates.addDays(today, -400);
    const er2 = await reportSvc.buildReport({ className: emptyClass, range: 'day', date: past, modules });
    assert(er2.recordCount === 0, `历史日期 ${past} 无记录`, er2.recordCount);
    assert(er2.score === null, '无记录时班超分为 null（不是 0）', er2.score);
    assert(er2.copyText.includes('还没有检查记录'), '无记录文本明说没有记录', er2.copyText);
  }

  await mongoose.disconnect();
  console.log('');
  if (failed) {
    console.log(`班超报表验证：失败 ${failed} 项`);
    process.exit(1);
  }
  console.log('班超报表验证全部通过');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
