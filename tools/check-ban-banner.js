/**
 * 静态检查：首页封禁公告条（用户 2026-11-02「如果用户被封禁应该在首页中的公告栏中显示，
 * 并闪烁红色警告状态，点击可以进入详细并申诉等」）
 *
 * 为什么单独一个检查器：这四条失败模式**全是静默的**，现有检查器一条都抓不到 ——
 *   ① 封禁条没渲染 / 不在公告栏位置 → 页面正常，只是用户永远不知道被封了；
 *   ② 没有闪烁动画 → 静态红条，等于没实现「闪烁红色警告状态」；
 *   ③ 点击不进详情、详情页没有申诉入口 → 提示了但没法办；
 *   ④ 详情页自己映射一份「人封/AI封/机封」文案 → 与服务端 SOURCE_TEXT 漂移（AGENTS.md 明确禁止）。
 *
 * 运行：node tools/check-ban-banner.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let failed = 0;
function ok(name, cond, detail) {
  console.log(`${cond ? '  ok   ' : '  FAIL '}${name}${cond ? '' : '  -> ' + JSON.stringify(detail)}`);
  if (!cond) failed += 1;
}

const HOME_WXML = read('miniprogram', 'pages', 'home', 'home.wxml');
const HOME_WXSS = read('miniprogram', 'pages', 'home', 'home.wxss');
const HOME_JS = read('miniprogram', 'pages', 'home', 'home.js');
const BANNED_WXML = read('miniprogram', 'pages', 'banned', 'banned.wxml');
const BANNED_JS = read('miniprogram', 'pages', 'banned', 'banned.js');
const BAN_MODEL = read('server', 'src', 'models', 'ban-record.js');
const AC_SVC = read('server', 'src', 'services', 'anticheat.js');
const APPEAL_ROUTE = read('server', 'src', 'routes', 'appeal.js');
const AUTH_MW = read('server', 'src', 'middlewares', 'auth.js');

// ===== 1) 首页公告栏位置 + 渲染条件 + 点击进详情 =====
console.log('[1] 首页公告条');
// 位置：必须排在普通公告条（notice-bar）之前 —— 封禁是账号级状态，优先级高于公告
const banIdx = HOME_WXML.indexOf('class="ban-banner');
const noticeIdx = HOME_WXML.indexOf('class="notice-bar');
ok('首页有封禁公告条', banIdx >= 0, banIdx);
ok('封禁条排在普通公告条之前', banIdx >= 0 && noticeIdx > banIdx, { banIdx, noticeIdx });
ok('封禁条按 banned 渲染', /wx:if="\{\{banned\}\}"/.test(HOME_WXML.slice(banIdx, banIdx + 400)));
ok('封禁条点击进封禁详情页', /bind:tap="goBanned"/.test(HOME_WXML.slice(banIdx, banIdx + 400)));
ok('goBanned 指向 /pages/banned/banned', /goBanned\(\)[\s\S]{0,120}\/pages\/banned\/banned/.test(HOME_JS));

// ===== 2) 闪烁红色警告 =====
console.log('\n[2] 闪烁红色警告态');
ok('封禁条带 alert 类（触发动画）', /class="ban-banner ban-banner-alert/.test(HOME_WXML));
ok('WXSS 定义了 ban-pulse 关键帧', /@keyframes ban-pulse[\s\S]*?\}/.test(HOME_WXSS));
ok('alert 类真的挂了动画', /\.ban-banner-alert[\s\S]{0,160}animation:\s*ban-pulse/.test(HOME_WXSS));
ok('红色系（品牌色之外的 error 语义）', /#e5484d|--td-error-color/.test(HOME_WXSS.slice(HOME_WXSS.indexOf('.ban-banner'), HOME_WXSS.indexOf('.ban-banner') + 1200)));
// 闪烁不能动 opacity：会把文字一起闪淡（红底白字会短暂读不清）
const pulseSeg = (HOME_WXSS.match(/@keyframes ban-pulse[\s\S]*?\n\}/) || [''])[0];
ok('闪烁只动阴影 / 背景，不动 opacity', !/opacity/.test(pulseSeg), pulseSeg.slice(0, 200));

// ===== 3) 文案与分类都来自服务端 =====
console.log('\n[3] 文案单点（分类不猜）');
ok('home.js 有 buildBanNotice', /function buildBanNotice/.test(HOME_JS));
ok('优先用服务端 sourceText', /sourceText/.test((HOME_JS.match(/function buildBanNotice[\s\S]*?\n\}/) || [''])[0]));
ok('封禁时才拉两接口（未封禁不白拉）', /if \(banned\) \{[\s\S]{0,400}\/api\/appeals\/restrictions/.test(HOME_JS));
ok('两接口失败不拖垮首页（allSettled/catch）', /Promise\.allSettled\(/.test(HOME_JS.slice(HOME_JS.indexOf('if (banned) {'))));
// 申诉进度：已提交待审核时要显式说明（否则用户会反复点申诉再被拒）
ok('文案含「申诉已提交」分支', /申诉已提交/.test(HOME_JS));
// 服务端必须真的下发 sourceText（否则前端只能退回兜底）
ok('activeRestrictions 下发 sourceText', /sourceText:\s*textOf/.test(AC_SVC));
ok('SOURCE_TEXT 仍是唯一定义处', /SOURCE_TEXT/.test(BAN_MODEL) && /SOURCE_TEXT\[src\]/.test(AC_SVC));

// ===== 4) 详情页：限制/分类/到期/申诉入口齐全 =====
console.log('\n[4] 封禁详情页');
ok('详情页拉生效限制（不只是 me）', /\/api\/appeals\/restrictions/.test(BANNED_JS));
ok('详情页拉申诉进度', /\/api\/appeals\/mine/.test(BANNED_JS));
ok('详情页展示每条限制的分类', /item\.sourceText/.test(BANNED_WXML));
ok('有待审核申诉时主按钮改「查看进度」', /wx:if="\{\{!appealPending\}\}"[^>]*bind:tap="goSubmit"[\s\S]{0,200}wx:else bind:tap="goList"/.test(BANNED_WXML));
ok('仍可提交申诉（scope=login）', /goSubmit\(\)[\s\S]{0,140}scope=login/.test(BANNED_JS));
ok('申诉回复字段用 reply（模型里就是 reply，不是 reviewResult）', /latestAppeal\.reply/.test(BANNED_WXML) && !/reviewResult/.test(BANNED_WXML));

// ===== 5) 封禁用户真的能调这些接口（否则详情页全空）=====
console.log('\n[5] 被封禁账号仍可访问（白名单）');
ok('BANNED_ALLOW 含 /api/appeals', /BANNED_ALLOW = \[[\s\S]{0,200}\/api\/appeals/.test(AUTH_MW));
ok('申诉列表/详情都在 /api/appeals 下', /router\.get\(\s*'\/restrictions'/.test(APPEAL_ROUTE) && /router\.get\(\s*'\/mine'/.test(APPEAL_ROUTE));

console.log(failed ? `\n失败 ${failed} 项` : '\n封禁公告条校验通过');
process.exit(failed ? 1 : 0);
