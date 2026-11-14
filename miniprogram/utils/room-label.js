/**
 * 「楼名·房号」的拆分与归一 —— **服务端 services/dorms.js 的前端副本，口径必须逐条一致**。
 *
 * 为什么必须单点（用户 2026-11-14「检查录入里洋河校区的宿舍楼栋显示出现 BUG」）：
 *   系统设置的宿舍用楼清单里有**楼名自带连字符**的项（线上实测：「洋河-男宿」「洋河-女宿」）。
 *   两个宿舍弹窗（components/dorm-sheet 与 components/room-dialog）原来都是一上来就按
 *   `[·・\-—/、,\s]` 切「楼名·房号」——「洋河-女宿·301」于是被拆成楼名「洋河」+ 房号「女宿301」。
 *   房号从此带着性别字样落库；下次打开回显成「洋河·女宿301」，用户再点一次标准楼名保存，
 *   就拼成「洋河-女宿·女宿301」→ 再被切开 → 房号「女宿女宿301」……
 *   **每保存一次多叠一层**，线上实测叠到 7 层（`女宿女宿女宿女宿女宿女宿女宿301`），
 *   检查录入台的查宿对象列表因此冒出上百个「幽灵房间」。
 *
 * 拆分优先级（与服务端 parseRoomLabel 一致）：
 *   ① 白名单楼名**最长前缀**匹配 —— 唯一能正确处理楼名自带 `-` 的依据；
 *   ② 规范分隔符「·」（服务端 roomLabel 拼的就是它）；
 *   ③ 旧写法兜底：任意分隔符（空格 / 连字符 / 斜杠 / 逗号）。
 *
 * ⚠️ 服务端有同名逻辑（server/src/services/dorms.js::parseRoomLabel）。改一处必须改另一处，
 *    否则会出现「界面显示 301、落库是 女宿301」这种最难查的两端漂移。
 *    回归：tools/check-room-label.js（两端用同一批用例逐条对比）。
 */

// 楼名里的性别标记（楼名带它时，房号里重复的性别字样一律剥掉）
const GENDER_TOKEN = /^(男宿|女宿)+/;
// 规范分隔符
const CANON_SEP = /[·・]/;
// 旧写法里的任意分隔符
const LEGACY_SEP = /[·・\-—/、,\s]+/;

/**
 * 房号归一：剥掉与楼名重复的性别字样（详见文件头）。
 *   · 楼名已带性别（洋河-女宿 / 1号楼(女生宿舍)）→ 房号里的性别前缀全部剥掉；
 *   · 楼名没带性别（旧数据「洋河」）→ 只保留**最后一个**性别词
 *     （污染是「在原有房号前再加一层」，末尾那个才是原始房号里本来就有的）；
 *   · 纯数字房号原样返回。
 */
function normalizeRoomNo(roomNo, buildingName) {
  const text = String(roomNo === undefined || roomNo === null ? '' : roomNo).trim();
  const buildingHasGender = /男宿|女宿/.test(String(buildingName || ''));
  // 一次性取出**所有**开头的性别词，不要边剥边重新匹配：
  // 「女宿女宿301」剥掉第一层后剩下「女宿301」，还会再命中 —— 用 while 重匹配很容易写成死循环。
  const head = text.match(/^(?:男宿|女宿)+/);
  if (!head) return text;
  const tail = text.slice(head[0].length);
  if (buildingHasGender) return tail.trim();
  // 楼名没带性别（旧数据「洋河」）：保留末尾那个性别词 —— 污染是在前面叠的，
  // 末尾那个才是原始房号里本来就有的。
  const tokens = head[0].match(/男宿|女宿/g) || [];
  return `${tokens[tokens.length - 1]}${tail}`.trim();
}

/**
 * 拆分「楼名·房号」。
 * @param {string} raw        形如「洋河-女宿·301」
 * @param {string[]} buildings 系统设置的宿舍用楼清单（楼名字符串数组，也可传 [{name}]）
 * @returns {{building:string, roomNo:string}}
 */
function splitRoomLabel(raw, buildings) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) return { building: '', roomNo: '' };
  const names = (buildings || [])
    .map((b) => (typeof b === 'string' ? b : (b && b.name) || ''))
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    // 长名优先：「洋河-女宿」必须先于「洋河」命中，否则长楼名的后半截会被当成房号
    .sort((a, b) => b.length - a.length);

  const make = (building, room) => {
    const b = String(building || '').trim();
    return { building: b, roomNo: normalizeRoomNo(room, b) };
  };

  // ① 白名单最长前缀
  for (const name of names) {
    if (text === name) return make(name, '');
    if (text.startsWith(name)) {
      const rest = text.slice(name.length).replace(LEGACY_SEP, '').trim();
      if (rest) return make(name, rest);
    }
  }

  // ② 规范分隔符「·」：只切第一个，楼名里的 `-` `(` `)` 一律不动
  const dotAt = text.search(CANON_SEP);
  if (dotAt > 0) {
    const building = text.slice(0, dotAt).trim();
    const room = text.slice(dotAt + 1).replace(CANON_SEP, '').trim();
    if (building) return make(building, room);
  }

  // ③ 旧写法兜底：没有 `·` 时才按任意分隔符切
  const parts = text.split(LEGACY_SEP).filter(Boolean);
  if (parts.length >= 2) return make(parts[0], parts.slice(1).join(''));
  return make('', text);
}

module.exports = { splitRoomLabel, normalizeRoomNo };
