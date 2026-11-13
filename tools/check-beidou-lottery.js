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
const pageWxss = readM('pages/reward/reward.wxss');
const pageSfx = readM('utils/sfx.js');
const adminWxml = readM('packageAdmin/config/reward-video.wxml');
const appSrc = readS('app.js');
// server/src/index.js：启动期迁移都挂在这里（score-scale / dorms / union / beidou）
const indexJs = readS('index.js');

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

// ===== ①b 抽奖页版式与音效的几个易回退点 =====
// 次数条早先是 `position:absolute; top:-52rpx` 压在转盘上方，正好叠在播报条上
// （用户截图里「刚抽中 100步」与「0 次可抽」两行字重在一起）。它本来就在盘上方，
// 绝对定位零收益高代价 —— 这里反向断言，防止有人再「顺手」改回去。
ok('次数条走正常文档流（不绝对定位压在播报条上）',
  /class="bd-stat"/.test(pageWxml) && !/class="bd-count"/.test(pageWxml) && !/\.bd-count\s*\{/.test(pageWxss));
// 转盘文字要正，必须同时满足三条（缺一条就是用户说的「乱」）：
//   ① 文字独立成层（放进 clip-path 扇形会被楔形边缘切掉一截）；
//   ② 径向排布 textDeg=±90（旋转对称 → 盘面停在任何角度都整齐）；
//   ③ 盘面转、指针固定（指针歪着停会让人以为坏了）
ok('扇区文字独立成层（不被 clip-path 楔形切掉）',
  /class="bd-label/.test(pageWxml) && /\.bd-label\s*\{/.test(pageWxss));
ok('文字单行径向（labelText + textDeg=±90）',
  /labelText/.test(pageJs) && /rotate\(\{\{item\.midDeg\}\}deg\)[^"]*rotate\(\{\{item\.textDeg\}\}deg\)/.test(pageWxml) &&
    /textDeg:\s*midDeg > 180 && midDeg < 360 \? 90 : -90/.test(pageJs));
ok('盘面旋转（rotateDeg 绑在 .bd-wheel 上）',
  /class="bd-wheel[^"]*"\s+style="transform: rotate\(\{\{rotateDeg\}\}deg\)/.test(pageWxml));
ok('指针固定不旋转（反向断言：指针上没有 rotate 内联样式）',
  /class="bd-pointer[^"]*"/.test(pageWxml) &&
    !/class="bd-pointer[^"]*"\s+style="transform:\s*rotate/.test(pageWxml));
// 签到格子必须写清「给什么」（早先只有一个「大」字）
ok('签到格子显示每日奖励（不是「大」字占位）',
  /rewardDrawText/.test(pageWxml) && /rewardStepsText/.test(pageJs) && !/item\.big \? '大'/.test(pageWxml));
// 中心按钮三态由 JS 预计算；「没次数」必须变成可点的下一步动作
ok('中心按钮文案由 JS 预计算（模板不写三元）', /centerMain/.test(pageWxml) && /function buildCenterState/.test(pageJs));
ok('没次数时中心是「赚次数」而不是死按钮',
  /main: '赚次数', sub: '去做任务'/.test(pageJs) && /bind:tap="tapCenter"/.test(pageWxml));
// 音效：管理端总开关必须真的拦播放（早先只进 data、从没被读过 = 假开关）
ok('sfxEnabled 真的拦住播放（不是只存进 data）',
  /const audio = this\.data\.sfxEnabled !== false;/.test(pageJs) && /if \(audio\) sfx\.play/.test(pageJs));
// iOS 上 3.2 秒后再 play 会被静默拦掉 —— 必须在点抽奖那一 tick 先响一声
ok('点抽奖时在手势栈里先发一声（解锁 iOS 音频）',
  /sfx\.play\('spin'\)/.test(pageJs) && /spin: 'bd_spin\.wav'/.test(pageSfx));
ok('音效失败后用户手动开音效可以重试一次', /function reset\(\)/.test(pageSfx) && /sfx\.reset && sfx\.reset\(\)/.test(pageJs));

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
// ⚠️ 这里必须钉成「(openid, drawId) 按人唯一」，不能只写「drawId 有唯一索引」：
//    旧实现是 drawId 全局唯一，两个用户撞出同一个 drawId 时，后来者会撞上别人的记录，
//    被幂等分支当成「重复提交」→ 返回**别人的奖品与 index**，自己次数不扣、步数不发，
//    而接口返回 success:true，日志里毫无痕迹。幂等的语义从来都是「同一个人同一笔」。
ok('drawId 唯一索引必须含 openid（按人隔离）',
  /index\(\{ openid: 1, drawId: 1 \}, \{ unique: true \}\)/.test(drawModel));
ok('禁止 drawId 全局唯一索引回潮（反向断言）',
  !/index\(\{\s*drawId:\s*1\s*\},\s*\{\s*unique:\s*true\s*\}\)/.test(drawModel));
ok('幂等查询带 openid（不能只按 drawId 查）',
  /BeidouDraw\.findOne\(\{ openid, drawId: nonce \}\)/.test(svc));
ok('幂等重放查询没有「只按 drawId」的写法（反向断言）',
  !/findOne\(\{ drawId: nonce \}\)/.test(svc));
ok('抽奖先查重复 drawId 并返回上次结果', /if \(dup\)[\s\S]{0,300}duplicated:\s*true/.test(svc));
ok('CAS 用 draw.used 做版本号', /'draw\.used':\s*day\.draw\.used/.test(svc));
ok('唯一键冲突时回滚已占用的次数', /'draw\.used':\s*-1/.test(svc));
ok('看视频 watchId 幂等（数组去重）', /video\.watchIds \|\| \[\]\)\.includes\(nonce\)/.test(svc));
ok('前端每次请求生成新的 nonce', /function makeNonce\(prefix\)/.test(pageJs));
// 索引换了必须显式迁移：Mongoose 只新建缺失索引，不会替换已存在的旧索引
ok('有 drawId 索引迁移函数', /async function migrateDrawIdIndex\(\)/.test(svc));
ok('迁移里显式 dropIndex 旧的全局 drawId_1', /dropIndex\('drawId_1'\)/.test(svc));
ok('index.js 启动期调用该迁移（与 dorms/union 同一模式）', /migrateDrawIdIndex/.test(indexJs));

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

// ===== ⑧b 来源口径文案必须单点（顺序改了两端不能撒谎）=====
console.log('\n[8b] 来源口径文案单点');
ok('来源中文文案在 service 里定义一份（SOURCE_TEXT）',
  /const SOURCE_TEXT = \{[\s\S]{0,200}prize: '再来一次'/.test(svc));
ok('service 导出 SOURCE_TEXT / sourceNote', /^\s+SOURCE_TEXT,$/m.test(svc) && /^\s+sourceNote,$/m.test(svc));
ok('口径整句由 SOURCE_ORDER 生成（顺序不会与代码脱节）',
  /SOURCE_ORDER\.map\(\(s\) => SOURCE_TEXT\[s\]\)\.join\(' → '\)/.test(svc));
ok('管理端路由不再自己写一份 SOURCE_TEXT（反向断言）',
  !/const SOURCE_TEXT = \{[\s\S]{0,160}video: '看视频'/.test(adminCfg));
ok('管理端下发的说明句取自 service', /sourceNote: cfgSvc\.sourceNote\(\)/.test(adminCfg));
ok('来源说明接口的 order/text 也取自 service',
  /order: svc\.SOURCE_ORDER/.test(adminCfg) && /text: svc\.SOURCE_TEXT/.test(adminCfg));
ok('页面不硬编码扣减优先级（反向断言）',
  !/再来一次 → 签到 → 看视频 → 邀请/.test(adminWxml));
ok('页面渲染服务端下发的 sourceNote', /\{\{sourceNote\}\}/.test(adminWxml));
ok('页面 data 有 sourceNote 初值（空则不显示，不编造）', /sourceNote: '',/.test(readM('packageAdmin/config/reward-video.js')));

// ===== ⑨ 中奖播报：脱敏 / 稀有度 / 隐私 =====
console.log('\n[9] 中奖播报（脱敏与稀有度）');
ok('姓名脱敏有唯一实现（services/name-mask.js）', fs.existsSync(path.join(SERVER, 'services', 'name-mask.js')));
ok('播报用 maskName，不下发完整姓名', /maskName\(u\.realName \|\| u\.nickname\)/.test(svc));
ok('播报字段名是 nameMasked（不是 realName/nickname）', /nameMasked:/.test(svc) && !/nameMasked:\s*u\.realName[^,]*,/.test(svc));
ok('不参与排名（exitRanking）的学生不进播报', /privacy\.exitRanking\) continue/.test(svc));
ok('封禁 / 教师账号不进播报', /u\.status === 'banned'\) continue/.test(svc) && /u\.role === 'teacher'\) continue/.test(svc));
ok('同一人最多占 2 条（防刷屏）', /cnt >= 2\) continue/.test(svc));
ok('谢谢参与不进播报', /type: \{ \$ne: 'none' \}/.test(svc));
ok('稀有度门槛是常量 10%（不是写死在 if 里）', /const RARE_PERCENT = 10;/.test(svc));
ok('rarest 要求「最小 percent 且 ≤10%」（奖池平时不会全员最稀有）',
  /pct <= minPct \+ 1e-9 && pct <= RARE_PERCENT/.test(svc));
ok('统计字段走服务端拼（atText / rarityText）', /atText: fmtClock/.test(svc) && /rarityText: buildRarityText/.test(svc));
ok('路由有 GET /winners', /router\.get\(\s*'\/winners'/.test(route));
ok('今天状态带 sfxEnabled（音效总开关）', /sfxEnabled: cfg\.sfxEnabled !== false/.test(svc));
ok('管理端可保存 sfxEnabled', /input\.sfxEnabled !== undefined/.test(svc));
// 历史 bug：recent 只下发 at（Date），WXML 渲染 atText → 时间列恒空
ok('recent 下发 atText（修历史 bug：时间列不再恒空）', /atText: fmtClock\(r\.createdAt\)/.test(svc));
ok('recent 下发 prizeLabel（前端不再自己拼奖品文案）', /prizeLabel: p\.label \|\|/.test(svc));

// ===== ⑩ 抽奖来源账本 + 管理端筛选（用户 2026-11-12）=====
console.log('\n[10] 抽奖来源账本与筛选');
ok('流水有 source 字段（账本归属）', /source:\s*\{\s*\n?\s*type:\s*String,/.test(drawModel));
ok('source 取值白名单含 video/share/checkin/prize/unknown',
  /'video',\s*'share',\s*'checkin',\s*'prize',\s*'unknown'/.test(drawModel));
ok('source 建了索引（管理端按来源筛）', /source:\s*1,\s*date:\s*-1/.test(drawModel));
ok('beidou_day 有各来源已用计数（usedVideo/usedShare/…）',
  /usedVideo:/.test(dayModel) && /usedShare:/.test(dayModel) && /usedCheckin:/.test(dayModel) && /usedPrize:/.test(dayModel));
ok('扣减优先级写死在代码里（prize → checkin → video → share）',
  /const SOURCE_ORDER = \['prize', 'checkin', 'video', 'share'\];/.test(svc));
ok('pickSource 是纯函数且导出', /function pickSource\(day\)/.test(svc) && /pickSource,/.test(svc));
ok('抽奖时**同一次原子更新**里扣 used 与来源账本（不能分两次写）',
  /\$inc: \{ 'draw\.used': 1, \.\.\.sourceInc \}/.test(svc));
ok('唯一键冲突回滚时来源账本也一起退（否则余额永久偏差）',
  /'draw\.used': -1, \.\.\.\(source === 'unknown' \? \{\} : \{ \[`draw\.\$\{SOURCE_USED_FIELD\[source\]\}`\]: -1 \}\)/.test(svc));
ok('历史数据对齐（老文档没有 used* 字段）', /async function alignLegacyUsage\(day\)/.test(svc));
ok('drawRound 抽奖前先对齐历史账本', /day = await alignLegacyUsage\(day\)/.test(svc));
// 管理端筛选
ok('管理端支持日期范围 dateFrom/dateTo', /cond\.date\.\$gte = from/.test(adminCfg) && /cond\.date\.\$lte = to/.test(adminCfg));
ok('日期倒序会自动纠正（不能骗管理员「筛了但没筛」）', /if \(from && to && from > to\) \[from, to\] = \[to, from\];/.test(adminCfg));
ok('管理端支持 source 筛选且校验白名单', /\[\'video\', \'share\', \'checkin\', \'prize\', \'unknown\'\]\.includes\(s\)/.test(adminCfg));
ok('分面计数排除 source 本身（否则选了视频只剩一项有数）', /delete facetBase\.source;/.test(adminCfg));
ok('来源中文文案由服务端下发（sourceText）', /sourceText: SOURCE_TEXT\[src\]/.test(adminCfg));
ok('明细下发 roll/index 留证字段', /roll: r\.roll,/.test(adminCfg) && /index: r\.index,/.test(adminCfg));
ok('有来源口径说明接口', /router\.get\(\s*'\/beidou-draws\/sources'/.test(adminCfg));
ok('页面筛选走服务端（把条件拼进 query）', /dateFrom=\$\{encodeURIComponent/.test(readM('packageAdmin/config/reward-video.js')));

// ===== ⑪ 纯函数行为断言（不连库，抓归一化/扇区的真错）=====
console.log('\n[11] 纯函数行为');
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

  // 稀有度三档 + 边界（这几条错一个就会「页面说稀有、播报说普通」）
  ok('rarest：最小 percent 且 ≤10%', b.rarityOf({ type: 'steps', percent: 2 }, p) === 'rarest', b.rarityOf({ type: 'steps', percent: 2 }, p));
  ok('rare：<10% 但不是最小', b.rarityOf({ type: 'steps', percent: 6 }, p) === 'rare', b.rarityOf({ type: 'steps', percent: 6 }, p));
  ok('normal：>=10%', b.rarityOf({ type: 'steps', percent: 30 }, p) === 'normal', b.rarityOf({ type: 'steps', percent: 30 }, p));
  ok('none：空奖不参与稀有度', b.rarityOf({ type: 'none' }, p) === 'none');
  const flat = [{ key: 'a', label: 'A', type: 'steps', percent: 25 }, { key: 'b', label: 'B', type: 'steps', percent: 25 }];
  ok('奖池很平时（最小 25%）不算 rarest', b.rarityOf(flat[0], flat) === 'normal', b.rarityOf(flat[0], flat));
  ok('rarityText 含最低与最高概率', /最低概率奖/.test(b.buildRarityText(p)) && /最高/.test(b.buildRarityText(p)));

  // 脱敏：唯一实现的行为
  const { maskName } = require(path.join(SERVER, 'services', 'name-mask'));
  ok('张三丰 → 张**', maskName('张三丰') === '张**', maskName('张三丰'));
  ok('陈宇航 → 陈**', maskName('陈宇航') === '陈**', maskName('陈宇航'));
  ok('单字名「李」→ 李*', maskName('李') === '李*', maskName('李'));
  ok('空名 → 匿名同学', maskName('') === '匿名同学', maskName(''));
  ok('脱敏后不含原名的第 2 个字（不可反推）', !maskName('陈宇航').includes('宇'));

  // 来源判定：优先级与余额（这几条错一个，管理端来源统计就整片失真）
  const mk = (o) => ({ draw: Object.assign(
    { fromPrize: 0, fromCheckin: 0, fromVideo: 0, fromShare: 0, usedPrize: 0, usedCheckin: 0, usedVideo: 0, usedShare: 0 },
    o
  ) });
  ok('只有 video 有余额 → video', b.pickSource(mk({ fromVideo: 2 })) === 'video');
  ok('checkin 优先于 video', b.pickSource(mk({ fromVideo: 2, fromCheckin: 1 })) === 'checkin');
  ok('prize（再来一次）优先级最高', b.pickSource(mk({ fromPrize: 1, fromCheckin: 5, fromVideo: 5 })) === 'prize');
  ok('video 优先于 share', b.pickSource(mk({ fromVideo: 1, fromShare: 1 })) === 'video');
  ok('余额用尽 → unknown（不瞎归到一个来源）', b.pickSource(mk({ fromVideo: 2, usedVideo: 2 })) === 'unknown');
  ok('部分消耗后继续扣剩余', b.pickSource(mk({ fromVideo: 2, usedVideo: 1 })) === 'video');
  ok('老数据（无 used* 字段）按 from 计', b.pickSource({ draw: { fromVideo: 1 } }) === 'video');
} catch (e) {
  ok('service 可被 require 并跑通纯函数', false, e.message);
}

console.log(failed ? `\n发现 ${failed} 个问题` : '\n北斗运动 2.0 静态契约全部通过');
process.exit(failed ? 1 : 0);
