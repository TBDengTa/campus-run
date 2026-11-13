/**
 * 组件行为测试：dorm-sheet 的楼号胶囊（用户 2026-11-12「宿舍弹窗多出来 1号楼 与 洋河」）。
 *
 * 报障原文：「在班级管理中的进入宿舍管理与用户详细里面的弹窗多出来 1号楼 与 洋河（图1 图2），
 *   正常的只有图3，是从我的班级-班级配置中的宿舍管理。」
 * 根因：楼号胶囊 = 系统设置清单 ∪ **历史出现过的所有楼名**，而房间是按自由文本
 *   「楼名·门号」自动建档的，历史里必然掺着手打的旧写法 / 错写法（实测「洋河」160 间
 *   739 人在住、「1号楼」1 间房号 999 无人住）。两个入口的历史集合范围还不一样
 *   （管理端=全校房间聚合 / 班级域=本班学生聚合），于是同一件事出现两套楼名。
 *
 * 这里守住四条：
 *   ① 现住楼在清单里的学生：胶囊 = 服务端下发的那份，组件不自己加东西；
 *   ② 住在**清单外旧楼名**的人仍要能保存（补一条 legacy 胶囊 + 提示）——
 *      否则白名单收窄会把 739 个住「洋河」的人改床位永久堵死（「请先选择楼号」）；
 *   ③ 主动改选标准楼名后，legacy 胶囊与提示立刻撤掉（不留第二套写法继续被点）；
 *   ④ 楼名/门号拆分与服务端 parseRoomLabel 同一套分隔符，含括号的标准楼名不能被拆坏。
 *
 * 运行：node tools/check-dorm-sheet.js
 */
const path = require('path');

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? '  ok   ' : '  FAIL '}${name}${cond ? '' : ' -> ' + JSON.stringify(detail)}`);
  if (!cond) failed += 1;
};

let def = null;
const toasts = [];
global.Component = (d) => { def = d; };
global.wx = { showToast: (o) => toasts.push(o && o.title) };
// eslint-disable-next-line global-require
require(path.join(__dirname, '..', 'miniprogram', 'components', 'dorm-sheet', 'dorm-sheet.js'));
if (!def) throw new Error('dorm-sheet 未注册');

const CFG = [
  { name: '1号楼(女生宿舍)', rooms: 58 },
  { name: '2号楼(男生旧宿)', rooms: 89 },
  { name: '3号楼(男生新宿)', rooms: 27 },
  { name: '洋河-男宿', rooms: 0 },
  { name: '洋河-女宿', rooms: 0 },
];

// 只跑 observers['roomText, buildings']（真实组件里 buildings/roomText 由父页面回灌）
function makeInst(roomText, buildings) {
  const inst = {
    data: JSON.parse(JSON.stringify(def.data)),
    triggerEvent: (n, d) => { inst.lastEvent = { name: n, detail: d }; },
  };
  inst.setData = (patch) => Object.assign(inst.data, patch);
  for (const [k, fn] of Object.entries(def.methods)) inst[k] = fn.bind(inst);
  inst.__observe = def.observers['roomText, buildings'].bind(inst);
  inst.__observe(roomText || '', buildings || []);
  return inst;
}

// ① 现住楼在清单内（图3 的正常形态：5 栋，一个不多）
console.log('[1] 现住楼在清单内');
{
  const inst = makeInst('1号楼(女生宿舍)·408', CFG);
  ok('胶囊条数 = 服务端那份', inst.data.chips.length === CFG.length, inst.data.chips.map((c) => c.name));
  ok('脏楼名「洋河」没有被组件自己塞进来', !inst.data.chips.some((c) => c.name === '洋河'), inst.data.chips.map((c) => c.name));
  ok('楼名含括号不被拆坏', inst.data.pickBuilding === '1号楼(女生宿舍)', inst.data.pickBuilding);
  ok('门号 = 408', inst.data.roomNo === '408', inst.data.roomNo);
  ok('没有 legacy 提示', inst.data.legacyBuilding === '', inst.data.legacyBuilding);
  toasts.length = 0;
  inst.submit();
  ok('可直接保存', inst.lastEvent && inst.lastEvent.detail.roomText === '1号楼(女生宿舍)·408', inst.lastEvent);
}

// ② 住在清单外的旧楼名（实测库里 739 人住「洋河」）
console.log('[2] 现住楼不在清单里');
{
  const inst = makeInst('洋河·208', CFG);
  ok('补出「洋河」胶囊并标 legacy', inst.data.chips.some((c) => c.name === '洋河' && c.legacy === true), inst.data.chips.map((c) => c.name));
  ok('只补本人这一条', inst.data.chips.length === CFG.length + 1, inst.data.chips.length);
  ok('默认选中现住楼', inst.data.pickBuilding === '洋河', inst.data.pickBuilding);
  ok('门号 = 208', inst.data.roomNo === '208', inst.data.roomNo);
  ok('给界面留 legacyBuilding 提示', inst.data.legacyBuilding === '洋河', inst.data.legacyBuilding);
  toasts.length = 0;
  inst.submit();
  ok('沿现住楼调床位不被「请先选择楼号」堵死', !toasts.some((t) => /请先选择楼号/.test(t || '')), toasts);
  ok('保存仍是「洋河·208」两段', inst.lastEvent.detail.roomText === '洋河·208', inst.lastEvent.detail);
}

// ③ 主动换成标准楼名后，旧写法入口撤掉（否则第二套写法一直挂在胶囊里）
console.log('[3] 改选标准楼名');
{
  const inst = makeInst('洋河·208', CFG);
  inst.tapBuilding({ currentTarget: { dataset: { name: '洋河-男宿' } } });
  ok('选中标准楼', inst.data.pickBuilding === '洋河-男宿', inst.data.pickBuilding);
  ok('legacy 胶囊已撤', !inst.data.chips.some((c) => c.legacy), inst.data.chips.map((c) => c.name));
  ok('提示已撤', inst.data.legacyBuilding === '', inst.data.legacyBuilding);
  // 选楼只抛 change（roomText 由父页面持有，save 时才整体抛出）—— 组件对外接口不能改
  ok('抛出 change 且用新楼名', inst.lastEvent.name === 'change' && inst.lastEvent.detail.field === 'roomText' && inst.lastEvent.detail.value === '洋河-男宿·208', inst.lastEvent);
}

// ④ 门号仍只收数字；清单为空时也不凭空造白名单
console.log('[4] 输入清洗与白名单边界');
{
  const inst = makeInst('', CFG);
  inst.tapBuilding({ currentTarget: { dataset: { name: '1号楼(女生宿舍)' } } });
  ok('「A2b01」→ 201', inst.onRoomInput({ detail: { value: 'A2b01' } }) === '201');
  toasts.length = 0;
  inst.onRoomInput({ detail: { value: '' } });
  inst.submit();
  ok('未填门号拒绝保存', toasts.some((t) => /请填写门号/.test(t || '')), toasts);

  const empty = makeInst('洋河·208', []);
  ok('清单为空时只有本人那条 legacy', empty.data.chips.length === 1 && empty.data.chips[0].legacy === true, empty.data.chips.map((c) => c.name));
}

// ⑤ 真实脏数据形态：洋河校区的门牌写成「男宿303」（不是纯数字），楼名也不能被吞掉
console.log('[5] 现住「洋河·男宿303」（实测库里的真实写法）');
{
  const inst = makeInst('洋河·男宿303', CFG);
  ok('楼名 = 洋河', inst.data.pickBuilding === '洋河', inst.data.pickBuilding);
  ok('门号原样保留（回显不改坏历史值）', inst.data.roomNo === '男宿303', inst.data.roomNo);
  ok('标 legacy', inst.data.legacyBuilding === '洋河', inst.data.legacyBuilding);
  inst.submit();
  ok('保存后仍是同一条房间（不因回显丢字而换房）', inst.lastEvent.detail.roomText === '洋河·男宿303', inst.lastEvent.detail);
}

console.log(failed ? `\n失败 ${failed} 项` : '\ndorm-sheet 行为校验通过（胶囊跟服务端清单、旧楼名只补本人、换标准楼即撤）');
process.exit(failed ? 1 : 0);
