// 「当月第 N 周」的日期口径（前端唯一实现，与 server/src/services/band-chao.js::monthWeekRange 同源）
//
// 为什么不是 ISO 周：排名页 / 我的班级页的「第 N 周」都要按**月份**锚定，
// 否则选「10月 第1周」可能把 9 月最后两天也算进来，两个页面还可能算出不同区间。
// 口径（与服务端逐字对齐）：
//   · 从当月 1 日起算，每 7 天为一周：1-7 日为第 1 周、8-14 日为第 2 周 …；
//   · **周是完整 7 天，不按月末截断** —— 最后一周跨到下月（10月第5周 = 10月29日至11月4日）；
//   · 周数上限 = ceil(当月天数 / 7)（2 月 28 天 → 4 周；30 天 → 5 周；31 天 → 5 周）；
//   · 越界的周数一律夹到 [1, maxWeek]（服务端也是这么夹的，两端不会打架）。
//
// 展示口径（用户要求）：周选择器要带日期段，如「第2周(10月8日至10月14日)」；
// 跨月时日期自带月份（「9月29日至10月5日」）—— 不写月份会歧义。
//
// 用法：
//   monthWeekOptions(2026, 10)  → [{ value:2, label:'第2周(10月8日至10月14日)', from, to }]
//   monthWeekRange(2026, 10, 2) → { weekNo:2, maxWeek:5, from:'2026-10-08', to:'2026-10-14', text:'10月8日至10月14日' }
//   dateRangeText('2026-10-08','2026-10-14') → '10月8日至10月14日'

const pad2 = (n) => String(n).padStart(2, '0');

// 当月天数（month 是 1-12；day 0 = 上个月最后一天，所以传 month 即得本月天数）
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// 当月最多几周（1-7 为第 1 周…，与 monthWeekRange 的夹取口径一致）
function maxWeekOfMonth(year, month) {
  return Math.ceil(daysInMonth(year, month) / 7);
}

// 「10月8日」（无效输入返回空串，交给调用方决定兜底文案）
function md(dateKey) {
  const k = String(dateKey || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return '';
  return `${Number(k.slice(5, 7))}月${Number(k.slice(8, 10))}日`;
}

// 日期键加天数（本地时区，不用 toISOString 免得差一天 —— 与 utils/format.js 同一口径）
function addDays(dateKey, days) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

// 区间文案：同一天只显示一天；跨月时两端都带月份（「9月29日至10月5日」）
function dateRangeText(from, to) {
  const a = md(from);
  const b = md(to);
  if (!a) return b;
  if (!b) return a;
  if (from === to) return a;
  return `${a}至${b}`;
}

// 当月第 N 周（从当月 1 日起算的第 N 个**完整 7 天**区间）。
// **不按月末截断**（用户明确要求「周要完整的日期，不要跟随月截断」）：
// 例如 10 月第 5 周 = 10月29日 至 11月4日，而不是被截成 10月29日至10月31日。
// 因此最后一周会跨到下个月，区间文案两端带月份才不歧义（「10月29日至11月4日」）。
// 编号口径不变：1-7 日为第 1 周、8-14 日为第 2 周 …，周数上限 = ceil(当月天数 / 7)。
function monthWeekRange(year, month, weekNo) {
  const maxWeek = maxWeekOfMonth(year, month);
  const n = Math.min(maxWeek, Math.max(1, Number(weekNo) || 1));
  const start = addDays(`${year}-${pad2(month)}-01`, (n - 1) * 7);
  const to = addDays(start, 6); // 完整 7 天，跨月不截断
  return { weekNo: n, maxWeek, from: start, to, text: dateRangeText(start, to) };
}

// 周选择项（picker 的 range）：label 直接带日期段，用户不用心算第 2 周是哪几天
function monthWeekOptions(year, month) {
  const maxWeek = maxWeekOfMonth(year, month);
  return Array.from({ length: maxWeek }, (_, i) => {
    const r = monthWeekRange(year, month, i + 1);
    return { value: i + 1, label: `第${i + 1}周(${r.text})`, from: r.from, to: r.to, weekNo: i + 1 };
  });
}

// 「12月」这类月份文案（picker range 用）
function monthOptions(year) {
  const y = Number(year) || new Date().getFullYear();
  return Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `${i + 1}月`, year: y }));
}

// 某个日期落在当月的第几周（用于「今天在第 N 周」的默认选中）
function weekNoOfDate(year, month, dateKey) {
  const d = Number(String(dateKey || '').slice(8, 10)) || 1;
  return Math.min(maxWeekOfMonth(year, month), Math.max(1, Math.ceil(d / 7)));
}

module.exports = {
  pad2,
  md,
  addDays,
  dateRangeText,
  daysInMonth,
  maxWeekOfMonth,
  monthWeekRange,
  monthWeekOptions,
  monthOptions,
  weekNoOfDate,
};
