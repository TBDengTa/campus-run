// 展示格式化工具
//
// ⚠️ 时间一律按**北京时间（Asia/Shanghai）**展示，不看设备/服务器时区
//   （用户 2026-10-27 报「今天同步的会有 22 点的奇怪时间 今天都没有 22 点呢」）。
//
// 事故成因（务必别再踩）：
//   后端把 BSON Date 序列化成 UTC ISO 串（如 `2026-10-26T22:30:00.000Z`），
//   而旧代码用 `s.match(/T(\d{2}:\d{2})/)` **直接从字符串里抠 HH:mm** ——
//   于是北京时间 10-27 06:30 的记录被显示成「10-26 22:30」，日期与时间一起错，
//   用户看到的就是「今天出现了 22 点」这种不可能的时间。
//
// 正确做法：先解析成 Date 再按 Asia/Shanghai 取字段，**绝不从 ISO 串里抠时间**。
const TZ = 'Asia/Shanghai';

// 任意输入（Date / ISO 串 / 时间戳）→ Date；非法返回 null
function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// 按北京时区取 {y, m, d, h, min, sec}
// sec 只有 formatWatermarkTime（水印相机）用；其余调用方忽略即可
function partsInTz(v) {
  const date = toDate(v);
  if (!date) return null;
  let y;
  let m;
  let d;
  let h;
  let min;
  let sec;
  try {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (t) => (p.find((x) => x.type === t) || {}).value;
    y = Number(get('year'));
    m = Number(get('month'));
    d = Number(get('day'));
    h = Number(get('hour'));
    min = Number(get('minute'));
    sec = Number(get('second'));
    if (h === 24) h = 0; // 部分实现会给 24:00
  } catch (e) {
    // 极老基础库没有 Intl 时区支持 → 退回本地时间（中国用户本地即 +08:00）
    y = date.getFullYear();
    m = date.getMonth() + 1;
    d = date.getDate();
    h = date.getHours();
    min = date.getMinutes();
    sec = date.getSeconds();
  }
  return { y, m, d, h, min, sec };
}

function formatNumber(n) {
  const num = Number(n) || 0;
  return num.toLocaleString('zh-CN');
}

// 米 → 展示（>=1000m 显示 km）
function formatDistance(meters) {
  const m = Number(meters) || 0;
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${Math.round(m)} m`;
}

// 秒 → "hh:mm:ss" 或 "mm:ss"
function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

// 字节 → 展示（KB / MB）
function formatSize(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

// 日期键 YYYY-MM-DD（北京时区；不传参数 = 今天）
function todayKey(d = new Date()) {
  const p = partsInTz(d);
  if (!p) return '';
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// HH:mm（北京时区）—— **替代所有「从 ISO 串抠 T\d{2}:\d{2}」的写法**
function formatClock(v) {
  const p = partsInTz(v);
  if (!p) return '';
  return `${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
}

// 完整时间 YYYY-MM-DD HH:mm（北京时区）
function formatDateTime(v) {
  const p = partsInTz(v);
  if (!p) return '';
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${formatClock(v)}`;
}

// 水印相机专用：YYYY-MM-DD 周X HH:mm:ss（北京时区，含秒含周几）
// 唯一实现（docs/watermark-camera-plan.md §4）：页面禁止从 ISO 串切片拼时间。
// 周几按北京时区日历日期算（用 UTC 构造避免依赖设备时区——y/m/d 已是北京日期）。
function formatWatermarkTime(v) {
  const p = partsInTz(v);
  if (!p) return '';
  const week = '日一二三四五六'[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
  const pad = (x) => String(x).padStart(2, '0');
  return `${p.y}-${pad(p.m)}-${pad(p.d)} 周${week} ${pad(p.h)}:${pad(p.min)}:${pad(p.sec)}`;
}

// dateKey → {y, m, d, week}
function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  const week = ['日', '一', '二', '三', '四', '五', '六'][new Date(y, m - 1, d).getDay()];
  return { y, m, d, week: `周${week}` };
}

// 记录来源展示（run_records.source）：微信运动 / GPS 实跑 / 北斗（转盘抽奖与签到阶梯奖励的步数）
const SOURCE_MAP = {
  werun: { sourceText: '微信运动', sourceIcon: 'logo-wechat-stroke' },
  gps: { sourceText: 'GPS 实跑', sourceIcon: 'location' },
  beidou: { sourceText: '北斗', sourceIcon: 'map-aiming' },
};

// 统一来源文案与图标，避免各页面各写一套三元表达式
function sourceOf(source) {
  return SOURCE_MAP[source] || { sourceText: '运动记录', sourceIcon: 'chart-bar' };
}

// ===== 反作弊研判指标换算（2026-11-03 小程序对齐 Web 控制台详情）=====
// 与 server/public/console/app.js 的同名函数保持同一口径；≤0 或非法一律显「—」，
// 否则「0 km/h」会被读成「站着不动」而不是「没有数据」。

// m/s → "xx.x km/h"
function kmh(mps) {
  const v = Number(mps);
  if (!v || v <= 0 || !Number.isFinite(v)) return '—';
  return `${(v * 3.6).toFixed(1)} km/h`;
}

// 秒/公里 → 12'03"（配速）
function paceText(secPerKm) {
  const v = Number(secPerKm);
  if (!v || v <= 0 || !Number.isFinite(v)) return '—';
  const m = Math.floor(v / 60);
  const s = Math.round(v % 60);
  return `${m}'${String(s).padStart(2, '0')}"`;
}

// 数值 → 固定两位小数（轨迹平滑度 / 点间隔这类小数指标）
function num2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '—';
}

/**
 * 班超分数（10 分制，用户 2026-11-12「不要满分100分制了」）→ 展示文案。
 *
 * 两条都是踩过的坑：
 *  ① **必须两位小数**：10 分制下「迟到 1 人」只扣 0.05 分，一位小数会把 9.95 收成 10.0，
 *     录入人以为「提交了但没生效」；百分制时代 0.5 分粒度看不出这个问题。
 *  ② **没有数据 ≠ 0 分**：`Number(null) === 0` 是有限数，所以不能直接把 num2 当分数格式化器用
 *     —— 那会把「这个班今天没有任何检查记录」显示成「0.00 分」，而 0 分是最严重的差评，
 *     会被截图发进工作群。null / undefined / 非法一律显「—」。
 */
function scoreText(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '—';
}

module.exports = {
  TZ,
  toDate,
  partsInTz,
  formatNumber,
  formatDistance,
  formatDuration,
  formatSize,
  todayKey,
  formatClock,
  formatDateTime,
  formatWatermarkTime,
  parseDateKey,
  sourceOf,
  SOURCE_MAP,
  kmh,
  paceText,
  num2,
  scoreText,
};
