// 展示格式化工具
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

function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

module.exports = { formatNumber, formatDistance, formatDuration, formatSize, todayKey, parseDateKey, sourceOf, SOURCE_MAP };
