/**
 * 静态检查：学生会复审台的分数分类 + 批量审核（用户 2026-11-02 需求二）
 *
 * 「在学生会检查中的复审中，支持分数分类，并对每块显示检查人、检查信息(简化)、检查图片，
 *  并增加批量审核功能。」
 *
 * 六条失败模式全部**静默**（不报错、不白屏，只是行为不对），现有检查器一条都抓不到：
 *   ① 批量接口自己写一套权限判定 → 能批量通过「自己提交的记录」，绕过自审禁令（历史同类事故）；
 *   ② 批量不复用单条写法 → 单条会写 history / 批量不写，留痕断档，查不出谁改的；
 *   ③ 分档区间在前后端各写一份 → 改边界后「徽标数字」和「点进去的条数」对不上；
 *   ④ 队列没加 scopeFilter → 分院部长能读到全校（越权读）；
 *   ⑤ 列表出口没走 cropPhotos → 宿舍照片原图被无权者拿到（安全红线）；
 *   ⑥ WXML 引用了 JS 没算的字段 → 某个块永远不显示。
 *
 * 运行：node tools/check-union-review.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'src');
const MINI = path.join(ROOT, 'miniprogram');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

let failed = 0;
function ok(name, cond, detail) {
  console.log(`${cond ? '  ok   ' : '  FAIL '}${name}${cond ? '' : '  -> ' + JSON.stringify(detail)}`);
  if (!cond) failed += 1;
}

let svc = null;
try {
  svc = require(path.join(SERVER, 'services', 'union-review'));
} catch (e) {
  console.log('  FAIL 服务可加载 -> ' + e.message);
  failed += 1;
}

const ROUTE = read(SERVER, 'routes', 'union.js');
const JS = read(MINI, 'packageUnion', 'review', 'review.js');
const WXML = read(MINI, 'packageUnion', 'review', 'review.wxml');
const WXSS = read(MINI, 'packageUnion', 'review', 'review.wxss');
const APP = JSON.parse(read(MINI, 'app.json'));
const UNION_PAGE = read(MINI, 'pages', 'union', 'union.js');

// ===== 1) 分档：唯一实现 + 边界正确 =====
console.log('[1] 分数分档（唯一实现）');
if (svc) {
  ok('导出 SCORE_BANDS / bandOf / bandCond', ['SCORE_BANDS', 'bandOf', 'bandCond'].every((k) => svc[k] !== undefined));
  ok('四档（满分 / 轻微 / 中等 / 较重）', Array.isArray(svc.SCORE_BANDS) && svc.SCORE_BANDS.length === 4, svc.SCORE_BANDS && svc.SCORE_BANDS.length);
  // 边界逐例（闭区间、逐档递减）
  const cases = [
    [0, 'full'],
    [undefined, 'full'],
    [-1, 'full'],
    ['abc', 'full'],
    [0.5, 'low'],
    [2, 'low'],
    [2.5, 'mid'],
    [5, 'mid'],
    [5.5, 'high'],
    [100, 'high'],
  ];
  for (const [input, want] of cases) {
    ok(`bandOf(${JSON.stringify(input)}) = ${want}`, svc.bandOf(input).key === want, svc.bandOf(input).key);
  }
  // 条件与分档必须同源（否则筛选与归档对不上）
  const lowCond = svc.bandCond('low');
  ok('bandCond(low) 是 (0, 2]', lowCond && lowCond.deduct.$gt === 0 && lowCond.deduct.$lte === 2, lowCond);
  ok('bandCond(full) 含「没写 deduct」的历史记录', !!svc.bandCond('full') && JSON.stringify(svc.bandCond('full')).includes('$not'), svc.bandCond('full'));
  ok('bandCond(high) 只有下界（无上界）', !!svc.bandCond('high') && svc.bandCond('high').deduct.$lte === undefined);
  ok('非法 / 空档 → 不筛（null）', svc.bandCond('') === null && svc.bandCond('xx') === null);
}

// ===== 2) 单条 / 队列 / 批量共用一份判定与写入 =====
console.log('\n[2] 单一实现（单条复核 / 队列 / 批量）');
ok('服务导出 reviewOne（唯一写入口）', svc && typeof svc.reviewOne === 'function');
ok('服务导出 reviewableOf（唯一判定）', svc && typeof svc.reviewableOf === 'function');
ok('服务导出 reviewBatch', svc && typeof svc.reviewBatch === 'function');
ok('reviewBatch 逐条调 reviewOne（不做批量捷径）', /await reviewOne\(\{/.test(read(SERVER, 'services', 'union-review.js')));
// 单条复核接口也必须走 reviewOne —— 否则「单条 / 批量」两套写法迟早漂移
const singleSeg = ROUTE.slice(ROUTE.indexOf("router.post(\n  '/records/:id/review'"), ROUTE.indexOf("'/records/:id/appeal',"));
ok('单条复核走 reviewSvc.reviewOne', /reviewSvc\.reviewOne\(/.test(singleSeg));
ok('单条复核不再自己写 status/reviewedBy', !/record\.status = approve \? 'approved' : 'rejected';/.test(singleSeg));
ok('批量接口走 reviewSvc.reviewBatch', /reviewSvc\.reviewBatch\(/.test(ROUTE));
ok('批量接口不自己写 record.status', !/router\.post\(\s*'\/review\/batch'[\s\S]{0,600}doc\.status =/.test(ROUTE));
// 留痕：单条与批量都必须是 reviewOne 里那一处写（全文件只应出现一次该赋值）
ok('reviewedBy 只在一处赋值（避免两套写法）', (read(SERVER, 'services', 'union-review.js').match(/record\.reviewedBy = /g) || []).length === 1);
ok('history 只在一处 push', (read(SERVER, 'services', 'union-review.js').match(/record\.history = \[/g) || []).length === 1);

// ===== 3) 队列：权限 / 范围 / 照片裁剪 =====
console.log('\n[3] 队列出口');
const queueSeg = ROUTE.slice(ROUTE.indexOf("'/review/queue'"), ROUTE.indexOf("'/review/batch'"));
ok('队列要求成员资格', /assertMember\(identity\)/.test(queueSeg));
ok('队列要求复核资格（canReviewAny）', /canReviewAny\(identity\)/.test(queueSeg));
ok('队列带可见范围 scopeFilter（分院读不到全校）', /scopeFilter\(identity\)/.test(queueSeg));
ok('队列只取待复核（status=submitted）', /status: 'submitted'/.test(queueSeg));
ok('队列排除作废记录', /voided: \{ \$ne: true \}/.test(queueSeg));
ok('队列复用 cropPhotos（宿舍照片不下发原图）', /unionSvc\.cropPhotos\(/.test(queueSeg));
ok('队列每条下发 canReview（自审禁令服务端判定）', /canReview: check\.ok/.test(queueSeg));
ok('队列每条下发简化信息 summary', /summary: reviewSvc\.summarizeRecord/.test(queueSeg));
ok('队列下发检查人 inspectorName', /inspectorName:/.test(queueSeg));
ok('队列下发检查图片 photos', /photos: photoView\.photos\.slice/.test(queueSeg));
ok('viewer 只在循环外算一次（不 N+1 resolveIdentity）', /const viewer = \{ openid/.test(queueSeg) && !/rows\.map[\s\S]{0,120}await unionSvc\.resolveIdentity/.test(queueSeg));

// ===== 4) 批量：逐条鉴权 + 不整批回滚 + 上限 =====
console.log('\n[4] 批量出口');
const batchSeg = ROUTE.slice(ROUTE.indexOf("'/review/batch'"));
ok('批量要求复核资格', /canReviewAny\(identity\)/.test(batchSeg));
ok('批量退回必须填原因（≥2 字）', /批量退回时必须填写原因/.test(batchSeg));
ok('批量上限 50（与前端一致）', /limit: 50/.test(batchSeg) && /BATCH_LIMIT = 50/.test(JS));
ok('批量逐条反馈（results）而不是整批失败', /results/.test(read(SERVER, 'services', 'union-review.js')));
ok('批量失败不抛错整批（try/catch 逐条）', /try \{\s*await reviewOne[\s\S]{0,200}catch \(e\)/.test(read(SERVER, 'services', 'union-review.js')));

// ===== 5) 前端接线 =====
console.log('\n[5] 小程序接线');
ok('页面已登记进 app.json（packageUnion/review/review）', (APP.subpackages || []).some((p) => p.root === 'packageUnion' && p.pages.includes('review/review')));
ok('工作台「待复核」进复审台', /goReviewList\(\)[\s\S]{0,140}packageUnion\/review\/review/.test(UNION_PAGE));
ok('班超块「待复核」进同一页', /packageUnion\/review\/review/.test(read(MINI, 'components', 'banchao-block', 'banchao-block.js')));
ok('前端拉队列接口', /\/api\/union\/review\/queue/.test(JS));
ok('前端提交批量接口', /\/api\/union\/review\/batch/.test(JS));
ok('分档来自服务端（不在前端写区间）', /data\.bands/.test(JS) && !/\$lte|0 ~ 2|2 ~ 5/.test(JS));
ok('不可复核的条目勾不上（按 canReview）', /if \(!row\.canReview\)/.test(JS));
ok('本页全选只选可复核的条目', /if \(!r\.canReview \|\| this\._sel\.has\(r\.id\)\) continue;/.test(JS));
ok('退回原因前端也拦一道（≥2 字）', /reason\.length < 2/.test(JS));
ok('切换分档时清空选择（不留幽灵选中）', /if \(reset\) this\._sel = new Set\(\);/.test(JS));
ok('WXML 有三块：分档 / 记录卡 / 批量条', /rv-bands/.test(WXML) && /rv-card/.test(WXML) && /rv-bar/.test(WXML));
ok('WXML 显示检查人', /inspectorName/.test(WXML));
ok('WXML 显示简化检查信息', /item\.summary/.test(WXML));
ok('WXML 显示检查图片', /item\.photos/.test(WXML));
ok('WXML 显示不可复核原因', /reviewBlockReason/.test(WXML));
ok('WXSS 无通配符选择器', !/[\s>,]*\*\s*[{,]/m.test(WXSS.replace(/\/\*[\s\S]*?\*\//g, ' ')));

console.log(failed ? `\n失败 ${failed} 项` : '\n复审台校验通过');
process.exit(failed ? 1 : 0);
