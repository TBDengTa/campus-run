/**
 * 「楼名·房号」拆分口径的**两端一致性**检查（用户 2026-11-14
 * 「检查录入里洋河校区的宿舍楼栋显示出现 BUG」）。
 *
 * 事故：系统设置的宿舍用楼清单里有**楼名自带连字符**的项（线上实测「洋河-男宿 / 洋河-女宿」）。
 *   两个宿舍弹窗（components/dorm-sheet、components/room-dialog）与服务端 services/dorms.js
 *   原来都是一上来就按 `[·・\-—/、,\s]` 切「楼名·房号」——
 *   「洋河-女宿·301」被拆成楼名「洋河」+ 房号「女宿301」。
 *   房号从此带着性别字样落库；下次打开回显成「洋河·女宿301」，用户再点一次标准楼名保存，
 *   就拼成「洋河-女宿·女宿301」→ 再被切开 → 房号「女宿女宿301」……
 *   **每保存一次多叠一层**，线上实测叠到 7 层
 *   （`女宿女宿女宿女宿女宿女宿女宿301`），检查录入台的查宿对象列表因此冒出上百个「幽灵房间」。
 *   而「班级管理 → 宿舍配置」只看记录快照（不重算楼名），所以那边看着是「正常」的 —— 正是报障现象。
 *
 * 这个检查守住四条（每条都对应一次真实的复发方式）：
 *   ① 两端（server/src/services/dorms.js 与 miniprogram/utils/room-label.js）**同一批用例结果必须逐条相同**
 *      —— 只要有人只改一边，就会出现「界面显示 301、落库是 女宿301」这种最难查的两端漂移；
 *   ② 楼名自带 `-` `(` `)` 不被切开；拿不到白名单时也优先认规范分隔符「·」；
 *   ③ 已污染的房号（重复性别前缀）被归一，且**幂等**：反复保存不再叠字；
 *   ④ 组件不再自己写一套拆分正则（唯一实现），只 require 共享 util。
 *
 * 运行：node tools/check-room-label.js
 */
const fs = require('fs');
const path = require('path');

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? '  ok   ' : '  FAIL '}${name}${cond ? '' : ' -> ' + JSON.stringify(detail)}`);
  if (!cond) failed += 1;
};

const ROOT = path.join(__dirname, '..');
const serverDorms = require(path.join(ROOT, 'server', 'src', 'services', 'dorms'));
const roomLabel = require(path.join(ROOT, 'miniprogram', 'utils', 'room-label'));

// 线上真实白名单（goal_config.buildings.dorm 实测值）
const BUILDINGS = ['1号楼(女生宿舍)', '2号楼(男生旧宿)', '3号楼(男生新宿)', '洋河-男宿', '洋河-女宿'];

// 覆盖：标椎楼名 / 自带连字符 / 含括号 / 旧写法 / 纯房号 / 已污染（1~7 层）/ 空
const CASES = [
  '洋河-女宿·301',
  '洋河-男宿·303',
  '洋河-女宿·401',
  '1号楼(女生宿舍)·408',
  '2号楼(男生旧宿)·213',
  '3号楼(男生新宿)·304',
  '洋河·女宿301',
  '洋河·男宿男宿405',
  '洋河-女宿·女宿301',
  '洋河·女宿女宿女宿女宿女宿女宿女宿301',
  '洋河·女宿女宿220',
  '洋河·302',
  '1号楼-201',
  '1号楼 201',
  '201',
  '洋河-女宿',
  '',
];

console.log('[1] 两端拆分结果逐条一致');
for (const input of CASES) {
  const a = serverDorms.parseRoomLabel(input, { buildings: BUILDINGS });
  const b = roomLabel.splitRoomLabel(input, BUILDINGS);
  const same = a.buildingName === b.building && a.roomNo === b.roomNo;
  ok(`${JSON.stringify(input)} 两端一致`, same, { server: `${a.buildingName}|${a.roomNo}`, mini: `${b.building}|${b.roomNo}` });
}

console.log('\n[2] 楼名自带分隔符不被切开');
{
  const p = serverDorms.parseRoomLabel('洋河-女宿·301', { buildings: BUILDINGS });
  ok('洋河-女宿·301 → 楼名洋河-女宿 / 房号301', p.buildingName === '洋河-女宿' && p.roomNo === '301', p);
  const q = roomLabel.splitRoomLabel('洋河-男宿·303', BUILDINGS);
  ok('洋河-男宿·303 → 楼名洋河-男宿 / 房号303', q.building === '洋河-男宿' && q.roomNo === '303', q);
  const r = serverDorms.parseRoomLabel('1号楼(女生宿舍)·408', { buildings: BUILDINGS });
  ok('含括号的楼名不被切开', r.buildingName === '1号楼(女生宿舍)' && r.roomNo === '408', r);
  // 拿不到白名单时，规范分隔符「·」仍要优先于「-」
  const noCfg = serverDorms.parseRoomLabel('洋河-女宿·301');
  ok('无白名单时也不在「-」处切错', noCfg.buildingName === '洋河-女宿' && noCfg.roomNo === '301', noCfg);
}

console.log('\n[3] 污染房号归一 + 幂等');
{
  const dirty = serverDorms.parseRoomLabel('洋河·女宿女宿女宿女宿女宿女宿女宿301', { buildings: BUILDINGS });
  ok('7 层污染归一为单层「女宿301」', dirty.roomNo === '女宿301', dirty.roomNo);
  const byBuilding = serverDorms.parseRoomLabel('洋河-女宿·女宿301', { buildings: BUILDINGS });
  ok('楼名已带性别时房号里的性别全剥', byBuilding.roomNo === '301', byBuilding.roomNo);

  // 幂等：拆 → 拼 → 再拆，结果必须稳定（这就是「每保存一次叠一层」的回归点）
  let label = '洋河-女宿·301';
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    const p = serverDorms.parseRoomLabel(label, { buildings: BUILDINGS });
    label = serverDorms.roomLabel({ buildingName: p.buildingName, roomNo: p.roomNo });
    seen.push(label);
  }
  ok('反复保存 6 次不叠字', seen.every((x) => x === '洋河-女宿·301'), seen);

  // 前端同一套循环（组件里 emitRoom/submit 走的是这个 normalizeRoomNo）
  let mini = '洋河-女宿·301';
  for (let i = 0; i < 6; i += 1) {
    const p = roomLabel.splitRoomLabel(mini, BUILDINGS);
    mini = `${p.building}·${roomLabel.normalizeRoomNo(p.roomNo, p.building)}`;
  }
  ok('前端同一套循环也不叠字', mini === '洋河-女宿·301', mini);
}

console.log('\n[4] 唯一实现与留痕');
{
  const SHEET = fs.readFileSync(path.join(ROOT, 'miniprogram', 'components', 'dorm-sheet', 'dorm-sheet.js'), 'utf8');
  const DIALOG = fs.readFileSync(path.join(ROOT, 'miniprogram', 'components', 'room-dialog', 'room-dialog.js'), 'utf8');
  const SERVER = fs.readFileSync(path.join(ROOT, 'server', 'src', 'services', 'dorms.js'), 'utf8');
  ok('dorm-sheet 走共享 util', /require\(['"]\.\.\/\.\.\/utils\/room-label['"]\)/.test(SHEET));
  ok('room-dialog 走共享 util', /require\(['"]\.\.\/\.\.\/utils\/room-label['"]\)/.test(DIALOG));
  // 反向断言：组件里不能再出现「一次性按全部分隔符切」的本地实现
  const localSplit = /split\(\s*\/\[·・/;
  ok('dorm-sheet 不再自己写拆分正则', !localSplit.test(SHEET));
  ok('room-dialog 不再自己写拆分正则', !localSplit.test(DIALOG));
  ok('服务端仍保留旧写法兜底（没有规范分隔符时才用）', /LEGACY_SEP/.test(SERVER));
  ok('服务端注释里写清了本次事故', /幽灵房间|每保存一次多叠一层/.test(SERVER));
}

console.log(failed ? `\n失败 ${failed} 项` : '\n楼名/房号拆分口径校验通过（两端一致、楼名连字符不被切开、污染房号归一且幂等）');
process.exit(failed ? 1 : 0);
