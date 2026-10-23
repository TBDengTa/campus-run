// 检查记录列表页的**筛选条按身份裁剪**（node tools/check-union-records-filter.js）
//
// 用户报障：「检查申诉记录不应该是这样啊，上面不应该与学生会中的仅我的和待复核一样啊」
// 场景：班主任 / 班委从「班超」页的「全部 ›」进来（非学生会成员、只看本班），
//   却看到学生会专属的两个高频筛选：
//     · 仅我的   = 我提交的记录 → 班主任/班委从不提交 → 恒为空
//     · 待复核   = 等我复核     → 班主任/班委没有复核权 → 恒为空
//   两个按钮点下去永远是空列表，属于「假筛选」。
// 期望：非成员改看「申诉中」（本班哪些记录在申诉流程里，接口既有参数 pendingAppeal=1）。
const path = require('path');
const fs = require('fs');

const MINI = path.join(__dirname, '..', 'miniprogram');
let page = null;
let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -> ${detail}`}`);
  if (!cond) failed += 1;
};

global.Page = (cfg) => {
  page = cfg;
};
global.getApp = () => ({ requireLogin: () => true, ensureLogin: async () => {} });
global.wx = {
  showToast() {},
  setNavigationBarTitle() {},
  stopPullDownRefresh() {},
  navigateTo() {},
  getStorageSync: () => '',
  setStorageSync() {},
  removeStorageSync() {},
};

let MINE = {};
const queries = [];
const auth = require(path.join(MINI, 'utils', 'request'));
auth.get = async (url, params) => {
  if (url === '/api/union/mine') return MINE;
  if (url === '/api/union/records') {
    queries.push(params);
    return { total: 0, hasMore: false, list: [] };
  }
  throw new Error('未预期请求: ' + url);
};

require(path.join(MINI, 'packageUnion', 'records', 'records.js'));

function makeInstance(options = {}) {
  const inst = Object.assign({}, page);
  inst.data = JSON.parse(JSON.stringify(page.data));
  inst.setData = function setData(patch, cb) {
    Object.assign(this.data, patch);
    if (cb) cb();
  };
  inst.onLoad(options);
  return inst;
}

const wxml = fs.readFileSync(path.join(MINI, 'packageUnion/records/records.wxml'), 'utf8');
const jsSrc = fs.readFileSync(path.join(MINI, 'packageUnion/records/records.js'), 'utf8');

(async () => {
  // ① 学生会成员 + 可复核：两个学生会专属筛选都在
  MINE = { isMember: true, canReview: true, modules: [{ key: 'hygiene', shortName: '卫生' }, { key: 'study_evening', shortName: '晚自习' }] };
  let inst = makeInstance({});
  await inst.load(true);
  ok('成员：isMember=true', inst.data.isMember === true);
  ok('成员：canReview=true', inst.data.canReview === true);
  ok('成员：classView=false', inst.data.classView === false);
  ok('成员：模块筛选有内容', inst.data.modules.length > 1, JSON.stringify(inst.data.modules));

  // ② 班主任 / 班委：两个专属筛选清掉、改给「申诉中」
  //    注意 /api/union/mine 对**所有人**都下发模块清单（非成员 canEnter=false）→ 模块筛选要保留
  MINE = { isMember: false, canReview: false, modules: [{ key: 'hygiene', shortName: '卫生' }, { key: 'study_evening', shortName: '晚自习' }] };
  inst = makeInstance({ className: encodeURIComponent('56级冒烟1班'), mine: '1' });
  await inst.load(true);
  ok('非成员：isMember=false', inst.data.isMember === false);
  ok('非成员：canReview=false', inst.data.canReview === false);
  ok('非成员：classView=true', inst.data.classView === true, String(inst.data.classView));
  ok('非成员：「仅我的」被清掉（否则恒为空列表）', inst.data.mine === false, String(inst.data.mine));
  ok('非成员：模块筛选保留（这个筛选对他们有用）', inst.data.modules.length > 1, JSON.stringify(inst.data.modules));

  // ③ 模板渲染条件
  ok('「仅我的」只在 isMember 时渲染', /wx:if="\{\{isMember\}\}"[^>]*bind:tap="toggleMine"[^>]*>仅我的/.test(wxml));
  ok('「待复核」只在 canReview 时渲染', /wx:if="\{\{canReview\}\}"[^>]*bind:tap="togglePending"[^>]*>待复核/.test(wxml));
  ok('「申诉中」在班本视角 / 无复核权 / 已启用时渲染', /wx:if="\{\{classView \|\| !canReview \|\| pendingAppeal\}\}"[^>]*bind:tap="toggleAppeal"[^>]*>申诉中/.test(wxml));
  ok('模块选择器不按 isMember 隐藏', /wx:if="\{\{modules\.length > 1\}\}"/.test(wxml));
  ok('有 toggleAppeal 处理函数', /toggleAppeal\(\) \{/.test(jsSrc));

  // ④ 「申诉中」沿用接口既有参数，不发明新契约
  queries.length = 0;
  inst.toggleAppeal();
  await new Promise((r) => setTimeout(r, 10));
  ok('请求带 pendingAppeal=1', queries.some((q) => q.pendingAppeal === 1), JSON.stringify(queries));
  ok('className 透传（范围由服务端按身份收敛）', queries.some((q) => q.className === '56级冒烟1班'), JSON.stringify(queries));

  // ⑤ 重置能一次清干净（否则用户会卡在一个看不见的筛选里）
  inst.resetFilters();
  await new Promise((r) => setTimeout(r, 10));
  ok('reset 后 pendingAppeal=false', inst.data.pendingAppeal === false);
  ok('reset 后 mine=false', inst.data.mine === false);

  console.log(`\n${failed ? `FAILED ${failed}` : '全部通过'}`);
  process.exit(failed ? 1 : 0);
})();