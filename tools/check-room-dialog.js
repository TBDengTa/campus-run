/**
 * 组件行为测试：room-dialog 的「教室门号可填场所名」（用户 2026-10-28）。
 *
 * 报障原文：「在设置教室中会出现没有门号而是名的问题，需要进行扩充一下」。
 * 修法：教室的「门号」从「只收数字」放宽为文本（阶梯教室 / 报告厅 / A301 都能填），
 *       **宿舍仍只收数字**（房号是门牌号，床位与按房间查宿都依赖数字口径）。
 *
 * 这个检查守住的几条性质（每一条都对应一次真实翻车风险）：
 *   ① 教室能存名称，不再被 \D 过滤成「只剩数字」；
 *   ② 宿舍没被连带放宽（A301 → 301 仍成立）；
 *   ③ 门号里不能出现楼名分隔符 · - / 等 —— 否则读回时会被拆成「楼名 + 半截门号」；
 *   ④ 拼出来仍是「楼名·门号」两段，前端回显与服务端 parseRoomLabel 都能拆；
 *   ⑤ 未选楼不能保存（预览/校验不能被放宽冲掉）。
 *
 * 运行：node tools/check-room-dialog.js
 */
const path = require('path');

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? '  ok   ' : '  FAIL '}${name}${cond ? '' : ' -> ' + JSON.stringify(detail)}`);
  if (!cond) failed += 1;
};

// 打桩加载组件真实代码
let def = null;
const toasts = [];
global.Component = (d) => {
  def = d;
};
global.wx = { showToast: (o) => toasts.push(o && o.title) };
// eslint-disable-next-line global-require
require(path.join(__dirname, '..', 'miniprogram', 'components', 'room-dialog', 'room-dialog.js'));
if (!def) throw new Error('room-dialog 未注册');

function makeInst(kind, value, buildings) {
  const inst = {
    data: { ...JSON.parse(JSON.stringify(def.data)) },
    triggerEvent: (n, d) => {
      inst.lastEvent = { name: n, detail: d };
    },
  };
  inst.data.canManage = true;
  inst.setData = (patch) => Object.assign(inst.data, patch);
  for (const [k, fn] of Object.entries(def.methods)) inst[k] = fn.bind(inst);
  const obsKey = Object.keys(def.observers)[0];
  inst.__observe = def.observers[obsKey].bind(inst);
  inst.__observe(true, value, buildings, kind);
  return inst;
}

const BUILDINGS = [{ name: '教学楼' }, { name: '实训楼' }];

// ① 教室：名称可保存
console.log('[1] 教室门号可填场所名');
{
  const inst = makeInst('classroom', '', BUILDINGS);
  ok('教室 allowText=true', inst.data.allowText === true, inst.data.allowText);
  ok('提示提到「阶梯教室」', /阶梯教室/.test(inst.data.roomHint), inst.data.roomHint);
  inst.tapBuilding({ currentTarget: { dataset: { name: '教学楼' } } });
  ok('输入「阶梯教室」原样保留', inst.onRoomInput({ detail: { value: '阶梯教室' } }) === '阶梯教室');
  inst.submit();
  ok('保存为「教学楼·阶梯教室」', inst.lastEvent.detail.roomText === '教学楼·阶梯教室', inst.lastEvent.detail);
}

// ② 教室：带字母的门号
console.log('[2] 带字母门号');
{
  const inst = makeInst('classroom', '', BUILDINGS);
  inst.tapBuilding({ currentTarget: { dataset: { name: '实训楼' } } });
  ok('「A301」不被过滤（旧实现会变 301）', inst.onRoomInput({ detail: { value: 'A301' } }) === 'A301');
}

// ③ 宿舍：仍然纯数字
console.log('[3] 宿舍仍只收数字');
{
  const inst = makeInst('dorm', '', [{ name: '1号楼' }]);
  ok('宿舍 allowText=false', inst.data.allowText === false, inst.data.allowText);
  inst.tapBuilding({ currentTarget: { dataset: { name: '1号楼' } } });
  ok('「A2b01」→ 201', inst.onRoomInput({ detail: { value: 'A2b01' } }) === '201');
  ok('超长截断到 6 位', inst.onRoomInput({ detail: { value: '2011999' } }) === '201199');
}

// ④ 分隔符清洗 + 拼串仍是两段
console.log('[4] 分隔符清洗与拼串');
{
  const inst = makeInst('classroom', '', BUILDINGS);
  inst.tapBuilding({ currentTarget: { dataset: { name: '教学楼' } } });
  const v = inst.onRoomInput({ detail: { value: '东-1/阶梯 教室' } });
  ok('门号不含 · - / 、,', !/[·・\-—/、,]/.test(v), v);
  inst.submit();
  const saved = inst.lastEvent.detail.roomText;
  const parts = saved.split('·');
  ok('拼串为「楼名·门号」两段', parts.length === 2 && parts[0] === '教学楼', saved);
  ok('门号段字符不丢', parts[1].replace(/\s/g, '') === '东1阶梯教室', parts[1]);
}

// ⑤ 长度与回显
console.log('[5] 长度上限与回显');
{
  const inst = makeInst('classroom', '', BUILDINGS);
  inst.tapBuilding({ currentTarget: { dataset: { name: '教学楼' } } });
  ok('教室门号限 20 字', inst.onRoomInput({ detail: { value: '一'.repeat(50) } }).length === 20);

  const back = makeInst('classroom', '教学楼·阶梯教室', BUILDINGS);
  ok('回显拆出楼名', back.data.pickBuilding === '教学楼', back.data.pickBuilding);
  ok('回显拆出门号（名称型）', back.data.roomNo === '阶梯教室', back.data.roomNo);
}

// ⑥ 校验
console.log('[6] 未选楼不可保存');
{
  const inst = makeInst('classroom', '', BUILDINGS);
  inst.onRoomInput({ detail: { value: '阶梯教室' } });
  ok('只填名称、未选楼 canSave=false', inst.data.canSave === false, inst.data.canSave);
  toasts.length = 0;
  inst.submit();
  ok('点保存提示先选楼', toasts.some((t) => /请先选择楼号/.test(t || '')), toasts);
}

console.log(failed ? `\n失败 ${failed} 项` : '\nroom-dialog 行为校验通过（教室可填场所名、宿舍仍纯数字）');
process.exit(failed ? 1 : 0);
