/**
 * 检查器：北斗运动 3.0（铜版经济 + 转盘 + 九宫格连线 + 好友点击归因）的静态契约。
 *
 * 方案与口径唯一说明：docs/beidou-economy-plan.md。本文件盯的是**改完之后最容易静默坏掉**的几条：
 *
 *   ① 结果只由服务端定：转盘 index / 九宫格 board+lines / 概率 / 保底全在 service，
 *      前端不得自己随机、自己排扇区、自己连线；
 *   ② 任务（看视频/签到/分享）只发铜版，不得再写 `draw.total` / run_records；
 *   ③ 分享必须好友点开（token + share/click），旧 share/report 只回 deprecated；
 *   ④ 钱包只经 beidou-wallet 增减，流水幂等键 `(openid, idemKey)` 唯一；余额不为负；
 *   ⑤ 两个玩法都扣铜版、都发铜版；dailyGameCoinCap / dailyStepsCap / 分享日上限是硬约束；
 *   ⑥ 保底连续未中触发、中奖清零；九宫格生成器线数必须精确；
 *   ⑦ 旧后端 API 全部保留（路径 + 旧字段），不得删除。
 *
 * 运行：node tools/check-beidou-lottery.js
 */
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server', 'src');
const MP = path.join(__dirname, '..', 'miniprogram');
const readS = (p) => fs.readFileSync(path.join(SERVER, p), 'utf8');
const readM = (p) => fs.readFileSync(path.join(MP, p), 'utf8');

let failed = 0;
function ok(name, cond, detail) {
  console.log(`${cond ? '  ok   ' : '  FAIL '}${name}${cond ? '' : '  -> ' + JSON.stringify(detail)}`);
  if (!cond) failed += 1;
}

const svc = readS('services/beidou.js');
const cfg = readS('services/beidou-config.js');
const walletSvc = readS('services/beidou-wallet.js');
const gridSvc = readS('services/beidou-grid.js');
const route = readS('routes/beidou.js');
const oldRoute = readS('routes/reward-video.js');
const adminCfg = readS('routes/admin/config.js');
const model = readS('models/goal-config.js');
const dayModel = readS('models/beidou-day.js');
const drawModel = readS('models/beidou-draw.js');
const walletModel = readS('models/beidou-wallet.js');
const logModel = readS('models/beidou-coin-log.js');
const shareLinkModel = readS('models/beidou-share-link.js');
const shareClickModel = readS('models/beidou-share-click.js');
const pageJs = readM('pages/reward/reward.js');
const pageWxml = readM('pages/reward/reward.wxml');
const pageWxss = readM('pages/reward/reward.wxss');
const shareUtil = readM('utils/beidou-share.js');
const appSrc = readM('app.js');
const splash = readM('pages/splash/splash.js');
const home = readM('pages/home/home.js');
const adminJs = readM('packageAdmin/config/reward-video.js');
const adminWxml = readM('packageAdmin/config/reward-video.wxml');
const indexJs = readS('index.js');

// ===== ① 结果只由服务端定 =====
console.log('[1] 结果只由服务端定');
ok('服务端用 crypto.randomInt 生成随机数（不用 Math.random 定结果）',
  /crypto\.randomInt\(/.test(svc) && !/Math\.random\(\)[\s\S]{0,30}roll/.test(svc));
ok('转盘 pickPrize 在 service（配置模块）里按权重求命中项',
  /function pickPrize\(prizes, sectors, roll\)/.test(cfg));
ok('九宫格盘面由服务端生成（gridSvc.drawBoard）', /gridSvc\.drawBoard\(/.test(svc));
ok('九宫格线检测/奖励统计只在服务端（findLines/evaluateBoard）',
  /function findLines\(board, symbols\)/.test(gridSvc) && /function evaluateBoard\(board, symbols\)/.test(gridSvc));
ok('前端不自己生成盘面/算连线（反向断言）',
  !/findLines\(/.test(pageJs) && !/function\s+lineCount/.test(pageJs) && !/Math\.random\(\)[\s\S]{0,40}board/.test(pageJs));
ok('前端转盘扇区直接来自接口 draw.sectors', /draw\.sectors|wheel\.sectors/.test(pageJs));
ok('前端停位角度用 DEG_PER_SECTOR（不硬编码 45/22.5）',
  /centerDeg = safeIndex \* DEG_PER_SECTOR \+ DEG_PER_SECTOR \/ 2/.test(pageJs));
ok('前端展示服务端下发的 prize（不是停位数组项）', /const p = result\.prize \|\| \{\}/.test(pageJs));
ok('九宫格结果使用服务端 board/lines', /result\.board/.test(pageJs) && /result\.lines/.test(pageJs));
ok('转盘 transitionend + 兜底定时器', /bind:transitionend="onSpinEnd"/.test(pageWxml) && /_spinTimer = setTimeout\(finish/.test(pageJs));

// ===== ② 任务只发铜版 =====
console.log('\n[2] 任务只发铜版');
ok('看视频不再累加 draw.total（反向断言）',
  !/reportVideo[\s\S]{0,1600}'draw\.total'/.test(svc));
ok('签到不再累加 draw.total / 发步数（反向断言）',
  !/async function checkin[\s\S]{0,3000}'draw\.total'/.test(svc)
  && !/async function checkin[\s\S]{0,3000}'draw\.stepsAwarded'/.test(svc));
ok('看视频发铜版（creditTaskCoin / coinPerWatch）', /source: 'video'/.test(svc) && /coinPerWatch/.test(cfg));
ok('签到发铜版（source: checkin）', /source: 'checkin'/.test(svc));
ok('签到阶梯只认 coin（旧 draw/steps 归零）',
  /draw: 0,\s*\n\s*steps: 0/.test(cfg) && /normalizeMilestones/.test(cfg));
ok('签到固定 7 天（脏数据截断/补齐 + dayNo 稳定 key）',
  /milestoneCount: 7/.test(cfg) && /slice\(0, LIMITS\.milestoneCount\)/.test(cfg)
  && /dayNo: i \+ 1/.test(cfg) && /wx:key="dayNo"/.test(adminWxml));
ok('签到输入走独立 index handler（不拼 {{index}} 路径）',
  /onMilestoneField/.test(adminWxml) && /onMilestoneField\(e\)/.test(adminJs));
ok('分享旧接口只回 deprecated，不再发奖', /deprecated: true/.test(svc) && /分享后需好友点开/.test(svc));
ok('旧 /api/reward-video/report 仍只回 success:false', /deprecated:\s*true/.test(oldRoute) && /success:\s*false/.test(oldRoute));

// ===== ③ 钱包/流水 =====
console.log('\n[3] 铜版钱包与流水');
ok('钱包余额只由 wallet 服务增减（beidou.js 不直接改 balance）',
  !/BeidouWallet\.updateOne[\s\S]{0,200}balance/.test(svc) && !/BeidouWallet\.findOneAndUpdate[\s\S]{0,200}balance/.test(svc));
ok('钱包有 CAS 扣款（balance 条件 + 保底计数同一次更新）',
  /balance:\s*\{\s*\$gte:\s*amount\s*\}/.test(walletSvc) && /\[lossField\]:\s*oldLosses/.test(walletSvc));
ok('流水幂等键 (openid, idemKey) 唯一',
  /index\(\{\s*openid:\s*1,\s*idemKey:\s*1\s*\},\s*\{\s*unique:\s*true\s*\}/.test(logModel));
ok('creditCoins 先写幂等流水再动余额', /const log = await writeLog[\s\S]{0,500}\$inc:\s*inc/.test(walletSvc));
ok('debitCoins 余额不足不写流水', /reason: 'insufficient'/.test(walletSvc));
ok('钱包余额默认 0、保底计数跨天保留', /balance:\s*\{\s*type:\s*Number,\s*default:\s*0\s*\}/.test(walletModel) && /wheelLosses/.test(walletModel));

// ===== ④ 封顶与保底 =====
console.log('\n[4] 封顶与保底');
ok('每日游戏铜版上限是唯一判定（gameCapRemaining）',
  /function gameCapRemaining\(day, cfg\)/.test(walletSvc) && /dailyGameCoinCap/.test(cfg));
ok('转盘 coin 奖受游戏上限约束，部分发放/降级',
  /applyWheelCaps/.test(svc) && /coinCap\.left/.test(svc));
ok('步数奖受 dailyStepsCap 约束并降级为空奖',
  /stepsCap\.cap && finalPrize\.amount > stepsCap\.left/.test(svc) && /dailyStepsCap/.test(cfg));
ok('九宫格同样走 coin/steps 双封顶', /applyGridCaps/.test(svc));
ok('两个玩法都有保底（连续未中到阈值必中）',
  /pickPityWheel/.test(svc) && /pickPityGrid/.test(svc) && /afterLosses/.test(cfg));
ok('保底进度与扣款同一次 CAS（不会并发写乱）',
  /luck\.\$\{game\}Losses|\[lossField\]/.test(walletSvc) && /nextLosses/.test(walletSvc));
ok('中奖后保底计数清零', /nextLosses = .*type === 'none' \? losses \+ 1 : 0/.test(svc));
ok('每日游戏铜版上限默认 200', /dailyGameCoinCap:\s*\{\s*type:\s*Number,\s*default:\s*200/.test(model));
ok('每日步数上限默认 3000', /dailyStepsCap:\s*\{\s*type:\s*Number,\s*default:\s*3000/.test(model));

// ===== ⑤ 九宫格 =====
console.log('\n[5] 九宫格连线');
ok('固定 8 条线（3 行 3 列 2 对角线）', /const LINES = \[/.test(gridSvc) && /row0/.test(gridSvc) && /diag1/.test(gridSvc));
ok('只把奖品符号成线算中奖（空白不算）', /sym\.type === SYMBOL_TYPE_NONE/.test(gridSvc));
ok('老虎机式随机盘面：按 weight 独立抽 9 格', /function drawBoard\(symbols/.test(gridSvc) && /pickWeighted/.test(gridSvc));
ok('多线/混合奖励由 evaluateBoard 统一统计', /function evaluateBoard\(board, symbols\)/.test(gridSvc) && /coinAmount/.test(gridSvc) && /stepsAmount/.test(gridSvc));
ok('盘面返回 9 格 + 中奖线 + 图标 URL', /BOARD_SIZE = 9/.test(gridSvc) && /boardCells/.test(gridSvc) && /iconUrl/.test(gridSvc));
ok('保底强制至少 1 线（pitySymbol）', /pitySymbol/.test(gridSvc));
ok('前端只做卷轴展示（停位=board、revealed/win 由服务端结果驱动）',
  /grid\.cells/.test(pageWxml) && /result\.board/.test(pageJs) && /finishGridReveal/.test(pageJs)
  && /board\[c \+ r \* 3\]/.test(pageJs));
{
  const buildReelsSrc = pageJs.slice(pageJs.indexOf('function buildReels'), pageJs.indexOf('function myMaskedName'));
  ok('卷轴装饰帧确定性循环（buildReels 零随机，反向断言）',
    buildReelsSrc.length > 0 && !/Math\.random/.test(buildReelsSrc));
}
ok('前端格子显示上传图标（iconUrl）', /iconUrl/.test(pageJs) && /item\.iconUrl/.test(pageWxml));
ok('铜版图标上传字段（coinIconUrl）', /coinIconUrl/.test(cfg) && /coinIconUrl/.test(readS('models/goal-config.js')));
ok('图案有单格权重 + 单线奖 + 图标 URL',
  /weight/.test(readS('models/goal-config.js')) && /iconUrl/.test(readS('models/goal-config.js')));
ok('上传用途 beidou（config.manage 可传）',
  /beidou: \['config\.manage'\]/.test(readS('routes/admin/upload.js'))
  && /'config\.manage'/.test(readS('routes/admin/index.js'))
  && /beidou/.test(readM('packageAdmin/files/files.js')));
ok('后台有图案上传/清除 + 铜版图标上传',
  /uploadSymbolIcon/.test(adminJs) && /uploadCoinIcon/.test(adminJs)
  && /uploadSymbolIcon/.test(adminWxml) && /uploadCoinIcon/.test(adminWxml));
ok('后台不再展示 v3 结果表（反向断言）',
  !/config\.beidou\.grid\.outcomes/.test(adminWxml) && !/onOutcomeField/.test(adminJs));

// ===== ⑥ 分享归因 =====
console.log('\n[6] 分享归因（好友点开才算）');
ok('分享令牌是 crypto.randomBytes 随机串', /crypto\.randomBytes\(16\)\.toString\('hex'\)/.test(svc));
ok('令牌模型 token 唯一 + owner+date 唯一', /token:.*unique: true/.test(shareLinkModel) && /ownerOpenid: 1, date: 1/.test(shareLinkModel));
ok('分享点击按 (owner,visitor,date) 唯一（同一好友每天一次）',
  /ownerOpenid: 1, visitorOpenid: 1, date: 1/.test(shareClickModel));
ok('自己点不算', /link\.ownerOpenid === openid/.test(svc) && /不能给自己助力/.test(svc));
ok('分享者每日上限', /share\.dailyLimit && rewarded >= cfg\.share\.dailyLimit/.test(svc));
ok('令牌过期拒绝', /expiresAt.*Date\.now\(\)/.test(svc) && /分享链接已过期/.test(svc));
ok('好友点击后才给分享者发铜版（share: 流水）', /source: 'share'/.test(svc) && /idemKey: `share:\$\{String\(click\._id\)\}`/.test(svc));
ok('前端分享路径带 bdshare 令牌', /share\.path|bdshare/.test(pageJs) && /bdshare/.test(shareUtil));
ok('前端不再调用旧 /share/report', !/\/api\/beidou\/share\/report/.test(pageJs));
ok('splash/app 捕获令牌（未登录也存）', /shareRef\.capture\(options\)/.test(splash) && /shareRef\.capture\(options\)/.test(appSrc));
ok('home 登录后 flush（且在 30 秒节流 return 之前）',
  /this\.flushShareRef\(\)/.test(home)
  && home.indexOf('this.flushShareRef()') < home.indexOf('HOME_REFRESH_MIN_GAP) return')
  && /shareRef\s*\.\s*flush\(\)/.test(home));

// ===== ⑦ 旧 API 保留 + 教师闸门 =====
console.log('\n[7] 旧 API 与教师闸门');
for (const p of ['/today', '/draw', '/video/report', '/checkin', '/share/report', '/winners']) {
  ok(`旧路径 ${p} 保留`, route.includes(`'${p}'`) || route.includes(`"${p}"`));
}
ok('新增 /grid/play', /router\.post\(\s*'\/grid\/play'/.test(route));
ok('新增 /share/intent 与 /share/click',
  /router\.post\(\s*'\/share\/intent'/.test(route) && /router\.post\(\s*'\/share\/click'/.test(route));
ok('所有写接口过 guardWrite',
  (route.match(/if \(!guardWrite\(req, res\)\) return;/g) || []).length >= 7);
ok('旧 today 兼容字段仍在（draw.remaining/prizes/sectors、video.drawPerWatch、share.drawPerShare）',
  /draw: \{[\s\S]{0,1200}remaining/.test(svc) && /drawPerWatch: 0/.test(svc) && /drawPerShare: 0/.test(svc));
ok('旧 /api/reward-video 仍挂载', /app\.use\('\/api\/reward-video'/.test(readS('app.js')));

// ===== ⑧ 管理端 =====
console.log('\n[8] 管理端');
ok('保存走 normalizeBeidouInput（钳位唯一实现）', /beidouSvc\.normalizeBeidouInput\(beidou\)/.test(adminCfg));
ok('GET 下发 beidouEffective + 可编辑 beidou', /out\.beidouEffective = await beidouSvc\.loadConfig\(\)/.test(adminCfg) && /toEditableConfig/.test(adminCfg));
ok('有预览接口（同一份归一/EV）', /router\.post\(\s*'\/beidou-preview'/.test(adminCfg) && /beidouSvc\.buildEffective\(norm\)/.test(adminCfg));
ok('中奖流水支持 game 筛选', /req\.query\.game/.test(adminCfg) && /facets:[\s\S]{0,400}game:/.test(adminCfg));
ok('铜版流水接口只读', /router\.get\(\s*'\/beidou-coin-logs'/.test(adminCfg) && !/router\.(put|post|delete)\(\s*'\/beidou-coin-logs'/.test(adminCfg));
ok('经济概览接口只读', /router\.get\(\s*'\/beidou-economy'/.test(adminCfg) && !/router\.(put|post|delete)\(\s*'\/beidou-economy'/.test(adminCfg));
ok('保存栏只给可写用户', /cfg-save-bar[^>]*wx:if="\{\{canManage\}\}"/.test(adminWxml));
ok('增删奖池/符号/结果都有 canManage 守卫',
  /addPrize[\s\S]{0,80}wx:if="\{\{canManage\}\}"/.test(adminWxml) || /wx:if="\{\{canManage\}\}"[\s\S]{0,120}bind:tap="addPrize"/.test(adminWxml));
ok('后台页有预览/流水/铜版/经济 Tab', /switchTab/.test(adminWxml) && /铜版流水/.test(adminWxml) && /经济概览|当前流通/.test(adminWxml));

// ===== ⑨ 纯函数 =====
console.log('\n[9] 纯函数行为');
try {
  const b = require(path.join(SERVER, 'services', 'beidou'));
  const p = b.normalizePrizes(null);
  const sum = Math.round(p.reduce((s, x) => s + x.percent, 0));
  ok('默认奖池概率合计 ≈ 100%', Math.abs(sum - 100) <= 1, sum);
  ok('默认奖池 8 项且含铜版奖', p.length === 8 && p.some((x) => x.type === 'coin'), p.map((x) => x.type));
  const sectors = b.buildSectors(p);
  ok('扇区数恒为 8', sectors.length === 8, sectors.length);
  ok('每个扇区都能对应到奖池项', sectors.every((k) => p.some((x) => x.key === k)));
  const fallback = b.normalizePrizes([{ key: 'a', type: 'none', weight: 0 }]);
  ok('权重全 0 → 回退默认奖池', fallback.length === b.DEFAULT_PRIZES.length, fallback.length);
  const e = b.buildEffective({});
  ok('默认转盘成本 5 / 九宫格成本 6', e.wheel.cost === 5 && e.grid.cost === 6, [e.wheel.cost, e.grid.cost]);
  ok('默认返奖率 < 100%（收益策略：返奖低于成本）', e.wheel.ev.returnRate < 100 && e.grid.ev.returnRate < 100, [e.wheel.ev, e.grid.ev]);
  ok('默认高价值奖占比 ≤ 10%', e.wheel.ev.highTierPercent <= 10 && e.grid.ev.highTierPercent <= 10);
  const g = require(path.join(SERVER, 'services', 'beidou-grid'));
  ok('默认九宫格期望线数 > 0', e.grid.ev.expectedLines > 0, e.grid.ev);
  // 全皇冠盘面：8 条线，奖励 = 8 × 单线奖
  const crown = e.grid.symbols.find((s) => s.key === 'crown');
  const crownBoard = Array(9).fill('crown');
  const full = g.evaluateBoard(crownBoard, e.grid.symbols);
  ok('9 格全皇冠 → 8 线', full.totalLines === 8, full.totalLines);
  ok('8 线奖励 = 8 × 单线奖', full.rewards[0] && full.rewards[0].amount === (crown.amount || 0) * 8, full.rewards);
  // 1 线皇冠 = 1 个单线奖；2 线 = 2 个
  const one = Array(9).fill('blank');
  [0, 1, 2].forEach((i) => { one[i] = 'crown'; });
  const oneEval = g.evaluateBoard(one, e.grid.symbols);
  ok('1 线皇冠 = 单线奖', oneEval.totalLines === 1 && oneEval.coinAmount === (crown.amount || 0), oneEval);
  const two = Array(9).fill('blank');
  [0, 1, 2, 3, 4, 5].forEach((i) => { two[i] = 'crown'; });
  const twoEval = g.evaluateBoard(two, e.grid.symbols);
  ok('2 线皇冠 = 单线奖 × 2', twoEval.totalLines === 2 && twoEval.coinAmount === (crown.amount || 0) * 2, twoEval);
  const norm = b.normalizeBeidouInput({
    wheel: { cost: -5, maxPerDay: 999999 },
    grid: { cost: 999999 },
    share: { dailyLimit: -1 },
    prizes: [{ key: 'x', type: 'coin', amount: 3, weight: 1 }],
  });
  ok('负数成本夹到 0', norm.wheel.cost === 0, norm.wheel.cost);
  ok('超大成本被夹紧', norm.grid.cost <= b.LIMITS.coinCost, norm.grid.cost);
  ok('负数分享上限夹到 0', norm.share.dailyLimit === 0, norm.share.dailyLimit);
} catch (e) {
  ok('service 可被 require 并跑通纯函数', false, e.stack || e.message);
}

// ===== ⑩ 文档 =====
console.log('\n[10] 文档与启动迁移');
ok('方案文档存在', fs.existsSync(path.join(__dirname, '..', 'docs', 'beidou-economy-plan.md')));
ok('docs/api.md 已补新接口', /\/api\/beidou/.test(fs.readFileSync(path.join(__dirname, '..', 'docs', 'api.md'), 'utf8')));
ok('index.js 启动期调用 migrateBeidouConfig', /migrateBeidouConfig/.test(indexJs));

// ===== ⑪ v4 修复（2026-11-25）：获奖概率口径 / 编辑不回写 / 露奖闸门 / 拉杆 =====
console.log('\n[11] v4 修复');
{
  const g = require('../server/src/services/beidou-grid.js');
  ok('lineWinProbability 已导出', typeof g.lineWinProbability === 'function');
  // 独立交叉核对：枚举 2^9 格子状态按 p^k(1-p)^(9-k) 加权，与容斥公式逐点比对
  const brute = (p) => {
    let sum = 0;
    for (let mask = 0; mask < 512; mask += 1) {
      const cells = [];
      let k = 0;
      for (let i = 0; i < 9; i += 1) {
        const on = (mask >> i) & 1;
        cells.push(on);
        k += on;
      }
      if (g.LINES.some((L) => L.cells.every((c) => cells[c] === 1))) sum += Math.pow(p, k) * Math.pow(1 - p, 9 - k);
    }
    return sum;
  };
  ok('获奖概率容斥 = 512 态枚举独立核对', [0.1, 0.3, 0.5, 0.9].every((p) => Math.abs(g.lineWinProbability(p) - brute(p)) < 1e-9));
  ok('反解往返：cellProbForWinProbability 单调可逆', [0.01, 0.05, 0.1727, 0.5, 0.9].every((q) => Math.abs(g.lineWinProbability(g.cellProbForWinProbability(q)) - q) < 1e-6));
  ok('normalizeSymbols 下发 winPercent（编辑态展示口径）', /winPercent:/.test(cfg) && /lineWinProbability/.test(cfg));
  // 目标概率模式：填 winTarget 反解权重，空白拿剩余；Σp>1 按比例缩放；权重模式不受影响
  const cfgSvc = require('../server/src/services/beidou-config.js');
  const tNorm = cfgSvc.normalizeBeidouInput({ grid: { symbols: [
    { key: 'star', label: '星星', type: 'coin', amount: 3, winTarget: '17.27' },
    { key: 'crown', label: '皇冠', type: 'coin', amount: 1, winTarget: '0.78' },
    { key: 'blank', label: '空白', type: 'none', amount: 0, weight: 30 },
  ] } });
  const tEff = cfgSvc.buildEffective(tNorm);
  const tStar = tEff.grid.symbols.find((s) => s.key === 'star');
  const tBlank = tEff.grid.symbols.find((s) => s.key === 'blank');
  ok('目标模式：winTarget 反解后实际获奖概率≈目标', Math.abs(tStar.winPercent - 17.27) < 0.01, tStar.winPercent);
  ok('目标模式：空白自动拿剩余概率', Math.abs(tBlank.percent - (100 - 30 - 10)) < 0.01, tBlank.percent);
  const sNorm = cfgSvc.normalizeBeidouInput({ grid: { symbols: [
    { key: 'a', label: 'A', type: 'coin', amount: 1, winTarget: '50' },
    { key: 'b', label: 'B', type: 'coin', amount: 1, winTarget: '50' },
    { key: 'c', label: 'C', type: 'coin', amount: 1, winTarget: '50' },
  ] } });
  const sEff = cfgSvc.buildEffective(sNorm);
  ok('目标合计超可实现范围按比例缩放（不静默丢符号）', sEff.grid.symbols.filter((s) => s.type !== 'none').every((s) => s.winPercent > 0 && s.winPercent < 50));
  ok('schema 放行 winTarget（否则保存被 stripped）', /winTarget: \{ type: String/.test(readS('models/goal-config.js')));
  ok('内置图标 seed 导出 + 启动调用 + 静态挂载 + 资源在仓库',
    /seedBeidouBuiltinIcons/.test(cfg) && /seedBeidouBuiltinIcons/.test(indexJs)
    && /'\/beidou'/.test(readS('app.js'))
    && ['crown.png', 'star.png', 'coin.png'].every((f) => fs.existsSync(path.join(SERVER, '..', 'public', 'beidou', f))));
  ok('seed 只补空不覆盖管理员上传', /if \(file && !s\.iconUrl\)/.test(cfg) && /if \(!b\.coinIconUrl\)/.test(cfg));
  const aJs = readM('packageAdmin/config/reward-video.js');
  const aWxml = readM('packageAdmin/config/reward-video.wxml');
  ok('编辑态展示单局获奖概率（不是单格出现率）', /单局获奖概率/.test(aWxml) && /winPercent/.test(aJs));
  ok('编辑框填获奖概率反解权重（winTarget 输入 + 服务端反解 + 空白剩余只读）',
    /data-key="winTarget"/.test(aWxml) && /key === 'winTarget'/.test(aJs) && /cellProbForWinProbability/.test(cfg) && /remainderText/.test(aWxml));
  const deco = aJs.slice(aJs.indexOf('\n  decorateConfig(effective)'), aJs.indexOf('\n  async fetchPreview('));
  ok('decorateConfig 派生字段点路径回写（不整数组替换 symbols/prizes）',
    deco.length > 0 && !/'config\.beidou\.grid\.symbols':/.test(deco) && !/'config\.beidou\.prizes':/.test(deco));
  const recalc = aJs.slice(aJs.indexOf('\n  recalcOdds()'), aJs.indexOf('\n  loadLogs(reset)'));
  ok('recalcOdds 不整数组回写 symbols（编辑中途不重置输入框）',
    recalc.length > 0 && !/'config\.beidou\.grid\.symbols':/.test(recalc));
  const onSym = aJs.slice(aJs.indexOf('onSymbolField(e)'), aJs.indexOf('addSymbol()'));
  ok('onSymbolField 点路径 + 权重/奖值保留原始字符串（空串/小数点不被强转 0）',
    /patch\[`\$\{base\}\.\$\{key\}`\]/.test(onSym) && /String\(value == null \? '' : value\)/.test(onSym) && !/\? 0 : Math\.max/.test(onSym));
  ok('中奖线胶囊停稳后才渲染（滚动中不剧透）',
    /bd-grid-lines" wx:if="\{\{grid\.lines\.length && !grid\.revealing\}\}/.test(pageWxml));
  ok('拉杆下压走常驻节点 transition（不是 class-add animation）',
    /\.bd-lever\.is-pulled[\s\S]{0,120}transform: translateY\(120rpx\)/.test(pageWxss) && !/bd-lever-pull/.test(pageWxss));
  ok('onLeverTap 与 SPIN 同入口（playGrid 守卫兜底竞态）', /onLeverTap\(\)/.test(pageJs) && /this\.playGrid\(\);/.test(pageJs));
}

console.log(failed ? `\n发现 ${failed} 个问题` : '\n北斗运动 3.0 静态契约全部通过');
process.exit(failed ? 1 : 0);
