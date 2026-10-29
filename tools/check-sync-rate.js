/**
 * 检查器：反作弊「涨幅速度」不得误封真人。
 *
 * 背景（用户 2026-10-29 原话）：「同步增速这个有点假很容易误封锁」。
 *
 * 为什么单独守这一条：这是**唯一一个会随用户操作习惯变化而误判的特征**——
 * 其他特征（单日总量、固定数字）反映的是"数据本身长什么样"，
 * 而涨幅速度 = 本次新增 ÷ 距上次同步时长，**分母是用户点同步的时机**，不是运动时长。
 * 真人实测会踩到的场景：
 *   · 走 30 秒 600 步后再同步 → 20 步/秒（旧口径 >15 得 0.9 → 直接封号）
 *   · 连点两次刷新（间隔 5 秒补 500 步）→ 100 步/秒
 *   · 快走 60 秒 1000 步 → 16.67 步/秒
 * 这些全是真实步数。阈值一旦被后人"调紧一点"，就会成片误封，而误封只能靠学生申诉才发现。
 *
 * 守住四条不变量：
 *   ① 有最小可信时间窗（< 3 分钟不判增速）；
 *   ② 硬规则门槛不低于 15 步/秒；
 *   ③ 物理约束层给涨幅速度的分数**必须低于自动封禁线**（只进待研判，绝不单独封号）；
 *   ④ 文案统一叫「涨幅速度」（不要再写「同步增速」——它容易被理解成加速度）。
 *
 * 运行：node tools/check-sync-rate.js
 */
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server', 'src');
const read = (p) => fs.readFileSync(path.join(SERVER, p), 'utf8');

let failed = 0;
function ok(name, cond, detail) {
  console.log(`${cond ? '  ok   ' : '  FAIL '}${name}${cond ? '' : '  -> ' + JSON.stringify(detail)}`);
  if (!cond) failed += 1;
}

const anomalySrc = read('services/step-anomaly.js');
const modelSrc = read('services/anticheat-model.js');

// ===== ① 最小可信时间窗 =====
console.log('[1] 最小可信时间窗');
ok('step-anomaly 定义了 MIN_WINDOW_SEC', /const MIN_WINDOW_SEC\s*=\s*\d+/.test(anomalySrc));
const mwMatch = anomalySrc.match(/const MIN_WINDOW_SEC\s*=\s*(\d+)/);
const mw = mwMatch ? Number(mwMatch[1]) : 0;
ok('时间窗 ≥ 120 秒（短于此的分母不可信）', mw >= 120, mw);
ok('时间窗内直接跳过判定', /ms\s*<\s*MIN_WINDOW_SEC\s*\*\s*1000[\s\S]{0,80}return\s*\{\s*score:\s*0/.test(anomalySrc));

// ===== ② 硬规则门槛 =====
console.log('\n[2] 硬规则门槛（checkStepRate）');
// 提取函数体，确认没有低于 15 的阈值
const fnBody = (anomalySrc.match(/function checkStepRate[\s\S]*?\n\}/) || [''])[0];
ok('checkStepRate 存在', fnBody.length > 0);
const thresholds = [...fnBody.matchAll(/perSec\s*>=\s*([0-9.]+)/g)].map((m) => Number(m[1]));
ok('门槛存在', thresholds.length > 0, thresholds);
ok(
  `最低门槛 ≥ 15 步/秒（实际 ${thresholds.length ? Math.min(...thresholds) : '?'}）`,
  thresholds.length > 0 && Math.min(...thresholds) >= 15,
  thresholds
);
// 旧口径的两档 8/12 必须已消失（8 步/秒对真人太松）
ok('不再有 8 / 12 步/秒这类过松门槛', !/perSec\s*>=\s*(8|12)\b/.test(fnBody), thresholds);

// ===== ③ 物理约束层绝不能单独封号 =====
console.log('\n[3] 物理约束层（AI）不得单独封号');
// 取 physicalScore 函数体
const physBody = (modelSrc.match(/function physicalScore[\s\S]*?\n\}/) || [''])[0];
ok('physicalScore 存在', physBody.length > 0);
// 找到「涨幅速度」那一段（以 perSec 为条件的 score 赋值）
const rateBlock = (physBody.match(/if \(feat\.perSec[\s\S]*?\n    \}/) || [''])[0];
ok('物理层有涨幅速度判据', rateBlock.length > 0, rateBlock.slice(0, 120));
const assigned = (rateBlock.match(/score\s*=\s*Math\.max\(score,\s*([0-9.]+)\)/) || [])[1];
ok('涨幅速度给了分数', assigned !== undefined, rateBlock);
// 关键：必须低于默认自动封禁线 0.78（BASE_THRESHOLD.autoBan）
const autoBanBase = Number((modelSrc.match(/const BASE_THRESHOLD\s*=\s*\{[\s\S]*?autoBan:\s*([0-9.]+)/) || [])[1]);
ok('能读到默认自动封禁线', Number.isFinite(autoBanBase), autoBanBase);
ok(
  `涨幅速度分数 ${assigned} < 自动封禁线 ${autoBanBase}（只进待研判，不单独封号）`,
  Number(assigned) < autoBanBase,
  { assigned, autoBanBase }
);
ok('物理层也要求最小时间窗（elapsedSec ≥ 180）', /feat\.perSec[\s\S]{0,120}elapsedSec[\s\S]{0,40}>=\s*180/.test(physBody));

// ===== ④ 文案口径 =====
console.log('\n[4] 文案口径');
ok('feature 里有 elapsedSec（时间窗判据的数据来源）', /elapsedSec:/.test(modelSrc));
ok('用户可见文案用「涨幅速度」', /涨幅速度/.test(anomalySrc) && /涨幅速度/.test(modelSrc));
const userFacingOld = /`同步增速\s?\$?\{?/.test(anomalySrc) || /`同步增速\s?\$?\{?/.test(modelSrc);
ok('不再用「同步增速」作为用户可见文案', !userFacingOld);

// ===== ⑤ 行为回归（真跑函数，确认真人场景不命中）=====
console.log('\n[5] 行为回归（真人场景不得命中）');
const anomaly = require(path.join(SERVER, 'services', 'step-anomaly'));
const realCases = [
  ['走 30 秒 600 步后同步', 600, 30 * 1000],
  ['快走 60 秒 1000 步', 1000, 60 * 1000],
  ['连点刷新 5 秒 +500', 500, 5 * 1000],
  ['间隔 2 秒 +300', 300, 2 * 1000],
  ['间隔 179 秒 +2000（未达时间窗）', 2000, 179 * 1000],
];
for (const [label, delta, ms] of realCases) {
  const r = anomaly.checkStepRate(delta, ms);
  ok(`真人场景不判：${label}`, !r.hit, r);
}
const cheatCases = [
  ['间隔 5 分钟 +7000', 7000, 300 * 1000],
  ['间隔 10 分钟 +15000', 15000, 600 * 1000],
];
for (const [label, delta, ms] of cheatCases) {
  const r = anomaly.checkStepRate(delta, ms);
  ok(`真作弊仍命中：${label}`, r.hit, r);
}

// ===== ⑥ 其他特征未被误伤 =====
console.log('\n[6] 真刷步特征仍然有效');
ok('单日总量上限仍在', /function checkDailyCap/.test(anomalySrc) && /80000/.test(anomalySrc));
ok('固定数字模式仍在', /function checkPatternNumber/.test(anomalySrc));
ok('整数化仍在', /function checkRoundNumber/.test(anomalySrc));
ok(
  '物理层单日 10 万步仍是高置信分',
  /feat\.steps > 100000[\s\S]{0,80}0\.95/.test(physBody)
);

console.log(failed ? `\n失败 ${failed} 项` : '\n涨幅速度口径校验通过（真人不会因同步短期增量被误封）');
process.exit(failed ? 1 : 0);
