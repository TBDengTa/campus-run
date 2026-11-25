/**
 * 班超报表：复制文本 / 生成图片 / 导出详情表格（用户 2026-11-23）
 *
 * 「我的班级 → 班超联赛」把本期（日 / 周 / 月）问题情况发到本班群：
 *   ① 复制文本 —— 服务端 buildReport().copyText 生成的短文本（微信里不会被折叠）；
 *   ② 生成图片 —— 本文件用 canvas 2d 画（标题 + 分数 + 模块行 + 口径说明），
 *      字段全部来自服务端 `GET /api/union/class/:className/report`，
 *      **前端不重算任何分数/名次**（重算就会出现「图片写的」与「页面显示的」对不上）；
 *   ③ 导出表格 —— 服务端 xlsx（format=xlsx），走 auth.downloadAndOpen。
 *
 * 为什么图片也在前端画：服务端没有画图依赖（也不该为了发群图片引入 sharp/canvas），
 * 而班级状态页（packageAdmin/class-status）已有成熟的三段式画布写法，这里沿用同一套：
 * 先算排版 -> 画 -> canvasToTempFilePath -> showShareImageMenu（低版本回退存相册）。
 *
 * 本文件只做「画」与「触发分享」，不碰请求（数据由页面取好后传进来）——请求鉴权/错误文案
 * 仍归页面，保持与页面其他动作一致。
 */

// ===== 版式常量（逻辑像素；画布按 ×2 出图保清晰）=====
const W = 750;
const PAD = 30;
const TITLE_H = 132; // 标题区：班级 + 区间 + 分数
const HEAD_H = 46; // 「检查明细」小标题
const ROW_H = 62; // 每个模块一行
const REC_HEAD_H = 40; // 「最近记录」小标题
const REC_ROW_H = 44; // 每条记录一行
const NOTE_HEAD_H = 40; // 「口径说明」小标题
const NOTE_LINE_H = 30; // 口径说明每行
const FOOT_H = 56; // 落款

// 颜色：与 app.wxss 的白橙设计令牌**同值**（canvas 拿不到 CSS 变量，只能写字面量；
// 改令牌时这里要同步 —— tools/check-banchao-report.js 会逐条比对，不一致就失败）。
const C = {
  bg: '#FFFFFF',
  // --tt-brand / --tt-brand-soft（亮色主题）
  brand: '#ff6b00',
  brandSoft: '#fff4ec',
  // --tt-text-1 / -2 / -3 实为 rgba 黑，画布这里用等价实色（避免半透明叠加在橙色底上发灰）
  text: 'rgba(0, 0, 0, 0.9)',
  text2: 'rgba(0, 0, 0, 0.6)',
  text3: 'rgba(0, 0, 0, 0.42)',
  // 语义色（与页面 class-status / 扣分档位同一套观感，非令牌）
  line: '#E5E7EB',
  good: '#15803D',
  warn: '#B45309',
  bad: '#D93025',
};

// 折行宽度（canvas 没有自动换行，必须自己切）：750 宽 - 两侧内边距，按 22px 字号估算
const NOTE_LINE_CHARS = 26;

/** 按字数硬折行（中文按字宽算，足够应付口径说明这类纯中文长句） */
function wrapText(text, maxChars) {
  const s = String(text || '');
  if (!s) return [];
  const out = [];
  let cur = '';
  for (const ch of s) {
    cur += ch;
    if (cur.length >= maxChars) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 计算画布高度与各分段偏移（**先算后画**：分两处各算迟早「高度按 A 算、绘制按 B 画」，
 * 画布溢出是静默的 —— 图片生成成功、发出去才发现口径说明被切掉半行）。
 *
 * @param {object} r 服务端 report 响应
 * @returns {{H:number, rows:object[], recStart:number, noteStart:number, footStart:number, noteLines:string[]}}
 */
function planLayout(r) {
  const rows = (r.modules || []).slice();
  const recs = (r.records || []).slice(0, 5);
  const noteLines = [];
  for (const line of r.noteLines || []) noteLines.push(...wrapText(line, NOTE_LINE_CHARS));

  const modTop = TITLE_H;
  const modBody = rows.length ? rows.length * ROW_H : ROW_H; // 无模块也留一行「暂无模块」
  const recTop = modTop + HEAD_H + modBody;
  const recBody = recs.length ? recs.length * REC_ROW_H : REC_ROW_H;
  const noteTop = recTop + REC_HEAD_H + recBody;
  const noteBody = NOTE_HEAD_H + Math.max(1, noteLines.length) * NOTE_LINE_H;
  const footStart = noteTop + noteBody;
  const H = footStart + FOOT_H;
  return { H, rows, recs, modTop, recTop, noteTop, noteLines, footStart };
}

/** 圆角矩形（canvas 2d 没有 border-radius，自己画路径） */
function roundRect(ctx, x, y, w, h, rad) {
  const rr = Math.min(rad, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 分数档位色（与页面 cls-bc-module-{done|warn|missing|skip} 的语义一致） */
function stateColor(state) {
  if (state === 'entered') return C.text;
  if (state === 'missing') return C.warn;
  return C.text3;
}

/**
 * 在画布上画整张报表。
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} r 服务端 report 响应
 * @param {object} plan planLayout() 的结果
 */
function draw(ctx, r, plan) {
  // 背景
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, plan.H);

  // ===== 标题区：品牌色块 + 班级 + 区间 + 大号分数 =====
  ctx.fillStyle = C.brandSoft;
  ctx.fillRect(0, 0, W, TITLE_H);
  ctx.fillStyle = C.brand;
  ctx.fillRect(0, 0, 8, TITLE_H);

  ctx.fillStyle = C.text;
  ctx.font = 'bold 34px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(String(r.className || ''), PAD, 26);

  ctx.fillStyle = C.text2;
  ctx.font = '22px sans-serif';
  const sub = [r.rangeWord, r.periodSpan, r.departmentName].filter(Boolean).join(' · ');
  ctx.fillText(sub, PAD, 74);

  // 右上角分数（没有记录时写「—」，不能写 0 分成真）
  const scoreVal = r.score === null || r.score === undefined ? '—' : String(r.scoreText || '—');
  ctx.textAlign = 'right';
  ctx.fillStyle = scoreVal === '—' ? C.text3 : C.brand;
  ctx.font = 'bold 58px sans-serif';
  ctx.fillText(scoreVal, W - PAD, 30);
  ctx.fillStyle = C.text3;
  ctx.font = '20px sans-serif';
  ctx.fillText(`班超分 / ${r.fullScore || 10}`, W - PAD, 96);
  ctx.textAlign = 'left';

  // ===== 检查明细 =====
  let y = plan.modTop;
  ctx.fillStyle = C.text;
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText('检查明细', PAD, y + 10);
  ctx.fillStyle = C.text3;
  ctx.font = '20px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`${r.recordCount || 0} 条记录 · ${r.dayCount || 0} 天`, W - PAD, y + 12);
  ctx.textAlign = 'left';
  y += HEAD_H;

  if (plan.rows.length) {
    for (const m of plan.rows) {
      // 行分隔线
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD, y + ROW_H - 1);
      ctx.lineTo(W - PAD, y + ROW_H - 1);
      ctx.stroke();

      ctx.fillStyle = C.text;
      ctx.font = '24px sans-serif';
      ctx.fillText(m.name, PAD, y + 10);

      ctx.fillStyle = C.text3;
      ctx.font = '19px sans-serif';
      ctx.fillText(m.metricText || '', PAD, y + 38);

      // 右侧：得分 / 扣分
      ctx.textAlign = 'right';
      if (m.state === 'entered') {
        ctx.fillStyle = m.deduct > 0 ? C.bad : C.good;
        ctx.font = 'bold 26px sans-serif';
        ctx.fillText(`${m.scoreText} 分`, W - PAD, y + 10);
        if (m.deduct > 0) {
          ctx.fillStyle = C.bad;
          ctx.font = '19px sans-serif';
          ctx.fillText(m.deductText, W - PAD, y + 38);
        }
      } else {
        ctx.fillStyle = stateColor(m.state);
        ctx.font = '22px sans-serif';
        ctx.fillText(m.stateText, W - PAD, y + 18);
      }
      ctx.textAlign = 'left';
      y += ROW_H;
    }
  } else {
    ctx.fillStyle = C.text3;
    ctx.font = '22px sans-serif';
    ctx.fillText('暂无检查模块', PAD, y + 14);
    y += ROW_H;
  }

  // ===== 最近记录 =====
  y = plan.recTop;
  ctx.fillStyle = C.text;
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText('最近记录', PAD, y + 8);
  y += REC_HEAD_H;
  if (plan.recs.length) {
    for (const rec of plan.recs) {
      ctx.fillStyle = C.text3;
      ctx.font = '19px sans-serif';
      ctx.fillText(shortDate(rec.date), PAD, y + 11);
      ctx.fillStyle = C.text;
      ctx.font = '21px sans-serif';
      ctx.fillText(rec.moduleName || '', PAD + 92, y + 10);
      ctx.textAlign = 'right';
      const tail = [rec.scoreText ? `${rec.scoreText} 分` : '', rec.deduct > 0 ? `扣 ${fmt2(rec.deduct)}` : '']
        .filter(Boolean)
        .join(' ');
      ctx.fillStyle = rec.deduct > 0 ? C.bad : C.text3;
      ctx.font = '19px sans-serif';
      ctx.fillText(tail, W - PAD, y + 11);
      ctx.textAlign = 'left';
      y += REC_ROW_H;
    }
  } else {
    ctx.fillStyle = C.text3;
    ctx.font = '22px sans-serif';
    ctx.fillText('本期没有检查记录', PAD, y + 8);
  }

  // ===== 口径说明（必须画：群里的人看不到页面脚注）=====
  y = plan.noteTop;
  ctx.fillStyle = C.text;
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText('口径说明', PAD, y + 6);
  y += NOTE_HEAD_H;
  ctx.fillStyle = C.text2;
  ctx.font = '18px sans-serif';
  if (plan.noteLines.length) {
    for (const line of plan.noteLines) {
      ctx.fillText(line, PAD, y + 4);
      y += NOTE_LINE_H;
    }
  } else {
    ctx.fillStyle = C.text3;
    ctx.fillText('—', PAD, y + 4);
  }

  // ===== 落款 =====
  ctx.fillStyle = C.text3;
  ctx.font = '18px sans-serif';
  ctx.fillText('唐唐快跑 · 我的班级 · 班超联赛', PAD, plan.footStart + 16);
}

/** 「2026-11-16」→「11/16」 */
function shortDate(dayKey) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  return m ? `${Number(m[1])}/${Number(m[2])}` : String(dayKey || '');
}

/** 两位小数（与页面 scoreText 同口径；只给图片用，页面数字仍由服务端下发） */
function fmt2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '—';
}

module.exports = {
  W,
  C,
  NOTE_LINE_CHARS,
  planLayout,
  draw,
  wrapText,
  shortDate,
  fmt2,
};
