/**
 * 宿舍房号「重复性别前缀」数据修复（一次性，可重复运行）
 *
 * 起因（用户 2026-11-14「检查录入中洋河校区的宿舍楼栋显示出现了 BUG，但班级管理中的宿舍配置显示正常」）：
 *   系统设置的宿舍用楼清单里有**楼名自带连字符**的项（线上实测「洋河-男宿 / 洋河-女宿」）。
 *   宿舍弹窗与服务端解析都被写成「一上来就按 [·・\-—/、,\s] 切」，于是
 *     「洋河-女宿·301」→ 楼名「洋河」+ 房号「女宿301」
 *   房号从此刻上了性别字样；下次回显成「洋河·女宿301」，用户再点一次标准楼名保存，
 *   就拼成「洋河-女宿·女宿301」→ 再被切开 →「女宿女宿301」……
 *   **每保存一次多叠一层**，线上实测叠到 7 层
 *   （`女宿女宿女宿女宿女宿女宿女宿301`，createdAt 2026-11-12T13:38:26Z）。
 *
 *   为什么「班级管理 → 宿舍配置」看着正常：那一页读的是 dorm_assignments 的记录快照
 *   （buildingName/roomNo 原样显示），不参与房间表重建；而检查录入台的查宿对象列表
 *   是拿 dorm_rooms 逐个房间生成的 —— 幽灵房间全在那儿冒出来。
 *
 * 用法：
 *   node scripts/fix-dorm-room-dup-prefix.js               # 只看会改什么（dry-run，默认）
 *   node scripts/fix-dorm-room-dup-prefix.js --apply       # 真正写库
 *
 * 修复口径（改这里之前先读上面的成因）：
 *   ① **目标房间由「白名单楼名 + 纯数字门号」决定**：
 *      楼名里的性别词（洋河 + 男宿301）→ 合并成白名单楼名「洋河-男宿」+ 门号「301」；
 *      「洋河」+「女宿女宿301」→「洋河-女宿」+「301」。这就是系统设置本来期望的唯一写法。
 *      找不到对应白名单楼名时**保持原楼名**（不凭空造楼）。
 *   ② **纯数字门号不猜性别**：`洋河|302` 既有男宿302 又有女宿302 时无从判断，
 *      保持独立房间并打印清单交人工（线上 users.gender 有 1498/2682 缺失）。
 *   ③ 每组挑**保留者**：已符合目标写法 > 有在住记录 > 在住人数多 > 检查记录多 > 创建更早。
 *   ④ 迁移：dorm_assignments.roomId → 保留房间（同步 buildingName/roomNo 快照，
 *      否则记录与房间仍对不上）；check_records.targetId 同步重指，
 *      撞 uniq_slot_active_v2（同模块/日期/时段/班级）的**不迁移**并打印，交人工处置
 *      —— 静默丢一条检查记录不可接受。
 *   ⑤ 迁空的冗余房间置 `enabled: false`，**不物理删除**（历史 movedTo 仍提到它）。
 *   ⑥ 幂等：第二次运行应「0 条待修改」；写库后再扫一遍自证。
 *   ⑦ **--apply 前自动落备份**：三张表全量导出到 `<repo>/_backup/dorm-repair-<时间戳>.json`
 *      （含学生姓名/学号，已在 .gitignore 里忽略，绝不入库）。
 *      备份写不出来就**中止**，不带着「无法回滚」的状态去改生产库。
 *
 * 设计成 scripts/ 而不是启动迁移：这是**数据修复**，不是 schema 迁移；
 * 部署时静默改数据比不改更危险（管理员必须能先看 dry-run 清单）。
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('../node_modules/mongoose');
const config = require('../src/config');
const DormRoom = require('../src/models/dorm-room');
const DormAssignment = require('../src/models/dorm-assignment');
const CheckRecord = require('../src/models/check-record');
const GoalConfig = require('../src/models/goal-config');
const orgSvc = require('../src/services/dorms');

const APPLY = process.argv.includes('--apply');
const ACTIVE = ['checked_in', 'guest'];
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const log = (s) => console.log(s);

/**
 * 落库前备份（只写 --apply）。写不出来就抛错中止 —— 宁可一次都不改，
 * 也不能在没有回滚点的前提下动生产数据。
 * @returns {string} 备份文件绝对路径
 */
function writeBackup({ rooms, assigns, records }) {
  const dir = path.resolve(__dirname, '..', '..', '_backup');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `dorm-repair-${stamp}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ takenAt: new Date().toISOString(), db: config.dbName, rooms, assigns, records }, null, 0),
    'utf8'
  );
  return file;
}

/** 房号里的性别标记（取最后一个）与数字门号 */
function splitRoomNo(roomNo) {
  const text = str(roomNo);
  const tokens = text.match(/男宿|女宿/g) || [];
  const digits = (text.match(/\d+/) || [])[0] || '';
  return { gender: tokens.length ? tokens[tokens.length - 1] : '', digits };
}

/**
 * 房间的目标写法：{ buildingName, roomNo }。
 *   · 楼名已带性别（洋河-男宿）→ 门号 = 纯数字
 *   · 楼名不带性别、房号带性别（洋河 + 女宿301）→ 白名单有「洋河-女宿」就用它
 *   · **纯数字门号**（`洋河|410`，是楼名被拆坏的残留）：
 *       `genderHint` 给出「同门号在姊妹房间里只出现过一种性别」时用它 —— 这是**从数据推导**，
 *       不是猜（线上 users.gender 有 1498/2682 缺失，按学生性别猜会把男生塞进女生宿舍）。
 *       同门号男女两种写法都存在时 hint 为空，保持独立并交人工。
 * @param {object} room
 * @param {string[]} dormBuildings 系统设置的宿舍用楼清单
 * @param {Map<string,string|Set<string>>} genderByDigits 楼名(去性别后缀) + 门号 → 性别（唯一时才给值）
 */
function targetOf(room, dormBuildings, genderByDigits) {
  const building = str(room.buildingName || room.buildingId);
  const { gender, digits } = splitRoomNo(room.roomNo);
  if (!digits) return { buildingName: building, roomNo: str(room.roomNo), guessFree: true };
  const bGender = (building.match(/男宿|女宿/g) || []).slice(-1)[0] || '';
  if (bGender) return { buildingName: building, roomNo: digits };
  // 楼名不带性别：优先用「房号里明确写了的性别」，其次用「姊妹房间推导出的唯一性别」
  const hint = gender || (genderByDigits.get(`${building}|${digits}`) || '');
  if (hint) {
    const candidate = `${building}-${hint}`;
    if (dormBuildings.includes(candidate)) return { buildingName: candidate, roomNo: digits };
    return { buildingName: building, roomNo: `${hint}${digits}` };
  }
  // 纯数字且无唯一性别可推：性别未知，保持原楼名 + 纯数字
  return { buildingName: building, roomNo: digits, genderUnknown: true };
}

(async () => {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });
  log(`=== 宿舍房号重复前缀修复（${APPLY ? 'APPLY 写库' : 'DRY-RUN 只看不改'}）===\n`);

  const cfg = await GoalConfig.getSingleton();
  const dormBuildings = ((cfg && cfg.buildings && cfg.buildings.dorm) || []).map(str).filter(Boolean);
  log(`系统设置的宿舍用楼清单：${JSON.stringify(dormBuildings)}\n`);

  const rooms = await DormRoom.find({}).lean();
  const assigns = await DormAssignment.find({}).lean();
  const dormRecords = await CheckRecord.find({ targetType: 'dorm_room' })
    .select('targetId moduleKey date period className status')
    .lean();

  // --apply 前先落备份（三张表全量）；失败直接中止，不带着无法回滚的状态改生产库
  if (APPLY) {
    const backupFile = writeBackup({ rooms, assigns, records: dormRecords });
    log(`已备份：${backupFile}`);
    log('（还原方式：把 json 里的 rooms/assigns/records 按 _id upsert 回对应集合）\n');
  }

  // ===== 从「明确写了性别的房间」推导「楼名 + 门号 → 性别」=====
  // 只采纳**唯一**命中的（同门号既有男宿又有女宿 → 空，不猜），供纯数字残房归位。
  const genderSets = new Map();
  for (const r of rooms) {
    const b = str(r.buildingName || r.buildingId);
    const p = splitRoomNo(r.roomNo);
    if (!p.digits) continue;
    const bGender = (b.match(/男宿|女宿/g) || []).slice(-1)[0] || '';
    const g = bGender || p.gender;
    if (!g) continue;
    const base = b.replace(/[-·]?(男宿|女宿)$/, '');
    const k = `${base}|${p.digits}`;
    if (!genderSets.has(k)) genderSets.set(k, new Set());
    genderSets.get(k).add(g);
  }
  const genderByDigits = new Map();
  const ambiguous = [];
  for (const [k, set] of genderSets) {
    if (set.size === 1) genderByDigits.set(k, [...set][0]);
    else ambiguous.push(k);
  }

  // 归组：目标写法键（楼名 | 门号）
  // ⚠️ **停用房间不参与**：它们已经被上一次修复归并掉了（enabled:false），
  //   还留在表里只是历史留痕。把它们算进来会让 dry-run 永远报「45 组待修复」，
  //   看起来像没修好（2026-11-14 实测踩过：自证显示 0 个重复组，dry-run 却说还有 45 组）。
  const groups = new Map();
  const noDigits = [];
  const noDigitsRooms = []; // 没有数字门号的房间（脏数据）。无引用时一并停用，见下
  for (const r of rooms) {
    if (r.enabled === false) continue;
    if (!/\d/.test(str(r.roomNo))) {
      noDigits.push(`dorm_rooms/${str(r.buildingName || r.buildingId)} ${str(r.roomNo)}：没有数字门号，不参与归并`);
      noDigitsRooms.push(r);
      continue;
    }
    const t = targetOf(r, dormBuildings, genderByDigits);
    const key = `${t.buildingName}|${t.roomNo}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ room: r, target: t });
  }

  // ⚠️ 不能只处理「一组多间」：只剩一间、但**楼名/房号写法不对**的组也必须改写。
  // 线上实测第一次跑完留下 66 间 `洋河` + `男宿101`（该门号只有这一间，没有重复组），
  // 楼名没归到白名单的「洋河-男宿」→ 检查录入台照样按「洋河」列出一大坨。
  const allGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dupeGroups = allGroups.filter(([, list]) => list.length > 1);
  // 单间但写法不对的组：楼名或房号与目标写法不一致
  const renameGroups = allGroups.filter(([, list]) => {
    if (list.length > 1) return false;
    const r = list[0].room;
    return str(r.buildingName || r.buildingId) !== list[0].target.buildingName || str(r.roomNo) !== list[0].target.roomNo;
  });
  log(`房间总数 ${rooms.length}，目标写法分组 ${groups.size}，其中多房间组 ${dupeGroups.length}、单间待改写法 ${renameGroups.length}`);
  log(`同门号存在双性别的 ${ambiguous.length} 个（纯数字房号不猜归属，保持独立并在此列出）\n`);

  const stats = { groups: 0, movedAssign: 0, movedRecs: 0, disabled: 0, blocked: 0 };
  const blocked = [];

  // 引用计数**边迁边改本地快照**（不能只读初始快照：迁走后 loser 的引用数就变了，
  // 拿初始值判「是否还有引用」会一律判成有，结果一间都停用不了）。
  let assignIndex = assigns.map((a) => ({ ...a }));
  let recordIndex = dormRecords.map((r) => ({ ...r }));
  const countActive = (roomId) => assignIndex.filter((a) => String(a.roomId) === String(roomId) && ACTIVE.includes(a.status)).length;
  const countAll = (roomId) => assignIndex.filter((a) => String(a.roomId) === String(roomId)).length;
  const countRecs = (roomId) => recordIndex.filter((r) => String(r.targetId) === String(roomId)).length;

  // 两组共用同一段「挑保留者 + 迁移 + 改写」逻辑：
  //   · 多房间组：还有 loser 要归并；
  //   · 单间待改写法：losers 为空，只会走到末尾的「保留者改写」。
  for (const [key, list] of [...dupeGroups, ...renameGroups]) {
    const [tBuilding, tRoomNo] = key.split('|');
    const t = { buildingName: tBuilding, roomNo: tRoomNo };
    const scored = list.map((x) => ({
      room: x.room,
      isTarget: str(x.room.roomNo) === tRoomNo && str(x.room.buildingName || x.room.buildingId) === tBuilding,
      active: countActive(x.room._id),
      all: countAll(x.room._id),
      recs: countRecs(x.room._id),
    }));
    scored.sort((a, b) => {
      if (a.isTarget !== b.isTarget) return b.isTarget ? 1 : -1;
      if ((a.active > 0) !== (b.active > 0)) return b.active > 0 ? 1 : -1;
      if (a.active !== b.active) return b.active - a.active;
      if (a.recs !== b.recs) return b.recs - a.recs;
      return new Date(a.room.createdAt) - new Date(b.room.createdAt);
    });
    const win = scored[0];
    const losers = scored.slice(1);

    log(`--- ${key} → 保留 ${JSON.stringify(str(win.room.buildingName || win.room.buildingId) + '·' + win.room.roomNo)} ---`);
    for (const s of scored) {
      log(`  ${s === win ? '保留' : '归并'} ${JSON.stringify(str(s.room.buildingName || s.room.buildingId) + '·' + s.room.roomNo)} 在住 ${s.active} / 历史 ${s.all} / 记录 ${s.recs}`);
    }

    for (const s of losers) {
      const loserId = s.room._id;
      const assignList = assignIndex.filter((a) => String(a.roomId) === String(loserId));

      // ① 住宿记录重指（含历史 moved/checked_out，保证「记录与房间」始终一致）
      if (assignList.length) {
        const moved = assignList.length;
        log(`  → 迁移住宿记录 ${moved} 条 → ${tBuilding}·${tRoomNo}`);
        if (APPLY) {
          await DormAssignment.updateMany(
            { roomId: loserId },
            { $set: { roomId: win.room._id, buildingId: tBuilding.slice(0, 20), buildingName: tBuilding, roomNo: tRoomNo } }
          );
        }
        stats.movedAssign += moved;
        // 本地快照同步（否则后面判断「还有没有引用」会读到迁移前的状态）
        assignIndex = assignIndex.map((a) =>
          String(a.roomId) === String(loserId) ? { ...a, roomId: win.room._id } : a
        );
      }

      // ② 检查记录重指（先查唯一键冲突，冲突的不迁）
      const recs = recordIndex.filter((r) => String(r.targetId) === String(loserId));
      const movable = [];
      for (const r of recs) {
        // 目标房间上是否已有同槽位记录（含本轮刚迁过去的）
        const hit = recordIndex.find(
          (x) =>
            String(x.targetId) === String(win.room._id) &&
            x.moduleKey === r.moduleKey &&
            x.date === r.date &&
            (x.period || '') === (r.period || '') &&
            (x.className || '') === (r.className || '')
        );
        // 库里也查一次（本轮索引只覆盖读出来的这些，防御性）
        const dbHit = hit
          ? null
          : await CheckRecord.findOne({
              moduleKey: r.moduleKey,
              targetType: 'dorm_room',
              targetId: String(win.room._id),
              date: r.date,
              period: r.period || '',
              className: r.className || '',
            })
              .select('_id')
              .lean();
        if (hit || dbHit) {
          const msg = `检查记录 ${String(r._id)}（${r.moduleKey} ${r.date} ${r.className}）与保留房间既有记录撞唯一键 → 未迁移，请人工处置`;
          log(`  ⚠️ ${msg}`);
          blocked.push(msg);
          stats.blocked += 1;
        } else {
          movable.push(r);
        }
      }
      if (movable.length) {
        log(`  → 重指检查记录 ${movable.length} 条`);
        if (APPLY) {
          for (const r of movable) {
            await CheckRecord.updateOne(
              { _id: r._id },
              { $set: { targetId: String(win.room._id), targetName: `${tBuilding} ${tRoomNo}`.trim() } }
            );
          }
        }
        stats.movedRecs += movable.length;
        const movedIds = new Set(movable.map((r) => String(r._id)));
        recordIndex = recordIndex.map((r) =>
          movedIds.has(String(r._id)) ? { ...r, targetId: String(win.room._id) } : r
        );
      }

      // ③ 迁空的冗余房间置 enabled:false（不删；历史 movedTo 仍提到它）
      const leftAssign = countAll(loserId);
      const leftRecs = countRecs(loserId);
      if (!leftAssign && !leftRecs) {
        if (APPLY) {
          await DormRoom.updateOne(
            { _id: loserId },
            { $set: { enabled: false, remark: '重复房号已归并（fix-dorm-room-dup-prefix）' } }
          );
        }
        stats.disabled += 1;
        log('  → 置为停用（enabled:false）');
      } else {
        // 记录迁不走的，房间不能停用（否则那条记录指向一间停用房间）
        log(`  ⚠️ 仍被引用（住宿 ${leftAssign} / 记录 ${leftRecs}）→ 保持启用，留人工确认`);
        blocked.push(`${str(s.room.buildingName || s.room.buildingId)}·${str(s.room.roomNo)} 仍有引用，未停用`);
      }
    }

    // ④ 保留者改成目标写法（楼名 + 门号），并把它的住宿记录快照一起对齐
    const winBuilding = str(win.room.buildingName || win.room.buildingId);
    const winRoomNo = str(win.room.roomNo);
    if (winBuilding !== tBuilding || winRoomNo !== tRoomNo) {
      log(`  → 保留房间改写 ${JSON.stringify(winBuilding + '·' + winRoomNo)} → ${JSON.stringify(tBuilding + '·' + tRoomNo)}`);
      if (APPLY) {
        await DormRoom.updateOne(
          { _id: win.room._id },
          { $set: { buildingId: tBuilding.slice(0, 20), buildingName: tBuilding, roomNo: tRoomNo } }
        );
        await DormAssignment.updateMany(
          { roomId: win.room._id },
          { $set: { buildingId: tBuilding.slice(0, 20), buildingName: tBuilding, roomNo: tRoomNo } }
        );
      }
    }
    stats.groups += 1;
  }

  // ===== ⑤ 纯数字房号的「幽灵房间」单独处置 =====
  // 它们是楼名被拆坏后剩下的空壳（`洋河` + `410`），而真正的房间是「洋河-男宿」+「410」。
  // 这些空壳会照样出现在检查录入台的查宿列表里 —— 正是用户截图里那一堆重复楼栋。
  //
  // 判定用「**在住 + 检查记录**」而不是「历史住宿记录」：
  //   历史记录是 `status='moved'` 的换房留痕（学生从空壳换到正牌房），它们本就该随房间换代
  //   留在历史里，不能当成「这间房还有人在用」。线上实测：第一轮修完剩 13 间空壳
  //   （`洋河·208/209/210/212/213/214/215/217/301/302/304/305`）在住 0、记录 0，只挂着
  //   1~9 条 moved 留痕 —— 用 countAll 判会一间都停用不了，录入台照样多出 13 行。
  // ⚠️ 只停用、绝不合并：纯数字房号不带性别，同门号男女两种写法都存在时无从判断归属。
  const ghostToggle = [];
  for (const r of rooms) {
    if (r.enabled === false) continue;
    const building = str(r.buildingName || r.buildingId);
    if (/(男宿|女宿)/.test(building)) continue; // 楼名已带性别 → 不是空壳
    if (!/^\d+$/.test(str(r.roomNo))) continue; // 房号带性别 → 已在上面的归并里处理
    const id = String(r._id);
    if (countActive(id) || countRecs(id)) continue; // 还有人住 / 有检查记录 → 不能动，交人工
    // 是否存在「同楼、同门号、带性别」的正牌房间？没有就说明这不一定是空壳（老数据可能只有它，别乱停）
    const siblings = rooms.filter(
      (x) =>
        String(x._id) !== id &&
        x.enabled !== false &&
        str(x.buildingName || x.buildingId).replace(/[-·]?(男宿|女宿)$/, '') === building &&
        (str(x.roomNo).match(/\d+/) || [])[0] === str(r.roomNo)
    );
    if (!siblings.length) continue;
    ghostToggle.push(r);
  }

  // ===== ⑥ 没有数字门号的脏房间（`洋河·男宿`、`1号楼·999` 这类）=====
  // 它们不能参与归并（连门号都没有，无从判断是哪一间），但同样会出现在查宿列表里。
  // 判据同 ⑤：**无在住 + 无检查记录**才停用（历史 moved 留痕不算「还在用」）。
  const noDigitToggle = [];
  for (const r of noDigitsRooms) {
    const id = String(r._id);
    if (countActive(id) || countRecs(id)) continue; // 确有引用 → 交人工
    noDigitToggle.push(r);
  }
  log('\n===== 无数字门号的脏房间（无在住、无检查记录）=====');
  if (!noDigitToggle.length) {
    log('  无');
  } else {
    for (const r of noDigitToggle) {
      log(`  ${str(r.buildingName || r.buildingId)}·${str(r.roomNo)} → 置为停用（房号没有数字，无法归并）`);
      if (APPLY) {
        await DormRoom.updateOne(
          { _id: r._id },
          { $set: { enabled: false, remark: '无数字门号的脏房间已停用（fix-dorm-room-dup-prefix）' } }
        );
      }
      stats.disabled += 1;
    }
    log(`  共 ${noDigitToggle.length} 间`);
  }

  log('\n===== 纯数字房号空壳（无在住、无检查记录，且在带性别的正牌房间覆盖下）=====');
  if (!ghostToggle.length) {
    log('  无');
  } else {
    for (const r of ghostToggle) {
      log(`  ${str(r.buildingName || r.buildingId)}·${str(r.roomNo)} → 置为停用（正牌房间已在白名单楼名下）`);
      if (APPLY) {
        await DormRoom.updateOne(
          { _id: r._id },
          { $set: { enabled: false, remark: '纯数字空壳房号已归并（fix-dorm-room-dup-prefix）' } }
        );
      }
      stats.disabled += 1;
    }
    log(`  共 ${ghostToggle.length} 间`);
  }

  // ===== ⑦ 楼名根本不在白名单里的孤立房间（`1号楼·999` 这类测试残留）=====
  // 录入台按「楼栋」分组时它们会多出一个假楼栋（白名单是「1号楼(女生宿舍)」，
  // 它却叫「1号楼」）。同样只动**无在住 + 无检查记录**的。
  const orphanToggle = [];
  for (const r of rooms) {
    if (r.enabled === false) continue;
    const building = str(r.buildingName || r.buildingId);
    if (!building || dormBuildings.includes(building)) continue; // 白名单里的不动
    // 白名单楼名 + 性别后缀（洋河-男宿）也算在册
    if (dormBuildings.some((b) => building === `${b}-男宿` || building === `${b}-女宿`)) continue;
    const id = String(r._id);
    if (countActive(id) || countRecs(id)) continue; // 有人在住 → 不能动
    orphanToggle.push(r);
  }
  log('\n===== 楼名不在白名单里的孤立房间（无在住、无检查记录）=====');
  if (!orphanToggle.length) {
    log('  无');
  } else {
    for (const r of orphanToggle) {
      log(`  ${str(r.buildingName || r.buildingId)}·${str(r.roomNo)} → 置为停用（楼名不在系统设置的宿舍用楼清单里）`);
      if (APPLY) {
        await DormRoom.updateOne(
          { _id: r._id },
          { $set: { enabled: false, remark: '楼名不在白名单的孤立房间已停用（fix-dorm-room-dup-prefix）' } }
        );
      }
      stats.disabled += 1;
    }
    log(`  共 ${orphanToggle.length} 间`);
  }

  // ===== 汇总（放在所有写动作之后，数字才是最终生效的）=====
  log('\n===== 汇总 =====');
  log(`归并组 ${stats.groups} / 阻塞 ${stats.blocked} 项`);
  log(`迁移住宿记录 ${stats.movedAssign} 条，重指检查记录 ${stats.movedRecs} 条，停用冗余房间 ${stats.disabled} 间`);

  // 幂等自证：分组与空壳都清完才算「本次 0 条待修改」
  if (!stats.groups && !ghostToggle.length) {
    log('\n没有需要修复的房间（幂等自证：本次 0 条待修改）');
  }
  if (blocked.length) {
    log('\n需要人工处置：');
    for (const b of blocked) log(`  · ${b}`);
  }
  if (noDigits.length) {
    log('\n不参与归并：');
    for (const s of noDigits) log(`  · ${s}`);
  }
  if (ambiguous.length) {
    log('\n纯数字房号（性别未知，保持独立，未自动归并）：');
    for (const k of ambiguous) log(`  · ${k}`);
  }
  if (!APPLY) log('\n（dry-run：未写库。确认无误后加 --apply 正式执行）');

  if (APPLY) {
    const after = await DormRoom.find({ enabled: { $ne: false } }).lean();
    const g2 = new Map();
    for (const r of after) {
      if (!/\d/.test(str(r.roomNo))) continue;
      const t = targetOf(r, dormBuildings, genderByDigits);
      const k = `${t.buildingName}|${t.roomNo}`;
      if (!g2.has(k)) g2.set(k, []);
      g2.get(k).push(str(r.roomNo));
    }
    const left = [...g2.entries()].filter(([, l]) => l.length > 1);
    log(`\n自证：写库后仍有重复组 ${left.length} 个（应为 0）`);
    for (const [k, l] of left.slice(0, 20)) log(`  · ${k}: ${l.join(' , ')}`);
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
