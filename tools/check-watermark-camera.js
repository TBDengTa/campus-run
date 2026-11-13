/**
 * 静态检查：考勤录入水印相机（docs/watermark-camera-plan.md，2026-11-13 定稿）
 *
 * 为什么单独一个检查器：这些失败模式**全是静默的**，现有检查器一条都抓不到 ——
 *   ① 预览浮层与 canvas 烙图各拼一份文案 → 「预览写着 A、照片烙着 B」（plan §5.2 红线）；
 *   ② 合成参数被改（png / quality<1 / 降采样变压缩）→ 「解除上传限制」被静默回潮；
 *   ③ entry 忘了给合成产物补 size → 失败兜底「<2MB 跳过压缩」把 size=0 全跳过，
 *      压缩重试通道静默失效（plan §5.3）；
 *   ④ 相机页一旦发起网络请求 → 弱网/离线拍不了（D9 被破坏）；
 *   ⑤ 时间字符串从 ISO 串切片 → 北京时区错位（AGENTS.md 既有红线，format.js 事故）；
 *   ⑥ 部门名前端自算 → 与 /api/union/mine 下发值漂移（AGENTS.md「文案单点」同款教训）。
 *
 * 运行：node tools/check-watermark-camera.js
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

const WM_UTIL = read('miniprogram', 'utils', 'watermark.js');
const FORMAT = read('miniprogram', 'utils', 'format.js');
const WCAM_JS = read('miniprogram', 'packageUnion', 'wcamera', 'wcamera.js');
const WCAM_WXML = read('miniprogram', 'packageUnion', 'wcamera', 'wcamera.wxml');
const WCAM_JSON = read('miniprogram', 'packageUnion', 'wcamera', 'wcamera.json');
const WCAM_WXSS = read('miniprogram', 'packageUnion', 'wcamera', 'wcamera.wxss');
const ENTRY_JS = read('miniprogram', 'packageUnion', 'entry', 'entry.js');
const ENTRY_WXML = read('miniprogram', 'packageUnion', 'entry', 'entry.wxml');
const ENTRY_WXSS = read('miniprogram', 'packageUnion', 'entry', 'entry.wxss');
const REQUEST_JS = read('miniprogram', 'utils', 'request.js');
const APP_JSON = JSON.parse(read('miniprogram', 'app.json'));

// ===== 1) 文案与版式单点 =====
console.log('[1] 文案与版式单点（plan §5.2）');
ok('utils/watermark.js 有 buildLines（唯一拼装点）', /function buildLines\(/.test(WM_UTIL));
ok('utils/watermark.js 有 computeLayout（版式唯一实现）', /function computeLayout\(/.test(WM_UTIL));
ok('utils/watermark.js 有 wrapText（canvas 折行唯一实现）', /function wrapText\(/.test(WM_UTIL));
ok('buildLines 行2 走 formatWatermarkTime（不切片）', /formatWatermarkTime\(/.test(WM_UTIL));
ok('行3 = 部门 · 姓名（deptName 缺失只写姓名）', /\[clean\(src\.deptName\),\s*clean\(src\.userName\)\]/.test(WM_UTIL));
ok('wcamera.js require utils/watermark', /require\('\.\.\/\.\.\/utils\/watermark'\)/.test(WCAM_JS));
ok('wcamera.js 烙图用 buildLines', /wmUtil\.buildLines\(/.test(WCAM_JS));
ok('wcamera.js 折行用 wrapText（不自写测量）', /wmUtil\.wrapText\(/.test(WCAM_JS) && !/measureText[\s\S]{0,40}for\s*\(/.test(WCAM_JS.replace(/wmUtil\.wrapText[\s\S]*?\n  \}/, '')));
// 实时浮层的行必须来自 buildLines（preview 与烙图同源）
ok('实时浮层 refreshLive 用 buildLines', /refreshLive\(\)[\s\S]{0,160}wmUtil\.buildLines\(/.test(WCAM_JS));
// buildLines 缺省路径：无模块/对象时行1 兜底「检查留证」，不能空串（空水印=没实现）
ok('行1 缺省兜底「检查留证」', /检查留证/.test(WM_UTIL));
// 相机页 WXML 浮层三行绑定 live.*
ok('浮层绑定 live.line1/2/3', /live\.line1/.test(WCAM_WXML) && /live\.line2/.test(WCAM_WXML) && /live\.line3/.test(WCAM_WXML));
// 反向断言：entry 不自己拼水印文案（部门名拼装只许在 watermark.js）
ok('entry.js 不 require watermark（拼装单点在 util）', !/utils\/watermark/.test(ENTRY_JS));

// ===== 2) 合成成片规格（round2 定稿：体积闭环根治「拍照后上传失败」）=====
console.log('\n[2] 成片规格（2560/q0.92 + 8MB 闭环）与上传通道');
ok('输出 jpg', /fileType:\s*'jpg'/.test(WCAM_JS));
ok('OUT_ATTEMPTS 阶梯（2560/0.92 → 2048/0.85 → 2048/0.75）', /OUT_LONG_EDGE = 2560/.test(WM_UTIL) && /OUT_QUALITY = 0\.92/.test(WM_UTIL) && /longEdge: 2048, quality: 0\.85/.test(WM_UTIL) && /quality: 0\.75/.test(WM_UTIL));
ok('预算红线 OUT_MAX_BYTES = 8MB', /OUT_MAX_BYTES = 8 \* 1024 \* 1024/.test(WM_UTIL));
ok('输出 quality 用阶梯值（不是写死 1.0）', /canvasToTempFile\(canvas, quality\)/.test(WCAM_JS) && !/quality:\s*1[,}]/.test(WCAM_JS));
ok('体积闭环：按实际文件大小降档（fileSizeOf + OUT_MAX_BYTES）', /function fileSizeOf/.test(WCAM_JS) && /size <= wmUtil\.OUT_MAX_BYTES/.test(WCAM_JS));
ok('最后一档无条件接受（再往上还有上传侧压缩重试兜底）', /i === wmUtil\.OUT_ATTEMPTS\.length - 1/.test(WCAM_JS));
ok('画布失败也降下一档（更小画布）', /OUT_ATTEMPTS\.length && !outPath/.test(WCAM_JS));
ok('解码只一次、降档复用（不重复花 1~2 秒解 12MP）', /onDecoded/.test(WCAM_JS));
ok('uploadCheckPhoto 显式 timeout 120s（默认 60s 是弱网超时根因之一）', /timeout:\s*120000/.test(REQUEST_JS));
// ---- 成片像素必须 1:1 钉死（2026-11-13「水印照片又传不上去」的真根因）----
// canvasToTempFilePath 的 destWidth/destHeight **默认 = 区域尺寸 × 屏幕像素密度**，
// 不传就是在画布尺寸上再乘一次 DPR（常见 3 倍）：2560 宽 → 实际输出 7680 宽（44MP）
// → q0.92 成片几十 MB → wx.uploadFile 失败。且每一档都超预算，闭环降到最后一档被无条件接受，
// 于是「明明在降档、照片还是传不上去」—— 第二轮只改了 quality/长边，没管导出像素数。
const EXPORT_SEG = (WCAM_JS.match(/function canvasToTempFile[\s\S]*?\n\}/) || [''])[0];
ok('导出显式给 destWidth/destHeight（防 DPR 把成片放大 3 倍）', /destWidth:/.test(EXPORT_SEG) && /destHeight:/.test(EXPORT_SEG), EXPORT_SEG);
ok('dest 尺寸取自画布本身（1:1，不会与绘制尺寸漂移）', /canvas\.width/.test(EXPORT_SEG) && /canvas\.height/.test(EXPORT_SEG) && !/destWidth:\s*(\d+)/.test(EXPORT_SEG), EXPORT_SEG);
// ⚠️ 反向断言：**不许**传 x/y/width/height 区域参数。区域默认就是「整块画布」
//（packageAdmin/class-status 的分享图同样不传区域、导出完整画布，现网已验证），
// 而部分机型把这几个参数按 canvas 的 **CSS 尺寸**解释（本页离屏画布 CSS 只有 320×240）
// —— 传了可能只导出左上角一小块，且「照片变小了」比「照片糊了一半」更容易被误判成画质问题。
ok('不传区域参数（防机型按 CSS 尺寸解释 → 只导出左上角）', !/\bx:\s*0/.test(EXPORT_SEG) && !/\by:\s*0/.test(EXPORT_SEG) && !/^\s*width:/m.test(EXPORT_SEG) && !/^\s*height:/m.test(EXPORT_SEG), EXPORT_SEG);
// 体积闭环 fail-open 回归：旧版 `!size → 接受` 让 getFileInfo 一失败就放行超大第一档成片
const LOOP_SEG = (WCAM_JS.match(/for \(let i = 0; i < wmUtil\.OUT_ATTEMPTS[\s\S]*?\n      \}/) || [''])[0];
ok('体积闭环不再 fail-open（size=0 不算通过，必须 size>0 才接受）', /size > 0 && size <= wmUtil\.OUT_MAX_BYTES/.test(LOOP_SEG) && !/if \(!size \|\|/.test(LOOP_SEG), LOOP_SEG);
ok('降档途中出错仍保留已产出的带水印成片（不白合成、也不退回无水印原图）', /lastProduced/.test(WCAM_JS) && /if \(!outPath\) outPath = lastProduced/.test(WCAM_JS));
// ---- 合成产物必须落盘到用户目录（2026-11-13「拍照上传就失败」）----
// canvasToTempFilePath 产出的是**临时文件**（微信明确「临时文件随时可能被系统清理」），
// 而上传发生在相机页 navigateBack 销毁之后：连拍几张后最早的合成图可能已被回收 →
// entry 上传时文件不存在 → 上传通道 fail。相册只挑 1~2 张、不产生额外临时文件，所以相册一直正常。
ok('合成产物 copyFile 落盘到用户目录（不赌临时文件活到上传那一刻）', /function persistComposedFile/.test(WCAM_JS) && /fsm\.copyFile\(/.test(WCAM_JS) && /wx\.env\.USER_DATA_PATH/.test(WCAM_JS));
// ⚠️ 必须是 **copyFile 而不是 saveFile**：saveFile 是「移动」，临时路径随即失效，
// 用户目录那份一旦读不到就彻底没有退路；copy 保留两份，上传前由 entry 验证哪份还在。
ok('落盘用 copyFile 不用 saveFile（保留临时副本作退路）', !/fsm\.saveFile\(/.test(WCAM_JS), 'still uses saveFile');
ok('落盘失败退回临时路径（不丢照片，只是回到旧行为）', /fail: \(\) => resolve\(\{ primary: tempPath, backup: '' \}\)/.test(WCAM_JS));
ok('合成完成后用落盘路径（previewPath = stablePath）', /const persisted = await persistComposedFile\(outPath\)/.test(WCAM_JS) && /previewPath: stablePath/.test(WCAM_JS));
ok('备份路径随托盘回传（双路径兜底）', /backupPath/.test(WCAM_JS) && /backupPath/.test(ENTRY_JS) && /resolvePhotoSource/.test(ENTRY_JS));
ok('读不到的文件不静默丢弃（toast + console.error）', /照片文件已失效/.test(ENTRY_JS) && /console\.error\('\[entry\] 水印照片文件不可读/.test(ENTRY_JS));
ok('上传失败必须打到控制台（真机可捞原始 errMsg）', /console\.error\('\[entry\] 检查照片上传失败'/.test(ENTRY_JS));
// `wx.uploadFile` 偶发「既不 success 也不 fail」：没有硬超时就会把 uploading 卡死，
// 之后每张照片都在 uploadPending 入口静默 return（照片不出现、控制台无报错）。
ok('单张上传有硬超时（永不回调也不会卡死后续上传）', /PHOTO_UPLOAD_TIMEOUT_MS/.test(ENTRY_JS) && /withHardTimeout\(\s*auth\.uploadCheckPhoto/.test(ENTRY_JS));
ok('uploading 复位在 finally（异常也不留卡死的闸门）', /finally \{[\s\S]{0,300}uploading: false/.test(ENTRY_JS));
ok('过期落盘文件会被清理（连拍不占满 200MB 用户目录）', /function purgeStaleSavedFiles/.test(WCAM_JS) && /fsm\.unlink\(\{ filePath/.test(WCAM_JS) && /purgeStaleSavedFiles\(\);/.test(WCAM_JS));
ok('成片体积在确认界面可见（现场可自证「是不是太大」）', /previewSizeText/.test(WCAM_JS) && /previewSizeText/.test(WCAM_WXML) && /format\.formatSize/.test(WCAM_JS));
ok('每步合成操作有超时（withTimeout，真机挂死不再卡住确认）', /function withTimeout/.test(WM_UTIL) && (WCAM_JS.match(/wmUtil\.withTimeout/g) || []).length >= 3);
ok('不再整屏 showLoading 遮罩（拍完必有确认界面，不能被遮罩卡死）', !/wx\.showLoading/.test(WCAM_JS));
ok('乐观预览：快门成功立即出原图确认（不等合成）', /previewPath: res\.tempImagePath/.test(WCAM_JS) && /composing: true/.test(WCAM_JS));
ok('合成完成换带水印图（seq 比对，重拍作废在途合成）', /seq !== this\._seq/.test(WCAM_JS));
ok('takePhoto quality high（原画质源）', /quality:\s*'high'/.test(WCAM_JS));
// EXIF 姿态校正：orientation ≠ up 必须走 drawNormalized
ok('drawNormalized 校正 orientation', /function drawNormalized/.test(WCAM_JS) && /orientation/.test(WCAM_JS.match(/function drawNormalized[\s\S]*?\n\}/)[0]));
ok('composeAtScale 传入 info.orientation', /drawNormalized\(ctx, source, storedW, storedH, info\.orientation/.test(WCAM_JS));
ok('left/right 交换输出宽高', /swap \? storedH : storedW/.test(WCAM_JS));
// 红线（用户 2026-11-12「解除所有上传照片的限制」）：相册原图直传不受成片规格影响
ok('相册路径仍 original 直传（成片规格只管水印相机产物）', /sizeType:\s*\['original'\]/.test(ENTRY_JS));

// ===== 3) entry 双入口接线 =====
console.log('\n[3] entry 双入口（D1）');
ok('onWatermarkCamera 存在', /onWatermarkCamera\(e\) \{/.test(ENTRY_JS));
ok('onAlbumPick 存在（原 onChoosePhoto 已拆分）', /onAlbumPick\(e\) \{/.test(ENTRY_JS));
ok('旧 onChoosePhoto 已删除（不留死入口）', !/onChoosePhoto/.test(ENTRY_JS) && !/onChoosePhoto/.test(ENTRY_WXML));
ok('相册入口 album-only（拍照一律走水印相机）', /sourceType:\s*\['album'\]/.test(ENTRY_JS));
ok('WXML 有水印拍照按钮', /onWatermarkCamera/.test(ENTRY_WXML));
ok('相册按钮文案显式标注「无水印」', /相册（无水印）/.test(ENTRY_WXML));
ok('wxss 有双入口样式（品牌描边突出主通道）', /en-photo-add-wm/.test(ENTRY_WXSS) && /en-photo-add-t-brand/.test(ENTRY_WXSS));
ok('wxss 用 --tt-* 令牌（不硬编码品牌色）', /var\(--tt-brand\)/.test(WCAM_WXSS) && !/#ff6b00|#0052d9/i.test(WCAM_WXSS));
// EventChannel 接线：init 传文案、done 收照片
ok('init 传 moduleName/targetName/deptName', /emit\('init'[\s\S]{0,220}moduleName[\s\S]{0,220}targetName[\s\S]{0,220}deptName/.test(ENTRY_JS));
ok('done 回传接 appendWatermarkPhotos', /done\(res\)[\s\S]{0,200}appendWatermarkPhotos/.test(ENTRY_JS));
ok('上传管线复用（uploadPending 一行不改）', /uploadPending\(fieldKey\)/.test(ENTRY_JS) && /uploadPending\(field\)/.test(ENTRY_JS));

// ===== 4) 合成产物 size 补齐（plan §5.3）=====
console.log('\n[4] 合成产物 size 补齐');
ok('appendWatermarkPhotos 用 getFileSystemManager().getFileInfo', /getFileSystemManager\(\)\.getFileInfo/.test(ENTRY_JS));
ok('size 取不到时落 0 而不是 undefined', /Number\(r && r\.size\) \|\| 0/.test(ENTRY_JS));
ok('photoFieldKey 兜底仍生效（field 缺省时）', /field \|\| this\.photoFieldKey\(\)/.test(ENTRY_JS));
// 入列条目带 size（失败兜底 retryWithCompressed 的 <2MB 判断依赖它）
ok('入列条目含 size 字段', /path: f\.path,\s*\n\s*size: f\.size,/.test(ENTRY_JS));

// ===== 5) 相机页零网络请求（D9）=====
console.log('\n[5] 相机页零网络请求');
ok('不发任何 auth 请求', !/auth\.(get|post|put|del)\(/.test(WCAM_JS));
ok('不调 uploadFile / request', !/uploadFile|request\(/.test(WCAM_JS));
// 部门名单点：相机页不自算部门（只读 entry 传入的 deptName）
ok('部门名只读 entry 传入值', /deptName = String\(p\.deptName \|\| ''\)/.test(WCAM_JS));
// 检查人姓名读本地缓存（登录态），不发 /api/auth/me
ok('检查人姓名读本地登录态缓存', /auth\.getUser\(\)/.test(WCAM_JS));

// ===== 6) 时间字符串走 format 单点（反向断言）=====
console.log('\n[6] 时间单点（不从 ISO 切片）');
ok('format.js 导出 formatWatermarkTime（含秒含周X）', /function formatWatermarkTime/.test(FORMAT) && /formatWatermarkTime/.test(FORMAT.slice(FORMAT.indexOf('module.exports'))));
ok('含秒（sec 字段在 partsInTz）', /sec/.test(FORMAT.match(/function partsInTz[\s\S]*?\n\}/)[0]));
ok('周几按北京日历日期（UTC 构造，不看设备时区）', /Date\.UTC\(p\.y, p\.m - 1, p\.d\)/.test(FORMAT));
// 反向断言：相机页与 watermark.js 都没有手搓 padStart 拼时间（必须走 format 单点）
const timeSlicing = (s) => /T\\d\{2\}|\.slice\(\d+,\s*\d+\)[\s\S]{0,30}[:：]/.test(s);
ok('watermark.js 无 ISO 切片拼时间', !timeSlicing(WM_UTIL));
ok('wcamera.js 无 ISO 切片拼时间', !timeSlicing(WCAM_JS));
ok('entry.js 水印相关无手搓时间格式化', !/formatWatermark|周[一二三四五六日].*padStart/.test(ENTRY_JS) || /wmDeptName/.test(ENTRY_JS));

// ===== 7) 页面配置（横屏）+ 注册 + 登录闸门 =====
console.log('\n[7] 页面配置与登录闸门');
ok('app.json 注册 wcamera/wcamera', (APP_JSON.subPackages || APP_JSON.subpackages || []).some((p) => p.root === 'packageUnion' && (p.pages || []).includes('wcamera/wcamera')));
ok('pageOrientation auto（横屏自动旋转，2026-11-13 真机反馈）', /"pageOrientation":\s*"auto"/.test(WCAM_JSON));
ok('navigationStyle custom（iOS 的 pageOrientation:auto 只在 custom 导航下生效）', /"navigationStyle":\s*"custom"/.test(WCAM_JSON));
ok('自定义导航有返回钮（托盘有照片时等同「完成」）', /bind:tap="onBack"/.test(WCAM_WXML) && /onBack\(\)/.test(WCAM_JS) && /if \(this\.data\.tray\.length\) this\.onFinish\(\)/.test(WCAM_JS));
// ===== 横屏专属布局（round2 B3，2026-11-13 用户截图裁决）=====
ok('WXSS 有横屏媒体查询块', /@media \(orientation: landscape\)/.test(WCAM_WXSS));
ok('横屏取景区铺满全屏（不再是竖屏列布局里的一条）', /@media \(orientation: landscape\)[\s\S]*\.wm-viewfinder[\s\S]{0,120}position: absolute/.test(WCAM_WXSS));
ok('横屏快门右下 + 完成/用照片在其上（wm-land-right 右列）', /\.wm-land-right[\s\S]{0,200}right: calc\(/.test(WCAM_WXSS) && /wm-land-btn/.test(WCAM_WXML));
ok('横屏重拍左下（左手拇指）', /bind:tap="onRetake"/.test(WCAM_WXML) && /\.wm-land-retake[\s\S]{0,200}left: calc\(/.test(WCAM_WXSS));
ok('横屏让出刘海侧（safe-area-inset-left/right）', /safe-area-inset-right/.test(WCAM_WXSS) && /safe-area-inset-left/.test(WCAM_WXSS));
ok('导航横屏浮层化（标题隐藏）', /\.wm-nav-title[\s\S]{0,40}display: none/.test(WCAM_WXSS.slice(WCAM_WXSS.indexOf('@media (orientation: landscape)'))));
ok('WXML 按 isLandscape 分支（竖屏 wm-bar 保持不动）', /wx:if="\{\{!isLandscape\}\}"/.test(WCAM_WXML) && /wx:else/.test(WCAM_WXML));
ok('isLandscape 首帧初始化 + 转屏跟随（onWindowResize/offWindowResize）', /isLandscape: !!\(win && win\.windowWidth > win\.windowHeight\)/.test(WCAM_JS) && /wx\.onWindowResize\(this\._onWinResize\)/.test(WCAM_JS) && /wx\.offWindowResize/.test(WCAM_JS));
// ---- 横屏「占比太大 + 挡画面」的三条硬约束（2026-11-13 用户截图：水印大字吃半屏、快门巨大）----
// 根因是 rpx：横屏下 rpx 按屏幕**长边**参照换算（812×375 → 1rpx≈1.08px），
// 竖屏 42rpx 大字（≈21px）横屏变 ≈45px、128rpx 快门变 ≈138px（占屏高 37%）。
// 这类错**不报错、不白屏、颜色也都在**，静态只能靠「横屏块内不许出现 rpx」钉住。
const LAND_WXSS = (WCAM_WXSS.slice(WCAM_WXSS.indexOf('@media (orientation: landscape)')) || '').replace(/\/\*[\s\S]*?\*\//g, '');
ok('横屏块内零 rpx（尺寸一律 px，防 rpx 长边换算膨胀）', !/[\d.]rpx/.test(LAND_WXSS), (LAND_WXSS.match(/[\d.]+rpx/g) || []).slice(0, 8));
ok('横屏快门 ≤ 64px（竖屏 128rpx 直接搬过来就是半个屏幕）', (() => {
  const m = LAND_WXSS.match(/\.wm-shutter\s*\{[^}]*width:\s*(\d+)px/);
  return !!m && Number(m[1]) <= 64;
})(), (LAND_WXSS.match(/\.wm-shutter\s*\{[^}]*\}/) || [''])[0]);
// 水印浮层横屏必须收成角落小块：铺满全宽的渐变压带 + 大字 = 挡住要拍的东西
ok('横屏水印浮层收进左下角（max-width + right:auto，不铺满全宽）', /\.wm-live\s*\{[^}]*max-width[^}]*right:\s*auto/.test(LAND_WXSS) || /\.wm-live\s*\{[^}]*right:\s*auto[^}]*max-width/.test(LAND_WXSS), (LAND_WXSS.match(/\.wm-live\s*\{[^}]*\}/) || [''])[0]);
ok('横屏水印字号 ≤ 20px（时间大字不再吃半屏）', (() => {
  const m = LAND_WXSS.match(/\.wm-live-l2\s*\{[^}]*font-size:\s*(\d+)px/);
  return !!m && Number(m[1]) <= 20;
})(), (LAND_WXSS.match(/\.wm-live-l2\s*\{[^}]*\}/) || [''])[0]);
// 横屏结构类必须在 WXSS 里真有定义（上一版 WXML 写了 wm-land-pill，WXSS 里根本没这个类
// → 控件全部按「无样式」裸排，位置全靠竖屏规则，看起来就是「乱、还挡」）
const wxmlLandClasses = [...new Set(((WCAM_WXML.match(/class="[^"]*"/g) || []).join(' ').match(/wm-land-[\w-]+/g) || []))];
ok('WXML 用到的 wm-land-* 类在 WXSS 里都有定义（不留无样式裸节点）', wxmlLandClasses.every((c) => new RegExp(`\\.${c}[\\s,{:]`).test(WCAM_WXSS)), wxmlLandClasses.filter((c) => !new RegExp(`\\.${c}[\\s,{:]`).test(WCAM_WXSS)));
// 横屏控件尺寸不再靠 JS 算卡片（卡片与全屏 viewfinder 规则互相覆盖 → 上一版「取景一条 + 花屏」）
ok('横屏不再有 JS 实算取景卡片（全屏取景单一口径）', !/landCardW|computeLandLayout/.test(WCAM_JS) && !/landCardW/.test(WCAM_WXML));
// 本页是固定暗色取景底：亮色主题的 --tt-text-* / --tt-line 压在黑底上等于隐形
// （旧版「完成 / 重拍 / 相机不可用」文字看不清的成因）
ok('暗色取景底不套用亮色文字令牌（--tt-text-* / --tt-line）', !/var\(--tt-(text-[123]|line)\)/.test(WCAM_WXSS), (WCAM_WXSS.match(/var\(--tt-(text-[123]|line)\)/g) || []).slice(0, 6));
// 横屏控制层是「透明覆盖全屏」的壳：不关掉 pointer-events 就吃掉整屏触摸，
// 相机点屏对焦失效（用户只会觉得「点了没反应」）；真控件必须各自收回 auto。
ok('横屏透明控制层不吃触摸（overlay none + 真控件 auto）', /\.wm-controls\s*\{[^}]*pointer-events:\s*none/.test(LAND_WXSS) && /pointer-events:\s*auto/.test(LAND_WXSS), (LAND_WXSS.match(/\.wm-controls\s*\{[^}]*\}/) || [''])[0]);
// ---- 成片水印的横屏预算（computeLayout 是版式唯一实现，浮层只是预告）----
// 旧实现只按**图宽**等比：4032×3024 横拍 → 时间大字 269px、底条 1258px = 吃掉画面 42%，
// 复审台看到的照片一半是黑条（与浮层同一半成因，用户 2026-11-13 截图）。
const wmLayout = require(path.join(ROOT, 'miniprogram', 'utils', 'watermark.js'));
const LAND_SIZES = [[4032, 3024], [2560, 1920], [2048, 1536], [1280, 960], [800, 600]];
const landBands = LAND_SIZES.map(([w, h]) => wmLayout.computeLayout(w, h).bandH / h);
ok('横屏成片底条 ≤ 30% 画面高（不再一半照片是黑条）', landBands.every((r) => r > 0 && r <= 0.3), landBands.map((r) => (r * 100).toFixed(0) + '%'));
const landTime = LAND_SIZES.map(([w, h]) => wmLayout.computeLayout(w, h).f2 / h);
ok('横屏时间大字 ≤ 8% 画面高（字号基准换成图高）', landTime.every((r) => r > 0 && r <= 0.08), landTime.map((r) => (r * 100).toFixed(1) + '%'));
ok('横屏版式按 landscape 标记分支（computeLayout 收 outH）', /function computeLayout\(outW, outH\)/.test(WM_UTIL) && /landscape:\s*land/.test(WM_UTIL) && /wmUtil\.computeLayout\(outW, outH\)/.test(WCAM_JS));
// 竖屏规格第一轮已验收：必须逐字不变（回归护栏，防「顺手把竖屏也改小」）
const port = wmLayout.computeLayout(3024, 4032);
ok('竖屏规格零变化（f1=126 f2=202 f3=108 maxW=2722）', port.f1 === 126 && port.f2 === 202 && port.f3 === 108 && port.maxW === 2722, port);
ok('onLoad 登录闸门（AGENTS.md 通用约定）', /onLoad\(\) \{\s*\n\s*if \(!getApp\(\)\.requireLogin\(\)\) return;/.test(WCAM_JS));
ok('onShow 登录闸门', /onShow\(\) \{\s*\n\s*if \(!getApp\(\)\.requireLogin\(\)\) return;/.test(WCAM_JS));
// 离屏画布：display:none 拿不到节点（class-status 踩过），必须移出屏幕
// （只看 .wm-offscreen 规则本身 —— 横屏块里 .wm-nav-title 的 display:none 是合法的标题隐藏）
const offscreenRule = (WCAM_WXSS.match(/\.wm-offscreen\s*\{[^}]*\}/) || [''])[0];
ok('合成画布移出屏幕（不 display:none）', /left:\s*-3000px/.test(offscreenRule) && !/display:\s*none/.test(offscreenRule), offscreenRule);
ok('WXML 是 type="2d" canvas', /type="2d"/.test(WCAM_WXML));

// ===== 8) 失败兜底与 D8 回退 =====
console.log('\n[8] 失败兜底与授权失败回退（D8）');
ok('binderror 接 onCameraError', /binderror="onCameraError"/.test(WCAM_WXML));
ok('引导面板有「去开启摄像头权限」', /onOpenSetting/.test(WCAM_JS) && /去开启摄像头权限/.test(WCAM_WXML));
ok('回退系统相机 chooseMedia camera-only（无水印仍可录）', /sourceType:\s*\['camera'\]/.test(WCAM_JS));
ok('回退也走 done 回传（entry 管线统一）', /onSystemCamera[\s\S]{0,600}emit\('done'/.test(WCAM_JS));
ok('回退原图直传（sizeType original，不引入画质限制）', /sizeType:\s*\['original'\]/.test(WCAM_JS));
// 合成失败：保留乐观预览的原图 + toast 知情 + 解除 composing（确认流程照常可用）
ok('合成失败保留原图并 toast 知情', /已保留原图/.test(WCAM_JS));
ok('失败解除 composing（确认不被卡住）', /setData\(\{ composing: false \}\)/.test(WCAM_JS));
ok('合成中「用照片」不生效（不把无水印图当成功交上去）', /if \(this\.data\.composing\) return;/.test(WCAM_JS));
// 连拍托盘与完成
ok('连拍托盘（tray）与「完成」带回', /onFinish[\s\S]{0,400}emit\('done'[\s\S]{0,200}navigateBack/.test(WCAM_JS));
ok('完成有防重（_finished）', /if \(this\._finished\) return;/.test(WCAM_JS));
// 未点完成退出 = 主动放弃，不回传（注释里写明）
ok('onUnload 不回传（主动放弃托盘废弃）', /onUnload\(\) \{[\s\S]{0,300}stopTimer/.test(WCAM_JS) && !/onUnload[\s\S]{0,400}emit\('done'/.test(WCAM_JS));

console.log(`\n${failed ? `FAIL: ${failed} 项未过` : 'ALL PASS'}\n`);
process.exit(failed ? 1 : 0);
