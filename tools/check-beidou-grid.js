/**
 * 检查器：九宫格「老虎机式」连线纯函数（不连库）。
 *
 * 用户 2026-11-22 口径：
 *   · 横/竖/斜 8 条线，3 个相同奖品图案 = 1 线；
 *   · 可以同时中多条线，每条线发该图案的单线奖；
 *   · 例：皇冠单线奖 1 铜版，1 线 = 1，2 线 = 2；
 *   · 不同图案的线分别累计（可同一局同时发铜版和步数）。
 *
 * 运行：node tools/check-beidou-grid.js
 */
const path = require('path');
const grid = require(path.join(__dirname, '..', 'server', 'src', 'services', 'beidou-grid'));
const cfgSvc = require(path.join(__dirname, '..', 'server', 'src', 'services', 'beidou-config'));

let failed = 0;
function ok(name, cond, detail) {
  console.log(`${cond ? '  ok   ' : '  FAIL '}${name}${cond ? '' : '  -> ' + JSON.stringify(detail)}`);
  if (!cond) failed += 1;
}

const symbols = [
  { key: 'star', label: '星星', icon: '⭐', iconUrl: '', type: 'coin', amount: 5, weight: 30, tier: 'low' },
  { key: 'medal', label: '奖牌', icon: '🏅', iconUrl: '', type: 'coin', amount: 10, weight: 15, tier: 'mid' },
  { key: 'foot', label: '足迹', icon: '👣', iconUrl: '', type: 'steps', amount: 100, weight: 15, tier: 'mid' },
  { key: 'crown', label: '皇冠', icon: '👑', iconUrl: '', type: 'coin', amount: 1, weight: 10, tier: 'high' },
  { key: 'blank', label: '空白', icon: '▫', iconUrl: '', type: 'none', amount: 0, weight: 30, tier: 'none' },
];

// 1) 8 条线定义
ok('8 条线（3 行 + 3 列 + 2 对角线）', grid.LINES.length === 8, grid.LINES.length);
ok('每条线 3 格且下标合法', grid.LINES.every((l) => l.cells.length === 3 && l.cells.every((i) => i >= 0 && i < 9)));
ok('线 key 唯一', new Set(grid.LINES.map((l) => l.key)).size === 8);

// 2) 中奖线识别 + 多线
const full = Array(9).fill('crown');
const fullEval = grid.evaluateBoard(full, symbols);
ok('9 格全皇冠 → 8 条线', fullEval.totalLines === 8, fullEval.totalLines);
ok('8 线皇冠 → 奖励 = 8 × 单线奖', fullEval.rewards.length === 1 && fullEval.rewards[0].amount === 8, fullEval.rewards);
ok('全皇冠铜版合计 = 8', fullEval.coinAmount === 8, fullEval.coinAmount);

const oneLine = Array(9).fill('blank');
[0, 1, 2].forEach((i) => { oneLine[i] = 'crown'; });
const oneEval = grid.evaluateBoard(oneLine, symbols);
ok('1 线皇冠 → 1 条线 / 1 铜版', oneEval.totalLines === 1 && oneEval.coinAmount === 1, oneEval);

const twoLine = Array(9).fill('blank');
[0, 1, 2].forEach((i) => { twoLine[i] = 'crown'; });
[3, 4, 5].forEach((i) => { twoLine[i] = 'crown'; });
const twoEval = grid.evaluateBoard(twoLine, symbols);
ok('2 线皇冠 → 2 条线 / 2 铜版（单线奖 × 线数）', twoEval.totalLines === 2 && twoEval.coinAmount === 2, twoEval);

// 3) 不同图案分别累计 + 混合奖励
const mixed = Array(9).fill('blank');
[0, 1, 2].forEach((i) => { mixed[i] = 'crown'; }); // 第 1 行皇冠
[3, 4, 5].forEach((i) => { mixed[i] = 'foot'; }); // 第 2 行足迹
const mixedEval = grid.evaluateBoard(mixed, symbols);
ok('不同图案的线分别累计（1 线皇冠 + 1 线足迹）', mixedEval.rewards.length === 2, mixedEval.rewards);
ok('混合奖励同时含铜版 1 与步数 100', mixedEval.coinAmount === 1 && mixedEval.stepsAmount === 100, mixedEval);
ok('混合奖励不是单类型', mixedEval.coinAmount > 0 && mixedEval.stepsAmount > 0);

// 4) 空白成线不兑奖
const blanks = Array(9).fill('blank');
ok('空白图案成线不算中奖', grid.findLines(blanks, symbols).length === 0, grid.findLines(blanks, symbols));

// 5) 随机盘面 + 保底
const board = grid.drawBoard(symbols);
ok('随机盘面 9 格', board.length === 9, board.length);
const pityBoard = grid.drawBoard(symbols, () => 0, { pitySymbol: 'crown' });
const pityEval = grid.evaluateBoard(pityBoard, symbols);
ok('保底强制至少 1 线皇冠', pityEval.rewards.some((r) => r.symbolKey === 'crown' && r.lines >= 1), pityEval);

// 6) 图标 URL 透传
const cells = grid.boardCells(['crown', 'blank'], symbols);
ok('格子带 iconUrl（用户上传图标）', cells[0].iconUrl === '' && cells[0].icon === '👑');
const withUrl = grid.boardCells(['crown'], [{ ...symbols[3], iconUrl: 'https://x/y.png' }]);
ok('有 iconUrl 时透传', withUrl[0].iconUrl === 'https://x/y.png', withUrl[0]);

// 7) 奖励文案
const text = grid.rewardTextOf(mixedEval.rewards, '铜版');
ok('混合奖励文案含两种奖励', /皇冠/.test(text) && /足迹/.test(text) && /铜版/.test(text) && /步/.test(text), text);

// 8) 权重/期望（与后台预览同一公式）
const e = cfgSvc.buildEffective({});
ok('默认 5 个图案', e.grid.symbols.length === 5, e.grid.symbols.length);
ok('默认九宫格期望线数 > 0', e.grid.ev.expectedLines > 0, e.grid.ev);
ok('默认九宫格返奖率 < 100%', e.grid.ev.returnRate < 100, e.grid.ev);
ok('默认高价值图案单格出现率 ≤ 10%', e.grid.ev.highTierPercent <= 10, e.grid.ev.highTierPercent);

console.log(failed ? `\n发现 ${failed} 个问题` : '\n九宫格老虎机式连线纯函数检查全部通过');
process.exit(failed ? 1 : 0);
