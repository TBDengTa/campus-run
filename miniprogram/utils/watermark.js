// 考勤录入水印相机 —— 文案与版式的唯一拼装点（docs/watermark-camera-plan.md）
//
// ⚠️ 相机页实时浮层与 canvas 烙图**共用本模块**的 buildLines 输出：
//   两处各拼一份必然出现「预览写着 A、照片烙着 B」（plan §5.2 红线）。
// 时间字符串走 utils/format.js::formatWatermarkTime（含秒含周X，北京时区），
// 禁止任何页面从 ISO 串切片拼时间。
const format = require('./format');

// ===== 合成成片规格（docs/watermark-camera-round2-plan.md A2，2026-11-13 定稿）=====
// 根因：q1.0 满分辨率 canvas 重编码会把 3~6MB 的硬件 JPEG 放大成 10~20MB（软编码在高
// quality 段效率远差于相机硬件编码器），撞真机 wx.uploadFile 通道上限 / 60s 默认超时
// —— 这就是「拍照后上传显示失败」的根子。成片规格是水印相机的产品定义（对标主流
// 水印相机 App 的输出规格），**不是**「解除上传限制」红线的回潮：红线保护的是用户
// **原图**（相册路径原样直传）与服务端零改动，两者本轮一行不动。
// 体积闭环：任一档成片超过 OUT_MAX_BYTES 或画布失败 → 自动降到下一档重出（复用已解码图）。
const OUT_LONG_EDGE = 2560; // 首档输出长边：复核屏绰绰有余，画布位图 ~19MB 低端机也稳
const OUT_QUALITY = 0.92; // 首档质量：视觉近无损，2560 档典型成片 1.5~3MB
const OUT_MAX_BYTES = 8 * 1024 * 1024; // 预算红线（8MB）：超出降档，不赌估算、只看实际文件大小
const OUT_ATTEMPTS = [
  { longEdge: OUT_LONG_EDGE, quality: OUT_QUALITY },
  { longEdge: 2048, quality: 0.85 },
  { longEdge: 2048, quality: 0.75 },
];

/**
 * 水印三行文案（唯一拼装点）：
 *   行1  模块名 · 受检对象   （与录入抽屉标题同源，缺省「检查留证」）
 *   行2  YYYY-MM-DD 周X HH:mm:ss（视觉重心，每张用各自快门时刻）
 *   行3  部门 · 检查人        （部门名单点取 /api/union/mine 下发 roles[].deptName，
 *                              前端不自算；缺失时只写姓名）
 * input: { moduleName, targetName, deptName, userName, at }  at: Date/时间戳
 */
function buildLines(input) {
  const src = input || {};
  const clean = (v) => String(v == null ? '' : v).trim();
  const subject = [clean(src.moduleName), clean(src.targetName)].filter(Boolean).join(' · ');
  const line2 = format.formatWatermarkTime(src.at || new Date());
  const person = [clean(src.deptName), clean(src.userName)].filter(Boolean).join(' · ');
  return {
    line1: subject || '检查留证',
    line2: line2 || format.formatWatermarkTime(new Date()),
    line3: person || '唐唐快跑',
  };
}

/**
 * canvas 烙图版式：全部按输出图宽度等比（小图不大字、大图不小字），plan §4 规格。
 * outW: 输出图宽（px）；outH: 输出图高（px，**横屏照片必须传**）。
 * 返回字号/内距/行高/底条高的像素值。
 *
 * ⚠️ 横屏（w > h）字号基准换成**短边（图高）**并整体收紧一档：
 * 只按宽度等比时，2048×1536 的横拍照片 f2 = 2048/15 ≈ 137px，
 * 三行 + 内距 + 渐变过渡 ≈ 714px = **吃掉画面 46%**（用户 2026-11-13「横屏占比太大、还挡画面」
 * 在成片上的同一半成因；浮层那一半在 WXSS 横屏块里按 px 预算解决）。
 * 横屏按 h 定预算并取更小的系数，底条稳定压在 ~24% 高。
 */
const LAYOUT_PORT = {
  f1: 1 / 24, f2: 1 / 15, f3: 1 / 28, padX: 1 / 20, padB: 1 / 22, gap: 1 / 70, fade: 1 / 12,
  minF1: 18, minF2: 24, minF3: 14, minPadX: 12, minPadB: 14, minGap: 6,
};
const LAYOUT_LAND = {
  f1: 1 / 40, f2: 1 / 24, f3: 1 / 48, padX: 1 / 22, padB: 1 / 22, gap: 1 / 90, fade: 1 / 16,
  minF1: 16, minF2: 22, minF3: 12, minPadX: 12, minPadB: 12, minGap: 5,
};

function computeLayout(outW, outH) {
  const w = Number(outW) || 0;
  const h = Number(outH) || 0;
  const land = h > 0 && w > h;
  const k = land ? LAYOUT_LAND : LAYOUT_PORT;
  const B = land ? h : w; // 等比基准：横屏取图高，竖屏取图宽（竖屏规格第一轮已验收，逐字不动）
  const f1 = Math.max(k.minF1, Math.round(B * k.f1)); // 行1 模块·对象
  const f2 = Math.max(k.minF2, Math.round(B * k.f2)); // 行2 日期时间（大字锚点）
  const f3 = Math.max(k.minF3, Math.round(B * k.f3)); // 行3 部门·检查人
  const padX = Math.max(k.minPadX, Math.round(B * k.padX)); // 左右内距
  const padB = Math.max(k.minPadB, Math.round(B * k.padB)); // 底部内距
  const gap = Math.max(k.minGap, Math.round(B * k.gap)); // 行间距
  const fade = Math.round(B * k.fade); // 渐变过渡带
  const lh1 = Math.round(f1 * 1.35);
  const lh2 = Math.round(f2 * 1.3);
  const lh3 = Math.round(f3 * 1.35);
  return {
    f1,
    f2,
    f3,
    padX,
    padB,
    gap,
    fade,
    lh1,
    lh2,
    lh3,
    landscape: land,
    // 行1 折行宽度上限：横屏画面又宽又扁，长对象名一路铺到右边缘最难看 —— 限到 62% 宽
    //（竖屏维持原来的「整幅宽 − 左右内距」，第一轮验收过的行为一行不动）
    maxW: Math.max(1, land ? Math.round(w * 0.62) : w - padX * 2),
    // 底条总高（渐变覆盖区）：三行 + 行距 + 底部内距，再留一段渐变过渡
    bandH: lh1 + lh2 + lh3 + gap * 2 + padB + fade,
  };
}

/**
 * canvas 2d 没有自动换行：按实际测量宽度逐字折行（比字符预算准），最多 maxLines 行，
 * 超出截断补省略号。ctx 只用来 measureText（真实宽度），折行规则单点在本模块。
 */
function wrapText(ctx, text, fontSize, maxWidth, maxLines) {
  ctx.font = `${fontSize}px sans-serif`;
  if (ctx.measureText(text).width <= maxWidth) return [text];
  const rows = [];
  let cur = '';
  for (const ch of text) {
    if (cur && ctx.measureText(cur + ch).width > maxWidth) {
      rows.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) rows.push(cur);
  if (rows.length <= maxLines) return rows;
  const kept = rows.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

/**
 * 给任何一步合成操作加超时（2026-11-13 真机反馈「拍完没反应」的根治）：
 * 大图解码 / 大画布输出在部分机型会**既不 success 也不 fail**（挂死），
 * 没有超时 = showLoading 遮罩永远挂着 = 用户看到「拍完卡死」。
 * 现在每一步都有超时，超时走合成失败兜底（保留原图），绝不无限等待。
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label || '操作超时')), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

module.exports = {
  buildLines,
  computeLayout,
  wrapText,
  withTimeout,
  OUT_LONG_EDGE,
  OUT_QUALITY,
  OUT_MAX_BYTES,
  OUT_ATTEMPTS,
};
