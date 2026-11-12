/**
 * 检查器：北斗运动 2.0（签到 + 转盘抽步数 + 看视频/分享得次数）的静态契约。
 *
 * 方案与口径的唯一说明：docs/beidou-lottery-plan.md。本文件盯的是**改完之后最容易静默坏掉**的几条：
 *
 *   ① 抽奖结果只由服务端定（roll / index / prize 全在 service 里算）；
 *      前端不得自己排扇区、不得用「停位对应的前端数组项」当结果 —— 那会出现「停在 A 却发 B」。
 *   ② 概率公示必须由服务端算（percent 字段），前端只展示：自己算会与配置漂移。
 *   ③ 奖池非法（权重全 0 / 全删）必须回退默认奖池，不能变成「保存成功但没人能中奖」。
 *   ④ 每日步数封顶是**唯一成本闸门**（用户 2026-11-11 定了「次数不限 + 点分享即给」）：
 *      抽奖与签到都必须过 capRemaining，且封顶时步数奖降级为空奖（不是报错）。
 *   ⑤ 幂等靠 drawId 唯一索引（弱网重试/连点），不能只靠 if 判断。
 *   ⑥ 教师四处（抽奖/看视频/分享/签到）都要拦；旧 /api/reward-video/report 必须不再发步数。
 *   ⑦ 断签必须重置（streak 按昨天推），不能用累计天数。
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
const route = readS('routes/beidou.js');
const oldRoute = readS('routes/reward-video.js');
const adminCfg = readS('routes/admin/config.js');
const model = readS('models/goal-config.js');
const dayModel = readS('models/beidou-day.js');
const drawModel = readS('models/beidou-draw.js');
const pageJs = readM('pages/reward/reward.js');
const pageWxml = readM('pages/reward/reward.wxml');
const adminWxml = readM('packageAdmin/config/reward-video.wxml');
const appSrc = readS('app.js');

// ===== ① 结果只由服务端定 =====
console.log('[1] 抽奖结果只由服务端定');
ok('服务端用 crypto.randomInt 生成随机数（不用 Math.random）', /crypto\.randomInt\(/.test(svc) && !/Math\.random\(\).*roll/.test(svc));
ok('pickPrize 在服务端按权重求命中项', /function pickPrize\(prizes, sectors, roll\)/.test(svc));
ok('service 下发 index（前端只做停位）', /index,/.test(svc) && /sectors/.test(svc));
ok('前端不自己排扇区顺序（sectors 直接来自接口）', /data\.draw\.sectors/.test(pageJs));
ok('前端停位角度用 DEG_PER_SECTOR 常量（不是硬编码 45/22.5）',
  /centerDeg = safeIndex \* DEG_PER_SECTOR \+ DEG_PER_SECTOR \/ 2/.test(pageJs));
ok('前端展示的是服务端下发的 prize（不是停位数组项）',
  /const p = result\.prize \|\| \{\}/.test(pageJs));
ok('前端有 transitionend 收口 + 兜底定时器（低端机不卡死）',
  /bind:transitionend="onSpinEnd"/.test(pageWxml) && /_spinTimer = setTimeout\(finish/.test(pageJs));

// ===== ② 概率公示由服务端算 =====
console.log('\n[2] 概率公示');
ok('normalizePrizes 产出 percent 字段', /percent:\s*Math\.round\(/.test(svc));
ok('前端只拼字符串、不自己算百分比', /function buildOddsText\(prizes\)/.test(pageJs) && /p\.percent/.test(pageJs));
ok('前端没有把 weight 直接除以总权重算公示', !/\/\s*total\s*\*\s*100/.test(pageJs));
ok('用户端规则区展示 oddsText', /oddsText/.test(pageWxml));
ok('管理端也显示归一后概率（percentText）', /percentText/.test(readM('packageAdmin/config/reward-video.js')));

// ===== ③ 非法奖池回退默认 =====
console.log('\n[3] 奖池非法回退');
ok('空奖池/全非法 → 回退 DEFAULT_PRIZES', /if \(!out\.length\) return normalizePrizes\(DEFAULT_PRIZES\)/.test(svc));
ok('weight <= 0 的项被剔除（不会画出永远抽不到的扇区）', /if \(!weight\) continue/.test(svc));
ok('step 奖 amount = 0 被剔除', /amount = clampInt\(p\.amount, LIMITS\.prizeSteps, 1\) \|\| 0;/.test(svc));
ok('奖项数上限 8（扇区数）', /prizeCount:\s*8/.test(svc));
ok('扇区固定 8 格', /SECTOR_COUNT = 8/.test(svc));

// ===== ④ 每日步数封顶（唯一成本闸门）=====
console.log('\n[4] 每日步数封顶');
ok('capRemaining 是唯一封顶判定', /function capRemaining\(day, cfg\)/.test(svc));
ok('抽奖的步数奖过封顶并降级为空奖', /if \(cap\.cap && prize\.amount > cap\.left\)/.test(svc));
ok('降级时把 index 也改成空奖所在扇区（否则停位与结果不符）',
  /const hit = cfg\.sectors\.indexOf\(nonePrize\.key\);[\s\S]{0,80}index = hit >= 0 \? hit /.test(svc));
ok('奖池里没有 none 项时**合成**一个 0 步空奖来降级（否则封顶是假的）',
  /find\(\(p\) => p\.type === 'none'\) \|\| \{[\s\S]{0,160}type: 'none'/.test(svc));
ok('降级记 capped 标记（前端可提示，不报错）', /capped: true|draw\.capped/.test(svc));
ok('签到步数同样过 capRemaining（不另开额度）',
  /const cap = capRemaining\(day, cfg\);[\s\S]{0,200}steps = Math\.max\(0, Math\.min\(steps, cap\.left\)\)/.test(svc));
ok('发步数时累加 draw.stepsAwarded', /'draw\.stepsAwarded'/.test(svc));
ok('默认封顶 3000 步', /dailyStepsCap:\s*\{\s*type:\s*Number,\s*default:\s*3000/.test(model));
ok('前端在封顶时有提示文案', /capText/.test(pageJs) && /capText/.test(pageWxml));

// ===== ⑤ 幂等 =====
console.log('\n[5] 幂等（drawId / watchId）');
ok('drawId 有唯一索引', /drawId:\s*1\s*\}\s*,\s*\{\s*unique:\s*true/.test(drawModel));
ok('抽奖先查重复 drawId 并返回上次结果', /if \(dup\)[\s\S]{0,300}duplicated:\s*true/.test(svc));
ok('CAS 用 draw.used 做版本号', /'draw\.used':\s*day\.draw\.used/.test(svc));
ok('唯一键冲突时回滚已占用的次数', /\$inc:\s*\{\s*'draw\.used':\s*-1\s*\}/.test(svc));
ok('看视频 watchId 幂等（数组去重）', /video\.watchIds \|\| \[\]\)\.includes\(nonce\)/.test(svc));
ok('前端每次请求生成新的 nonce', /function makeNonce\(prefix\)/.test(pageJs));

// ===== ⑥ 教师拦截 + 旧接口降级 =====
console.log('\n[6] 教师拦截与旧接口');
ok('routes/beidou 有 guardWrite 统一闸门', /function guardWrite\(req, res\)/.test(route));
ok('guardWrite 里有 isTeacher 判定', /stepsSvc\.isTeacher\(req\.user\)/.test(route));
ok('四个写接口都过 guardWrite', (route.match(/if \(!guardWrite\(req, res\)\) return;/g) || []).length >= 4);
ok('抽奖接口也过 sync 限制（403004）', /anticheat\.activeRestriction\(req\.user, 'sync'\)/.test(route));
ok('旧 /api/reward-video/report 只回 success:false', /deprecated:\s*true/.test(oldRoute) && /success:\s*false/.test(oldRoute));
ok('旧接口不再调用 reportRewardVideo（不再发步数）', !/reportRewardVideo\(/.test(oldRoute));
ok('app.js 挂载了 /api/beidou', /app\.use\('\/api\/beidou'/.test(appSrc));

// ===== ⑦ 断签重置 =====
console.log('\n[7] 签到断签重置');
ok('streak 按昨天是否签到推（不是累计天数）',
  /const yStreak = yDoc && yDoc\.checkin && yDoc\.checkin\.done \? yDoc\.checkin\.streak \|\| 0 : 0;/.test(svc));
ok('streak = 昨天 + 1', /const streak = yStreak \+ 1;/.test(svc));
ok('并发重复签到用 checkin.done:false 做条件', /'checkin\.done':\s*false/.test(svc));
ok('签到模型 openid+date 唯一', /beidouDaySchema\.index\(\{ openid: 1, date: 1 \}, \{ unique: true \}\)/.test(dayModel));

// ===== ⑧ 管理端 / 文档接线 =====
console.log('\n[8] 管理端与文档');
ok('管理端保存走 normalizeBeidouInput（钳位唯一实现）',
  /beidouSvc\.normalizeBeidouInput\(beidou\)/.test(adminCfg));
ok('管理端 GET 下发 beidouEffective', /out\.beidouEffective = await beidouSvc\.loadConfig\(\)/.test(adminCfg));
ok('中奖记录接口只读（只有 GET）', /router\.get\(\s*'\/beidou-draws'/.test(adminCfg) && !/router\.(put|post|delete)\(\s*'\/beidou-draws'/.test(adminCfg));
ok('管理端保存栏只给可写用户', /cfg-save-bar[^>]*wx:if="\{\{canManage\}\}"/.test(adminWxml));
ok('管理端奖池可增删（有 addPrize / removePrize）',
  /addPrize\(\)/.test(readM('packageAdmin/config/reward-video.js')) && /removePrize\(e\)/.test(readM('packageAdmin/config/reward-video.js')));
const plan = path.join(__dirname, '..', 'docs', 'beidou-lottery-plan.md');
ok('方案文档存在', fs.existsSync(plan));
const apiDoc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'api.md'), 'utf8');
ok('docs/api.md 已补 /api/beidou', /\/api\/beidou/.test(apiDoc));

// ===== ⑨ 纯函数行为断言（不连库，抓归一化/扇区的真错）=====
console.log('\n[9] 纯函数行为');
try {
  const b = require(path.join(SERVER, 'services', 'beidou'));
  const p = b.normalizePrizes(null);
  const sum = Math.round(p.reduce((s, x) => s + x.percent, 0));
  ok('默认奖池概率合计 ≈ 100%', Math.abs(sum - 100) <= 1, sum);
  const sectors = b.buildSectors(p);
  ok('扇区数恒为 8', sectors.length === 8, sectors.length);
  ok('每个扇区都能对应到奖池项', sectors.every((k) => p.some((x) => x.key === k)));
  // 权重全 0 必须回退默认，而不是返回空
  const fallback = b.normalizePrizes([{ key: 'a', type: 'none', weight: 0 }]);
  ok('权重全 0 → 回退默认奖池', fallback.length === b.DEFAULT_PRIZES.length, fallback.length);
  // roll 边界：0 命中第一项，1 命中最后一项（不能出现 undefined）
  const first = b.pickPrize(p, sectors, 0);
  const last = b.pickPrize(p, sectors, 0.999999);
  ok('roll=0 命中有效奖池项', !!first.prize && !!first.prize.key, first.prize);
  ok('roll≈1 命中有效奖池项', !!last.prize && !!last.prize.key, last.prize);
  ok('index 落在 0..7', first.index >= 0 && first.index < 8 && last.index >= 0 && last.index < 8);
  // pickPrize 的 index 必须指向「该奖所在的扇区」，否则停位会错
  ok('index 指向的扇区就是命中的奖', sectors[first.index] === first.prize.key);
  // 归一化输入：越界夹紧、非数字不落
  const norm = b.normalizeBeidouInput({ draw: { maxPerDay: -5, dailyStepsCap: 999999 }, prizes: [{ key: 'x', type: 'steps', amount: 3, weight: 1 }] });
  ok('负数 maxPerDay 夹到 0', norm.draw.maxPerDay === 0, norm.draw.maxPerDay);
  ok('超大 dailyStepsCap 被夹紧', norm.draw.dailyStepsCap <= b.LIMITS.dailyStepsCap, norm.draw.dailyStepsCap);
} catch (e) {
  ok('service 可被 require 并跑通纯函数', false, e.message);
}

console.log(failed ? `\n发现 ${failed} 个问题` : '\n北斗运动 2.0 静态契约全部通过');
process.exit(failed ? 1 : 0);
