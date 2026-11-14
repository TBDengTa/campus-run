/**
 * 宿舍与混宿归属的服务层（学生 ↔ 房间，不是班级 ↔ 房间）
 *
 * 为什么必须强调这一点（用户明确纠正过）：一个房间可能住**多个班的学生（混宿）**，
 * 所以「谁住哪间」只能绑在学生身上（dorm_assignments），绑到班级上必然记错。
 * 房间的 dorm_rooms.className 只是「默认归属班」（无名单时的兜底展示），不参与计分归属。
 */
const mongoose = require('mongoose');
const DormRoom = require('../models/dorm-room');
const DormAssignment = require('../models/dorm-assignment');
const User = require('../models/user');

const str = (v, max = 40) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

// 旧写法里的「任意分隔符」（空格 / 连字符 / 斜杠 / 逗号）：**只在拿不到更可靠依据时**才用。
// ⚠️ 绝不能一上来就按它切：系统设置里的楼名本身就可能带 `-`（线上白名单实测有
//   「洋河-男宿 / 洋河-女宿」）。按 `-` 切会把「洋河-女宿·301」拆成楼名「洋河」+ 房号「女宿301」，
//   房号从此带着性别字样落库；下一次回显成「洋河·女宿301」、再点一次标准楼名就变成
//   「洋河-女宿·女宿301」→ 房号「女宿女宿301」…… 每保存一次多叠一层。线上实测叠到 7 层
//   （`女宿女宿女宿女宿女宿女宿女宿301`），检查录入台因此列出上百个「幽灵房间」。
const LEGACY_SEP = /[·・\-—/、,\s]+/;
// 规范分隔符：`roomLabel()` 拼出来的就是它，解析必须**优先**认它
const CANON_SEP = /[·・]/;
// 楼名里的性别标记（白名单楼名带它时，房号里重复的性别字样一律剥掉）
const GENDER_TOKEN = /^(男宿|女宿)+/;

// 系统设置的「宿舍用楼」清单（解析楼名时要靠它做最长前缀匹配，否则楼名里的 `-` 无从消歧）。
// 60s 进程内缓存：清单只在管理端改，读一次库即可；取不到就退回空数组（不阻塞绑定）。
let buildingCache = { at: 0, names: [] };
const BUILDING_TTL = 60 * 1000;

async function configuredBuildingNames() {
  if (buildingCache.names.length && Date.now() - buildingCache.at < BUILDING_TTL) return buildingCache.names;
  try {
    const GoalConfig = require('../models/goal-config');
    const cfg = await GoalConfig.getSingleton();
    const names = ((cfg && cfg.buildings && cfg.buildings.dorm) || [])
      .map((s) => String(s == null ? '' : s).trim())
      .filter(Boolean);
    buildingCache = { at: Date.now(), names };
    return names;
  } catch (e) {
    // 读配置失败不该让「填宿舍」整个不可用：沿用上一次的清单（没有就空数组）
    return buildingCache.names || [];
  }
}

/**
 * 房号归一：剥掉与楼名重复的性别字样。
 *
 * 背景：楼名「洋河-女宿」+ 房号「女宿301」是同一个房间的两种写法（历史上被拆坏过）。
 *   · 楼名已带性别（洋河-女宿 / 1号楼(女生宿舍) 这类）→ 房号里所有连续性别前缀全部剥掉；
 *   · 楼名没带性别（旧数据里的「洋河」）→ 只保留**最后一个**性别词
 *     （污染是「在原有房号前面再加一层」，所以末尾那个才是原始房号里的）；
 *   · 纯数字房号原样返回。
 */
function normalizeRoomNo(roomNo, buildingName) {
  const text = String(roomNo == null ? '' : roomNo).trim();
  const buildingHasGender = /男宿|女宿/.test(String(buildingName || ''));
  // 一次性取出**所有**开头的性别词，不要边剥边重新匹配：
  // 「女宿女宿301」剥掉第一层后剩下「女宿301」，还会再命中 —— 用 while 重匹配极容易写成死循环
  // （本轮就踩过：整个绑定接口挂住，表现为「保存一直转圈」）。
  const head = text.match(GENDER_TOKEN);
  if (!head) return text;
  const tail = text.slice(head[0].length);
  if (buildingHasGender) return tail.trim();
  // 楼名没带性别（旧数据「洋河」）：保留末尾那个性别词 —— 污染是在前面叠的，
  // 末尾那个才是原始房号里本来就有的。
  const tokens = head[0].match(/男宿|女宿/g) || [];
  return `${tokens[tokens.length - 1]}${tail}`.trim();
}

/**
 * 解析「楼号·门号」为楼栋 + 房号（管理端只填一栏也能存对）。
 * 支持的输入：「1号楼·201」/「1号楼 201」/「1号楼-201」/「A201」/「201」
 *   · 拆不出楼栋时 roomNo 取整串（与原字段口径一致，避免把用户的输入改坏）
 *   · 拆得出来就两栏分开存：以后按楼栋筛选、按房间查宿都要靠 buildingId
 *
 * 拆分优先级（改这里之前先读文件头那段落库事故）：
 *   ① 白名单楼名**最长前缀**匹配（唯一能正确处理楼名自带 `-` 的依据）；
 *   ② 规范分隔符「·」（roomLabel 拼的就是它）—— 即使拿不到白名单也不会拆错；
 *   ③ 旧写法兜底：任意分隔符（空格 / 连字符 / 斜杠 / 逗号）。
 *
 * @param {string} input 「楼名·房号」
 * @param {{buildings?: string[]}} [opts] buildings = 系统设置的宿舍用楼清单
 */
function parseRoomLabel(input, opts = {}) {
  // ⚠️ 防「对象被当字符串用」产生的脏数据（用户 2026-10-26 报：宿舍里出现
  //   楼名「[object」、房号「Object]9901」—— 就是某次把对象直接拼进字符串造成的）。
  //   String({}) === '[object Object]'，再按分隔符切就得到「[object」+「Object]9901」。
  //   这类输入一律当非法：宁可让录入人重填，也不要把垃圾写进 dorm_rooms
  //   （脏楼名会污染整个「楼栋」下拉，且按楼栋筛选/统计全部失真）。
  if (input && typeof input === 'object') {
    throw new Error('宿舍号格式不正确（收到的是对象，请传「1号楼·201」这样的字符串）');
  }
  const raw = str(input, 60);
  const empty = { buildingId: '', buildingName: '', roomNo: '' };
  if (!raw) return empty;
  if (/\[object/i.test(raw)) {
    throw new Error('宿舍号格式不正确（不要把对象当宿舍号提交），请填写「1号楼·201」');
  }
  const make = (building, room) => {
    const b = str(building, 30);
    return {
      buildingId: b.slice(0, 20),
      buildingName: b,
      roomNo: str(normalizeRoomNo(room, b), 20),
    };
  };

  // ① 白名单楼名最长前缀（长名优先：「洋河-男宿」要先于「洋河」命中）
  const names = (Array.isArray(opts.buildings) ? opts.buildings : [])
    .map((n) => str(n, 30))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (raw === name) return make(name, '');
    if (raw.startsWith(name)) {
      const rest = raw.slice(name.length).replace(LEGACY_SEP, '').trim();
      if (rest) return make(name, rest);
    }
  }

  // ② 规范分隔符「·」：只切**第一个**，楼名里的 `-` `(` `)` 一律不动
  const dotAt = raw.search(CANON_SEP);
  if (dotAt > 0) {
    const building = raw.slice(0, dotAt).trim();
    const room = raw.slice(dotAt + 1).replace(CANON_SEP, '').replace(/^[·・]+/, '').trim();
    if (building) return make(building, room);
  }

  // ③ 旧写法兜底（「1号楼-201」「1号楼 201」）：没有 `·` 时才按任意分隔符切
  const parts = raw.split(LEGACY_SEP).filter(Boolean);
  if (parts.length >= 2) return make(parts[0], parts.slice(1).join(''));
  return make('', raw);
}

// 房间的展示名：楼号·门号（前端与导出统一走这个，不要各处自己拼）
// ⚠️ 在这里也做一次房号归一：存量脏数据（「洋河」+「女宿女宿301」）读出来时要显示成
//   正常人看得懂的「洋河·女宿301」，而不是把 7 层前缀原样摆上检查录入台。
//   归一**只影响展示**，真正落库的纠正由 scripts/fix-dorm-room-dup-prefix.js 负责。
function roomLabel(a) {
  const b = a.buildingName || a.buildingId || '';
  const r = normalizeRoomNo(a.roomNo, b);
  if (b && r) return `${b}·${r}`;
  return b || r || '';
}

/**
 * 找到（或新建）「楼名 + 房号」对应的房间，**并顺手认领历史脏房间**。
 *
 * 为什么不能只做 `findOne({buildingId, roomNo})`：库里有被拆坏的历史房间
 * （`洋河` + `女宿301` / `女宿女宿301` / …），而正确写法是 `洋河-女宿` + `301`。
 * 只按精确键查会「正确键查不到 → 再新建一间」—— 房间数只增不减，查宿列表越滚越长。
 *
 * 认领规则（按优先级，命中即复用）：
 *   ① 精确键（buildingId + roomNo）；
 *   ② 同楼名、房号（剥掉重复性别词后）相同的房间 —— 必须**性别一致**：
 *      门号 301 同时存在 男宿301 与 女宿301 是两间不同的房，合并会把男生塞进女生宿舍。
 *   ③ 只看房号且房间没有楼栋（历史数据没建楼栋）—— 与旧实现同口径。
 *
 * @returns {{room:object, createdRoom:boolean}}
 */
async function findOrCreateRoom(parsed, student) {
  const enabledOnly = { enabled: { $ne: false } };
  const exact = await DormRoom.findOne({ buildingId: parsed.buildingId, roomNo: parsed.roomNo, ...enabledOnly }).lean();
  if (exact) return { room: exact, createdRoom: false };

  // ② 同楼名下的「脏房号」认领：只比数字门号 + 性别标记，绝不跨性别
  const wantGender = (String(parsed.roomNo).match(/男宿|女宿/g) || []).slice(-1)[0] || '';
  const wantDigits = (String(parsed.roomNo).match(/\d+/) || [])[0] || '';
  if (wantDigits) {
    const peers = await DormRoom.find({ buildingId: parsed.buildingId, ...enabledOnly })
      .select('buildingId buildingName roomNo')
      .lean();
    const hit = peers.find((r) => {
      const g = (String(r.roomNo).match(/男宿|女宿/g) || []).slice(-1)[0] || '';
      const d = (String(r.roomNo).match(/\d+/) || [])[0] || '';
      return d === wantDigits && g === wantGender;
    });
    if (hit) {
      // 认领后把房号纠正为规范写法（脏房号只该出现在历史里，不该继续被写）：
      // 只改房号文本，不动 roomId 引用（在住记录仍指向同一间房，历史不丢）
      if (hit.roomNo !== parsed.roomNo) {
        await DormRoom.updateOne({ _id: hit._id }, { $set: { roomNo: parsed.roomNo, buildingName: parsed.buildingName } });
        hit.roomNo = parsed.roomNo;
        hit.buildingName = parsed.buildingName;
      }
      return { room: hit, createdRoom: false };
    }
  }

  // ③ 没有楼栋的老房间（同房号）：复用，避免同一间房建两条
  const byNo = await DormRoom.findOne({
    roomNo: parsed.roomNo,
    $or: [{ buildingId: '' }, { buildingId: null }],
    ...enabledOnly,
  }).lean();
  if (byNo) return { room: byNo, createdRoom: false };

  const room = await DormRoom.create({
    buildingId: parsed.buildingId,
    buildingName: parsed.buildingName,
    roomNo: parsed.roomNo,
    // 房间的默认班级只是兜底展示；真实归属看 dorm_assignments（混宿时一间房会有多个班）
    className: student.className || '',
    departmentId: student.departmentId || null,
    departmentName: student.departmentName || '',
  });
  return { room: room.toObject ? room.toObject() : room, createdRoom: true };
}

/**
 * 给一个学生绑定房间（找不到房间就按「楼号·门号」自动建档）。
 * 换房自动把旧记录置 moved —— 保持「一人只有一条在住记录」的库层唯一约束成立。
 * @returns {{room:object, createdRoom:boolean, movedFrom:string}}
 */
async function assignStudentRoom({ student, roomId, roomLabel: label, bedNo = '' }) {
  if (!student || !student._id) throw new Error('缺少学生');
  let room = null;
  let createdRoom = false;

  if (roomId) {
    if (!mongoose.isValidObjectId(roomId)) throw new Error('房间不存在');
    room = await DormRoom.findById(roomId).lean();
    if (!room) throw new Error('房间不存在');
  } else if (label) {
    // 楼名解析必须带白名单：「洋河-女宿·301」的楼名里自带 `-`，不靠清单会拆成「洋河」+「女宿301」
    const parsed = parseRoomLabel(label, { buildings: await configuredBuildingNames() });
    if (!parsed.roomNo) throw new Error('请填写宿舍号（如 1号楼·201）');
    room = await findOrCreateRoom(parsed, student);
    createdRoom = !!room.createdRoom;
    room = room.room;
  } else {
    throw new Error('请选择或填写宿舍号');
  }

  const active = await DormAssignment.findOne({ openid: student.openid, status: { $in: ['checked_in', 'guest'] } });
  let movedFrom = '';
  if (active) {
    if (String(active.roomId) === String(room._id) && (active.bedNo || '') === (bedNo || '') && active.status === 'checked_in') {
      return { room, createdRoom: false, movedFrom: '' };
    }
    movedFrom = roomLabel(active);
    active.status = 'moved';
    active.movedTo = roomLabel({ buildingName: room.buildingName, buildingId: room.buildingId, roomNo: room.roomNo });
    await active.save();
  }

  const doc = await DormAssignment.create({
    userId: student._id,
    openid: student.openid || '',
    realName: student.realName || student.nickname || student.account || '',
    studentId: student.studentId || '',
    className: student.className || '',
    roomId: room._id,
    buildingId: room.buildingId,
    buildingName: room.buildingName,
    roomNo: room.roomNo,
    bedNo: str(bedNo, 10),
    status: 'checked_in',
  });
  return { room, assignment: doc, createdRoom, movedFrom };
}

// 按班级取学生名单（带各自宿舍号）：「班级管理」里按班维护宿舍就用这个视图
async function rosterWithRooms(className) {
  const students = await User.find({ className, role: { $ne: 'teacher' } })
    .select('realName nickname account studentId className openid')
    .sort({ studentId: 1 })
    .limit(300)
    .lean();
  const ids = students.map((s) => s.studentId).filter(Boolean);
  const roomBy = new Map();
  if (ids.length) {
    const rows = await DormAssignment.find({ studentId: { $in: ids }, status: { $in: ['checked_in', 'guest'] } })
      .select('studentId buildingName buildingId roomNo bedNo')
      .lean();
    for (const r of rows) roomBy.set(r.studentId, { roomText: roomLabel(r), bedNo: r.bedNo || '' });
  }
  return students.map((s) => ({
    userId: String(s._id),
    studentId: s.studentId || '',
    name: s.realName || s.nickname || s.account || '未命名',
    roomText: (roomBy.get(s.studentId) || {}).roomText || '',
    bedNo: (roomBy.get(s.studentId) || {}).bedNo || '',
    assigned: !!(roomBy.get(s.studentId) || {}).roomText,
  }));
}

/**
 * 房间的班级归属（**按在住学生算**，混宿时返回多个班）
 * @returns {Array<{className:string, count:number}>}
 */
async function roomOwners(roomId) {
  const rows = await DormAssignment.find({ roomId, status: { $in: ['checked_in', 'guest'] } })
    .select('className')
    .lean();
  const map = new Map();
  for (const r of rows) {
    const cn = String(r.className || '').trim();
    if (!cn) continue;
    map.set(cn, (map.get(cn) || 0) + 1);
  }
  return [...map.entries()].map(([className, count]) => ({ className, count }));
}

// 启动期幂等迁移：把旧的「唯一槽位」索引换成含 className 的版本。
// 为什么必须显式删旧索引：Mongoose 只会**新建**缺失的索引，不会替换同名/同键的旧索引；
// 旧索引（不含 className）继续存在的话，混宿房间第二个班那条记录会被唯一约束直接拒掉。
async function migrateSlotIndex() {
  const CheckRecord = require('../models/check-record');
  const uniq = CheckRecord.UNIQUE_SLOT;
  const cols = await CheckRecord.collection.indexes();
  const names = cols.map((i) => i.name);
  if (!names.includes(uniq.name)) {
    await CheckRecord.collection.createIndex(uniq.keys, {
      unique: true,
      partialFilterExpression: { status: { $in: CheckRecord.COUNTED_STATUS } },
      name: uniq.name,
    });
  }
  if (uniq.oldName && names.includes(uniq.oldName)) {
    await CheckRecord.collection.dropIndex(uniq.oldName);
  }
}

module.exports = {
  parseRoomLabel,
  roomLabel,
  assignStudentRoom,
  rosterWithRooms,
  roomOwners,
  migrateSlotIndex,
};
