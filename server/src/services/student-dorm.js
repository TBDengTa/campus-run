/**
 * 学生宿舍（住宿记录）的**唯一实现**：读视图 / 分配 / 退宿。
 *
 * 为什么抽成 service（用户 2026-10-22「班主任可以给本班学生设置宿舍，为什么教师权限组无法获取楼名」）：
 * 宿舍维护现在有两个入口 ——
 *   ① 管理端 `/api/admin/users/:id/dorm`（user.manage）—— 宿管 / 学生处；
 *   ② 班级域 `/api/class/student/:id/dorm`（**班主任对本班学生**，不需要任何管理权限）。
 * 两处必须同一份逻辑：换房回填人数、房间自动建档、退宿保留历史，少一处就是数据事故。
 *
 * 楼名（`buildings`）也在这里一起返回：班主任要填宿舍就得先选楼，
 * 而 `/api/admin/config/buildings` 挂在 building.view / building.manage / config.view 下 ——
 * 教师权限组没有这些权限（那是**宿管维护楼名清单**的权限，不该发给所有教师）。
 * 所以宿舍视图自己把「系统设置里配置的宿舍楼 ∪ 历史上出现过的楼」合并好下发，
 * 班主任不必、也不该拿到楼名管理的权限。
 */
const { ApiError } = require('../utils/response');
const dormsSvc = require('./dorms');
const classProfilesSvc = require('./class-profiles');
const DormAssignment = require('../models/dorm-assignment');
const DormRoom = require('../models/dorm-room');
const GoalConfig = require('../models/goal-config');

const ACTIVE = { $in: ['checked_in', 'guest'] };

// 单条在住记录 → 统一展示口径（与宿舍抽屉一致）
async function currentDorm(openid) {
  if (!openid) return null;
  const doc = await DormAssignment.findOne({ openid, status: ACTIVE })
    .select('roomId buildingId buildingName roomNo bedNo status')
    .lean();
  if (!doc) return null;
  return {
    roomText: dormsSvc.roomLabel(doc),
    roomId: doc.roomId ? String(doc.roomId) : '',
    bedNo: doc.bedNo || '',
    status: doc.status || '',
  };
}

// 系统设置里配置的楼名（goal_config.buildings）；没配置过就是空数组
async function configuredBuildings() {
  try {
    const cfg = await GoalConfig.getSingleton();
    const b = (cfg && cfg.buildings) || {};
    const clean = (arr) => (Array.isArray(arr) ? arr : []).map((s) => String(s || '').trim()).filter(Boolean);
    return { teaching: clean(b.teaching), dorm: clean(b.dorm) };
  } catch (e) {
    return { teaching: [], dorm: [] };
  }
}

// 只取宿舍楼（宿舍视图用）
async function configuredDormBuildings() {
  return (await configuredBuildings()).dorm;
}

/**
 * 宿舍面板一次性给全：当前在住 + 楼栋候选 + 本班已用房间 + 是否已绑微信。
 * @param {Object} user 目标学生（需要 openid / role / className / _id）
 */
async function buildDormPayload(user) {
  const openid = user.openid || '';
  const className = user.className || '';
  const teacher = user.role === 'teacher';
  const [current, rooms, classRows, cfgBuildings] = await Promise.all([
    teacher || !openid ? Promise.resolve(null) : currentDorm(openid),
    DormRoom.find({ enabled: { $ne: false } })
      .select('buildingId buildingName roomNo')
      .sort({ buildingId: 1, roomNo: 1 })
      .limit(800)
      .lean(),
    teacher || !className
      ? Promise.resolve([])
      : DormAssignment.find({ className, status: ACTIVE }).select('buildingId buildingName roomNo').lean(),
    teacher ? Promise.resolve([]) : configuredDormBuildings(),
  ]);

  const buildingCount = new Map();
  for (const r of rooms) {
    const b = r.buildingName || r.buildingId || '';
    if (!b) continue;
    buildingCount.set(b, (buildingCount.get(b) || 0) + 1);
  }

  // 配置清单在前（它才是「应该住哪几栋」的唯一来源），历史里多出来的楼补在后面，
  // 避免「配置了新楼但没学生住过」时下拉里选不到。
  const buildings = [];
  const seenB = new Set();
  for (const name of cfgBuildings) {
    if (seenB.has(name)) continue;
    seenB.add(name);
    buildings.push({ name, rooms: buildingCount.get(name) || 0 });
  }
  for (const [name, n] of buildingCount.entries()) {
    if (seenB.has(name)) continue;
    seenB.add(name);
    buildings.push({ name, rooms: n });
  }

  const quickRooms = [];
  const seen = new Set();
  for (const a of classRows) {
    const label = dormsSvc.roomLabel(a);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    quickRooms.push(label);
  }

  return {
    teacher, // 教师不住学生宿舍：不给宿舍相关的一切输入
    // 未绑微信时记不了住宿（记录按 openid 唯一），前端据此给明确提示
    wechatBound: !!openid,
    roomText: current ? current.roomText : '',
    roomId: current ? current.roomId : '',
    bedNo: current ? current.bedNo : '',
    status: current ? current.status : '',
    buildings,
    quickRooms: quickRooms.slice(0, 40),
  };
}

async function refreshDormCountsFor(classNames) {
  for (const cn of [...new Set((classNames || []).map((c) => String(c || '').trim()).filter(Boolean))]) {
    try {
      await classProfilesSvc.refreshDormCounts(cn);
    } catch (e) {
      /* 人数回填失败不影响本次绑定/退宿结果 */
    }
  }
}

/**
 * 给学生绑宿舍：{ roomLabel: '1号楼·201' } 或 { roomId } + 可选 bedNo。
 * 房间不存在时 assignStudentRoom 按「楼号·门号」自动建档；换房自动把旧记录置 moved。
 */
async function assignDorm(student, body = {}) {
  if (!student) throw new ApiError(404, 404, '用户不存在');
  if (student.role === 'teacher') throw new ApiError(400, 400, '教师账号不安排宿舍');
  if (!student.openid) throw new ApiError(400, 400, '该学生还没绑定微信，暂时无法记录住宿');

  // 换房前那条记录的班级也要回填人数（转班 / 混宿时旧记录的 className 可能与当前不同）
  const prior = await DormAssignment.findOne({ openid: student.openid, status: ACTIVE }).select('className').lean();
  let out;
  try {
    out = await dormsSvc.assignStudentRoom({
      student,
      roomId: body.roomId,
      roomLabel: body.roomLabel,
      bedNo: body.bedNo,
    });
  } catch (e) {
    // 服务层用 Error 表达「房间不存在 / 未填房号」这类入参问题，统一转 400 给前端可读文案
    throw new ApiError(400, 400, e.message || '绑定失败');
  }
  await refreshDormCountsFor([student.className, prior && prior.className]);

  return {
    studentId: student.studentId || '',
    name: student.realName || student.nickname || student.account || '',
    className: student.className || '',
    room: dormsSvc.roomLabel(out.room),
    roomId: String(out.room._id),
    // 同房间同床位时 assignStudentRoom 直接返回（不新建记录、没有 assignment 字段），
    // 这时床位号就是入参值
    bedNo: String((out.assignment && out.assignment.bedNo) || body.bedNo || '').trim(),
    createdRoom: !!out.createdRoom, // 房间不存在时自动建档
    movedFrom: out.movedFrom || '',
  };
}

/** 退宿：在住记录置 checked_out（历史保留，之后可重新绑定） */
async function checkoutDorm(student) {
  if (!student) throw new ApiError(404, 404, '用户不存在');
  if (!student.openid) return { checkedOut: false, reason: '该学生还没绑定微信，没有住宿记录' };
  const doc = await DormAssignment.findOne({ openid: student.openid, status: ACTIVE });
  if (!doc) return { checkedOut: false, reason: '当前没有在住记录' };
  doc.status = 'checked_out';
  await doc.save();
  await refreshDormCountsFor([student.className, doc.className]);
  return { checkedOut: true };
}

module.exports = { currentDorm, configuredBuildings, configuredDormBuildings, buildDormPayload, assignDorm, checkoutDorm };
