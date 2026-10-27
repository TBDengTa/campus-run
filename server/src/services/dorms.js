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

/**
 * 解析「楼号·门号」为楼栋 + 房号（管理端只填一栏也能存对）。
 * 支持的输入：「1号楼·201」/「1号楼 201」/「1号楼-201」/「A201」/「201」
 *   · 拆不出楼栋时 roomNo 取整串（与原字段口径一致，避免把用户的输入改坏）
 *   · 拆得出来就两栏分开存：以后按楼栋筛选、按房间查宿都要靠 buildingId
 */
function parseRoomLabel(input) {
  // ⚠️ 防「对象被当字符串用」产生的脏数据（用户 2026-10-26 报：宿舍里出现
  //   楼名「[object」、房号「Object]9901」—— 就是某次把对象直接拼进字符串造成的）。
  //   String({}) === '[object Object]'，再按分隔符切就得到「[object」+「Object]9901」。
  //   这类输入一律当非法：宁可让录入人重填，也不要把垃圾写进 dorm_rooms
  //   （脏楼名会污染整个「楼栋」下拉，且按楼栋筛选/统计全部失真）。
  if (input && typeof input === 'object') {
    throw new Error('宿舍号格式不正确（收到的是对象，请传「1号楼·201」这样的字符串）');
  }
  const raw = str(input, 60);
  if (!raw) return { buildingId: '', buildingName: '', roomNo: '' };
  if (/\[object/i.test(raw)) {
    throw new Error('宿舍号格式不正确（不要把对象当宿舍号提交），请填写「1号楼·201」');
  }
  // 分隔符：中圆点 / 空格 / 连字符 / 斜杠 / 逗号
  const parts = raw.split(/[·・\-—/、,\s]+/).filter(Boolean);
  if (parts.length >= 2) {
    return { buildingId: parts[0].slice(0, 20), buildingName: parts[0].slice(0, 30), roomNo: parts.slice(1).join('').slice(0, 20) };
  }
  return { buildingId: '', buildingName: '', roomNo: raw.slice(0, 20) };
}

// 房间的展示名：楼号·门号（前端与导出统一走这个，不要各处自己拼）
function roomLabel(a) {
  const b = a.buildingName || a.buildingId || '';
  const r = a.roomNo || '';
  if (b && r) return `${b}·${r}`;
  return b || r || '';
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
    const parsed = parseRoomLabel(label);
    if (!parsed.roomNo) throw new Error('请填写宿舍号（如 1号楼·201）');
    room = await DormRoom.findOne({ buildingId: parsed.buildingId, roomNo: parsed.roomNo }).lean();
    if (!room) {
      // 按「楼+房」不存在时，再试只看房号：同楼栋可能被建成不同 buildingId（历史数据），
      // 命中就复用，避免同一间房建两条记录（查宿会出现两条重复房间）。
      const byNo = await DormRoom.findOne({ roomNo: parsed.roomNo }).lean();
      if (byNo && !byNo.buildingId) {
        room = byNo;
      } else {
        room = await DormRoom.create({
          buildingId: parsed.buildingId,
          buildingName: parsed.buildingName,
          roomNo: parsed.roomNo,
          // 房间的默认班级只是兜底展示；真实归属看 dorm_assignments（混宿时一间房会有多个班）
          className: student.className || '',
          departmentId: student.departmentId || null,
          departmentName: student.departmentName || '',
        });
        createdRoom = true;
      }
    }
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
