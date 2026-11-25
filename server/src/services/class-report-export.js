/**
 * 班超报表（日 / 周 / 月）：复制文本 + 详情表格文件（用户 2026-11-23）
 *
 * 「我的班级 → 班超联赛」要能把**本期问题情况**直接发到本班群：
 *   ① 复制文本 —— 粘到微信群里不会被折叠成一小块的短文本；
 *   ② 详情表格 —— xlsx（总览 + 模块明细 + 当日明细 + 走动明细），发文件比长文本好核对；
 *   ③ 生成图片 —— 画布在**前端**（`miniprogram/utils/banchao-report.js`），但标题/口径/模块行
 *      与这里**同一份** buildReport() 产出，否则「图片写的」与「文件写的」迟早对不上。
 *
 * ===== 数据来源（不许重算）=====
 * 一切数字来自 `bandChao.classSummary()`（与页面「班超联赛」tab、首页班超块同一个函数）：
 * 区间 score / deduct / deduct4 / absenceCount / modules[].deduct / metricText / skipped 全在它里面。
 * 本文件**只做「怎么说话」**：拼文本、排表格。绝不在这里算第二套扣分或达标（同 class-status-export 的教训）。
 *
 * ===== 权限（与 GET /api/union/class/:className 同口径，不能更宽）=====
 * 能看班超详情的身份（学生会成员按范围 / 本班学生 / 班主任 / 学生会总管）才能导出。
 * 路由层只做鉴权与取参，判定函数 canViewClass() 在这里单点实现。
 */

const CheckRecord = require('../models/check-record');
const ClassProfile = require('../models/class-profile');
const dates = require('../utils/dates');
const checkModules = require('./check-modules');
const bandChao = require('./band-chao');
const unionSvc = require('./union');
// 版式工具复用班级状态导出那套（品牌橙 + 微软雅黑 + 隔行底 + 口径说明块）
const layout = require('./class-status-export');

// 区间 → 人话（「今日」/「本周」/「本月」）。与 check-modules / page 的 RANGE_WORD 同口径。
const RANGE_TEXT = { day: '今日', week: '本周', month: '本月' };
// 明细里的状态文案：只列「已计入」的记录（COUNTED_STATUS），退回/作废的不进报表
const STATUS_TEXT = { submitted: '已提交', approved: '已复核' };

const MAX_ROWS = 200; // 明细 sheet 单次上限：本班一个月也很难超过，超出用「仅显示前 N 条」注明

// ===== 小工具 =====
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (n) => Number(n) || 0;
/** 「2026-11-16」→「11月16日」 */
const md = (dayKey) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  return m ? `${Number(m[2])}月${Number(m[3])}日` : String(dayKey || '');
};
/** 区间 →「11月10日」/「11月10日至11月16日」（同一天不重复写） */
const spanText = (from, to) => (from && to && from !== to ? `${md(from)}至${md(to)}` : md(from || to));
/** 分数展示：两位小数（10 分制下一位会把 9.95 显示成 10.0） */
const scoreText = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : round2(v).toFixed(2));

/**
 * 能不能看这个班的班超报表。
 * ⚠️ 判定**不在本文件里**：路由把 `routes/union.js::canViewClassFull` 的结果传进来
 * （那是页面 GET /class/:className 的同一份判定）。本文件只组装报表，
 * 绝不在这里再写一份近似判定 —— 两份必然漂移成「页面能看、导出 403」或反过来越权。
 */

/**
 * 组装本期报表（文本 / 表格 / 图片共用同一份）。
 *
 * @param {object} p
 * @param {string} p.className
 * @param {'day'|'week'|'month'} p.range
 * @param {string} p.date
 * @param {string} [p.weekNo] 本月第几周（range=week）
 * @param {string} [p.month] 月份（YYYY-MM，range=week/month）
 * @param {object[]} [p.modules] 模块定义（缺省现取）
 * @param {(rec, moduleDef)=>object} [p.presentRecord] 记录卡片的展示字段（路由已实现，传进来复用）
 */
async function buildReport({ className, range, date, weekNo, month, modules, presentRecord }) {
  const mods = modules || (await checkModules.listModules({ force: true }));
  const summary = await bandChao.classSummary({ className, date, range, weekNo, month, modules: mods });
  const profile = await ClassProfile.findOne({ className }).lean();

  const from = String(summary.from || '').slice(0, 10);
  const to = String(summary.to || '').slice(0, 10);
  const periodLabel = summary.periodLabel || summary.rangeLabel || RANGE_TEXT[range] || '';
  const rangeWord = RANGE_TEXT[range] || summary.rangeLabel || '';

  // 明细（与页面「所选区间内的全部检查记录」同条件：COUNTED 状态 + 非 voided）
  const match = {
    className,
    voided: { $ne: true },
    status: { $in: CheckRecord.COUNTED_STATUS },
    date: { $gte: from, $lte: to },
  };
  const [rows, total] = await Promise.all([
    CheckRecord.find(match).sort({ date: -1, createdAt: -1 }).limit(MAX_ROWS).lean(),
    CheckRecord.countDocuments(match),
  ]);
  const nameOf = new Map(mods.map((m) => [m.key, m.shortName || m.name]));
  const moduleMap = new Map(mods.map((m) => [m.key, m]));
  const records = rows.map((r) => {
    const moduleDef = moduleMap.get(r.moduleKey);
    // 有 presentRecord 就用路由那份（照片 / 名单权限判定的口径在那里），否则只取基础字段
    const base = presentRecord ? presentRecord(r) : {};
    return {
      id: String(r._id),
      date: r.date,
      moduleName: nameOf.get(r.moduleKey) || r.moduleKey,
      statusText: STATUS_TEXT[r.status] || r.status || '',
      deduct: round2(r.deduct),
      scoreText: r.score === null || r.score === undefined ? '' : scoreText(r.score),
      // 展示摘要：路由传进来的 presentRecord 已按页面口径拼好（含权限裁剪），优先用它；
      // 兜底时走 bandChao.metricText，注意它第 2 参**必须是一组记录的 metrics 数组**
      //（写成单条 record 会在 `(metrics || []).map` 处抛 TypeError —— 端到端验证抓到过）。
      metricText: base.metricText || bandChao.metricText(moduleDef, r.metrics ? [r.metrics] : [], (r.details && r.details.actualCount) || 0) || '',
      remark: String((r.details && r.details.remark) || r.remark || '').slice(0, 60),
      // 受检对象名（「1号楼 302」/「北校区操场中部区域-南」/班级名）：录入时已写进记录。
      // 复制文本里必须有它 —— 只写「卫生 扣 2 分」时，群里的人根本不知道是哪个宿舍/区域扣的分。
      targetName: base.targetName || r.targetName || r.className || '',
      inspectorName: (r.details && r.details.inspectorName) || r.inspectorName || '',
      submittedAt: r.createdAt ? new Date(r.createdAt).toISOString() : '',
    };
  });

  // 模块行：状态文案与页面逐字一致（跳过 / 未录 / 可选未录 / 已录）
  const moduleRows = (summary.modules || []).map((m) => {
    const entered = !!m.entered;
    const skipped = !!m.skipped;
    // 可选模块（早八「只记迟到人」）未录时服务端下发 noRecordText（「无迟到」）：
    // 状态文案必须跟它走 —— 状态写「未录」而指标写「无迟到」自相矛盾（用户明确口径：无记录 = 无迟到）。
    const optionalMissing = !entered && !skipped && !!m.noRecordText;
    const stateText = skipped ? '不参检' : optionalMissing ? m.noRecordText : !entered ? '未录' : '已录';
    return {
      key: m.key,
      name: m.shortName || m.name,
      ownerDeptName: m.ownerDeptName || '',
      state: skipped ? 'skip' : !entered ? 'missing' : 'entered',
      stateText,
      scoreText: skipped ? '无' : entered ? scoreText(m.score) : '—',
      deduct: skipped || !entered ? 0 : round2(m.deduct),
      deductText: skipped ? '' : entered ? (num(m.deduct) > 0 ? `扣 ${scoreText(m.deduct)}` : '未扣分') : '',
      metricText: skipped ? m.skippedReason || '本班不参检' : entered ? m.metricText || '' : m.noRecordText || '暂无记录',
      // 可选模块（早八）未录 = 正常，不算「未录待补」，不进文本的「未录模块」提醒
      optionalMissing,
    };
  });
  // 只把「有问题的模块」写进复制文本（扣分 > 0），未录 / 不参检单独提一句，不铺满整段
  const problemModules = moduleRows.filter((m) => m.state === 'entered' && m.deduct > 0);
  // 「未录模块」只提醒**必需**模块：optionalMissing 是「没有记录 = 无迟到」的正常状态
  const missingModules = moduleRows.filter((m) => m.state === 'missing' && !m.optionalMissing);

  const deduct = round2(summary.deduct);
  const report = {
    className,
    range,
    rangeWord,
    periodLabel,
    periodSpan: spanText(from, to),
    from,
    to,
    score: summary.score,
    scoreText: scoreText(summary.score),
    fullScore: num(summary.fullScore) || 10,
    deduct,
    deduct4: round2(summary.deduct4),
    absenceCount: num(summary.absenceCount),
    absenceWeight: round2(summary.absenceWeight),
    recordCount: num(summary.recordCount),
    dayCount: Array.isArray(summary.days) ? summary.days.length : 0,
    departmentName: (profile && profile.departmentName) || '',
    moduleRows,
    problemModules,
    missingModules,
    records,
    recordsTotal: total,
    recordsTruncated: total > records.length,
    maxRows: MAX_ROWS,
    // 口径说明（文本末尾与 xlsx 的口径块共用，**只写一份**）
    noteLines: buildNoteLines(),
  };
  report.copyText = buildCopyText(report);
  return report;
}

/**
 * 口径说明：分数怎么来的（与班超页脚注同源，数字从 band-chao 常量取，不写死）。
 * 群里的人看不到页面脚注，只看到「8.60 分」一定会问「这分怎么算的」。
 */
function buildNoteLines() {
  const full = Math.round(num(require('./score-scale').FULL_SCORE) || 10);
  const ratio = Math.round((bandChao.DEDUCT_SCORE_RATIO || 0.1) * 100);
  return [
    `班超分 = ${full} − 卫生/查宿/晚自习/早操四项累计扣分 × ${ratio}% − 缺勤加权（普通缺勤 0.02/人次，病/事/公假 0.01/人次），最低 0 分。`,
    '只统计已提交 / 已复核的检查记录，作废与未提交的记录不计入。',
    '班里没有某一项（如无晚自习）按「不参检」计，不另外扣分。',
    '整个统计期一次检查都没录的模块显示「未录」，不是 0 分 —— 请以纪检部实际录入为准。',
  ];
}

/**
 * 复制到班群的短文本。
 *
 * 为什么必须短：微信里超长文本会被折叠成「全文」，老师在群里根本看不到重点。
 * 所以只写：分数 + 名次 + **扣分模块**（真正的问题）+ 未录提醒 + 最近几条记录。
 * 明细（每条记录）放 xlsx，不塞进文本。
 */
function buildCopyText(r) {
  const head = `【${r.className}】班超${r.rangeWord} ${r.periodSpan}`;
  const lines = [head];
  if (r.score === null || r.score === undefined) {
    lines.push(`本期还没有检查记录（${r.recordCount} 条），班超分无法计算。`);
  } else {
    lines.push(`班超分 ${r.scoreText} 分${r.departmentName ? ` · ${r.departmentName}` : ''} · ${r.recordCount} 条记录`);
  }
  if (r.problemModules.length) {
    lines.push('扣分项：');
    for (const m of r.problemModules) {
      // ⚠️ 只在括号里写**非累加**指标（查宿「未归 3 人 · 在宿率 98.9%」）。
      // 卫生的指标是「得分 = 本期各次检查得分之和」（135 条 × 10 分制 = 868 分），
      // 与「扣 85.75 分」并列会被读成「这次得了 868 分」，反而误导 —— 卫生只写扣分。
      const metric = m.key === 'hygiene' ? '' : m.metricText;
      lines.push(`· ${m.name} 扣 ${scoreText(m.deduct)} 分${metric ? `（${metric}）` : ''}`);
    }
  } else if (r.recordCount > 0) {
    lines.push('本期各项均未扣分 👍');
  }
  if (r.missingModules.length) {
    lines.push(`未录模块：${r.missingModules.map((m) => m.name).join('、')}（纪检部还没录，请留意）`);
  }
  if (r.absenceCount > 0) {
    lines.push(`缺勤 ${r.absenceCount} 人次（加权扣分 ${scoreText(r.absenceWeight)}）`);
  }
  // 最近 3 条**有问题的**记录（扣分 > 0）：群里关心的是「扣分扣在哪一天、哪个对象」。
  // 全满分时不列流水（列三条「卫生 10 分」等于没说），只留上面那句「各项均未扣分」。
  const problemRecords = r.records.filter((rec) => rec.deduct > 0);
  if (problemRecords.length) {
    lines.push('扣分明细：');
    for (const rec of problemRecords.slice(0, 5)) {
      // 一行：日期 · 模块 · 受检对象 · 扣分 · 评价内容。得分与扣分同时写会拼出「得分 10 分 · 10.00 分」这种重复。
      // 同一天同扣分出现多行是正常的（不同宿舍 / 不同区域各自扣分），对象名让它们彼此可区分。
      const where = rec.targetName && rec.targetName !== r.className ? rec.targetName : '';
      // 中文标点前不留半角空格（「扣 2.00 分 （得分 8分）」读起来像断句）
      const tail = [where, rec.deduct > 0 ? `扣 ${scoreText(rec.deduct)} 分` : '', rec.metricText ? `（${rec.metricText}）` : '']
        .filter(Boolean)
        .join(' ')
        .replace(/\s+（/g, '（');
      lines.push(`· ${md(rec.date)} ${rec.moduleName}${tail ? ` ${tail}` : ''}`);
    }
    if (problemRecords.length > 5) lines.push(`· …另有 ${problemRecords.length - 5} 条扣分记录`);
  }
  lines.push(`（完整明细见导出的表格文件）`);
  return lines.join('\n');
}

// ===== 详情表格（xlsx）=====

/** 总览 + 模块两段，放在同一张 sheet 上半部分 */
function buildOverviewSheet(wb, r) {
  const cols = [
    { title: '项目', wch: 18 },
    { title: '内容', wch: 46 },
    { title: '扣分', wch: 10 },
    { title: '说明', wch: 34 },
  ];
  const ws = wb.addWorksheet('本期总览', { views: [{ state: 'frozen', ySplit: 3 }], properties: { defaultRowHeight: 18 } });
  ws.columns = cols.map((c) => ({ width: c.wch }));
  // styleSheetTitle 内部已按 colCount 合并整行 —— 这里**不能**再合并一次（ExcelJS 会抛
  // 「Cannot merge already merged cells」，端到端验证抓到过）。
  layout.styleSheetTitle(ws, 1, cols.length, `${r.className} · 班超${r.rangeWord}报表（${r.periodSpan}）`);
  layout.styleSheetSubtitle(ws, 2, cols.length, `导出时间 ${dates.todayKey()} · ${r.departmentName || ''} · ${r.recordCount} 条记录 · ${r.dayCount} 天有记录`);
  layout.styleHeaderRow(ws, 3, cols);

  const rows = [
    ['班超分', r.score === null || r.score === undefined ? '—' : `${r.scoreText} 分`, '', r.score === null ? '本期无检查记录' : '满分 10 分'],
    ['本期累计扣分', `${r.deduct} 分`, '', '四项模块扣分合计 + 缺勤加权'],
    ['其中四项模块扣分', `${r.deduct4} 分`, '', '卫生 / 查宿 / 晚自习 / 早操'],
    ['其中缺勤加权', `${r.absenceWeight} 分`, '', `缺勤 ${r.absenceCount} 人次`],
    ['检查记录数', `${r.recordCount} 条`, '', `覆盖 ${r.dayCount} 天`],
  ];
  layout.styleDataRows(ws, 4, rows, cols.length);
  let cursor = 4 + rows.length + 1;

  // 模块明细小节
  layout.styleSectionTitle(ws, cursor, cols.length, '检查明细（各模块本期得分与扣分）');
  cursor += 1;
  const modCols = [
    { title: '模块', wch: 14 },
    { title: '所属部门', wch: 16 },
    { title: '得分', wch: 10 },
    { title: '扣分', wch: 10 },
    { title: '状态', wch: 10 },
    { title: '指标', wch: 46 },
  ];
  layout.styleHeaderRow(ws, cursor, modCols);
  cursor += 1;
  const modRows = r.moduleRows.map((m) => [m.name, m.ownerDeptName, m.scoreText, m.deduct ? scoreText(m.deduct) : '', m.stateText, m.metricText]);
  layout.styleDataRows(ws, cursor, modRows, modCols.length, { centerCols: [3, 4, 5] });
  cursor += modRows.length + 1;

  layout.styleNoteBlock(ws, cursor, cols.length, r.noteLines);
  return ws;
}

/** 每条检查记录一行（发文件核对用） */
function buildRecordsSheet(wb, r) {
  const cols = [
    { title: '序号', wch: 6 },
    { title: '日期', wch: 12 },
    { title: '模块', wch: 14 },
    { title: '得分', wch: 8 },
    { title: '扣分', wch: 8 },
    { title: '检查内容', wch: 44 },
    { title: '备注', wch: 28 },
    { title: '检查人', wch: 12 },
    { title: '状态', wch: 10 },
  ];
  const ws = wb.addWorksheet('检查明细', {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 3 }],
    properties: { defaultRowHeight: 18 },
  });
  ws.columns = cols.map((c) => ({ width: c.wch }));
  layout.styleSheetTitle(ws, 1, cols.length, `${r.className} · ${r.periodSpan} 检查明细`);
  layout.styleSheetSubtitle(
    ws,
    2,
    cols.length,
    r.recordsTruncated ? `共 ${r.recordsTotal} 条，仅列出前 ${r.records.length} 条（完整明细请缩小统计范围）` : `共 ${r.recordsTotal} 条`
  );
  layout.styleHeaderRow(ws, 3, cols);
  const data = r.records.map((rec, i) => [
    i + 1,
    rec.date,
    rec.moduleName,
    rec.scoreText,
    rec.deduct ? scoreText(rec.deduct) : '',
    rec.metricText,
    rec.remark,
    rec.inspectorName,
    rec.statusText,
  ]);
  layout.styleDataRows(ws, 4, data, cols.length, { centerCols: [1, 2, 4, 5, 9], wrapCols: [6, 7] });
  if (data.length) ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3 + data.length, column: cols.length } };
  // 全无记录时给一行可读的空态，而不是一张只有表头的表
  if (!data.length) layout.styleDataRows(ws, 4, [['', '', '本期没有检查记录', '', '', '', '', '', '']], cols.length);
  return ws;
}

/** 生成 xlsx Buffer */
async function buildWorkbook(r) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = '唐唐快跑';
  wb.created = new Date();
  buildOverviewSheet(wb, r);
  buildRecordsSheet(wb, r);
  return wb.xlsx.writeBuffer();
}

/** 发送 xlsx（文件名带班级与区间，群里一眼能看出是哪一份） */
async function sendXlsx(res, r) {
  const buf = await buildWorkbook(r);
  const safeClass = String(r.className || '').replace(/[\\/:*?"<>|]/g, '');
  const safeDay = `${r.from || dates.todayKey()}${r.from !== r.to ? `至${r.to}` : ''}`.replace(/[^0-9A-Za-z-]/g, '');
  const fileName = `${safeClass}-班超${r.rangeWord}-${safeDay}.xlsx`;
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  // 中文文件名：filename* 给现代客户端，filename 给老版本
  res.set('Content-Disposition', `attachment; filename="class-report-${safeDay}.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.send(Buffer.from(buf));
}

module.exports = {
  RANGE_TEXT,
  MAX_ROWS,
  buildReport,
  buildCopyText,
  buildNoteLines,
  buildWorkbook,
  sendXlsx,
};
