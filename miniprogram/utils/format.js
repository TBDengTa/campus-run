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

// 按北京时区取 {y, m, d, h, min}
function partsInTz(v) {
  const date = toDate(v);
  if (!date) return null;
  let y;
  let m;
  let d;
  let h;
  let min;
  try {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (t) => (p.find((x) => x.type === t) || {}).value;
    y = Number(get('year'));
    m = Number(get('month'));
    d = Number(get('day'));
    h = Number(get('hour'));
    min = Number(get('minute'));
    if (h === 24) h = 0; // 部分实现会给 24:00
  } catch (e) {
    // 极老基础库没有 Intl 时区支持 → 退回本地时间（中国用户本地即 +08:00）
    y = date.getFullYear();
    m = date.getMonth() + 1;
    d = date.getDate();
    h = date.getHours();
    min = date.getMinutes();
  }
  return { y, m, d, h, min };
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

// dateKey → {y, m, d, week}
function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  const week = ['日', '一', '二', '三', '四', '五', '六'][new Date(y, m - 1, d).getDay()];
  return { y, m, d, week: `周${week}` };
}

// 记录来源展示（run_records.source）：微信运动 / GPS 实跑 / 北斗（激励视频奖励步数）
const SOURCE_MAP = {
  werun: { sourceText: '微信运动', sourceIcon: 'logo-wechat-stroke' },
  gps: { sourceText: 'GPS 实跑', sourceIcon: 'location' },
  beidou: { sourceText: '北斗', sourceIcon: 'map-aiming' },
};

// 统一来源文案与图标，避免各页面各写一套三元表达式
function sourceOf(source) {
  return SOURCE_MAP[source] || { sourceText: '运动记录', sourceIcon: 'chart-bar' };
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
  parseDateKey,
  sourceOf,
  SOURCE_MAP,
};
