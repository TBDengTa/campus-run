// 水印相机（docs/watermark-camera-plan.md —— 口径唯一说明，改这里前先读它）
//
// 链路：takePhoto(quality:'high') → **乐观预览**（原图立刻进确认界面）→
//       canvas 2d 后台合成（原图 + 底部水印条）→ 完成后换图（jpg，水印已烙进文件）→
//       「用照片」进托盘（可连拍）→「完成」EventChannel 带回 entry，走既有逐张上传管线。
//
// 硬约束（改动前先读）：
//   ① **拍完必有确认界面**（2026-11-13 真机反馈「拍完没反应/没有确认」的根治）：
//      旧流程「等合成完才出预览」，真机上大图解码 / 大画布输出慢甚至挂死，
//      showLoading 一挂就是「拍完卡死」。现在快门成功即出原图预览，
//      合成在后台追赶：完成换带水印图；失败/超时保留原图并 toast —— 绝不阻塞确认。
//   ② **每一步合成操作都有超时**（utils/watermark.js::withTimeout）：大图解码 / 画布输出
//      在部分机型「既不 success 也不 fail」，没有超时 = 永远挂死。超时走失败兜底。
//   ③ **画布失败自动降档**：整链先按原尺寸（超长边先降到 MAX_LONG_EDGE）合成，
//      失败再降 2048 档重试一次；两档都失败才退「无水印原图」。
//      降档是防低端机画布内存爆掉，不是「上传前压缩」的回潮（检查照片不限制画质，用户 2026-11-12）。
//   ④ **本页零网络请求**（D9）：水印文案全部由 entry 经 EventChannel 传入，
//      检查人姓名读本地登录态缓存。弱网/离线必须可拍。
//   ⑤ 文案与版式共用 utils/watermark.js（buildLines / computeLayout / wrapText）：
//      实时浮层与 canvas 烙图两处各拼一份，必然「预览写着 A、照片烙着 B」。
//   ⑥ **横屏**（2026-11-13 真机反馈「没法自动转成横屏」）：页面配置 pageOrientation:"auto"
//      （iOS 要 navigationStyle:"custom" 才生效，故本页自定义导航栏）。横拍时 takePhoto 产物
//      可能带 EXIF 旋转标记，orientation ≠ 'up' 必须先 drawNormalized 校正再画，否则水印横着。
const wmUtil = require('../../utils/watermark');
const auth = require('../../utils/request');
// 体积文案走 format 单点（与 entry 的失败文案同口径，两处各写一份必然显示不一致）
const format = require('../../utils/format');

// 单步合成超时：读图信息 / 解码 / 输出各 6 秒（真机典型 1~3 秒，6 秒已很宽裕）
const STEP_TIMEOUT_MS = 6000;

// EXIF 姿态校正：storedW/H 是位图存储尺寸；left/right 是 90° 旋转，输出画布宽高互换。
// 镜像类只有前置摄像头可能出现，本页固定后置，按原样绘制兜底。
function drawNormalized(ctx, img, storedW, storedH, orientation) {
  const swap = orientation === 'left' || orientation === 'right';
  const outW = swap ? storedH : storedW;
  const outH = swap ? storedW : storedH;
  ctx.save();
  if (orientation === 'right') {
    // 存储位图顺时针转 90° 才正：画布原点挪到右上
    ctx.translate(outW, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(img, 0, 0, storedW, storedH);
  } else if (orientation === 'left') {
    ctx.translate(0, outH);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(img, 0, 0, storedW, storedH);
  } else if (orientation === 'down') {
    ctx.translate(outW, outH);
    ctx.rotate(Math.PI);
    ctx.drawImage(img, 0, 0, storedW, storedH);
  } else {
    ctx.drawImage(img, 0, 0, storedW, storedH);
  }
  ctx.restore();
}

// 底部水印条：渐变黑（只压底部）+ 三行白字（版式规格见 plan §4 + round2 B6 横屏预算）
function drawWatermark(ctx, outW, outH, lines) {
  // outH 必须传：横屏照片的字号基准是**图高**（只按宽度等比会把底条撑到占画面 46%）
  const L = wmUtil.computeLayout(outW, outH);
  const rows1 = wmUtil.wrapText(ctx, lines.line1, L.f1, L.maxW, 2);
  // 底条总高 = 三行 + 行距 + 底部内距 + 渐变过渡带（折行时随行1加高）
  const bandH = rows1.length * L.lh1 + L.lh2 + L.lh3 + L.gap * (rows1.length + 1) + L.padB + L.fade;
  const bandTop = outH - bandH;

  const grad = ctx.createLinearGradient(0, bandTop, 0, outH);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
  grad.addColorStop(0.35, 'rgba(0, 0, 0, 0.3)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, bandTop, outW, bandH);

  // 从下往上排（textBaseline='top'，行槽自底向上叠）
  ctx.textBaseline = 'top';
  const y3 = outH - L.padB - L.lh3;
  const y2 = y3 - L.gap - L.lh2;
  const y1Last = y2 - L.gap - L.lh1;
  const y1First = y1Last - (rows1.length - 1) * L.lh1;

  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 1;
  ctx.font = `${L.f1}px sans-serif`;
  rows1.forEach((row, i) => ctx.fillText(row, L.padX, y1First + i * L.lh1));
  ctx.font = `bold ${L.f2}px sans-serif`;
  ctx.fillText(lines.line2, L.padX, y2);
  ctx.globalAlpha = 0.85;
  ctx.font = `${L.f3}px sans-serif`;
  ctx.fillText(lines.line3, L.padX, y3);
  ctx.globalAlpha = 1;
}

function imageInfoOf(src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({ src, success: resolve, fail: (e) => reject(new Error((e && e.errMsg) || '读取照片信息失败')) });
  });
}

function canvasToTempFile(canvas, quality) {
  return new Promise((resolve, reject) => {
    // jpg + 成片规格质量（OUT_ATTEMPTS 阶梯；合成必然重编码一次，是「烙进文件」的固有代价）
    // ⚠️ **destWidth/destHeight 必须显式给成画布像素**（2026-11-13「水印照片又传不上去」的真根因）：
    // 微信对这两个参数的默认值是「区域尺寸 × devicePixelRatio」—— DPR=3 的机子上 2560 宽会输出 7680 宽
    //（44MP），q0.92 成片几十 MB，上传通道直接失败。更阴的是**每一档都超预算**，
    // 闭环一路降到最后一档被无条件接受 → 照样几十 MB，于是「明明在降档、照片还是传不上去」。
    // ⚠️ 反过来**不要**显式传 x/y/width/height：区域默认就是「整块画布」
    //（packageAdmin/class-status 的分享图同样不传区域、导出完整画布，现网已验证），
    // 而部分机型把这几个参数按 canvas 的 **CSS 尺寸**解释（本页离屏画布 CSS 只有 320×240）
    // —— 传了反而可能只导出左上角一小块。只钉 dest 像素数是最小的安全改动。
    const w = Number(canvas.width) || 0;
    const h = Number(canvas.height) || 0;
    wx.canvasToTempFilePath({
      canvas,
      destWidth: w,
      destHeight: h,
      fileType: 'jpg',
      quality,
      success: (r) => resolve(r.tempFilePath),
      fail: (e) => reject(new Error((e && e.errMsg) || '水印合成输出失败')),
    });
  });
}

// 成片实际体积（体积闭环只看文件真实大小，不赌估算）。
// ⚠️ 读不到**不再当通过**（旧版 `!size → 接受` 是 fail-open：getFileInfo 失败 = 放行超大成片）。
// 读不到就继续降档，最后一档兜底（再往上还有上传侧「失败压缩重试一次」）。
function fileSizeOf(path) {
  return new Promise((resolve) => {
    wx.getFileSystemManager().getFileInfo({
      filePath: path,
      success: (r) => resolve(Number(r && r.size) || 0),
      fail: () => resolve(0),
    });
  });
}

// ===== 合成产物的**落盘持久化**（2026-11-13 第三轮「拍照上传就失败」的另一半根因）=====
//
// `canvasToTempFilePath` 产出的是**临时文件**：微信明确「临时文件随时可能被系统清理」，
// 而本页的产物根本不是在生成它的页面里上传的 —— 用户点「完成」后 `navigateBack` 把相机页
// 销毁，上传发生在 entry 页。连拍 2~4 张时，每一张都会留下「相机原图 + 合成图」两份临时文件
// （12MP 原图 3~6MB），临时区很快触顶，系统回收最早的合成图 →
// entry 上传时文件已经不存在 → 上传通道直接 fail（表现为「拍照上传就失败」，
// 而相册只挑 1~2 张、上传前不产生额外临时文件，所以相册照片一直正常）。
//
// 修法：合成完成后立刻 `saveFile` 到**用户目录**（200MB 配额、不随页面销毁/临时区回收消失），
// 托盘与上传都用这个稳定路径；失败则退回临时路径（行为同旧版，不额外恶化）。
const WM_FILE_PREFIX = 'wm-';

function userDataDir() {
  return (wx.env && wx.env.USER_DATA_PATH) || '';
}

// 清理**过期的**落盘成片（正常上传后不再需要；正在用/待重传的绝不能被删，所以只清 24h 前的）
function purgeStaleSavedFiles() {
  const fsm = wx.getFileSystemManager && wx.getFileSystemManager();
  const dir = userDataDir();
  if (!fsm || !fsm.readdir || !dir) return;
  const STALE_MS = 24 * 3600 * 1000;
  const now = Date.now();
  fsm.readdir({
    dirPath: dir,
    success: (res) => {
      const names = ((res && res.files) || []).filter((n) => String(n).indexOf(WM_FILE_PREFIX) === 0);
      names.forEach((name) => {
        const filePath = `${dir}/${name}`;
        fsm.stat({
          path: filePath,
          success: (st) => {
            // lastModifiedTime 单位是**秒**（不同基础库 mtime 字段名不一致，两个都兜）
            const at = Number((st && (st.lastModifiedTime || st.mtime)) || 0) * 1000;
            if (!at || now - at > STALE_MS) fsm.unlink({ filePath, fail: () => {} });
          },
          fail: () => {},
        });
      });
    },
    fail: () => {},
  });
}

// 合成图 → 用户目录的稳定副本。
// ⚠️ 用 **copyFile 而不是 saveFile**（2026-11-13 第四轮）：saveFile 是「移动」，
// 临时路径随即失效，一旦用户目录那份读不到就彻底没有退路；copyFile 保留两份，
// 上传时哪份还在就用哪份（entry 侧会逐一验证，见 appendWatermarkPhotos）。
// 返回 { primary, backup }：primary 是稳定副本（失败时=原临时路径），backup 是临时路径。
function persistComposedFile(tempPath) {
  return new Promise((resolve) => {
    const fsm = wx.getFileSystemManager && wx.getFileSystemManager();
    const dir = userDataDir();
    if (!tempPath || !fsm || !fsm.copyFile || !dir) {
      resolve({ primary: tempPath, backup: '' });
      return;
    }
    const filePath = `${dir}/${WM_FILE_PREFIX}${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`;
    fsm.copyFile({
      srcPath: tempPath,
      destPath: filePath,
      success: () => resolve({ primary: filePath, backup: tempPath }),
      fail: () => resolve({ primary: tempPath, backup: '' }),
    });
  });
}

Page({
  data: {
    statusBarHeight: 0,
    isLandscape: false, // 横屏标记（布局分支用；纯样式切换走 WXSS 媒体查询，双轨）
    live: { line1: '检查留证', line2: '', line3: '唐唐快跑' },
    previewing: false,
    previewPath: '',
    previewSizeText: '', // 成片体积（如「2.14 MB」）：现场就能回答「是不是太大传不上去」
    composing: false, // 后台合成中（乐观预览已显示原图，确认按钮暂不可用）
    tray: [],
    cameraError: false,
  },

  onLoad() {
    if (!getApp().requireLogin()) return;
    this._wm = { moduleName: '', targetName: '', deptName: '', userName: '' };
    this._seq = 0; // 快门序号：重拍即作废在途合成（完成回写前比对，不覆盖新状态）
    this._finished = false;
    // 自定义导航（pageOrientation:auto 在 iOS 需要 navigationStyle:custom）+ 横屏方向初始化
    try {
      const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      this.setData({
        statusBarHeight: (win && win.statusBarHeight) || 0,
        isLandscape: !!(win && win.windowWidth > win.windowHeight),
      });
    } catch (e) {
      this.setData({ statusBarHeight: 0, isLandscape: false });
    }
    // 转屏跟随（进页就横着的场景由上面的首帧初始化兜住）
    this._onWinResize = (res) => {
      const size = (res && res.size) || {};
      const land = size.windowWidth > size.windowHeight;
      if (land !== this.data.isLandscape) this.setData({ isLandscape: land });
    };
    if (wx.onWindowResize) wx.onWindowResize(this._onWinResize);
    // 清理 24h 前的落盘成片（连拍会攒文件；正在用/待重传的按时间窗保护，不会被误删）
    purgeStaleSavedFiles();
    // 检查人姓名：本地登录态缓存（D9 离线可拍，不发请求）
    const cached = (auth && auth.getUser && auth.getUser()) || {};
    this._wm.userName = String(cached.name || '').trim();
    // 水印文案由 entry 传入（moduleName / targetName / deptName），本页不另算
    const ch = this.getOpenerEventChannel && this.getOpenerEventChannel();
    if (ch && ch.on) {
      ch.on('init', (payload) => {
        const p = payload || {};
        this._wm.moduleName = String(p.moduleName || '').trim();
        this._wm.targetName = String(p.targetName || '').trim();
        // 部门名：entry 从 /api/union/mine 的 roles[].deptName 取好传进来（服务端单点，前端不自算）
        this._wm.deptName = String(p.deptName || '').trim();
        this.refreshLive();
      });
    }
  },

  onShow() {
    if (!getApp().requireLogin()) return;
    // 实时浮层的秒级时钟：每张照片用各自快门时刻，浮层只是预告
    this.refreshLive();
    if (!this._liveTimer && !this.data.cameraError) {
      this._liveTimer = setInterval(() => this.refreshLive(), 1000);
    }
  },

  onHide() {
    this.stopTimer();
  },

  onUnload() {
    this.stopTimer();
    if (wx.offWindowResize && this._onWinResize) wx.offWindowResize(this._onWinResize);
    // 未点「完成」就退出 = 用户主动放弃，托盘照片（临时文件）随之废弃，不回传
  },

  stopTimer() {
    if (this._liveTimer) {
      clearInterval(this._liveTimer);
      this._liveTimer = null;
    }
  },

  // 横屏布局为什么不用 JS 算尺寸、也不用 rpx：
  // 横屏下 rpx 按屏幕**长边**参照换算会膨胀近一倍（1rpx≈1.08px，而可用高度只有 ~375px），
  // 沿用竖屏数值 = 控件巨大、水印大字挡半屏（2026-11-13 截图裁决）。
  // 因此横屏一律走 WXSS `@media (orientation: landscape)` 里的 **px** 预算，
  // 取景保持全屏（不做「4:3 居中卡片」——卡片与全屏规则互相覆盖，上一版就是这么花屏的）。
  refreshLive() {
    this.setData({ live: wmUtil.buildLines({ ...this._wm, at: new Date() }) });
  },

  // ===== 自定义导航（横屏必需：iOS 的 pageOrientation:auto 只在 custom 导航下生效）=====
  onBack() {
    // 托盘里有照片 = 回去就是交照片，走与「完成」相同的回传
    if (this.data.tray.length) this.onFinish();
    else wx.navigateBack();
  },

  // ===== 拍摄与合成 =====
  onShutter() {
    if (this.data.cameraError || this.data.previewing || this.data.composing) return;
    const at = new Date(); // 快门瞬间即水印时刻（D4 本地时钟；真锚点是服务端接收时间）
    wx.createCameraContext().takePhoto({
      quality: 'high',
      success: (res) => {
        // 乐观预览（硬约束①）：原图立刻进确认界面，「重拍 / 用照片」马上可见 ——
        // 合成在后台追赶，完成换带水印图；卡死/失败也不阻塞确认（②③兜底）。
        this._seq += 1;
        const seq = this._seq;
        this.setData({
          previewing: true,
          previewPath: res.tempImagePath,
          composing: true,
        });
        this.composePhoto(res.tempImagePath, at, seq);
      },
      fail: () => {
        wx.showToast({ title: '拍摄失败，请重试', icon: 'none' });
      },
    });
  },

  // 后台合成：完成把带水印图换进预览；失败/超时保留原图并提示（确认流程永不被卡住）
  async composePhoto(srcPath, at, seq) {
    try {
      const info = await wmUtil.withTimeout(imageInfoOf(srcPath), STEP_TIMEOUT_MS, '读取照片信息超时');
      const longEdgeSrc = Math.max(info.width, info.height);
      let img = null; // 只解码一次，降档重出复用（重解码 12MP 要再花 1~2 秒）
      let outPath = '';
      let lastProduced = ''; // 已产出的最小一档（体积未知/全档超预算时用，别让整链白合成）
      let lastErr = null;
      // 体积闭环（OUT_ATTEMPTS 阶梯）：画布失败**或成片超 OUT_MAX_BYTES** 都降到下一档；
      // 最后一档无条件接受（再往上还有上传侧「失败压缩重试一次」兜底）。
      // ⚠️ 体积**读不到（size=0）不算通过**：旧版 `!size → 接受` 是 fail-open，
      // getFileInfo 一失败就放行超大成片 —— 正是「闭环在降档、照片还是传不上去」的第二半。
      for (let i = 0; i < wmUtil.OUT_ATTEMPTS.length && !outPath; i += 1) {
        const step = wmUtil.OUT_ATTEMPTS[i];
        const scale = Math.min(1, step.longEdge / longEdgeSrc);
        const isLast = i === wmUtil.OUT_ATTEMPTS.length - 1;
        try {
          // eslint-disable-next-line no-await-in-loop
          const path = await this.composeAtScale(srcPath, info, img, scale, step.quality, at, (decoded) => {
            img = decoded;
          });
          lastProduced = path;
          // eslint-disable-next-line no-await-in-loop
          const size = await fileSizeOf(path);
          if ((size > 0 && size <= wmUtil.OUT_MAX_BYTES) || isLast) outPath = path;
        } catch (e) {
          lastErr = e; // 画布爆内存 / 输出失败 → 降下一档（更小画布）
        }
      }
      // 降档途中某档抛错，但前面已经出过一张：用那张（带水印）而不是退回无水印原图
      if (!outPath) outPath = lastProduced;
      if (!outPath) throw lastErr || new Error('水印合成失败');
      // ⚠️ 必须先落盘到用户目录再返回：临时文件在相机页销毁后可能已被系统回收，
      // 那时 entry 的上传会 fail（「拍照上传就失败」的根因之一，见 persistComposedFile 注释）。
      // eslint-disable-next-line no-await-in-loop
      const persisted = await persistComposedFile(outPath);
      const stablePath = persisted.primary;
      // 备份路径随托盘一起回传：上传前由 entry 逐一验证「哪份还在」
      this._previewBackup = persisted.backup || '';
      const stableSize = await fileSizeOf(stablePath);
      if (seq !== this._seq) return; // 已重拍/退出：作废，不覆盖新状态
      this.setData({
        previewPath: stablePath,
        // 现场可见的体积：用户 2026-11-13「是图片大小的原因吗」—— 直接答在界面上，
        // 不必等上传失败再猜（>8MB 基本就是合成侧规格失效，<4MB 则一定是网络/服务端）
        previewSizeText: stableSize > 0 ? format.formatSize(stableSize) : '',
        composing: false,
      });
    } catch (err) {
      if (seq !== this._seq) return;
      this.setData({ composing: false });
      // 原图已在预览里（乐观预览）：只提示，确认流程照常可用（用照片 = 交无水印原图）
      wx.showToast({ title: '水印合成失败，已保留原图', icon: 'none' });
    }
  },

  // 按 scale + quality 合成一次（画布尺寸 = 存储尺寸 × scale，left/right 交换宽高）
  async composeAtScale(srcPath, info, img, scale, quality, at, onDecoded) {
    const storedW = Math.max(1, Math.round(info.width * scale));
    const storedH = Math.max(1, Math.round(info.height * scale));
    const swap = info.orientation === 'left' || info.orientation === 'right';
    const outW = swap ? storedH : storedW;
    const outH = swap ? storedW : storedH;

    const canvas = await this.prepareCanvas(outW, outH);
    const ctx = canvas.getContext('2d');
    let source = img;
    if (!source) {
      source = canvas.createImage();
      await wmUtil.withTimeout(
        new Promise((resolve, reject) => {
          source.onload = resolve;
          source.onerror = () => reject(new Error('照片解码失败'));
          source.src = srcPath;
        }),
        STEP_TIMEOUT_MS,
        '照片解码超时'
      );
      if (onDecoded) onDecoded(source);
    }
    drawNormalized(ctx, source, storedW, storedH, info.orientation || 'up');
    drawWatermark(ctx, outW, outH, wmUtil.buildLines({ ...this._wm, at }));
    return wmUtil.withTimeout(canvasToTempFile(canvas, quality), STEP_TIMEOUT_MS, '水印输出超时');
  },

  prepareCanvas(outW, outH) {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#wm-canvas')
        .fields({ node: true })
        .exec((res) => {
          const canvas = res && res[0] && res[0].node;
          if (!canvas) {
            reject(new Error('合成画布不可用'));
            return;
          }
          canvas.width = outW;
          canvas.height = outH;
          resolve(canvas);
        });
    });
  },

  // ===== 预览确认 / 托盘 / 完成 =====
  onUsePhoto() {
    // 合成未落定时按钮不生效（防止把没水印的图当成功交上去而不自知）；
    // 合成失败的兜底已在 composePhoto 里解除 composing，此时「用照片」= 交无水印原图
    if (this.data.composing) return;
    if (!this.data.previewPath) return;
    this.addToTray(this.data.previewPath);
  },

  onRetake() {
    // 重拍随时可用（含合成中）：序号 +1 作废在途合成，完成后不会覆盖回来
    this._seq += 1;
    this._previewBackup = '';
    this.setData({ previewing: false, previewPath: '', previewSizeText: '', composing: false });
  },

  addToTray(path) {
    if (!path) return;
    // backup：同一张图的临时路径副本（见 persistComposedFile）。上传前 entry 会验证哪份还在 ——
    // 「相机页销毁后临时文件被回收」与「用户目录那份读不到」两种意外都能兜住。
    this.setData({
      tray: this.data.tray.concat([{ path, backup: this._previewBackup || '' }]),
      previewing: false,
      previewPath: '',
      previewSizeText: '',
      composing: false,
    });
    this._previewBackup = '';
  },

  onFinish() {
    if (this._finished) return;
    this._finished = true;
    const ch = this.getOpenerEventChannel && this.getOpenerEventChannel();
    // 只回传路径；size 由 entry 侧补齐（合成产物没有 size，入列前必须补，
    // 否则失败兜底「<2MB 跳过压缩」会把 size=0 全跳过 —— plan §5.3）
    if (ch && ch.emit) {
      ch.emit('done', {
        photos: this.data.tray.map((t) => ({ path: t.path, backupPath: t.backup || '' })),
      });
    }
    wx.navigateBack();
  },

  // ===== 相机不可用（授权拒绝 / PC / 极旧基础库）=====
  onCameraError() {
    this.stopTimer();
    this.setData({ cameraError: true });
  },

  onOpenSetting() {
    wx.openSetting({
      success: (res) => {
        // 用户在设置页把摄像头权限打开后返回：重新初始化相机（组件 wx:if 会重建）
        if (res && res.authSetting && res.authSetting['scope.camera']) {
          this.setData({ cameraError: false });
          if (!this._liveTimer) {
            this._liveTimer = setInterval(() => this.refreshLive(), 1000);
          }
        }
      },
    });
  },

  // D8 回退：系统相机（无水印）。照片照常回 entry 入库，录入不停摆。
  onSystemCamera() {
    wx.chooseMedia({
      count: 9,
      mediaType: ['image'],
      sourceType: ['camera'],
      sizeType: ['original'], // 原图直传：不因回退而引入画质限制（用户 2026-11-12）
      success: (res) => {
        const shots = ((res && res.tempFiles) || []).map((f) => ({ path: f.tempFilePath }));
        if (!shots.length) return;
        const ch = this.getOpenerEventChannel && this.getOpenerEventChannel();
        if (ch && ch.emit) ch.emit('done', { photos: shots });
        this._finished = true;
        wx.navigateBack();
      },
      fail: () => {},
    });
  },
});
