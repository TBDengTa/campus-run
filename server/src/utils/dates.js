// 日期工具：日历键统一为 YYYY-MM-DD 字符串（按本地时区）
function toDateKey(d) {
  const date = d instanceof Date ? d : new Date(d);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayKey() {
  return toDateKey(new Date());
}

function addDays(dateKey, days) {
  const d = new Date(`${dateKey}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toDateKey(d);
}

// dateKey 所在月的起止（闭区间，用于查询）
function monthRange(monthKey) {
  // monthKey: YYYY-MM
  const [y, m] = monthKey.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 1);
  return { start, end, startKey: toDateKey(start), endKey: toDateKey(new Date(end.getTime() - 1)) };
}

function isValidDateKey(key) {
  return /^\d{4}-\d{2}-\d{2}$/.test(key || '');
}

module.exports = { toDateKey, todayKey, addDays, monthRange, isValidDateKey };
